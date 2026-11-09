import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CODE_GRAPH_INJECTED_TOOL_KEYS,
  LEDGER_INJECTED_TOOL_KEYS,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import * as nodePath from 'node:path';
import { approvalFileChangeForClaudeTool } from '@canopy/protocol/approvals';
import type {
  ApprovalCheck,
  ApprovalMode,
  ApprovalRequestDetails,
  ApprovalRuleTarget,
} from '@canopy/desktop-shared/types';
import { suggestedCommandPattern } from '@canopy/desktop-shared/lib/approval-engine';

// Only unattended worker Plan permission presets use this allowlist.
// Interactive planning tools follow the session's ordinary approval policy.
export const CLAUDE_PLAN_MODE_READ_ONLY_TOOLS = new Set([
  'Glob',
  'Grep',
  'NotebookRead',
  'Read',
  'WebFetch',
  'WebSearch',
  ...CODE_GRAPH_INJECTED_TOOL_KEYS.filter(
    (key) => key !== 'build_or_update_code_graph',
  ).map((key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName),
]);

const CLAUDE_PLAN_MODE_BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(
  LEDGER_INJECTED_TOOL_KEYS.map(
    (key) => CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName,
  ),
);

/**
 * Plan mode's explicit bookkeeping exception: the Ledger tools stay usable
 * while planning, so an agent can record intended tasks and decisions. Plan
 * mode adds no denial for them; like every interactive tool they follow the
 * session's approval mode, and the native `plan` permission mode still keeps
 * source edits and execution out. Only these three tools qualify.
 */
export function isClaudePlanModeBookkeepingTool(toolName: string): boolean {
  return CLAUDE_PLAN_MODE_BOOKKEEPING_TOOLS.has(toolName);
}

/** Context a Plan mode bookkeeping call carries back to the model. */
export const CLAUDE_PLAN_MODE_BOOKKEEPING_CONTEXT =
  'Plan mode: this Feed call is bookkeeping and is allowed while planning. It does not permit editing files or running commands, so keep planning.';

/**
 * Maps a Canopy approval mode (plus the orthogonal plan-mode toggle) to the
 * Claude Agent SDK's `PermissionMode`. Plan mode always wins regardless of
 * approval mode for the native planning workflow. Interactive tool decisions
 * remain governed by the session's approval mode through the approval hooks.
 */
export function claudePermissionModeFor(
  mode: ApprovalMode,
  planMode: boolean,
): PermissionMode {
  if (planMode) {
    return 'plan';
  }
  if (mode === 'full-access') {
    return 'bypassPermissions';
  }
  // Both Ask and Auto must route every governed tool through `canUseTool` so
  // Canopy's deny rules and Auto workspace containment remain authoritative.
  return 'default';
}

interface ClaudeToolApprovalRequirement {
  check: ApprovalCheck;
  details: ApprovalRequestDetails;
  suggestedTarget: ApprovalRuleTarget;
  /**
   * Display label substituted for the raw tool name in the approval title.
   * Call sites compose `<actor> wants to use <titleTool>` so each surface
   * keeps its own actor attribution ("Claude", "Claude Code", "Agent") on the
   * most trusted line of the prompt.
   */
  titleTool?: string;
}

interface ClaudeToolCheckResult extends ClaudeToolApprovalRequirement {
  additionalRequirements?: ClaudeToolApprovalRequirement[];
  failClosedReason?: string;
}

function toolFallback(toolName: string): ClaudeToolCheckResult {
  return {
    check: { kind: 'tool', toolName },
    details: { kind: 'tool', toolName },
    suggestedTarget: { kind: 'tool', toolName },
  };
}

const CLAUDE_SKILL_DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Skill names are `<skill>` or `<plugin>:<skill>` identifiers. The name is
 * model-supplied and lands on the approval prompt, so anything outside that
 * shape (whitespace, control characters, prose that could imitate app-authored
 * copy) falls back to the generic `Skill` display instead of being rendered.
 */
const CLAUDE_SKILL_NAME_PATTERN = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/;

function checkForSkill(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  const rawSkillName = input.skill;
  if (typeof rawSkillName !== 'string') {
    return toolFallback(toolName);
  }

  // The pattern requires at least one character, so empty and whitespace-only
  // names fall back rather than rendering a blank name in the prompt.
  const skillName = rawSkillName.trim();
  if (!CLAUDE_SKILL_NAME_PATTERN.test(skillName)) {
    return toolFallback(toolName);
  }

  const displayName = skillName.slice(0, CLAUDE_SKILL_DISPLAY_NAME_MAX_LENGTH);
  return {
    ...toolFallback(toolName),
    details: { kind: 'tool', toolName: displayName },
    titleTool: `skill ${displayName}`,
  };
}

function commandSuggestedTarget(command: string): ApprovalRuleTarget {
  return { kind: 'command', pattern: suggestedCommandPattern(command) };
}

function checkForCommand(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  const command = input.command;
  if (typeof command !== 'string') {
    return toolFallback(toolName);
  }
  return {
    check: { kind: 'command', command, ...(cwd ? { cwd } : {}) },
    details: { kind: 'command', command },
    suggestedTarget: commandSuggestedTarget(command),
  };
}

/** Lexical display convenience only; deliberately does not resolve symlinks. */
export function approvalFileDisplayPath(
  providerPath: string,
  cwd: string | undefined,
  paths: Pick<
    typeof nodePath,
    'relative' | 'resolve' | 'isAbsolute' | 'sep'
  > = nodePath,
): string | undefined {
  if (!providerPath || !cwd) return undefined;
  const relative = paths.relative(cwd, paths.resolve(cwd, providerPath));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    return undefined;
  return relative;
}

function checkForFileWrite(
  toolName: string,
  path: unknown,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  if (typeof path !== 'string') {
    return toolFallback(toolName);
  }
  const displayPath = approvalFileDisplayPath(path, cwd);
  const change = approvalFileChangeForClaudeTool(toolName, input);
  return {
    check: { kind: 'file-write', path },
    details: {
      kind: 'file-write',
      path,
      ...(displayPath ? { displayPath } : {}),
      ...(change ? { change } : {}),
    },
    suggestedTarget: { kind: 'file-write', path },
  };
}

function checkForNetwork(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  return checkForNetworkUrl(toolName, input.url);
}

function checkForNetworkUrl(
  toolName: string,
  url: unknown,
): ClaudeToolCheckResult {
  if (typeof url !== 'string') {
    return toolFallback(toolName);
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return toolFallback(toolName);
  }
  return {
    check: { kind: 'network', host },
    details: { kind: 'network', host },
    suggestedTarget: { kind: 'network', host },
  };
}

function networkRequirement(host: string): ClaudeToolApprovalRequirement {
  return {
    check: { kind: 'network', host },
    details: { kind: 'network', host },
    suggestedTarget: { kind: 'network', host },
  };
}

function webSearchDomainHost(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const candidate = value.trim().replace(/\.$/, '').toLowerCase();
  if (!candidate || candidate.includes('*')) {
    return undefined;
  }
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function checkForWebSearch(
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  const allowedDomains = input.allowed_domains;
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return {
      ...toolFallback('WebSearch'),
      failClosedReason:
        'WebSearch requires bounded allowed_domains for network approval.',
    };
  }
  const parsedHosts = allowedDomains.map(webSearchDomainHost);
  if (!parsedHosts.every((host): host is string => host !== undefined)) {
    return {
      ...toolFallback('WebSearch'),
      failClosedReason:
        'WebSearch contains an invalid or unsupported allowed domain.',
    };
  }
  const hosts = Array.from(new Set(parsedHosts));
  const [first, ...additional] = hosts.map(networkRequirement);
  return {
    ...first,
    ...(additional.length > 0 ? { additionalRequirements: additional } : {}),
  };
}

function checkForMcp(
  toolName: string,
  server: string,
  tool: string,
): ClaudeToolCheckResult {
  return {
    check: { kind: 'mcp', server, tool },
    details: { kind: 'mcp', server, tool },
    suggestedTarget: { kind: 'mcp', server, tool },
  };
}

/**
 * Derives the policy-engine `ApprovalCheck`, the renderer-facing
 * `ApprovalRequestDetails`, and a suggested "always allow/deny" rule target
 * for a given Claude tool name + input. See the tool -> check mapping table
 * in `docs/planning/2026-07-20-tool-approval-ux/plan.md` (Task 6).
 */
export function approvalCheckForClaudeTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  if (toolName === CANOPY_INJECTED_TOOL_REGISTRY.watch_command.claudeToolName)
    return checkForCommand(toolName, input, cwd);
  if (toolName === 'Bash') {
    return checkForCommand(toolName, input, cwd);
  }
  if (toolName === 'Monitor' && typeof input.command === 'string') {
    return checkForCommand(toolName, input, cwd);
  }
  if (
    toolName === 'Monitor' &&
    typeof input.ws === 'object' &&
    input.ws !== null &&
    !Array.isArray(input.ws)
  ) {
    const websocketUrl = 'url' in input.ws ? input.ws.url : undefined;
    return checkForNetworkUrl(toolName, websocketUrl);
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return checkForFileWrite(toolName, input.file_path, input, cwd);
  }
  if (toolName === 'NotebookEdit') {
    return checkForFileWrite(toolName, input.notebook_path, input, cwd);
  }
  if (toolName === 'WebFetch') {
    return checkForNetwork(toolName, input);
  }
  if (toolName === 'WebSearch') {
    return checkForWebSearch(input);
  }
  if (toolName === 'Skill') {
    return checkForSkill(toolName, input);
  }
  if (toolName.startsWith('mcp__')) {
    const remainder = toolName.slice('mcp__'.length);
    const separatorIndex = remainder.indexOf('__');
    if (separatorIndex > 0 && separatorIndex < remainder.length - 2) {
      const server = remainder.slice(0, separatorIndex);
      const tool = remainder.slice(separatorIndex + 2);
      if (tool.includes('__')) {
        // The SDK permission callback exposes only the flattened qualified
        // name, not separate MCP server/tool fields. A second separator is
        // therefore ambiguous (server `a` + tool `b__c` and server `a__b` +
        // tool `c` both become `mcp__a__b__c`). Deny instead of persisting an
        // approval identity that could later authorize the other pair.
        const fallback = toolFallback(toolName);
        return {
          ...fallback,
          failClosedReason:
            'Ambiguous MCP server/tool identity; denied by default.',
        };
      }
      return checkForMcp(toolName, server, tool);
    }
  }
  return toolFallback(toolName);
}
