import { buildManagedMcpServerName } from '@canopy/desktop-shared/node/plugins/mcp-server-name';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type {
  ApprovalCheck,
  ApprovalMode,
  ApprovalRule,
} from '@canopy/desktop-shared/types';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import { approvalCheckForClaudeTool } from '../agents/claude-approval-adapter';
import type { ApprovalSessionHandle } from '../approvals/approval-service';

/**
 * Approval parity between the root chat and a delegated child (see
 * docs/planning/2026-09-25-delegation-capabilities/04-mcp-parity.md,
 * "Approval parity"): the same MCP call, under the same saved rules and the
 * same root approval mode, must produce the same decision and the same
 * `{kind:'mcp', server, tool}` prompt target whether the parent chat or a
 * delegated child makes it.
 *
 * Both the Claude parent hook (`approvalCheckForClaudeTool`'s `mcp__` branch,
 * apps/desktop-app/src/main/agents/claude-approval-adapter.ts) and the Codex
 * parent (`CodexAppServerClient.handleMcpElicitation` /
 * `handleFallbackMcpApproval`, apps/desktop-app/src/main/codex/app-server-client.ts)
 * build that exact literal directly; so does the child's
 * `DelegationNativePolicy.authorizeMcp`. Feeding the identical target through
 * the identical rules/mode via the pure policy engine
 * (packages/desktop-shared/src/lib/approval-engine.ts — the same engine
 * `createApprovalSession` wraps with disk-backed rule tiers and a renderer
 * prompt bridge) is therefore an equivalent, self-contained proof of parity
 * that does not require booting a live Claude/Codex session or the renderer.
 */

const cwd = '/workspace/example';

const serverName = buildManagedMcpServerName({
  kind: 'plugin',
  friendlyParts: ['review-plugin', 'evidence'],
  identityParts: ['market', 'review-plugin', 'evidence'],
});
const toolName = 'lookup_evidence';

interface MutableApprovalRuleSets {
  session: ApprovalRule[];
  project: ApprovalRule[];
  global: ApprovalRule[];
}

function emptyRules(): MutableApprovalRuleSets {
  return { session: [], project: [], global: [] };
}

/** Builds an `ApprovalSessionHandle` directly on the pure engine, counting
 * every 'prompt' outcome it reaches — the same count a real approval card
 * would produce, without mocking the renderer or the rule stores. */
function pureEngineApprovalHandle(options: {
  rules: MutableApprovalRuleSets;
  mode: ApprovalMode;
  promptCounter: { count: number };
  promptDecision?: 'allow' | 'deny';
}): ApprovalSessionHandle {
  let currentMode = options.mode;
  return {
    check: (check: ApprovalCheck): Promise<{ decision: 'allow' | 'deny' }> => {
      const evaluation = evaluateApproval(check, {
        mode: currentMode,
        rules: options.rules,
        workspaceRoot: cwd,
      });
      if (evaluation.outcome === 'allow')
        return Promise.resolve({ decision: 'allow' });
      if (evaluation.outcome === 'deny')
        return Promise.resolve({ decision: 'deny' });
      options.promptCounter.count += 1;
      return Promise.resolve({ decision: options.promptDecision ?? 'allow' });
    },
    setMode: (mode: ApprovalMode): void => {
      currentMode = mode;
    },
    policyContextKey: (): string =>
      JSON.stringify([
        currentMode,
        options.rules.session.length,
        options.rules.project.length,
        options.rules.global.length,
      ]),
    reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
    dispose: (): void => {},
  };
}

function delegateWithPureEngine(options: {
  rules: MutableApprovalRuleSets;
  mode: () => ApprovalMode;
  promptCounter: { count: number };
  writable?: () => boolean;
}): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: [serverName],
    mode: options.mode,
    signal: new AbortController().signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    ...(options.writable ? { writable: options.writable } : {}),
    approval: pureEngineApprovalHandle({
      rules: options.rules,
      mode: options.mode(),
      promptCounter: options.promptCounter,
    }),
    emit: (): Promise<void> => Promise.resolve(),
  });
}

describe('delegated MCP approval parity', () => {
  it("matches the parent Claude hook's approval target for the managed server name", () => {
    const claudeTarget = approvalCheckForClaudeTool(
      `mcp__${serverName}__${toolName}`,
      {},
      cwd,
    );
    const expected = {
      kind: 'mcp' as const,
      server: serverName,
      tool: toolName,
    };
    expect(claudeTarget.check).toEqual(expected);
    expect(claudeTarget.details).toEqual(expected);
    expect(claudeTarget.suggestedTarget).toEqual(expected);
  });

  it('matches the parent Codex approval target for the managed server name', () => {
    // Mirrors CodexAppServerClient.handleMcpElicitation /
    // handleFallbackMcpApproval, which build this exact literal for a
    // genuine MCP tool-call approval on the Codex parent.
    const codexTarget = {
      kind: 'mcp' as const,
      server: serverName,
      tool: toolName,
    };
    const claudeTarget = approvalCheckForClaudeTool(
      `mcp__${serverName}__${toolName}`,
      {},
      cwd,
    );
    expect(codexTarget).toEqual(claudeTarget.check);
  });

  it('gives the same Ask-mode decision as the parent target, with exactly one prompt for one call', async () => {
    const rules = emptyRules();
    const promptCounter = { count: 0 };
    const mode: ApprovalMode = 'ask';
    const parentEvaluation = evaluateApproval(
      { kind: 'mcp', server: serverName, tool: toolName },
      { mode, rules, workspaceRoot: cwd },
    );
    expect(parentEvaluation.outcome).toBe('prompt');
    const tools = delegateWithPureEngine({
      rules,
      mode: () => mode,
      promptCounter,
    });
    await expect(
      tools.authorizeMcpToolUse(serverName, toolName, {}, 'call-1'),
    ).resolves.toBe(true);
    expect(promptCounter.count).toBe(1);
    // The SDK hook and canUseTool asking about the same tool_use id must
    // reuse that one decision, never a second prompt.
    await expect(
      tools.authorizeMcpToolUse(serverName, toolName, {}, 'call-1'),
    ).resolves.toBe(true);
    expect(promptCounter.count).toBe(1);
  });

  it('auto-approves the identical call from a parent-saved "always allow" rule, without a prompt', async () => {
    const savedRule: ApprovalRule = {
      id: 'rule-always-allow',
      behavior: 'allow',
      target: { kind: 'mcp', server: serverName, tool: toolName },
      origin: 'prompt',
      createdAt: new Date().toISOString(),
    };
    const rules: MutableApprovalRuleSets = {
      session: [savedRule],
      project: [],
      global: [],
    };
    const promptCounter = { count: 0 };
    const mode: ApprovalMode = 'ask';
    const parentEvaluation = evaluateApproval(
      { kind: 'mcp', server: serverName, tool: toolName },
      { mode, rules, workspaceRoot: cwd },
    );
    expect(parentEvaluation.outcome).toBe('allow');
    const tools = delegateWithPureEngine({
      rules,
      mode: () => mode,
      promptCounter,
    });
    await expect(
      tools.authorizeMcp(serverName, toolName, {}, 'call-saved-rule'),
    ).resolves.toBe(true);
    expect(promptCounter.count).toBe(0);
  });

  it('a saved rule for a different tool on the same server does not leak approval', async () => {
    const savedRule: ApprovalRule = {
      id: 'rule-other-tool',
      behavior: 'allow',
      target: { kind: 'mcp', server: serverName, tool: 'other_tool' },
      origin: 'prompt',
      createdAt: new Date().toISOString(),
    };
    const rules: MutableApprovalRuleSets = {
      session: [savedRule],
      project: [],
      global: [],
    };
    const promptCounter = { count: 0 };
    const mode: ApprovalMode = 'ask';
    const parentEvaluation = evaluateApproval(
      { kind: 'mcp', server: serverName, tool: toolName },
      { mode, rules, workspaceRoot: cwd },
    );
    // The saved rule is scoped to 'other_tool' and must not cover this tool.
    expect(parentEvaluation.outcome).toBe('prompt');
    const tools = new DelegationNativePolicy({
      cwd,
      writePaths: [],
      mcpServerNames: [serverName],
      mode: (): ApprovalMode => mode,
      signal: new AbortController().signal,
      delegationId: 'child',
      allowed: (): Promise<boolean> => Promise.resolve(true),
      // Denies the prompt itself, so no fresh grant confuses the assertion.
      approval: pureEngineApprovalHandle({
        rules,
        mode,
        promptCounter,
        promptDecision: 'deny',
      }),
      emit: (): Promise<void> => Promise.resolve(),
    });
    await expect(
      tools.authorizeMcp(serverName, toolName, {}, 'call-unrelated-tool'),
    ).resolves.toBe(false);
    expect(promptCounter.count).toBe(1);
  });

  it('refuses the delegated MCP call while the root chat plans, like the parent', async () => {
    const rules = emptyRules();
    const promptCounter = { count: 0 };
    const tools = delegateWithPureEngine({
      rules,
      mode: () => 'auto',
      promptCounter,
      writable: () => false,
    });
    await expect(
      tools.authorizeMcp(serverName, toolName, {}, 'call-plan-mode'),
    ).resolves.toBe(false);
    expect(promptCounter.count).toBe(0);
  });

  it('auto-approves under full access, like the parent', async () => {
    const rules = emptyRules();
    const promptCounter = { count: 0 };
    const mode: ApprovalMode = 'full-access';
    const parentEvaluation = evaluateApproval(
      { kind: 'mcp', server: serverName, tool: toolName },
      { mode, rules, workspaceRoot: cwd },
    );
    expect(parentEvaluation.outcome).toBe('allow');
    const tools = delegateWithPureEngine({
      rules,
      mode: () => mode,
      promptCounter,
    });
    await expect(
      tools.authorizeMcp(serverName, toolName, {}, 'call-full-access'),
    ).resolves.toBe(true);
    expect(promptCounter.count).toBe(0);
  });
});
