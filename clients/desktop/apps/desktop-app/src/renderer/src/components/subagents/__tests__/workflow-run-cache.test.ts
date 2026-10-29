/** @jest-environment jsdom */

import type {
  ActivityReadWorkflowRunRequest,
  BackgroundProcess,
  WorkflowRunState,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import {
  acquireWorkflowRun,
  getWorkflowRunCacheVersion,
  getWorkflowRunEntry,
  resetWorkflowRunCacheForTests,
  subscribeWorkflowRunCache,
  WORKFLOW_RUN_POLL_INTERVAL_MS,
} from '../workflow-run-cache';
import type {
  WorkflowRunCacheEntry,
  WorkflowRunCacheTarget,
} from '../workflow-run-cache';

const NOW = 1_800_000_000_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = (): void => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function runState(
  runId: string,
  status = 'running',
  lastActivityAt = NOW,
): WorkflowRunState {
  return {
    runId,
    status,
    phases: [],
    agents: [],
    lastActivityAt,
  };
}

function target(runId: string): WorkflowRunCacheTarget {
  return {
    runId,
    transcriptDir: `/private/session/workflows/${runId}`,
    taskId: `task-${runId}`,
    toolUseId: `tool-${runId}`,
  };
}

function backgroundProcess(runId: string): BackgroundProcess {
  return {
    id: `process-${runId}`,
    chatId: 'chat-1',
    toolUseId: `tool-${runId}`,
    taskId: `task-${runId}`,
    runId,
    toolName: 'Workflow',
    kind: 'workflow',
    description: `Workflow ${runId}`,
    status: 'running',
    startedAt: NOW - 1_000,
    updatedAt: NOW,
    outputLines: [],
    canStop: false,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(milliseconds);
  await flushPromises();
}

type ReadWorkflowRun = (
  request: ActivityReadWorkflowRunRequest,
) => Promise<WorkflowRunState | null>;

let readWorkflowRun: jest.MockedFunction<ReadWorkflowRun>;

function installApi(read: jest.MockedFunction<ReadWorkflowRun>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { activity: { readWorkflowRun: read } },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetWorkflowRunCacheForTests();
  useActivityStore.setState({ bgProcesses: {} });
  readWorkflowRun = jest.fn(
    (): Promise<WorkflowRunState | null> => Promise.resolve(null),
  );
  installApi(readWorkflowRun);
});

afterEach(() => {
  resetWorkflowRunCacheForTests();
  useActivityStore.setState({ bgProcesses: {} });
  jest.useRealTimers();
});

describe('workflow run cache', () => {
  it('reads a finished run once and does not re-read it after release', async () => {
    const runTarget = target('finished');
    readWorkflowRun.mockResolvedValue(runState('finished', 'completed'));

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();
    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS * 8);

    expect(readWorkflowRun).toHaveBeenCalledTimes(1);
    expect(getWorkflowRunEntry(runTarget).status).toBe('completed');
    release();

    const releaseAgain = acquireWorkflowRun(runTarget);
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(1);
    releaseAgain();
  });

  it('polls a running run while acquired and stops polling after release', async () => {
    const runTarget = target('running');
    readWorkflowRun.mockResolvedValue(runState('running'));

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(1);

    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);

    release();
    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS * 3);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it('stops polling when activity is stale and resumes when a live process appears', async () => {
    const runTarget = target('activity');
    readWorkflowRun.mockResolvedValue(
      runState('activity', 'running', NOW - 31 * 60_000),
    );
    useActivityStore.setState({
      bgProcesses: { 'worktree-1': [backgroundProcess('activity')] },
    });

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();
    expect(getWorkflowRunEntry(runTarget).status).toBe('running');
    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);

    useActivityStore.setState({ bgProcesses: {} });
    expect(getWorkflowRunEntry(runTarget).status).toBe('interrupted');
    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS * 3);
    expect(readWorkflowRun).toHaveBeenCalledTimes(2);

    useActivityStore.setState({
      bgProcesses: { 'worktree-1': [backgroundProcess('activity')] },
    });
    expect(getWorkflowRunEntry(runTarget).status).toBe('running');
    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS);
    expect(readWorkflowRun).toHaveBeenCalledTimes(3);
    release();
  });

  it('limits reads to two in flight and starts queued runs in FIFO order', async () => {
    const pending = [
      deferred<WorkflowRunState | null>(),
      deferred<WorkflowRunState | null>(),
      deferred<WorkflowRunState | null>(),
      deferred<WorkflowRunState | null>(),
    ];
    let nextRead = 0;
    readWorkflowRun.mockImplementation(() => {
      const current = pending[nextRead];
      nextRead += 1;
      return current?.promise ?? Promise.resolve(null);
    });
    const releases = ['one', 'two', 'three', 'four'].map((runId) =>
      acquireWorkflowRun(target(runId)),
    );

    expect(readWorkflowRun).toHaveBeenCalledTimes(2);
    pending[0]?.resolve(runState('one', 'completed'));
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(3);
    expect(readWorkflowRun.mock.calls[2]?.[0].runId).toBe('three');

    pending[1]?.resolve(runState('two', 'completed'));
    await flushPromises();
    expect(readWorkflowRun).toHaveBeenCalledTimes(4);
    expect(readWorkflowRun.mock.calls[3]?.[0].runId).toBe('four');

    pending[2]?.resolve(runState('three', 'completed'));
    pending[3]?.resolve(runState('four', 'completed'));
    await flushPromises();
    releases.forEach((release) => release());
  });

  it('keeps the same entry reference and does not publish identical reads', async () => {
    const runTarget = target('stable');
    readWorkflowRun.mockResolvedValue(runState('stable'));
    let publishCount = 0;
    const unsubscribe = subscribeWorkflowRunCache((): void => {
      publishCount += 1;
    });

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();
    const first = getWorkflowRunEntry(runTarget);
    const version = getWorkflowRunCacheVersion();
    expect(publishCount).toBe(1);

    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS);

    expect(getWorkflowRunEntry(runTarget)).toBe(first);
    expect(getWorkflowRunCacheVersion()).toBe(version);
    expect(publishCount).toBe(1);
    release();
    unsubscribe();
  });

  it('accepts null as a loaded result and retains prior state for a later null', async () => {
    const runTarget = target('transient-null');
    const firstState = runState('transient-null');
    readWorkflowRun
      .mockResolvedValueOnce(firstState)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();
    const firstEntry = getWorkflowRunEntry(runTarget);
    expect(firstEntry).toEqual({
      loaded: true,
      failed: false,
      state: firstState,
      status: 'running',
    });

    await advanceTimers(WORKFLOW_RUN_POLL_INTERVAL_MS);
    expect(getWorkflowRunEntry(runTarget)).toBe(firstEntry);

    release();
    const nullTarget = target('valid-null');
    const releaseNull = acquireWorkflowRun(nullTarget);
    await flushPromises();
    expect(getWorkflowRunEntry(nullTarget)).toEqual({
      loaded: true,
      failed: false,
      state: null,
      status: 'interrupted',
    });
    releaseNull();
  });

  it('publishes a finished run with its terminal status and no running placeholder', async () => {
    const runTarget = target('terminal-first');
    readWorkflowRun.mockResolvedValue(runState('terminal-first', 'completed'));
    const publishedStatuses: WorkflowRunCacheEntry['status'][] = [];
    const unsubscribe = subscribeWorkflowRunCache((): void => {
      publishedStatuses.push(getWorkflowRunEntry(runTarget).status);
    });

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();

    expect(publishedStatuses).toEqual(['completed']);
    release();
    unsubscribe();
  });

  it('marks a failed first read loaded and interrupted', async () => {
    const runTarget = target('failed-read');
    readWorkflowRun.mockRejectedValue(new Error('unreadable run'));

    const release = acquireWorkflowRun(runTarget);
    await flushPromises();

    expect(getWorkflowRunEntry(runTarget)).toEqual({
      loaded: true,
      failed: true,
      state: null,
      status: 'interrupted',
    });
    release();
  });

  it('does not read or subscribe to activity while no run is acquired', () => {
    const subscribe = jest.spyOn(useActivityStore, 'subscribe');

    expect(readWorkflowRun).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    subscribe.mockRestore();
  });
});
