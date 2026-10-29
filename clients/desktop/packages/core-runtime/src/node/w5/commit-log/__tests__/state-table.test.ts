import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { W5CommitLog, W5CommitRefusedError, type W5ReceiptKey } from '..';

// Every public action against every state of a commit and of a reservation,
// so no action can ignore the state it runs in (CAN-3805).

type CommitState = 'committed' | 'applied' | 'recovery-required' | 'missing';
type ReservationState = 'reserved' | 'recovery-required' | 'missing';

const key: W5ReceiptKey = {
  caller: 'portal:1',
  operation: 'core.workspace.update',
  idempotencyKey: 'k1',
};
const receipt = { ...key, fingerprint: 'f1' };

let dir: string;
let log: W5CommitLog;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-states-'));
  log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
  file = join(dir, 'a.json');
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A keyed commit of `file` in the given state; returns its id. */
function commitIn(state: CommitState): number {
  if (state === 'missing') return 999;
  const result = log.commit({
    operation: key.operation,
    receipt,
    advance: [{ kind: 'workspace', workspaceId: 'alpha' }],
    files: [{ path: file, contents: 'a2', previousFingerprint: null }],
    outcome: { ok: true },
  });
  if (result.status !== 'committed') throw new Error('Expected a commit');
  if (state === 'applied') log.markApplied(result.commitId);
  if (state === 'recovery-required') {
    log.markCommitRecoveryRequired(result.commitId, { conflict: true });
  }
  return result.commitId;
}

function reservationIn(state: ReservationState): string {
  if (state === 'missing') return 'missing';
  log.reserve({
    reservationId: 'op-1',
    operation: key.operation,
    receipt,
    diagnostics: null,
  });
  if (state === 'recovery-required') log.markInterruptedReservations();
  return 'op-1';
}

/** `ok`, a refusal reason, or a lookup status. */
function outcome(run: () => unknown): string {
  try {
    const value = run();
    if (typeof value === 'object' && value !== null && 'status' in value) {
      return String(Reflect.get(value, 'status'));
    }
    return 'ok';
  } catch (error) {
    if (error instanceof W5CommitRefusedError) return error.reason;
    throw error;
  }
}

const sameKeyCommit = (reservationId?: string) => (): unknown =>
  log.commit({
    operation: key.operation,
    receipt,
    advance: [],
    files: [],
    outcome: { ok: true },
    ...(reservationId === undefined ? {} : { reservationId }),
  });

describe('W5 commit log state table (CAN-3805)', () => {
  const commitActions: Record<
    string,
    {
      run: (id: number) => () => unknown;
      expected: Record<CommitState, string>;
    }
  > = {
    'receipt lookup': {
      run: () => () => log.lookupReceipt(key, 'f1'),
      expected: {
        committed: 'replay',
        applied: 'replay',
        // A replay never reports an outcome the files do not hold.
        'recovery-required': 'commit-recovery-required',
        missing: 'none',
      },
    },
    'commit with the same key': {
      run: () => sameKeyCommit(),
      expected: {
        committed: 'replayed',
        applied: 'replayed',
        'recovery-required': 'recovery-required',
        missing: 'committed',
      },
    },
    'commit to the same file': {
      run: () => () =>
        log.commit({
          operation: 'core.workspace.update',
          advance: [],
          files: [{ path: file, contents: 'a3', previousFingerprint: null }],
          outcome: null,
        }),
      expected: {
        committed: 'unapplied-change',
        applied: 'committed',
        'recovery-required': 'unapplied-change',
        missing: 'committed',
      },
    },
    'mark applied': {
      run: (id) => () => log.markApplied(id),
      expected: {
        committed: 'ok',
        applied: 'invalid-state',
        'recovery-required': 'invalid-state',
        missing: 'invalid-state',
      },
    },
    'mark recovery required': {
      run: (id) => () => log.markCommitRecoveryRequired(id, null),
      expected: {
        committed: 'ok',
        applied: 'invalid-state',
        'recovery-required': 'invalid-state',
        missing: 'invalid-state',
      },
    },
    'retry recovery': {
      run: (id) => () => log.retryRecoveryRequiredCommit(id),
      expected: {
        committed: 'invalid-state',
        applied: 'invalid-state',
        'recovery-required': 'ok',
        missing: 'invalid-state',
      },
    },
    'drop for recovery': {
      run: (id) => () => log.abandonRecoveryRequiredCommit(id),
      expected: {
        committed: 'invalid-state',
        applied: 'invalid-state',
        'recovery-required': 'ok',
        missing: 'invalid-state',
      },
    },
  };

  const commitCases = Object.entries(commitActions).flatMap(
    ([action, { run, expected }]) =>
      (Object.keys(expected) as CommitState[]).map(
        (state) => [action, state, run, expected[state]] as const,
      ),
  );

  it.each(commitCases)(
    '%s on a %s commit gives %4$s',
    (_action, state, run, expected) => {
      const id = commitIn(state);
      expect(outcome(run(id))).toBe(expected);
    },
  );

  it.each([
    ['committed', [true, false]],
    ['applied', [false, false]],
    ['recovery-required', [false, true]],
  ] as const)(
    'lists a %s commit as pending %p and awaiting recovery %p',
    (state, [pending, awaiting]) => {
      const id = commitIn(state);
      expect(log.listPendingCommits().some((c) => c.commitId === id)).toBe(
        pending,
      );
      expect(log.listRecoveryRequiredCommitIds().includes(id)).toBe(awaiting);
    },
  );

  const reservationActions: Record<
    string,
    {
      run: (id: string) => () => unknown;
      expected: Record<ReservationState, string>;
    }
  > = {
    'receipt lookup': {
      run: () => () => log.lookupReceipt(key, 'f1'),
      expected: {
        reserved: 'in-progress',
        'recovery-required': 'recovery-required',
        missing: 'none',
      },
    },
    'commit with the same key': {
      run: () => sameKeyCommit(),
      expected: {
        reserved: 'in-progress',
        'recovery-required': 'recovery-required',
        missing: 'committed',
      },
    },
    'commit completing the reservation': {
      run: (id) => sameKeyCommit(id),
      expected: {
        reserved: 'committed',
        'recovery-required': 'recovery-required',
        missing: 'unknown-reservation',
      },
    },
    'reserve the same key': {
      run: () => () =>
        log.reserve({
          reservationId: 'op-2',
          operation: key.operation,
          receipt,
          diagnostics: null,
        }),
      expected: {
        reserved: 'in-progress',
        'recovery-required': 'recovery-required',
        missing: 'ok',
      },
    },
    release: {
      run: (id) => () => log.releaseReservation(id),
      expected: {
        reserved: 'ok',
        'recovery-required': 'invalid-state',
        missing: 'invalid-state',
      },
    },
    'resolve recovery': {
      run: (id) => () => log.resolveRecovery(id),
      expected: {
        // Never resolved out from under an operation still running.
        reserved: 'invalid-state',
        'recovery-required': 'ok',
        missing: 'invalid-state',
      },
    },
    'mark interrupted': {
      run: () => () => {
        expect(log.markInterruptedReservations()).toBeGreaterThanOrEqual(0);
      },
      expected: { reserved: 'ok', 'recovery-required': 'ok', missing: 'ok' },
    },
  };

  const reservationCases = Object.entries(reservationActions).flatMap(
    ([action, { run, expected }]) =>
      (Object.keys(expected) as ReservationState[]).map(
        (state) => [action, state, run, expected[state]] as const,
      ),
  );

  it.each(reservationCases)(
    '%s on a %s reservation gives %4$s',
    (_action, state, run, expected) => {
      const id = reservationIn(state);
      expect(outcome(run(id))).toBe(expected);
    },
  );

  it.each([
    ['reserved', 1],
    ['recovery-required', 0],
  ] as const)(
    'marks a %s reservation interrupted %i time(s)',
    (state, count) => {
      reservationIn(state);
      expect(log.markInterruptedReservations()).toBe(count);
      expect(log.listReservations()).toEqual([
        expect.objectContaining({ state: 'recovery-required' }),
      ]);
    },
  );
});
