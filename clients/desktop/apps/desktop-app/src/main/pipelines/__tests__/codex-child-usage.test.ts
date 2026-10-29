import type {
  CodexRunTurnRequest,
  CodexStartThreadRequest,
  CodexTurnOutcome,
} from '@canopy/desktop-shared/node/codex-runtime';

const mockRunCodexTurn = jest.fn<
  Promise<CodexTurnOutcome>,
  [CodexRunTurnRequest]
>();
const mockStartCodexThread = jest.fn<
  Promise<unknown>,
  [CodexStartThreadRequest]
>();
const mockResumeCodexThread = jest.fn<
  Promise<unknown>,
  [CodexStartThreadRequest]
>();
const mockResolveAiCreditsRoutingOverride = jest.fn();
const mockResolveBackgroundWorkOwner = jest.fn();
const mockIsModelBlockedByStoredPolicy = jest.fn();
const mockIsOrgModelPolicyActiveByStoredAccount = jest.fn();

jest.mock('../resource-lanes', () => ({
  pipelineResourceContextEnabled: (): boolean => false,
  assertPipelineContext: jest.fn(() => Promise.resolve()),
}));
jest.mock('../canopy-server-client', () => ({
  getSharedPipeline: jest.fn(),
  getSharedPipelineForExecutionContext: jest.fn(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user-a' } } }),
  ),
}));
jest.mock('../../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: jest.fn(),
  })),
}));
jest.mock('../../lib/paths', () => ({
  getDataDir: jest.fn(() => '/data'),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: (...args: unknown[]): unknown =>
    mockResolveBackgroundWorkOwner(...args),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (...args: unknown[]): unknown =>
    mockIsModelBlockedByStoredPolicy(...args),
  isOrgModelPolicyActiveForStoredAccount: (...args: unknown[]): unknown =>
    mockIsOrgModelPolicyActiveByStoredAccount(...args),
}));
jest.mock('../config-paths', () => ({
  getBundledActionsDir: jest.fn(() => '/bundled/actions'),
  getBundledPipelinesDir: jest.fn(() => '/bundled/pipelines'),
  getProjectActionsDir: jest.fn((repoPath: string) => `${repoPath}/.actions`),
  getProjectActionsDirCandidates: jest.fn(() => []),
  getProjectPipelinesDir: jest.fn(
    (repoPath: string) => `${repoPath}/.pipelines`,
  ),
  getProjectPipelinesDirCandidates: jest.fn(() => []),
}));
jest.mock('../execution-runtime-hooks', () => ({
  createDesktopLifecycleHooks: jest.fn(() => ({})),
  createDesktopStepPostProcess: jest.fn(() => jest.fn()),
}));
jest.mock('../../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));
jest.mock('../plugin-collection-resolver', () => ({
  resolvePipelinePluginCollections: jest.fn(),
}));
jest.mock('../../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (...args: unknown[]): unknown =>
    mockResolveAiCreditsRoutingOverride(...args),
}));
jest.mock('../../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    unregisterRoutesForSession: jest.fn(),
  })),
}));
jest.mock('../../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: jest.fn(() => Promise.resolve('route')),
    unregisterCanopyWorktreeSessionRoute: jest.fn(),
    unregisterRoutesForSession: jest.fn(),
    getCanopyWorktreeMcpUrl: jest.fn(() => 'http://127.0.0.1/mcp'),
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
  })),
}));
jest.mock('../../agents/agent-model-store', () => ({
  getAgentModel: jest.fn(),
}));
jest.mock('../../agents/agent-default-model', () => ({
  resolveAgentDestinationDefaultModel: jest.fn(),
}));
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: (request: CodexStartThreadRequest): Promise<unknown> =>
      mockStartCodexThread(request),
    resumeThread: (request: CodexStartThreadRequest): Promise<unknown> =>
      mockResumeCodexThread(request),
    registerStdioMcpRoute: jest.fn(),
    revokeStdioMcpRoutes: jest.fn(),
  })),
}));
jest.mock('../../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: jest.fn(() => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'pipeline:workspace',
    secretVersionFingerprint: 'pipeline-secret',
  })),
}));
jest.mock('../../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: jest.fn(),
    cancel: jest.fn(),
  })),
}));
jest.mock('../../lib/worktree-service', () => ({
  getWorktreeCliRecord: jest.fn(),
}));
jest.mock('../cursor-prompt-runner', () => ({
  runCursorPipelinePrompt: jest.fn(),
}));
jest.mock('../pipeline-ledger', () => ({
  createDesktopPipelineLedgerPort: jest.fn(() => ({ openAttempt: jest.fn() })),
  getPipelineLedgerAttemptTools: jest.fn(),
  openPipelineLedgerCodexTools: jest.fn(),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolvePlugins: jest.fn(() => Promise.resolve([])),
}));

import { createElectronExecutionRuntime } from '../execution-runtime';

describe('pipeline Codex child usage events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAiCreditsRoutingOverride.mockResolvedValue(null);
    mockResolveBackgroundWorkOwner.mockResolvedValue({ kind: 'personal' });
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockIsOrgModelPolicyActiveByStoredAccount.mockResolvedValue(false);
    mockStartCodexThread.mockResolvedValue({
      threadId: 'pipeline-thread',
      runTurn: mockRunCodexTurn,
      unsubscribe: jest.fn(() => Promise.resolve()),
    });
    mockRunCodexTurn.mockImplementation((request) => {
      void request.onEvent?.({
        method: 'thread/started',
        params: {
          thread: {
            id: 'child-thread',
            model: 'gpt-5.5',
            source: {
              subAgent: {
                threadSpawn: {
                  agentNickname: 'Planner',
                  agentRole: 'planner',
                  parent_thread_id: 'pipeline-thread',
                },
              },
            },
          },
        },
      });
      void request.onEvent?.({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'child-thread',
          turnId: 'child-turn',
          tokenUsage: {
            total: {
              inputTokens: 500,
              cachedInputTokens: 100,
              cacheWriteInputTokens: 20,
              outputTokens: 400,
              reasoningOutputTokens: 30,
            },
            last: {
              inputTokens: 250,
              cachedInputTokens: 50,
              cacheWriteInputTokens: 10,
              outputTokens: 200,
              reasoningOutputTokens: 15,
            },
          },
        },
      });
      void request.onEvent?.({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'pipeline-thread',
          turnId: 'root-turn',
          tokenUsage: {
            total: { inputTokens: 600, outputTokens: 40 },
            last: { inputTokens: 300, outputTokens: 20 },
          },
        },
      });
      return Promise.resolve({
        status: 'completed',
        threadId: 'pipeline-thread',
        finalText: 'done',
        usage: {},
      });
    });
  });

  it('forwards child usage and metadata while keeping root accounting isolated', async () => {
    const receivedLines: string[] = [];
    const runtime = createElectronExecutionRuntime();

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected Codex prompt runner');
    }
    const result = await runtime.codexPromptRunner.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-5.5',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
      onTranscriptLine: (line) => {
        receivedLines.push(line);
      },
    });

    expect(result.status).toBe('success');
    const events = receivedLines.map((line): unknown => JSON.parse(line));
    expect(
      events.find(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'thread.started' &&
          'thread_id' in event &&
          event.thread_id === 'child-thread',
      ),
    ).toMatchObject({
      type: 'thread.started',
      source: {
        subAgent: {
          threadSpawn: {
            agentNickname: 'Planner',
            agentRole: 'planner',
            parent_thread_id: 'pipeline-thread',
          },
        },
      },
      thread_id: 'child-thread',
      model: 'gpt-5.5',
      agent_nickname: 'Planner',
      agent_role: 'planner',
      parent_thread_id: 'pipeline-thread',
    });
    expect(events).toContainEqual({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-thread',
      turn_id: 'child-turn',
      total: {
        input_tokens: 500,
        cached_input_tokens: 100,
        cache_write_input_tokens: 20,
        output_tokens: 400,
        reasoning_output_tokens: 30,
      },
      last: {
        input_tokens: 250,
        cached_input_tokens: 50,
        cache_write_input_tokens: 10,
        output_tokens: 200,
        reasoning_output_tokens: 15,
      },
    });
    expect(
      events.find(
        (event) =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'thread.token_usage.updated',
      ),
    ).toMatchObject({
      threadId: 'pipeline-thread',
      turnId: 'root-turn',
      usage: {
        input_tokens: 300,
        output_tokens: 20,
        cumulative_input_tokens: 600,
        cumulative_output_tokens: 40,
      },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'thread.token_usage.updated',
        threadId: 'child-thread',
      }),
    );
  });
});
