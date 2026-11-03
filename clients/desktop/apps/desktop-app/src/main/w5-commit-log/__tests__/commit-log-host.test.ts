import type { WorkspaceCreationDiagnostics } from '@canopy/desktop-shared/node/w5-commit-log/reservation-diagnostics';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as AdmissionModule from '../../lib/w5-host-admission';
import type * as HostModule from '../commit-log-host';
import { createW5CommitEventSource } from '@canopy/core-runtime/node/w5/commit-events';
import {
  W5CommitLog,
  W5CommitLogError,
  W5CommitRefusedError,
  fingerprintW5File,
  recoverW5CommitLog,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

const mockPaths = {
  dbPath: '/nonexistent/w5-host-test/commit-log.sqlite',
  root: '/nonexistent/w5-host-test/workspaces',
};

jest.mock('../../lib/paths', () => ({
  getW5CommitLogPath: (): string => mockPaths.dbPath,
  getWorkspacesRootDir: (): string => mockPaths.root,
}));

import {
  W5CommitLogHost,
  W5CommitLogHostError,
  getW5CommitLogHost,
  shutdownW5CommitLogHost,
  type W5CommitLogHostOptions,
} from '../commit-log-host';

jest.setTimeout(60_000);

const WORKER_ENTRY = join(__dirname, '..', 'commit-log-worker.ts');
const SCRIPTED_ENTRY = join(__dirname, 'fixtures', 'scripted-worker.ts');
const RECORDING_ENTRY = join(__dirname, 'fixtures', 'recording-worker.ts');
const WORKSPACES = { kind: 'workspaces' } as const;

let dir: string;
let root: string;
let dbPath: string;
let indexPath: string;
const hosts: W5CommitLogHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-host-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  indexPath = join(root, 'index.json');
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  rmSync(dir, { recursive: true, force: true });
});

function createHost(
  options: Partial<W5CommitLogHostOptions> = {},
): W5CommitLogHost {
  const host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: WORKER_ENTRY,
    ...options,
  });
  hosts.push(host);
  return host;
}

/** Stops the host's running worker, as a crash does; the next call starts another. */
async function retireWorker(host: W5CommitLogHost): Promise<void> {
  const worker: unknown = Reflect.get(
    Object(Reflect.get(host, 'session')),
    'worker',
  );
  const terminate: unknown = Reflect.get(Object(worker), 'terminate');
  if (typeof terminate !== 'function') throw new Error('No running worker');
  await Reflect.apply(terminate, worker, []);
}

function scriptedHost(
  script: string,
  options: Partial<W5CommitLogHostOptions> = {},
): W5CommitLogHost {
  return createHost({ workerEntry: SCRIPTED_ENTRY, root: script, ...options });
}

interface CachedRead {
  readonly reason: unknown;
  readonly read: string | null;
}

/** A subscriber's cache of `path`, re-read from disk on each invalidation. */
function invalidationCache(
  events: ReturnType<typeof createW5CommitEventSource>,
  epoch: string,
  path: string,
): CachedRead[] {
  const cache: CachedRead[] = [];
  const subscribed = events.journal.subscribe(
    { daemonEpoch: epoch, sequence: 0 },
    (entry) => {
      if (entry.event.name !== 'core.workspace.invalidated') return;
      cache.push({
        reason: entry.event.payload.reason,
        read: existsSync(path) ? readFileSync(path, 'utf8') : null,
      });
    },
  );
  expect(subscribed.kind).toBe('subscribed');
  return cache;
}

function indexChange(
  contents: string,
  previous: string | null,
): W5CommitRequest {
  return {
    operation: 'internal.repository.write',
    advance: [WORKSPACES],
    files: [
      {
        path: indexPath,
        contents,
        previousFingerprint: fingerprintW5File(previous),
      },
    ],
    outcome: null,
  };
}

/** The host failure a call settled with, or `resolved`. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof W5CommitLogHostError ? error.reason : 'other';
  }
}

describe('W5 commit log host (CAN-3805)', () => {
  it('starts no worker until the first call, then commits and writes the file', async () => {
    const host = createHost();
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);

    await expect(host.commit(indexChange('v1', null))).resolves.toMatchObject({
      status: 'applied',
      revisions: { workspaces: 1 },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
    expect(host.workersStarted).toBe(1);
  });

  it('creates a missing data root before the first commit writes into it', async () => {
    const freshRoot = join(dir, 'fresh', 'workspaces');
    const freshIndex = join(freshRoot, 'index.json');
    const host = createHost({ root: freshRoot });

    await expect(
      host.commit({
        ...indexChange('v1', null),
        files: [
          { path: freshIndex, contents: 'v1', previousFingerprint: null },
        ],
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(readFileSync(freshIndex, 'utf8')).toBe('v1');
  });

  // CAN-5153: whoever created the data root, its parent is flushed, then the
  // database's folder.
  it("flushes the data root's parent before the worker reports ready", async () => {
    const log = join(dir, 'recording.log');
    const host = createHost({ dataRoot: dir, workerEntry: RECORDING_ENTRY });
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toEqual([
      `flush ${dir}`,
      `flush ${dirname(dir)}`,
      `flush ${dirname(dbPath)}`,
      'message ready',
    ]);
  });

  it('refuses a data root that does not hold the root and the log', () => {
    expect(() => createHost({ dataRoot: join(dir, 'w5') })).toThrow(RangeError);
    expect(() => createHost({ dataRoot: root })).toThrow(RangeError);
    expect(createHost({ dataRoot: dir }).root).toBe(root);
    // A child whose name starts with `..` is still inside.
    expect(() =>
      createHost({
        dataRoot: dir,
        root: join(dir, '..workspaces'),
        dbPath: join(dir, '..w5', 'commit-log.sqlite'),
      }),
    ).not.toThrow();
  });

  it('finishes a change an earlier process committed before it answers anything', async () => {
    // A worker that committed and stopped before writing the file, then a
    // retry of the same keyed request against the next worker.
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'k1',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    const log = W5CommitLog.open(dbPath);
    const committed = log.commit(keyed);
    log.close();
    expect(existsSync(indexPath)).toBe(false);

    const host = createHost();
    await expect(host.recoveryReport()).resolves.toEqual({
      applied: [committed.commitId],
      recoveryRequired: [],
      interruptedReservations: 0,
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(host.commit(keyed)).resolves.toEqual({
      status: 'replayed',
      commitId: committed.commitId,
      outcome: { workspaceId: 'alpha' },
    });
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
  });

  it("replays a keyed request and carries refusals as the commit log's own errors", async () => {
    const host = createHost();
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'k1',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    await expect(host.commit(keyed)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(host.commit(keyed)).resolves.toMatchObject({
      status: 'replayed',
      outcome: { workspaceId: 'alpha' },
    });

    const stale = host.commit({
      ...indexChange('v2', 'v1'),
      expectedRevisions: [{ resource: WORKSPACES, revision: 0 }],
    });
    await expect(stale).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(stale).rejects.toMatchObject({ reason: 'revision-conflict' });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
  });

  it('carries an expired replay through the real worker and host without another commit', async () => {
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'expired',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    const log = W5CommitLog.open(dbPath, {
      clock: () => Date.parse('2020-01-01T00:00:00.000Z'),
    });
    let commitId: number;
    try {
      commitId = log.commit(keyed).commitId;
      await recoverW5CommitLog(log, { root });
    } finally {
      log.close();
    }
    rmSync(indexPath);
    const host = createHost();
    await expect(host.commit(keyed)).resolves.toEqual({
      status: 'replay-expired',
      commitId,
    });
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
    expect(existsSync(indexPath)).toBe(false);
  });

  it('reports a change it could not write as awaiting recovery and keeps the file', async () => {
    writeFileSync(indexPath, 'edited elsewhere');
    const host = createHost();

    await expect(host.commit(indexChange('v2', 'v1'))).resolves.toMatchObject({
      status: 'recovery-required',
      apply: {
        conflicts: [
          {
            path: indexPath,
            expected: fingerprintW5File('v1'),
            actual: fingerprintW5File('edited elsewhere'),
          },
        ],
        written: [],
      },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('edited elsewhere');
  });

  it('reports a log another connection holds, and opens it once released', async () => {
    const host = createHost();
    const holder = W5CommitLog.open(dbPath);
    try {
      const refused = host.revision(WORKSPACES);
      await expect(refused).rejects.toBeInstanceOf(W5CommitLogError);
      await expect(refused).rejects.toMatchObject({
        code: 'WRITER_UNAVAILABLE',
      });
    } finally {
      holder.close();
    }
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(host.workersStarted).toBe(2);
  });

  it('rejects a request the worker cannot read and keeps the worker', async () => {
    const host = createHost();
    const malformed = host.commit({
      ...indexChange('v1', null),
      expectedRevisions: [{ resource: WORKSPACES, revision: 1.5 }],
    });
    await expect(malformed).rejects.toBeInstanceOf(W5CommitLogHostError);
    await expect(malformed).rejects.toMatchObject({ reason: 'malformed' });

    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(existsSync(indexPath)).toBe(false);
    expect(host.workersStarted).toBe(1);
  });

  it('refuses a request that cannot be sent and keeps the worker', async () => {
    const host = createHost();
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);

    const unclonable = host.commit({
      ...indexChange('v1', null),
      outcome: (): undefined => undefined,
    });
    await expect(unclonable).rejects.toMatchObject({ reason: 'malformed' });

    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(existsSync(indexPath)).toBe(false);
    expect(host.workersStarted).toBe(1);
  });

  it('treats a call lost in flight as outcome unknown and the calls behind it as never sent', async () => {
    const host = scriptedHost('exit-on-request');
    await expect(
      Promise.all([
        failureOf(host.revision(WORKSPACES)),
        failureOf(host.revision(WORKSPACES)),
      ]),
    ).resolves.toEqual(['outcome-unknown', 'unavailable']);
  });

  // Recovery by the replacement is covered with the real worker above.
  it('retires a worker that failed unexpectedly and starts a fresh one', async () => {
    const host = scriptedHost('failed');
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    expect(host.workersStarted).toBe(2);
  });

  it("pins the first worker's capture root and starts every later worker with it", async () => {
    const host = scriptedHost('anchor');
    const startedWith = async (): Promise<unknown> => {
      const error: unknown = await host
        .capture({
          files: [],
          discoverWorkspaces: false,
        })
        .then(
          () => 'captured',
          (failure: unknown) => failure,
        );
      expect(error).toBeInstanceOf(W5CommitRefusedError);
      return Reflect.get(
        Object(Reflect.get(Object(error), 'details')),
        'startedWith',
      );
    };
    expect(host.captureRoot).toBeUndefined();
    await expect(startedWith()).resolves.toBeNull();
    const anchored = host.captureRoot;
    expect(anchored).toMatch(/^\/anchored\/by-worker-\d+$/);
    // A retired worker's replacement must not resolve the root again.
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    await expect(startedWith()).resolves.toBe(anchored);
    expect(host.captureRoot).toBe(anchored);
    expect(host.workersStarted).toBe(2);
  });

  /** The capture root a late-anchoring scripted worker refused with. */
  async function capturedWith(host: W5CommitLogHost): Promise<unknown> {
    const error: unknown = await host
      .capture({ files: [], discoverWorkspaces: false })
      .then(
        () => 'captured',
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(W5CommitRefusedError);
    return Reflect.get(
      Object(Reflect.get(Object(error), 'details')),
      'anchored',
    );
  }

  it('replaces a worker that could not anchor before a capture, keeping the calls queued behind it', async () => {
    const host = scriptedHost('anchor-late');
    // Only a capture needs the anchor; other calls keep the worker.
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(host.workersStarted).toBe(1);
    expect(host.captureRoot).toBeUndefined();
    const captured = capturedWith(host);
    const behind = host.revision(WORKSPACES);
    const anchored = await captured;
    expect(anchored).toMatch(/^\/anchored\/by-worker-\d+$/);
    expect(host.captureRoot).toBe(anchored);
    await expect(behind).resolves.toBe(0);
    expect(host.workersStarted).toBe(2);
    // Pinned now: later captures start no other worker.
    await expect(capturedWith(host)).resolves.toBe(anchored);
    expect(host.workersStarted).toBe(2);
  });

  it('replaces an unanchored worker at most once per capture when the root never resolves', async () => {
    const host = scriptedHost('never-anchor');
    await expect(capturedWith(host)).resolves.toBeNull();
    // The first worker started for the capture, then one replacement.
    expect(host.workersStarted).toBe(2);
    await expect(capturedWith(host)).resolves.toBeNull();
    expect(host.workersStarted).toBe(3);
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(host.workersStarted).toBe(3);
    expect(host.captureRoot).toBeUndefined();
  });

  it('starts no replacement for an unanchored worker once shutdown begins', async () => {
    const host = scriptedHost('never-anchor');
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    // The capture retires the idle worker at once; its replacement waits.
    const captured = failureOf(
      host.capture({ files: [], discoverWorkspaces: false }),
    );
    await host.shutdown();
    await expect(captured).resolves.toBe('unavailable');
    expect(host.workersStarted).toBe(1);
    expect(host.runningWorkerCount).toBe(0);
  });

  it('anchors the realpath of a root reached through an alias, and starts a replacement worker with it after a swap', async () => {
    const alias = join(dir, 'alias');
    symlinkSync(root, alias, 'dir');
    const host = createHost({ root: alias });
    await host.recoveryReport();
    const anchored = realpathSync(root);
    expect(host.captureRoot).toBe(anchored);
    expect(host.root).toBe(alias);
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    unlinkSync(alias);
    symlinkSync(elsewhere, alias, 'dir');
    const before = startedWorkers.length;
    await retireWorker(host);
    await host.recoveryReport();
    expect(host.workersStarted).toBe(2);
    expect(startedWorkers.slice(before)).toMatchObject([
      { workerData: { root: alias, captureRoot: anchored } },
    ]);
    expect(host.captureRoot).toBe(anchored);
  });

  it('starts no replacement while a stopped worker is still blocked', async () => {
    const host = scriptedHost('blocked', { requestTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    // The first worker is still in its native call, and may hold the lock.
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.workersStarted).toBe(1);
  });

  it('treats a request the worker never answers as outcome unknown', async () => {
    const host = scriptedHost('silent', { requestTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
  });

  describe('queued read deadlines (CAN-5566)', () => {
    it('does not send an overdue read when a worker response beats the queued timer callback', async () => {
      const host = scriptedHost('gated-commit');
      await host.revision(WORKSPACES);
      const gate = new Int32Array(new SharedArrayBuffer(4));
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
      try {
        const active = host.commit({
          ...indexChange('v1', null),
          outcome: gate.buffer,
        });
        const waiting = failureOf(host.revision(WORKSPACES));
        // Model a delayed host timer: I/O can run after the deadline but before
        // its timer callback. The enqueue deadline must still hold at send.
        clock.mockReturnValue(30_000);
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        await expect(active).resolves.toMatchObject({ status: 'applied' });
        await expect(waiting).resolves.toBe('unavailable');
        await expect(host.revision(WORKSPACES)).resolves.toBe(3);
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        clock.mockRestore();
        jest.useRealTimers();
      }
    });

    it('bounds admission waits too, without starting a worker after the only read expires', async () => {
      let admit = (): void => undefined;
      const admission = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const host = createHost({
        admission: () => admission,
        queuedReadTimeoutMs: 100,
      });
      jest.useFakeTimers();
      try {
        const waiting = failureOf(host.revision(WORKSPACES));
        await jest.advanceTimersByTimeAsync(100);
        // Checking before awaiting the call makes a missing deadline fail promptly.
        expect(jest.getTimerCount()).toBe(0);
        let failure: string | undefined;
        void waiting.then((reason) => {
          failure = reason;
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(failure).toBe('unavailable');
        admit();
        await jest.advanceTimersByTimeAsync(0);
        expect(host.workersStarted).toBe(0);
      } finally {
        admit();
        jest.useRealTimers();
      }
    });

    it.each([0, -1, NaN, Infinity])(
      'rejects an invalid queued read bound %s',
      (queuedReadTimeoutMs) => {
        expect(() => createHost({ queuedReadTimeoutMs })).toThrow(RangeError);
      },
    );

    it('expires only the three covered reads after 30 s, frees their queue slots, and keeps other calls waiting', async () => {
      const host = scriptedHost('gated-commit', {
        requestTimeoutMs: 120_000,
        maxQueuedCalls: 6,
      });
      await expect(host.revision(WORKSPACES)).resolves.toBe(1);
      const gate = new Int32Array(new SharedArrayBuffer(4));
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        const active = host.commit({
          ...indexChange('v1', null),
          outcome: gate.buffer,
        });
        void active.catch(() => undefined);
        let committed = false;
        const queuedCommit = host
          .commit(indexChange('v2', 'v1'))
          .then((result) => {
            committed = true;
            return result;
          });
        void queuedCommit.catch(() => undefined);
        let otherReadsCompleted = 0;
        const snapshot = host.snapshot().then((result) => {
          otherReadsCompleted += 1;
          return result;
        });
        const receipt = host
          .lookupReceipt({
            caller: 'test',
            operation: 'internal.repository.write',
            idempotencyKey: 'queued',
            fingerprint: 'test',
          })
          .then((result) => {
            otherReadsCompleted += 1;
            return result;
          });
        void snapshot.catch(() => undefined);
        void receipt.catch(() => undefined);
        const failures: unknown[] = [];
        const reads = [
          host.capture({ files: [], discoverWorkspaces: false }),
          host.revision(WORKSPACES),
          host.recoveryReport(),
        ].map((read) =>
          read.catch((error: unknown) => {
            failures.push(error);
          }),
        );
        await jest.advanceTimersByTimeAsync(29_999);
        expect(failures).toEqual([]);
        expect(committed).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(failures).toHaveLength(3);
        await Promise.all(reads);
        for (const error of failures) {
          expect(error).toBeInstanceOf(W5CommitLogHostError);
          expect(error).toMatchObject({ reason: 'unavailable' });
        }
        // Uncovered calls must survive beyond the read deadline, not just to it.
        await jest.advanceTimersByTimeAsync(30_000);
        expect(committed).toBe(false);
        expect(otherReadsCompleted).toBe(0);
        expect(jest.getTimerCount()).toBe(1);
        // All three expired reads release capacity; only the active timer remains.
        const afterExpiry = Promise.all([
          host.revision(WORKSPACES),
          host.revision(WORKSPACES),
          host.revision(WORKSPACES),
        ]);
        void afterExpiry.catch(() => undefined);
        await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
          reason: 'unavailable',
          message: 'The W5 commit log is busy',
        });
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        // Keep one monotonic clock until the queued deadlines have drained.
        await expect(active).resolves.toMatchObject({
          status: 'applied',
          commitId: 2,
        });
        await expect(queuedCommit).resolves.toMatchObject({
          status: 'applied',
          commitId: 3,
        });
        await expect(snapshot).resolves.toMatchObject({ commitId: 4 });
        await expect(receipt).resolves.toEqual({ status: 'none' });
        // Warm-up, two commits, two uncovered reads, and the replacement reads.
        await expect(afterExpiry).resolves.toEqual([6, 7, 8]);
        expect(jest.getTimerCount()).toBe(0);
        expect(host.workersStarted).toBe(1);
      } finally {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        jest.useRealTimers();
      }
    });

    it.each([
      { workerNumber: 1, loggingThrows: false },
      { workerNumber: 2, loggingThrows: true },
    ])(
      'logs timeout context on worker $workerNumber and settles even if logging throws ($loggingThrows)',
      async ({ workerNumber, loggingThrows }) => {
        const warn = jest.fn(() => {
          if (loggingThrows) throw new Error('logger unavailable');
        });
        const host = scriptedHost('gated-commit', { warn });
        await host.revision(WORKSPACES);
        if (workerNumber === 2) {
          await retireWorker(host);
          await host.revision(WORKSPACES);
        }
        const gate = new Int32Array(new SharedArrayBuffer(4));
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        try {
          const active = failureOf(
            host.commit({
              ...indexChange('private-bytes', null),
              outcome: gate.buffer,
            }),
          );
          // Queued commits retain their existing unavailable-on-worker-failure policy.
          const queued = failureOf(host.commit(indexChange('v2', 'v1')));
          await jest.advanceTimersByTimeAsync(30_000);
          await expect(active).resolves.toBe('outcome-unknown');
          await expect(queued).resolves.toBe('unavailable');
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith('W5 commit log request timed out', {
            method: 'commit',
            elapsedMs: 30_000,
            queueDepth: 1,
            workerNumber,
          });
        } finally {
          Atomics.store(gate, 0, 1);
          Atomics.notify(gate, 0);
          jest.useRealTimers();
        }
      },
    );
  });

  it('treats a result of the wrong shape as outcome unknown', async () => {
    const host = scriptedHost('unexpected-result');
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
  });

  it('gives up on a worker that never starts without sending anything', async () => {
    const host = scriptedHost('never-ready', { startupTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('refuses calls beyond its queue bound', async () => {
    const host = createHost({ maxQueuedCalls: 1 });
    const first = host.revision(WORKSPACES);
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(first).resolves.toBe(0);
  });

  it('counts a worker as recovered only once it reports ready', async () => {
    const host = scriptedHost('never-ready', { startupTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.workersStarted).toBe(1);
    expect(host.recoveredWorker).toBe(0);
  });

  // CAN-5497 review b89f3b44: a call refused before a replacement worker is
  // ready must not stand in for that worker's launch recovery.
  it('publishes a replacement worker recovery only once its effects are on disk', async () => {
    const epoch = 'runtime:host-test';
    const host = createHost({ maxQueuedCalls: 1 });
    const events = createW5CommitEventSource({ host, epoch });
    const port = events.port();
    const cache = invalidationCache(events, epoch, indexPath);
    await port.recoveryReport();
    expect(host.recoveredWorker).toBe(1);
    // Worker 1 stops, leaving a commit it made but did not write.
    await retireWorker(host);
    expect(host.runningWorkerCount).toBe(0);
    const log = W5CommitLog.open(dbPath);
    log.commit(indexChange('v1', null));
    log.close();
    // Its exit was published, before the pending commit existed.
    expect(cache.splice(0)).toEqual([{ reason: 'uncertain', read: null }]);

    const first = port.revision(WORKSPACES);
    // Worker 2 has started; its launch recovery has not run yet.
    expect(host.workersStarted).toBe(2);
    expect(host.recoveredWorker).toBe(1);
    await expect(port.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(cache).toEqual([]);
    await expect(first).resolves.toBe(1);
    expect(host.recoveredWorker).toBe(2);
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    expect(cache).toEqual([{ reason: 'recovered', read: 'v1' }]);
  });

  // CAN-5497: a replacement worker can apply part of its launch recovery and
  // then fail before it is ready; its refused calls change nothing, so only
  // its exit can tell subscribers, even when no call follows.
  it('publishes the exit of a worker that failed before it was ready', async () => {
    const epoch = 'runtime:host-test';
    const host = scriptedHost('partial-recovery', { startupTimeoutMs: 200 });
    const events = createW5CommitEventSource({ host, epoch });
    const cache = invalidationCache(events, epoch, dbPath);
    await expect(events.port().revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.recoveredWorker).toBe(0);
    await host.shutdown();
    expect(host.runningWorkerCount).toBe(0);
    expect(cache).toEqual([{ reason: 'uncertain', read: 'recovered' }]);
  });

  it('refuses calls after shutdown and releases the log', async () => {
    const host = createHost();
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    await host.shutdown();

    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    W5CommitLog.open(dbPath).close();
    expect(host.workersStarted).toBe(1);
  });

  it("starts nothing for the app's host until a call, and refuses calls after quit", async () => {
    mockPaths.dbPath = dbPath;
    mockPaths.root = root;
    const host = getW5CommitLogHost();
    expect(getW5CommitLogHost()).toBe(host);
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);

    await shutdownW5CommitLogHost();
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  describe('writer admission (CAN-3797)', () => {
    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    } {
      let resolve = (): void => undefined;
      let reject: (error: Error) => void = () => undefined;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    }

    it('starts the worker only once admission resolves', async () => {
      const gate = deferred();
      const host = createHost({ admission: () => gate.promise });
      const first = host.revision(WORKSPACES);
      const second = host.commit(indexChange('v1', null));
      await new Promise((done) => setTimeout(done, 20));
      expect(host.workersStarted).toBe(0);
      expect(existsSync(dbPath)).toBe(false);

      gate.resolve();
      await expect(first).resolves.toBe(0);
      await expect(second).resolves.toMatchObject({ status: 'applied' });
      expect(host.workersStarted).toBe(1);
    });

    it('refuses waiting calls as unavailable when admission rejects, starting nothing', async () => {
      let checks = 0;
      const host = createHost({
        admission: () => {
          checks += 1;
          return Promise.reject(new Error('maintenance-held'));
        },
      });
      const calls = [
        host.revision(WORKSPACES),
        host.commit(indexChange('v1', null)),
      ];
      await expect(Promise.all(calls.map(failureOf))).resolves.toEqual([
        'unavailable',
        'unavailable',
      ]);
      await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
        reason: 'unavailable',
        message: 'The W5 commit log is not admitted in this process',
      });
      // One check per launch; each later call asks again.
      expect(checks).toBe(2);
      expect(host.workersStarted).toBe(0);
      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(indexPath)).toBe(false);
    });

    it('treats an admission that throws synchronously as a refusal', async () => {
      const host = createHost({
        admission: () => {
          throw new Error('not registered');
        },
      });
      await expect(failureOf(host.revision(WORKSPACES))).resolves.toBe(
        'unavailable',
      );
      expect(host.workersStarted).toBe(0);
    });

    it('starts nothing when shut down while admission is pending', async () => {
      const gate = deferred();
      const host = createHost({ admission: () => gate.promise });
      const waiting = failureOf(host.revision(WORKSPACES));
      await host.shutdown();
      await expect(waiting).resolves.toBe('unavailable');
      gate.resolve();
      await new Promise((done) => setTimeout(done, 20));
      expect(host.workersStarted).toBe(0);
      expect(existsSync(dbPath)).toBe(false);
    });

    it("gates the app's host on startup registration", async () => {
      mockPaths.dbPath = dbPath;
      mockPaths.root = root;
      await jest.isolateModulesAsync(async () => {
        const isolated =
          jest.requireActual<typeof HostModule>('../commit-log-host');
        const admission = jest.requireActual<typeof AdmissionModule>(
          '../../lib/w5-host-admission',
        );
        const host = isolated.getW5CommitLogHost();
        try {
          // Never registered: refused before any worker or log exists.
          await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
            reason: 'unavailable',
          });
          expect(host.workersStarted).toBe(0);
          expect(existsSync(dbPath)).toBe(false);
          if (process.platform !== 'win32')
            expect(existsSync(join(dir, 'runtime', 'hosts'))).toBe(false);

          await expect(admission.admitDesktopW5Host(dir)).resolves.toEqual({
            kind: 'admitted',
          });
          // Admitted for the log's own data root: the worker now starts. The
          // app's worker bundle is absent under Jest, so the call may fail.
          await host.revision(WORKSPACES).catch(() => undefined);
          expect(host.workersStarted).toBe(1);
        } finally {
          await isolated.shutdownW5CommitLogHost();
        }
      });
    });
  });

  it('loads in main without node:sqlite, which only the worker opens', () => {
    jest.isolateModules(() => {
      jest.doMock('node:sqlite', () => {
        throw new Error('node:sqlite was loaded in main');
      });
      expect((): void => {
        jest.requireActual('../commit-log-host');
      }).not.toThrow();
    });
  });
});

describe('cold-host recovery requests (RX1)', () => {
  const RECEIPT = {
    caller: 'portal:1',
    operation: 'core.workspace.create',
    idempotencyKey: 'k1',
    fingerprint: 'f1',
  };

  function keyedChange(contents: string, previous: string): W5CommitRequest {
    return {
      ...indexChange(contents, previous),
      receipt: RECEIPT,
      outcome: { workspaceId: 'alpha' },
    };
  }

  /**
   * A keyed commit left awaiting recovery because its file changed out of
   * band, made by a host that has since shut down; returns a cold host.
   */
  async function wedgedRoot(): Promise<{
    cold: W5CommitLogHost;
    commitId: number;
  }> {
    writeFileSync(indexPath, 'foreign');
    const writer = createHost();
    const outcome = await writer.commit(keyedChange('v1', 'v0'));
    if (outcome.status !== 'recovery-required')
      throw new Error(`Expected recovery-required, got ${outcome.status}`);
    await writer.shutdown();
    const cold = createHost();
    expect(cold.workersStarted).toBe(0);
    return { cold, commitId: outcome.commitId };
  }

  it('retries a wedged commit: still awaiting recovery without a restore, applied after an exact one', async () => {
    const { cold, commitId } = await wedgedRoot();
    await expect(cold.recoveryReport()).resolves.toMatchObject({
      applied: [],
      recoveryRequired: [commitId],
    });

    await expect(cold.retryRecoveryRequiredCommit(commitId)).resolves.toEqual({
      status: 'recovery-required',
      commitId,
      apply: {
        status: 'recovery-required',
        conflicts: [
          {
            path: indexPath,
            expected: fingerprintW5File('v0'),
            actual: fingerprintW5File('foreign'),
          },
        ],
        written: [],
      },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('foreign');

    writeFileSync(indexPath, 'v0');
    await expect(cold.retryRecoveryRequiredCommit(commitId)).resolves.toEqual({
      status: 'applied',
      commitId,
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(cold.commit(keyedChange('v1', 'v0'))).resolves.toEqual({
      status: 'replayed',
      commitId,
      outcome: { workspaceId: 'alpha' },
    });
    await expect(cold.revision(WORKSPACES)).resolves.toBe(1);
    expect(cold.workersStarted).toBe(1);
  });

  it('abandons a wedged commit: foreign bytes kept, a stale same-key retry refused, then fresh writes apply', async () => {
    const { cold, commitId } = await wedgedRoot();

    await expect(
      cold.abandonRecoveryRequiredCommit(commitId),
    ).resolves.toBeUndefined();
    expect(readFileSync(indexPath, 'utf8')).toBe('foreign');
    await expect(cold.lookupReceipt(RECEIPT)).resolves.toEqual({
      status: 'none',
    });
    // Revision advances stay, so the expectation read before it refuses.
    await expect(cold.revision(WORKSPACES)).resolves.toBe(1);
    const stale = cold.commit({
      ...keyedChange('v1', 'foreign'),
      expectedRevisions: [{ resource: WORKSPACES, revision: 0 }],
    });
    await expect(stale).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(stale).rejects.toMatchObject({ reason: 'revision-conflict' });
    expect(readFileSync(indexPath, 'utf8')).toBe('foreign');

    const fresh = await cold.commit({
      ...keyedChange('v1', 'foreign'),
      expectedRevisions: [{ resource: WORKSPACES, revision: 1 }],
    });
    expect(fresh).toMatchObject({
      status: 'applied',
      revisions: { workspaces: 2 },
    });
    expect(fresh.commitId).not.toBe(commitId);
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(cold.commit(indexChange('v2', 'v1'))).resolves.toMatchObject({
      status: 'applied',
      revisions: { workspaces: 3 },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v2');
    await expect(
      cold.abandonRecoveryRequiredCommit(commitId),
    ).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { commitId, actual: 'missing' },
    });
  });

  it('resolves a reservation a crashed host left, after which the same key applies exactly once', async () => {
    const writer = createHost();
    await writer.reserve({
      reservationId: 'held',
      operation: RECEIPT.operation,
      receipt: RECEIPT,
    });
    await writer.shutdown();
    const cold = createHost();
    await expect(cold.recoveryReport()).resolves.toMatchObject({
      interruptedReservations: 1,
      recoveryRequiredReservations: ['held'],
    });
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: RECEIPT,
      outcome: { workspaceId: 'alpha' },
    };
    await expect(cold.commit(keyed)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(existsSync(indexPath)).toBe(false);

    await expect(cold.resolveRecovery('held')).resolves.toBeUndefined();
    await expect(cold.resolveRecovery('held')).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { reservationId: 'held', actual: 'missing' },
    });
    const applied = await cold.commit(keyed);
    expect(applied).toMatchObject({ status: 'applied' });
    await expect(cold.commit(keyed)).resolves.toEqual({
      status: 'replayed',
      commitId: applied.commitId,
      outcome: { workspaceId: 'alpha' },
    });
    await expect(cold.revision(WORKSPACES)).resolves.toBe(1);
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
  });

  it('carries malformed arguments and invalid-state across the host and keeps the worker', async () => {
    const host = createHost();
    await host.reserve({ reservationId: 'live', operation: 'core.x' });

    for (const call of [
      host.retryRecoveryRequiredCommit(1.5),
      host.abandonRecoveryRequiredCommit(0),
      host.resolveRecovery(''),
    ]) {
      await expect(call).rejects.toBeInstanceOf(W5CommitLogHostError);
      await expect(call).rejects.toMatchObject({ reason: 'malformed' });
    }
    const live = host.resolveRecovery('live');
    await expect(live).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(live).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { reservationId: 'live', actual: 'reserved' },
    });
    await expect(host.retryRecoveryRequiredCommit(1)).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { commitId: 1, actual: 'missing' },
    });
    expect((await host.recoveryReport()).reservations).toMatchObject([
      { reservationId: 'live', state: 'reserved' },
    ]);
    expect(host.workersStarted).toBe(1);
  });

  it('treats a recovery result of the wrong shape as outcome unknown', async () => {
    const host = scriptedHost('unexpected-result');
    await expect(
      Promise.all([
        failureOf(host.resolveRecovery('held')),
        failureOf(host.retryRecoveryRequiredCommit(1)),
        failureOf(host.abandonRecoveryRequiredCommit(1)),
      ]),
    ).resolves.toEqual([
      'outcome-unknown',
      'outcome-unknown',
      'outcome-unknown',
    ]);
  });

  it('treats a retry result for another commit as outcome unknown', async () => {
    const host = scriptedHost('other-commit');
    await expect(failureOf(host.retryRecoveryRequiredCommit(1))).resolves.toBe(
      'outcome-unknown',
    );
  });
});

it('retains the latest live reservation diagnostics in the launch recovery report', async () => {
  const diagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId: 'alpha',
    ownedPaths: ['/owned/alpha'],
    phase: 'before-canonical-commit',
  };
  const host = createHost();
  await host.reserve({
    reservationId: 'progress',
    operation: 'core.workspace.create',
    diagnostics,
  });
  const latest = {
    ...diagnostics,
    ownedPaths: ['/owned/alpha', '/owned/member'],
  };
  await host.updateReservationDiagnostics('progress', latest);
  expect((await host.recoveryReport()).reservations).toMatchObject([
    { reservationId: 'progress', state: 'reserved', diagnostics: latest },
  ]);
  await host.shutdown();
  const restarted = createHost();
  const report = await restarted.recoveryReport();
  expect(report.recoveryRequiredReservations).toContain('progress');
  expect(report.reservations).toMatchObject([
    {
      reservationId: 'progress',
      state: 'recovery-required',
      diagnostics: latest,
    },
  ]);
  await expect(
    restarted.updateReservationDiagnostics('progress', latest),
  ).rejects.toBeInstanceOf(W5CommitRefusedError);
});
