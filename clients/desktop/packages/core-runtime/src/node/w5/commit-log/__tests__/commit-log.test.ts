import type { WorkspaceCreationDiagnostics } from '../reservation-diagnostics';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  W5CommitLog,
  W5_COMMIT_LOG_SCHEMA_VERSION,
  W5CommitRefusedError,
  fingerprintW5File,
  type W5CommitRequest,
  type W5ReceiptKey,
  type W5Resource,
} from '..';

const workspaces: W5Resource = { kind: 'workspaces' };
const alpha: W5Resource = { kind: 'workspace', workspaceId: 'alpha' };
const bravo: W5Resource = { kind: 'workspace', workspaceId: 'bravo' };

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

let dir: string;
let dbPath: string;
let log: W5CommitLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-commit-log-'));
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  log = W5CommitLog.open(dbPath);
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function change(overrides: Partial<W5CommitRequest> = {}): W5CommitRequest {
  return {
    operation: 'core.workspace.update',
    advance: [alpha],
    files: [
      {
        path: join(dir, 'alpha.json'),
        contents: '{"name":"Alpha"}',
        previousFingerprint: null,
      },
    ],
    outcome: { workspaceId: 'alpha' },
    ...overrides,
  };
}

const key: W5ReceiptKey = {
  caller: 'portal:1',
  operation: 'core.workspace.update',
  idempotencyKey: 'k1',
};

function refusal(run: () => unknown): W5CommitRefusedError {
  try {
    run();
  } catch (error) {
    if (error instanceof W5CommitRefusedError) return error;
    throw error;
  }
  throw new Error('Expected the commit to be refused');
}

describe('W5 commit log (CAN-3805)', () => {
  it('refuses a second writer while the first holds the log', () => {
    expect(thrown(() => W5CommitLog.open(dbPath, 0))).toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
  });

  it('never opens a log written by a newer schema', () => {
    log.close();
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(`UPDATE w5_meta SET value = ? WHERE key = 'schema_version'`)
      .run(String(W5_COMMIT_LOG_SCHEMA_VERSION + 1));
    raw.close();

    expect(thrown(() => W5CommitLog.open(dbPath))).toMatchObject({
      code: 'UNSUPPORTED_SCHEMA',
    });
    log = W5CommitLog.open(join(dir, 'other.sqlite'));
  });

  describe('revisions (CAN-3799 D4)', () => {
    it('starts every resource at 0 and advances each one by one per change', () => {
      expect(log.revision(alpha)).toBe(0);

      const first = log.commit(change({ advance: [alpha, workspaces] }));
      const second = log.commit(
        change({ advance: [alpha], files: [], outcome: null }),
      );

      expect(first).toMatchObject({
        status: 'committed',
        revisions: { 'workspace:alpha': 1, workspaces: 1 },
      });
      expect(second).toMatchObject({
        revisions: { 'workspace:alpha': 2 },
      });
      expect(log.revision(workspaces)).toBe(1);
    });

    it('refuses a stale edit and changes nothing', () => {
      log.commit(change({ files: [] }));
      const before = log.revision(alpha);

      const error = refusal(() =>
        log.commit(
          change({
            receipt: { ...key, fingerprint: 'f1' },
            expectedRevisions: [{ resource: alpha, revision: 0 }],
          }),
        ),
      );

      expect(error).toMatchObject({
        reason: 'revision-conflict',
        details: { resource: 'workspace:alpha', expected: 0, actual: 1 },
      });
      expect(log.revision(alpha)).toBe(before);
      expect(log.listPendingCommits()).toHaveLength(1);
      expect(log.lookupReceipt(key, 'f1')).toEqual({ status: 'none' });
    });

    it('never lets an edit to one workspace conflict with an edit to another', () => {
      log.commit(change({ advance: [bravo], files: [] }));

      expect(
        log.commit(
          change({
            files: [],
            expectedRevisions: [{ resource: alpha, revision: 0 }],
          }),
        ),
      ).toMatchObject({ status: 'committed' });
    });
  });

  describe('receipts', () => {
    it('replays a committed outcome for the same key and parameters, before any revision check', () => {
      const first = log.commit(
        change({
          receipt: { ...key, fingerprint: 'f1' },
          expectedRevisions: [{ resource: alpha, revision: 0 }],
        }),
      );
      // The target moved on (or was deleted) since the first attempt.
      log.commit(
        change({
          operation: 'core.workspace.delete',
          files: [],
          outcome: null,
        }),
      );

      expect(
        log.commit(
          change({
            receipt: { ...key, fingerprint: 'f1' },
            expectedRevisions: [{ resource: alpha, revision: 0 }],
          }),
        ),
      ).toEqual({
        status: 'replayed',
        commitId: first.commitId,
        outcome: { workspaceId: 'alpha' },
      });
      expect(log.revision(alpha)).toBe(2);
    });

    it('refuses a key reused with other parameters', () => {
      log.commit(change({ files: [], receipt: { ...key, fingerprint: 'f1' } }));

      expect(log.lookupReceipt(key, 'f2')).toEqual({ status: 'key-reused' });
      expect(
        refusal(() =>
          log.commit(
            change({ files: [], receipt: { ...key, fingerprint: 'f2' } }),
          ),
        ).reason,
      ).toBe('key-reused');
    });

    it('scopes keys to their caller', () => {
      log.commit(change({ files: [], receipt: { ...key, fingerprint: 'f1' } }));

      expect(
        log.commit(
          change({
            files: [],
            receipt: { ...key, caller: 'portal:2', fingerprint: 'f2' },
          }),
        ),
      ).toMatchObject({ status: 'committed' });
    });
  });

  describe('reservations (CAN-3799 D3)', () => {
    const reserved = (): void =>
      log.reserve({
        reservationId: 'op-1',
        operation: key.operation,
        receipt: { ...key, fingerprint: 'f1' },
        diagnostics: { clone: '/repos/app' },
      });

    it('refuses a concurrent duplicate and lets its own reservation commit', () => {
      reserved();

      expect(log.lookupReceipt(key, 'f1')).toEqual({
        status: 'in-progress',
        reservationId: 'op-1',
      });
      expect(
        refusal(() =>
          log.commit(
            change({ files: [], receipt: { ...key, fingerprint: 'f1' } }),
          ),
        ).reason,
      ).toBe('in-progress');

      log.commit(
        change({
          files: [],
          receipt: { ...key, fingerprint: 'f1' },
          reservationId: 'op-1',
        }),
      );
      expect(log.listReservations()).toEqual([]);
      expect(log.lookupReceipt(key, 'f1')).toMatchObject({ status: 'replay' });
    });

    it('turns a reservation an earlier process held into a recovery that blocks its key', () => {
      reserved();
      log.close();
      log = W5CommitLog.open(dbPath);

      expect(log.markInterruptedReservations()).toBe(1);
      expect(log.lookupReceipt(key, 'f1')).toEqual({
        status: 'recovery-required',
        reservationId: 'op-1',
        diagnostics: { clone: '/repos/app' },
      });
      expect(
        refusal(() =>
          log.commit(
            change({ files: [], receipt: { ...key, fingerprint: 'f1' } }),
          ),
        ).reason,
      ).toBe('recovery-required');

      log.resolveRecovery('op-1');
      expect(log.lookupReceipt(key, 'f1')).toEqual({ status: 'none' });
    });

    it('refuses the key of a held reservation with other parameters', () => {
      reserved();

      expect(log.lookupReceipt(key, 'f2')).toEqual({ status: 'key-reused' });
      expect(
        refusal(() =>
          log.commit(
            change({
              files: [],
              receipt: { ...key, fingerprint: 'f2' },
              reservationId: 'op-1',
            }),
          ),
        ).reason,
      ).toBe('key-reused');
      expect(log.listReservations()).toHaveLength(1);
    });

    it('never lets a commit complete a reservation awaiting recovery', () => {
      reserved();
      log.markInterruptedReservations();

      expect(
        refusal(() => log.commit(change({ files: [], reservationId: 'op-1' })))
          .reason,
      ).toBe('recovery-required');
      expect(log.listReservations()).toEqual([
        expect.objectContaining({ state: 'recovery-required' }),
      ]);
    });

    it('refuses a commit that names a reservation it does not hold', () => {
      expect(
        refusal(() =>
          log.commit(change({ files: [], reservationId: 'missing' })),
        ).reason,
      ).toBe('unknown-reservation');
    });

    it('releases a reservation whose operation failed before any effect', () => {
      reserved();
      log.releaseReservation('op-1');

      expect(log.lookupReceipt(key, 'f1')).toEqual({ status: 'none' });
    });
  });

  it('refuses a change to a file with a committed change still unapplied', () => {
    const first = log.commit(change());

    expect(
      refusal(() =>
        log.commit(
          change({
            files: [
              {
                path: join(dir, 'alpha.json'),
                contents: '{"name":"Alpha 2"}',
                previousFingerprint: fingerprintW5File('{"name":"Alpha"}'),
              },
            ],
          }),
        ),
      ),
    ).toMatchObject({
      reason: 'unapplied-change',
      details: { commitId: first.commitId },
    });

    log.markApplied(first.commitId);
    expect(log.listPendingCommits()).toEqual([]);
  });
});

it('marks only a reserved attempt for recovery and refuses every other state', () => {
  log.reserve({
    reservationId: 'held',
    operation: key.operation,
    receipt: { ...key, fingerprint: 'f' },
    diagnostics: null,
  });
  log.reserve({
    reservationId: 'other',
    operation: key.operation,
    diagnostics: null,
  });
  const diagnostics = {
    operation: key.operation,
    errorName: 'Error',
    errorCode: 'EIO',
  };
  log.markReservationRecoveryRequired('held', diagnostics);
  expect(
    log.listReservations().find((row) => row.reservationId === 'other'),
  ).toMatchObject({ state: 'reserved', diagnostics: null });
  expect(log.lookupReceipt(key, 'f')).toMatchObject({
    status: 'recovery-required',
    reservationId: 'held',
    diagnostics,
  });
  expect(
    thrown(() =>
      log.markReservationRecoveryRequired('held', {
        operation: key.operation,
        errorName: 'OtherError',
      }),
    ),
  ).toMatchObject({
    reason: 'invalid-state',
    details: { expected: 'reserved', actual: 'recovery-required' },
  });
  expect(thrown(() => log.releaseReservation('held'))).toMatchObject({
    reason: 'invalid-state',
  });
  expect(log.lookupReceipt(key, 'f')).toMatchObject({ diagnostics });
  log.resolveRecovery('held');
  expect(
    thrown(() => log.markReservationRecoveryRequired('held', diagnostics)),
  ).toMatchObject({
    reason: 'invalid-state',
    details: { expected: 'reserved', actual: 'missing' },
  });
});

const creationDiagnostics: WorkspaceCreationDiagnostics = {
  kind: 'local-workspace-create',
  workspaceId: 'alpha',
  ownedPaths: ['/owned/alpha'],
  phase: 'before-canonical-commit',
};

it('updates only live reservation diagnostics and preserves the latest facts on restart', () => {
  log.reserve({
    reservationId: 'progress',
    operation: key.operation,
    receipt: { ...key, fingerprint: 'f1' },
    diagnostics: creationDiagnostics,
  });
  log.reserve({
    reservationId: 'unrelated',
    operation: key.operation,
    diagnostics: { sentinel: true },
  });
  const before = log.snapshot();
  const latest = {
    ...creationDiagnostics,
    ownedPaths: ['/owned/alpha', '/owned/member'],
  };
  log.updateReservationDiagnostics('progress', latest);
  expect(log.snapshot()).toEqual(before);
  expect(log.lookupReceipt(key, 'f1')).toEqual({
    status: 'in-progress',
    reservationId: 'progress',
  });
  expect(
    log.listReservations().find((row) => row.reservationId === 'unrelated')
      ?.diagnostics,
  ).toEqual({ sentinel: true });
  log.close();
  log = W5CommitLog.open(dbPath);
  log.markInterruptedReservations();
  expect(
    log.listReservations().find((row) => row.reservationId === 'progress'),
  ).toMatchObject({ state: 'recovery-required', diagnostics: latest });
});
it.each(['unknown', 'completed', 'released', 'recovery-required'] as const)(
  'refuses diagnostics updates on a %s reservation',
  (state) => {
    if (state !== 'unknown')
      log.reserve({
        reservationId: 'progress',
        operation: key.operation,
        diagnostics: creationDiagnostics,
      });
    if (state === 'completed')
      log.commit(change({ files: [], advance: [], reservationId: 'progress' }));
    if (state === 'released') log.releaseReservation('progress');
    if (state === 'recovery-required') log.markInterruptedReservations();
    const before = log.listReservations();
    expect(
      refusal(() =>
        log.updateReservationDiagnostics('progress', {
          ...creationDiagnostics,
          ownedPaths: [],
        }),
      ).reason,
    ).toBe('invalid-state');
    expect(log.listReservations()).toEqual(before);
  },
);
it('bounds and projects diagnostics and refuses a different workspace identity', () => {
  log.reserve({
    reservationId: 'progress',
    operation: key.operation,
    diagnostics: creationDiagnostics,
  });
  expect(
    refusal(() =>
      log.updateReservationDiagnostics('progress', {
        ...creationDiagnostics,
        workspaceId: 'bravo',
      }),
    ).reason,
  ).toBe('invalid-state');
  expect(
    refusal(() =>
      log.updateReservationDiagnostics('progress', {
        ...creationDiagnostics,
        ownedPaths: Array.from({ length: 100 }, () => 'p'.repeat(4096)),
      }),
    ).reason,
  ).toBe('invalid-state');
  log.updateReservationDiagnostics(
    'progress',
    Object.assign({}, creationDiagnostics, {
      message: 'must not persist',
      stack: 'must not persist',
    }),
  );
  expect(log.listReservations()[0]?.diagnostics).toEqual(creationDiagnostics);
});
