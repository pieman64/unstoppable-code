import { StorageWriteRefusedError } from '../../../storage';
import type { W5CaptureResult } from '../commit-log/capture-contract';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5Reservation,
} from '../commit-log/commit-log';
import { W5CommitRefusedError } from '../commit-log/errors';
import { fingerprintW5File } from '../commit-log/fingerprint';
import type { WorkspaceCreationDiagnostics } from '../commit-log/reservation-diagnostics';
import type {
  W5CommitOutcome,
  W5HostRecoveryReport,
} from '../commit-log/worker-contract';
import {
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  type W5CommitLogFileStoreBindings,
  type W5CommitLogHostPort,
} from '../commit-log-file-store';
import { W5AuthorityUnreachableError, type W5FileRead } from '../file-store';
import type { W5StorageTarget } from '../storage-target';

const INDEX: W5StorageTarget = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};
const INDEX_PATH = '/w5/index.json';
const BACKUP_PATH = '/w5/index.json.bak';

function barrier(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface FakeHost extends W5CommitLogHostPort {
  commits: W5CommitRequest[];
  recoveries: number;
  report: W5HostRecoveryReport;
  /** Replaces the next commit's behavior once. */
  nextCommit?: (request: W5CommitRequest) => Promise<W5CommitOutcome>;
}

function applyFiles(
  files: Map<string, string>,
  request: W5CommitRequest,
): void {
  for (const { path, contents } of request.files) {
    if (contents === null) files.delete(path);
    else files.set(path, contents);
  }
}

function fakeHost(files: Map<string, string>): FakeHost {
  const host: FakeHost = {
    root: '/w5',
    commits: [],
    recoveries: 0,
    report: { applied: [], recoveryRequired: [], interruptedReservations: 0 },
    recoveryReport() {
      host.recoveries += 1;
      return Promise.resolve(host.report);
    },
    async commit(request) {
      host.commits.push(request);
      const next = host.nextCommit;
      host.nextCommit = undefined;
      if (next) return next(request);
      applyFiles(files, request);
      return {
        status: 'applied',
        commitId: host.commits.length,
        revisions: {},
      };
    },
    lookupReceipt: () => Promise.resolve({ status: 'none' }),
    reserve: async () => {},
    updateReservationDiagnostics: async () => {},
    releaseReservation: async () => {},
    markReservationRecoveryRequired: async () => {},
    revision: () => Promise.resolve(0),
    capture: () => Promise.reject(new Error('not captured')),
  };
  return host;
}

interface Harness {
  files: Map<string, string>;
  warnings: Array<[string, Record<string, unknown>]>;
  admitted: W5StorageTarget[][];
  lateAdmitted: W5StorageTarget[];
  bindings: Omit<W5CommitLogFileStoreBindings, 'getHost'>;
}

function harness(files = new Map<string, string>()): Harness {
  const warnings: Harness['warnings'] = [];
  const admitted: Harness['admitted'] = [];
  const lateAdmitted: Harness['lateAdmitted'] = [];
  return {
    files,
    warnings,
    admitted,
    lateAdmitted,
    bindings: {
      warn: (message, context) => warnings.push([message, context]),
      readFile: (filePath): Promise<W5FileRead> => {
        const raw = files.get(filePath);
        return Promise.resolve(
          raw === undefined ? { state: 'absent' } : { state: 'present', raw },
        );
      },
      admit: <T>(
        targets: readonly W5StorageTarget[],
        operation: () => Promise<T>,
      ): Promise<T> => {
        admitted.push([...targets]);
        return operation();
      },
      admitWrite: <T>(
        target: W5StorageTarget,
        write: () => Promise<T>,
      ): Promise<T> => {
        lateAdmitted.push(target);
        return write();
      },
    },
  };
}

function replaceIndex(
  store: ReturnType<typeof createW5CommitLogFileStore>,
  contents: string,
  previousRaw: string | null,
): Promise<void> {
  return store.replace(INDEX_PATH, contents, INDEX, {
    operation: 'test.index',
    advance: [{ kind: 'workspaces' }],
    previousRaw,
  });
}

describe('host identity', () => {
  it('serializes final decisions across stores sharing one host object', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const first = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const second = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => Promise.resolve(host),
    });
    const gate = barrier();
    host.nextCommit = async (request): Promise<W5CommitOutcome> => {
      await gate.promise;
      applyFiles(files, request);
      return { status: 'applied', commitId: 1, revisions: {} };
    };
    files.set('/w5/a.json', 'a');
    const one = first.replace('/w5/a.json', 'a2', INDEX, {
      operation: 'one',
      advance: [],
      previousRaw: 'a',
    });
    await tick();
    const two = second.replace(INDEX_PATH, 'b', INDEX, {
      operation: 'two',
      advance: [],
      previousRaw: null,
    });
    await tick();
    await tick();
    // The second store has recovered and now waits on the shared queue.
    expect(host.recoveries).toBe(2);
    expect(host.commits.map((request) => request.operation)).toEqual(['one']);
    gate.open();
    await Promise.all([one, two]);
    expect(host.commits.map((request) => request.operation)).toEqual([
      'one',
      'two',
    ]);
  });

  it('does not serialize stores whose hosts are different objects', async () => {
    const { files, bindings } = harness();
    const blocked = fakeHost(files);
    const other = fakeHost(files);
    const gate = barrier();
    blocked.nextCommit = async (): Promise<W5CommitOutcome> => {
      await gate.promise;
      return { status: 'applied', commitId: 1, revisions: {} };
    };
    const one = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => blocked,
    });
    const two = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => other,
    });
    const pending = replaceIndex(one, 'one', null);
    await tick();
    await replaceIndex(two, 'two', null);
    expect(other.commits).toHaveLength(1);
    gate.open();
    await pending;
  });
});

describe('launch recovery', () => {
  it('shares one attempt, memoizes success and resolves the host once per attempt', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const getHost = jest.fn(() => host);
    const store = createW5CommitLogFileStore({ ...bindings, getHost });
    await Promise.all([store.read(INDEX_PATH), store.read(INDEX_PATH)]);
    await store.readRevisions([{ kind: 'workspaces' }]);
    expect(host.recoveries).toBe(1);
    expect(getHost).toHaveBeenCalledTimes(1);
  });

  it('forwards each host-port call only after recovery', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const calls: string[] = [];
    const gate = barrier();
    const reservation: W5Reservation = {
      reservationId: 'r',
      operation: 'create',
      state: 'reserved',
      diagnostics: null,
    };
    host.recoveryReport = async (): Promise<W5HostRecoveryReport> => {
      calls.push('recoveryReport');
      await gate.promise;
      return {
        applied: [],
        recoveryRequired: [],
        interruptedReservations: 0,
        reservations: [reservation],
      };
    };
    function record<A extends unknown[], R>(
      name: string,
      result: R,
    ): (...args: A) => Promise<R> {
      return (...args) => {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return Promise.resolve(result);
      };
    }
    const receipt = {
      caller: 'c',
      operation: 'create',
      idempotencyKey: 'k',
      fingerprint: 'f',
    };
    const diagnostics: WorkspaceCreationDiagnostics = {
      kind: 'local-workspace-create',
      workspaceId: 'w',
      ownedPaths: [],
      phase: 'before-canonical-commit',
    };
    const failure = { operation: 'create', errorName: 'Error' };
    const captured: W5CaptureResult = {
      files: [],
      discovery: 'not-requested',
      log: {
        commitId: 0,
        retainedCommits: 0,
        unresolvedCommits: 0,
        schemaVersion: 1,
        revisions: {},
        files: [],
        chains: [],
        resourceRevisionEligibility: 'unproven',
      },
    };
    const lookup: W5ReceiptLookup = { status: 'none' };
    host.lookupReceipt = record('lookupReceipt', lookup);
    host.reserve = record('reserve', undefined);
    host.updateReservationDiagnostics = record('update', undefined);
    host.releaseReservation = record('release', undefined);
    host.markReservationRecoveryRequired = record('mark', undefined);
    host.revision = record('revision', 7);
    host.capture = record('capture', captured);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const request = { files: [], discoverWorkspaces: false };
    const results = Promise.all([
      store.lookupReceipt(receipt),
      store.reserve({ reservationId: 'r', operation: 'create', receipt }),
      store.updateReservationDiagnostics('r', diagnostics),
      store.releaseReservation('r'),
      store.markReservationRecoveryRequired('r', failure),
      store.readRevisions([{ kind: 'workspaces' }]),
      store.capture?.(request),
      store.readReservations(),
    ]);
    await tick();
    expect(calls).toEqual(['recoveryReport']);
    gate.open();
    await expect(results).resolves.toEqual([
      lookup,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ resource: { kind: 'workspaces' }, revision: 7 }],
      { capture: captured, root: '/w5' },
      [reservation],
    ]);
    const json = (...args: unknown[]): string => JSON.stringify(args);
    expect(calls).toEqual([
      'recoveryReport',
      `lookupReceipt:${json(receipt)}`,
      `reserve:${json({ reservationId: 'r', operation: 'create', receipt })}`,
      `update:${json('r', diagnostics)}`,
      `release:${json('r')}`,
      `mark:${json('r', failure)}`,
      `revision:${json({ kind: 'workspaces' })}`,
      `capture:${json(request)}`,
      // readReservations reads a fresh report from the recovered host.
      'recoveryReport',
    ]);
  });

  it('shares a failed attempt, then retries on the next call', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const failure = new Error('startup failed');
    const recoveryReport = jest
      .spyOn(host, 'recoveryReport')
      .mockRejectedValueOnce(failure);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await expect(
      Promise.all([store.read(INDEX_PATH), store.read(INDEX_PATH)]),
    ).resolves.toEqual([
      { state: 'unreadable', error: failure },
      { state: 'unreadable', error: failure },
    ]);
    expect(recoveryReport).toHaveBeenCalledTimes(1);
    await expect(store.read(INDEX_PATH)).resolves.toEqual({ state: 'absent' });
    await store.read(INDEX_PATH);
    expect(recoveryReport).toHaveBeenCalledTimes(2);
  });

  it('reports recovery through the warning logger and the W4a diagnostics decoder', async () => {
    const { files, bindings, warnings } = harness();
    const host = fakeHost(files);
    const diagnostics = {
      kind: 'local-workspace-create',
      workspaceId: 'alpha',
      ownedPaths: ['/owned/alpha'],
      phase: 'before-canonical-commit',
      extra: 'stripped',
    };
    host.report = {
      applied: [],
      recoveryRequired: [3, 4],
      interruptedReservations: 2,
      recoveryRequiredDetails: [
        {
          commitId: 3,
          conflictCount: 1,
          writtenFileCount: 0,
          unexpectedFailure: false,
        },
      ],
      recoveryRequiredReservations: ['valid', 'invalid'],
      reservations: [
        {
          reservationId: 'valid',
          operation: 'create',
          state: 'recovery-required',
          diagnostics,
        },
        {
          reservationId: 'invalid',
          operation: 'create',
          state: 'recovery-required',
          diagnostics: { contents: 'never log this' },
        },
      ],
    };
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.read(INDEX_PATH);
    const decoded = {
      kind: diagnostics.kind,
      workspaceId: diagnostics.workspaceId,
      ownedPaths: diagnostics.ownedPaths,
      phase: diagnostics.phase,
    };
    expect(warnings).toEqual([
      [
        'W5 commit requires recovery',
        {
          commitId: 3,
          reason: 'file-apply-incomplete',
          diagnostics: {
            conflictCount: 1,
            writtenFileCount: 0,
            unexpectedFailure: false,
          },
        },
      ],
      [
        'W5 commit requires recovery',
        { commitId: 4, reason: 'file-apply-incomplete' },
      ],
      [
        'W5 reservation requires recovery',
        {
          reservationId: 'valid',
          reason: 'interrupted-operation',
          diagnostics: decoded,
        },
      ],
      [
        'W5 reservation requires recovery',
        { reservationId: 'invalid', reason: 'interrupted-operation' },
      ],
    ]);
  });
});

describe('commit outcomes', () => {
  it('invalidates recovery after a thrown host commit and rethrows the same error', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const failure = new Error('worker stopped');
    host.nextCommit = (): Promise<W5CommitOutcome> => Promise.reject(failure);
    await expect(replaceIndex(store, 'next', null)).rejects.toBe(failure);
    expect(host.recoveries).toBe(1);
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(2);
  });

  it('keeps recovery after a returned recovery-required outcome', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    host.nextCommit = (): Promise<W5CommitOutcome> =>
      Promise.resolve({
        status: 'recovery-required',
        commitId: 9,
        revisions: {},
        apply: { status: 'recovery-required', conflicts: [], written: [] },
      });
    const write = replaceIndex(store, 'next', null);
    await expect(write).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(write).rejects.toMatchObject({
      reason: 'recovery-required',
      details: { commitId: 9 },
    });
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(1);
  });

  it('maps a thrown revision conflict and still invalidates recovery', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    host.nextCommit = (): Promise<W5CommitOutcome> =>
      Promise.reject(
        new W5CommitRefusedError('revision-conflict', 'stale', {
          resource: 'workspaces',
          expected: 1,
          actual: 2,
        }),
      );
    const write = replaceIndex(store, 'next', null);
    await expect(write).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expect(write).rejects.toMatchObject({
      reason: 'revision-conflict',
      resource: 'workspaces',
      expected: 1,
      actual: 2,
    });
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(2);
  });

  it.each([
    ['a revision conflict without numeric details', 'revision-conflict', {}],
    [
      'another refusal with revision details',
      'unapplied-change',
      { expected: 1, actual: 2 },
    ],
  ] as const)('passes %s through unchanged', async (_label, reason, extra) => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const refusal = new W5CommitRefusedError(reason, 'stale', {
      resource: 'workspaces',
      ...extra,
    });
    host.nextCommit = (): Promise<W5CommitOutcome> => Promise.reject(refusal);
    await expect(replaceIndex(store, 'next', null)).rejects.toBe(refusal);
  });

  it('recovers again inside the queue when a preceding decision failed', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const gate = barrier();
    host.nextCommit = async (): Promise<W5CommitOutcome> => {
      await gate.promise;
      throw new Error('worker stopped');
    };
    const failed = replaceIndex(store, 'first', null);
    await tick();
    const queued = store.replace(BACKUP_PATH, 'second', INDEX, {
      operation: 'test.second',
      advance: [],
      previousRaw: null,
    });
    await tick();
    expect(host.recoveries).toBe(1);
    gate.open();
    await expect(failed).rejects.toThrow('worker stopped');
    await queued;
    expect(host.recoveries).toBe(2);
    expect(files.get(BACKUP_PATH)).toBe('second');
  });
});

describe('preflight and staging', () => {
  it('refuses a changed or unreadable file before the decision', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, 'outside']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const stale = replaceIndex(store, 'next', 'read');
    await expect(stale).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    await expect(stale).rejects.toMatchObject({
      reason: 'fingerprint-conflict',
      path: INDEX_PATH,
    });
    const unreadable = createW5CommitLogFileStore({
      ...bindings,
      readFile: (): Promise<W5FileRead> =>
        Promise.resolve({ state: 'unreadable' }),
      getHost: () => host,
    });
    // An absent preimage would match an unreadable read's fingerprint.
    await expect(
      unreadable.replace('/w5/new.json', 'next', INDEX, {
        operation: 'test.new',
        advance: [],
        previousRaw: null,
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commits).toEqual([]);
    expect(files.get(INDEX_PATH)).toBe('outside');
  });

  it('admits a scope once with its staged targets, keeping first preimages and the original backup', async () => {
    const { files, bindings, admitted, lateAdmitted } = harness(
      new Map([[INDEX_PATH, 'v0']]),
    );
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'test.scope' }, async () => {
      // Each write reads its predecessor's staged index and backup images.
      await store.replace(INDEX_PATH, 'v1', INDEX, {
        operation: 'test.index',
        advance: [{ kind: 'workspaces' }],
        previousRaw: 'v0',
        backup: { path: BACKUP_PATH, contents: 'v0', previousRaw: null },
      });
      await store.replace(INDEX_PATH, 'v2', INDEX, {
        operation: 'test.index',
        advance: [{ kind: 'workspaces' }],
        previousRaw: 'v1',
        backup: { path: BACKUP_PATH, contents: 'v1', previousRaw: 'v0' },
      });
      await expect(store.read(INDEX_PATH)).resolves.toEqual({
        state: 'present',
        raw: 'v2',
      });
    });
    expect(admitted).toEqual([[INDEX]]);
    expect(lateAdmitted).toEqual([INDEX, INDEX]);
    expect(host.commits).toHaveLength(1);
    expect(host.commits[0]).toMatchObject({
      operation: 'test.scope',
      advance: [{ kind: 'workspaces' }],
      files: [
        { path: INDEX_PATH, contents: 'v2' },
        { path: BACKUP_PATH, contents: 'v0' },
      ],
    });
    expect(files.get(BACKUP_PATH)).toBe('v0');
  });

  it('backs up the scope preimage when a backup follows an earlier staged write', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, 'v0']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'test.scope' }, async () => {
      await replaceIndex(store, 'v1', 'v0');
      await store.replace(INDEX_PATH, 'v2', INDEX, {
        operation: 'test.index',
        advance: [],
        previousRaw: 'v1',
        backup: { path: BACKUP_PATH, contents: 'v1', previousRaw: null },
      });
    });
    expect(host.commits[0]?.files).toEqual([
      expect.objectContaining({ path: INDEX_PATH, contents: 'v2' }),
      expect.objectContaining({ path: BACKUP_PATH, contents: 'v0' }),
    ]);
  });

  it('stages no backup when the scope created the file', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'test.scope' }, async () => {
      await replaceIndex(store, 'v1', null);
      await store.replace(INDEX_PATH, 'v2', INDEX, {
        operation: 'test.index',
        advance: [],
        previousRaw: 'v1',
        backup: { path: BACKUP_PATH, contents: 'v1', previousRaw: null },
      });
    });
    expect(host.commits[0]?.files).toEqual([
      expect.objectContaining({ path: INDEX_PATH, contents: 'v2' }),
    ]);
  });

  it('fences declared locks at entry and refuses when one changes before the decision', async () => {
    const lockPath = '/w5/a/workspace.json';
    const { files, bindings } = harness(new Map([[lockPath, 'dep']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const fenced = {
      operation: 'test.fence',
      fenceLockedFiles: true,
      locks: [{ kind: 'manifest' as const, path: lockPath }],
    };
    await store.withCommit(fenced, () => replaceIndex(store, 'next', null));
    expect(host.commits[0]?.files).toEqual([
      expect.objectContaining({ path: lockPath, contents: 'dep' }),
      expect.objectContaining({ path: INDEX_PATH, contents: 'next' }),
    ]);
    const refused = store.withCommit(fenced, async () => {
      files.set(lockPath, 'changed');
      await replaceIndex(store, 'again', 'next');
    });
    await expect(refused).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commits).toHaveLength(1);
  });

  it('refuses a fenced lock restaged from a preimage that changed after entry', async () => {
    const lockPath = '/w5/a/workspace.json';
    const { files, bindings } = harness(new Map([[lockPath, 'dep']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const refused = store.withCommit(
      {
        operation: 'test.fence',
        fenceLockedFiles: true,
        locks: [{ kind: 'manifest', path: lockPath }],
      },
      async () => {
        files.set(lockPath, 'changed');
        await store.replace(lockPath, 'next', INDEX, {
          operation: 'test.lock',
          advance: [],
          previousRaw: 'changed',
        });
      },
    );
    await expect(refused).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commits).toEqual([]);
  });

  it('keeps a staged preimage when a nested scope fences the same file', async () => {
    const lockPath = '/w5/a/workspace.json';
    const { files, bindings } = harness(new Map([[lockPath, 'dep']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'test.outer' }, async () => {
      await store.replace(lockPath, 'next', INDEX, {
        operation: 'test.lock',
        advance: [],
        previousRaw: 'dep',
      });
      await store.withCommit(
        {
          operation: 'test.inner',
          fenceLockedFiles: true,
          locks: [{ kind: 'manifest', path: lockPath }],
        },
        () => Promise.resolve(),
      );
    });
    expect(host.commits[0]?.files).toEqual([
      {
        path: lockPath,
        contents: 'next',
        previousFingerprint: fingerprintW5File('dep'),
      },
    ]);
  });

  it('refuses a scoped write over a stale image of its own staged file', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, 'v0']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const refused = store.withCommit({ operation: 'test.scope' }, async () => {
      await replaceIndex(store, 'v1', 'v0');
      await replaceIndex(store, 'v2', 'v0');
    });
    await expect(refused).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commits).toEqual([]);
  });

  it("refuses reads and writes inside another store's scope", async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const one = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const two = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await one.withCommit({ operation: 'test.scope' }, async () => {
      await expect(two.read(INDEX_PATH)).rejects.toThrow('cannot span stores');
      await expect(replaceIndex(two, 'next', null)).rejects.toThrow(
        'cannot span stores',
      );
    });
    expect(host.commits).toEqual([]);
  });

  it('refuses a scoped write when recovery fails, before staging it', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const failure = new Error('startup failed');
    jest.spyOn(host, 'recoveryReport').mockRejectedValueOnce(failure);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'test.scope' }, async () => {
      await expect(replaceIndex(store, 'next', null)).rejects.toBe(failure);
    });
    expect(host.commits).toEqual([]);
  });

  it('sends the scope outcome, signals before the decision and skips an empty scope', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const order: string[] = [];
    host.nextCommit = (request): Promise<W5CommitOutcome> => {
      order.push('commit');
      applyFiles(files, request);
      return Promise.resolve({ status: 'applied', commitId: 1, revisions: {} });
    };
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit(
      {
        operation: 'test.scope',
        outcome: { id: 'w' },
        beforeDecision: () => order.push('before'),
      },
      () => replaceIndex(store, 'next', null),
    );
    expect(order).toEqual(['before', 'commit']);
    expect(host.commits[0]?.outcome).toEqual({ id: 'w' });
    await store.withCommit({ operation: 'test.empty' }, () =>
      Promise.resolve(),
    );
    expect(host.commits).toHaveLength(1);
  });

  it('refuses an unadmittable writer before admission or recovery', async () => {
    const { files, bindings, lateAdmitted } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await expect(
      store.replace(
        INDEX_PATH,
        'next',
        { namespace: 'workspace_index', writer: 'daemon' },
        { operation: 'test.daemon', advance: [], previousRaw: null },
      ),
    ).rejects.toBeInstanceOf(StorageWriteRefusedError);
    expect(lateAdmitted).toEqual([]);
    expect(host.recoveries).toBe(0);
  });

  it('propagates a failed admission without committing', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const refusal = new Error('not admitted');
    const store = createW5CommitLogFileStore({
      ...bindings,
      admitWrite: () => Promise.reject(refusal),
      getHost: () => host,
    });
    await expect(replaceIndex(store, 'next', null)).rejects.toBe(refusal);
    expect(host.commits).toEqual([]);
  });
});

describe('an unreachable authority (CAN-5542)', () => {
  const lost = (): W5AuthorityUnreachableError =>
    new W5AuthorityUnreachableError('refused', 'lost');

  /** `bindings`' reads, failing unreachable while `down` holds. */
  function lossyReads(
    bindings: Harness['bindings'],
    down: () => W5AuthorityUnreachableError | undefined,
  ): Harness['bindings'] {
    return {
      ...bindings,
      readFile: (filePath): Promise<W5FileRead> => {
        const error = down();
        return error
          ? Promise.resolve({ state: 'unreadable', error })
          : bindings.readFile(filePath);
      },
    };
  }

  it('rethrows a preflight read that could not reach the authority, never a fingerprint conflict', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, 'read']]));
    const host = fakeHost(files);
    const unreachable = lost();
    const store = createW5CommitLogFileStore({
      ...lossyReads(bindings, () => unreachable),
      getHost: () => host,
    });
    await expect(replaceIndex(store, 'next', 'read')).rejects.toBe(unreachable);
    expect(host.commits).toEqual([]);
    expect(files.get(INDEX_PATH)).toBe('read');
  });

  it('rethrows a fenced lock read that could not reach the authority', async () => {
    const lockPath = '/w5/a/workspace.json';
    const { files, bindings } = harness(new Map([[lockPath, 'dep']]));
    const host = fakeHost(files);
    const unreachable = lost();
    const store = createW5CommitLogFileStore({
      ...lossyReads(bindings, () => unreachable),
      getHost: () => host,
    });
    const work = jest.fn(() => replaceIndex(store, 'next', null));
    await expect(
      store.withCommit(
        {
          operation: 'test.fence',
          fenceLockedFiles: true,
          locks: [{ kind: 'manifest', path: lockPath }],
        },
        work,
      ),
    ).rejects.toBe(unreachable);
    expect(work).not.toHaveBeenCalled();
    expect(host.commits).toEqual([]);
  });

  it('recovers again after a read the authority could not answer, and keeps recovery after any other unreadable read', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    let failure: W5FileRead | undefined;
    const store = createW5CommitLogFileStore({
      ...bindings,
      readFile: (filePath): Promise<W5FileRead> =>
        failure ? Promise.resolve(failure) : bindings.readFile(filePath),
      getHost: () => host,
    });
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(1);
    failure = { state: 'unreadable', error: new Error('EACCES') };
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(1);
    const unreachable = lost();
    failure = { state: 'unreadable', error: unreachable };
    await expect(store.read(INDEX_PATH)).resolves.toEqual(failure);
    failure = undefined;
    // A restarted daemon's recovery warnings are read again.
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(2);
  });

  it.each([
    [
      'a receipt lookup',
      (host: FakeHost): jest.SpyInstance => jest.spyOn(host, 'lookupReceipt'),
      (
        store: ReturnType<typeof createW5CommitLogFileStore>,
      ): Promise<unknown> =>
        store.lookupReceipt({
          caller: 'c',
          operation: 'o',
          idempotencyKey: 'k',
          fingerprint: 'f',
        }),
    ],
    [
      'a reservation',
      (host: FakeHost): jest.SpyInstance => jest.spyOn(host, 'reserve'),
      (
        store: ReturnType<typeof createW5CommitLogFileStore>,
      ): Promise<unknown> =>
        store.reserve({ reservationId: 'r', operation: 'o' }),
    ],
    [
      'a reservation release',
      (host: FakeHost): jest.SpyInstance =>
        jest.spyOn(host, 'releaseReservation'),
      (
        store: ReturnType<typeof createW5CommitLogFileStore>,
      ): Promise<unknown> => store.releaseReservation('r'),
    ],
    [
      'a revision read',
      (host: FakeHost): jest.SpyInstance => jest.spyOn(host, 'revision'),
      (
        store: ReturnType<typeof createW5CommitLogFileStore>,
      ): Promise<unknown> => store.readRevisions([{ kind: 'workspaces' }]),
    ],
  ])(
    'recovers again after %s could not reach the authority, rethrowing it',
    async (_label, spy, call) => {
      const { files, bindings } = harness();
      const host = fakeHost(files);
      const store = createW5CommitLogFileStore({
        ...bindings,
        getHost: () => host,
      });
      await store.read(INDEX_PATH);
      const unreachable = new W5AuthorityUnreachableError(
        'outcome-unknown',
        'lost',
      );
      spy(host).mockRejectedValueOnce(unreachable);
      await expect(call(store)).rejects.toBe(unreachable);
      expect(host.recoveries).toBe(1);
      await call(store);
      expect(host.recoveries).toBe(2);
    },
  );

  it('forgets only the recovery a failed call rode, never a newer one', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.read(INDEX_PATH);
    let failLate: (error: unknown) => void = () => undefined;
    const late = new Promise<never>((_resolve, reject) => {
      failLate = reject;
    });
    late.catch(() => undefined);
    jest
      .spyOn(host, 'releaseReservation')
      .mockRejectedValueOnce(lost())
      .mockReturnValueOnce(late);
    const first = store.releaseReservation('a');
    const second = store.releaseReservation('b');
    await expect(first).rejects.toBeInstanceOf(W5AuthorityUnreachableError);
    // A reconnected caller starts the next recovery before the late failure.
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(2);
    failLate(lost());
    await expect(second).rejects.toBeInstanceOf(W5AuthorityUnreachableError);
    await store.read(INDEX_PATH);
    expect(host.recoveries).toBe(2);
  });

  it('keeps recovery after a keyed call fails with any other error', async () => {
    const { files, bindings } = harness();
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    const refusal = new W5CommitRefusedError('in-progress', 'busy', {});
    jest.spyOn(host, 'reserve').mockRejectedValueOnce(refusal);
    await expect(
      store.reserve({ reservationId: 'r', operation: 'o' }),
    ).rejects.toBe(refusal);
    await store.reserve({ reservationId: 'r', operation: 'o' });
    expect(host.recoveries).toBe(1);
  });
});

it('loads its entrypoint without node:sqlite', () => {
  jest.isolateModules(() => {
    jest.doMock('node:sqlite', () => {
      throw new Error('node:sqlite was loaded');
    });
    expect((): void => {
      jest.requireActual<object>('../commit-log-file-store');
    }).not.toThrow();
  });
});

describe('record removal', () => {
  it('stages absence, then recreates against the original preimage in one decision', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, '{}']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.withCommit({ operation: 'remove-recreate' }, async () => {
      await store.remove(INDEX_PATH, INDEX, {
        operation: 'remove',
        advance: [{ kind: 'workspaces' }],
        previousRaw: '{}',
      });
      expect(await store.read(INDEX_PATH)).toEqual({ state: 'absent' });
      expect(files.get(INDEX_PATH)).toBe('{}');
      await replaceIndex(store, '{"new":true}', null);
    });
    expect(host.commits).toHaveLength(1);
    expect(host.commits[0]?.files).toEqual([
      {
        path: INDEX_PATH,
        contents: '{"new":true}',
        previousFingerprint: fingerprintW5File('{}'),
      },
    ]);
  });

  it('commits an unscoped removal and refuses an unreadable preflight without deciding', async () => {
    const { files, bindings } = harness(new Map([[INDEX_PATH, '{}']]));
    const host = fakeHost(files);
    const store = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await store.remove(INDEX_PATH, INDEX, {
      operation: 'remove',
      advance: [{ kind: 'workspaces' }],
      previousRaw: '{}',
    });
    expect(await store.read(INDEX_PATH)).toEqual({ state: 'absent' });
    expect(host.commits[0]?.files[0]?.contents).toBeNull();
    bindings.readFile = (): Promise<W5FileRead> =>
      Promise.resolve({ state: 'unreadable' });
    const unreadable = createW5CommitLogFileStore({
      ...bindings,
      getHost: () => host,
    });
    await expect(
      unreadable.remove(INDEX_PATH, INDEX, {
        operation: 'remove',
        advance: [],
        previousRaw: null,
      }),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commits).toHaveLength(1);
  });
});
