import { join } from 'node:path';
import type { JournalEntry } from '../../../kernel/event-journal';
import type { CoreEventRecord } from '../../../kernel/core-events-module';
import type {
  W5CommitRequest,
  W5ReservationFailureDiagnostics,
} from '../commit-log/commit-log';
import { W5CommitRefusedError } from '../commit-log/errors';
import type { WorkspaceCreationDiagnostics } from '../commit-log/reservation-diagnostics';
import type {
  W5CommitOutcome,
  W5HostRecoveryReport,
} from '../commit-log/worker-contract';
import {
  classifyW5CommitFile,
  createW5CommitEventSource,
  type W5CommitEventHost,
} from '../commit-events';
import {
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
  type W5CommitLogHostPort,
} from '../commit-log-file-store';
import { W5CommitLogHostError } from '../commit-log-host';
import type { W5FileRead } from '../file-store';
import type { W5StorageTarget } from '../storage-target';

const ROOT = join('/data', 'workspaces');
const EPOCH = 'runtime:source-test';
const LIST: W5StorageTarget = {
  namespace: 'worktree_list',
  writer: 'electron_main',
};

interface FakeHost extends W5CommitEventHost {
  /** As the real host counts it: before the worker's launch recovery. */
  workersStarted: number;
  recoveredWorker: number;
  report: W5HostRecoveryReport;
  /** Replaces the next commit's behavior once. */
  next?: (request: W5CommitRequest) => Promise<W5CommitOutcome>;
  active: number;
  maxActive: number;
  commits: number;
  /** A worker exits, as the real host reports it. */
  exit(): void;
}

function fakeHost(): FakeHost {
  const unused = (): Promise<never> => Promise.reject(new Error('unused'));
  const exitListeners = new Set<() => void>();
  const host: FakeHost = {
    root: ROOT,
    workersStarted: 1,
    recoveredWorker: 1,
    report: { applied: [], recoveryRequired: [], interruptedReservations: 0 },
    active: 0,
    maxActive: 0,
    commits: 0,
    recoveryReport: () => Promise.resolve(host.report),
    async commit(request) {
      host.active += 1;
      host.maxActive = Math.max(host.maxActive, host.active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const next = host.next;
        host.next = undefined;
        if (next) return await next(request);
        host.commits += 1;
        return {
          status: 'applied',
          commitId: host.commits,
          revisions: Object.fromEntries(
            request.advance.map((resource) => [
              resource.kind === 'workspaces'
                ? 'workspaces'
                : resource.kind === 'worktree'
                  ? `worktree:${resource.workspaceId}/${resource.worktreeId}`
                  : `${resource.kind}:${resource.workspaceId}`,
              host.commits + 10,
            ]),
          ),
        };
      } finally {
        host.active -= 1;
      }
    },
    lookupReceipt: () => Promise.resolve({ status: 'none' }),
    reserve: () => Promise.resolve(),
    updateReservationDiagnostics: () => Promise.resolve(),
    releaseReservation: () => Promise.resolve(),
    markReservationRecoveryRequired: () => Promise.resolve(),
    revision: () => Promise.resolve(0),
    capture: unused,
    onWorkerExit(listener) {
      exitListeners.add(listener);
      return () => void exitListeners.delete(listener);
    },
    exit() {
      for (const listener of exitListeners) listener();
    },
  };
  return host;
}

function source(host = fakeHost()): {
  host: FakeHost;
  entries: JournalEntry<CoreEventRecord>[];
  events: ReturnType<typeof createW5CommitEventSource>;
} {
  const events = createW5CommitEventSource({
    host,
    epoch: EPOCH,
    now: () => new Date('2026-10-31T00:00:00.000Z'),
  });
  const entries: JournalEntry<CoreEventRecord>[] = [];
  const subscribed = events.journal.subscribe(
    { daemonEpoch: EPOCH, sequence: 0 },
    (entry) => void entries.push(entry),
  );
  if (subscribed.kind !== 'subscribed') throw new Error('journal refused');
  return { host, entries, events };
}

const RECEIPT: NonNullable<W5CommitRequest['receipt']> = {
  caller: 'portal:1',
  operation: 'core.workspace.create',
  idempotencyKey: 'k1',
  fingerprint: 'f1',
};

const DIAGNOSTICS: WorkspaceCreationDiagnostics = {
  kind: 'local-workspace-create',
  workspaceId: 'ws-1',
  ownedPaths: [],
  phase: 'before-canonical-commit',
};
const FAILURE: W5ReservationFailureDiagnostics = {
  operation: 'test.write',
  errorName: 'Error',
};

const request = (
  overrides: Partial<W5CommitRequest> = {},
): W5CommitRequest => ({
  operation: 'test.write',
  advance: [{ kind: 'worktrees', workspaceId: 'ws-1' }],
  files: [
    {
      path: join(ROOT, 'ws-1', 'worktrees.json'),
      contents: '[]',
      previousFingerprint: null,
    },
  ],
  outcome: null,
  ...overrides,
});

const names = (entries: JournalEntry<CoreEventRecord>[]): string[] =>
  entries.map((entry) => entry.event.name);

/** A replacement worker that has started and finished its launch recovery. */
function replaceWorker(host: FakeHost, worker: number): void {
  host.workersStarted = worker;
  host.recoveredWorker = worker;
}

const unavailable = (): W5CommitLogHostError =>
  new W5CommitLogHostError('unavailable', 'busy');

type HostCall = Exclude<keyof W5CommitLogHostPort, 'root' | 'commitQueueKey'>;

/** Every observing call a view makes, issued once. */
const VIEW_CALLS: ReadonlyArray<
  [HostCall, (port: W5CommitLogHostPort) => Promise<unknown>]
> = [
  ['recoveryReport', (port) => port.recoveryReport()],
  ['commit', (port) => port.commit(request())],
  ['lookupReceipt', (port) => port.lookupReceipt(RECEIPT)],
  [
    'reserve',
    (port) => port.reserve({ reservationId: 'r-1', operation: 'test.write' }),
  ],
  [
    'updateReservationDiagnostics',
    (port) => port.updateReservationDiagnostics('r-1', DIAGNOSTICS),
  ],
  ['releaseReservation', (port) => port.releaseReservation('r-1')],
  [
    'markReservationRecoveryRequired',
    (port) => port.markReservationRecoveryRequired('r-1', FAILURE),
  ],
  ['revision', (port) => port.revision({ kind: 'workspaces' })],
  ['capture', (port) => port.capture({ files: [], discoverWorkspaces: false })],
];

describe('W5 commit event source', () => {
  it('publishes exactly one path-free committed event per applied commit', async () => {
    const { entries, events } = source();
    await events.port().commit(
      request({
        advance: [
          { kind: 'workspaces' },
          { kind: 'workspace', workspaceId: 'ws-1' },
          { kind: 'worktree', workspaceId: 'ws-1', worktreeId: 'wt-1' },
        ],
        files: [
          {
            path: join(ROOT, 'index.json'),
            contents: '{}',
            previousFingerprint: null,
          },
          {
            path: join(ROOT, 'index.json.bak'),
            contents: '{}',
            previousFingerprint: null,
          },
          {
            path: join(ROOT, 'ws-1', 'workspace.json'),
            contents: '{}',
            previousFingerprint: null,
          },
          {
            path: join(ROOT, 'ws-1', 'notes.json'),
            contents: '{}',
            previousFingerprint: null,
          },
          {
            path: join('/elsewhere', 'index.json'),
            contents: '{}',
            previousFingerprint: null,
          },
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toEqual({
      name: 'core.workspace.committed',
      scope: { workspaceId: 'ws-1' },
      occurredAt: '2026-10-31T00:00:00.000Z',
      payload: {
        commit: 'w5:1',
        changes: [
          { kind: 'index', revision: 11 },
          { kind: 'workspace', workspaceId: 'ws-1', revision: 11 },
          {
            kind: 'worktree',
            workspaceId: 'ws-1',
            worktreeId: 'wt-1',
            revision: 11,
          },
        ],
        files: [
          { kind: 'index' },
          { kind: 'index-backup' },
          { kind: 'manifest', workspaceId: 'ws-1' },
        ],
      },
    });
    expect(JSON.stringify(entries[0]?.event)).not.toContain('/data');
  });

  it('attributes commits made through an attributed view', async () => {
    const { entries, events } = source();
    const electron = events.port({ publishedBy: 'desktop-1' });
    expect(events.port({ publishedBy: 'desktop-1' })).toBe(electron);
    expect(events.port()).not.toBe(electron);
    await electron.commit(request());
    await events.port().commit(request());
    expect(entries.map((entry) => entry.event.payload.publishedBy)).toEqual([
      'desktop-1',
      undefined,
    ]);
  });

  it('scopes a commit spanning several workspaces to none', async () => {
    const { entries, events } = source();
    await events.port().commit(
      request({
        advance: [
          { kind: 'worktrees', workspaceId: 'ws-1' },
          { kind: 'worktrees', workspaceId: 'ws-2' },
        ],
        files: [],
      }),
    );
    expect(entries[0]?.event.scope).toEqual({});
  });

  it.each<[string, (request: W5CommitRequest) => Promise<W5CommitOutcome>]>([
    [
      'recovery-required',
      (): Promise<W5CommitOutcome> =>
        Promise.resolve({
          status: 'recovery-required',
          commitId: 9,
          revisions: {},
          apply: { status: 'recovery-required', conflicts: [], written: [] },
        }),
    ],
    [
      'replayed',
      (): Promise<W5CommitOutcome> =>
        Promise.resolve({ status: 'replayed', commitId: 3, outcome: null }),
    ],
    [
      'replay-expired',
      (): Promise<W5CommitOutcome> =>
        Promise.resolve({ status: 'replay-expired', commitId: 3 }),
    ],
    [
      'a refusal',
      (): Promise<W5CommitOutcome> =>
        Promise.reject(
          new W5CommitRefusedError('revision-conflict', 'refused', {}),
        ),
    ],
    [
      'a malformed request',
      (): Promise<W5CommitOutcome> =>
        Promise.reject(new W5CommitLogHostError('malformed', 'bad')),
    ],
    [
      'an unsent call',
      (): Promise<W5CommitOutcome> =>
        Promise.reject(new W5CommitLogHostError('unavailable', 'busy')),
    ],
  ])('publishes nothing for %s', async (_name, outcome) => {
    const { host, entries, events } = source();
    host.next = outcome;
    await events
      .port()
      .commit(request())
      .catch(() => undefined);
    expect(entries).toEqual([]);
  });

  it('publishes nothing for a commit refused at preflight', async () => {
    const { host, entries, events } = source();
    const commit = jest.spyOn(host, 'commit');
    const store = createW5CommitLogFileStore({
      getHost: () => events.port(),
      warn: () => undefined,
      readFile: (): Promise<W5FileRead> =>
        Promise.resolve({ state: 'present', raw: 'changed underneath' }),
      admit: (_targets, work) => work(),
      admitWrite: (_target, work) => work(),
    });
    await expect(
      store.replace(join(ROOT, 'ws-1', 'worktrees.json'), '[]', LIST, {
        previousRaw: null,
        operation: 'test.write',
        advance: [{ kind: 'worktrees', workspaceId: 'ws-1' }],
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(commit).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it.each([
    [
      'an outcome-unknown failure',
      new W5CommitLogHostError('outcome-unknown', 'stopped'),
    ],
    ['an unexpected error', new Error('surprise')],
  ])('publishes invalidated, never committed, for %s', async (_name, error) => {
    const { host, entries, events } = source();
    host.next = (): Promise<W5CommitOutcome> => Promise.reject(error);
    await expect(events.port().commit(request())).rejects.toBe(error);
    expect(entries.map((entry) => entry.event)).toEqual([
      expect.objectContaining({
        name: 'core.workspace.invalidated',
        scope: {},
        payload: { reason: 'uncertain' },
      }),
    ]);
  });

  it('publishes a recovery before anything a replacement worker answers', async () => {
    const { host, entries, events } = source();
    const port = events.port();
    host.next = (): Promise<W5CommitOutcome> =>
      Promise.reject(new W5CommitLogHostError('outcome-unknown', 'x'));
    await port.commit(request()).catch(() => undefined);
    // The store asks the replacement worker, which recovered commit 1.
    host.commits = 1;
    replaceWorker(host, 2);
    host.report = { ...host.report, applied: [1] };
    await port.recoveryReport();
    await port.commit(request());
    // A worker that is not asked for its report still invalidates first.
    replaceWorker(host, 3);
    await port.commit(request());
    expect(names(entries)).toEqual([
      'core.workspace.invalidated',
      'core.workspace.invalidated',
      'core.workspace.committed',
      'core.workspace.invalidated',
      'core.workspace.committed',
    ]);
    expect(entries.map((entry) => entry.event.payload)).toEqual([
      { reason: 'uncertain' },
      { reason: 'recovered', commits: ['w5:1'] },
      expect.objectContaining({ commit: 'w5:2' }),
      { reason: 'recovered' },
      expect.objectContaining({ commit: 'w5:3' }),
    ]);
    // A report proving nothing was applied publishes nothing.
    replaceWorker(host, 4);
    host.report = { ...host.report, applied: [] };
    await port.recoveryReport();
    expect(entries).toHaveLength(5);
  });

  // CAN-5497 review b89f3b44: the host counts a worker as started before its
  // launch recovery runs, and refuses an overflowing call at once.
  it.each(VIEW_CALLS)(
    'observes a replacement worker only after its launch recovery, even when %s is refused first',
    async (method, call) => {
      const { host, entries, events } = source();
      const port = events.port();
      host.workersStarted = 2;
      const refused = jest
        .spyOn(host, method)
        .mockRejectedValueOnce(unavailable());
      await expect(call(port)).rejects.toBeInstanceOf(W5CommitLogHostError);
      expect(refused).toHaveBeenCalledTimes(1);
      expect(entries).toEqual([]);
      // Launch recovery then applies pending commit 42.
      host.recoveredWorker = 2;
      host.commits = 42;
      host.report = { ...host.report, applied: [42] };
      await call(port).catch(() => undefined);
      expect(entries.map((entry) => entry.event)[0]).toEqual(
        expect.objectContaining({
          name: 'core.workspace.invalidated',
          payload:
            method === 'recoveryReport'
              ? { reason: 'recovered', commits: ['w5:42'] }
              : { reason: 'recovered' },
        }),
      );
      expect(
        names(entries).filter((name) => name.endsWith('invalidated')),
      ).toHaveLength(1);
    },
  );

  // CAN-5497: a replacement worker can apply part of its launch recovery and
  // then fail before it is ready. Its refused calls changed nothing, so they
  // publish nothing; its exit, once its effects are on disk, invalidates.
  it('invalidates when a worker exits, even one that failed before it was ready', async () => {
    const { host, entries, events } = source();
    const port = events.port();
    host.workersStarted = 2;
    jest.spyOn(host, 'revision').mockRejectedValueOnce(unavailable());
    await expect(port.revision({ kind: 'workspaces' })).rejects.toBeInstanceOf(
      W5CommitLogHostError,
    );
    expect(entries).toEqual([]);
    host.exit();
    expect(entries.map((entry) => entry.event.payload)).toEqual([
      { reason: 'uncertain' },
    ]);
    // Its replacement then recovers what it left: not proof of worker 2.
    host.workersStarted = 3;
    host.recoveredWorker = 3;
    await port.recoveryReport();
    expect(entries.map((entry) => entry.event.payload)).toEqual([
      { reason: 'uncertain' },
      { reason: 'recovered' },
    ]);
  });

  it('trusts an empty report only from the next worker after the last observed one', async () => {
    const { host, entries, events } = source();
    const port = events.port();
    // Worker 2 started and may have recovered part of a commit, but failed
    // before it was ready; worker 3 then found nothing left to apply.
    host.workersStarted = 3;
    host.recoveredWorker = 3;
    await port.recoveryReport();
    expect(entries.map((entry) => entry.event.payload)).toEqual([
      { reason: 'recovered' },
    ]);
  });

  it('keeps journal order equal to commit order across views and guards it', async () => {
    const { host, entries, events } = source();
    const views: W5CommitLogHostPort[] = [
      events.port({ publishedBy: 'desktop-1' }),
      events.port(),
    ];
    const stores = views.map((view) =>
      createW5CommitLogFileStore({
        getHost: () => view,
        warn: () => undefined,
        readFile: (): Promise<W5FileRead> =>
          Promise.resolve({ state: 'absent' }),
        admit: (_targets, work) => work(),
        admitWrite: (_target, work) => work(),
      }),
    );
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        stores[index % 2]?.replace(
          join(ROOT, `ws-${index}`, 'worktrees.json'),
          '[]',
          LIST,
          {
            previousRaw: null,
            operation: 'test.write',
            advance: [{ kind: 'worktrees', workspaceId: `ws-${index}` }],
          },
        ),
      ),
    );
    // Both views share the host's final-decision queue.
    expect(host.maxActive).toBe(1);
    expect(entries.map((entry) => entry.event.payload.commit)).toEqual([
      'w5:1',
      'w5:2',
      'w5:3',
      'w5:4',
      'w5:5',
      'w5:6',
    ]);
    host.next = (): Promise<W5CommitOutcome> =>
      Promise.resolve({ status: 'applied', commitId: 2, revisions: {} });
    await views[1]?.commit(request());
    expect(entries.at(-1)?.event).toMatchObject({
      name: 'core.workspace.invalidated',
      payload: { reason: 'uncertain', commits: ['w5:2'] },
    });
  });
});

describe('classifyW5CommitFile', () => {
  it('maps only the four W5 files under the root', () => {
    expect(classifyW5CommitFile(ROOT, join(ROOT, 'index.json'))).toEqual({
      kind: 'index',
    });
    expect(
      classifyW5CommitFile(ROOT, join(ROOT, 'ws', 'worktrees.json')),
    ).toEqual({ kind: 'worktrees', workspaceId: 'ws' });
    for (const path of [
      ROOT,
      join(ROOT, '..', 'index.json'),
      join(ROOT, 'ws', 'nested', 'workspace.json'),
      join(ROOT, 'con', 'workspace.json'),
      join(ROOT, 'other.json'),
    ])
      expect(classifyW5CommitFile(ROOT, path)).toBeNull();
  });
});
