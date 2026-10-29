import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  W5CommitLog,
  W5_COMMIT_LOG_SCHEMA_VERSION,
  W5_COMPACTION_BATCH_SIZE,
  W5_COMPACTION_INTERVAL,
  fingerprintW5File,
  recoverW5CommitLog,
  type W5CommitRequest,
} from './fixtures/with-durability';

const key = {
  caller: 'portal:1',
  operation: 'test.update',
  idempotencyKey: 'k1',
};
const RETRY_WINDOW = 1_000;
let now: number;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected a refusal');
}

function reopen(): void {
  log.close();
  log = W5CommitLog.open(dbPath, {
    clock: () => now,
    retryWindowMs: RETRY_WINDOW,
  });
}

function request(): W5CommitRequest {
  return {
    operation: key.operation,
    receipt: { ...key, fingerprint: 'f1' },
    advance: [{ kind: 'workspaces' }],
    files: [
      {
        path: join(dir, 'target.json'),
        previousFingerprint: null,
        contents: 'new contents',
      },
    ],
    outcome: { workspaceId: 'alpha' },
  };
}

function inspect(run: (db: DatabaseSync) => void): void {
  log.close();
  const db = new DatabaseSync(dbPath);
  try {
    run(db);
  } finally {
    db.close();
  }
  reopen();
}

let dir: string;
let dbPath: string;
let log: W5CommitLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-retention-'));
  dbPath = join(dir, 'commit-log.sqlite');
  now = Date.parse('2026-10-01T00:00:00.000Z');
  log = W5CommitLog.open(dbPath, {
    clock: () => now,
    retryWindowMs: RETRY_WINDOW,
  });
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('W5 receipt retention (CAN-4029)', () => {
  it('replays the saved outcome at the window boundary after restart and target deletion', async () => {
    const original = log.commit(request());
    await recoverW5CommitLog(log, { root: dir });
    rmSync(join(dir, 'target.json'));
    now += RETRY_WINDOW;
    reopen();
    await recoverW5CommitLog(log, { root: dir });
    expect(log.lookupReceipt(key, 'f1')).toEqual({
      status: 'replay',
      commitId: original.commitId,
      outcome: request().outcome,
    });
    expect(log.commit(request())).toEqual({
      status: 'replayed',
      commitId: original.commitId,
      outcome: request().outcome,
    });
    expect(log.revision({ kind: 'workspaces' })).toBe(1);
  });

  it('keeps an expired identity across restart without rerunning it or accepting new parameters', async () => {
    const original = log.commit(request());
    await recoverW5CommitLog(log, { root: dir });
    now += RETRY_WINDOW + 1;
    reopen();
    await recoverW5CommitLog(log, { root: dir });
    rmSync(join(dir, 'target.json'));
    reopen();
    const expired = { status: 'replay-expired', commitId: original.commitId };
    expect(log.lookupReceipt(key, 'f1')).toEqual(expired);
    expect(log.commit(request())).toEqual(expired);
    expect(log.lookupReceipt(key, 'f2')).toEqual({ status: 'key-reused' });
    expect(
      thrown(() =>
        log.commit({ ...request(), receipt: { ...key, fingerprint: 'f2' } }),
      ),
    ).toMatchObject({ reason: 'key-reused' });
    expect(
      thrown(() =>
        log.reserve({
          reservationId: 'another',
          operation: key.operation,
          receipt: { ...key, fingerprint: 'f1' },
          diagnostics: null,
        }),
      ),
    ).toMatchObject({ reason: 'outcome-expired' });
    inspect((db) => {
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM w5_commits').get()?.count,
      ).toBe(1);
      expect(
        db
          .prepare(
            'SELECT outcome_json, outcome_expired, completed_at FROM w5_commits',
          )
          .get(),
      ).toEqual({
        outcome_json: 'null',
        outcome_expired: 1,
        completed_at: '2026-10-01T00:00:00.000Z',
      });
      expect(
        db
          .prepare(
            'SELECT caller, operation, idempotency_key, fingerprint, commit_id FROM w5_receipts',
          )
          .get(),
      ).toEqual({
        caller: key.caller,
        operation: key.operation,
        idempotency_key: key.idempotencyKey,
        fingerprint: 'f1',
        commit_id: original.commitId,
      });
    });
  });

  it('starts the retry window at application and never compacts pending changes or reservations', async () => {
    const original = log.commit(request());
    const conflictKey = { ...key, idempotencyKey: 'conflict' };
    const conflicted = log.commit({
      ...request(),
      receipt: { ...conflictKey, fingerprint: 'f1' },
      files: [],
    });
    log.markCommitRecoveryRequired(conflicted.commitId, { conflict: true });
    const reservationKey = { ...key, idempotencyKey: 'reservation' };
    log.reserve({
      reservationId: 'r1',
      operation: key.operation,
      receipt: { ...reservationKey, fingerprint: 'f1' },
      diagnostics: { clone: true },
    });
    now += RETRY_WINDOW * 2;
    expect(log.compact()).toBe(0);
    expect(log.lookupReceipt(key, 'f1').status).toBe('replay');
    expect(log.lookupReceipt(conflictKey, 'f1').status).toBe(
      'commit-recovery-required',
    );
    expect(log.lookupReceipt(reservationKey, 'f1').status).toBe('in-progress');
    reopen();
    await recoverW5CommitLog(log, { root: dir });
    expect(log.lookupReceipt(key, 'f1')).toEqual({
      status: 'replay',
      commitId: original.commitId,
      outcome: request().outcome,
    });
    expect(log.lookupReceipt(reservationKey, 'f1').status).toBe(
      'recovery-required',
    );
  });

  it('limits launch compaction to a batch and runs another only after the commit interval', async () => {
    for (let i = 0; i < W5_COMPACTION_BATCH_SIZE + 1; i += 1) {
      const result = log.commit({
        ...request(),
        receipt: { ...key, idempotencyKey: String(i), fingerprint: 'f1' },
        files: [],
      });
      log.markApplied(result.commitId);
    }
    now += RETRY_WINDOW + 1;
    reopen();
    await recoverW5CommitLog(log, { root: dir });
    expect(
      log.lookupReceipt({ ...key, idempotencyKey: '0' }, 'f1').status,
    ).toBe('replay-expired');
    const lastKey = {
      ...key,
      idempotencyKey: String(W5_COMPACTION_BATCH_SIZE),
    };
    expect(log.lookupReceipt(lastKey, 'f1').status).toBe('replay');
    for (let i = 0; i < W5_COMPACTION_INTERVAL - 1; i += 1) {
      const result = log.commit({
        operation: 'internal.test',
        advance: [],
        files: [],
        outcome: null,
      });
      log.markApplied(result.commitId);
    }
    expect(log.lookupReceipt(lastKey, 'f1').status).toBe('replay');
    const result = log.commit({
      operation: 'internal.test',
      advance: [],
      files: [],
      outcome: null,
    });
    log.markApplied(result.commitId);
    expect(log.lookupReceipt(lastKey, 'f1').status).toBe('replay-expired');
  });

  it('migrates a v1 file in place, retaining outcomes and pending recovery images', async () => {
    log.close();
    rmSync(dbPath);
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(readFileSync(join(__dirname, 'fixtures/schema-v1.sql'), 'utf8'));
      const insert = db.prepare(
        `INSERT INTO w5_commits (commit_id, operation, outcome_json, state, committed_at) VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run(
        1,
        key.operation,
        JSON.stringify(request().outcome),
        'applied',
        '2020-01-01T00:00:00.000Z',
      );
      insert.run(
        2,
        key.operation,
        'null',
        'committed',
        '2020-01-01T00:00:00.000Z',
      );
      insert.run(
        3,
        key.operation,
        'null',
        'recovery-required',
        '2020-01-01T00:00:00.000Z',
      );
      db.prepare('INSERT INTO w5_receipts VALUES (?, ?, ?, ?, ?)').run(
        key.caller,
        key.operation,
        key.idempotencyKey,
        'f1',
        1,
      );
      const file = db.prepare(
        'INSERT INTO w5_commit_files VALUES (?, ?, ?, ?)',
      );
      file.run(
        1,
        join(dir, 'deleted.json'),
        fingerprintW5File('before'),
        'after',
      );
      file.run(2, join(dir, 'pending.json'), null, 'pending image');
      file.run(3, join(dir, 'recovery.json'), null, 'recovery image');
    } finally {
      db.close();
    }
    reopen();
    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      { applied: [2], recoveryRequired: [3] },
    );
    expect(log.lookupReceipt(key, 'f1')).toEqual({
      status: 'replay',
      commitId: 1,
      outcome: request().outcome,
    });
    expect(readFileSync(join(dir, 'pending.json'), 'utf8')).toBe(
      'pending image',
    );
    inspect((raw) => {
      expect(
        raw
          .prepare("SELECT value FROM w5_meta WHERE key = 'schema_version'")
          .get()?.value,
      ).toBe(String(W5_COMMIT_LOG_SCHEMA_VERSION));
      expect(
        raw
          .prepare(
            'SELECT contents, previous_fingerprint, new_fingerprint FROM w5_commit_files WHERE commit_id = 1',
          )
          .get(),
      ).toEqual({
        contents: null,
        previous_fingerprint: fingerprintW5File('before'),
        new_fingerprint: fingerprintW5File('after'),
      });
      expect(
        raw
          .prepare('SELECT contents FROM w5_commit_files WHERE commit_id = 3')
          .get()?.contents,
      ).toBe('recovery image');
    });
    now += RETRY_WINDOW + 1;
    reopen();
    await recoverW5CommitLog(log, { root: dir });
    expect(log.lookupReceipt(key, 'f1').status).toBe('replay-expired');
  });

  it('clears applied images but keeps conflicted images across launch and manual recovery', async () => {
    const appliedPath = join(dir, 'applied.json');
    const recoveryPath = join(dir, 'recovery.json');
    writeFileSync(appliedPath, 'before');
    writeFileSync(recoveryPath, 'edited elsewhere');
    const applied = log.commit({
      operation: 'test.update',
      advance: [],
      outcome: null,
      files: [
        {
          path: appliedPath,
          previousFingerprint: fingerprintW5File('before'),
          contents: 'after',
        },
      ],
    });
    const recovery = log.commit({
      operation: 'test.update',
      advance: [],
      outcome: null,
      files: [
        {
          path: recoveryPath,
          previousFingerprint: null,
          contents: 'recover me',
        },
      ],
    });
    await recoverW5CommitLog(log, { root: dir });
    log.close();
    const db = new DatabaseSync(dbPath);
    try {
      expect(
        db
          .prepare('SELECT contents FROM w5_commit_files WHERE commit_id = ?')
          .get(applied.commitId)?.contents,
      ).toBeNull();
      expect(
        db
          .prepare(
            'SELECT previous_fingerprint, new_fingerprint FROM w5_commit_files WHERE commit_id = ?',
          )
          .get(applied.commitId),
      ).toEqual({
        previous_fingerprint: fingerprintW5File('before'),
        new_fingerprint: fingerprintW5File('after'),
      });
      expect(
        db
          .prepare('SELECT contents FROM w5_commit_files WHERE commit_id = ?')
          .get(recovery.commitId)?.contents,
      ).toBe('recover me');
    } finally {
      db.close();
    }
    log = W5CommitLog.open(dbPath);
    rmSync(recoveryPath);
    log.retryRecoveryRequiredCommit(recovery.commitId);
    await expect(recoverW5CommitLog(log, { root: dir })).resolves.toMatchObject(
      { applied: [recovery.commitId] },
    );
    expect(readFileSync(recoveryPath, 'utf8')).toBe('recover me');
  });
});
