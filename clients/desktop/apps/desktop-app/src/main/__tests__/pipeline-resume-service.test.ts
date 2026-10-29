import type * as BackgroundContextModule from '../services/background-execution-context';
import type { ChildPipelineAuthorization } from '@canopy/desktop-shared/types/pipeline';
let mockBackgroundEnabled = false;
let mockWorkspaceContext = 'personal';
const mockAuthorizeBackground = jest.fn<
  ReturnType<typeof BackgroundContextModule.authorizeBackgroundExecution>,
  Parameters<typeof BackgroundContextModule.authorizeBackgroundExecution>
>();
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => mockBackgroundEnabled,
  resolveBackgroundWorkspaceContext: (): Promise<string> =>
    Promise.resolve(mockWorkspaceContext),
  persistedPipelineContextResources: (): unknown[] => [
    { owner: { shareScope: 'private' } },
  ],
  authorizeBackgroundExecution: (
    ...args: Parameters<typeof mockAuthorizeBackground>
  ): ReturnType<typeof mockAuthorizeBackground> =>
    mockAuthorizeBackground(...args),
}));
jest.mock('../pipelines/pipeline-service', () => ({
  getStoredPipelineBySource: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  loadExecutionState: jest.fn(),
  resumePipeline: jest.fn(),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/tmp/executions',
  })),
}));
jest.mock('../resource-monitor', () => ({
  getResourceMonitorService: jest.fn(() => ({
    dispose: jest.fn(),
    reservePipelineExecutionStart: (): { release: () => void } => ({
      release: jest.fn(),
    }),
  })),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../lib/linear-auth', () => ({
  resolveLinearToken: (): Promise<undefined> => Promise.resolve(undefined),
}));
jest.mock('../lib/user-environment-store', () => ({
  readEnvironmentConfig: jest.fn(),
}));
jest.mock('../pipelines/preference-env', () => ({
  buildPipelinePreferenceEnv: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../pipelines/worktree-base-branch-env', () => ({
  buildPipelineBaseBranchEnv: (): Promise<object> => Promise.resolve({}),
}));
jest.mock('../pipelines/pipeline-advisor', () => ({
  getPipelineAdvisorService: (): { watchExecution: () => void } => ({
    watchExecution: jest.fn(),
  }),
}));

jest.mock('../pipelines/transient-error-retry-scheduler', () => ({
  cancelPendingTransientRetryTimer: jest.fn(),
  notePipelineExecutionEvent: jest.fn(),
}));
const mockGetActiveExecutionHandle = jest.fn();
const mockHasActiveExecution = jest.fn(() => false);
jest.mock('../pipelines/pipeline-execution-registry', () => ({
  getActiveExecutionHandle: mockGetActiveExecutionHandle,
  hasActiveExecution: mockHasActiveExecution,
  releaseExecutionReservation: jest.fn(),
  reserveExecution: jest.fn(),
  trackExecution: jest.fn(),
}));

import {
  loadExecutionState,
  resumePipeline,
  type ExecutionEvent,
  type ExecutionState,
  type StepOutputEvent,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { authorizePipelineReplay } from '../pipelines/pipeline-replay-authorization';
import { cancelPendingTransientRetryTimer } from '../pipelines/transient-error-retry-scheduler';

const mockedLoadExecutionState = jest.mocked(loadExecutionState);
const mockedCancelPendingTransientRetryTimer = jest.mocked(
  cancelPendingTransientRetryTimer,
);

describe('pipeline resume service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBackgroundEnabled = false;
    mockWorkspaceContext = 'personal';
    mockHasActiveExecution.mockReturnValue(false);
  });

  it('reauthorizes a global execution without inventing a workspace target', async () => {
    mockBackgroundEnabled = true;
    mockAuthorizeBackground.mockResolvedValue({ allow: true });
    const state: ExecutionState = {
      version: 6,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Global pipeline',
        scope: ['global'],
        jobs: {},
      },
      scope: 'global',
      execution_context: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status: 'paused',
      initiation_source: 'user',
      jobs: {},
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };

    await expect(authorizePipelineReplay(state)).resolves.toMatchObject({
      executionContext: state.execution_context,
    });
    expect(mockAuthorizeBackground).toHaveBeenCalledWith(
      state.execution_context,
      expect.any(Array),
      { scope: 'global' },
      [],
    );
  });

  it.each([
    [
      { allow: false, reason: 'unknown-provenance', transient: true },
      "Couldn't check access to what this run uses. Try again in a moment.",
    ],
    [
      { allow: false, reason: 'access-removed' },
      'You no longer have access to something this uses.',
    ],
  ] as const)(
    'leaves a denied paused replay untouched',
    async (decision, message) => {
      mockBackgroundEnabled = true;
      mockAuthorizeBackground.mockResolvedValue(decision);
      const state: ExecutionState = {
        version: 6,
        id: 'execution-1',
        pipeline_id: 'pipeline-1',
        pipeline_snapshot: { name: 'Saved', scope: ['global'], jobs: {} },
        scope: 'global',
        status: 'paused',
        jobs: {},
        cwd: '/tmp',
        env: {},
        inputs: {},
        started_at: '2026-01-01T00:00:00Z',
      };
      mockedLoadExecutionState.mockResolvedValue(state);
      await expect(
        resumePipelineExecutionFromMain({
          executionId: state.id,
          initiationSource: 'user',
          getWindow: () => null,
        }),
      ).rejects.toThrow(message);
      expect(resumePipeline).not.toHaveBeenCalled();
      expect(state.status).toBe('paused');
      if (decision.transient) {
        const resumedState = { ...state, status: 'success' as const };
        mockAuthorizeBackground.mockResolvedValueOnce({ allow: true });
        jest.mocked(resumePipeline).mockResolvedValueOnce({
          id: state.id,
          getState: () => resumedState,
          cancel: () => Promise.resolve(resumedState),
          waitForCompletion: () => Promise.resolve(resumedState),
        });
        await expect(
          resumePipelineExecutionFromMain({
            executionId: state.id,
            initiationSource: 'user',
            getWindow: () => null,
          }),
        ).resolves.toMatchObject({ status: 'started' });
        expect(resumePipeline).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('invalidates a transient retry before loading execution state', async () => {
    let resolveState: ((state: null) => void) | undefined;
    mockedLoadExecutionState.mockReturnValue(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );

    const resumePromise = resumePipelineExecutionFromMain({
      executionId: 'execution-1',
      initiationSource: 'user',
      getWindow: () => null,
    });

    expect(mockedCancelPendingTransientRetryTimer).toHaveBeenCalledWith(
      'execution-1',
      undefined,
    );

    resolveState?.(null);
    await expect(resumePromise).rejects.toThrow(
      'Execution "execution-1" not found',
    );
  });

  it.each([false, true])(
    'rejects Ultra fast before resuming a pipeline (active: %s)',
    async (active) => {
      const state: ExecutionState = {
        version: 6,
        id: 'execution-1',
        pipeline_id: 'pipeline-1',
        pipeline_snapshot: { name: 'Unsupported speed', jobs: {} },
        status: 'paused',
        jobs: {},
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
        env: {},
        inputs: {},
        status_reasons: [],
        model_config: { speed: 'ultrafast', fastMode: false },
      };
      mockedLoadExecutionState.mockResolvedValue(
        active
          ? { ...state, model_config: { speed: 'standard', fastMode: false } }
          : state,
      );
      const resumePaused = jest.fn(() => Promise.resolve(state));
      jest.mocked(resumePipeline).mockResolvedValue({
        id: state.id,
        getState: () => state,
        cancel: () => Promise.resolve(state),
        waitForCompletion: () => Promise.resolve(state),
      });
      mockHasActiveExecution.mockReturnValue(active);
      mockGetActiveExecutionHandle.mockReturnValue({
        getState: () => state,
        resumePaused,
      });
      await expect(
        resumePipelineExecutionFromMain({
          executionId: state.id,
          initiationSource: 'user',
          statusReasonIds: ['123e4567-e89b-42d3-a456-426614174000'],
          getWindow: () => null,
        }),
      ).rejects.toThrow(
        'Pipelines do not support Ultra fast. Choose Regular or Fast.',
      );
      expect(resumePaused).not.toHaveBeenCalled();
      expect(resumePipeline).not.toHaveBeenCalled();
    },
  );

  it('preserves the original source for an internal automated resume', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const state: ExecutionState = {
      version: 6,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Parallel pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      initiation_source: 'user',
      status_reasons: [
        {
          id: reasonId,
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'limited',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const resumedState = { ...state, status_reasons: [] };
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      resumePaused,
    });

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        statusReasonIds: [reasonId],
        initiationSource: 'automation',
        getWindow: () => null,
      }),
    ).resolves.toEqual({ status: 'started', state: resumedState });
    expect(resumePaused).toHaveBeenCalledWith([reasonId], undefined, 'user');
  });

  it.each([
    { active: true, enabled: true, context: 'personal' },
    {
      active: true,
      enabled: true,
      context: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    { active: false, enabled: true, context: 'personal' },
    {
      active: false,
      enabled: true,
      context: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    },
    { active: true, enabled: false, context: 'personal' },
    { active: false, enabled: false, context: 'personal' },
  ])(
    'fences resume with fresh child authorizations and resolved context (active=$active, enabled=$enabled, context=$context)',
    async ({ active, enabled, context }): Promise<void> => {
      mockBackgroundEnabled = enabled;
      mockWorkspaceContext = context;
      const records: ChildPipelineAuthorization[] = [
        { request: 'child', identity: 'local', contentHash: 'a'.repeat(64) },
      ];
      mockAuthorizeBackground.mockImplementation(
        (_context, _resources, _destination, authorizations) => {
          authorizations?.push(...records);
          return Promise.resolve({ allow: true });
        },
      );
      const reasonId = '123e4567-e89b-42d3-a456-426614174000';
      const state: ExecutionState = {
        version: 6,
        id: 'execution-1',
        pipeline_id: 'pipeline-1',
        project_id: 'workspace-1',
        pipeline_snapshot: {
          name: 'Parallel pipeline',
          scope: ['directory'],
          jobs: {},
        },
        status: 'running',
        initiation_source: 'user',
        status_reasons: [
          {
            id: reasonId,
            kind: 'provider_usage_limit',
            code: 'usage_limit_exceeded',
            provider: 'claude',
            account_scope: 'native',
            detected_at: '2026-01-01T00:00:00.000Z',
            source: {
              job_id: 'limited',
              step_id: 'prompt',
              attempt: 0,
              iteration: 1,
            },
          },
        ],
        jobs: {},
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
        env: {},
        inputs: {},
      };
      const resumedState = { ...state, status_reasons: [] };
      const resumePaused = jest.fn().mockResolvedValue(resumedState);
      mockedLoadExecutionState.mockResolvedValue(state);
      mockHasActiveExecution.mockReturnValue(active);
      mockGetActiveExecutionHandle.mockReturnValue({
        id: state.id,
        getState: () => state,
        resumePaused,
      });

      jest.mocked(resumePipeline).mockResolvedValue({
        id: state.id,
        getState: () => resumedState,
        cancel: () => Promise.resolve(resumedState),
        waitForCompletion: () => Promise.resolve(resumedState),
      });
      await expect(
        resumePipelineExecutionFromMain({
          executionId: state.id,
          statusReasonIds: [reasonId],
          initiationSource: 'automation',
          getWindow: () => null,
        }),
      ).resolves.toEqual({ status: 'started', state: resumedState });
      if (enabled)
        expect(mockAuthorizeBackground).toHaveBeenCalledWith(
          context,
          expect.any(Array),
          expect.any(Object),
          records,
        );
      if (!enabled) {
        expect(mockAuthorizeBackground).not.toHaveBeenCalled();
        if (active)
          expect(resumePaused).toHaveBeenCalledWith(
            [reasonId],
            undefined,
            'user',
          );
        else {
          const options = jest.mocked(resumePipeline).mock.calls[0]?.[1];
          expect(options).not.toHaveProperty('executionContext');
          expect(options).not.toHaveProperty('childPipelineAuthorizations');
        }
      } else if (active) {
        expect(resumePaused).toHaveBeenCalledWith(
          [reasonId],
          undefined,
          'user',
          undefined,
          {
            executionContext: context,
            childPipelineAuthorizations: records,
          },
        );
      } else {
        expect(resumePipeline).toHaveBeenCalledWith(
          state.id,
          expect.objectContaining({
            executionContext: context,
            childPipelineAuthorizations: records,
          }),
        );
      }
    },
  );

  it('attaches portal observers before resuming an active handle', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const state: ExecutionState = {
      version: 9,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Active portal resume',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      initiation_source: 'user',
      status_reasons: [
        {
          id: reasonId,
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'limited',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const resumedState = { ...state, status_reasons: [] };
    let attachedObservers:
      | {
          onEvent?: (event: ExecutionEvent) => void;
          onStepOutput?: (event: StepOutputEvent) => void;
        }
      | undefined;
    const removeObservers = jest.fn();
    const addObservers = jest.fn(
      (observers: {
        onEvent?: (event: ExecutionEvent) => void;
        onStepOutput?: (event: StepOutputEvent) => void;
      }) => {
        attachedObservers = observers;
        return removeObservers;
      },
    );
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      addObservers,
      resumePaused,
    });
    const onEvent = jest.fn();
    const onStepOutput = jest.fn();

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        statusReasonIds: [reasonId],
        initiationSource: 'portal',
        persistInitiationSource: true,
        portalCommandId: 'portal-command-1',
        getWindow: () => null,
        onEvent,
        onStepOutput,
      }),
    ).resolves.toEqual({ status: 'started', state: resumedState });

    expect(addObservers).toHaveBeenCalledTimes(1);
    const registeredObservers = addObservers.mock.calls[0]?.[0];
    expect(typeof registeredObservers?.onEvent).toBe('function');
    expect(registeredObservers?.onStepOutput).toBe(onStepOutput);
    expect(addObservers.mock.invocationCallOrder[0]).toBeLessThan(
      resumePaused.mock.invocationCallOrder[0],
    );

    const progressEvent: ExecutionEvent = {
      executionId: state.id,
      type: 'execution.updated',
      state: resumedState,
      timestamp: '2026-01-01T00:00:01.000Z',
    };
    const outputEvent: StepOutputEvent = {
      executionId: state.id,
      jobId: 'limited',
      jobName: 'Limited',
      stepId: 'prompt',
      stepName: 'Prompt',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'resumed output',
    };
    attachedObservers?.onEvent?.(progressEvent);
    attachedObservers?.onStepOutput?.(outputEvent);
    expect(removeObservers).not.toHaveBeenCalled();
    attachedObservers?.onEvent?.({
      ...progressEvent,
      type: 'execution.completed',
      state: { ...resumedState, status: 'success' },
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'execution.completed' }),
    );
    expect(onStepOutput).toHaveBeenCalledWith(outputEvent);
    expect(removeObservers).toHaveBeenCalledTimes(1);
  });

  it('keeps observers while a resumed job runs beside a paused sibling', async () => {
    const selectedCheckpointId = '123e4567-e89b-42d3-a456-426614174010';
    const siblingCheckpointId = '123e4567-e89b-42d3-a456-426614174011';
    const state: ExecutionState = {
      version: 9,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Partial active portal resume',
        scope: ['directory'],
        jobs: {},
      },
      status: 'paused',
      initiation_source: 'user',
      status_reasons: [],
      pending_pauses: [
        {
          id: selectedCheckpointId,
          kind: 'input',
          job_id: 'selected',
          logical_job_id: 'selected',
          step_id: 'approval',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: siblingCheckpointId,
          kind: 'action',
          job_id: 'sibling',
          logical_job_id: 'sibling',
          step_id: 'manual-gate',
          attempt: 0,
          iteration: 1,
          detected_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      jobs: {
        selected: {
          status: 'paused',
          steps: {},
          outputs: {},
          retry_count: 0,
          iteration_count: 1,
        },
        sibling: {
          status: 'paused',
          steps: {},
          outputs: {},
          retry_count: 0,
          iteration_count: 1,
        },
      },
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const resumedState: ExecutionState = {
      ...state,
      status: 'running',
      pending_pauses: [state.pending_pauses[1]],
      jobs: {
        ...state.jobs,
        selected: { ...state.jobs.selected, status: 'running' },
      },
    };
    let attachedObservers:
      | {
          onEvent?: (event: ExecutionEvent) => void;
          onStepOutput?: (event: StepOutputEvent) => void;
        }
      | undefined;
    const removeObservers = jest.fn();
    const addObservers = jest.fn(
      (observers: {
        onEvent?: (event: ExecutionEvent) => void;
        onStepOutput?: (event: StepOutputEvent) => void;
      }) => {
        attachedObservers = observers;
        return removeObservers;
      },
    );
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      addObservers,
      resumePaused,
    });
    const onEvent = jest.fn();
    const onStepOutput = jest.fn();
    const pauseResponses = [
      {
        checkpoint_id: selectedCheckpointId,
        job_id: 'selected',
        step_id: 'approval',
        answers: { approved: true },
      },
    ];

    await resumePipelineExecutionFromMain({
      executionId: state.id,
      pauseResponses,
      initiationSource: 'portal',
      portalCommandId: 'portal-command-1',
      getWindow: () => null,
      onEvent,
      onStepOutput,
    });

    const progressEvent: ExecutionEvent = {
      executionId: state.id,
      type: 'execution.updated',
      state: resumedState,
      timestamp: '2026-01-01T00:00:01.000Z',
    };
    const outputEvent: StepOutputEvent = {
      executionId: state.id,
      jobId: 'selected',
      jobName: 'Selected',
      stepId: 'approval',
      stepName: 'Approval',
      attempt: 0,
      iteration: 1,
      stream: 'stdout',
      data: 'selected job resumed',
    };
    attachedObservers?.onEvent?.(progressEvent);
    attachedObservers?.onStepOutput?.(outputEvent);

    expect(onEvent).toHaveBeenCalledWith(progressEvent);
    expect(onStepOutput).toHaveBeenCalledWith(outputEvent);
    expect(removeObservers).not.toHaveBeenCalled();

    attachedObservers?.onEvent?.({
      ...progressEvent,
      state: {
        ...resumedState,
        jobs: {
          ...resumedState.jobs,
          selected: { ...resumedState.jobs.selected, status: 'success' },
        },
      },
    });
    expect(removeObservers).toHaveBeenCalledTimes(1);
  });

  it('removes portal observers when an active resume is rejected', async () => {
    const reasonId = '123e4567-e89b-42d3-a456-426614174000';
    const state: ExecutionState = {
      version: 9,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Rejected active portal resume',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      initiation_source: 'user',
      status_reasons: [
        {
          id: reasonId,
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'limited',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const removeObservers = jest.fn();
    const addObservers = jest.fn(() => removeObservers);
    const resumePaused = jest.fn().mockRejectedValue(new Error('stale resume'));
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      addObservers,
      resumePaused,
    });

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        statusReasonIds: [reasonId],
        initiationSource: 'portal',
        portalCommandId: 'portal-command-1',
        getWindow: () => null,
        onEvent: jest.fn(),
        onStepOutput: jest.fn(),
      }),
    ).rejects.toThrow('stale resume');

    expect(addObservers).toHaveBeenCalledTimes(1);
    expect(removeObservers).toHaveBeenCalledTimes(1);
  });

  it('resumes all non-input reasons when active resume IDs are omitted', async () => {
    const recoveryReasonId = '123e4567-e89b-42d3-a456-426614174000';
    const inputReasonId = '223e4567-e89b-42d3-a456-426614174000';
    const state: ExecutionState = {
      version: 6,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Parallel pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      status_reasons: [
        {
          id: recoveryReasonId,
          kind: 'provider_usage_limit',
          code: 'usage_limit_exceeded',
          provider: 'claude',
          account_scope: 'native',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'limited',
            step_id: 'prompt',
            attempt: 0,
            iteration: 1,
          },
        },
        {
          id: inputReasonId,
          kind: 'input_required',
          code: 'input_required',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: 'input',
            step_id: 'approval',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const resumedState = {
      ...state,
      status_reasons: state.status_reasons.filter(
        (reason) => reason.id !== recoveryReasonId,
      ),
    };
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      resumePaused,
    });

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        initiationSource: 'user',
        getWindow: () => null,
      }),
    ).resolves.toEqual({ status: 'started', state: resumedState });
    expect(resumePaused).toHaveBeenCalledWith(
      [recoveryReasonId],
      undefined,
      undefined,
    );
  });

  it('forwards pause responses while sibling jobs keep the execution active', async () => {
    const unrelatedReasonId = '123e4567-e89b-42d3-a456-426614174001';
    const state: ExecutionState = {
      version: 8,
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Parallel pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status: 'running',
      status_reasons: [
        {
          id: unrelatedReasonId,
          kind: 'action_paused',
          code: 'action_requested_pause',
          detected_at: '2026-01-01T00:00:00.000Z',
          source: {
            job_id: '__matrix__review__1',
            step_id: 'manual-gate',
            attempt: 0,
            iteration: 1,
          },
        },
      ],
      jobs: {},
      job_groups: {},
      job_definitions: {},
      pending_pauses: [],
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const pauseResponses = [
      {
        job_id: '__matrix__review__0',
        step_id: 'approval',
        answers: { decision: 'continue' },
      },
    ];
    const resumedState = { ...state };
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      resumePaused,
    });

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        pauseResponses,
        initiationSource: 'automation',
        persistInitiationSource: true,
        getWindow: () => null,
      }),
    ).resolves.toEqual({ status: 'started', state: resumedState });
    expect(resumePaused).toHaveBeenCalledWith([], pauseResponses, 'automation');
  });

  it('accepts a checkpoint-only execution selected from the recovery UI', async () => {
    const checkpointId = '123e4567-e89b-42d3-a456-426614174099';
    const state: ExecutionState = {
      version: 8,
      id: 'execution-checkpoint-only',
      pipeline_id: 'pipeline-1',
      pipeline_snapshot: {
        name: 'Checkpoint-only pipeline',
        scope: ['directory'],
        jobs: {},
      },
      status: 'paused',
      status_reasons: [],
      shutdown_checkpoint: {
        id: checkpointId,
        detected_at: '2026-01-01T00:00:00.000Z',
      },
      jobs: {},
      job_groups: {},
      job_definitions: {},
      pending_pauses: [],
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      env: {},
      inputs: {},
    };
    const resumedState = { ...state, shutdown_checkpoint: undefined };
    const resumePaused = jest.fn().mockResolvedValue(resumedState);
    mockedLoadExecutionState.mockResolvedValue(state);
    mockHasActiveExecution.mockReturnValue(true);
    mockGetActiveExecutionHandle.mockReturnValue({
      id: state.id,
      getState: () => state,
      resumePaused,
    });

    await expect(
      resumePipelineExecutionFromMain({
        executionId: state.id,
        statusReasonIds: [checkpointId],
        allowStaleNoop: true,
        initiationSource: 'user',
        getWindow: () => null,
      }),
    ).resolves.toEqual({ status: 'started', state: resumedState });
    expect(resumePaused).toHaveBeenCalledWith(
      [checkpointId],
      undefined,
      undefined,
    );
  });
});
