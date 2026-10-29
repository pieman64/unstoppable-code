import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { runStep } from '../step-runner';
import type {
  AgentPromptWorkerResult,
  CodexPromptRunnerResult,
  ExecutionRuntime,
  NormalizedStep,
} from '../types';
import type { AgentFailureClassification } from '@canopy/desktop-shared/types/agent-failures';

const CLAUDE_MODEL = 'claude-account-proxy-step-test';
const CODEX_MODEL = 'gpt-account-proxy-step-test';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function writeAgentPromptAction(runtime: ExecutionRuntime): void {
  const actionDir = path.join(runtime.bundledActionsDir, 'agent-prompt');
  fs.mkdirSync(actionDir, { recursive: true });
  fs.writeFileSync(
    path.join(actionDir, 'action.yml'),
    [
      'name: agent-prompt',
      'log_format_hint: agent',
      'inputs:',
      '  model: {}',
      '  prompt: {}',
      'outputs: {}',
      'runs:',
      '  using: node',
      '  main: index.js',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(actionDir, 'index.js'), '', 'utf8');
}

function agentStep(model: string): NormalizedStep {
  return {
    id: 'agent-step',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 1,
    skip_on_missing_action: false,
    uses: 'builtin/agent-prompt',
    with: { model, prompt: 'do it' },
  };
}

function usageLimit(provider: 'claude' | 'codex'): AgentFailureClassification {
  return {
    kind: 'provider_usage_limit',
    code: 'usage_limit_exceeded',
    provider,
    account_scope: 'native',
    diagnostic_message: 'The proxy account reached its limit',
  };
}

describe('runStep through the account proxy', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeAll(() => {
    initClaudeModels([{ id: CLAUDE_MODEL, label: 'Claude proxy test' }]);
    initCodexModels([{ id: CODEX_MODEL, label: 'Codex proxy test' }]);
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-proxy-step-'));
    runtime = createRuntime(tempDir);
    writeAgentPromptAction(runtime);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(model: string): ReturnType<typeof runStep> {
    return runStep({
      executionId: 'exec-proxy',
      jobId: 'build',
      logicalJobId: 'build',
      jobName: 'Build',
      pipelineName: 'Release',
      step: agentStep(model),
      cwd: tempDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      agentTerminalMode: true,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      attempt: 0,
      iteration: 1,
    });
  }

  it('pauses a Claude proxy quota failure with a restart checkpoint before any activity', async () => {
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: CLAUDE_MODEL,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/route' },
        accountProxyRouted: true,
        accountProxyConnectionId: 'proxy-connection',
      }),
    );
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'failure',
          workerId: 'worker',
          transcript: '',
          failure: {
            version: 1,
            provider: 'claude',
            had_agent_activity: false,
            classification: usageLimit('claude'),
            message: 'The proxy account reached its limit',
          },
        }),
    };

    const result = await run(CLAUDE_MODEL);

    expect(result.status).toBe('paused');
    expect(result.pause_reason).toMatchObject({
      kind: 'provider_usage_limit',
      account_proxy_connection_id: 'proxy-connection',
    });
    expect(result.agent_recovery).toMatchObject({
      account_proxy_connection_id: 'proxy-connection',
      strategy: 'restart_step',
    });
  });

  it('pauses a Codex proxy quota failure while preserving its existing thread', async () => {
    runtime.resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'codex' as const,
        harness: 'codex' as const,
        runtimeModel: CODEX_MODEL,
        aiCreditsRouted: false,
        modelGatewayRouted: false,
        accountProxyRouted: true,
        accountProxyConnectionId: 'proxy-connection',
      }),
    );
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'failure',
          transcript: '',
          failure: {
            version: 1,
            provider: 'codex',
            session_id: 'codex-thread',
            had_agent_activity: true,
            classification: usageLimit('codex'),
            message: 'The proxy account reached its limit',
          },
        }),
    };

    const result = await run(CODEX_MODEL);

    expect(result.status).toBe('paused');
    expect(result.pause_reason).toMatchObject({
      kind: 'provider_usage_limit',
      account_proxy_connection_id: 'proxy-connection',
    });
    expect(result.agent_recovery).toMatchObject({
      account_proxy_connection_id: 'proxy-connection',
      session_id: 'codex-thread',
      strategy: 'continue_session',
    });
  });

  it('marks a Claude step the account proxy served for audit', async () => {
    runtime.resolveAiCreditsRouting = jest.fn(() =>
      Promise.resolve({
        provider: 'claude' as const,
        model: CLAUDE_MODEL,
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/route' },
        accountProxyRouted: true,
        accountProxyConnectionId: 'proxy-connection',
      }),
    );
    runtime.agentPromptWorker = {
      runAgentPrompt: (): Promise<AgentPromptWorkerResult> =>
        Promise.resolve({
          status: 'success',
          workerId: 'worker',
          sessionId: 'claude-session',
          rawText: 'done',
          transcript: '',
        }),
    };

    const result = await run(CLAUDE_MODEL);

    expect(result.status).toBe('success');
    expect(result.outputs.canopy_account_proxy_routed).toBe('true');
    expect(result.outputs.canopy_ai_credits_routed).toBeUndefined();
    // The broker route the step used, so its accounts can be read (CAN-4021).
    expect(result.outputs.canopy_account_proxy_session).toMatch(/^pipeline:/);
    expect(runtime.resolveAiCreditsRouting).toHaveBeenCalledWith(
      CLAUDE_MODEL,
      'claude',
      expect.objectContaining({
        routeSessionId: result.outputs.canopy_account_proxy_session,
      }),
    );
  });

  it('marks a Codex step the account proxy served for audit', async () => {
    runtime.resolveModelHarnessInvocation = jest.fn(() =>
      Promise.resolve({
        source: 'codex' as const,
        harness: 'codex' as const,
        runtimeModel: CODEX_MODEL,
        aiCreditsRouted: false,
        modelGatewayRouted: false,
        accountProxyRouted: true,
        accountProxyConnectionId: 'proxy-connection',
      }),
    );
    runtime.codexPromptRunner = {
      runCodexPrompt: (): Promise<CodexPromptRunnerResult> =>
        Promise.resolve({
          status: 'success',
          sessionId: 'codex-thread',
          rawText: 'done',
          transcript: '',
          usage: {},
        }),
    };

    const result = await run(CODEX_MODEL);

    expect(result.status).toBe('success');
    expect(result.outputs.canopy_account_proxy_routed).toBe('true');
    expect(result.outputs.canopy_account_proxy_session).toMatch(/^pipeline:/);
    expect(runtime.resolveModelHarnessInvocation).toHaveBeenCalledWith(
      CODEX_MODEL,
      expect.objectContaining({
        routeSessionId: result.outputs.canopy_account_proxy_session,
      }),
    );
  });
});
