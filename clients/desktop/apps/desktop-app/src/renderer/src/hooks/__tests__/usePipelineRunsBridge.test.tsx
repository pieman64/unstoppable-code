/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineAdvisorEvent,
  PipelineQueueEvent,
  StepOutputEvent,
} from '@canopy/desktop-shared/types/pipeline';
import {
  installPipelineRunsBridge,
  usePipelineRunsBridge,
} from '../usePipelineRunsBridge';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  acquireStepLogInterest,
  getStepLogView,
  resetStepLogStoreForTests,
} from '@/stores/pipelineStepLogStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    version: 1,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline 1', jobs: {}, env: {}, inputs: {} },
    status: 'running',
    jobs: {},
    job_definitions: {},
    job_groups: {},
    started_at: '2026-03-27T12:00:00.000Z',
    cwd: '/workspace',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: 'project-1',
    worktree_id: 'wt-1',
    ...overrides,
  };
}

function outputEvent(
  data: string,
  executionId = 'execution-1',
): StepOutputEvent {
  return {
    executionId,
    jobId: 'build',
    jobName: 'Build',
    stepId: 'compile',
    stepName: 'Compile',
    attempt: 0,
    stream: 'stdout',
    data,
  };
}

let executionListeners: Array<(event: ExecutionEvent) => void> = [];
let outputListeners: Array<(event: StepOutputEvent) => void> = [];
let queueListeners: Array<(event: PipelineQueueEvent) => void> = [];
let advisorListeners: Array<(event: PipelineAdvisorEvent) => void> = [];
let frames: Array<() => void> = [];

function listen<T>(
  getList: () => Array<(event: T) => void>,
  setList: (next: Array<(event: T) => void>) => void,
): jest.Mock {
  return jest.fn((listener: (event: T) => void) => {
    setList([...getList(), listener]);
    return (): void => {
      setList(getList().filter((entry) => entry !== listener));
    };
  });
}

const onExecutionEvent = listen(
  () => executionListeners,
  (next) => {
    executionListeners = next;
  },
);
const onStepOutput = listen(
  () => outputListeners,
  (next) => {
    outputListeners = next;
  },
);
const onQueueEvent = listen(
  () => queueListeners,
  (next) => {
    queueListeners = next;
  },
);
const onAdvisorEvent = listen(
  () => advisorListeners,
  (next) => {
    advisorListeners = next;
  },
);
const getWorktreePath = jest.fn();
const readStepLog = jest.fn();

function emitExecution(event: ExecutionEvent): void {
  for (const listener of executionListeners) listener(event);
}

function emitOutput(event: StepOutputEvent): void {
  for (const listener of outputListeners) listener(event);
}

function runFrames(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

describe('usePipelineRunsBridge', () => {
  let container: HTMLDivElement;
  let root: Root;
  const releases: Array<() => void> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    executionListeners = [];
    outputListeners = [];
    queueListeners = [];
    advisorListeners = [];
    frames = [];
    resetStepLogStoreForTests();
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        onExecutionEvent,
        onStepOutput,
        onQueueEvent,
        onAdvisorEvent,
        readStepLog,
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getWorktreePath },
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: jest.fn((callback: () => void) => {
        frames.push(callback);
        return frames.length;
      }),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: jest.fn(),
    });
    getWorktreePath.mockResolvedValue('/workspace');
    readStepLog.mockResolvedValue({ success: true, data: { lines: [] } });
    useChatStore.setState({ selectedWorktree: null });
    usePipelineRunsStore.setState({
      currentCwd: null,
      currentProjectId: null,
      currentWorktreeId: null,
      summaries: [],
      statesById: {},
      loadExecutions: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn(),
      trackGlobalExecutionEvent: jest.fn(),
      handleExecutionEvent: jest.fn(),
      handleQueueEvent: jest.fn(),
      handleAdvisorEvent: jest.fn(),
    });
    useActivityStore.setState({ loadTrackedPlans: jest.fn() });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    while (releases.length > 0) releases.pop()?.();
  });

  function Harness({
    trackGlobalStatus = true,
  }: {
    trackGlobalStatus?: boolean;
  }): JSX.Element {
    usePipelineRunsBridge({ trackGlobalStatus });
    return <></>;
  }

  it('installs one set of listeners however many owners mount it', () => {
    act(() => {
      root.render(
        <>
          <Harness />
          <Harness />
        </>,
      );
    });
    releases.push(installPipelineRunsBridge({ trackGlobalStatus: true }));

    expect(onExecutionEvent).toHaveBeenCalledTimes(1);
    expect(onStepOutput).toHaveBeenCalledTimes(1);
    expect(onQueueEvent).toHaveBeenCalledTimes(1);
    expect(onAdvisorEvent).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<></>);
    });
    expect(executionListeners).toHaveLength(1);
    expect(outputListeners).toHaveLength(1);
    releases.pop()?.();
    expect(executionListeners).toHaveLength(0);
    expect(outputListeners).toHaveLength(0);
  });

  it('processes each execution event exactly once', () => {
    act(() => {
      root.render(
        <>
          <Harness />
          <Harness />
        </>,
      );
    });
    const event: ExecutionEvent = {
      type: 'execution.updated',
      executionId: 'execution-1',
      state: createState(),
      timestamp: '2026-03-27T12:01:00.000Z',
    };

    emitExecution(event);

    const store = usePipelineRunsStore.getState();
    expect(store.trackGlobalExecutionEvent).toHaveBeenCalledTimes(1);
    expect(store.trackGlobalExecutionEvent).toHaveBeenCalledWith(event);
    expect(store.handleExecutionEvent).not.toHaveBeenCalled();
  });

  it('keeps global status tracking out of a renderer that does not own it', () => {
    act(() => {
      root.render(<Harness trackGlobalStatus={false} />);
    });

    emitExecution({
      type: 'execution.updated',
      executionId: 'execution-1',
      state: createState(),
      timestamp: '2026-03-27T12:01:00.000Z',
    });

    const store = usePipelineRunsStore.getState();
    expect(store.handleExecutionEvent).toHaveBeenCalledTimes(1);
    expect(store.trackGlobalExecutionEvent).not.toHaveBeenCalled();
  });

  it('drops step output nobody registered interest in', () => {
    act(() => {
      root.render(<Harness />);
    });

    emitOutput(outputEvent('ignored\n'));

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('batches interested output per frame and flushes it before the next state', async () => {
    act(() => {
      root.render(<Harness />);
    });
    const interest = acquireStepLogInterest({
      identity: {
        executionId: 'execution-1',
        jobId: 'build',
        stepId: 'compile',
        attempt: 0,
      },
      terminal: false,
    });
    await flushAsyncWork();

    emitOutput(outputEvent('one\n'));
    emitOutput(outputEvent('two\n'));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(getStepLogView(interest.key).lines).toEqual([]);

    let linesWhenStateApplied: string[] | null = null;
    usePipelineRunsStore.setState({
      trackGlobalExecutionEvent: jest.fn(() => {
        linesWhenStateApplied = getStepLogView(interest.key).lines;
      }),
    });
    emitExecution({
      type: 'execution.completed',
      executionId: 'execution-1',
      state: createState({ status: 'success' }),
      timestamp: '2026-03-27T12:02:00.000Z',
    });

    // Output queued for the next frame was applied before the terminal state.
    expect(linesWhenStateApplied).toEqual(['one', 'two']);
    runFrames();
    expect(getStepLogView(interest.key).lines).toEqual(['one', 'two']);
    interest.release();
  });

  it('flushes on a timer when a hidden window throttles animation frames', async () => {
    jest.useFakeTimers();
    try {
      act(() => {
        root.render(<Harness />);
      });
      const interest = acquireStepLogInterest({
        identity: {
          executionId: 'execution-1',
          jobId: 'build',
          stepId: 'compile',
          attempt: 0,
        },
        terminal: false,
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      emitOutput(outputEvent('late frame\n'));
      act(() => {
        jest.advanceTimersByTime(300);
      });

      expect(getStepLogView(interest.key).lines).toEqual(['late frame']);
      interest.release();
    } finally {
      jest.useRealTimers();
    }
  });

  it('drives the run list from the selected Code worktree or Cowork Work Entry', async () => {
    act(() => {
      root.render(<Harness />);
    });
    const store = usePipelineRunsStore.getState();
    expect(store.clear).toHaveBeenCalledTimes(1);

    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
      });
      await flushAsyncWork();
    });
    expect(getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    expect(store.loadExecutions).toHaveBeenLastCalledWith({
      cwd: '/workspace',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    // Re-selecting the same scope does not reload the list.
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
      });
      await flushAsyncWork();
    });
    expect(store.loadExecutions).toHaveBeenCalledTimes(1);

    getWorktreePath.mockResolvedValue('/cowork/home');
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'cowork-1', worktreeId: 'entry-1' },
      });
      await flushAsyncWork();
    });
    expect(store.loadExecutions).toHaveBeenLastCalledWith({
      cwd: '/cowork/home',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
    });

    await act(async () => {
      useChatStore.setState({ selectedWorktree: null });
      await flushAsyncWork();
    });
    expect(store.clear).toHaveBeenCalledTimes(2);
  });

  it('ignores a list load for a selection that changed while resolving its path', async () => {
    let resolvePath: (path: string) => void = () => undefined;
    getWorktreePath.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolvePath = resolve;
      }),
    );
    act(() => {
      root.render(<Harness />);
    });
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-2' },
      });
      await flushAsyncWork();
      resolvePath('/stale');
      await flushAsyncWork();
    });

    const calls = jest.mocked(usePipelineRunsStore.getState().loadExecutions)
      .mock.calls;
    expect(calls).toEqual([
      [{ cwd: '/workspace', projectId: 'project-1', worktreeId: 'wt-2' }],
    ]);
  });

  it('refreshes tracked plans when a plan-linked run in the selected scope finishes', async () => {
    act(() => {
      root.render(<Harness />);
    });
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'wt-1' },
      });
      await flushAsyncWork();
    });

    emitExecution({
      type: 'execution.completed',
      executionId: 'execution-1',
      state: createState({ status: 'success', planId: 'plan-1' }),
      timestamp: '2026-03-27T12:02:00.000Z',
    });
    emitExecution({
      type: 'execution.completed',
      executionId: 'execution-2',
      state: createState({
        id: 'execution-2',
        status: 'success',
        planId: 'plan-2',
        worktree_id: 'wt-9',
      }),
      timestamp: '2026-03-27T12:02:00.000Z',
    });

    const loadTrackedPlans = useActivityStore.getState().loadTrackedPlans;
    expect(loadTrackedPlans).toHaveBeenCalledTimes(1);
    expect(loadTrackedPlans).toHaveBeenCalledWith('project-1', 'wt-1');
  });

  it('routes queue and advisor events to the store', () => {
    act(() => {
      root.render(<Harness />);
    });
    const queueEvent: PipelineQueueEvent = {
      type: 'cancelled',
      queueId: 'queue-1',
    };
    for (const listener of queueListeners) listener(queueEvent);
    const advisorEvent: PipelineAdvisorEvent = {
      executionId: 'execution-1',
      timestamp: '2026-03-27T12:02:00.000Z',
      snapshot: {
        version: 1,
        executionId: 'execution-1',
        executionDataDir: '/data/execution-1',
        stateFilePath: '/data/execution-1/pipeline-advisor.json',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        thinkingLevel: 'high',
        status: 'running',
        turnCount: 1,
        backoffIndex: 0,
        lastUpdatedAt: '2026-03-27T12:02:00.000Z',
        reports: [],
      },
    };
    for (const listener of advisorListeners) listener(advisorEvent);

    const store = usePipelineRunsStore.getState();
    expect(store.handleQueueEvent).toHaveBeenCalledWith(queueEvent);
    expect(store.handleAdvisorEvent).toHaveBeenCalledWith(advisorEvent);
  });
});
