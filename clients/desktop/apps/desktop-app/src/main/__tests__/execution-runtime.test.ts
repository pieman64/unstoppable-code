import type { ResolvePipelineTargetResult } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { runStep } from '@canopy/desktop-shared/node/pipelines/executor/step-runner';
import { assertPipelineContext } from '../pipelines/resource-lanes';
import * as workspacePersistence from '../lib/workspace-persistence';
import * as pipelineStore from '@canopy/desktop-shared/pipelines/store';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveChildPipeline } from '@canopy/desktop-shared/node/pipelines/executor/child-pipeline-resolver';
import * as pipelineInstallContext from '../pipelines/pipeline-install-context';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { getAgentModel } from '../agents/agent-model-store';
import { resolveAgentDestinationDefaultModel } from '../agents/agent-default-model';
import {
  CodexAppServerJsonRpcError,
  CodexAppServerRequestTimeoutError,
  CodexSharedRestartPeerError,
} from '@canopy/desktop-shared/node/codex-runtime/connection';
import { resolveAiCreditsRoutingOverride } from '../agents/ai-credits-routing';
import { runCursorPipelinePrompt } from '../pipelines/cursor-prompt-runner';
import {
  CODEX_PROJECT_DOC_THREAD_CONFIG,
  createCodexCapabilitySnapshotId,
  type CodexResumeThreadRequest,
  type CodexRunTurnRequest,
  type CodexStartThreadRequest,
  type CodexTurnOutcome,
} from '@canopy/desktop-shared/node/codex-runtime';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import {
  initCodexModels,
  initCursorModels,
  toOllamaModelId,
} from '@canopy/desktop-shared/types';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import type * as PipelineLedgerModule from '../pipelines/pipeline-ledger';

let mockPipelineContextEnabled = false;
const mockSharedPipeline = jest.fn();
const mockSelectionSharedPipeline = jest.fn((...args: unknown[]): unknown =>
  mockSharedPipeline(...args),
);
const mockBoundSharedPipeline = jest.fn((...args: unknown[]): unknown =>
  mockSharedPipeline(...args),
);
const mockParentBinding = jest.fn();
jest.mock('../pipelines/resource-lanes', () => ({
  pipelineResourceContextEnabled: (): boolean => mockPipelineContextEnabled,
  assertPipelineContext: jest.fn(() => Promise.resolve()),
}));
jest.mock('../pipelines/canopy-server-client', () => ({
  getSharedPipeline: (...args: unknown[]): unknown =>
    mockSelectionSharedPipeline(...args),
  getSharedPipelineForExecutionContext: (...args: unknown[]): unknown =>
    mockBoundSharedPipeline(...args),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user-a' } } }),
  ),
}));
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    findLocal: mockParentBinding,
  })),
}));

const mockRunWorker = jest.fn();
const mockCancelWorker = jest.fn();
const mockRunCodexTurn = jest.fn<
  Promise<CodexTurnOutcome>,
  [CodexRunTurnRequest]
>();
const mockUnsubscribeCodexThread = jest.fn();
const mockStartCodexThread = jest.fn<unknown, [CodexStartThreadRequest]>();
const mockResumeCodexThread = jest.fn<unknown, [CodexResumeThreadRequest]>();
const mockUnregisterHttpMcpRoutes = jest.fn();
const mockUnregisterGatewayRoutes = jest.fn();
const mockRevokeStdioMcpRoutes = jest.fn();
const mockResolveCodexRuntimeEnvironmentProfile = jest.fn(() => ({
  environment: { PIPELINE_ENV_FROM_SETTINGS: 'settings-value' },
  logicalWorkspaceEnvironmentId: 'pipeline:workspace-pipeline',
  secretVersionFingerprint: 'pipeline-secret-v1',
}));
const mockResolveBackgroundWorkOwner = jest.fn();
const mockIsModelBlockedByStoredPolicy = jest.fn();
const mockIsOrgModelPolicyActiveForStoredAccount = jest.fn();

jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/data'),
}));

jest.mock('../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: (...args: unknown[]): unknown =>
    mockResolveBackgroundWorkOwner(...args),
}));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (...args: unknown[]): unknown =>
    mockIsModelBlockedByStoredPolicy(...args),
  isOrgModelPolicyActiveForStoredAccount: (...args: unknown[]): unknown =>
    mockIsOrgModelPolicyActiveForStoredAccount(...args),
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledActionsDir: jest.fn(() => '/bundled/actions'),
  getBundledPipelinesDir: jest.fn(() => '/bundled/pipelines'),
  getProjectActionsDir: jest.fn((repoPath: string) => `${repoPath}/.actions`),
  getProjectActionsDirCandidates: jest.fn(() => []),
  getProjectPipelinesDir: jest.fn(
    (repoPath: string) => `${repoPath}/.pipelines`,
  ),
  getProjectPipelinesDirCandidates: jest.fn(() => []),
}));

jest.mock('../pipelines/execution-runtime-hooks', () => ({
  createDesktopLifecycleHooks: jest.fn(() => ({})),
  createDesktopStepPostProcess: jest.fn(() => jest.fn()),
}));

jest.mock('../lib/plan-persistence', () => ({
  createTrackedPlan: jest.fn(),
  updateTrackedPlan: jest.fn(),
}));

jest.mock('../pipelines/plugin-collection-resolver', () => ({
  resolvePipelinePluginCollections: jest.fn(),
}));

jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(),
}));

jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: jest.fn(),
}));

jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    unregisterRoutesForSession: mockUnregisterGatewayRoutes,
  })),
}));

jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    unregisterRoutesForSession: mockUnregisterHttpMcpRoutes,
    getCodexCapabilityAuthorityIds: jest.fn(() => []),
  })),
}));

jest.mock('../agents/agent-model-store', () => ({
  getAgentModel: jest.fn(),
}));

jest.mock('../agents/agent-default-model', () => ({
  resolveAgentDestinationDefaultModel: jest.fn(),
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: (request: CodexStartThreadRequest): unknown =>
      mockStartCodexThread(request),
    resumeThread: (request: CodexResumeThreadRequest): unknown =>
      mockResumeCodexThread(request),
    registerStdioMcpRoute: jest.fn(),
    revokeStdioMcpRoutes: mockRevokeStdioMcpRoutes,
  })),
}));

jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (...args: unknown[]): unknown =>
    mockResolveCodexRuntimeEnvironmentProfile(...args) as unknown,
}));

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: mockRunWorker,
    cancel: mockCancelWorker,
  })),
}));

jest.mock('../lib/worktree-service', () => ({
  getWorktreeCliRecord: jest.fn(),
}));

jest.mock('../pipelines/cursor-prompt-runner', () => ({
  runCursorPipelinePrompt: jest.fn(),
}));

const mockGetPipelineLedgerAttemptTools = jest.fn();
const mockOpenPipelineLedgerCodexTools = jest.fn();
jest.mock('../pipelines/pipeline-ledger', () => ({
  ...jest.requireActual<typeof PipelineLedgerModule>(
    '../pipelines/pipeline-ledger',
  ),
  getPipelineLedgerAttemptTools: (...args: unknown[]): unknown =>
    mockGetPipelineLedgerAttemptTools(...args),
  openPipelineLedgerCodexTools: (...args: unknown[]): unknown =>
    mockOpenPipelineLedgerCodexTools(...args),
}));

const mockPipelineHostActions = { run: jest.fn() };
jest.mock('../pipelines/host-actions', () => ({
  createDesktopPipelineHostActions: (): unknown => mockPipelineHostActions,
}));

// Owner checks have their own suite; these fixtures have no workspace configs.
const mockAuthorizePipelineTarget = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../pipelines/pipeline-owner-policy', () => ({
  createDesktopPipelineOwnershipPort: (): unknown => ({
    authorizeTarget: (...args: unknown[]): unknown =>
      mockAuthorizePipelineTarget(...args),
    readAgentAuthor: (): undefined => undefined,
  }),
}));

const resolveAiCreditsRoutingOverrideMock = jest.mocked(
  resolveAiCreditsRoutingOverride,
);
const runCursorPipelinePromptMock = jest.mocked(runCursorPipelinePrompt);

describe('createElectronExecutionRuntime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveBackgroundWorkOwner.mockResolvedValue({ kind: 'personal' });
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockIsOrgModelPolicyActiveForStoredAccount.mockResolvedValue(false);
    mockRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'pipeline-thread',
      finalText: 'done',
      usage: {},
    });
    mockUnsubscribeCodexThread.mockResolvedValue(undefined);
    mockStartCodexThread.mockResolvedValue({
      threadId: 'pipeline-thread',
      runTurn: mockRunCodexTurn,
      unsubscribe: mockUnsubscribeCodexThread,
    });
    mockResumeCodexThread.mockResolvedValue({
      threadId: 'pipeline-thread',
      runTurn: mockRunCodexTurn,
      unsubscribe: mockUnsubscribeCodexThread,
    });
  });

  it('supplies the desktop pipeline host actions port', () => {
    expect(createElectronExecutionRuntime().pipelineHostActions).toBe(
      mockPipelineHostActions,
    );
  });

  it('resolves an inheriting Agent alias to the step workspace default model', async () => {
    const agent = {
      id: 'agent_model_inherit',
      name: 'Inherit',
      baseModel: 'default',
      instructions: 'Inherit instructions.',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
    };
    jest.mocked(getAgentModel).mockResolvedValue(agent);
    jest
      .mocked(resolveAgentDestinationDefaultModel)
      .mockResolvedValue('gpt-5.5');
    const runtime = createElectronExecutionRuntime();
    await expect(
      runtime.resolvePipelineAgentModelAlias?.('agent_model_inherit', {
        projectId: 'workspace-1',
      }),
    ).resolves.toMatchObject({
      agentId: 'agent_model_inherit',
      base: 'gpt-5.5',
      instructions: 'Inherit instructions.',
    });
    expect(resolveAgentDestinationDefaultModel).toHaveBeenCalledWith(
      'workspace-1',
    );
  });

  it('supplies the desktop owner checks for run-pipeline targets', async () => {
    const runtime = createElectronExecutionRuntime();
    const target = {
      scope: 'worktree' as const,
      workspace_id: 'workspace-1',
      worktree_id: 'worktree-1',
      path: '/repo',
      created: false,
    };
    await runtime.pipelineOwnership?.authorizeTarget({
      executionContext: 'personal',
      target,
    });
    expect(mockAuthorizePipelineTarget).toHaveBeenCalledWith({
      executionContext: 'personal',
      target,
    });
  });

  it('scopes pipeline model-policy checks to the resolved work owner', async () => {
    const organizationOwner = {
      kind: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const personalOwner = { kind: 'personal' as const };
    mockResolveBackgroundWorkOwner
      .mockResolvedValueOnce(organizationOwner)
      .mockResolvedValueOnce(personalOwner);
    mockIsModelBlockedByStoredPolicy
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const runtime = createElectronExecutionRuntime();

    await expect(
      runtime.isModelBlockedByOrgPolicy?.('openai/restricted', {
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.isModelBlockedByOrgPolicy?.('openai/restricted', {
        projectId: 'project-personal',
        worktreeId: 'worktree-personal',
        executionContext: 'personal',
      }),
    ).resolves.toBe(false);

    expect(mockIsModelBlockedByStoredPolicy.mock.calls).toEqual([
      ['openai/restricted', organizationOwner],
      ['openai/restricted', personalOwner],
    ]);
  });

  it('routes pipeline AI Credits resolution through the shared resolver', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.resolveAiCreditsRouting?.('gpt-5.5', 'codex');

    expect(result).toBeNull();
    // The pipeline runtime slot is passed so the user-supplied-credential guard
    // reads the same Canopy Environments assignments the step spawns with
    // (ECW-9091 review round 6).
    expect(resolveAiCreditsRoutingOverrideMock).toHaveBeenCalledWith(
      'gpt-5.5',
      'codex',
      undefined,
      undefined,
      { environmentRuntime: 'pipeline' },
    );
  });

  // ECW-9091 review round 7. The step supplies both halves of its routing
  // context: the workspace (so the credential guard resolves the same
  // environment the step spawns with — a workspace assignment REPLACES the
  // global one) and whether an unattended trigger may fall back to credits.
  it('forwards the step routing context to the shared resolver', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();

    await runtime.resolveAiCreditsRouting?.('gpt-5.5', 'codex', {
      workspaceId: 'ws-3',
      allowNoNativeAuthFallback: false,
    });

    expect(resolveAiCreditsRoutingOverrideMock).toHaveBeenCalledWith(
      'gpt-5.5',
      'codex',
      undefined,
      undefined,
      {
        environmentRuntime: 'pipeline',
        workspaceId: 'ws-3',
        allowNoNativeAuthFallback: false,
      },
    );
  });

  it('forwards a parent-owned broker route for terminal-worker routing', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();

    await runtime.resolveAiCreditsRouting?.('opus[1m]', 'claude', {
      workspaceId: 'ws-3',
      allowNoNativeAuthFallback: true,
      routeSessionId: 'ephemeral:pipeline:exec:job:step:1',
    });

    expect(resolveAiCreditsRoutingOverrideMock).toHaveBeenCalledWith(
      'opus[1m]',
      'claude',
      undefined,
      'ephemeral:pipeline:exec:job:step:1',
      {
        environmentRuntime: 'pipeline',
        workspaceId: 'ws-3',
        allowNoNativeAuthFallback: true,
      },
    );
  });

  it('forwards pipeline guard context through model harness resolution', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT-5.5' }]);
    const runtime = createElectronExecutionRuntime();

    await runtime.resolveModelHarnessInvocation('gpt-5.5', {
      routeSessionId: 'pipeline:exec:job:step:1',
      workspaceId: 'workspace-guarded',
      allowNoNativeAuthFallback: false,
    });

    expect(resolveAiCreditsRoutingOverrideMock).toHaveBeenCalledWith(
      'gpt-5.5',
      'codex',
      undefined,
      'pipeline:exec:job:step:1',
      {
        environmentRuntime: 'pipeline',
        workspaceId: 'workspace-guarded',
        allowNoNativeAuthFallback: false,
      },
    );
  });

  it('resolves a Cursor-managed model to the cursor harness', async () => {
    initCursorModels([
      {
        id: 'cursor-default',
        rawModelId: 'default[]',
        label: 'Cursor default',
      },
    ]);
    const runtime = createElectronExecutionRuntime();

    await expect(
      runtime.resolveModelHarnessInvocation?.('cursor-default', {
        harness: 'cursor',
      }),
    ).resolves.toEqual({
      source: 'cursor-managed',
      harness: 'cursor',
      runtimeModel: 'cursor-default',
      aiCreditsRouted: false,
    });
  });

  it('cancels an active pipeline agent worker when its execution is aborted', async () => {
    let resolveWorker:
      | ((value: {
          status: 'cancelled';
          workerId: string;
          sessionId: string;
          finalText: string;
          result: null;
          transcriptJsonl: string;
          transcript: [];
        }) => void)
      | undefined;
    mockRunWorker.mockImplementation(
      (request: { onCreated?: (workerId: string) => void }) => {
        request.onCreated?.('pipeline-worker');
        return new Promise((resolve) => {
          resolveWorker = resolve;
        });
      },
    );
    mockCancelWorker.mockImplementation(() => {
      resolveWorker?.({
        status: 'cancelled',
        workerId: 'pipeline-worker',
        sessionId: 'session-1',
        finalText: '',
        result: null,
        transcriptJsonl: '',
        transcript: [],
      });
      return Promise.resolve();
    });
    const controller = new AbortController();
    const runtime = createElectronExecutionRuntime();
    const pending = runtime.agentPromptWorker?.runAgentPrompt({
      cwd: process.cwd(),
      prompt: 'do it',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Agent',
      signal: controller.signal,
      aiCreditsRouteSessionId: 'ephemeral:pipeline:execution-1:worker',
    });
    if (!pending) {
      throw new Error('Expected an agent prompt worker');
    }

    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'cancelled',
      workerId: 'pipeline-worker',
      failure: {
        message: 'Claude worker failed with status: cancelled',
      },
    });
    expect(mockUnregisterGatewayRoutes).toHaveBeenCalledWith(
      'ephemeral:pipeline:execution-1:worker',
    );
    expect(mockCancelWorker).toHaveBeenCalledWith('pipeline-worker');
    expect(mockRunWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        startupTimeoutMs: 10 * 60_000,
      }),
    );
  });

  // Pipelines cannot run Ultra fast. The runner's tier comes only from the
  // step's explicit boolean; an Ultra fast run config visible in the step
  // environment is rejected by the step runner before this runner is called,
  // and must never reach the thread as an `ultrafast` tier here.
  it.each([
    [false, 'default'],
    [true, 'priority'],
  ] as const)(
    'maps the step boolean fastMode=%s to the %s tier regardless of the run model config',
    async (fastMode, serviceTier): Promise<void> => {
      resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
      const runtime = createElectronExecutionRuntime();

      const result = await runtime.codexPromptRunner?.runCodexPrompt({
        cwd: '/workspace/repo',
        prompt: 'do the work',
        environment: {
          [brandEnvName('MODEL_CONFIG')]: JSON.stringify({
            speed: 'ultrafast',
            fastMode: false,
          }),
        },
        model: 'gpt-6-sol',
        fastMode,
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Codex',
      });

      expect(result?.status).toBe('success');
      const startRequest = mockStartCodexThread.mock.calls[0]?.[0] as
        | { params?: { serviceTier?: string } }
        | undefined;
      expect(startRequest?.params?.serviceTier).toBe(serviceTier);
    },
  );

  it('passes the captured project pipeline environment into the Codex spawn profile', async () => {
    // The exact remaining budget requires no elapsed time between clock reads.
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {
        PIPELINE_PUBLIC: 'public-value',
        PIPELINE_SECRET: 'secret-value',
      },
      model: 'gpt-6-sol',
      fastMode: true,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result?.status).toBe('success');
    const startRequest = mockStartCodexThread.mock.calls[0]?.[0] as
      | {
          params?: { serviceTier?: string };
          capabilitySnapshotId?: string;
          profile?: {
            environment?: Record<string, string>;
            logicalWorkspaceEnvironmentId?: string;
            secretVersionFingerprint?: string;
          };
        }
      | undefined;
    expect(startRequest?.profile?.environment).toMatchObject({
      PIPELINE_ENV_FROM_SETTINGS: 'settings-value',
      PIPELINE_PUBLIC: 'public-value',
      PIPELINE_SECRET: 'secret-value',
    });
    expect(startRequest?.profile?.logicalWorkspaceEnvironmentId).toBe(
      'pipeline:workspace-pipeline',
    );
    expect(startRequest?.profile?.secretVersionFingerprint).toBe(
      'pipeline-secret-v1',
    );
    expect(mockResolveCodexRuntimeEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'pipeline',
      workspaceId: 'workspace-1',
    });
    expect(startRequest?.params?.serviceTier).toBe('priority');
    expect(startRequest?.capabilitySnapshotId).toBe(
      createCodexCapabilitySnapshotId({
        roots: [],
        mcpServers: {},
        mcpAuthorityIds: [],
      }),
    );
    expect(mockRunCodexTurn.mock.calls[0]?.[0].totalTimeoutMs).toBe(60_000);
    expect(mockUnregisterHttpMcpRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:step-1:1',
    );
    expect(mockUnregisterGatewayRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:step-1:1',
    );
    expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:step-1:1',
    );
    expect(mockUnsubscribeCodexThread).toHaveBeenCalledTimes(1);
  });

  it('streams pipeline Codex transcript lines through onTranscriptLine while the turn is active', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const receivedLines: string[] = [];
    let linesWhenTurnResolved = -1;
    mockRunCodexTurn.mockImplementation((request) => {
      void request.onEvent?.({
        method: 'item/completed',
        params: {
          threadId: 'pipeline-thread',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'message-1', text: 'partial' },
        },
      });
      linesWhenTurnResolved = receivedLines.length;
      return Promise.resolve({
        status: 'completed',
        threadId: 'pipeline-thread',
        finalText: 'done',
        usage: {},
      });
    });
    const runtime = createElectronExecutionRuntime();

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected Codex prompt runner');
    }
    const result = await runtime.codexPromptRunner.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
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
    // thread.started plus the projected item event must both stream before
    // the turn resolves, not arrive as one batch afterwards.
    expect(linesWhenTurnResolved).toBe(2);
    expect(receivedLines[0]).toBe(
      JSON.stringify({ type: 'thread.started', thread_id: 'pipeline-thread' }),
    );
    expect(receivedLines[1]).toContain('"type":"item.completed"');
    if (result.status === 'success') {
      expect(result.transcript).toBe(`${receivedLines.join('\n')}\n`);
    }
  });

  it('keeps subagent token usage out of the pipeline transcript', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const receivedLines: string[] = [];
    mockRunCodexTurn.mockImplementation((request) => {
      // A registered subagent thread reports usage through the root handle
      // before the handle applies its own thread guard.
      void request.onEvent?.({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'subagent-thread',
          tokenUsage: {
            last: { totalTokens: 9999, inputTokens: 9000, outputTokens: 999 },
            modelContextWindow: 200000,
          },
        },
      });
      void request.onEvent?.({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'pipeline-thread',
          tokenUsage: {
            last: { totalTokens: 120, inputTokens: 80, outputTokens: 40 },
            modelContextWindow: 200000,
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
    const runtime = createElectronExecutionRuntime();

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected Codex prompt runner');
    }
    const result = await runtime.codexPromptRunner.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
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
    const usageLines = receivedLines.filter((line) =>
      line.includes('"type":"thread.token_usage.updated"'),
    );
    // Only the root thread's usage reaches audit counters and the context
    // meter; the subagent's larger numbers must not overwrite them.
    expect(usageLines).toHaveLength(1);
    expect(JSON.parse(usageLines[0])).toEqual({
      type: 'thread.token_usage.updated',
      threadId: 'pipeline-thread',
      usage: {
        context_tokens: 120,
        context_window: 200000,
        input_tokens: 80,
        output_tokens: 40,
      },
    });
    if (result.status === 'success') {
      expect(result.transcript).not.toContain('subagent-thread');
    }
  });

  it('projects the pipeline multi-agent preference into Codex start and resume thread config', async () => {
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();
    const preferenceEnvName = brandEnvName(
      'PREF_CODEX_MULTI_AGENT_PIPELINES_ENABLED',
    );
    const limitEnvName = brandEnvName('PREF_CODEX_MAX_CONCURRENT_SUBAGENTS');
    const baseRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      model: 'gpt-6-sol' as const,
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    };

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected Codex prompt runner');
    }

    await runtime.codexPromptRunner.runCodexPrompt({
      ...baseRequest,
      environment: { [preferenceEnvName]: 'true', [limitEnvName]: '2' },
    });
    await runtime.codexPromptRunner.runCodexPrompt({
      ...baseRequest,
      environment: { [preferenceEnvName]: 'false', [limitEnvName]: '5' },
      resumeSessionId: 'pipeline-thread',
    });

    // Local memory preference env var is absent here, so no native-memory
    // suppression key is merged (CAN-1969). Repository instruction delivery
    // is re-supplied on both start and resume (CAN-4531).
    const projectDocConfig = {
      project_doc_max_bytes: 131_072,
      project_doc_fallback_filenames: ['CLAUDE.md'],
    };
    const expectedStartConfig: NonNullable<
      CodexStartThreadRequest['params']['config']
    > = {
      ...projectDocConfig,
      features: { multi_agent: true, multi_agent_v2: true },
      agents: { enabled: true, max_concurrent_threads_per_session: 2 },
    };
    const expectedResumeConfig: NonNullable<
      CodexResumeThreadRequest['params']['config']
    > = {
      ...projectDocConfig,
      features: { multi_agent: false, multi_agent_v2: false },
      agents: { enabled: false, max_concurrent_threads_per_session: 5 },
    };
    const startRequest = mockStartCodexThread.mock.calls[0]?.[0];
    const resumeRequest = mockResumeCodexThread.mock.calls[0]?.[0];
    expect(startRequest?.params.config).toEqual(expectedStartConfig);
    expect(resumeRequest?.params.config).toEqual(expectedResumeConfig);
  });

  it('suppresses Codex-native memories only when the pipeline local memory preference is on', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    const localMemoryEnvName = brandEnvName('PREF_LOCAL_MEMORY_ENABLED');
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();
    const baseRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol' as const,
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    };

    if (!runtime.codexPromptRunner) {
      throw new Error('Expected Codex prompt runner');
    }

    try {
      // Default: no preference env var — local memory is opt-in and off, so
      // canonical Codex memory configuration stays untouched.
      await runtime.codexPromptRunner.runCodexPrompt({ ...baseRequest });
      const defaultRequest = mockStartCodexThread.mock.calls[0]?.[0];
      expect(defaultRequest?.params.config).toEqual(
        CODEX_PROJECT_DOC_THREAD_CONFIG,
      );

      // Enabled: the desktop app projects the preference into the execution
      // environment and Codex-native memories are suppressed.
      mockStartCodexThread.mockClear();
      await runtime.codexPromptRunner.runCodexPrompt({
        ...baseRequest,
        environment: { [localMemoryEnvName]: 'true' },
      });
      const suppressedRequest = mockStartCodexThread.mock.calls[0]?.[0];
      expect(suppressedRequest?.params.config).toEqual({
        ...CODEX_PROJECT_DOC_THREAD_CONFIG,
        'features.memories': false,
      });

      // Escape hatch force-allows native memory even while enabled.
      mockStartCodexThread.mockClear();
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
      await runtime.codexPromptRunner.runCodexPrompt({
        ...baseRequest,
        environment: { [localMemoryEnvName]: 'true' },
      });
      const allowedRequest = mockStartCodexThread.mock.calls[0]?.[0];
      expect(allowedRequest?.params.config).toEqual(
        CODEX_PROJECT_DOC_THREAD_CONFIG,
      );
    } finally {
      if (original === undefined) {
        delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      } else {
        process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
      }
    }
  });

  it('uses distinct Codex route identities for foreach siblings', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();
    const baseRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 0,
      stepLabel: 'Codex',
    };

    await runtime.codexPromptRunner?.runCodexPrompt({
      ...baseRequest,
      childId: 'child-000000',
    });
    await runtime.codexPromptRunner?.runCodexPrompt({
      ...baseRequest,
      childId: 'child-000001',
    });

    expect(mockUnregisterHttpMcpRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:child-000000:step-1:0',
    );
    expect(mockUnregisterHttpMcpRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:child-000001:step-1:0',
    );
    expect(mockUnregisterGatewayRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:child-000000:step-1:0',
    );
    expect(mockUnregisterGatewayRoutes).toHaveBeenCalledWith(
      'pipeline:execution-1:job-1:child-000001:step-1:0',
    );
  });

  it('reports an internally interrupted Codex turn as a failure', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    mockRunCodexTurn.mockResolvedValue({
      status: 'interrupted',
      threadId: 'pipeline-thread',
      finalText: '',
      usage: {},
      error: 'Codex pipeline turn timed out',
    });
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: 'Codex pipeline turn timed out' },
    });
    expect(mockUnsubscribeCodexThread).toHaveBeenCalledTimes(1);
    expect(mockUnregisterHttpMcpRoutes).toHaveBeenCalledTimes(1);
    expect(mockUnregisterGatewayRoutes).toHaveBeenCalledTimes(1);
    expect(mockRevokeStdioMcpRoutes).toHaveBeenCalledTimes(1);
  });

  it('reports an interrupted Codex turn as cancelled only when aborted', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    mockRunCodexTurn.mockResolvedValue({
      status: 'interrupted',
      threadId: 'pipeline-thread',
      finalText: '',
      usage: {},
    });
    const controller = new AbortController();
    controller.abort();
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      status: 'cancelled',
      failure: { message: 'Codex pipeline turn was cancelled.' },
    });
  });

  describe('Codex app-server transport failures', () => {
    async function runFailingCodexStep(error: Error): Promise<unknown> {
      resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
      mockRunCodexTurn.mockRejectedValue(error);
      const runtime = createElectronExecutionRuntime();
      return runtime.codexPromptRunner?.runCodexPrompt({
        cwd: '/workspace/repo',
        prompt: 'do the work',
        environment: {},
        model: 'gpt-6-sol',
        fastMode: false,
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Codex',
      });
    }

    it.each([
      [
        'an unanswered thread/resume',
        new CodexAppServerRequestTimeoutError('thread/resume', 120_000),
      ],
      [
        'an unanswered thread/start',
        new CodexAppServerRequestTimeoutError('thread/start', 120_000),
      ],
      ['a forced shared restart', new CodexSharedRestartPeerError()],
      [
        'a thread that stayed closing',
        new CodexAppServerJsonRpcError(
          'thread/resume',
          'thread t-1 is closing; retry thread/resume after the thread is closed',
          -32600,
          undefined,
        ),
      ],
    ])(
      'marks %s as temporarily unavailable so the run can resume',
      async (_label, error) => {
        expect(await runFailingCodexStep(error)).toMatchObject({
          status: 'failure',
          failure: {
            provider: 'codex',
            classification: {
              kind: 'provider_temporarily_unavailable',
              code: 'provider_timeout',
              provider: 'codex',
              account_scope: 'native',
            },
          },
        });
      },
    );

    it('keeps the resumed session without claiming agent activity when resume setup fails', async () => {
      resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
      mockResumeCodexThread.mockRejectedValue(
        new CodexAppServerRequestTimeoutError('thread/resume', 120_000),
      );
      const runtime = createElectronExecutionRuntime();

      const result = await runtime.codexPromptRunner?.runCodexPrompt({
        cwd: '/workspace/repo',
        prompt: 'continue the work',
        environment: {},
        model: 'gpt-6-sol',
        fastMode: false,
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Codex',
        resumeSessionId: 'existing-thread',
      });

      expect(result).toMatchObject({
        status: 'failure',
        failure: {
          session_id: 'existing-thread',
          // Nothing ran in this attempt; the step runner carries over activity
          // from the checkpoint this resume was continuing, when there is one.
          had_agent_activity: false,
          classification: { kind: 'provider_temporarily_unavailable' },
        },
      });
    });

    it('classifies a shared restart from the failed turn outcome', async () => {
      resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
      mockRunCodexTurn.mockResolvedValue({
        status: 'failed',
        threadId: 'pipeline-thread',
        finalText: '',
        usage: {},
        error:
          'Codex app-server was restarted because another turn could not be interrupted cleanly. Please retry this message.',
        transportFailure: { codex_error_code: 'app_server_shared_restart' },
      });
      const runtime = createElectronExecutionRuntime();

      const result = await runtime.codexPromptRunner?.runCodexPrompt({
        cwd: '/workspace/repo',
        prompt: 'do the work',
        environment: {},
        model: 'gpt-6-sol',
        fastMode: false,
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Codex',
      });

      expect(result).toMatchObject({
        status: 'failure',
        failure: {
          classification: {
            kind: 'provider_temporarily_unavailable',
            code: 'provider_timeout',
          },
        },
      });
    });

    it.each([
      [
        'an unanswered turn/start, which may already be running',
        new CodexAppServerRequestTimeoutError('turn/start', 600_000),
      ],
      [
        'a writer held outside this app',
        new CodexAppServerJsonRpcError(
          'thread/resume',
          'thread t-1 already has an active writer',
          -32600,
          undefined,
        ),
      ],
      ['an unrelated error', new Error('authentication required')],
    ])('leaves %s unclassified', async (_label, error) => {
      const result = await runFailingCodexStep(error);
      expect(result).toMatchObject({ status: 'failure' });
      expect(Reflect.get(Object(result), 'failure')).not.toHaveProperty(
        'classification',
      );
    });
  });

  it('runs a proxy-routed step with its native model and does not call it AI Credits', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue({
      provider: 'codex',
      model: 'gpt-6-sol',
      env: {},
      accountProxyRouted: true,
      codexConfig: { model_provider: 'canopy_account_proxy' },
    });
    mockRunCodexTurn.mockImplementation(() =>
      Promise.resolve({
        status: 'failed',
        threadId: 'pipeline-thread',
        finalText: '',
        usage: {},
        error: 'The proxy is unavailable',
      }),
    );
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result).toMatchObject({ status: 'failure', aiCreditsRouted: false });
    const thread = JSON.stringify(mockStartCodexThread.mock.calls.at(-1));
    expect(thread).toContain('canopy_account_proxy');
    expect(thread).toContain('gpt-6-sol');
  });

  it('attributes routed failures to AI Credits without lifecycle-only agent activity', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue({
      provider: 'codex',
      model: 'gateway-model',
      env: {},
      codexConfig: {},
    });
    mockRunCodexTurn.mockImplementation((request) => {
      void request.onEvent?.({
        method: 'turn/started',
        params: { threadId: 'pipeline-thread', turnId: 'turn-1' },
      });
      void request.onEvent?.({
        method: 'turn/completed',
        params: {
          threadId: 'pipeline-thread',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: 'Gateway stream disconnected',
              codexErrorInfo: { responseStreamDisconnected: null },
            },
          },
        },
      });
      return Promise.resolve({
        status: 'failed',
        threadId: 'pipeline-thread',
        finalText: '',
        usage: {},
        error: 'Gateway stream disconnected',
      });
    });
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result).toMatchObject({
      status: 'failure',
      aiCreditsRouted: true,
      failure: {
        had_agent_activity: false,
        classification: {
          account_scope: 'ai_credits',
          code: 'stream_disconnected',
        },
      },
    });
  });

  describe('pipeline agent Ledger tools', () => {
    const ledgerTools = {
      systemPrompt: jest.fn(() => 'LEDGER BLOCK'),
      execute: jest.fn(() => Promise.resolve({ text: '{"ok":true}' })),
    };
    const codexRequest = {
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {},
      model: 'gpt-5.4',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    };
    const ledgerNames = [
      CANOPY_INJECTED_TOOL_REGISTRY.add_ledger_entry.codexToolName,
      CANOPY_INJECTED_TOOL_REGISTRY.search_ledger_entries.codexToolName,
      CANOPY_INJECTED_TOOL_REGISTRY.update_ledger_entry.codexToolName,
    ];
    const approvalCheck = jest.fn<
      Promise<{ decision: 'allow' | 'deny' }>,
      [unknown, unknown]
    >();
    const disposeApproval = jest.fn();

    beforeEach(() => {
      resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
      mockGetPipelineLedgerAttemptTools.mockImplementation((key: unknown) =>
        key === 'attempt-1' ? ledgerTools : undefined,
      );
      approvalCheck.mockReset();
      approvalCheck.mockResolvedValue({ decision: 'allow' });
      disposeApproval.mockReset();
      // The real Codex policy, under a fake approval session.
      mockOpenPipelineLedgerCodexTools.mockImplementation((key: unknown) => {
        if (key !== 'attempt-1') return undefined;
        const { specs, policy } = jest
          .requireActual<
            typeof PipelineLedgerModule
          >('../pipelines/pipeline-ledger')
          .pipelineLedgerCodexTools(ledgerTools, { check: approvalCheck });
        return {
          instructions: 'LEDGER BLOCK',
          specs,
          policy,
          dispose: disposeApproval,
        };
      });
    });

    it('serves an open attempt on a new Codex thread', async () => {
      const runtime = createElectronExecutionRuntime();

      await runtime.codexPromptRunner?.runCodexPrompt({
        ...codexRequest,
        ledgerAttemptKey: 'attempt-1',
      });

      const startRequest = mockStartCodexThread.mock.calls[0]?.[0];
      expect(
        startRequest?.params.dynamicTools?.map((tool) => tool.name),
      ).toEqual(ledgerNames);
      expect(startRequest?.params.developerInstructions).toContain(
        'LEDGER BLOCK',
      );
      // The snapshot leaves the tools out, so a resume matches its lease.
      expect(startRequest?.capabilitySnapshotId).toBe(
        createCodexCapabilitySnapshotId({
          roots: [],
          mcpServers: {},
          mcpAuthorityIds: [],
        }),
      );
      expect(mockOpenPipelineLedgerCodexTools).toHaveBeenCalledWith(
        'attempt-1',
        '/workspace/repo',
      );
      // The step's approval session ends with the step.
      expect(disposeApproval).toHaveBeenCalledTimes(1);
      const policy = mockRunCodexTurn.mock.calls[0]?.[0].hostToolPolicy;
      if (policy === undefined) throw new Error('Expected a host tool policy');
      const signal = new AbortController().signal;
      const call = {
        threadId: 'pipeline-thread',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: null,
        tool: ledgerNames[1] ?? '',
        arguments: {},
      };
      // Each call passes the step's approval session first.
      await expect(policy.authorize(call, signal)).resolves.toBe(true);
      expect(approvalCheck).toHaveBeenCalledWith(
        { kind: 'tool', toolName: ledgerNames[1] },
        expect.objectContaining({ toolUseId: 'codex-call-1' }),
      );
      approvalCheck.mockResolvedValueOnce({ decision: 'deny' });
      await expect(policy.authorize(call, signal)).resolves.toBe(false);
      await expect(
        policy.execute(
          {
            threadId: 'pipeline-thread',
            turnId: 'turn-1',
            callId: 'call-1',
            namespace: null,
            tool: ledgerNames[1] ?? '',
            arguments: {},
          },
          signal,
        ),
      ).resolves.toMatchObject({ success: true });
      expect(ledgerTools.execute).toHaveBeenCalledWith(
        'search_ledger_entries',
        {},
        { invocationId: 'codex:pipeline-thread:turn-1:call-1', signal },
      );
    });

    it('serves a resumed thread the tools it started with, without new ones', async () => {
      const runtime = createElectronExecutionRuntime();

      await runtime.codexPromptRunner?.runCodexPrompt({
        ...codexRequest,
        resumeSessionId: 'existing-thread',
        ledgerAttemptKey: 'attempt-1',
      });

      const resumeRequest = mockResumeCodexThread.mock.calls[0]?.[0];
      expect(resumeRequest?.params).not.toHaveProperty('dynamicTools');
      expect(resumeRequest?.params).not.toHaveProperty('developerInstructions');
      expect(mockRunCodexTurn.mock.calls[0]?.[0].hostToolPolicy).toBeDefined();
    });

    it('leaves a Codex step unchanged without an attempt', async () => {
      const runtime = createElectronExecutionRuntime();

      await runtime.codexPromptRunner?.runCodexPrompt(codexRequest);

      const startRequest = mockStartCodexThread.mock.calls[0]?.[0];
      expect(startRequest?.params).not.toHaveProperty('dynamicTools');
      expect(startRequest?.params).not.toHaveProperty('developerInstructions');
      expect(mockRunCodexTurn.mock.calls[0]?.[0]).not.toHaveProperty(
        'hostToolPolicy',
      );
    });

    it('hands a pipeline worker the attempt tools, and a plain worker none', async () => {
      mockRunWorker.mockResolvedValue({
        status: 'success',
        workerId: 'worker-1',
        sessionId: 'session-1',
        finalText: 'done',
        result: null,
        transcriptJsonl: '',
        transcript: [],
      });
      const runtime = createElectronExecutionRuntime();
      const workerRequest = {
        cwd: process.cwd(),
        prompt: 'do it',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Agent',
      };

      await runtime.agentPromptWorker?.runAgentPrompt({
        ...workerRequest,
        ledgerAttemptKey: 'attempt-1',
      });
      await runtime.agentPromptWorker?.runAgentPrompt(workerRequest);

      const workerRequests = mockRunWorker.mock.calls.map(
        (call: readonly unknown[]): unknown => call[0],
      );
      expect(workerRequests[0]).toMatchObject({
        kind: 'pipeline_agent_prompt',
        ledgerTools,
      });
      expect(workerRequests[1]).toBeDefined();
      expect(workerRequests[1]).toMatchObject({ ledgerTools: undefined });
    });
  });

  it('prepends the pipeline system prompt to the Codex turn input', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      systemPrompt: 'Follow the review rubric.',
      environment: {},
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    const startRequest = mockStartCodexThread.mock.calls[0]?.[0] as
      | { params?: { developerInstructions?: string } }
      | undefined;
    expect(startRequest?.params).not.toHaveProperty('developerInstructions');
    expect(mockRunCodexTurn.mock.calls[0]?.[0].input).toEqual([
      {
        type: 'text',
        text: 'Follow the review rubric.\n\ndo the work',
        text_elements: [],
      },
    ]);
  });

  it('does not inject current global instructions when resuming a Codex thread', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();
    const globalInstructionsEnvName = brandEnvName(
      'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
    );

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'continue',
      resumeSessionId: 'existing-thread',
      environment: {
        [globalInstructionsEnvName]: JSON.stringify({
          overall: 'Do not inject this.',
          scoped: [],
        }),
      },
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    const resumeRequest = mockResumeCodexThread.mock.calls[0]?.[0];
    expect(resumeRequest?.params).not.toHaveProperty('developerInstructions');
  });

  it('resolves Ollama-scoped global instructions for an Ollama Codex invocation', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    const runtime = createElectronExecutionRuntime();
    const globalInstructionsEnvName = brandEnvName(
      'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
    );

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'do the work',
      environment: {
        [globalInstructionsEnvName]: JSON.stringify({
          overall: '',
          scoped: [
            {
              id: 'ollama-only',
              text: 'Use the local Ollama workflow.',
              mode: 'append',
              harnesses: ['ollama'],
              models: [],
              workspaceTypes: [],
            },
          ],
        }),
      },
      model: toOllamaModelId('qwen3'),
      harnessInvocation: {
        source: 'ollama',
        harness: 'codex',
        runtimeModel: 'qwen3',
        aiCreditsRouted: false,
      },
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Ollama',
    });

    const startRequest = mockStartCodexThread.mock.calls[0]?.[0];
    expect(startRequest?.params.developerInstructions).toContain(
      'Use the local Ollama workflow.',
    );
  });

  it("keeps the model's malformed text out of the retry prompt and the failure", async () => {
    // V8's `JSON.parse` message embeds an excerpt of the text it choked on, so
    // a raw parse put model bytes - which can carry a configured value, cut
    // anywhere - into the structured-output retry prompt sent back to the
    // vendor and into the thrown failure. The CLI runner already formats this
    // safely; the desktop runner parsed directly.
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    // The value sits where V8's excerpt actually falls (its message quotes the
    // first few characters), so this is the disclosure, not a hypothetical one.
    const malformed = 'SYNTHETIC-SECRET-8891 is not json';
    mockRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'pipeline-thread',
      finalText: malformed,
      usage: {},
    });
    const runtime = createElectronExecutionRuntime();

    const failure = await runtime.codexPromptRunner
      ?.runCodexPrompt({
        cwd: '/workspace/repo',
        prompt: 'summarize',
        environment: {},
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        model: 'gpt-6-sol',
        fastMode: false,
        totalTimeoutMs: 60_000,
        permissionPreset: 'read_only',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        attempt: 1,
        stepLabel: 'Codex',
      })
      .then(
        (value) => value,
        (error: unknown) => error,
      );

    // Malformed structured output is still retryable, so the classification is
    // unchanged...
    expect(mockRunCodexTurn.mock.calls.length).toBeGreaterThan(1);
    const retryInput = JSON.stringify(
      mockRunCodexTurn.mock.calls[1]?.[0].input,
    );
    expect(retryInput).toContain(
      'Your previous response failed JSON Schema validation.',
    );
    // ...but neither the retry prompt nor the reported failure repeats the
    // model's own bytes.
    expect(retryInput).not.toContain('SYNTHETIC-SECRET-8891');
    const reported =
      failure instanceof Error
        ? failure.message
        : JSON.stringify(failure ?? null);
    expect(reported).not.toContain('SYNTHETIC-SECRET-8891');
    expect(reported).toContain('Response was not valid JSON');
  });

  it('still parses ordinary structured output', async () => {
    // Control: valid JSON is unaffected by the safe formatting.
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    mockRunCodexTurn.mockResolvedValue({
      status: 'completed',
      threadId: 'pipeline-thread',
      finalText: '{"summary":"done"}',
      usage: {},
    });
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'summarize',
      environment: {},
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result).toMatchObject({
      status: 'success',
      structured: { summary: 'done' },
    });
  });

  it('shrinks the Codex retry budget across attempts instead of restarting it', async () => {
    // Independent-review finding (test-coverage asymmetry): only the Cursor
    // runner had a test proving the single step deadline shrinks across
    // structured-output retries. The identical Codex change was unverified,
    // so a regression here would have been silent.
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    // A controlled clock: the first attempt takes exactly 20 seconds. The
    // single step deadline must hand the retry the remaining 40, where the old
    // per-attempt restart handed it a fresh 60.
    let now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockRunCodexTurn
      .mockImplementationOnce(() => {
        now += 20_000;
        return Promise.resolve({
          status: 'failed',
          threadId: 'pipeline-thread',
          finalText: '',
          usage: {},
          error: 'Response does not match output schema',
        });
      })
      .mockResolvedValueOnce({
        status: 'completed',
        threadId: 'pipeline-thread',
        finalText: '{"summary":"done"}',
        usage: {},
      });
    const runtime = createElectronExecutionRuntime();

    await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'summarize',
      environment: {},
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });
    clock.mockRestore();

    expect(mockRunCodexTurn).toHaveBeenCalledTimes(2);
    expect(mockRunCodexTurn.mock.calls[0]?.[0]).toMatchObject({
      totalTimeoutMs: 60_000,
    });
    expect(mockRunCodexTurn.mock.calls[1]?.[0]).toMatchObject({
      totalTimeoutMs: 40_000,
    });
  });

  it('retries recoverable structured output failures on the same thread', async () => {
    resolveAiCreditsRoutingOverrideMock.mockResolvedValue(null);
    mockRunCodexTurn
      .mockResolvedValueOnce({
        status: 'failed',
        threadId: 'pipeline-thread',
        finalText: '',
        usage: {},
        error: 'Response does not match output schema',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        threadId: 'pipeline-thread',
        finalText: '{"summary":"done"}',
        usage: {},
      });
    const runtime = createElectronExecutionRuntime();

    const result = await runtime.codexPromptRunner?.runCodexPrompt({
      cwd: '/workspace/repo',
      prompt: 'summarize',
      environment: {},
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      model: 'gpt-6-sol',
      fastMode: false,
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Codex',
    });

    expect(result).toMatchObject({
      status: 'success',
      structured: { summary: 'done' },
    });
    expect(mockRunCodexTurn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockRunCodexTurn.mock.calls[1]?.[0].input)).toContain(
      'Your previous response failed JSON Schema validation.',
    );
    const retryStartRequest = mockStartCodexThread.mock.calls[0]?.[0] as
      | { params?: { serviceTier?: string } }
      | undefined;
    expect(retryStartRequest?.params?.serviceTier).toBe('default');
  });
});

describe('cursorPromptRunner', () => {
  it('delegates to runCursorPipelinePrompt', async () => {
    const cursorResult = {
      status: 'success' as const,
      sessionId: 'cursor-sess-1',
      rawText: 'done',
      transcript: '',
      usage: {},
    };
    runCursorPipelinePromptMock.mockResolvedValue(cursorResult);
    const runtime = createElectronExecutionRuntime();

    const request = {
      cwd: '/workspace/repo',
      prompt: 'summarize',
      environment: {},
      model: 'cursor-default',
      totalTimeoutMs: 60_000,
      permissionPreset: 'read_only' as const,
      executionsDir: '/exec',
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 1,
      stepLabel: 'Cursor',
    };
    const result = await runtime.cursorPromptRunner?.runCursorPrompt(request);

    expect(runCursorPipelinePromptMock).toHaveBeenCalledWith(request);
    expect(result).toEqual(cursorResult);
  });

  it('loads ./cursor-prompt-runner via a dynamic import, not a static one, so the ESM-only ACP SDK chain stays off the startup evaluation path', () => {
    // execution-runtime.ts is statically imported by ipc/archived-containers.ts,
    // ipc/usage-limited-chats.ts, and pipelines/pipeline-handlers.ts, all
    // reachable at Electron main startup. cursor-prompt-runner.ts transitively
    // imports node/cursor/turn-driver -> node/acp/client, which pulls in the
    // ESM-only '@agentclientprotocol/sdk'. A static import of
    // './cursor-prompt-runner' here would put that ESM chain on the static
    // require graph the bytecode-compiled main build resolves at load (CAN
    // production `npm run build`); the dynamic edge keeps its module body
    // from being EVALUATED until a Cursor step actually runs.
    //
    // Scope of this assertion, stated honestly (independent-review finding
    // L1): the main build sets `output.inlineDynamicImports: true`
    // (apps/desktop-app/electron.vite.config.ts), which is load-bearing for
    // the executor's own circular dynamic import. Rollup therefore INLINES
    // this module into the single main chunk, so this does not keep those
    // bytes out of the emitted bundle, and no source-text assertion could
    // observe that either way. What it does pin is the source shape that
    // keeps the chain off the static require graph and out of startup
    // evaluation — which is the property the call site depends on.
    const source = readFileSync(
      path.join(__dirname, '../pipelines/execution-runtime.ts'),
      'utf8',
    );
    const staticImportPattern =
      /^import\s+.*from\s+'\.\/cursor-prompt-runner';/m;
    const dynamicImportPattern =
      /await import\(\s*'\.\/cursor-prompt-runner'\s*\)/;

    expect(source).not.toMatch(staticImportPattern);
    expect(source).toMatch(dynamicImportPattern);
  });
});

describe('nested pipeline ownership', () => {
  beforeEach((): void => {
    mockSharedPipeline.mockClear();
    mockSelectionSharedPipeline.mockClear();
    mockBoundSharedPipeline.mockClear();
    mockParentBinding.mockClear();
  });
  afterEach((): void => {
    mockPipelineContextEnabled = false;
  });
  it('uses account-bound share reads for contextual parents, children, and installed copies', async () => {
    mockPipelineContextEnabled = true;
    const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const owner = { type: 'organization', id: 'org-a', name: null };
    mockSharedPipeline.mockResolvedValue({
      owner,
      rawPipeline: 'name: Child\non: dispatch\njobs: {}',
    });
    mockParentBinding.mockResolvedValue({
      accountId: 'user-a',
      receipt: {
        family: 'pipelines',
        remoteId: 'copy-remote',
        localResourceIds: ['installed-copy'],
        shareScope: 'organization',
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
        hash: 'hash',
        authorizedAt: '2026-09-24T00:00:00Z',
      },
    });
    const stored = jest
      .spyOn(pipelineStore, 'getStoredPipelinePathWithSource')
      .mockReturnValue({
        success: true,
        data: { source: 'user', filePath: '/stored/installed-copy.yaml' },
      });
    try {
      const runtime = createElectronExecutionRuntime();
      const resolveParent = runtime.resolvePipelineContextResource;
      const resolveChild = runtime.resolvePipelineResource;
      if (!resolveParent || !resolveChild)
        throw new Error('Missing resource resolver');
      const parent = await resolveParent(
        { pipelineId: 'shared:canopy-cloud:parent' },
        executionContext,
      );
      expect(parent).toMatchObject({ owner });
      await expect(
        resolveChild(
          'shared:canopy-cloud:child',
          { owner },
          undefined,
          undefined,
          executionContext,
        ),
      ).resolves.toMatchObject({ pipeline: { name: 'Child' } });
      await expect(
        resolveChild(
          'installed-copy',
          { owner },
          undefined,
          undefined,
          executionContext,
        ),
      ).resolves.toBeUndefined();
      expect(mockBoundSharedPipeline.mock.calls).toEqual([
        ['parent'],
        ['child'],
        ['copy-remote'],
      ]);
      expect(mockSelectionSharedPipeline).not.toHaveBeenCalled();
      expect(assertPipelineContext).toHaveBeenCalledWith(
        expect.objectContaining({ owner }),
        undefined,
        executionContext,
      );
    } finally {
      stored.mockRestore();
    }
  });
  it.each(['personal', 'org-a', 'org-b', 'flag-off'])(
    'authorizes nested org child against resolved %s target',
    async (target): Promise<void> => {
      mockPipelineContextEnabled = target !== 'flag-off';
      mockSharedPipeline.mockResolvedValue({
        owner: { type: 'organization', id: 'org-a', name: null },
        rawPipeline: 'name: Child\non: dispatch\njobs: {}',
      });
      const authorize = jest.mocked(assertPipelineContext);
      authorize.mockImplementation(
        (_resource, projectId): Promise<void> =>
          projectId && projectId !== 'org-a'
            ? Promise.reject(
                new Error('Pipeline unavailable (context-mismatch)'),
              )
            : Promise.resolve(),
      );
      const resolve = createElectronExecutionRuntime().resolvePipelineResource;
      if (!resolve) throw new Error('Missing resource resolver');
      try {
        const result = resolve(
          'shared:canopy-cloud:child',
          { owner: { type: 'organization', id: 'org-a', name: null } },
          undefined,
          {
            cwd: '/target',
            scope: 'worktree',
            projectId: target,
            worktreeId: 'wt',
            target: {
              scope: 'worktree',
              workspace_id: target,
              worktree_id: 'wt',
              path: '/target',
              created: false,
            },
          },
        );
        if (target === 'personal' || target === 'org-b')
          await expect(result).rejects.toThrow(
            'Pipeline unavailable (context-mismatch)',
          );
        else if (target === 'flag-off')
          await expect(result).resolves.toBeUndefined();
        else await expect(result).resolves.toBeDefined();
      } finally {
        authorize.mockImplementation(async (): Promise<void> => {});
      }
    },
  );

  it.each(['organization', 'receipt', 'personal', 'flag-off'])(
    'requires a verified project for %s directory execution',
    async (kind): Promise<void> => {
      mockPipelineContextEnabled = kind !== 'flag-off';
      const resolve = createElectronExecutionRuntime().resolvePipelineResource;
      if (!resolve) throw new Error('Missing resource resolver');
      const parent = {
        owner: {
          type: kind === 'organization' ? 'organization' : 'user',
          id: 'org-a',
          name: null,
        },
        ...(kind === 'receipt'
          ? {
              provenance: {
                family: 'pipelines',
                remoteId: 'remote',
                localResourceIds: ['copy'],
                shareScope: 'organization',
                ownerContext: { kind: 'organization', organizationId: 'org-a' },
                hash: 'hash',
                authorizedAt: '2026-09-24T00:00:00Z',
              },
            }
          : {}),
      } satisfies Parameters<typeof resolve>[1];
      const result = resolve('inline-pipeline', parent, undefined, {
        cwd: '/arbitrary',
        scope: 'directory',
        target: { scope: 'directory', path: '/arbitrary' },
      });
      if (kind === 'organization' || kind === 'receipt')
        await expect(result).rejects.toThrow(
          'Pipeline unavailable (unsupported-target)',
        );
      else await expect(result).resolves.toBeUndefined();
    },
  );

  it('retains file source authorization through a retargeted child and grandchild', async (): Promise<void> => {
    mockPipelineContextEnabled = true;
    const executionContext = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockSharedPipeline.mockResolvedValue({
      owner: { type: 'organization', id: 'org-a', name: null },
    });
    const root = await mkdtemp(path.join(tmpdir(), 'retargeted-source-'));
    const destination = await mkdtemp(
      path.join(tmpdir(), 'retargeted-destination-'),
    );
    await writeFile(
      path.join(root, 'child.yaml'),
      `name: Child
scope: worktree
on: dispatch
jobs:
  nested:
    steps:
      - id: grandchild
        uses: builtin/run-pipeline
        with:
          pipeline: grandchild.yaml
`,
    );
    await writeFile(
      path.join(root, 'grandchild.yaml'),
      'name: Grandchild\nscope: worktree\non: dispatch\njobs: {}',
    );
    const authorize = jest
      .spyOn(pipelineInstallContext, 'authorizeProjectPipelineRequest')
      .mockImplementation(
        (
          request,
        ): ReturnType<
          typeof pipelineInstallContext.authorizeProjectPipelineRequest
        > => {
          if (request.cwd !== root || path.dirname(request.filePath) !== root)
            return Promise.reject(
              new Error('Pipeline unavailable (unsupported-target)'),
            );
          return Promise.resolve({
            projectId: 'source-project',
            owner: { type: 'organization', id: 'org-a', name: null },
          });
        },
      );
    try {
      const result = await runStep({
        executionId: 'source-exec',
        jobId: 'source-job',
        pipelineId: 'shared:canopy-cloud:parent',
        projectId: 'source-project',
        worktreeId: 'source-wt',
        executionContext,
        allowUnverifiedForegroundChildren: true,
        cwd: root,
        env: {},
        step: {
          id: 'child',
          uses: 'builtin/run-pipeline',
          with: { pipeline: 'child.yaml' },
          target: {
            scope: 'worktree',
            workspace_id: 'destination-project',
            worktree: { id: 'destination-wt' },
          },
        },
        runtime: {
          ...createElectronExecutionRuntime(),
          executionsDir: root,
          tempRootDir: root,
          bundledActionsDir: path.resolve(
            'packages/desktop-shared/resources/actions',
          ),
          resolvePipelineTarget: (): Promise<ResolvePipelineTargetResult> =>
            Promise.resolve({
              cwd: destination,
              scope: 'worktree',
              projectId: 'destination-project',
              worktreeId: 'destination-wt',
              target: {
                scope: 'worktree',
                workspace_id: 'destination-project',
                worktree_id: 'destination-wt',
                path: destination,
                created: false,
              },
            }),
        },
        signal: new AbortController().signal,
      });
      expect(
        authorize.mock.calls.map(([request]) => request.cwd),
      ).not.toContain(destination);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('success');
      expect(authorize).toHaveBeenCalledWith({
        id: 'grandchild.yaml',
        cwd: root,
        filePath: path.join(root, 'grandchild.yaml'),
      });
      expect(assertPipelineContext).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { type: 'organization', id: 'org-a', name: null },
        }),
        'destination-project',
        executionContext,
      );
    } finally {
      authorize.mockRestore();
      await rm(root, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    }
  });

  it('refuses run-pipeline after resolving a Personal target override', async (): Promise<void> => {
    mockPipelineContextEnabled = true;
    mockSharedPipeline.mockResolvedValue({
      owner: { type: 'organization', id: 'org-a', name: null },
      rawPipeline: 'name: Child\nscope: worktree\non: dispatch\njobs: {}',
    });
    const authorize = jest.mocked(assertPipelineContext);
    authorize.mockImplementation(
      (_resource, projectId): Promise<void> =>
        projectId === 'personal'
          ? Promise.reject(new Error('Pipeline unavailable (context-mismatch)'))
          : Promise.resolve(),
    );
    const root = await mkdtemp(path.join(tmpdir(), 'nested-target-'));
    try {
      const result = await runStep({
        executionId: 'exec-1',
        jobId: 'job-1',
        pipelineId: 'shared:canopy-cloud:parent',
        projectId: 'org-a',
        worktreeId: 'parent-wt',
        cwd: root,
        env: {},
        step: {
          id: 'nested',
          uses: 'builtin/run-pipeline',
          with: { pipeline: 'shared:canopy-cloud:child' },
          target: {
            scope: 'worktree',
            workspace_id: 'personal',
            worktree: { id: 'wt' },
          },
        },
        runtime: {
          ...createElectronExecutionRuntime(),
          executionsDir: root,
          tempRootDir: root,
          bundledActionsDir: path.resolve(
            'packages/desktop-shared/resources/actions',
          ),
          resolvePipelineTarget: (): Promise<ResolvePipelineTargetResult> =>
            Promise.resolve({
              cwd: root,
              scope: 'worktree',
              projectId: 'personal',
              worktreeId: 'wt',
              target: {
                scope: 'worktree',
                workspace_id: 'personal',
                worktree_id: 'wt',
                path: root,
                created: false,
              },
            }),
        },
        signal: new AbortController().signal,
      });
      expect(result.status).toBe('failure');
      expect(result.error).toContain('Pipeline unavailable (context-mismatch)');
    } finally {
      authorize.mockImplementation(async (): Promise<void> => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['personal', 'org-a'])(
    'binds inline run-pipeline to the resolved %s target',
    async (target): Promise<void> => {
      mockPipelineContextEnabled = true;
      mockSharedPipeline.mockResolvedValue({
        owner: { type: 'organization', id: 'org-a', name: null },
        rawPipeline: 'name: Child\nscope: worktree\non: dispatch\njobs: {}',
      });
      const authorize = jest.mocked(assertPipelineContext);
      authorize.mockImplementation(
        (_resource, projectId): Promise<void> =>
          projectId === 'personal'
            ? Promise.reject(
                new Error('Pipeline unavailable (context-mismatch)'),
              )
            : Promise.resolve(),
      );
      const root = await mkdtemp(path.join(tmpdir(), 'nested-target-'));
      try {
        const result = await runStep({
          executionId: 'exec-1',
          jobId: 'job-1',
          pipelineId: 'shared:canopy-cloud:parent',
          projectId: 'org-a',
          worktreeId: 'parent-wt',
          cwd: root,
          env: {},
          step: {
            id: 'nested',
            uses: 'builtin/run-pipeline',
            with: {
              pipeline_yaml:
                'name: Inline\nscope: worktree\non: dispatch\njobs: {}',
            },
            target: {
              scope: 'worktree',
              workspace_id: target,
              worktree: { id: 'wt' },
            },
          },
          runtime: {
            ...createElectronExecutionRuntime(),
            executionsDir: root,
            tempRootDir: root,
            bundledActionsDir: path.resolve(
              'packages/desktop-shared/resources/actions',
            ),
            resolvePipelineTarget: (): Promise<ResolvePipelineTargetResult> =>
              Promise.resolve({
                cwd: root,
                scope: 'worktree',
                projectId: target,
                worktreeId: 'wt',
                target: {
                  scope: 'worktree',
                  workspace_id: target,
                  worktree_id: 'wt',
                  path: root,
                  created: false,
                },
              }),
          },
          signal: new AbortController().signal,
        });
        if (target === 'personal') {
          expect(result.status).toBe('failure');
          expect(result.error).toContain(
            'Pipeline unavailable (context-mismatch)',
          );
        } else expect(result.status).toBe('success');
      } finally {
        authorize.mockImplementation(async (): Promise<void> => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('resolves a bundled relative child parent as system-owned', async (): Promise<void> => {
    mockPipelineContextEnabled = true;
    const authorize = jest
      .spyOn(pipelineInstallContext, 'authorizeProjectPipelineRequest')
      .mockRejectedValue(
        new Error('Pipeline unavailable (unsupported-target)'),
      );
    const resolve =
      createElectronExecutionRuntime().resolvePipelineContextResource;
    if (!resolve) throw new Error('Missing resource resolver');
    try {
      await expect(
        resolve({
          pipelineId: 'relative-child.yaml',
          projectId: 'personal',
          cwd: '/repo',
          pipelineFileDir: '/bundled/pipelines/nested',
        }),
      ).resolves.toEqual({ owner: { type: 'system' } });
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      authorize.mockRestore();
    }
  });

  it('authorizes the executing project parent from its canonical file', async (): Promise<void> => {
    const read = jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        config: {
          version: 1,
          type: 'single-repo',
          repos: [],
          owner: { type: 'organization', organizationId: 'org-a' },
        },
      });
    mockPipelineContextEnabled = true;
    const authorize = jest
      .spyOn(pipelineInstallContext, 'authorizeProjectPipelineRequest')
      .mockResolvedValue({
        projectId: 'project-a',
        owner: { type: 'organization', id: 'org-a', name: null },
      });
    const resolve =
      createElectronExecutionRuntime().resolvePipelineContextResource;
    if (!resolve) throw new Error('Missing resource resolver');
    try {
      await expect(
        resolve({
          pipelineId: 'project--parent.yaml',
          projectId: 'project-a',
          cwd: '/repo',
          pipelineFileDir: '/repo/.canopy/pipelines',
        }),
      ).resolves.toMatchObject({
        owner: { type: 'organization', id: 'org-a' },
      });
      expect(authorize).toHaveBeenCalledWith({
        id: 'project--parent.yaml',
        cwd: '/repo',
        filePath: '/repo/.canopy/pipelines/parent.yaml',
      });
    } finally {
      authorize.mockRestore();
      read.mockRestore();
    }
  });

  it.each(['./child.yaml', '../outside.yaml'])(
    'resolves organization project child %s with canonical ownership',
    async (reference): Promise<void> => {
      mockPipelineContextEnabled = true;
      mockParentBinding.mockResolvedValue(undefined);
      const root = await mkdtemp(path.join(tmpdir(), 'org-child-'));
      await writeFile(
        path.join(root, 'child.yaml'),
        'name: Child\non: dispatch\njobs: {}',
      );
      const authorize = jest
        .spyOn(pipelineInstallContext, 'authorizeProjectPipelineRequest')
        .mockResolvedValue({
          projectId: 'project-a',
          owner: { type: 'organization', id: 'org-a', name: null },
        });
      try {
        const result = resolveChildPipeline({
          pipelineRef: reference,
          cwd: root,
          pipelineFileDir: root,
          parent: { owner: { type: 'organization', id: 'org-a', name: null } },
          resolvePipelineResource:
            createElectronExecutionRuntime().resolvePipelineResource,
        });
        if (reference.startsWith('../')) await expect(result).rejects.toThrow();
        else {
          await expect(result).resolves.toMatchObject({
            pipeline: { name: 'Child' },
          });
          expect(authorize).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: root,
              filePath: path.join(root, 'child.yaml'),
            }),
          );
          expect(mockParentBinding).not.toHaveBeenCalled();
        }
      } finally {
        authorize.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('treats a file child inside the bundled pipelines directory as system-owned', async (): Promise<void> => {
    mockPipelineContextEnabled = true;
    const authorize = jest
      .spyOn(pipelineInstallContext, 'authorizeProjectPipelineRequest')
      .mockRejectedValue(
        new Error('Pipeline unavailable (unsupported-target)'),
      );
    const resolve = createElectronExecutionRuntime().resolvePipelineResource;
    if (!resolve) throw new Error('Missing pipeline resolver');
    try {
      // System children are allowed for user parents and refused for
      // organization parents by the dependency table; neither consults the
      // project resolver.
      await expect(
        resolve(
          'code-review.yaml',
          { owner: { type: 'user', id: 'user-a', name: null } },
          { cwd: '/repo', filePath: '/bundled/pipelines/code-review.yaml' },
        ),
      ).resolves.toBeUndefined();
      await expect(
        resolve(
          'code-review.yaml',
          { owner: { type: 'organization', id: 'org-a', name: null } },
          { cwd: '/repo', filePath: '/bundled/pipelines/code-review.yaml' },
        ),
      ).rejects.toThrow('Pipeline unavailable (missing-dependency)');
      expect(authorize).not.toHaveBeenCalled();
      await expect(
        resolve(
          '../escape.yaml',
          { owner: { type: 'organization', id: 'org-a', name: null } },
          { cwd: '/repo', filePath: '/bundled/escape.yaml' },
        ),
      ).rejects.toThrow('Pipeline unavailable (unsupported-target)');
    } finally {
      authorize.mockRestore();
    }
  });

  it.each([false, true])(
    'checks installed org child ownership (organization parent=%s)',
    async (organization): Promise<void> => {
      const stored = jest
        .spyOn(pipelineStore, 'getStoredPipelinePathWithSource')
        .mockReturnValue({
          success: true,
          data: { source: 'user', filePath: '/stored/installed-child.yaml' },
        });
      mockPipelineContextEnabled = true;
      mockParentBinding.mockResolvedValue({
        accountId: 'user-a',
        receipt: {
          family: 'pipelines',
          remoteId: 'child-remote',
          localResourceIds: ['installed-child'],
          shareScope: 'organization',
          ownerContext: { kind: 'organization', organizationId: 'org-a' },
          hash: 'hash',
          authorizedAt: '2026-09-24T00:00:00Z',
        },
      });
      mockSharedPipeline.mockResolvedValue({
        owner: { type: 'user', id: 'user-a', name: null },
      });
      const resolve = createElectronExecutionRuntime().resolvePipelineResource;
      if (!resolve) throw new Error('Missing resource resolver');
      const invocation = resolve('installed-child', {
        owner: organization
          ? { type: 'organization', id: 'org-a', name: null }
          : { type: 'user', id: 'user-a', name: null },
      });
      if (organization) await expect(invocation).resolves.toBeUndefined();
      else
        await expect(invocation).rejects.toThrow(
          'Pipeline unavailable (missing-dependency)',
        );
      stored.mockRestore();
    },
  );

  it.each([
    {
      label: 'Personal parent',
      enabled: true,
      organization: false,
      denied: true,
    },
    {
      label: 'same-org parent',
      enabled: true,
      organization: true,
      denied: false,
    },
    { label: 'flag off', enabled: false, organization: false, denied: false },
  ])(
    '$label to organization child',
    async ({ enabled, organization, denied }): Promise<void> => {
      mockPipelineContextEnabled = enabled;
      mockParentBinding.mockResolvedValue(
        organization
          ? {
              accountId: 'user-a',
              receipt: {
                family: 'pipelines',
                remoteId: 'parent-remote',
                localResourceIds: ['parent'],
                shareScope: 'organization',
                ownerContext: { kind: 'organization', organizationId: 'org-a' },
                hash: 'hash',
                authorizedAt: '2026-09-24T00:00:00Z',
              },
            }
          : undefined,
      );
      mockSharedPipeline.mockResolvedValue({
        owner: { type: 'organization', id: 'org-a', name: null },
        rawPipeline: 'name: Child\non: dispatch\njobs: {}',
      });
      const runtime = createElectronExecutionRuntime();
      const resolve = runtime.resolvePipelineResource;
      const resolveParent = runtime.resolvePipelineContextResource;
      if (!resolve || !resolveParent)
        throw new Error('Missing resource resolver');
      const parent = await resolveParent({ pipelineId: 'parent' });
      const invocation = resolve('shared:canopy-cloud:child', parent);
      if (denied)
        await expect(invocation).rejects.toThrow(
          'Pipeline unavailable (missing-dependency)',
        );
      else if (enabled)
        await expect(invocation).resolves.toMatchObject({
          pipeline: { name: 'Child' },
        });
      else {
        await expect(invocation).resolves.toBeUndefined();
        expect(mockSharedPipeline).not.toHaveBeenCalled();
        expect(mockParentBinding).not.toHaveBeenCalled();
      }
    },
  );
});
