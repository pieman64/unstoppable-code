/**
 * @jest-environment jsdom
 */
import { act, useLayoutEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  IPCResult,
  StepLogReadResult,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getPipelineDetailLeaseCount,
  hasPipelineSummaryInterest,
  isPipelineExecutionLeased,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { toPipelineRunRowState } from '@/lib/pipelineRunRowState';
import { usePipelineExecutionDetailData } from '@/components/activity/details/usePipelineExecutionDetailData';
import {
  acquirePipelineExecutionDetail,
  usePipelineExecutionDetailLease,
  usePipelineExecutionSummaryInterest,
  useStepLogInterest,
  type PipelineDetailOwner,
} from '@/stores/pipelineDetailCoordinator';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  getStepLogInterestCount,
  hasStepLogInterestForExecution,
  resetStepLogStoreForTests,
} from '@/stores/pipelineStepLogStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    version: 1,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Pipeline 1',
      scope: ['directory'],
      jobs: {},
      env: {},
      inputs: {},
    },
    status: 'running',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    started_at: '2026-03-27T12:00:00.000Z',
    cwd: '/workspace',
    env: {},
    inputs: {},
    pending_pauses: [],
    status_reasons: [],
    event_name: 'dispatch',
    project_id: 'project-1',
    worktree_id: 'wt-2',
    ...overrides,
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const getExecution = jest.fn<Promise<IPCResult<ExecutionState>>, [string]>();
const readStepLog = jest.fn<
  Promise<IPCResult<StepLogReadResult>>,
  [unknown, unknown]
>();

const OWNER_A: PipelineDetailOwner = {
  projectId: 'project-1',
  worktreeId: 'wt-1',
};
const OWNER_B: PipelineDetailOwner = {
  projectId: 'project-1',
  worktreeId: 'wt-3',
};

describe('pipelineDetailCoordinator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: { getExecution, readStepLog },
    });
    getExecution.mockResolvedValue({ success: true, data: createState() });
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['persisted'] },
    });
    usePipelineRunsStore.setState({
      currentCwd: '/workspace',
      currentProjectId: 'project-1',
      currentWorktreeId: 'wt-1',
      summaries: [],
      statesById: {},
      rowStatesById: {},
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('registers the lease before issuing the snapshot read', async () => {
    let leasedWhenRead = false;
    getExecution.mockImplementation((executionId) => {
      leasedWhenRead = isPipelineExecutionLeased(executionId);
      return Promise.resolve({ success: true, data: createState() });
    });

    const release = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    await flushAsyncWork();

    expect(leasedWhenRead).toBe(true);
    release();
  });

  it('ref-counts leases across owners and evicts detail after the last release', async () => {
    const releaseA = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    const releaseB = acquirePipelineExecutionDetail(OWNER_B, 'execution-1');
    await flushAsyncWork();

    // Single flight: two consumers, one snapshot read.
    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(getPipelineDetailLeaseCount('execution-1')).toBe(2);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeDefined();

    releaseA();
    releaseA();
    expect(getPipelineDetailLeaseCount('execution-1')).toBe(1);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeDefined();

    releaseB();
    expect(getPipelineDetailLeaseCount('execution-1')).toBe(0);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeUndefined();
  });

  it('does not install a snapshot that resolves after the last lease was released', async () => {
    let resolveRead: (value: IPCResult<ExecutionState>) => void = () =>
      undefined;
    getExecution.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const release = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    release();
    resolveRead({ success: true, data: createState() });
    await flushAsyncWork();

    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeUndefined();
    // Nothing orphaned: later events for the run are not cached either.
    usePipelineRunsStore.getState().handleExecutionEvent({
      type: 'execution.updated',
      executionId: 'execution-1',
      state: createState({ status: 'paused' }),
      timestamp: '2026-03-27T12:01:00.000Z',
    });
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeUndefined();
  });

  it('a lease acquired again before the read resolves shares it and installs the snapshot', async () => {
    let resolveRead: (value: IPCResult<ExecutionState>) => void = () =>
      undefined;
    getExecution.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const releaseFirst = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    releaseFirst();
    const releaseSecond = acquirePipelineExecutionDetail(
      OWNER_B,
      'execution-1',
    );
    resolveRead({ success: true, data: createState() });
    await flushAsyncWork();

    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeDefined();
    releaseSecond();
  });

  it('a non-lease caller joining an abandoned read gets a transient snapshot', async () => {
    let resolveRead: (value: IPCResult<ExecutionState>) => void = () =>
      undefined;
    getExecution.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const release = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    release();
    const joined = usePipelineRunsStore
      .getState()
      .loadExecutionDetails('execution-1');
    resolveRead({ success: true, data: createState() });

    await expect(joined).resolves.toMatchObject({ id: 'execution-1' });
    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeUndefined();
  });

  it('evicts full detail when the last lease closes while its listed row remains', async () => {
    const state = createState({ worktree_id: 'wt-1' });
    getExecution.mockResolvedValue({ success: true, data: state });
    usePipelineRunsStore.setState({
      summaries: [
        {
          id: state.id,
          pipeline_id: state.pipeline_id,
          pipeline_name: 'Pipeline 1',
          status: 'running',
          status_reasons: [],
          started_at: state.started_at,
          cwd: state.cwd,
          project_id: 'project-1',
          worktree_id: 'wt-1',
        },
      ],
      rowStatesById: { [state.id]: toPipelineRunRowState(state) },
    });

    const release = acquirePipelineExecutionDetail(OWNER_A, state.id);
    await flushAsyncWork();
    release();

    expect(
      usePipelineRunsStore.getState().statesById[state.id],
    ).toBeUndefined();
    expect(usePipelineRunsStore.getState().rowStatesById[state.id]).toEqual(
      toPipelineRunRowState(state),
    );
  });

  it('reuses a complete cached snapshot instead of reading again', async () => {
    usePipelineRunsStore.setState({
      statesById: { 'execution-1': createState() },
      rowStatesById: {},
    });

    const release = acquirePipelineExecutionDetail(OWNER_A, 'execution-1');
    await flushAsyncWork();

    expect(getExecution).not.toHaveBeenCalled();
    release();
  });

  function LeaseHarness({
    executionId,
    enabled,
    onResult,
  }: {
    executionId: string;
    enabled: boolean;
    onResult: (loadFailed: boolean) => void;
  }): JSX.Element {
    const { loadFailed } = usePipelineExecutionDetailLease(
      OWNER_A,
      executionId,
      enabled,
    );
    onResult(loadFailed);
    return <></>;
  }

  it('the lease hook loads while enabled, reports failures, and releases on disable', async () => {
    getExecution.mockResolvedValueOnce({ success: false, error: 'missing' });
    const results: boolean[] = [];
    await act(async () => {
      root.render(
        <LeaseHarness
          executionId="execution-1"
          enabled
          onResult={(value) => results.push(value)}
        />,
      );
      await flushAsyncWork();
    });

    expect(isPipelineExecutionLeased('execution-1')).toBe(true);
    expect(results[results.length - 1]).toBe(true);

    await act(async () => {
      root.render(
        <LeaseHarness
          executionId="execution-1"
          enabled={false}
          onResult={(value) => results.push(value)}
        />,
      );
      await flushAsyncWork();
    });
    expect(isPipelineExecutionLeased('execution-1')).toBe(false);
    expect(results[results.length - 1]).toBe(false);
  });

  it('the lease hook reloads when a leased snapshot disappears', async () => {
    await act(async () => {
      root.render(
        <LeaseHarness
          executionId="execution-1"
          enabled
          onResult={() => undefined}
        />,
      );
      await flushAsyncWork();
    });
    expect(getExecution).toHaveBeenCalledTimes(1);

    await act(async () => {
      usePipelineRunsStore.setState({ statesById: {} });
      await flushAsyncWork();
    });

    expect(getExecution).toHaveBeenCalledTimes(2);
    expect(
      usePipelineRunsStore.getState().statesById['execution-1'],
    ).toBeDefined();
  });

  it('loads full detail when a row exists but the full cache is empty', async () => {
    const state = createState();
    usePipelineRunsStore.setState({
      rowStatesById: { [state.id]: toPipelineRunRowState(state) },
    });
    expect(
      usePipelineRunsStore.getState().statesById[state.id],
    ).toBeUndefined();

    await act(async () => {
      root.render(
        <LeaseHarness
          executionId={state.id}
          enabled
          onResult={() => undefined}
        />,
      );
      await flushAsyncWork();
    });

    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(usePipelineRunsStore.getState().statesById[state.id]).toBeDefined();
    expect(usePipelineRunsStore.getState().rowStatesById[state.id]).toEqual(
      toPipelineRunRowState(state),
    );
  });

  function SummaryHarness({ ids }: { ids: string[] }): JSX.Element {
    usePipelineExecutionSummaryInterest(ids);
    return <></>;
  }

  it('holds summary interest for the listed executions only while mounted', () => {
    act(() => {
      root.render(<SummaryHarness ids={['execution-1', 'execution-2']} />);
    });
    expect(hasPipelineSummaryInterest('execution-1')).toBe(true);
    expect(hasPipelineSummaryInterest('execution-2')).toBe(true);
    expect(isPipelineExecutionLeased('execution-1')).toBe(false);
    expect(getExecution).not.toHaveBeenCalled();

    act(() => {
      root.render(<SummaryHarness ids={['execution-2']} />);
    });
    expect(hasPipelineSummaryInterest('execution-1')).toBe(false);
    expect(hasPipelineSummaryInterest('execution-2')).toBe(true);

    act(() => {
      root.render(<></>);
    });
    expect(hasPipelineSummaryInterest('execution-2')).toBe(false);
  });

  it('keeps a shared summary row when interest ids are re-keyed', async () => {
    getExecution.mockImplementation((executionId) =>
      Promise.resolve({
        success: true,
        data: createState({ id: executionId }),
      }),
    );

    act(() => {
      root.render(<SummaryHarness ids={['a', 'b']} />);
    });
    await act(async () => {
      await usePipelineRunsStore.getState().loadExecutionRowState('b');
    });
    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(getExecution).toHaveBeenCalledWith('b');
    usePipelineRunsStore.setState((state) => ({
      summaries: [],
      rowStatesById: {
        ...state.rowStatesById,
        a: toPipelineRunRowState(createState({ id: 'a' })),
      },
    }));

    await act(async () => {
      root.render(<SummaryHarness ids={['b', 'c']} />);
      await Promise.resolve();
    });

    expect(usePipelineRunsStore.getState().rowStatesById.a).toBeUndefined();
    expect(usePipelineRunsStore.getState().rowStatesById.b).toBeDefined();

    await act(async () => {
      await usePipelineRunsStore.getState().loadExecutionRowState('b');
    });

    expect(getExecution).toHaveBeenCalledTimes(1);
    expect(getExecution).toHaveBeenCalledWith('b');
  });

  function DetailDataHarness({
    activeExecutionId,
    enabled,
  }: {
    activeExecutionId: string;
    enabled: boolean;
  }): JSX.Element {
    usePipelineExecutionDetailData({
      rootExecutionId: 'root',
      activeExecutionId,
      owner: OWNER_A,
      enabled,
    });
    return <></>;
  }

  it('retains root detail while a child is active and releases it when disabled', async () => {
    const rootState = createState({ id: 'root' });
    const childState = createState({
      id: 'child',
      parent_execution_id: 'root',
    });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { root: rootState, child: childState },
      rowStatesById: {},
    });

    await act(async () => {
      root.render(<DetailDataHarness activeExecutionId="child" enabled />);
      await flushAsyncWork();
    });

    expect(getPipelineDetailLeaseCount('root')).toBe(1);
    expect(usePipelineRunsStore.getState().statesById.root).toBe(rootState);

    await act(async () => {
      root.render(
        <DetailDataHarness activeExecutionId="child" enabled={false} />,
      );
      await flushAsyncWork();
    });

    expect(getPipelineDetailLeaseCount('root')).toBe(0);
    expect(usePipelineRunsStore.getState().statesById.root).toBeUndefined();
  });

  it('keeps root detail through active execution transitions', async () => {
    const rootState = createState({ id: 'root' });
    const childState = createState({
      id: 'child',
      parent_execution_id: 'root',
    });
    getExecution.mockImplementation((executionId) =>
      Promise.resolve({
        success: true,
        data: executionId === 'root' ? rootState : childState,
      }),
    );
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { root: rootState, child: childState },
      rowStatesById: {},
    });

    await act(async () => {
      root.render(<DetailDataHarness activeExecutionId="root" enabled />);
      await flushAsyncWork();
    });

    expect(getPipelineDetailLeaseCount('root')).toBe(1);
    expect(usePipelineRunsStore.getState().statesById.root).toBe(rootState);
    expect(getExecution).not.toHaveBeenCalledWith('root');

    await act(async () => {
      root.render(<DetailDataHarness activeExecutionId="child" enabled />);
      await flushAsyncWork();
    });

    expect(getPipelineDetailLeaseCount('root')).toBe(1);
    expect(usePipelineRunsStore.getState().statesById.root).toBe(rootState);
    expect(getExecution).not.toHaveBeenCalledWith('root');

    await act(async () => {
      root.render(<DetailDataHarness activeExecutionId="root" enabled />);
      await flushAsyncWork();
    });

    expect(getPipelineDetailLeaseCount('root')).toBe(1);
    expect(usePipelineRunsStore.getState().statesById.root).toBe(rootState);
    expect(getExecution).not.toHaveBeenCalledWith('root');
  });

  function LogHarness({
    terminal,
    enabled,
    onLines,
  }: {
    terminal: boolean;
    enabled: boolean;
    onLines: (lines: string[]) => void;
  }): JSX.Element {
    const view = useStepLogInterest({
      identity: {
        executionId: 'execution-1',
        jobId: 'build',
        stepId: 'compile',
        attempt: 0,
      },
      terminal,
      enabled,
    });
    onLines(view.lines);
    return <></>;
  }

  it('the log hook buffers output from the commit that mounts it', async () => {
    // Step output arrives over IPC, which can run as soon as the commit
    // ends, before passive effects. A probe that commits after the hook
    // observes whether the bridge would buffer this execution's output.
    let bufferingAtCommit: boolean | null = null;
    function CommitProbe(): JSX.Element {
      useLayoutEffect(() => {
        bufferingAtCommit = hasStepLogInterestForExecution('execution-1');
      }, []);
      return <></>;
    }
    await act(async () => {
      root.render(
        <>
          <LogHarness
            terminal={false}
            enabled
            onLines={(): void => undefined}
          />
          <CommitProbe />
        </>,
      );
      await flushAsyncWork();
    });
    expect(bufferingAtCommit).toBe(true);
  });

  it('the log hook reads on mount, re-reads on a terminal change, and releases on unmount', async () => {
    const seen: string[][] = [];
    await act(async () => {
      root.render(
        <LogHarness
          terminal={false}
          enabled
          onLines={(lines) => seen.push(lines)}
        />,
      );
      await flushAsyncWork();
    });
    expect(readStepLog).toHaveBeenCalledTimes(1);
    expect(readStepLog).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'execution-1',
        stepId: 'compile',
      }),
      { format: 'text' },
    );
    expect(seen[seen.length - 1]).toEqual(['persisted']);

    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['persisted', 'final'] },
    });
    await act(async () => {
      root.render(
        <LogHarness terminal enabled onLines={(lines) => seen.push(lines)} />,
      );
      await flushAsyncWork();
    });
    expect(readStepLog).toHaveBeenCalledTimes(2);
    expect(seen[seen.length - 1]).toEqual(['persisted', 'final']);

    await act(async () => {
      root.render(
        <LogHarness
          terminal
          enabled={false}
          onLines={(lines) => seen.push(lines)}
        />,
      );
      await flushAsyncWork();
    });
    expect(getStepLogInterestCount()).toBe(0);
    expect(readStepLog).toHaveBeenCalledTimes(2);
  });
});
