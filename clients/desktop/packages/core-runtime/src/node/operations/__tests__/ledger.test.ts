import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  IN_PROCESS_LEASE_TERMS,
  IN_PROCESS_WORKER_TARGET,
  OperationRecordSchema,
} from '@canopy/protocol/canopy-core';

import {
  validateNamespaceBackupRecord,
  type NamespaceBackupRecord,
} from '../../../storage/backup-record';
import { STORAGE_OWNERSHIP } from '../../../storage/storage-ownership.generated';
import {
  OPERATION_LEDGER_SCHEMA_VERSION,
  OperationLedger,
  OperationLedgerError,
  OperationLedgerRefusedError,
  backupOperationLedger,
  restoreOperationLedgerBackup,
  type OperationAcceptRequest,
  type OperationLedgerBackupOptions,
} from '../ledger';

const DAY = 24 * 60 * 60 * 1_000;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error');
}

function request(
  overrides: Partial<OperationAcceptRequest> = {},
): OperationAcceptRequest {
  return {
    kind: 'core.pipeline.run',
    origin: { kind: 'client', sourceId: 'desktop-window-1' },
    owner: { kind: 'principal', id: 'local-user' },
    scope: { workspaceId: 'alpha', worktreeId: 'main' },
    ...overrides,
  };
}

const keyed = {
  caller: 'local-user',
  idempotencyKey: 'run-1',
  fingerprint: 'params-a',
};

let dir: string;
let dbPath: string;
let now: number;
let ledger: OperationLedger;

function open(): OperationLedger {
  return OperationLedger.open(dbPath, { clock: () => now });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'operation-ledger-'));
  dbPath = join(dir, 'operations', 'operation-ledger.sqlite');
  now = Date.parse('2026-10-27T10:00:00.000Z');
  ledger = open();
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

function countOperations(): number {
  ledger.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      db.prepare('SELECT COUNT(*) AS count FROM operations').get()?.count,
    );
  } finally {
    db.close();
    ledger = open();
  }
}

describe('acceptance and receipts', () => {
  it('commits the record and its key before returning, so a retry after a lost acknowledgement finds it', () => {
    const accepted = ledger.accept(request({ receipt: keyed }));
    expect(accepted.status).toBe('accepted');
    const operation = accepted.operation;
    expect(OperationRecordSchema.parse(operation)).toEqual(operation);
    expect(operation).toMatchObject({
      status: 'queued',
      revision: 1,
      rootOperationId: operation.operationId,
      receipt: { idempotencyKey: 'run-1', outcome: 'pending' },
      owner: { kind: 'principal', id: 'local-user' },
    });

    // The acknowledgement is lost and the process goes away.
    ledger.close();
    ledger = open();

    const retried = ledger.accept(request({ receipt: keyed }));
    expect(retried).toEqual({ status: 'in-progress', operation });
    expect(countOperations()).toBe(1);
  });

  it('replays the recorded outcome to a retry instead of new work', () => {
    const { operation } = ledger.accept(
      request({ receipt: keyed, status: 'running' }),
    );
    ledger.finish(operation.operationId, {
      status: 'completed',
      outcome: { exitCode: 0 },
    });
    const retried = ledger.accept(request({ receipt: keyed }));
    expect(retried.status).toBe('replay');
    expect(retried.operation).toMatchObject({
      operationId: operation.operationId,
      status: 'completed',
      outcome: { exitCode: 0 },
      receipt: { outcome: 'recorded' },
    });
    expect(countOperations()).toBe(1);
  });

  it('refuses a key reused with other parameters and records nothing', () => {
    ledger.accept(request({ receipt: keyed }));
    const error = thrown(() =>
      ledger.accept(
        request({ receipt: { ...keyed, fingerprint: 'params-b' } }),
      ),
    );
    expect(error).toBeInstanceOf(OperationLedgerRefusedError);
    expect(error).toMatchObject({ refusal: 'key-reused' });
    expect(countOperations()).toBe(1);
  });

  it('scopes keys to the caller and the operation kind', () => {
    const first = ledger.accept(request({ receipt: keyed }));
    const otherCaller = ledger.accept(
      request({ receipt: { ...keyed, caller: 'someone-else' } }),
    );
    const otherKind = ledger.accept(
      request({ kind: 'core.script.run', receipt: keyed }),
    );
    expect(
      new Set([
        first.operation.operationId,
        otherCaller.operation.operationId,
        otherKind.operation.operationId,
      ]).size,
    ).toBe(3);
  });

  it('records lineage and refuses children of unknown or finished parents', () => {
    const parent = ledger.accept(request()).operation;
    const child = ledger.accept(
      request({
        kind: 'worker.pipeline.step',
        parentOperationId: parent.operationId,
      }),
    ).operation;
    const grandchild = ledger.accept(
      request({
        kind: 'worker.process.run',
        parentOperationId: child.operationId,
      }),
    ).operation;
    expect(child).toMatchObject({
      parentOperationId: parent.operationId,
      rootOperationId: parent.operationId,
    });
    expect(grandchild.rootOperationId).toBe(parent.operationId);
    expect(ledger.listActiveChildren(parent.operationId)).toEqual([child]);

    expect(
      thrown(() => ledger.accept(request({ parentOperationId: 'missing' }))),
    ).toMatchObject({ refusal: 'unknown-parent' });
    ledger.finish(parent.operationId, { status: 'cancelled' });
    expect(
      thrown(() =>
        ledger.accept(request({ parentOperationId: parent.operationId })),
      ),
    ).toMatchObject({ refusal: 'invalid-state' });
  });
});

describe('lifecycle', () => {
  it('advances the revision and writes one ordered event per change', () => {
    const { operation } = ledger.accept(request());
    ledger.transition(operation.operationId, 'running');
    ledger.transition(operation.operationId, 'paused');
    ledger.transition(operation.operationId, 'running');
    ledger.reportProgress(operation.operationId, 0.5);
    const finished = ledger.finish(operation.operationId, {
      status: 'failed',
      error: {
        kind: 'internal',
        message: 'Step 2 exited with 1.',
        retry: { kind: 'never' },
      },
    });
    expect(finished.operation).toMatchObject({
      status: 'failed',
      revision: 6,
      progress: 0.5,
      outcome: null,
      error: { message: 'Step 2 exited with 1.' },
    });
    expect(finished.operation.completedAt).not.toBeNull();
    expect(
      ledger.eventsAfter(0).map((event) => [event.event, event.previousStatus]),
    ).toEqual([
      ['queued', null],
      ['started', 'queued'],
      ['paused', 'running'],
      ['resumed', 'paused'],
      ['failed', 'running'],
    ]);
    expect(ledger.eventsHead()).toBe(5);
  });

  it('refuses to change finished work, but finishing again the same way is a no-op', () => {
    const { operation } = ledger.accept(request());
    ledger.finish(operation.operationId, { status: 'completed' });
    expect(
      ledger.finish(operation.operationId, { status: 'completed' }).event,
    ).toBeNull();
    expect(
      thrown(() => ledger.finish(operation.operationId, { status: 'failed' })),
    ).toMatchObject({ refusal: 'invalid-state' });
    expect(
      thrown(() => ledger.transition(operation.operationId, 'running')),
    ).toMatchObject({ refusal: 'invalid-state' });
  });

  it('records a cancellation intent once and compares revisions', () => {
    const { operation } = ledger.accept(request({ status: 'running' }));
    const cancellation = {
      requestedAt: new Date(now).toISOString(),
      requestedBy: 'local-user',
      reason: 'No longer needed',
    };
    expect(
      thrown(() =>
        ledger.requestCancel(operation.operationId, cancellation, {
          expectedRevision: 7,
        }),
      ),
    ).toMatchObject({
      refusal: 'revision-conflict',
      details: { currentRevision: 1 },
    });
    const first = ledger.requestCancel(operation.operationId, cancellation, {
      expectedRevision: 1,
    });
    expect(first.event?.event).toBe('cancelRequested');
    expect(first.operation.cancellation).toEqual(cancellation);
    expect(
      ledger.requestCancel(operation.operationId, cancellation).event,
    ).toBeNull();
    const withdrawn = ledger.withdrawCancel(operation.operationId);
    expect(withdrawn.event?.event).toBe('cancelRefused');
    expect(withdrawn.operation.cancellation).toBeNull();
  });

  it('lists work an earlier process left unfinished', () => {
    const queued = ledger.accept(request()).operation;
    const running = ledger.accept(request({ status: 'running' })).operation;
    const done = ledger.accept(request()).operation;
    ledger.finish(done.operationId, { status: 'completed' });
    expect(ledger.listInterrupted()).toEqual([]);
    const previousEpoch = ledger.runEpoch;
    ledger.close();
    ledger = open();
    expect(ledger.runEpoch).not.toBe(previousEpoch);
    expect(ledger.listInterrupted().map((op) => op.operationId)).toEqual([
      queued.operationId,
      running.operationId,
    ]);
    // Taking work over claims it for this process.
    ledger.transition(queued.operationId, 'running');
    expect(ledger.listInterrupted().map((op) => op.operationId)).toEqual([
      running.operationId,
    ]);
  });
});

describe('listing', () => {
  it('pages newest first and filters by scope, status, kind and parent', () => {
    const ids: string[] = [];
    const workspaces = ['alpha', 'bravo', 'alpha'];
    for (let index = 0; index < workspaces.length; index += 1) {
      const workspaceId = workspaces[index];
      now += 1_000;
      ids.push(
        ledger.accept(
          request({
            scope: { workspaceId },
            kind: index === 1 ? 'core.script.run' : 'core.pipeline.run',
          }),
        ).operation.operationId,
      );
    }
    ledger.finish(ids[2], { status: 'completed' });

    const first = ledger.list({ limit: 2 });
    expect(first.items.map((op) => op.operationId)).toEqual([ids[2], ids[1]]);
    expect(first.next).not.toBeNull();
    const second = ledger.list({ limit: 2, after: first.next ?? undefined });
    expect(second.items.map((op) => op.operationId)).toEqual([ids[0]]);
    expect(second.next).toBeNull();

    expect(
      ledger.list({ limit: 10, scope: { workspaceId: 'alpha' } }).items.length,
    ).toBe(2);
    expect(
      ledger
        .list({ limit: 10, statuses: ['queued'] })
        .items.map((op) => op.operationId),
    ).toEqual([ids[1], ids[0]]);
    expect(
      ledger
        .list({ limit: 10, kinds: ['core.script.run'] })
        .items.map((op) => op.operationId),
    ).toEqual([ids[1]]);
  });
});

describe('retention', () => {
  it('drops outcomes and events after the retry window but never the receipt', () => {
    const { operation } = ledger.accept(request({ receipt: keyed }));
    ledger.finish(operation.operationId, {
      status: 'completed',
      outcome: { exitCode: 0 },
    });
    const head = ledger.eventsHead();
    now += 31 * DAY;
    expect(ledger.compact()).toBe(1);
    expect(ledger.eventsAfter(0)).toEqual([]);
    expect(ledger.eventsResumableFrom()).toBe(head);
    expect(ledger.eventsHead()).toBe(head);

    const retried = ledger.accept(request({ receipt: keyed }));
    expect(retried.status).toBe('replay-expired');
    expect(retried.operation).toMatchObject({
      status: 'completed',
      outcome: null,
      receipt: { outcome: 'expired' },
    });
  });

  it('expires a receipt by age even before compaction has run', () => {
    const { operation } = ledger.accept(request({ receipt: keyed }));
    ledger.finish(operation.operationId, {
      status: 'completed',
      outcome: { exitCode: 0 },
    });
    now += 31 * DAY;
    expect(ledger.lookupReceipt(operation.kind, keyed)).toMatchObject({
      status: 'replay-expired',
      operation: { outcome: null, receipt: { outcome: 'expired' } },
    });
    expect(ledger.accept(request({ receipt: keyed })).status).toBe(
      'replay-expired',
    );
    expect(ledger.get(operation.operationId)).toMatchObject({
      outcome: null,
      receipt: { outcome: 'expired' },
    });
    expect(ledger.eventsAfter(0)).toEqual([]);
  });

  it('refuses to resume from before a pruned event, even with older events kept', () => {
    const kept = ledger.accept(request({ status: 'running' })).operation;
    const pruned = ledger.accept(request()).operation;
    const beforePruned = ledger.eventsHead();
    ledger.finish(pruned.operationId, { status: 'completed' });
    const prunedThrough = ledger.eventsHead();
    ledger.transition(kept.operationId, 'paused');
    now += 31 * DAY;
    expect(ledger.compact()).toBe(1);

    // A cursor at `beforePruned` would silently skip the pruned completion,
    // so resuming needs a cursor at or after it; the kept work's events stay
    // readable on either side of the gap.
    expect(ledger.eventsResumableFrom()).toBe(prunedThrough);
    expect(beforePruned).toBeLessThan(ledger.eventsResumableFrom());
    expect(
      ledger.eventsAfter(0).map((item) => item.operation.operationId),
    ).toEqual([kept.operationId, kept.operationId]);
  });

  it('keeps unfinished work however old it is', () => {
    ledger.accept(request({ status: 'running' }));
    now += 400 * DAY;
    expect(ledger.compact()).toBe(0);
    expect(ledger.eventsAfter(0)).toHaveLength(1);
  });
});

describe('storage', () => {
  it('admits one writer at a time', () => {
    const error = thrown(() =>
      OperationLedger.open(dbPath, { openBusyTimeoutMs: 0 }),
    );
    expect(error).toBeInstanceOf(OperationLedgerError);
    expect(error).toMatchObject({ code: 'WRITER_UNAVAILABLE' });
  });

  it('never opens a newer schema', () => {
    ledger.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE operation_meta SET value = ? WHERE key = 'schema_version'`,
    ).run(String(OPERATION_LEDGER_SCHEMA_VERSION + 1));
    db.close();
    expect(thrown(() => open())).toMatchObject({ code: 'UNSUPPORTED_SCHEMA' });
    ledger = OperationLedger.open(join(dir, 'other.sqlite'));
  });

  it('upgrades a version 1 ledger in place, keeping its records', () => {
    const kept = ledger.accept(request({ receipt: keyed })).operation;
    const ledgerId = ledger.ledgerId;
    ledger.close();
    const db = new DatabaseSync(dbPath);
    for (const table of [
      'delegations',
      'delegation_leases',
      'execution_targets',
    ])
      db.exec(`DROP TABLE ${table}`);
    db.prepare(
      `UPDATE operation_meta SET value = '1' WHERE key = 'schema_version'`,
    ).run();
    db.close();
    ledger = open();
    expect(ledger.ledgerId).toBe(ledgerId);
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.registerTarget(IN_PROCESS_WORKER_TARGET)).toMatchObject(
      IN_PROCESS_WORKER_TARGET,
    );
  });

  it('keeps a registered target row and refuses a different one', () => {
    const first = ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    now += 1_000;
    expect(ledger.registerTarget(IN_PROCESS_WORKER_TARGET)).toEqual(first);
    expect(
      thrown(() =>
        ledger.registerTarget({
          ...IN_PROCESS_WORKER_TARGET,
          profile: 'worker',
        }),
      ),
    ).toMatchObject({ refusal: 'invalid-state' });
  });

  it('holds one degenerate lease per run and releases earlier ones', () => {
    ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const lease = ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(
      ledger.acquireLease(
        IN_PROCESS_WORKER_TARGET.targetId,
        IN_PROCESS_LEASE_TERMS,
      ),
    ).toEqual(lease);
    ledger.close();
    ledger = open();
    const next = ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    expect(next.leaseId).not.toBe(lease.leaseId);
    expect(ledger.getLease(lease.leaseId)).toMatchObject({
      releasedAt: new Date(now).toISOString(),
      releaseReason: 'process-ended',
    });
  });

  it('rolls a dispatch back with its child when the record is refused', () => {
    ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const lease = ledger.acquireLease(
      IN_PROCESS_WORKER_TARGET.targetId,
      IN_PROCESS_LEASE_TERMS,
    );
    const parent = ledger.accept(request()).operation;
    const dispatch = {
      delegationId: 'delegation-1',
      targetId: IN_PROCESS_WORKER_TARGET.targetId,
      leaseId: lease.leaseId,
      operation: {
        name: 'worker.example.write',
        version: 1,
        idempotency: 'keyed' as const,
      },
      idempotencyKey: 'step-1',
      executorKey: 'delegation-1',
      activation: {
        delivery: 'inline-parameters' as const,
        digest: 'not-a-digest',
      },
      secrets: [],
    };
    const child = {
      ...request({ kind: 'worker.example.write' }),
      parentOperationId: parent.operationId,
      runtimeDelegationId: 'delegation-1',
    };
    expect(() => ledger.acceptDispatch(child, dispatch)).toThrow();
    expect(ledger.listActiveChildren(parent.operationId)).toEqual([]);
    const accepted = ledger.acceptDispatch(child, {
      ...dispatch,
      activation: {
        delivery: 'inline-parameters',
        digest: `sha256:${'0'.repeat(64)}`,
      },
    });
    expect(accepted.delegation).toMatchObject({
      state: 'prepared',
      childOperationId: accepted.result.operation.operationId,
      rootOperationId: parent.operationId,
    });
    expect(accepted.result.operation).toMatchObject({
      executionTargetId: IN_PROCESS_WORKER_TARGET.targetId,
      runtimeDelegationId: 'delegation-1',
    });
  });

  it('keeps its identity, so event cursors survive a restart', () => {
    const ledgerId = ledger.ledgerId;
    ledger.close();
    ledger = open();
    expect(ledger.ledgerId).toBe(ledgerId);
  });
});

describe('backup and restore', () => {
  const outside = (): boolean => true;
  const synced: string[] = [];
  const backup = (
    options: Omit<OperationLedgerBackupOptions, 'syncDirectory'>,
  ): Promise<NamespaceBackupRecord> =>
    backupOperationLedger(ledger, {
      ...options,
      syncDirectory: (path): Promise<'flushed'> => {
        synced.push(path);
        return Promise.resolve('flushed');
      },
    });

  it('issues a verified, restore-tested namespace_backup record and restores from it', async () => {
    const kept = ledger.accept(request({ receipt: keyed })).operation;
    const target = ledger.registerTarget(IN_PROCESS_WORKER_TARGET);
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-1.sqlite',
      isOutsideCheckouts: outside,
      clock: () => now,
    });
    expect(
      validateNamespaceBackupRecord(record, {
        rows: STORAGE_OWNERSHIP,
        isOutsideCheckouts: outside,
      }).ok,
    ).toBe(true);
    expect(record).toMatchObject({
      namespaceId: 'operation_ledger',
      schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
      sourceRevision: `${ledger.ledgerId}:1`,
      verifiedBy: { algorithm: 'sha256' },
      rollbackMigration: 'restoreOperationLedgerBackup',
    });
    // The copy's folder entry is flushed through the host's port.
    expect(synced).toContain(join(realpathSync(dir), 'backups'));

    // Later work is lost by the restore; the backed-up work is back.
    const later = ledger.accept(request()).operation;
    ledger.close();
    restoreOperationLedgerBackup(record, {
      dataRoot: dir,
      databasePath: dbPath,
      isOutsideCheckouts: outside,
    });
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
    expect(ledger.get(later.operationId)).toBeNull();
    expect(ledger.getTarget(target.targetId)).toEqual(target);
  });

  it('restores in place on the writer connection, never swapping the database file', async () => {
    const kept = ledger.accept(request()).operation;
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-in-place.sqlite',
      isOutsideCheckouts: outside,
    });
    ledger.accept(request());
    ledger.close();
    const before = statSync(dbPath).ino;
    restoreOperationLedgerBackup(record, {
      dataRoot: dir,
      databasePath: dbPath,
      isOutsideCheckouts: outside,
    });
    expect(statSync(dbPath).ino).toBe(before);
    const previousLedgerId = record.sourceRevision.split(':')[0];
    expect(readdirSync(join(dir, 'operations'))).toEqual([
      'operation-ledger.sqlite',
    ]);
    ledger = open();
    expect(ledger.list({ limit: 10 }).items).toEqual([kept]);
    expect(ledger.eventsHead()).toBe(1);
    // The event log rewound, so cursors issued before the restore must not
    // resume against it.
    expect(ledger.ledgerId).not.toBe(previousLedgerId);
  });

  it('refuses to restore while the ledger is open or from a changed copy', async () => {
    ledger.accept(request());
    const record = await backup({
      dataRoot: dir,
      backupPath: 'backups/operation-ledger-2.sqlite',
      isOutsideCheckouts: outside,
    });
    expect(
      thrown(() =>
        restoreOperationLedgerBackup(record, {
          dataRoot: dir,
          databasePath: dbPath,
          isOutsideCheckouts: outside,
        }),
      ),
    ).toMatchObject({ code: 'WRITER_UNAVAILABLE' });

    ledger.close();
    writeFileSync(join(dir, 'backups/operation-ledger-2.sqlite'), 'changed');
    expect(
      thrown(() =>
        restoreOperationLedgerBackup(record, {
          dataRoot: dir,
          databasePath: dbPath,
          isOutsideCheckouts: outside,
        }),
      ),
    ).toMatchObject({ code: 'BACKUP_UNVERIFIED' });
    ledger = open();
  });

  it('refuses paths that a symlink carries outside the data root', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'operation-ledger-outside-'));
    try {
      symlinkSync(outsideDir, join(dir, 'linked'));
      await expect(
        backup({
          dataRoot: dir,
          backupPath: 'linked/ledger.sqlite',
          isOutsideCheckouts: outside,
        }),
      ).rejects.toThrow(/leaves the data root/);
      expect(readdirSync(outsideDir)).toEqual([]);

      const record = await backup({
        dataRoot: dir,
        backupPath: 'backups/operation-ledger-link.sqlite',
        isOutsideCheckouts: outside,
      });
      renameSync(
        join(dir, 'backups/operation-ledger-link.sqlite'),
        join(outsideDir, 'copy.sqlite'),
      );
      symlinkSync(
        join(outsideDir, 'copy.sqlite'),
        join(dir, 'backups/operation-ledger-link.sqlite'),
      );
      ledger.close();
      expect(() =>
        restoreOperationLedgerBackup(record, {
          dataRoot: dir,
          databasePath: dbPath,
          isOutsideCheckouts: outside,
        }),
      ).toThrow(/leaves the data root/);
      ledger = open();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('never overwrites a file, the live ledger included', async () => {
    const kept = ledger.accept(request()).operation;
    for (const backupPath of [
      'operations/operation-ledger.sqlite',
      'operations/operation-ledger.sqlite-wal',
    ])
      await expect(
        backup({
          dataRoot: dir,
          backupPath,
          isOutsideCheckouts: outside,
        }),
      ).rejects.toThrow(/already exists/);
    expect(ledger.get(kept.operationId)).toEqual(kept);
    ledger.close();
    ledger = open();
    expect(ledger.get(kept.operationId)).toEqual(kept);
  });

  it('refuses a backup path not proven outside every checkout before touching it', async () => {
    const existing = join(dir, 'checkout', 'notes.txt');
    mkdirSync(dirname(existing), { recursive: true });
    writeFileSync(existing, 'keep me');
    await expect(
      backup({
        dataRoot: dir,
        backupPath: 'checkout/notes.txt',
        isOutsideCheckouts: (path) => !path.startsWith('checkout/'),
      }),
    ).rejects.toThrow(/outside every checkout/);
    expect(readFileSync(existing, 'utf8')).toBe('keep me');
    await expect(
      backup({
        dataRoot: dir,
        backupPath: 'checkout/new/ledger.sqlite',
        isOutsideCheckouts: () => false,
      }),
    ).rejects.toThrow(/outside every checkout/);
    expect(existsSync(join(dir, 'checkout', 'new'))).toBe(false);
  });
});
