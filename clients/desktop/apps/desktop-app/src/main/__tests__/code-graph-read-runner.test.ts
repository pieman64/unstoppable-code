import { EventEmitter } from 'node:events';

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn();
  public readonly kill = jest.fn(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

const recordTelemetry = jest.fn<void, [unknown]>();
const flushTelemetry = jest.fn<void, []>();
jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphReadDiagnostic: (): void => undefined,
  flushCodeGraphReadDiagnostics: (): void => undefined,
  recordCodeGraphQueryTelemetry: (input: unknown): void =>
    recordTelemetry(input),
  flushCodeGraphQueryTelemetry: (): void => flushTelemetry(),
}));

import {
  cancelCodeGraphReads,
  resetCodeGraphReadRunnerForTests,
  runCodeGraphWorkerRead,
  CodeGraphWorkerReadError,
  type CodeGraphWorkerReadRequest,
  type CodeGraphWorkerReadResult,
  type CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';

const REQUEST: CodeGraphWorkerReadRequest = {
  dbPath: '/private/graph.db',
  task: {
    kind: 'calls',
    calls: [{ method: 'file-summary', target: 'fixture.ts' }],
  },
};
const DETECT_CHANGED_TASK: CodeGraphWorkerReadTask = {
  kind: 'detect-changed',
  repoId: 'repo',
  rootPath: '/repo',
  baseRef: 'HEAD',
};
const DETECT_CHANGED_RESULT: CodeGraphWorkerReadResult = {
  kind: 'detect-changed',
  value: { changed: [], unmatchedFiles: [], lastBuildAt: null },
};

function start(
  key = 'workspace/worktree',
  task: CodeGraphWorkerReadTask = REQUEST.task,
): ReturnType<typeof runCodeGraphWorkerRead> {
  return runCodeGraphWorkerRead({
    key,
    kind: 'context',
    request: { dbPath: REQUEST.dbPath, task },
  });
}

describe('code-graph read runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetCodeGraphReadRunnerForTests();
    forkMock.mockReset();
    recordTelemetry.mockReset();
    flushTelemetry.mockReset();
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    const cancellations = new Set(
      ['workspace/worktree', 'one', 'two', 'three', 'four', 'five'].map((key) =>
        cancelCodeGraphReads(key),
      ),
    );
    for (const child of children) child.emit('exit', 0);
    await Promise.all(cancellations);
  });

  it('forks a read utility process and returns its typed response', async () => {
    const pending = start();

    expect(forkMock).toHaveBeenCalledWith(
      expect.stringContaining('code-graph-read-worker.js'),
      [],
      { serviceName: 'code-graph-read' },
    );
    expect(children[0]?.postMessage).toHaveBeenCalledWith(REQUEST);

    children[0]?.emit('message', {
      data: {
        ok: true,
        result: { kind: 'calls', value: [{ symbolCount: 42 }] },
      },
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      result: { kind: 'calls', value: [{ symbolCount: 42 }] },
    });
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'context', outcome: 'success' }),
    );
  });

  it('caps concurrent readers and starts the next queued request on settle', async () => {
    // Keep four live slots with three interactive calls and one warm comparison.
    const pending = [
      start('one'),
      start('two'),
      start('three', DETECT_CHANGED_TASK),
      start('four'),
      start('five'),
    ];
    for (const read of pending) read.catch(() => undefined);
    expect(children).toHaveLength(4);

    children[0]?.emit('message', {
      data: { ok: true, result: { kind: 'calls', value: [[]] } },
    });
    await pending[0];
    // The finished worker is evicted for the queued key; its replacement
    // starts once it has exited, so no more than four processes run.
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(4);
    children[0]?.emit('exit', 0);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(children).toHaveLength(5);

    for (let index = 1; index < children.length; index += 1) {
      const result: CodeGraphWorkerReadResult =
        index === 2 ? DETECT_CHANGED_RESULT : { kind: 'calls', value: [[]] };
      children[index]?.emit('message', {
        data: { ok: true, result },
      });
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(5);
  });

  it('kills and rejects active reads when their worktree is removed', async () => {
    const pending = start();
    const canceling = cancelCodeGraphReads('workspace/worktree');

    await expect(pending).rejects.toMatchObject<CodeGraphWorkerReadError>(
      new CodeGraphWorkerReadError('canceled', 'Code-graph read canceled.'),
    );
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    children[0]?.emit('exit', 0);
    await expect(canceling).resolves.toBeUndefined();
    expect(recordTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'canceled' }),
    );
  });

  it('rejects malformed worker responses and terminates that worker', async () => {
    const pending = start();
    children[0]?.emit('message', { data: { unexpected: true } });

    await expect(pending).rejects.toMatchObject({
      reason: 'malformed-response',
    });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('kills a read that exceeds its watchdog instead of hanging the tool', async () => {
    jest.useFakeTimers();
    try {
      const pending = start();
      jest.advanceTimersByTime(30_000);

      await expect(pending).rejects.toMatchObject({ reason: 'timeout' });
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      expect(recordTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timeout' }),
      );
      children[0]?.emit('exit', 0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records queued cancel telemetry once and clears timers', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const comparison = runCodeGraphWorkerRead({
        key: 'three',
        kind: 'context',
        request: {
          dbPath: REQUEST.dbPath,
          task: {
            kind: 'change-impact',
            repoId: 'repo',
            rootPath: '/repo',
            baseRef: 'HEAD',
            resourcesDir: '/resources',
          },
        },
      });
      const maintenance = runCodeGraphWorkerRead({
        key: 'four',
        kind: 'context',
        request: {
          dbPath: REQUEST.dbPath,
          task: { kind: 'persist-fingerprint', fingerprint: 'fingerprint' },
        },
      });
      const busy = [start('one'), start('two'), comparison, maintenance];
      for (const pending of busy) void pending.catch(() => undefined);
      const queued = start('five');
      void queued.catch(() => undefined);
      expect(children).toHaveLength(4);

      const cancelQueued = cancelCodeGraphReads('five');
      await expect(queued).rejects.toMatchObject({ reason: 'canceled' });
      await cancelQueued;
      expect(recordTelemetry).toHaveBeenCalledTimes(1);
      expect(recordTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'context', outcome: 'canceled' }),
      );

      const cancellations = ['one', 'two', 'three', 'four'].map((key) =>
        cancelCodeGraphReads(key),
      );
      for (const child of children) child.emit('exit', 0);
      await Promise.all(cancellations);
      await Promise.allSettled(busy);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

      expect(recordTelemetry).toHaveBeenCalledTimes(5);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles cancellation once despite duplicate late responses and clears timers', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      const pending = start();
      const canceling = cancelCodeGraphReads('workspace/worktree');
      await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
      expect(recordTelemetry).toHaveBeenCalledTimes(1);
      expect(recordTelemetry).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'context', outcome: 'canceled' }),
      );

      const lateResponse = {
        data: { ok: true, result: { kind: 'calls', value: [[]] } },
      };
      children[0]?.emit('message', lateResponse);
      children[0]?.emit('message', lateResponse);
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      expect(recordTelemetry).toHaveBeenCalledTimes(1);

      children[0]?.emit('exit', 0);
      await canceling;
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(recordTelemetry).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
