import { EventEmitter } from 'node:events';

/**
 * A utility process that answers only when the test says so and exits only
 * when the test emits `exit`, so every lifecycle edge (idle, mid-request,
 * killed but not yet exited) is observable.
 */
class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn();
  /**
   * Like Electron's `UtilityProcess.kill()`: false (and nothing happens) until
   * the process has launched, because its pid is still unset.
   */
  public readonly kill = jest.fn((): boolean => this.spawned);
  public exited = false;

  public constructor(public spawned = true) {
    super();
  }

  /** Finishes a deferred launch, as Electron's 'spawn' event reports it. */
  public launch(): void {
    this.spawned = true;
    this.emit('spawn');
  }

  public answer(value: unknown[] = [[]]): void {
    this.emit('message', {
      data: { ok: true, result: { kind: 'calls', value } },
    });
  }

  /** Answers with any result kind (`answer()` only answers `calls`). */
  public answerWith(result: CodeGraphWorkerReadResult): void {
    this.emit('message', { data: { ok: true, result } });
  }

  public exit(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));

jest.mock('../lib/code-graph-telemetry', () => ({
  recordCodeGraphReadDiagnostic: (): void => undefined,
  flushCodeGraphReadDiagnostics: (): void => undefined,
  recordCodeGraphQueryTelemetry: (): void => undefined,
  flushCodeGraphQueryTelemetry: (): void => undefined,
}));

import {
  CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS,
  cancelCodeGraphReads,
  cancelCodeGraphReadsForWorkspace,
  fenceCodeGraphReads,
  fenceCodeGraphReadsForWorkspace,
  resetCodeGraphReadRunnerForTests,
  runCodeGraphWorkerRead,
  shutdownCodeGraphReadWorkers,
  type CodeGraphWorkerReadRequest,
  type CodeGraphWorkerReadResult,
  type CodeGraphWorkerReadTask,
} from '../code-graph/read-runner';

const STRUCTURAL: CodeGraphWorkerReadTask = {
  kind: 'calls',
  calls: [{ method: 'file-summary', target: 'fixture.ts' }],
};

const PERSIST_FINGERPRINT: CodeGraphWorkerReadTask = {
  kind: 'persist-fingerprint',
  fingerprint: 'fingerprint',
};
const PERSISTED: CodeGraphWorkerReadResult = { kind: 'persist-fingerprint' };
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

/**
 * Requests a warm worker gains nothing for, with their answers: bookkeeping
 * from builds and scheduling, and the UI summary, which opens its own
 * connection.
 */
const COLD: ReadonlyArray<
  [string, CodeGraphWorkerReadTask, CodeGraphWorkerReadResult]
> = [
  ['persist-fingerprint', PERSIST_FINGERPRINT, PERSISTED],
  [
    'validate-base',
    {
      kind: 'validate-base',
      identity: {
        repoId: 'repo',
        canonicalRepoRoot: '/repo',
        customLanguagesFingerprint: 'languages',
      },
      gitHead: null,
    },
    { kind: 'validate-base', value: true },
  ],
  [
    'fingerprint-metadata',
    { kind: 'fingerprint-metadata' },
    {
      kind: 'fingerprint-metadata',
      value: {
        fingerprint: null,
        schemaVersion: null,
        extractorVersion: null,
        completed: true,
      },
    },
  ],
  [
    'readonly-summary',
    { kind: 'readonly-summary' },
    { kind: 'readonly-summary', value: { state: 'missing' } },
  ],
];

/** Agent tool reads, which reuse the worker's kept connection. */
const TOOL_READS: ReadonlyArray<
  [string, CodeGraphWorkerReadTask, CodeGraphWorkerReadResult]
> = [
  ['calls', STRUCTURAL, { kind: 'calls', value: [[]] }],
  [
    'detect-changed',
    {
      kind: 'detect-changed',
      repoId: 'repo',
      rootPath: '/repo',
      baseRef: 'HEAD',
    },
    {
      kind: 'detect-changed',
      value: { changed: [], unmatchedFiles: [], lastBuildAt: null },
    },
  ],
];

function request(
  task: CodeGraphWorkerReadTask = STRUCTURAL,
): CodeGraphWorkerReadRequest {
  return { dbPath: '/private/graph.db', task };
}

function read(
  key = 'workspace/worktree',
  task: CodeGraphWorkerReadTask = STRUCTURAL,
): ReturnType<typeof runCodeGraphWorkerRead> {
  return runCodeGraphWorkerRead({
    key,
    kind: 'context',
    request: request(task),
  });
}

/** Three interactive reads plus a warm comparison reader fill the four slots. */
function mixedFourReads(
  keys: readonly [string, string, string, string],
): ReturnType<typeof runCodeGraphWorkerRead>[] {
  // `read()` keeps the `context` telemetry label; admission must use task.kind.
  return [
    read(keys[0]),
    read(keys[1]),
    read(keys[2]),
    read(keys[3], DETECT_CHANGED_TASK),
  ];
}

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

const KEYS = [
  'workspace/worktree',
  'one',
  'two',
  'three',
  'four',
  'five',
  'proj/wt-1',
  'proj/wt-2',
  'proj/base/repo',
  'project/wt-1',
];

describe('code-graph read worker pool', () => {
  const children: FakeUtilityProcess[] = [];

  async function warmFourMixed(
    keys: readonly [string, string, string, string],
  ): Promise<void> {
    const warmed = mixedFourReads(keys);
    children[0]?.answer();
    children[1]?.answer();
    children[2]?.answer();
    children[3]?.answerWith(DETECT_CHANGED_RESULT);
    await Promise.all(warmed);
  }

  beforeEach(() => {
    resetCodeGraphReadRunnerForTests();
    forkMock.mockReset();
    children.length = 0;
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    const cancellations = KEYS.map((key) => cancelCodeGraphReads(key));
    for (const child of children) child.exit();
    await Promise.all(cancellations);
  });

  it('answers the next request on the same warm worker instead of forking', async () => {
    const first = read();
    children[0]?.answer([{ symbolCount: 1 }]);
    await expect(first).resolves.toMatchObject({ ok: true });

    const second = read();
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(2);
    expect(children[0]?.kill).not.toHaveBeenCalled();
    children[0]?.answer([{ symbolCount: 2 }]);
    await expect(second).resolves.toEqual({
      ok: true,
      result: { kind: 'calls', value: [{ symbolCount: 2 }] },
    });
  });

  it('never posts a second request to a worker that has not answered the first', async () => {
    const first = read();
    const second = read();
    // The busy worker is not shared: the second request gets its own worker.
    expect(children).toHaveLength(2);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    expect(children[1]?.postMessage).toHaveBeenCalledTimes(1);
    children[1]?.answer();
    children[0]?.answer();
    await Promise.all([first, second]);

    const third = read();
    expect(children).toHaveLength(2);
    children[0]?.answer();
    children[1]?.answer();
    await expect(third).resolves.toMatchObject({ ok: true });
  });

  it('shuts an idle worker down after the idle timeout, then forks a fresh one', async () => {
    jest.useFakeTimers();
    const first = read();
    children[0]?.answer();
    await first;

    jest.advanceTimersByTime(CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS - 1);
    expect(children[0]?.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    children[0]?.exit();

    const second = read();
    expect(children).toHaveLength(2);
    children[1]?.answer();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('restarts the idle clock on every request', async () => {
    jest.useFakeTimers();
    const first = read();
    children[0]?.answer();
    await first;
    jest.advanceTimersByTime(CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS - 10);

    const second = read();
    // A busy worker is never reaped by the idle timer.
    jest.advanceTimersByTime(20);
    expect(children[0]?.kill).not.toHaveBeenCalled();
    children[0]?.answer();
    await second;
    jest.advanceTimersByTime(CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS - 1);
    expect(children[0]?.kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used idle worker when the pool is full', async () => {
    await warmFourMixed(['one', 'two', 'three', 'four']);
    // Touch 'one' so 'two' becomes the least recently used.
    const touched = read('one');
    children[0]?.answer();
    await touched;
    expect(children).toHaveLength(4);

    const fifth = read('five');
    // Settled by teardown if an assertion fails first.
    fifth.catch(() => undefined);
    expect(children[1]?.kill).toHaveBeenCalledTimes(1);
    for (const index of [0, 2, 3]) {
      expect(children[index]?.kill).not.toHaveBeenCalled();
    }
    // The evicted process still runs, so its replacement waits for it.
    await settleMicrotasks();
    expect(children).toHaveLength(4);
    children[1]?.exit();
    await settleMicrotasks();
    expect(children).toHaveLength(5);
    expect(children.filter((child) => !child.exited)).toHaveLength(4);
    children[4]?.answer();
    await expect(fifth).resolves.toMatchObject({ ok: true });
  });

  it('stops waiting for an evicted worker whose exit never arrives', async () => {
    jest.useFakeTimers();
    await warmFourMixed(['one', 'two', 'three', 'four']);

    const fifth = read('five');
    fifth.catch(() => undefined);
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(children).toHaveLength(4);
    // The exit wait gives up 2 s after the kill landed, as cleanup does.
    await jest.advanceTimersByTimeAsync(1);
    expect(children).toHaveLength(5);
    children[4]?.answer();
    await expect(fifth).resolves.toMatchObject({ ok: true });
  });

  it('runs no fifth process while a killed worker is still exiting', async () => {
    jest.useFakeTimers();
    const busy = mixedFourReads(['one', 'two', 'three', 'four']);
    for (const pending of busy) pending.catch(() => undefined);
    // Admit the waiter just before the unchanged 30 s execution watchdog,
    // so its independent 5 s queue deadline does not obscure held-slot reuse.
    await jest.advanceTimersByTimeAsync(29_999);
    const queued = read('five');
    for (const pending of [...busy, queued]) pending.catch(() => undefined);
    // The watchdog kills 'one', which does not exit at once.
    await jest.advanceTimersByTimeAsync(1);
    await expect(busy[0]).rejects.toMatchObject({ reason: 'timeout' });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(4);

    children[0]?.exit();
    await settleMicrotasks();
    expect(children).toHaveLength(5);
    children[4]?.answer();
    await expect(queued).resolves.toMatchObject({ ok: true });
    for (const index of [1, 2, 3]) children[index]?.answer();
    await Promise.allSettled(busy);
  });

  it('queues a request while four workers are busy, without evicting any', async () => {
    const busy = mixedFourReads(['one', 'two', 'three', 'four']);
    const queued = read('five');
    for (const pending of [...busy, queued]) pending.catch(() => undefined);
    expect(children).toHaveLength(4);
    for (const child of children) expect(child.kill).not.toHaveBeenCalled();

    children[2]?.answer();
    await busy[2];
    // The freed worker belongs to another key: it is evicted for the queued
    // request rather than leaving it waiting, and its replacement starts
    // once it has exited.
    expect(children[2]?.kill).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(4);
    children[2]?.exit();
    await settleMicrotasks();
    expect(children).toHaveLength(5);
    children[4]?.answer();
    await expect(queued).resolves.toMatchObject({ ok: true });
    for (const index of [0, 1]) children[index]?.answer();
    children[3]?.answerWith(DETECT_CHANGED_RESULT);
    await Promise.all(busy);
  });

  it('discards a worker that crashes mid-request and forks a fresh one next time', async () => {
    const first = read();
    children[0]?.exit(9);
    await expect(first).rejects.toMatchObject({ reason: 'worker-exit' });

    const second = read();
    expect(children).toHaveLength(2);
    children[1]?.answer();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('drops an idle worker that exits on its own and forks a fresh one next time', async () => {
    const first = read();
    children[0]?.answer();
    await first;
    children[0]?.exit(1);

    const second = read();
    expect(children).toHaveLength(2);
    children[1]?.answer();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('kills a hung worker at the watchdog and never reuses it', async () => {
    jest.useFakeTimers();
    const first = read();
    jest.advanceTimersByTime(30_000);
    await expect(first).rejects.toMatchObject({ reason: 'timeout' });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    // A late answer from the killed worker is ignored, and the next request
    // gets a fresh process even before the old one has exited.
    children[0]?.answer();
    const second = read();
    expect(children).toHaveLength(2);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    children[1]?.answer();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it('discards a worker that sends a message while idle', async () => {
    const first = read();
    children[0]?.answer();
    await first;
    children[0]?.answer();
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    const second = read();
    expect(children).toHaveLength(2);
    children[1]?.answer();
    await second;
  });

  it('retires the worker after change-impact so its parser memory is not kept idle', async () => {
    const impact = read('workspace/worktree', {
      kind: 'change-impact',
      repoId: 'repo',
      rootPath: '/repo',
      baseRef: 'HEAD',
      resourcesDir: '/resources',
    });
    children[0]?.emit('message', {
      data: {
        ok: true,
        result: {
          kind: 'change-impact',
          value: { report: {}, lastBuildAt: null },
        },
      },
    });
    await expect(impact).resolves.toMatchObject({ ok: true });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);

    const next = read();
    expect(children).toHaveLength(2);
    children[1]?.answer();
    await next;
  });

  describe('requests that keep no warm state', () => {
    it.each(COLD)(
      'retires a worker forked for %s after it answers',
      async (_kind, task, result) => {
        const maintenance = read('workspace/worktree', task);
        children[0]?.answerWith(result);
        await expect(maintenance).resolves.toEqual({ ok: true, result });
        // A warm process gains it nothing: it does not idle.
        expect(children[0]?.kill).toHaveBeenCalledTimes(1);

        const next = read();
        expect(children).toHaveLength(2);
        expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
        children[1]?.answer();
        await expect(next).resolves.toMatchObject({ ok: true });
      },
    );

    it.each(TOOL_READS)(
      'keeps a worker forked for %s warm after it answers',
      async (_kind, task, result) => {
        const first = read('workspace/worktree', task);
        children[0]?.answerWith(result);
        await expect(first).resolves.toEqual({ ok: true, result });
        expect(children[0]?.kill).not.toHaveBeenCalled();

        const next = read();
        expect(children).toHaveLength(1);
        children[0]?.answer();
        await expect(next).resolves.toMatchObject({ ok: true });
      },
    );

    it.each(COLD)(
      'keeps a worker that served a tool read warm through %s',
      async (_kind, task, result) => {
        const tool = read();
        children[0]?.answer();
        await tool;

        const maintenance = read('workspace/worktree', task);
        expect(children).toHaveLength(1);
        children[0]?.answerWith(result);
        await expect(maintenance).resolves.toEqual({ ok: true, result });
        expect(children[0]?.kill).not.toHaveBeenCalled();

        const next = read();
        expect(children).toHaveLength(1);
        expect(children[0]?.postMessage).toHaveBeenCalledTimes(3);
        children[0]?.answer([{ symbolCount: 3 }]);
        await expect(next).resolves.toEqual({
          ok: true,
          result: { kind: 'calls', value: [{ symbolCount: 3 }] },
        });
      },
    );

    it('keeps the strict cap when a maintenance request evicts an idle worker', async () => {
      await warmFourMixed(['one', 'two', 'three', 'four']);

      const persist = read('five', PERSIST_FINGERPRINT);
      persist.catch(() => undefined);
      // The least recently used tool reader makes room, as for any read.
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      await settleMicrotasks();
      expect(children).toHaveLength(4);
      children[0]?.exit();
      await settleMicrotasks();
      expect(children).toHaveLength(5);
      expect(children.filter((child) => !child.exited)).toHaveLength(4);

      children[4]?.answerWith(PERSISTED);
      await expect(persist).resolves.toEqual({ ok: true, result: PERSISTED });
      // The write's own worker retires instead of idling in the pool...
      expect(children[4]?.kill).toHaveBeenCalledTimes(1);
      for (const index of [1, 2, 3]) {
        expect(children[index]?.kill).not.toHaveBeenCalled();
      }

      // ...and keeps its slot until it has exited.
      const next = read('one');
      next.catch(() => undefined);
      expect(children[1]?.kill).not.toHaveBeenCalled();
      await settleMicrotasks();
      expect(children).toHaveLength(5);
      children[4]?.exit();
      await settleMicrotasks();
      expect(children).toHaveLength(6);
      expect(children.filter((child) => !child.exited)).toHaveLength(4);
      children[5]?.answer();
      await expect(next).resolves.toMatchObject({ ok: true });
    });
  });

  describe('worktree removal', () => {
    it('kills and awaits a worker that is mid-request', async () => {
      const pending = read();
      const canceling = cancelCodeGraphReads('workspace/worktree');
      await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);

      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[0]?.exit();
      await canceling;
    });

    it('kills and awaits an idle worker', async () => {
      const first = read();
      children[0]?.answer();
      await first;

      const canceling = cancelCodeGraphReads('workspace/worktree');
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[0]?.exit();
      await canceling;
    });

    it('awaits a worker that is mid-shutdown after its idle timeout', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      const first = read();
      children[0]?.answer();
      await first;
      jest.advanceTimersByTime(CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS);
      // Killed by the idle timer; the process has not exited yet.
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);

      const canceling = cancelCodeGraphReads('workspace/worktree');
      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[0]?.exit();
      await canceling;
      expect(settled).toBe(true);
    });

    it('awaits a worker that is mid-shutdown after LRU eviction', async () => {
      await warmFourMixed(['workspace/worktree', 'two', 'three', 'four']);
      const evicting = read('five');
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);

      const canceling = cancelCodeGraphReads('workspace/worktree');
      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[0]?.exit();
      await canceling;
      children[4]?.answer();
      await evicting;
    });

    it('leaves other worktrees warm', async () => {
      const mine = read('workspace/worktree');
      const other = read('one');
      children[0]?.answer();
      children[1]?.answer();
      await Promise.all([mine, other]);

      const canceling = cancelCodeGraphReads('workspace/worktree');
      children[0]?.exit();
      await canceling;
      expect(children[1]?.kill).not.toHaveBeenCalled();
    });

    it('kills again once a worker killed before its launch has launched, and awaits its exit', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      forkMock.mockImplementation(() => {
        const child = new FakeUtilityProcess(false);
        children.push(child);
        return child;
      });
      const pending = read();
      void pending.catch(() => undefined);
      const release = fenceCodeGraphReads('workspace/worktree');
      const canceling = cancelCodeGraphReads('workspace/worktree');
      await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
      // Electron refuses the kill: the process has no pid yet.
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      expect(children[0]?.kill).toHaveLastReturnedWith(false);

      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      // The 2 s exit fallback must not count from a kill that did nothing.
      jest.advanceTimersByTime(2_500);
      await settleMicrotasks();
      expect(settled).toBe(false);

      // It launches and would now read the queued request: it is killed.
      children[0]?.launch();
      expect(children[0]?.kill).toHaveBeenCalledTimes(2);
      expect(children[0]?.kill).toHaveLastReturnedWith(true);
      // A late answer neither revives it nor skips the kill.
      children[0]?.answer();
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[0]?.exit();
      await canceling;
      expect(settled).toBe(true);
      release();
    });

    it('gives a worker that launches late its full exit wait after the kill lands', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      forkMock.mockImplementation(() => {
        const child = new FakeUtilityProcess(false);
        children.push(child);
        return child;
      });
      const pending = read();
      void pending.catch(() => undefined);
      const release = fenceCodeGraphReads('workspace/worktree');
      const canceling = cancelCodeGraphReads('workspace/worktree');
      await expect(pending).rejects.toMatchObject({ reason: 'canceled' });
      let settled = false;
      void canceling.then(() => {
        settled = true;
      });

      // It launches just before the 10 s launch bound, so the kill lands then.
      jest.advanceTimersByTime(9_900);
      children[0]?.launch();
      expect(children[0]?.kill).toHaveLastReturnedWith(true);
      await settleMicrotasks();
      // The launch bound passing must not cut the 2 s exit wait short.
      jest.advanceTimersByTime(1_000);
      await settleMicrotasks();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1_000);
      await settleMicrotasks();
      expect(settled).toBe(true);
      release();
    });

    it('kills on launch a worker whose request could not be posted', async () => {
      forkMock.mockImplementation(() => {
        const child = new FakeUtilityProcess(false);
        child.postMessage.mockImplementation(() => {
          throw new Error('port closed');
        });
        children.push(child);
        return child;
      });
      await expect(read()).rejects.toMatchObject({ reason: 'post-failed' });
      expect(children[0]?.kill).toHaveLastReturnedWith(false);
      children[0]?.launch();
      expect(children[0]?.kill).toHaveBeenCalledTimes(2);
      expect(children[0]?.kill).toHaveLastReturnedWith(true);
    });

    it('kills and awaits every reader of a project being deleted, and fences the project', async () => {
      const warmed = [
        read('proj/wt-1'),
        read('proj/base/repo'),
        read('project/wt-1', DETECT_CHANGED_TASK),
      ];
      children[0]?.answer();
      children[1]?.answer();
      children[2]?.answerWith(DETECT_CHANGED_RESULT);
      await Promise.all(warmed);
      const busy = read('proj/wt-2');
      void busy.catch(() => undefined);
      expect(children).toHaveLength(4);

      const release = fenceCodeGraphReadsForWorkspace('proj');
      const canceling = cancelCodeGraphReadsForWorkspace('proj');
      await expect(busy).rejects.toMatchObject({ reason: 'canceled' });
      for (const index of [0, 1, 3]) {
        expect(children[index]?.kill).toHaveBeenCalledTimes(1);
      }
      // A project whose id merely starts with the same letters is untouched.
      expect(children[2]?.kill).not.toHaveBeenCalled();
      await expect(read('proj/wt-3')).rejects.toMatchObject({
        reason: 'canceled',
      });
      expect(forkMock).toHaveBeenCalledTimes(4);

      let settled = false;
      void canceling.then(() => {
        settled = true;
      });
      children[0]?.exit();
      children[1]?.exit();
      await settleMicrotasks();
      expect(settled).toBe(false);
      children[3]?.exit();
      await canceling;
      expect(settled).toBe(true);

      release();
      const after = read('proj/wt-1');
      expect(forkMock).toHaveBeenCalledTimes(5);
      children[4]?.answer();
      await expect(after).resolves.toMatchObject({ ok: true });
    });

    it('starts no worker for a fenced worktree until the fence is released', async () => {
      const release = fenceCodeGraphReads('workspace/worktree');
      await expect(read()).rejects.toMatchObject({ reason: 'canceled' });
      expect(forkMock).not.toHaveBeenCalled();
      // Other worktrees are unaffected.
      const other = read('one');
      expect(forkMock).toHaveBeenCalledTimes(1);
      children[0]?.answer();
      await other;

      release();
      const after = read();
      expect(forkMock).toHaveBeenCalledTimes(2);
      children[1]?.answer();
      await expect(after).resolves.toMatchObject({ ok: true });
    });

    it('starts no worker for a request queued before its worktree was fenced', async () => {
      const busy = mixedFourReads(['one', 'two', 'three', 'four']);
      // A failed assertion leaves these to afterEach's cancel.
      void Promise.allSettled(busy);
      const queued = read().then(
        () => 'answered',
        (error: unknown) => error,
      );
      expect(children).toHaveLength(4);
      const release = fenceCodeGraphReads('workspace/worktree');

      // A slot frees up while the removal holds the fence.
      children[0]?.answer();
      await busy[0];
      expect(forkMock).toHaveBeenCalledTimes(4);
      children[4]?.answer();
      await expect(queued).resolves.toMatchObject({ reason: 'canceled' });

      release();
      for (const index of [1, 2]) children[index]?.answer();
      children[3]?.answerWith(DETECT_CHANGED_RESULT);
      await Promise.all(busy);
    });

    it('keeps a worktree fenced until every overlapping fence is released', async () => {
      const releaseFirst = fenceCodeGraphReads('workspace/worktree');
      const releaseSecond = fenceCodeGraphReads('workspace/worktree');
      releaseFirst();
      releaseFirst();
      await expect(read()).rejects.toMatchObject({ reason: 'canceled' });
      releaseSecond();
      const after = read();
      children[0]?.answer();
      await expect(after).resolves.toMatchObject({ ok: true });
    });
  });

  it('kills idle workers too on app shutdown and awaits their exit', async () => {
    const first = read();
    children[0]?.answer();
    await first;

    const shutdown = shutdownCodeGraphReadWorkers();
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await settleMicrotasks();
    expect(settled).toBe(false);
    children[0]?.exit();
    await shutdown;
    await expect(read()).rejects.toMatchObject({ reason: 'canceled' });
  });

  describe('queue scheduling contracts', () => {
    const COMPARISON_TASK: CodeGraphWorkerReadTask = {
      kind: 'change-impact',
      repoId: 'repo',
      rootPath: '/repo',
      baseRef: 'HEAD',
      resourcesDir: '/resources',
    };
    const COMPARISON_RESULT: CodeGraphWorkerReadResult = {
      kind: 'change-impact',
      value: {
        report: {
          repoId: 'repo',
          baseRef: 'HEAD',
          changed: [],
          unmatchedFiles: [],
          delta: { added: [], removed: [], signatureChanged: [] },
          risk: { score: 0, level: 'low', reasons: [], formula: '' },
          impacted: [],
          impactTruncated: false,
          impactSeedsTruncated: false,
          impactedTests: [],
          impactedTestsTruncated: false,
          beforeGraph: { filesBuilt: 0, filesSkipped: 0 },
          reviewContext: {
            changedSymbols: [],
            impactedFiles: [],
            impactedFilesTruncated: false,
            testGaps: [],
            testGapsTruncated: false,
            reviewPriorities: [],
            reviewPrioritiesTruncated: false,
          },
        },
        lastBuildAt: null,
      },
    };

    // The shared read() helper labels every request as `context`; scheduling
    // must use the nested task kind, not that telemetry label.
    function answerChangeImpact(child: FakeUtilityProcess): void {
      child.answerWith(COMPARISON_RESULT);
    }

    type AgedReadKind = 'comparison' | 'maintenance';
    const AGED_CANDIDATES: Record<
      AgedReadKind,
      {
        key: string;
        task: CodeGraphWorkerReadTask;
        result: CodeGraphWorkerReadResult;
      }
    > = {
      comparison: {
        key: 'five',
        task: COMPARISON_TASK,
        result: COMPARISON_RESULT,
      },
      maintenance: {
        key: 'proj/wt-1',
        task: PERSIST_FINGERPRINT,
        result: PERSISTED,
      },
    };
    const AGED_ADMISSION_CASES: ReadonlyArray<{
      description: string;
      oldest: AgedReadKind;
    }> = [
      { description: 'comparison admitted first', oldest: 'comparison' },
      { description: 'maintenance admitted first', oldest: 'maintenance' },
    ];

    it('skips an ineligible cold head for a warm same-key reader', async () => {
      const interactive = ['one', 'two', 'three'].map((key) => read(key));
      const retiringMaintenance = read('four', PERSIST_FINGERPRINT);
      for (const pending of [...interactive, retiringMaintenance]) {
        void pending.catch(() => undefined);
      }
      expect(children).toHaveLength(4);

      // Three interactive owners and a cold maintenance owner fill the
      // 3-interactive + 1-maintenance mix. The cold worker retires but holds
      // its global slot until its process exits.
      children[3]?.answerWith(PERSISTED);
      await retiringMaintenance;
      expect(children[3]?.kill).toHaveBeenCalledTimes(1);
      expect(children[3]?.exited).toBe(false);
      expect(children.filter((child) => !child.exited)).toHaveLength(4);

      const waitingMaintenance = read('five', PERSIST_FINGERPRINT);
      const warmProbe = read('one');
      void waitingMaintenance.catch(() => undefined);
      void warmProbe.catch(() => undefined);

      // The old maintenance child still holds the fourth slot. Freeing the
      // first interactive reader makes its warm same-key worker eligible,
      // even though the maintenance request remains at the queue head.
      children[0]?.answer([{ symbolCount: 1 }]);
      await interactive[0];
      expect(children).toHaveLength(4);
      expect(children[3]?.exited).toBe(false);
      expect(children[0]?.postMessage).toHaveBeenCalledTimes(2);
      expect(children[3]?.postMessage).toHaveBeenCalledTimes(1);

      children[0]?.answer([{ symbolCount: 2 }]);
      await warmProbe;
      children[3]?.exit();
      await settleMicrotasks();
      expect(children).toHaveLength(5);
      expect(children[4]?.postMessage).toHaveBeenCalledTimes(1);
      children[4]?.answerWith(PERSISTED);
      await waitingMaintenance;
      children[4]?.exit();

      for (const index of [1, 2]) children[index]?.answer();
      await Promise.all(interactive.slice(1));
    });

    it('prefers eligible interactive work before maintenance reaches five seconds', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const comparison = read('three', COMPARISON_TASK);
        const activeMaintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [...interactive, comparison, activeMaintenance]) {
          void pending.catch(() => undefined);
        }
        expect(children).toHaveLength(4);

        const waitingMaintenance = read('five', PERSIST_FINGERPRINT);
        void waitingMaintenance.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(4_999);
        // Queue the interactive probe at the threshold, not at time zero, so
        // its five-second queue expiry cannot mask the priority boundary.
        const youngerInteractive = read('proj/wt-1');
        void youngerInteractive.catch(() => undefined);

        children[3]?.answerWith(PERSISTED);
        await activeMaintenance;
        children[3]?.exit();
        await settleMicrotasks();
        expect(children).toHaveLength(5);
        expect(children[4]?.postMessage).toHaveBeenCalledWith(
          request(STRUCTURAL),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('gives aged maintenance one five-second fairness turn', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const comparison = read('three', COMPARISON_TASK);
        const activeMaintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [...interactive, comparison, activeMaintenance]) {
          void pending.catch(() => undefined);
        }
        expect(children).toHaveLength(4);

        const agedMaintenance = read('five', PERSIST_FINGERPRINT);
        void agedMaintenance.catch(() => undefined);
        let agedMaintenanceSettled = false;
        void agedMaintenance.then(
          () => {
            agedMaintenanceSettled = true;
          },
          () => {
            agedMaintenanceSettled = true;
          },
        );

        await jest.advanceTimersByTimeAsync(4_500);
        // Interactive requests have a five-second expiry, so enqueue these
        // near the maintenance fairness milestone rather than at time zero.
        const youngerInteractive = read('proj/wt-1');
        void youngerInteractive.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(500);
        const nextMaintenance = read('four', PERSIST_FINGERPRINT);
        void nextMaintenance.catch(() => undefined);
        expect(agedMaintenanceSettled).toBe(false);
        expect(children[0]?.kill).not.toHaveBeenCalled();
        expect(children[1]?.kill).not.toHaveBeenCalled();
        expect(children[2]?.kill).not.toHaveBeenCalled();
        expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);

        // The active maintenance owner must finish and its retiring process
        // must exit before the aged request is eligible; aging never preempts.
        children[3]?.answerWith(PERSISTED);
        await activeMaintenance;
        expect(children[3]?.kill).toHaveBeenCalledTimes(1);
        expect(children).toHaveLength(4);
        children[3]?.exit();
        await settleMicrotasks();
        expect(children).toHaveLength(5);
        expect(children[4]?.postMessage).toHaveBeenCalledWith(
          request(PERSIST_FINGERPRINT),
        );

        children[4]?.answerWith(PERSISTED);
        await agedMaintenance;
        children[4]?.exit();
        await settleMicrotasks();
        // The maintenance request queued at the milestone has not earned
        // another aged turn; the earlier interactive request goes next.
        expect(children).toHaveLength(6);
        expect(children[5]?.postMessage).toHaveBeenCalledWith(
          request(STRUCTURAL),
        );
        expect(children[5]?.postMessage).not.toHaveBeenCalledWith(
          request(PERSIST_FINGERPRINT),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('prefers eligible interactive work before comparison reaches fifteen seconds', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const activeComparison = read('three', COMPARISON_TASK);
        const activeMaintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [
          ...interactive,
          activeComparison,
          activeMaintenance,
        ]) {
          void pending.catch(() => undefined);
        }
        expect(children).toHaveLength(4);

        const waitingComparison = read('five', COMPARISON_TASK);
        void waitingComparison.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(14_999);
        // Interactions are enqueued just before the comparison aging boundary,
        // safely inside their five-second queue expiry.
        const youngerInteractive = read('project/wt-1');
        const secondYoungerInteractive = read('proj/base/repo');
        void youngerInteractive.catch(() => undefined);
        void secondYoungerInteractive.catch(() => undefined);

        const activeComparisonWorker = children[2];
        if (activeComparisonWorker === undefined) {
          throw new Error('The active comparison worker was not created.');
        }
        answerChangeImpact(activeComparisonWorker);
        await activeComparison;
        activeComparisonWorker.exit();
        await settleMicrotasks();
        expect(children).toHaveLength(5);
        expect(children[4]?.postMessage).toHaveBeenCalledWith(
          request(STRUCTURAL),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('gives aged comparison one fifteen-second fairness turn', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const activeComparison = read('three', COMPARISON_TASK);
        const activeMaintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [
          ...interactive,
          activeComparison,
          activeMaintenance,
        ]) {
          void pending.catch(() => undefined);
        }
        expect(children).toHaveLength(4);

        const agedComparison = read('five', COMPARISON_TASK);
        void agedComparison.catch(() => undefined);
        let agedComparisonSettled = false;
        void agedComparison.then(
          () => {
            agedComparisonSettled = true;
          },
          () => {
            agedComparisonSettled = true;
          },
        );

        await jest.advanceTimersByTimeAsync(14_500);
        // These interactions have waited only half a second when the
        // comparison reaches its fifteen-second fairness milestone.
        const youngerInteractive = read('project/wt-1');
        const secondYoungerInteractive = read('proj/base/repo');
        void youngerInteractive.catch(() => undefined);
        void secondYoungerInteractive.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(500);
        const nextComparison = read('proj/wt-2', COMPARISON_TASK);
        void nextComparison.catch(() => undefined);
        expect(agedComparisonSettled).toBe(false);
        expect(children[0]?.kill).not.toHaveBeenCalled();
        expect(children[1]?.kill).not.toHaveBeenCalled();
        expect(children[3]?.kill).not.toHaveBeenCalled();
        expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);

        // The active comparison is not preempted at the fairness milestone;
        // it releases its class only after answering and exiting.
        const activeComparisonWorker = children[2];
        if (activeComparisonWorker === undefined) {
          throw new Error('The active comparison worker was not created.');
        }
        answerChangeImpact(activeComparisonWorker);
        await activeComparison;
        expect(children[2]?.kill).toHaveBeenCalledTimes(1);
        // Change-impact is retiring, but its live process still holds the
        // global slot until the exit event below.
        expect(children).toHaveLength(4);
        children[2]?.exit();
        await settleMicrotasks();
        expect(children).toHaveLength(5);
        expect(children[4]?.postMessage).toHaveBeenCalledWith(
          request(COMPARISON_TASK),
        );

        const agedComparisonWorker = children[4];
        if (agedComparisonWorker === undefined) {
          throw new Error('The aged comparison worker was not created.');
        }
        answerChangeImpact(agedComparisonWorker);
        await agedComparison;
        children[4]?.exit();
        await settleMicrotasks();
        // Queue expiry is thirty seconds, so the aged comparison and
        // half-second-old interactions are still live; a fresh comparison
        // cannot claim another aged turn ahead of the older interactions.
        expect(children).toHaveLength(6);
        expect(children[5]?.postMessage).toHaveBeenCalledWith(
          request(STRUCTURAL),
        );
        expect(children[5]?.postMessage).not.toHaveBeenCalledWith(
          request(COMPARISON_TASK),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it.each(AGED_ADMISSION_CASES)(
      'serves the oldest simultaneously aged comparison/maintenance request once, then prefers queued interactive work ($description)',
      async ({ oldest }) => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
        try {
          const interactive = [read('one'), read('two')];
          const activeComparison = read('three', COMPARISON_TASK);
          const activeMaintenance = read('four', PERSIST_FINGERPRINT);
          for (const pending of [
            ...interactive,
            activeComparison,
            activeMaintenance,
          ]) {
            void pending.catch(() => undefined);
          }
          expect(children).toHaveLength(4);

          const newerKind: AgedReadKind =
            oldest === 'comparison' ? 'maintenance' : 'comparison';
          const olderCandidate = AGED_CANDIDATES[oldest];
          const newerCandidate = AGED_CANDIDATES[newerKind];
          // `read()` uses the same `context` telemetry label for all tasks;
          // the queued task kind determines the admission class.
          const older = read(olderCandidate.key, olderCandidate.task);
          void older.catch(() => undefined);
          await jest.advanceTimersByTimeAsync(10_000);

          const newer = read(newerCandidate.key, newerCandidate.task);
          void newer.catch(() => undefined);
          const bothAgedAtMs = oldest === 'comparison' ? 15_000 : 25_000;
          await jest.advanceTimersByTimeAsync(bothAgedAtMs - 10_500);
          // Enqueue just 500 ms before eligibility, inside the 5 s queue TTL.
          const queuedInteractive = read('workspace/worktree');
          void queuedInteractive.catch(() => undefined);
          await jest.advanceTimersByTimeAsync(500);

          expect(children[0]?.kill).not.toHaveBeenCalled();
          expect(children[1]?.kill).not.toHaveBeenCalled();
          expect(children[2]?.kill).not.toHaveBeenCalled();
          expect(children[3]?.kill).not.toHaveBeenCalled();
          expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
          expect(children[1]?.postMessage).toHaveBeenCalledTimes(1);

          const activeComparisonWorker = children[2];
          const activeMaintenanceWorker = children[3];
          if (
            activeComparisonWorker === undefined ||
            activeMaintenanceWorker === undefined
          ) {
            throw new Error(
              'The active comparison/maintenance workers were not created.',
            );
          }
          answerChangeImpact(activeComparisonWorker);
          activeMaintenanceWorker.answerWith(PERSISTED);
          await Promise.all([activeComparison, activeMaintenance]);
          expect(activeComparisonWorker.kill).toHaveBeenCalledTimes(1);
          expect(activeMaintenanceWorker.kill).toHaveBeenCalledTimes(1);

          // Both class owners have answered, so both aged candidates are
          // eligible. Keep one retired process holding its slot so the pool
          // admits only the oldest candidate on this fairness turn.
          activeComparisonWorker.exit();
          await settleMicrotasks();
          expect(children).toHaveLength(5);
          const olderWorker = children[4];
          if (olderWorker === undefined) {
            throw new Error('The oldest aged candidate did not get a worker.');
          }
          expect(olderWorker.postMessage).toHaveBeenCalledWith(
            request(olderCandidate.task),
          );
          expect(olderWorker.postMessage).not.toHaveBeenCalledWith(
            request(newerCandidate.task),
          );
          expect(olderWorker.postMessage).not.toHaveBeenCalledWith(
            request(STRUCTURAL),
          );
          expect(activeMaintenanceWorker.exited).toBe(false);
          expect(children.filter((child) => !child.exited)).toHaveLength(4);

          olderWorker.answerWith(olderCandidate.result);
          await expect(older).resolves.toEqual({
            ok: true,
            result: olderCandidate.result,
          });
          expect(olderWorker.kill).toHaveBeenCalledTimes(1);
          olderWorker.exit();
          await settleMicrotasks();

          // The other aged class does not take a second consecutive fairness
          // turn ahead of the still-eligible interactive request.
          expect(children).toHaveLength(6);
          const interactiveWorker = children[5];
          if (interactiveWorker === undefined) {
            throw new Error(
              'The queued interactive read did not get a worker.',
            );
          }
          expect(interactiveWorker.postMessage).toHaveBeenCalledWith(
            request(STRUCTURAL),
          );
          expect(interactiveWorker.postMessage).not.toHaveBeenCalledWith(
            request(newerCandidate.task),
          );
          expect(activeMaintenanceWorker.exited).toBe(false);
          expect(children[0]?.kill).not.toHaveBeenCalled();
          expect(children[1]?.kill).not.toHaveBeenCalled();

          interactiveWorker.answer();
          await queuedInteractive;
          activeMaintenanceWorker.exit();
          await settleMicrotasks();
          expect(children).toHaveLength(7);
          const newerWorker = children[6];
          if (newerWorker === undefined) {
            throw new Error(
              'The remaining aged candidate did not get a worker.',
            );
          }
          expect(newerWorker.postMessage).toHaveBeenCalledWith(
            request(newerCandidate.task),
          );
          newerWorker.answerWith(newerCandidate.result);
          await expect(newer).resolves.toEqual({
            ok: true,
            result: newerCandidate.result,
          });
          newerWorker.exit();

          children[0]?.answer();
          children[1]?.answer();
          await Promise.all(interactive);
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it('skips an older aged candidate while its task class is ineligible', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const activeComparison = read('three', COMPARISON_TASK);
        const activeMaintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [
          ...interactive,
          activeComparison,
          activeMaintenance,
        ]) {
          void pending.catch(() => undefined);
        }
        expect(children).toHaveLength(4);

        const olderCandidate = AGED_CANDIDATES.maintenance;
        const newerCandidate = AGED_CANDIDATES.comparison;
        const older = read(olderCandidate.key, olderCandidate.task);
        void older.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(10_000);
        const newer = read(newerCandidate.key, newerCandidate.task);
        void newer.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(14_500);
        // Stay inside the interactive queue TTL while comparison reaches 15 s.
        const queuedInteractive = read('workspace/worktree');
        void queuedInteractive.catch(() => undefined);
        await jest.advanceTimersByTimeAsync(500);

        // Both candidates have aged, but this maintenance task is still
        // active, so the older maintenance request is not eligible yet.
        const activeComparisonWorker = children[2];
        if (activeComparisonWorker === undefined) {
          throw new Error('The active comparison worker was not created.');
        }
        answerChangeImpact(activeComparisonWorker);
        await activeComparison;
        activeComparisonWorker.exit();
        await settleMicrotasks();

        expect(children).toHaveLength(5);
        const newerWorker = children[4];
        if (newerWorker === undefined) {
          throw new Error(
            'The eligible comparison candidate did not get a worker.',
          );
        }
        expect(newerWorker.postMessage).toHaveBeenCalledWith(
          request(newerCandidate.task),
        );
        expect(newerWorker.postMessage).not.toHaveBeenCalledWith(
          request(olderCandidate.task),
        );
        expect(children[3]?.kill).not.toHaveBeenCalled();

        newerWorker.answerWith(newerCandidate.result);
        await expect(newer).resolves.toEqual({
          ok: true,
          result: newerCandidate.result,
        });
        newerWorker.exit();
        await settleMicrotasks();
        expect(children).toHaveLength(6);
        const interactiveWorker = children[5];
        if (interactiveWorker === undefined) {
          throw new Error('The queued interactive read did not get a worker.');
        }
        expect(interactiveWorker.postMessage).toHaveBeenCalledWith(
          request(STRUCTURAL),
        );
        expect(interactiveWorker.postMessage).not.toHaveBeenCalledWith(
          request(olderCandidate.task),
        );

        interactiveWorker.answer();
        await queuedInteractive;
        const activeMaintenanceWorker = children[3];
        if (activeMaintenanceWorker === undefined) {
          throw new Error('The active maintenance worker was not created.');
        }
        activeMaintenanceWorker.answerWith(PERSISTED);
        await activeMaintenance;
        activeMaintenanceWorker.exit();
        await settleMicrotasks();

        expect(children).toHaveLength(7);
        const olderWorker = children[6];
        if (olderWorker === undefined) {
          throw new Error('The maintenance candidate did not get a worker.');
        }
        expect(olderWorker.postMessage).toHaveBeenCalledWith(
          request(olderCandidate.task),
        );
        olderWorker.answerWith(olderCandidate.result);
        await expect(older).resolves.toEqual({
          ok: true,
          result: olderCandidate.result,
        });
        olderWorker.exit();

        children[0]?.answer();
        children[1]?.answer();
        await Promise.all(interactive);
      } finally {
        jest.useRealTimers();
      }
    });

    it('shutdown cancels queued classes and awaits workers', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
      try {
        const interactive = [read('one'), read('two')];
        const comparison = read('three', COMPARISON_TASK);
        const maintenance = read('four', PERSIST_FINGERPRINT);
        for (const pending of [...interactive, comparison, maintenance]) {
          void pending.catch(() => undefined);
        }

        children[0]?.answer();
        await interactive[0];
        expect(children[0]?.kill).not.toHaveBeenCalled();
        children[3]?.answerWith(PERSISTED);
        await maintenance;
        expect(children[3]?.kill).toHaveBeenCalledTimes(1);
        expect(children[3]?.exited).toBe(false);

        const queuedInteractive = read('five');
        const queuedComparison = read('proj/wt-1', COMPARISON_TASK);
        const queuedMaintenance = read('proj/wt-2', PERSIST_FINGERPRINT);
        for (const pending of [
          queuedInteractive,
          queuedComparison,
          queuedMaintenance,
        ]) {
          void pending.catch(() => undefined);
        }

        const shutdown = shutdownCodeGraphReadWorkers();
        let shutdownSettled = false;
        void shutdown.then(() => {
          shutdownSettled = true;
        });
        await expect(queuedInteractive).rejects.toMatchObject({
          reason: 'canceled',
        });
        await expect(queuedComparison).rejects.toMatchObject({
          reason: 'canceled',
        });
        await expect(queuedMaintenance).rejects.toMatchObject({
          reason: 'canceled',
        });
        await expect(Promise.all(interactive)).rejects.toMatchObject({
          reason: 'canceled',
        });
        await expect(comparison).rejects.toMatchObject({ reason: 'canceled' });
        for (const index of [0, 1, 2, 3]) {
          expect(children[index]?.kill).toHaveBeenCalledTimes(1);
        }
        await settleMicrotasks();
        expect(shutdownSettled).toBe(false);

        for (const child of children) child.exit();
        await shutdown;
        await settleMicrotasks();
        expect(shutdownSettled).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
