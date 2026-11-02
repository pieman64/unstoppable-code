// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../preload/index.d.ts" />
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  summaryFromState,
  usePipelineRunsStore,
} from '@/stores/pipelineRunsStore';
import {
  acquirePipelineDetailLease,
  acquirePipelineSummaryInterest,
  getPipelineDetailLeaseCount,
  releasePipelineDetailLease,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { toPipelineRunRowState } from '@/lib/pipelineRunRowState';
import {
  acquireStepLogInterest,
  getStepLogView,
  inspectStepLogInterest,
  resetStepLogStoreForTests,
  routeStepOutputEvents,
} from '@/stores/pipelineStepLogStore';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import type {
  NormalizedJob,
  NormalizedPipeline,
  Pipeline,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  ExecutionEvent,
  ExecutionState,
  ExecutionSummary,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';

function createProject(
  seenPipelineExecutionIds?: string[],
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project 1',
    repoPath: '/workspace',
    color: '#000000',
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'feature/test',
        createdAt: '2026-03-27T11:59:00.000Z',
        ...(seenPipelineExecutionIds ? { seenPipelineExecutionIds } : {}),
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function getFirstProjectFirstWorktree():
  | { seenPipelineExecutionIds?: string[] }
  | undefined {
  const project = useProjectsStore.getState().projects[0];
  if (!project || project.type === 'cowork') {
    return undefined;
  }
  return project.worktrees[0];
}

type ExecutionStateOverrides = Partial<
  Omit<ExecutionState, 'pipeline_snapshot'>
> & {
  pipeline_snapshot?: Partial<NormalizedPipeline>;
};

function createState(overrides: ExecutionStateOverrides = {}): ExecutionState {
  const { pipeline_snapshot: pipelineSnapshotOverrides, ...stateOverrides } =
    overrides;
  return {
    version: 1,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      ...pipelineSnapshotOverrides,
      name: pipelineSnapshotOverrides?.name ?? 'Pipeline 1',
      scope: pipelineSnapshotOverrides?.scope ?? ['directory'],
      jobs: pipelineSnapshotOverrides?.jobs ?? {},
      env: pipelineSnapshotOverrides?.env ?? {},
      inputs: pipelineSnapshotOverrides?.inputs ?? {},
    },
    status: 'success',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: '2026-03-27T12:00:00.000Z',
    cwd: '/workspace',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    ...stateOverrides,
  };
}

function createLargeState(id: string): ExecutionState {
  const scriptSentinel = `W1B_STEP_SCRIPT_${id}_`.repeat(1_000);
  const step: NormalizedJob['steps'][number] = {
    id: 'build-step',
    run: scriptSentinel,
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 0,
    skip_on_missing_action: false,
  };
  const job: NormalizedJob = {
    name: 'Build',
    needs: [],
    timeout_minutes: 0,
    max_retries: 0,
    continue_on_error: false,
    steps: [step],
  };
  return createState({
    id,
    cwd: '/workspace',
    project_id: 'project-1',
    worktree_id: 'wt-1',
    pipeline_snapshot: {
      name: 'Pipeline 1',
      jobs: { build: job },
      env: {},
      inputs: {},
    },
    jobs: {
      build: {
        status: 'running',
        steps: {
          'build-step': {
            status: 'running',
            outputs: { sentinel: scriptSentinel },
            dynamic_env: {},
          },
        },
        outputs: { sentinel: scriptSentinel },
      },
    },
    job_definitions: {
      build: {
        physical_job_id: 'build',
        logical_job_id: 'build',
        ...job,
      },
    },
    job_groups: {
      build: {
        job_id: 'build',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['build'],
        status: 'running',
      },
    },
  });
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createExecutionEvent(
  executionId: string,
  state: ExecutionState,
): ExecutionEvent {
  return {
    type: 'execution.updated',
    timestamp: '2026-03-27T12:06:00.000Z',
    executionId,
    state,
  };
}

describe('pipelineRunsStore retry/rerun actions', () => {
  const retryExecution = jest.fn();
  const retryMatrixJob = jest.fn();
  const cancelMatrixVariant = jest.fn();
  const rerunExecution = jest.fn();
  const setExecutionHidden = jest.fn();
  const resumeExecution = jest.fn();
  const listExecutions = jest.fn();
  const getExecution = jest.fn();
  const saveProjects = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        listExecutions,
        getExecution,
        retryExecution,
        retryMatrixJob,
        cancelMatrixVariant,
        rerunExecution,
        setExecutionHidden,
        resume: resumeExecution,
      },
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        saveProjects,
      },
    });

    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: null,
      currentWorktreeId: null,
      summaries: [],
      statesById: {},
      rowStatesById: {},
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: false,
      pendingGlobalExecutionStatesById: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      pipelineSummariesByWorktree: {},
    });
    useChatStore.setState({ selectedWorktree: null });
    useNavigationStore.getState().navigate('overview');
    useProjectsStore.setState({
      projects: [createProject()],
    });
  });

  it('hydrates large listed executions as slim rows without retaining full sentinels', async () => {
    const executions = [
      createLargeState('execution-large-1'),
      createLargeState('execution-large-2'),
      createLargeState('execution-large-3'),
    ];
    const executionsById = new Map(
      executions.map((execution) => [execution.id, execution]),
    );
    listExecutions.mockResolvedValue({
      success: true,
      data: executions.map(summaryFromState),
    });
    getExecution.mockImplementation((executionId: string) => {
      const execution = executionsById.get(executionId);
      if (!execution) throw new Error(`Unexpected execution ${executionId}`);
      return Promise.resolve({ success: true, data: execution });
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    const rows = await Promise.all(
      executions.map(({ id }) =>
        usePipelineRunsStore.getState().loadExecutionRowState(id),
      ),
    );

    const state = usePipelineRunsStore.getState();
    expect(rows).toEqual(executions.map(toPipelineRunRowState));
    expect(Object.keys(state.statesById)).toEqual([]);
    expect(Object.keys(state.rowStatesById).sort()).toEqual(
      executions.map(({ id }) => id).sort(),
    );
    for (const row of Object.values(state.rowStatesById)) {
      expect(row).not.toHaveProperty('job_definitions');
    }
    expect(JSON.stringify(state.rowStatesById)).not.toContain(
      'W1B_STEP_SCRIPT_',
    );
  });

  it('shares row and detail reads in either request order', async () => {
    for (const order of ['row-first', 'detail-first'] as const) {
      const execution = createState({
        id: `execution-${order}`,
        project_id: 'project-1',
        worktree_id: 'wt-1',
      });
      const read = deferred<{ success: true; data: ExecutionState }>();
      getExecution.mockReturnValue(read.promise);
      usePipelineRunsStore.setState({
        summaries: [summaryFromState(execution)],
        statesById: {},
        rowStatesById: {},
      });
      const lease = acquirePipelineDetailLease(null, execution.id);
      const store = usePipelineRunsStore.getState();
      const first =
        order === 'row-first'
          ? store.loadExecutionRowState(execution.id)
          : store.loadExecutionDetails(execution.id);
      const second =
        order === 'row-first'
          ? store.loadExecutionDetails(execution.id)
          : store.loadExecutionRowState(execution.id);

      expect(getExecution).toHaveBeenCalledTimes(1);
      read.resolve({ success: true, data: execution });
      await Promise.all([first, second]);

      const rowResult = order === 'row-first' ? first : second;
      const detailResult = order === 'row-first' ? second : first;
      await expect(rowResult).resolves.toEqual(
        toPipelineRunRowState(execution),
      );
      await expect(detailResult).resolves.toEqual(execution);
      expect(usePipelineRunsStore.getState().statesById[execution.id]).toBe(
        execution,
      );
      releasePipelineDetailLease(lease);
      getExecution.mockClear();
    }
  });

  it('buffers only global execution projections and clears them when hydration throws', async () => {
    const largeState = createLargeState('execution-buffered');
    const materializedDefinition = largeState.job_definitions.build;
    if (!materializedDefinition) {
      throw new Error('Expected a materialized build definition');
    }
    const eventState = createState({
      ...largeState,
      status: 'running',
      job_definitions: {
        build: { ...materializedDefinition, name: 'Authored Build' },
      },
    });
    let rejectList: (error: Error) => void = () => undefined;
    listExecutions.mockReturnValue(
      new Promise<{ success: boolean; data: ExecutionSummary[] }>(
        (resolve, reject) => {
          rejectList = (error: Error): void => reject(error);
        },
      ),
    );
    const hydration = usePipelineRunsStore
      .getState()
      .loadGlobalPipelineStatuses();

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(eventState.id, eventState),
      );

    const pending =
      usePipelineRunsStore.getState().pendingGlobalExecutionStatesById[
        eventState.id
      ];
    expect(pending).toMatchObject({
      id: eventState.id,
      name: 'Pipeline 1',
      status: 'running',
      runningJobs: ['Authored Build'],
    });
    expect(pending).not.toHaveProperty('pipeline_snapshot');
    expect(JSON.stringify(pending)).not.toContain('W1B_STEP_SCRIPT_');

    rejectList(new Error('global hydration unavailable'));
    await hydration;
    expect(
      usePipelineRunsStore.getState().pendingGlobalExecutionStatesById,
    ).toEqual({});
    expect(
      usePipelineRunsStore.getState().isHydratingGlobalPipelineStatuses,
    ).toBe(false);
  });

  it('preserves a definition-less event over a pending row snapshot', async () => {
    const execution = createState({
      id: 'execution-pending-row',
      cwd: '/other',
      project_id: 'project-1',
      worktree_id: 'wt-2',
    });
    const snapshot = createState({
      ...execution,
      pipeline_snapshot: {
        name: 'Pipeline 1',
        jobs: {
          build: {
            name: 'Build',
            needs: [],
            timeout_minutes: 0,
            max_retries: 0,
            continue_on_error: false,
            steps: [
              {
                id: 'compile',
                run: 'not retained in the row',
                shell: 'bash',
                continue_on_error: false,
                timeout_minutes: 0,
                skip_on_missing_action: false,
              },
            ],
          },
        },
        env: {},
        inputs: {},
      },
      job_definitions: {
        build: {
          physical_job_id: 'build',
          logical_job_id: 'build',
          name: 'Build',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
      job_groups: {},
    });
    const read = deferred<{ success: true; data: ExecutionState }>();
    getExecution.mockReturnValue(read.promise);
    usePipelineRunsStore.setState({ summaries: [summaryFromState(snapshot)] });

    const loading = usePipelineRunsStore
      .getState()
      .loadExecutionRowState(snapshot.id);
    const latest = createState({
      ...snapshot,
      status: 'paused',
      planId: 'plan-latest',
      job_definitions: undefined,
      job_groups: undefined,
      jobs: { build: { status: 'running', steps: {}, outputs: {} } },
    });
    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(createExecutionEvent(latest.id, latest));
    read.resolve({ success: true, data: snapshot });

    await expect(loading).resolves.toMatchObject({
      status: 'paused',
      planId: 'plan-latest',
      pipeline_snapshot: {
        jobs: { build: { steps: [{ id: 'compile' }] } },
      },
    });
    expect(
      usePipelineRunsStore.getState().statesById[snapshot.id],
    ).toBeUndefined();
  });

  it('does not restore a row from a pending read after switching scopes', async () => {
    const scopeARun = createState({
      id: 'execution-scope-a',
      cwd: '/workspace',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });
    const scopeBRun = createState({
      id: 'execution-scope-b',
      cwd: '/other',
      project_id: 'project-1',
      worktree_id: 'wt-2',
    });
    const read = deferred<{ success: true; data: ExecutionState }>();
    getExecution.mockReturnValue(read.promise);
    usePipelineRunsStore.setState({
      summaries: [summaryFromState(scopeARun)],
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
    });

    const loadingRow = usePipelineRunsStore
      .getState()
      .loadExecutionRowState(scopeARun.id);
    listExecutions.mockResolvedValue({
      success: true,
      data: [summaryFromState(scopeBRun)],
    });
    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/other',
      projectId: 'project-1',
      worktreeId: 'wt-2',
    });
    read.resolve({ success: true, data: scopeARun });
    await loadingRow;

    expect(
      usePipelineRunsStore.getState().summaries.map(({ id }) => id),
    ).toEqual([scopeBRun.id]);
    expect(
      usePipelineRunsStore.getState().rowStatesById[scopeARun.id],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().statesById[scopeARun.id],
    ).toBeUndefined();
  });

  it('updates the summary and row for an unleased retry without retaining detail', async () => {
    const failedSummary: ExecutionSummary = {
      id: 'execution-1',
      pipeline_id: 'pipeline-1',
      pipeline_name: 'Pipeline 1',
      status_reasons: [],
      status: 'failure',
      started_at: '2026-03-27T12:00:00.000Z',
      completed_at: '2026-03-27T12:01:00.000Z',
      cwd: '/workspace',
      event_name: 'dispatch',
    };
    const retriedState = createState({
      status: 'running',
    });

    retryExecution.mockResolvedValue({
      success: true,
      data: retriedState,
    });
    usePipelineRunsStore.setState({
      summaries: [failedSummary],
    });

    const result = await usePipelineRunsStore
      .getState()
      .retryExecution('execution-1');

    expect(result).toEqual({ success: true });
    expect(usePipelineRunsStore.getState().summaries).toEqual([
      expect.objectContaining({
        id: 'execution-1',
        status: 'running',
      }),
    ]);
    const state = usePipelineRunsStore.getState();
    expect(state.statesById['execution-1']).toBeUndefined();
    expect(state.rowStatesById['execution-1']).toEqual(
      toPipelineRunRowState(retriedState),
    );
  });

  it('mutation and hide/show results retain full state only under a detail lease', async () => {
    const actions = [
      'resume',
      'retry',
      'retryMatrix',
      'cancelMatrix',
      'rerun',
      'hideShow',
    ] as const;

    for (const leased of [false, true]) {
      for (const action of actions) {
        const hiddenValues = action === 'hideShow' ? [true, false] : [false];
        for (const hidden of hiddenValues) {
          const executionId = `execution-${action}-${hidden ? 'hidden' : 'shown'}-${leased ? 'leased' : 'row'}`;
          const state = createState({
            id: executionId,
            cwd: '/workspace',
            status: 'running',
            hidden: action === 'hideShow' ? hidden : undefined,
          });
          const lease = leased
            ? acquirePipelineDetailLease(null, executionId)
            : null;
          usePipelineRunsStore.setState({
            summaries: [summaryFromState(state)],
            statesById: {},
            rowStatesById: {},
          });

          switch (action) {
            case 'resume':
              resumeExecution.mockResolvedValue({ success: true, data: state });
              await usePipelineRunsStore
                .getState()
                .resumeExecution(executionId);
              break;
            case 'retry':
              retryExecution.mockResolvedValue({ success: true, data: state });
              await usePipelineRunsStore.getState().retryExecution(executionId);
              break;
            case 'retryMatrix':
              retryMatrixJob.mockResolvedValue(state);
              await usePipelineRunsStore.getState().retryMatrixJob({
                executionId,
                jobId: 'build',
                mode: 'failed',
              });
              break;
            case 'cancelMatrix':
              cancelMatrixVariant.mockResolvedValue(state);
              await usePipelineRunsStore.getState().cancelMatrixVariant({
                executionId,
                jobId: 'build',
                variantJobId: 'build',
              });
              break;
            case 'rerun':
              rerunExecution.mockResolvedValue({ success: true, data: state });
              await usePipelineRunsStore.getState().rerunExecution(executionId);
              break;
            case 'hideShow':
              setExecutionHidden.mockResolvedValue({
                success: true,
                data: state,
              });
              await usePipelineRunsStore
                .getState()
                .setExecutionHidden(executionId, hidden);
              break;
          }

          const stored = usePipelineRunsStore.getState();
          expect(stored.statesById[executionId]).toBe(
            leased ? state : undefined,
          );
          expect(stored.rowStatesById[executionId]).toEqual(
            toPipelineRunRowState(state),
          );
          if (action === 'hideShow') {
            expect(stored.summaries[0]?.hidden).toBe(hidden || undefined);
          }
          if (lease) releasePipelineDetailLease(lease);
        }
      }
    }
  });

  it('resets joined step output before retrying a matrix job', async () => {
    resetStepLogStoreForTests();
    const retriedState = createState({ status: 'running' });
    const readStepLog = jest
      .fn()
      .mockResolvedValue({ success: true, data: { lines: [], text: '' } });
    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        listExecutions,
        getExecution,
        retryExecution,
        retryMatrixJob,
        rerunExecution,
        readStepLog,
      },
    });
    const interest = acquireStepLogInterest({
      identity: {
        executionId: 'execution-1',
        jobId: '__matrix__review__0',
        stepId: 'review',
        attempt: 0,
      },
      terminal: false,
    });
    await flushAsyncWork();
    routeStepOutputEvents([
      {
        executionId: 'execution-1',
        jobId: '__matrix__review__0',
        jobName: 'Review',
        stepId: 'review',
        stepName: 'Review',
        attempt: 0,
        stream: 'stdout',
        data: 'stale output\n',
      },
    ]);
    expect(getStepLogView(interest.key).lines).toEqual(['stale output']);
    retryMatrixJob.mockImplementation(() => {
      // The prior stream was dropped and a fresh authoritative read issued
      // before main restarted the variant.
      expect(inspectStepLogInterest(interest.key)).toMatchObject({
        mode: null,
        pendingEvents: 0,
        readInFlight: true,
      });
      return Promise.resolve(retriedState);
    });

    await expect(
      usePipelineRunsStore.getState().retryMatrixJob({
        executionId: 'execution-1',
        jobId: 'review',
        mode: 'failed',
      }),
    ).resolves.toEqual({ success: true });
    expect(readStepLog).toHaveBeenCalledTimes(2);
    await flushAsyncWork();
    expect(getStepLogView(interest.key).lines).toEqual([]);
    interest.release();
  });

  it('retry path surfaces verbatim guard text from an IPC rejection without an Error: prefix', async () => {
    const { extractIpcErrorMessage } = await import('@/lib/errors');
    const guardText =
      'Canopy is under high memory pressure. Stop an active chat or pipeline execution before starting another pipeline.';

    retryExecution.mockRejectedValueOnce(new Error(guardText));

    let observed: string | null = null;
    try {
      await usePipelineRunsStore.getState().retryExecution('execution-1');
    } catch (error: unknown) {
      observed = extractIpcErrorMessage(error);
    }

    // The store rethrows the rejection; the caller (PipelineRunsSection) uses
    // extractIpcErrorMessage to surface the verbatim message.
    expect(observed).toBe(guardText);
    expect(observed).not.toMatch(/^Error:/);
  });

  it('rerun path surfaces verbatim guard text from an IPC rejection without an Error: prefix', async () => {
    const { extractIpcErrorMessage } = await import('@/lib/errors');
    const guardText =
      'Canopy is under high memory pressure. Stop an active chat or pipeline execution before starting another pipeline.';

    rerunExecution.mockRejectedValueOnce(new Error(guardText));

    let observed: string | null = null;
    try {
      await usePipelineRunsStore.getState().rerunExecution('execution-1');
    } catch (error: unknown) {
      observed = extractIpcErrorMessage(error);
    }

    expect(observed).toBe(guardText);
    expect(observed).not.toMatch(/^Error:/);
  });

  it('preserves hidden on summaries regenerated from execution state', async () => {
    const rerunState = createState({
      id: 'execution-2',
      status: 'running',
      hidden: true,
    });

    rerunExecution.mockResolvedValue({
      success: true,
      data: rerunState,
    });

    const result = await usePipelineRunsStore
      .getState()
      .rerunExecution('execution-1');

    expect(result).toEqual({ success: true });
    expect(usePipelineRunsStore.getState().summaries).toEqual([
      expect.objectContaining({
        id: 'execution-2',
        hidden: true,
      }),
    ]);
  });

  it('adds rerun executions to summaries and preserves rerun lineage', async () => {
    const rerunState = createState({
      id: 'execution-2',
      status: 'running',
      rerun_source_id: 'execution-1',
    });

    rerunExecution.mockResolvedValue({
      success: true,
      data: rerunState,
    });

    const result = await usePipelineRunsStore
      .getState()
      .rerunExecution('execution-1');

    expect(result).toEqual({ success: true });
    expect(usePipelineRunsStore.getState().summaries).toEqual([
      expect.objectContaining({
        id: 'execution-2',
        status: 'running',
        rerun_source_id: 'execution-1',
      }),
    ]);
    expect(
      usePipelineRunsStore.getState().statesById['execution-2'],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().rowStatesById['execution-2'],
    ).toEqual(toPipelineRunRowState(rerunState));
  });

  it('loads worktree-scoped executions from child repo directories', async () => {
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-child',
          pipeline_id: 'pipeline-child',
          pipeline_name: 'Child Repo Pipeline',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:02:00.000Z',
          completed_at: '2026-03-27T12:05:00.000Z',
          cwd: '/workspace/repos/app',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-root',
          pipeline_id: 'pipeline-root',
          pipeline_name: 'Root Pipeline',
          status_reasons: [],
          status: 'running',
          started_at: '2026-03-27T12:01:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-other-worktree',
          pipeline_id: 'pipeline-other',
          pipeline_name: 'Other Worktree Pipeline',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:03:00.000Z',
          completed_at: '2026-03-27T12:06:00.000Z',
          cwd: '/workspace/repos/app',
          project_id: 'project-1',
          worktree_id: 'wt-2',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(usePipelineRunsStore.getState().summaries.map((s) => s.id)).toEqual([
      'execution-child',
      'execution-root',
    ]);
  });

  it('requires matching worktree ids when execution ids are available', async () => {
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-match',
          pipeline_id: 'pipeline-match',
          pipeline_name: 'Matching Pipeline',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:02:00.000Z',
          completed_at: '2026-03-27T12:05:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-mismatch',
          pipeline_id: 'pipeline-mismatch',
          pipeline_name: 'Other Worktree Pipeline',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:03:00.000Z',
          completed_at: '2026-03-27T12:06:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-2',
          event_name: 'dispatch',
        },
        {
          id: 'execution-legacy',
          pipeline_id: 'pipeline-legacy',
          pipeline_name: 'Legacy Pipeline',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(usePipelineRunsStore.getState().summaries.map((s) => s.id)).toEqual([
      'execution-match',
      'execution-legacy',
    ]);
  });

  it('tracks live worktree-scoped events from child repo directories', () => {
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
      summaries: [],
      statesById: {},
      rowStatesById: {},
    });

    usePipelineRunsStore.getState().handleExecutionEvent(
      createExecutionEvent(
        'execution-child',
        createState({
          id: 'execution-child',
          cwd: '/workspace/repos/app',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          status: 'running',
        }),
      ),
    );

    usePipelineRunsStore.getState().handleExecutionEvent(
      createExecutionEvent(
        'execution-other-worktree',
        createState({
          id: 'execution-other-worktree',
          cwd: '/workspace/repos/app',
          project_id: 'project-1',
          worktree_id: 'wt-2',
          status: 'running',
        }),
      ),
    );

    expect(usePipelineRunsStore.getState().summaries.map((s) => s.id)).toEqual([
      'execution-child',
    ]);
    const state = usePipelineRunsStore.getState();
    expect(state.statesById['execution-child']).toBeUndefined();
    expect(state.rowStatesById['execution-child']).toEqual(
      toPipelineRunRowState(
        createState({
          id: 'execution-child',
          cwd: '/workspace/repos/app',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          status: 'running',
        }),
      ),
    );
  });

  it('projects global execution events into the currently selected run state', () => {
    const pending = createState({
      id: 'execution-selected',
      cwd: '/workspace',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      status: 'pending',
    });
    const lease = acquirePipelineDetailLease(null, pending.id);
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
      summaries: [
        {
          id: pending.id,
          pipeline_id: pending.pipeline_id,
          pipeline_name: pending.pipeline_snapshot.name,
          status: pending.status,
          status_reasons: [],
          started_at: pending.started_at,
          cwd: pending.cwd,
          project_id: pending.project_id,
          worktree_id: pending.worktree_id,
        },
      ],
      statesById: { [pending.id]: pending },
    });
    const running = createState({
      ...pending,
      status: 'running',
      jobs: { build: { status: 'running', steps: {}, outputs: {} } },
    });

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(createExecutionEvent(running.id, running));

    expect(usePipelineRunsStore.getState().statesById[running.id]?.status).toBe(
      'running',
    );
    expect(usePipelineRunsStore.getState().summaries[0]?.status).toBe(
      'running',
    );
    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ]?.[0]?.runningJobs,
    ).toEqual(['build']);
    releasePipelineDetailLease(lease);
  });

  it('clears unseen failure severity when a retried execution succeeds', () => {
    useProjectsStore.setState({ fastRefreshWorktreeDiffStats: jest.fn() });
    const successfulExecution = createState({
      id: 'execution-success',
      pipeline_id: 'pipeline-success',
      pipeline_snapshot: {
        name: 'Successful Pipeline',
        jobs: {},
        env: {},
        inputs: {},
      },
      status: 'success',
      completed_at: '2026-03-27T12:05:00.000Z',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });
    const failedExecution = createState({
      id: 'execution-retried',
      pipeline_id: 'pipeline-retried',
      pipeline_snapshot: {
        name: 'Retried Pipeline',
        jobs: {},
        env: {},
        inputs: {},
      },
      status: 'failure',
      completed_at: '2026-03-27T12:06:00.000Z',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(successfulExecution.id, successfulExecution),
      );
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(failedExecution.id, failedExecution),
      type: 'execution.failed',
    });

    const retriedExecution = createState({
      ...failedExecution,
      status: 'running',
      completed_at: undefined,
      started_at: '2026-03-27T12:07:00.000Z',
    });
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(retriedExecution.id, retriedExecution),
      type: 'execution.started',
    });

    const completedRetry = createState({
      ...retriedExecution,
      status: 'success',
      completed_at: '2026-03-27T12:08:00.000Z',
    });
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(completedRetry.id, completedRetry),
      type: 'execution.completed',
    });

    const entries =
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ];
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: completedRetry.id,
          status: 'success',
        }),
        expect.objectContaining({
          id: successfulExecution.id,
          status: 'success',
        }),
      ]),
    );
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenFailedPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(false);
  });

  it('keeps unseen failure severity when another failed execution remains', () => {
    useProjectsStore.setState({ fastRefreshWorktreeDiffStats: jest.fn() });
    const remainingFailure = createState({
      id: 'execution-still-failed',
      status: 'failure',
      completed_at: '2026-03-27T12:05:00.000Z',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });
    const retriedFailure = createState({
      id: 'execution-retried',
      status: 'failure',
      completed_at: '2026-03-27T12:06:00.000Z',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });
    for (const state of [remainingFailure, retriedFailure]) {
      usePipelineRunsStore.getState().trackGlobalExecutionEvent({
        ...createExecutionEvent(state.id, state),
        type: 'execution.failed',
      });
    }

    const completedRetry = createState({
      ...retriedFailure,
      status: 'success',
      completed_at: '2026-03-27T12:08:00.000Z',
    });
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(completedRetry.id, completedRetry),
      type: 'execution.completed',
    });

    expect(
      usePipelineRunsStore
        .getState()
        .unseenFailedPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
  });

  it('keeps complete execution metadata when a definition-less event arrives and leaves new incomplete states uncached', () => {
    const complete = createState({
      id: 'execution-selected',
      cwd: '/workspace',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      status: 'pending',
      job_definitions: {
        build: {
          physical_job_id: 'build',
          logical_job_id: 'build',
          name: 'Build',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
      job_groups: {},
    });
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
      summaries: [],
      statesById: { [complete.id]: complete },
    });
    const lease = acquirePipelineDetailLease(null, complete.id);

    const incompleteUpdate = createState({
      ...complete,
      status: 'running',
      jobs: { build: { status: 'running', steps: {}, outputs: {} } },
      job_definitions: undefined,
      job_groups: undefined,
    });
    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(incompleteUpdate.id, incompleteUpdate),
      );

    expect(
      usePipelineRunsStore.getState().statesById[complete.id],
    ).toMatchObject({
      status: 'running',
      job_definitions: complete.job_definitions,
      job_groups: complete.job_groups,
    });

    const newIncomplete = createState({
      ...incompleteUpdate,
      id: 'execution-new',
    });
    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(newIncomplete.id, newIncomplete),
      );

    expect(
      usePipelineRunsStore.getState().statesById[newIncomplete.id],
    ).toBeUndefined();
    releasePipelineDetailLease(lease);
  });

  it('rehydrates persisted worktree pipeline summaries on startup', async () => {
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-running',
          pipeline_id: 'pipeline-running',
          pipeline_name: 'Build',
          status_reasons: [],
          status: 'running',
          started_at: '2026-03-27T12:03:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-failure',
          pipeline_id: 'pipeline-failure',
          pipeline_name: 'Release',
          status_reasons: [],
          status: 'failure',
          started_at: '2026-03-27T12:02:00.000Z',
          completed_at: '2026-03-27T12:05:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_name: 'Deploy',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(usePipelineRunsStore.getState().runningExecutionsByWorktree).toEqual(
      {
        'project-1/wt-1': new Set(['execution-running']),
      },
    );
    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'execution-running',
        status: 'running',
      }),
      expect.objectContaining({
        id: 'execution-failure',
        status: 'failure',
      }),
      expect.objectContaining({
        id: 'execution-success',
        status: 'success',
      }),
    ]);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenFailedPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
  });

  it('clears a paused worktree pipeline when its cancellation event arrives', () => {
    const pausedState = createState({
      id: 'execution-paused',
      status: 'paused',
      project_id: 'project-1',
      worktree_id: 'wt-1',
    });
    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(pausedState.id, pausedState),
      );

    expect(usePipelineRunsStore.getState().pausedExecutionsByWorktree).toEqual({
      'project-1/wt-1': new Set([pausedState.id]),
    });

    const cancelledState = createState({
      ...pausedState,
      status: 'cancelled',
      completed_at: '2026-03-27T12:06:00.000Z',
    });
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(cancelledState.id, cancelledState),
      type: 'execution.cancelled',
    });

    expect(usePipelineRunsStore.getState().pausedExecutionsByWorktree).toEqual(
      {},
    );
    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: cancelledState.id,
        status: 'cancelled',
      }),
    ]);
  });

  it('projects materialized matrix names into global pipeline status', () => {
    const state = createState({
      id: 'execution-matrix',
      status: 'running',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      jobs: {
        __matrix__review__0: { status: 'running', steps: {}, outputs: {} },
        __matrix__review__1: { status: 'failure', steps: {}, outputs: {} },
      },
      job_definitions: {
        __matrix__review__0: {
          physical_job_id: '__matrix__review__0',
          logical_job_id: 'review',
          name: 'Review (security)',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
        __matrix__review__1: {
          physical_job_id: '__matrix__review__1',
          logical_job_id: 'review',
          name: 'Review (quality)',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
    });

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(createExecutionEvent(state.id, state));

    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ]?.[0],
    ).toMatchObject({
      runningJobs: ['Review (security)'],
      failedJobs: ['Review (quality)'],
    });
  });

  it.each([
    ['execution.completed' as const, 'success' as const],
    ['execution.completed' as const, 'failure' as const],
    ['execution.failed' as const, 'success' as const],
    ['execution.failed' as const, 'failure' as const],
  ])(
    'prioritizes a Git stats refresh when a worktree pipeline emits %s',
    (type, status) => {
      const fastRefreshWorktreeDiffStats = jest.fn();
      useProjectsStore.setState({ fastRefreshWorktreeDiffStats });
      const state = createState({
        id: `execution-${status}`,
        status,
        completed_at: '2026-03-27T12:06:00.000Z',
        project_id: 'project-1',
        worktree_id: 'wt-1',
      });

      usePipelineRunsStore.getState().trackGlobalExecutionEvent({
        ...createExecutionEvent(state.id, state),
        type,
      });

      expect(fastRefreshWorktreeDiffStats).toHaveBeenCalledTimes(1);
      expect(fastRefreshWorktreeDiffStats).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
      );
    },
  );

  it('does not prioritize Git stats for non-terminal or non-worktree pipeline events', () => {
    const fastRefreshWorktreeDiffStats = jest.fn();
    useProjectsStore.setState({ fastRefreshWorktreeDiffStats });

    usePipelineRunsStore.getState().trackGlobalExecutionEvent(
      createExecutionEvent(
        'execution-updated',
        createState({
          id: 'execution-updated',
          status: 'success',
          project_id: 'project-1',
          worktree_id: 'wt-1',
        }),
      ),
    );
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(
        'execution-no-worktree',
        createState({
          id: 'execution-no-worktree',
          status: 'success',
          project_id: 'project-1',
          worktree_id: undefined,
        }),
      ),
      type: 'execution.completed',
    });

    expect(fastRefreshWorktreeDiffStats).not.toHaveBeenCalled();
  });

  it('marks global pipeline status hydration complete when loading fails', async () => {
    listExecutions.mockResolvedValue({
      success: false,
      error: 'unavailable',
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(
      usePipelineRunsStore.getState().isHydratingGlobalPipelineStatuses,
    ).toBe(false);
    expect(
      usePipelineRunsStore.getState().hasHydratedGlobalPipelineStatuses,
    ).toBe(true);
    expect(
      usePipelineRunsStore.getState().pendingGlobalExecutionStatesById,
    ).toEqual({});
  });

  it('merges a definition-less live state that arrives during global hydration', async () => {
    let resolveListExecutions:
      | ((value: { success: true; data: ExecutionSummary[] }) => void)
      | undefined;
    listExecutions.mockReturnValue(
      new Promise((resolve) => {
        resolveListExecutions = resolve;
      }),
    );
    const load = usePipelineRunsStore.getState().loadGlobalPipelineStatuses();
    const state = createState({
      id: 'execution-live',
      status: 'running',
      project_id: 'project-1',
      worktree_id: 'wt-1',
      jobs: { build: { status: 'running', steps: {}, outputs: {} } },
      job_definitions: undefined,
    });

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(createExecutionEvent(state.id, state));
    if (!resolveListExecutions) {
      throw new Error('Expected listExecutions resolver to be set');
    }
    resolveListExecutions({ success: true, data: [] });
    await load;

    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ]?.[0]?.runningJobs,
    ).toEqual(['build']);
  });

  it('does not re-add terminal startup summaries for the selected worktree', async () => {
    useNavigationStore.getState().navigate('main');
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
    });
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_name: 'Deploy',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(usePipelineRunsStore.getState().pipelineSummariesByWorktree).toEqual(
      {},
    );
    expect(
      usePipelineRunsStore.getState().unseenPipelineWorktreeKeys.size,
    ).toBe(0);
    expect(
      usePipelineRunsStore.getState().unseenFailedPipelineWorktreeKeys.size,
    ).toBe(0);
  });

  it('treats the selected worktree as unseen when terminal startup summaries load off the worktree page', async () => {
    useNavigationStore.getState().navigate('overview');
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
    });
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_name: 'Deploy',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'execution-success',
        status: 'success',
      }),
    ]);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
  });

  it('marks a selected worktree unseen when a pipeline finishes off the worktree page', () => {
    useNavigationStore.getState().navigate('overview');
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
    });

    usePipelineRunsStore.getState().trackGlobalExecutionEvent(
      createExecutionEvent(
        'execution-success',
        createState({
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_snapshot: {
            name: 'Deploy',
            jobs: {},
            env: {},
            inputs: {},
          },
          status: 'success',
          completed_at: '2026-03-27T12:05:00.000Z',
          project_id: 'project-1',
          worktree_id: 'wt-1',
        }),
      ),
    );

    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'execution-success',
        status: 'success',
      }),
    ]);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
  });

  it('does not rehydrate seen terminal executions after restart', async () => {
    useProjectsStore.setState({
      projects: [createProject(['execution-success', 'execution-failure'])],
    });
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-running',
          pipeline_id: 'pipeline-running',
          pipeline_name: 'Build',
          status_reasons: [],
          status: 'running',
          started_at: '2026-03-27T12:03:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-failure',
          pipeline_id: 'pipeline-failure',
          pipeline_name: 'Release',
          status_reasons: [],
          status: 'failure',
          started_at: '2026-03-27T12:02:00.000Z',
          completed_at: '2026-03-27T12:05:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
        {
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_name: 'Deploy',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'execution-running',
        status: 'running',
      }),
    ]);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(false);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenFailedPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(false);
  });

  it('merges execution events that arrive while global statuses are hydrating', async () => {
    let resolveListExecutions:
      | ((value: { success: boolean; data: ExecutionSummary[] }) => void)
      | undefined;

    listExecutions.mockImplementation(
      () =>
        new Promise<{ success: boolean; data: ExecutionSummary[] }>(
          (resolve) => {
            resolveListExecutions = resolve;
          },
        ),
    );

    const loadPromise = usePipelineRunsStore
      .getState()
      .loadGlobalPipelineStatuses();

    const largeState = createLargeState('execution-running');
    const eventState = createState({
      ...largeState,
      pipeline_snapshot: {
        ...largeState.pipeline_snapshot,
        name: 'Build',
      },
      status: 'failure',
      completed_at: '2026-03-27T12:05:00.000Z',
    });
    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(
        createExecutionEvent(eventState.id, eventState),
      );

    const pending =
      usePipelineRunsStore.getState().pendingGlobalExecutionStatesById[
        eventState.id
      ];
    expect(pending).toMatchObject({
      status: 'failure',
      runningJobs: ['Build'],
    });
    expect(pending).not.toHaveProperty('pipeline_snapshot');
    expect(JSON.stringify(pending)).not.toContain('W1B_STEP_SCRIPT_');

    expect(resolveListExecutions).toBeDefined();
    if (!resolveListExecutions) {
      throw new Error('Expected listExecutions resolver to be set');
    }

    resolveListExecutions({
      success: true,
      data: [
        {
          id: 'execution-running',
          pipeline_id: 'pipeline-running',
          pipeline_name: 'Build',
          status_reasons: [],
          status: 'running',
          started_at: '2026-03-27T12:03:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ],
    });

    await loadPromise;

    expect(usePipelineRunsStore.getState().runningExecutionsByWorktree).toEqual(
      {},
    );
    expect(
      usePipelineRunsStore.getState().pipelineSummariesByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([
      expect.objectContaining({
        id: 'execution-running',
        status: 'failure',
      }),
    ]);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
    expect(
      usePipelineRunsStore
        .getState()
        .unseenFailedPipelineWorktreeKeys.has('project-1/wt-1'),
    ).toBe(true);
  });

  it('shares an in-flight execution list between global and scoped hydration', async () => {
    let resolveListExecutions:
      | ((value: { success: true; data: ExecutionSummary[] }) => void)
      | undefined;
    const pendingList = new Promise<{
      success: true;
      data: ExecutionSummary[];
    }>((resolve) => {
      resolveListExecutions = resolve;
    });
    listExecutions.mockReturnValue(pendingList);

    const globalLoad = usePipelineRunsStore
      .getState()
      .loadGlobalPipelineStatuses();
    const scopedLoad = usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(listExecutions).toHaveBeenCalledTimes(1);
    if (!resolveListExecutions) {
      throw new Error('Expected listExecutions resolver to be set');
    }
    resolveListExecutions({ success: true, data: [] });
    await Promise.all([globalLoad, scopedLoad]);
  });

  it('prunes stale seen execution ids during global status hydration', async () => {
    useProjectsStore.setState({
      projects: [createProject(['execution-success', 'stale-execution'])],
    });
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-success',
          pipeline_id: 'pipeline-success',
          pipeline_name: 'Deploy',
          status_reasons: [],
          status: 'success',
          started_at: '2026-03-27T12:01:00.000Z',
          completed_at: '2026-03-27T12:04:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });

    await usePipelineRunsStore.getState().loadGlobalPipelineStatuses();

    expect(getFirstProjectFirstWorktree()?.seenPipelineExecutionIds).toEqual([
      'execution-success',
    ]);
    expect(saveProjects).toHaveBeenCalled();
  });

  it('persists seen execution ids when a worktree pipeline badge is cleared', async () => {
    usePipelineRunsStore.setState({
      unseenPipelineWorktreeKeys: new Set(['project-1/wt-1']),
      unseenFailedPipelineWorktreeKeys: new Set(['project-1/wt-1']),
      pipelineSummariesByWorktree: {
        'project-1/wt-1': [
          {
            id: 'execution-running',
            name: 'Build',
            status: 'running',
          },
          {
            id: 'execution-failure',
            name: 'Release',
            status: 'failure',
          },
          {
            id: 'execution-paused',
            name: 'Deploy',
            status: 'paused',
          },
        ],
      },
    });

    usePipelineRunsStore.getState().markWorktreePipelineSeen('project-1/wt-1');

    await Promise.resolve();

    expect(getFirstProjectFirstWorktree()?.seenPipelineExecutionIds).toEqual([
      'execution-failure',
      'execution-paused',
    ]);
    expect(saveProjects).toHaveBeenCalled();
  });

  it('only clears persisted seen ids for active executions that are still marked seen', async () => {
    useProjectsStore.setState({
      projects: [createProject()],
    });

    usePipelineRunsStore.getState().trackGlobalExecutionEvent(
      createExecutionEvent(
        'execution-running',
        createState({
          id: 'execution-running',
          pipeline_id: 'pipeline-running',
          pipeline_snapshot: {
            name: 'Build',
            jobs: {},
            env: {},
            inputs: {},
          },
          status: 'running',
          project_id: 'project-1',
          worktree_id: 'wt-1',
        }),
      ),
    );

    await Promise.resolve();

    expect(saveProjects).not.toHaveBeenCalled();

    useProjectsStore.setState({
      projects: [createProject(['execution-running'])],
    });

    usePipelineRunsStore.getState().trackGlobalExecutionEvent(
      createExecutionEvent(
        'execution-running',
        createState({
          id: 'execution-running',
          pipeline_id: 'pipeline-running',
          pipeline_snapshot: {
            name: 'Build',
            jobs: {},
            env: {},
            inputs: {},
          },
          status: 'running',
          project_id: 'project-1',
          worktree_id: 'wt-1',
        }),
      ),
    );

    await Promise.resolve();

    expect(saveProjects).toHaveBeenCalledTimes(1);
    expect(
      getFirstProjectFirstWorktree()?.seenPipelineExecutionIds,
    ).toBeUndefined();
  });
});

describe('pipelineRunsStore pendingExecutions queue (git-pending worktrees)', () => {
  const executePipeline = jest.fn();
  const getWorktreePath = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });

    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        execute: executePipeline,
        listExecutions: jest.fn(),
        getExecution: jest.fn(),
      },
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: {
        getWorktreePath,
      },
    });

    executePipeline.mockResolvedValue({ success: true, data: undefined });
    getWorktreePath.mockResolvedValue('/workspace/wt-pending');

    usePipelineRunsStore.setState({
      pendingExecutions: {},
      failedPendingExecutions: {},
    });
  });

  function makePipelineContent(): Pipeline {
    return {
      name: 'Build',
      on: 'task_ready',
      jobs: {
        deploy: {
          name: 'Deploy',
          steps: [{ run: 'echo hi' }],
        },
      },
    };
  }

  type EnqueueParams = Parameters<
    ReturnType<typeof usePipelineRunsStore.getState>['enqueuePendingExecution']
  >[0];

  function enqueueDefault(overrides: Partial<EnqueueParams> = {}): string {
    return usePipelineRunsStore.getState().enqueuePendingExecution({
      projectId: 'project-1',
      worktreeId: 'wt-pending',
      pipelineId: 'pipeline-1',
      pipelineContent: makePipelineContent(),
      eventName: 'task_ready',
      eventData: { task_ready: { task_text: 'Implement the feature' } },
      pluginCollectionPreferences: {},
      pipelineName: 'Build',
      taskText: 'Implement the feature',
      ...overrides,
    });
  }

  it('enqueues a pending execution under the worktree key', () => {
    const localId = enqueueDefault();
    const queued =
      usePipelineRunsStore.getState().pendingExecutions['project-1/wt-pending'];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.localId).toBe(localId);
    expect(queued?.[0]?.taskText).toBe('Implement the feature');
  });

  it('cancelPendingExecution removes only the targeted entry', () => {
    const firstId = enqueueDefault();
    const secondId = enqueueDefault();

    usePipelineRunsStore.getState().cancelPendingExecution(firstId);

    const queued =
      usePipelineRunsStore.getState().pendingExecutions['project-1/wt-pending'];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]?.localId).toBe(secondId);
  });

  it('flushPendingForWorktree calls getWorktreePath then pipelines.execute with pipelineContent first arg and the task text in eventData', async () => {
    enqueueDefault();
    await usePipelineRunsStore
      .getState()
      .flushPendingForWorktree('project-1', 'wt-pending');
    // Allow the dispatched promise to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-pending',
    });

    expect(executePipeline).toHaveBeenCalledTimes(1);
    // First arg is the captured pipeline content (NOT the task text).
    // Task text is delivered through eventData.task_ready.task_text.
    expect(executePipeline).toHaveBeenCalledWith(
      makePipelineContent(),
      expect.objectContaining({
        cwd: '/workspace/wt-pending',
        repoPath: '/workspace/wt-pending',
        pipelineId: 'pipeline-1',
        projectId: 'project-1',
        worktreeId: 'wt-pending',
        eventName: 'task_ready',
        eventData: { task_ready: { task_text: 'Implement the feature' } },
      }),
    );

    // Bucket cleared after dispatch.
    expect(
      usePipelineRunsStore.getState().pendingExecutions['project-1/wt-pending'],
    ).toBeUndefined();
  });

  it('flushPendingForWorktree forwards selectedRepoId to getWorktreePath when provided', async () => {
    enqueueDefault({ selectedRepoId: 'repo-A' });

    await usePipelineRunsStore
      .getState()
      .flushPendingForWorktree('project-1', 'wt-pending');
    await Promise.resolve();
    await Promise.resolve();

    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-pending',
      repoId: 'repo-A',
    });
  });

  it('dropPendingForWorktree clears the bucket without calling execute', () => {
    enqueueDefault();
    usePipelineRunsStore
      .getState()
      .dropPendingForWorktree('project-1', 'wt-pending');

    expect(
      usePipelineRunsStore.getState().pendingExecutions['project-1/wt-pending'],
    ).toBeUndefined();
    expect(executePipeline).not.toHaveBeenCalled();
  });

  it('records a per-entry failure when queued execution cannot be started', async () => {
    enqueueDefault();
    executePipeline.mockRejectedValueOnce(new Error('pipeline exploded'));

    await usePipelineRunsStore
      .getState()
      .flushPendingForWorktree('project-1', 'wt-pending');
    await Promise.resolve();
    await Promise.resolve();

    const failed =
      usePipelineRunsStore.getState().failedPendingExecutions[
        'project-1/wt-pending'
      ];
    expect(failed).toHaveLength(1);
    expect(failed?.[0]).toEqual(
      expect.objectContaining({
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
        taskText: 'Implement the feature',
        error: 'pipeline exploded',
      }),
    );
  });

  it('records a per-entry failure when execute resolves with success false', async () => {
    enqueueDefault();
    executePipeline.mockResolvedValueOnce({
      success: false,
      error: 'queue start failed',
    });

    await usePipelineRunsStore
      .getState()
      .flushPendingForWorktree('project-1', 'wt-pending');
    await Promise.resolve();
    await Promise.resolve();

    const failed =
      usePipelineRunsStore.getState().failedPendingExecutions[
        'project-1/wt-pending'
      ];
    expect(failed).toHaveLength(1);
    expect(failed?.[0]).toEqual(
      expect.objectContaining({
        pipelineId: 'pipeline-1',
        pipelineName: 'Build',
        taskText: 'Implement the feature',
        error: 'queue start failed',
      }),
    );
  });

  it('preserves failed pending executions across clear()', () => {
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      summaries: [
        {
          id: 'execution-1',
          pipeline_id: 'pipeline-1',
          pipeline_name: 'Build',
          status_reasons: [],
          status: 'failure',
          started_at: '2026-03-27T12:00:00.000Z',
          cwd: '/workspace',
          event_name: 'dispatch',
        },
      ],
      statesById: { 'execution-1': createState() },
      rowStatesById: {
        'execution-1': toPipelineRunRowState(createState()),
      },
      isHydratingGlobalPipelineStatuses: true,
      hasHydratedGlobalPipelineStatuses: true,
      pendingGlobalExecutionStatesById: {
        'execution-1': {
          id: 'execution-1',
          name: 'Pipeline 1',
          status: 'success',
        },
      },
      failedPendingExecutions: {
        'project-1/wt-pending': [
          {
            localId: 'failed-1',
            projectId: 'project-1',
            worktreeId: 'wt-pending',
            pipelineId: 'pipeline-1',
            pipelineName: 'Build',
            taskText: 'Implement the feature',
            error: 'queue start failed',
            failedAt: 123,
          },
        ],
      },
    });

    usePipelineRunsStore.getState().clear();

    expect(usePipelineRunsStore.getState().currentCwd).toBeNull();
    expect(usePipelineRunsStore.getState().summaries).toEqual([]);
    expect(usePipelineRunsStore.getState().statesById).toEqual({});
    expect(
      usePipelineRunsStore.getState().failedPendingExecutions[
        'project-1/wt-pending'
      ],
    ).toEqual([
      expect.objectContaining({
        localId: 'failed-1',
        error: 'queue start failed',
      }),
    ]);
  });

  it('starts queued work immediately when the target worktree is already git-ready', async () => {
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project-1',
          name: 'Project 1',
          repoPath: '/workspace',
          color: '#000000',
          worktrees: [
            {
              id: 'wt-pending',
              branchName: 'feature/test',
              createdAt: '2026-03-27T11:59:00.000Z',
              setupPhase: 'git-ready',
            },
          ],
          collapsed: false,
          order: 0,
        },
      ],
    });

    enqueueDefault();
    await Promise.resolve();
    await Promise.resolve();

    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(
      usePipelineRunsStore.getState().pendingExecutions['project-1/wt-pending'],
    ).toBeUndefined();
  });
});

describe('pipelineRunsStore hook-pipeline queue events', () => {
  const cancelQueuedExecution = jest.fn();
  const listExecutions = jest.fn();
  const listQueuedExecutions = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        cancelQueuedExecution,
        listExecutions,
        listQueuedExecutions,
      },
    });

    usePipelineRunsStore.setState({
      currentCwd: null,
      currentProjectId: null,
      currentWorktreeId: null,
      summaries: [],
      statesById: {},
      rowStatesById: {},
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: false,
      pendingGlobalExecutionStatesById: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      pipelineSummariesByWorktree: {},
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
    });
  });

  interface MakeQueueEntryResult {
    queueId: string;
    projectId: string;
    worktreeId: string;
    pipelineId: string;
    pipelineName: string;
    reason: 'pipeline-concurrency';
    reasonLabel: string;
    enqueuedAt: string;
  }

  function makeQueueEntry(
    overrides: Partial<{
      queueId: string;
      projectId: string;
      worktreeId: string;
      pipelineId: string;
      pipelineName: string;
    }> = {},
  ): MakeQueueEntryResult {
    return {
      queueId: 'queue-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      pipelineId: 'plan-review',
      pipelineName: 'Plan review',
      reason: 'pipeline-concurrency' as const,
      reasonLabel: 'Waiting for active pipeline runs to finish',
      enqueuedAt: '2026-03-27T12:00:00.000Z',
      ...overrides,
    };
  }

  it('appends entries to the per-worktree FIFO on queued events', () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([entry]);
  });

  it('removes a queued entry on started/cancelled events', () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'started',
      queueId: entry.queueId,
    });

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();

    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'cancelled',
      queueId: entry.queueId,
    });

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();
  });

  it('removes the queued entry and adds a failed card on failed events', () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'failed',
      queueId: entry.queueId,
      entry,
      error: 'boom',
    });

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();
    const failed =
      usePipelineRunsStore.getState().failedQueuedExecutionsByWorktree[
        'project-1/wt-1'
      ];
    expect(failed).toHaveLength(1);
    expect(failed?.[0]).toMatchObject({
      queueId: entry.queueId,
      pipelineName: entry.pipelineName,
      error: 'boom',
    });
  });

  it('caps failed queued cards to the most recent five entries per worktree', () => {
    for (let index = 1; index <= 6; index += 1) {
      const entry = makeQueueEntry({
        queueId: `queue-${index}`,
        pipelineId: `plan-${index}`,
        pipelineName: `Plan ${index}`,
      });
      usePipelineRunsStore.getState().handleQueueEvent({
        type: 'failed',
        queueId: entry.queueId,
        entry,
        error: `boom-${index}`,
      });
    }

    const failed =
      usePipelineRunsStore.getState().failedQueuedExecutionsByWorktree[
        'project-1/wt-1'
      ];
    expect(failed).toHaveLength(5);
    expect(failed?.map((entry) => entry.queueId)).toEqual([
      'queue-2',
      'queue-3',
      'queue-4',
      'queue-5',
      'queue-6',
    ]);
  });

  it('dismissFailedQueuedExecution drops the matching failed card', () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'failed',
      queueId: entry.queueId,
      entry,
      error: 'boom',
    });
    usePipelineRunsStore.getState().dismissFailedQueuedExecution(entry.queueId);

    expect(
      usePipelineRunsStore.getState().failedQueuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();
  });

  it('cancelQueuedPipelineExecution forwards to the IPC bridge', async () => {
    cancelQueuedExecution.mockResolvedValueOnce({ success: true });
    await usePipelineRunsStore
      .getState()
      .cancelQueuedPipelineExecution('queue-7');
    expect(cancelQueuedExecution).toHaveBeenCalledWith('queue-7');
  });

  it('hydrates queued execution cards while loading executions', async () => {
    const entry = makeQueueEntry();
    listExecutions.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    listQueuedExecutions.mockResolvedValueOnce({
      success: true,
      data: [entry],
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([entry]);
  });

  it('clears queued execution cards when queued refresh fails', async () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    listExecutions.mockResolvedValueOnce({
      success: true,
      data: [],
    });
    listQueuedExecutions.mockResolvedValueOnce({
      success: false,
      error: 'queue refresh failed',
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(usePipelineRunsStore.getState().queuedExecutionsByWorktree).toEqual(
      {},
    );
  });

  it('clears queued state on dropPendingForWorktree and clear()', () => {
    const entry = makeQueueEntry();
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'failed',
      queueId: 'queue-2',
      entry: makeQueueEntry({ queueId: 'queue-2' }),
      error: 'boom',
    });
    usePipelineRunsStore.getState().dropPendingForWorktree('project-1', 'wt-1');

    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().failedQueuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toBeUndefined();

    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'queued',
      entry,
    });
    usePipelineRunsStore.getState().handleQueueEvent({
      type: 'failed',
      queueId: 'queue-3',
      entry: makeQueueEntry({ queueId: 'queue-3' }),
      error: 'boom',
    });
    // Losing the selected scope resets only the scoped run list. The queue
    // maps are global (keyed by worktree) and stay for other consumers.
    usePipelineRunsStore.getState().clear();
    expect(
      usePipelineRunsStore.getState().queuedExecutionsByWorktree[
        'project-1/wt-1'
      ],
    ).toEqual([entry]);
    expect(
      usePipelineRunsStore
        .getState()
        .failedQueuedExecutionsByWorktree[
          'project-1/wt-1'
        ]?.map((failed) => failed.queueId),
    ).toEqual(['queue-3']);
  });
});

describe('pipelineRunsStore summary trigger source attribution', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        retryExecution: jest.fn().mockResolvedValue({ success: true }),
      },
    });

    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: null,
      currentWorktreeId: null,
      summaries: [],
      statesById: {},
      rowStatesById: {},
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: false,
      pendingGlobalExecutionStatesById: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      pipelineSummariesByWorktree: {},
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
    });
  });

  it('handleExecutionEvent copies trigger_source onto the rendered summary', () => {
    const triggerSource = {
      kind: 'hook' as const,
      hook_key: 'project:pr:create',
      hook_label: 'PR Created',
      trigger_name: 'pr:create',
      target: 'project' as const,
      action_index: 0,
      triggered_at: '2026-03-27T12:00:00.000Z',
    };

    const state = createState({
      id: 'execution-hook-1',
      status: 'running',
      cwd: '/workspace',
      trigger_source: triggerSource,
    });

    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: null,
      currentWorktreeId: null,
    });
    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(createExecutionEvent('execution-hook-1', state));

    const summaries = usePipelineRunsStore.getState().summaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0].trigger_source).toEqual(triggerSource);
  });
});

describe('pipelineRunsStore Pipeline Advisor snapshots', () => {
  const listExecutions = jest.fn();
  const getExecution = jest.fn();
  const listAdvisorSnapshots = jest.fn();
  const getAdvisorSnapshot = jest.fn();

  function makeSnapshot(
    executionId: string,
    overrides: Partial<{
      latestReportEta: 'available' | 'unknown' | 'complete';
      remainingSeconds?: number;
      generatedAt: string;
    }> = {},
  ): PipelineAdvisorSnapshot {
    const generatedAt = overrides.generatedAt ?? '2026-03-27T12:01:00.000Z';
    return {
      version: 1,
      executionId,
      executionDataDir: `/data/${executionId}`,
      stateFilePath: `/data/${executionId}/pipeline-advisor.json`,
      provider: 'codex',
      model: 'gpt-6-luna',
      thinkingLevel: 'high',
      status: 'running',
      turnCount: 1,
      backoffIndex: 0,
      lastUpdatedAt: generatedAt,
      reports: [],
      latestReport: {
        version: 1,
        reportId: `report-${executionId}`,
        executionId,
        kind: 'periodic',
        generatedAt,
        pipelineStatus: 'running',
        health: {
          status: 'healthy',
          score: 80,
          summary: 'Pipeline is making steady progress.',
          evidence: [],
          blockers: [],
        },
        eta: {
          status: overrides.latestReportEta ?? 'available',
          remainingSeconds: overrides.remainingSeconds ?? 720,
          confidence: 'medium',
          rationale: 'Based on observed step durations.',
        },
        inefficiencies: [],
        summary: 'Pipeline appears healthy.',
        recommendations: [],
      },
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: {
        listExecutions,
        getExecution,
        listAdvisorSnapshots,
        getAdvisorSnapshot,
      },
    });

    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: null,
      currentWorktreeId: null,
      summaries: [],
      statesById: {},
      rowStatesById: {},
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: false,
      pendingGlobalExecutionStatesById: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      pipelineSummariesByWorktree: {},
      pendingExecutions: {},
      failedPendingExecutions: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
      advisorSnapshotsByExecutionId: {},
    });
    useChatStore.setState({ selectedWorktree: null });
    useNavigationStore.getState().navigate('overview');
    useProjectsStore.setState({ projects: [createProject()] });
  });

  it('loadExecutions hydrates advisor snapshots for the returned summaries', async () => {
    listExecutions.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'execution-advisor-1',
          pipeline_id: 'pipeline-advisor-1',
          pipeline_name: 'Advisor Pipeline',
          status_reasons: [],
          status: 'running',
          started_at: '2026-03-27T12:00:00.000Z',
          cwd: '/workspace',
          project_id: 'project-1',
          worktree_id: 'wt-1',
          event_name: 'dispatch',
        },
      ] satisfies ExecutionSummary[],
    });
    const snapshot = makeSnapshot('execution-advisor-1');
    listAdvisorSnapshots.mockResolvedValue({
      success: true,
      data: [snapshot],
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(listAdvisorSnapshots).toHaveBeenCalledWith(['execution-advisor-1']);
    expect(
      usePipelineRunsStore.getState().advisorSnapshotsByExecutionId,
    ).toEqual({ 'execution-advisor-1': snapshot });
  });

  it('handleAdvisorEvent upserts the carried snapshot by execution id', () => {
    const snapshotA = makeSnapshot('execution-advisor-1');
    usePipelineRunsStore.setState({
      advisorSnapshotsByExecutionId: { 'execution-advisor-1': snapshotA },
    });

    const snapshotB = makeSnapshot('execution-advisor-1', {
      generatedAt: '2026-03-27T12:05:00.000Z',
      remainingSeconds: 600,
    });
    usePipelineRunsStore.getState().handleAdvisorEvent({
      executionId: 'execution-advisor-1',
      snapshot: snapshotB,
      timestamp: '2026-03-27T12:05:01.000Z',
    });

    expect(
      usePipelineRunsStore.getState().advisorSnapshotsByExecutionId[
        'execution-advisor-1'
      ],
    ).toBe(snapshotB);

    const snapshotC = makeSnapshot('execution-advisor-2');
    usePipelineRunsStore.getState().handleAdvisorEvent({
      executionId: 'execution-advisor-2',
      snapshot: snapshotC,
      timestamp: '2026-03-27T12:05:02.000Z',
    });

    expect(
      Object.keys(
        usePipelineRunsStore.getState().advisorSnapshotsByExecutionId,
      ),
    ).toEqual(
      expect.arrayContaining(['execution-advisor-1', 'execution-advisor-2']),
    );
  });

  it('clear() keeps advisor snapshots, which overview and sidebar consumers read', () => {
    usePipelineRunsStore.setState({
      advisorSnapshotsByExecutionId: {
        'execution-advisor-1': makeSnapshot('execution-advisor-1'),
      },
    });

    usePipelineRunsStore.getState().clear();

    expect(
      Object.keys(
        usePipelineRunsStore.getState().advisorSnapshotsByExecutionId,
      ),
    ).toEqual(['execution-advisor-1']);
  });
});

describe('pipelineRunsStore list/detail lifecycle (phase 02)', () => {
  const listExecutions = jest.fn();
  const listQueuedExecutions = jest.fn();
  const getExecution = jest.fn();

  function summaryFor(state: ExecutionState): ExecutionSummary {
    return {
      id: state.id,
      pipeline_id: state.pipeline_id,
      pipeline_name: state.pipeline_snapshot.name,
      status_reasons: [],
      status: state.status,
      started_at: state.started_at,
      cwd: state.cwd,
      event_name: state.event_name,
      project_id: state.project_id,
      worktree_id: state.worktree_id,
    };
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  }

  const inScope = createState({
    id: 'execution-in-scope',
    project_id: 'project-1',
    worktree_id: 'wt-1',
    status: 'running',
  });
  const otherWorktree = createState({
    id: 'execution-other',
    cwd: '/other',
    project_id: 'project-1',
    worktree_id: 'wt-2',
    status: 'running',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetPipelineDetailLeasesForTests();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    Object.defineProperty(globalThis.window, 'pipelines', {
      configurable: true,
      value: { listExecutions, listQueuedExecutions, getExecution },
    });
    Object.defineProperty(globalThis.window, 'api', {
      configurable: true,
      value: { saveProjects: jest.fn() },
    });
    listQueuedExecutions.mockResolvedValue({ success: true, data: [] });
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
      summaries: [summaryFor(inScope)],
      statesById: {},
      rowStatesById: {},
      isHydratingGlobalPipelineStatuses: false,
      hasHydratedGlobalPipelineStatuses: true,
      pendingGlobalExecutionStatesById: {},
      runningExecutionsByWorktree: {},
      pausedExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set<string>(),
      unseenFailedPipelineWorktreeKeys: new Set<string>(),
      pipelineSummariesByWorktree: {},
      queuedExecutionsByWorktree: {},
      failedQueuedExecutionsByWorktree: {},
      advisorSnapshotsByExecutionId: {},
    });
    useChatStore.setState({ selectedWorktree: null });
    useNavigationStore.getState().navigate('overview');
    useProjectsStore.setState({
      projects: [createProject()],
      fastRefreshWorktreeDiffStats: jest.fn(),
    });
  });

  it('keeps a listed row on same-scope reload without retaining full detail', async () => {
    usePipelineRunsStore.setState({
      statesById: { [inScope.id]: inScope },
      rowStatesById: { [inScope.id]: toPipelineRunRowState(inScope) },
    });
    listExecutions.mockResolvedValue({
      success: true,
      data: [summaryFor(inScope)],
    });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(
      usePipelineRunsStore.getState().statesById[inScope.id],
    ).toBeUndefined();
    expect(usePipelineRunsStore.getState().rowStatesById[inScope.id]).toEqual(
      toPipelineRunRowState(inScope),
    );
  });

  it('a failed same-scope list reload prunes unleased details and rows', async () => {
    usePipelineRunsStore.setState({
      statesById: { [inScope.id]: inScope },
      rowStatesById: { [inScope.id]: toPipelineRunRowState(inScope) },
    });
    listExecutions.mockResolvedValue({ success: false, error: 'nope' });

    await usePipelineRunsStore.getState().loadExecutions({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(usePipelineRunsStore.getState().summaries).toEqual([]);
    expect(
      usePipelineRunsStore.getState().statesById[inScope.id],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().rowStatesById[inScope.id],
    ).toBeUndefined();
  });

  it('a scope switch keeps only leased detail and interested/listed rows', async () => {
    const chatCardRun = createState({ id: 'execution-chat-card' });
    usePipelineRunsStore.setState({
      statesById: {
        [inScope.id]: inScope,
        [otherWorktree.id]: otherWorktree,
        [chatCardRun.id]: chatCardRun,
      },
      rowStatesById: {
        [inScope.id]: toPipelineRunRowState(inScope),
        [otherWorktree.id]: toPipelineRunRowState(otherWorktree),
        [chatCardRun.id]: toPipelineRunRowState(chatCardRun),
      },
    });
    const lease = acquirePipelineDetailLease(
      { projectId: 'project-1', worktreeId: 'wt-2' },
      otherWorktree.id,
    );
    const releaseInterest = acquirePipelineSummaryInterest(chatCardRun.id);
    const listed = deferred<{ success: true; data: ExecutionSummary[] }>();
    listExecutions.mockReturnValue(listed.promise);

    const loading = usePipelineRunsStore.getState().loadExecutions({
      cwd: '/other',
      projectId: 'project-1',
      worktreeId: 'wt-2',
    });

    // Scope change clears old list demand; the detail lease and chat interest
    // retain one full state and two lightweight rows respectively.
    expect(usePipelineRunsStore.getState().summaries).toEqual([]);
    expect(
      Object.keys(usePipelineRunsStore.getState().statesById).sort(),
    ).toEqual([otherWorktree.id]);
    expect(
      Object.keys(usePipelineRunsStore.getState().rowStatesById).sort(),
    ).toEqual([chatCardRun.id, otherWorktree.id].sort());

    listed.resolve({ success: true, data: [summaryFor(otherWorktree)] });
    await loading;
    expect(
      usePipelineRunsStore.getState().summaries.map((summary) => summary.id),
    ).toEqual([otherWorktree.id]);
    releasePipelineDetailLease(lease);
    releaseInterest();
  });

  it('clear() resets only the scoped list and unretained detail', () => {
    const pending = createState({ id: 'execution-hydrating' });
    const leased = createState({ id: 'execution-leased' });
    usePipelineRunsStore.setState({
      statesById: { [inScope.id]: inScope, [leased.id]: leased },
      rowStatesById: {
        [inScope.id]: toPipelineRunRowState(inScope),
        [leased.id]: toPipelineRunRowState(leased),
      },
      isHydratingGlobalPipelineStatuses: true,
      pendingGlobalExecutionStatesById: {
        [pending.id]: {
          id: pending.id,
          name: pending.pipeline_snapshot.name,
          status: pending.status,
        },
      },
      queuedExecutionsByWorktree: {
        'project-1/wt-1': [
          {
            queueId: 'queue-1',
            projectId: 'project-1',
            worktreeId: 'wt-1',
            pipelineId: 'pipeline-1',
            pipelineName: 'Pipeline 1',
            reason: 'pipeline-concurrency',
            reasonLabel: 'Waiting',
            enqueuedAt: '2026-03-27T12:00:00.000Z',
          },
        ],
      },
    });
    const lease = acquirePipelineDetailLease(null, leased.id);

    usePipelineRunsStore.getState().clear();

    const state = usePipelineRunsStore.getState();
    expect(state.currentCwd).toBeNull();
    expect(state.summaries).toEqual([]);
    expect(Object.keys(state.statesById)).toEqual([leased.id]);
    expect(Object.keys(state.rowStatesById)).toEqual([leased.id]);
    // Global hydration buffering, queue, and advisor state survive.
    expect(state.isHydratingGlobalPipelineStatuses).toBe(true);
    expect(Object.keys(state.pendingGlobalExecutionStatesById)).toEqual([
      pending.id,
    ]);
    expect(Object.keys(state.queuedExecutionsByWorktree)).toEqual([
      'project-1/wt-1',
    ]);
    releasePipelineDetailLease(lease);
  });

  it('applies events to a leased execution outside the selected scope, and with no scope at all', () => {
    usePipelineRunsStore.setState({
      statesById: { [otherWorktree.id]: otherWorktree },
    });
    const lease = acquirePipelineDetailLease(null, otherWorktree.id);
    const paused = createState({ ...otherWorktree, status: 'paused' });

    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(createExecutionEvent(paused.id, paused));

    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id]?.status,
    ).toBe('paused');
    // The out-of-scope run does not enter the selected list.
    expect(
      usePipelineRunsStore.getState().summaries.map((summary) => summary.id),
    ).toEqual([inScope.id]);

    usePipelineRunsStore.getState().clear();
    const success = createState({ ...otherWorktree, status: 'success' });
    usePipelineRunsStore
      .getState()
      .trackGlobalExecutionEvent(createExecutionEvent(success.id, success));
    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id]?.status,
    ).toBe('success');
    releasePipelineDetailLease(lease);
  });

  it('keeps a chat card state live outside the scope and ignores unknown out-of-scope runs', () => {
    const releaseInterest = acquirePipelineSummaryInterest(otherWorktree.id);
    const stranger = createState({
      ...otherWorktree,
      id: 'execution-stranger',
    });

    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(
        createExecutionEvent(otherWorktree.id, otherWorktree),
      );
    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(createExecutionEvent(stranger.id, stranger));

    const state = usePipelineRunsStore.getState();
    expect(state.statesById[otherWorktree.id]).toBeUndefined();
    expect(state.rowStatesById[otherWorktree.id]).toEqual(
      toPipelineRunRowState(otherWorktree),
    );
    expect(state.statesById[stranger.id]).toBeUndefined();
    expect(state.rowStatesById[stranger.id]).toBeUndefined();
    releaseInterest();
  });

  it('keeps an already cached state live when its events arrive out of scope', () => {
    usePipelineRunsStore.setState({
      statesById: { [otherWorktree.id]: otherWorktree },
      rowStatesById: {
        [otherWorktree.id]: toPipelineRunRowState(otherWorktree),
      },
    });
    const lease = acquirePipelineDetailLease(null, otherWorktree.id);
    const failed = createState({ ...otherWorktree, status: 'failure' });

    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(createExecutionEvent(failed.id, failed));

    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id]?.status,
    ).toBe('failure');
    releasePipelineDetailLease(lease);
  });

  it('updates an in-list unleased event as a row without retaining full detail', () => {
    usePipelineRunsStore.setState({ summaries: [summaryFor(inScope)] });
    const paused = createState({ ...inScope, status: 'paused' });

    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(createExecutionEvent(paused.id, paused));

    const state = usePipelineRunsStore.getState();
    expect(state.statesById[inScope.id]).toBeUndefined();
    expect(state.rowStatesById).toEqual({
      [inScope.id]: toPipelineRunRowState(paused),
    });
  });

  it('rejects a late running snapshot that resolves after a newer terminal event', async () => {
    const read = deferred<{ success: true; data: ExecutionState }>();
    getExecution.mockReturnValue(read.promise);
    const lease = acquirePipelineDetailLease(null, otherWorktree.id);

    const loading = usePipelineRunsStore
      .getState()
      .loadExecutionDetails(otherWorktree.id);
    const completed = createState({
      ...otherWorktree,
      status: 'success',
      completed_at: '2026-03-27T12:10:00.000Z',
    });
    usePipelineRunsStore.getState().trackGlobalExecutionEvent({
      ...createExecutionEvent(completed.id, completed),
      type: 'execution.completed',
    });
    read.resolve({ success: true, data: otherWorktree });

    await expect(loading).resolves.toMatchObject({ status: 'success' });
    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id]?.status,
    ).toBe('success');
    releasePipelineDetailLease(lease);
  });

  it('fills a superseding definition-less state from the late snapshot structure', async () => {
    const read = deferred<{ success: true; data: ExecutionState }>();
    getExecution.mockReturnValue(read.promise);
    const snapshot = createState({
      ...otherWorktree,
      job_definitions: {
        build: {
          physical_job_id: 'build',
          logical_job_id: 'build',
          name: 'Build',
          needs: [],
          timeout_minutes: 0,
          max_retries: 0,
          continue_on_error: false,
          steps: [],
        },
      },
    });
    const lease = acquirePipelineDetailLease(null, otherWorktree.id);

    const loading = usePipelineRunsStore
      .getState()
      .loadExecutionDetails(otherWorktree.id);
    const pausedWithoutDefinitions = createState({
      ...otherWorktree,
      status: 'paused',
      job_definitions: undefined,
      job_groups: undefined,
    });
    usePipelineRunsStore
      .getState()
      .handleExecutionEvent(
        createExecutionEvent(
          pausedWithoutDefinitions.id,
          pausedWithoutDefinitions,
        ),
      );
    read.resolve({ success: true, data: snapshot });
    await loading;

    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id],
    ).toMatchObject({
      status: 'paused',
      job_definitions: snapshot.job_definitions,
    });
    releasePipelineDetailLease(lease);
  });

  it('returns an unleased snapshot to its caller without retaining full detail', async () => {
    getExecution.mockResolvedValue({ success: true, data: otherWorktree });

    await expect(
      usePipelineRunsStore.getState().loadExecutionDetails(otherWorktree.id),
    ).resolves.toBe(otherWorktree);

    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id],
    ).toBeUndefined();
  });

  it('shares one in-flight snapshot read between concurrent consumers', async () => {
    const read = deferred<{ success: true; data: ExecutionState }>();
    getExecution.mockReturnValue(read.promise);

    const first = usePipelineRunsStore
      .getState()
      .loadExecutionDetails(otherWorktree.id);
    const second = usePipelineRunsStore
      .getState()
      .loadExecutionDetails(otherWorktree.id);
    read.resolve({ success: true, data: otherWorktree });

    await expect(Promise.all([first, second])).resolves.toEqual([
      otherWorktree,
      otherWorktree,
    ]);
    expect(getExecution).toHaveBeenCalledTimes(1);

    getExecution.mockResolvedValue({ success: true, data: otherWorktree });
    await usePipelineRunsStore
      .getState()
      .loadExecutionDetails(otherWorktree.id);
    expect(getExecution).toHaveBeenCalledTimes(2);
  });

  it('a rejected snapshot read resolves null', async () => {
    getExecution.mockRejectedValue(new Error('IPC down'));

    await expect(
      usePipelineRunsStore.getState().loadExecutionDetails(otherWorktree.id),
    ).resolves.toBeNull();
  });

  it('releaseExecutionDetail evicts only detail nothing else retains', () => {
    const interested = createState({ id: 'execution-interested' });
    usePipelineRunsStore.setState({
      statesById: {
        [inScope.id]: inScope,
        [otherWorktree.id]: otherWorktree,
        [interested.id]: interested,
      },
      rowStatesById: {
        [inScope.id]: toPipelineRunRowState(inScope),
        [interested.id]: toPipelineRunRowState(interested),
      },
    });
    const releaseInterest = acquirePipelineSummaryInterest(interested.id);

    const store = usePipelineRunsStore.getState();
    store.releaseExecutionDetail(inScope.id);
    store.releaseExecutionDetail(otherWorktree.id);
    store.releaseExecutionDetail(interested.id);

    const state = usePipelineRunsStore.getState();
    expect(Object.keys(state.statesById)).toEqual([]);
    expect(Object.keys(state.rowStatesById).sort()).toEqual(
      [inScope.id, interested.id].sort(),
    );
    releaseInterest();
  });

  it('prunes after the last of two leases and two summary interests releases', async () => {
    const state = createState({ id: 'execution-ref-counted' });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { [state.id]: state },
      rowStatesById: { [state.id]: toPipelineRunRowState(state) },
    });
    const leaseA = acquirePipelineDetailLease(null, state.id);
    const leaseB = acquirePipelineDetailLease(null, state.id);
    const releaseInterestA = acquirePipelineSummaryInterest(state.id);
    const releaseInterestB = acquirePipelineSummaryInterest(state.id);

    releasePipelineDetailLease(leaseA);
    releaseInterestA();
    expect(usePipelineRunsStore.getState().statesById[state.id]).toBe(state);
    expect(
      usePipelineRunsStore.getState().rowStatesById[state.id],
    ).toBeDefined();

    releasePipelineDetailLease(leaseB);
    await Promise.resolve();
    expect(
      usePipelineRunsStore.getState().statesById[state.id],
    ).toBeUndefined();
    expect(
      usePipelineRunsStore.getState().rowStatesById[state.id],
    ).toBeDefined();

    releaseInterestB();
    await Promise.resolve();
    expect(
      usePipelineRunsStore.getState().rowStatesById[state.id],
    ).toBeUndefined();
  });

  it('owner cleanup releases every lease of that owner and evicts its detail', () => {
    usePipelineRunsStore.setState({
      statesById: { [otherWorktree.id]: otherWorktree },
    });
    const owner = { projectId: 'project-1', worktreeId: 'wt-2' };
    acquirePipelineDetailLease(owner, otherWorktree.id);
    acquirePipelineDetailLease(owner, otherWorktree.id);
    const otherOwnerLease = acquirePipelineDetailLease(
      { projectId: 'project-1', worktreeId: 'wt-3' },
      'execution-kept',
    );

    usePipelineRunsStore.getState().releaseDetailOwner('project-1', 'wt-2');

    expect(getPipelineDetailLeaseCount(otherWorktree.id)).toBe(0);
    expect(getPipelineDetailLeaseCount('execution-kept')).toBe(1);
    expect(
      usePipelineRunsStore.getState().statesById[otherWorktree.id],
    ).toBeUndefined();
    releasePipelineDetailLease(otherOwnerLease);
  });
});
