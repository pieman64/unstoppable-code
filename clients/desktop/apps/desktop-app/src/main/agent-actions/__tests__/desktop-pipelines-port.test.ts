import type {
  AgentActionCall,
  AgentPipelineRunResult,
  PipelineRunAction,
} from '@canopy/agent-actions';
import type { ExecutePipelineRequestOptions } from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  ExecutionState,
  PipelineData,
} from '@canopy/desktop-shared/types/pipeline';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type { WorktreeActionRuntime } from '../../canopy-tools/worktree-actions';
import { desktopPipelinesPort } from '../desktop-pipelines-port';

const ORG = 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockAgentPipelineOwnerContext = jest.fn<
  Promise<{ owner: string } | { refusal: string }>,
  [{ projectId: string; worktreeId?: string }]
>();
jest.mock('../../pipelines/pipeline-owner-policy', () => ({
  agentPipelineOwnerContext: (target: {
    projectId: string;
    worktreeId?: string;
  }): Promise<{ owner: string } | { refusal: string }> =>
    mockAgentPipelineOwnerContext(target),
}));

const mockLoadAgentGlobalPipelineById = jest.fn<
  Promise<PipelineData | null>,
  [string, string]
>();
const mockLoadAgentPipelineById = jest.fn<
  Promise<PipelineData | null>,
  [string, unknown, string]
>();
const mockAgentResourceActionFailure = jest.fn<
  { ok: false; error?: { code: string; message: string; retryable?: boolean } },
  [unknown]
>(() => ({
  ok: false,
  error: { code: 'validation_failed', message: 'Pipeline unavailable' },
}));
jest.mock('../../canopy-tools/resource-actions', () => ({
  agentResourceActionFailure: (
    cause: unknown,
  ): {
    ok: false;
    error?: { code: string; message: string; retryable?: boolean };
  } => mockAgentResourceActionFailure(cause),
  loadAgentPipelineById: (
    id: string,
    runtime: unknown,
    cwd: string,
  ): Promise<PipelineData | null> =>
    mockLoadAgentPipelineById(id, runtime, cwd),
  loadAgentGlobalPipelineById: (
    id: string,
    executionContext: string,
  ): Promise<PipelineData | null> =>
    mockLoadAgentGlobalPipelineById(id, executionContext),
}));

jest.mock('../../canopy-tools/worktree-actions', () => ({
  initiatorForWorktreeRuntime: (
    runtime: Pick<WorktreeActionRuntime, 'projectId' | 'worktreeId' | 'chatId'>,
  ): unknown => ({
    kind: 'agent',
    chat: {
      projectId: runtime.projectId,
      worktreeId: runtime.worktreeId,
      chatId: runtime.chatId,
    },
  }),
  pipelineExecutionArtifact: jest.fn(),
  pipelineSourceExecutionOptions: (): object => ({}),
  resolveScopedEventPath: jest.fn(),
  runtimeExecutionScope: jest.fn(),
}));

jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (): string => '/repo',
}));

const mockAssertNotSplitLocked = jest.fn<void, [string, string, string]>();
jest.mock('../../services/split-lock-service', () => ({
  assertNotSplitLocked: (
    projectId: string,
    worktreeId: string,
    activity: string,
  ): void => mockAssertNotSplitLocked(projectId, worktreeId, activity),
}));

const mockWatcherSetup = jest.fn<Promise<unknown>, [unknown, unknown, unknown]>(
  () => Promise.resolve({ ok: true }),
);
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    setup: (
      request: unknown,
      destination: unknown,
      options: unknown,
    ): Promise<unknown> => mockWatcherSetup(request, destination, options),
  }),
}));

const mockPreflightGlobalStart = jest.fn<
  Promise<{ reason: 'unsupported_scope'; message: string } | null>,
  [unknown, ExecutePipelineRequestOptions]
>(() => Promise.resolve(null));
jest.mock('../../pipelines/pipeline-global-start', () => ({
  preflightGlobalStart: (
    pipeline: unknown,
    options: ExecutePipelineRequestOptions,
  ): Promise<{ reason: 'unsupported_scope'; message: string } | null> =>
    mockPreflightGlobalStart(pipeline, options),
}));

const mockStartPipelineExecutionFromMain = jest.fn<
  Promise<{ success: true; data: ExecutionState }>,
  [{ options: ExecutePipelineRequestOptions }]
>();
jest.mock('../../pipelines/pipeline-handlers', () => ({
  startPipelineExecutionFromMain: (args: {
    options: ExecutePipelineRequestOptions;
  }): Promise<{ success: true; data: ExecutionState }> =>
    mockStartPipelineExecutionFromMain(args),
}));

jest.mock('../desktop-legacy-family', () => ({
  inlineWatcherSetupJson: (): object => ({ ok: true }),
}));

function globalPipeline(source: 'user' | 'project' = 'user'): PipelineData {
  return {
    info: {
      id: 'global-review',
      name: 'Global review',
      description: '',
      icon: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      filename: 'global-review.yaml',
      source,
      readonly: false,
      scopes: ['global'],
    },
    content: { name: 'Global review', on: 'dispatch', jobs: {} },
  };
}

function startedState(options: ExecutePipelineRequestOptions): ExecutionState {
  const state: ExecutionState = {
    id: 'execution-1',
    version: 10,
    pipeline_id: options.pipelineId ?? 'global-review',
    pipeline_snapshot: { name: 'Global review', scope: ['global'], jobs: {} },
    status: 'running',
    started_at: '2026-10-21T00:00:00.000Z',
    cwd: '/data/pipeline-executions/execution-1/workspace',
    scope: 'global',
    event_name: 'dispatch',
    env: {},
    inputs: {},
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    ...(options.executionContext !== undefined
      ? { execution_context: options.executionContext }
      : {}),
  };
  return state;
}

const AGENT_CHAT = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};
const ADVISOR_CHAT = {
  projectId: 'app-advisor',
  worktreeId: 'advisor-worktree',
  chatId: 'advisor-chat',
};

function host(
  overrides: Partial<CanopyInjectedToolRuntime> = {},
): CanopyInjectedToolRuntime {
  return {
    requestUserAnswers: (): ReturnType<
      CanopyInjectedToolRuntime['requestUserAnswers']
    > => Promise.resolve([]),
    loadScriptOutput: (): ReturnType<
      CanopyInjectedToolRuntime['loadScriptOutput']
    > => Promise.reject(new Error('Unused')),
    ...overrides,
  };
}

const scopedChat = host({
  worktreeActionRuntime: {
    ...AGENT_CHAT,
    cwd: '/repo/worktree-1',
    getWindow: () => null,
  },
});
const appAdvisorChat = host({
  worktreeWatcherRuntime: ADVISOR_CHAT,
  appAdvisorPipelineWindow: () => null,
});

function run(
  action: PipelineRunAction,
  runtime: CanopyInjectedToolRuntime,
  signal?: AbortSignal,
): Promise<AgentPipelineRunResult> {
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    host: runtime,
    actorKey: 'test',
    ...(signal ? { signal } : {}),
  };
  return desktopPipelinesPort.run(action, call);
}

const GLOBAL_RUN: PipelineRunAction = {
  type: 'pipeline.run',
  pipelineId: 'global-review',
  scope: 'global',
};

function startedOptions(): ExecutePipelineRequestOptions {
  const options = mockStartPipelineExecutionFromMain.mock.calls[0]?.[0].options;
  if (!options) throw new Error('Expected a started run');
  return options;
}

describe('desktop pipelines port, global runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentPipelineOwnerContext.mockResolvedValue({ owner: ORG });
    mockLoadAgentGlobalPipelineById.mockResolvedValue(globalPipeline());
    mockPreflightGlobalStart.mockResolvedValue(null);
    mockStartPipelineExecutionFromMain.mockImplementation(({ options }) =>
      Promise.resolve({ success: true, data: startedState(options) }),
    );
  });

  it("runs under the calling project's owner with no task and records the chat", async () => {
    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toMatchObject({
      status: 'started',
      execution: {
        executionId: 'execution-1',
        executionScope: 'global',
        owner: ORG,
      },
    });
    expect(mockAgentPipelineOwnerContext).toHaveBeenCalledWith({
      projectId: AGENT_CHAT.projectId,
      worktreeId: AGENT_CHAT.worktreeId,
    });
    // The definition is authorized against the run's owner.
    expect(mockLoadAgentGlobalPipelineById).toHaveBeenCalledWith(
      'global-review',
      ORG,
    );
    const options = startedOptions();
    expect(options).toMatchObject({
      scope: 'global',
      target: { scope: 'global' },
      eventName: 'dispatch',
      executionContext: ORG,
      initiator: { kind: 'agent', chat: AGENT_CHAT },
    });
    // The calling task is attribution only, never the execution target.
    for (const key of [
      'cwd',
      'projectId',
      'worktreeId',
      'repoPath',
      'pipelineFilePath',
      'requestedOwner',
    ] as const)
      expect(options[key]).toBeUndefined();
  });

  it("takes App Advisor's selected context and records the Advisor chat", async () => {
    await expect(run(GLOBAL_RUN, appAdvisorChat)).resolves.toMatchObject({
      status: 'started',
    });
    expect(mockAgentPipelineOwnerContext).toHaveBeenCalledWith({
      projectId: ADVISOR_CHAT.projectId,
    });
    expect(startedOptions()).toMatchObject({
      executionContext: ORG,
      initiator: { kind: 'app_advisor', chat: ADVISOR_CHAT },
    });
  });

  it('refuses a chat with no source identity', async () => {
    await expect(run(GLOBAL_RUN, host())).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid_target',
    });
    expect(mockAgentPipelineOwnerContext).not.toHaveBeenCalled();
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('refuses a global pipeline that does not declare dispatch before starting', async () => {
    const planOnly = globalPipeline();
    planOnly.content = { ...planOnly.content, on: 'plan_ready' };
    mockLoadAgentGlobalPipelineById.mockResolvedValue(planOnly);

    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'invalid_target',
    });
    expect(mockPreflightGlobalStart).not.toHaveBeenCalled();
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('never records a watcher-only runtime that is not App Advisor as App Advisor', async () => {
    await expect(
      run(GLOBAL_RUN, host({ worktreeWatcherRuntime: AGENT_CHAT })),
    ).resolves.toMatchObject({ status: 'rejected', reason: 'invalid_target' });
    expect(mockAgentPipelineOwnerContext).not.toHaveBeenCalled();
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it("refuses when the calling project's owner is unavailable", async () => {
    mockAgentPipelineOwnerContext.mockResolvedValue({
      refusal: 'Owner unavailable.',
    });

    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toEqual({
      status: 'rejected',
      reason: 'owner_unavailable',
      message: 'Owner unavailable.',
    });
    expect(mockLoadAgentGlobalPipelineById).not.toHaveBeenCalled();
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it("does not disclose a definition outside the run's owner", async () => {
    mockLoadAgentGlobalPipelineById.mockRejectedValue(
      new Error('Pipeline unavailable (context-mismatch)'),
    );

    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toEqual({
      status: 'rejected',
      reason: 'not_found',
      message: 'Pipeline global-review was not found.',
    });
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('keeps a retryable or account-level load failure visible', async () => {
    mockLoadAgentGlobalPipelineById.mockRejectedValue(new Error('offline'));
    const offline = {
      ok: false as const,
      error: { code: 'validation_failed', message: 'offline', retryable: true },
    };
    // Classified once to decide and once to report.
    mockAgentResourceActionFailure
      .mockReturnValueOnce(offline)
      .mockReturnValueOnce(offline);

    await expect(run(GLOBAL_RUN, scopedChat)).rejects.toMatchObject({
      code: 'validation_failed',
      retryable: true,
    });

    const noCapability = {
      ok: false as const,
      error: { code: 'missing_capability', message: 'No pipelines' },
    };
    mockAgentResourceActionFailure
      .mockReturnValueOnce(noCapability)
      .mockReturnValueOnce(noCapability);
    await expect(run(GLOBAL_RUN, scopedChat)).rejects.toMatchObject({
      code: 'missing_capability',
    });
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('reports a project definition as not found', async () => {
    mockLoadAgentGlobalPipelineById.mockResolvedValue(
      globalPipeline('project'),
    );

    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toMatchObject({
      status: 'rejected',
      reason: 'not_found',
    });
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });

  it('starts nothing when the global start preflight refuses', async () => {
    mockPreflightGlobalStart.mockResolvedValue({
      reason: 'unsupported_scope',
      message: 'This pipeline only runs in a task.',
    });

    await expect(run(GLOBAL_RUN, scopedChat)).resolves.toEqual({
      status: 'rejected',
      reason: 'unsupported_scope',
      message: 'This pipeline only runs in a task.',
    });
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });
});

describe('desktop pipelines port, App Advisor runs in a task', () => {
  const PROJECT_PIPELINE: PipelineData = {
    info: {
      id: 'pipe-1',
      name: 'Project pipeline',
      description: '',
      icon: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      filename: 'project.yaml',
      source: 'project',
      readonly: false,
      filePath: '/repo/.canopy/pipelines/project.yaml',
    },
    content: { name: 'Project pipeline', on: 'dispatch', jobs: {} },
  };
  const advisorInTask = host({
    worktreeWatcherRuntime: ADVISOR_CHAT,
    appAdvisorPipelineTarget: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadAgentPipelineById.mockResolvedValue(PROJECT_PIPELINE);
    mockStartPipelineExecutionFromMain.mockImplementation(({ options }) =>
      Promise.resolve({
        success: true,
        data: {
          ...startedState(options),
          scope: 'worktree',
          project_id: 'project-1',
          worktree_id: 'worktree-1',
        },
      }),
    );
  });

  it('starts with the options the renderer used to send, plus the Advisor chat', async () => {
    await expect(
      run(
        {
          type: 'pipeline.run',
          pipelineId: 'pipe-1',
          inputs: { target: 'unit' },
        },
        advisorInTask,
      ),
    ).resolves.toMatchObject({
      status: 'started',
      agentArtifacts: [
        expect.objectContaining({
          kind: 'pipeline_run',
          executionId: 'execution-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        }),
      ],
    });
    expect(mockLoadAgentPipelineById).toHaveBeenCalledWith(
      'pipe-1',
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: ADVISOR_CHAT.chatId,
      }),
      '/repo',
    );
    expect(startedOptions()).toEqual({
      cwd: '/repo',
      pipelineId: 'pipe-1',
      pipelineFilePath: '/repo/.canopy/pipelines/project.yaml',
      repoPath: '/repo',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      initiationSource: 'app_advisor',
      initiator: { kind: 'app_advisor', chat: ADVISOR_CHAT },
      eventName: 'dispatch',
      inputs: { target: 'unit' },
    });
  });

  it('arms watchers for the new run on the Advisor chat', async () => {
    await run(
      {
        type: 'pipeline.run',
        pipelineId: 'pipe-1',
        watchers: [{ terminalStatuses: ['success', 'failure'] }],
      },
      advisorInTask,
    );

    expect(mockWatcherSetup).toHaveBeenCalledWith(
      {
        watchers: [
          {
            trigger: 'worktree_pipeline_completion',
            target: {
              kind: 'worktree_pipeline',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              executionId: 'execution-1',
              terminalStatuses: ['success', 'failure'],
            },
          },
        ],
      },
      ADVISOR_CHAT,
      { toolUseId: undefined },
    );
  });

  it("passes a Stop's abort signal to the run's watcher setup", async () => {
    const { signal } = new AbortController();
    await run(
      { type: 'pipeline.run', pipelineId: 'pipe-1', watchers: [{}] },
      advisorInTask,
      signal,
    );

    expect(mockWatcherSetup).toHaveBeenCalledWith(
      expect.anything(),
      ADVISOR_CHAT,
      { toolUseId: undefined, signal },
    );
  });

  it('refuses a locked task before loading or starting anything', async () => {
    mockAssertNotSplitLocked.mockImplementationOnce(() => {
      throw new Error('This task is locked while it splits.');
    });

    await expect(
      run({ type: 'pipeline.run', pipelineId: 'pipe-1' }, advisorInTask),
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid_target',
      message: 'This task is locked while it splits.',
    });
    expect(mockLoadAgentPipelineById).not.toHaveBeenCalled();
    expect(mockStartPipelineExecutionFromMain).not.toHaveBeenCalled();
  });
});
