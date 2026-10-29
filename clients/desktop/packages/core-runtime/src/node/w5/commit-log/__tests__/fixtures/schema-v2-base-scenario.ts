// The inputs behind schema-v2-base.sql and the reads compared against it.
// generate-schema-v2-base.mjs writes the database with the base library and
// records observeW5CommitLog under it; the reopen suite runs the same reads
// with this library. Paths are placeholders: no suite touches them on disk.
import type {
  W5CommitLog,
  W5CommitRequest,
  W5ReceiptKey,
  W5ReservationFailureDiagnostics,
  W5Resource,
} from '../..';
import type { WorkspaceCreationDiagnostics } from '../../reservation-diagnostics';

/** Writes of the expired commit; everything else is written at {@link LATER}. */
export const EARLIER = Date.parse('2026-09-01T00:00:00.000Z');
/** Past the default 30-day retry window from {@link EARLIER}. */
export const LATER = Date.parse('2026-10-02T00:00:00.000Z');

const operation = 'core.workspace.create';
function key(idempotencyKey: string): W5ReceiptKey {
  return { caller: 'portal:1', operation, idempotencyKey };
}

export const keys = {
  applied: key('k-applied'),
  expired: key('k-expired'),
  pending: key('k-pending'),
  conflicted: key('k-conflicted'),
  live: key('k-live'),
  failed: key('k-failed'),
  unknown: key('k-unknown'),
} as const;
export const OTHER_FINGERPRINT = 'fp-other';
export function fingerprintOf(name: string): string {
  return `fp-${name}`;
}

const workspaces: W5Resource = { kind: 'workspaces' };
function workspace(workspaceId: string): W5Resource {
  return { kind: 'workspace', workspaceId };
}

export const resources: readonly W5Resource[] = [
  workspaces,
  workspace('alpha'),
  workspace('bravo'),
  workspace('charlie'),
  workspace('unknown'),
];

function keyed(
  name: 'applied' | 'expired' | 'pending' | 'conflicted',
  request: Omit<W5CommitRequest, 'operation' | 'receipt'>,
): W5CommitRequest {
  return {
    operation,
    receipt: { ...keys[name], fingerprint: fingerprintOf(name) },
    ...request,
  };
}

export const requests = {
  expired: keyed('expired', {
    advance: [workspaces],
    files: [
      {
        path: '/w5-fixture/workspaces.json',
        previousFingerprint: null,
        contents: '{"workspaces":[]}',
      },
    ],
    outcome: { workspaceId: 'old' },
  }),
  applied: keyed('applied', {
    advance: [workspaces, workspace('alpha')],
    files: [
      {
        path: '/w5-fixture/workspaces/alpha/workspace.json',
        previousFingerprint: null,
        contents: '{"name":"Alpha"}',
      },
      {
        path: '/w5-fixture/workspaces/stale.json',
        // sha256("stale")
        previousFingerprint:
          'a03f2386ae06b21109577020844df367857b72c2fcce384c1896fed98a89c82b',
        contents: null,
      },
    ],
    outcome: { workspaceId: 'alpha', name: 'Alpha' },
  }),
  pending: keyed('pending', {
    advance: [workspace('bravo')],
    files: [
      {
        path: '/w5-fixture/workspaces/bravo/workspace.json',
        previousFingerprint: null,
        contents: '{"name":"Bravo"}',
      },
    ],
    outcome: { workspaceId: 'bravo' },
  }),
  conflicted: keyed('conflicted', {
    advance: [workspace('charlie')],
    files: [
      {
        path: '/w5-fixture/workspaces/charlie/workspace.json',
        previousFingerprint: null,
        contents: '{"name":"Charlie"}',
      },
    ],
    outcome: { workspaceId: 'charlie' },
  }),
} as const;

/** What the applier records when a file matches neither side of a change. */
export const conflictDiagnostics = {
  conflicts: [
    {
      path: '/w5-fixture/workspaces/charlie/workspace.json',
      expected: null,
      // sha256("stale")
      actual:
        'a03f2386ae06b21109577020844df367857b72c2fcce384c1896fed98a89c82b',
    },
  ],
  written: [],
};

function createDiagnostics(workspaceId: string): WorkspaceCreationDiagnostics {
  return {
    kind: 'local-workspace-create',
    workspaceId,
    ownedPaths: [],
    phase: 'before-canonical-commit',
  };
}

export const reservations = {
  live: {
    reservationId: 'r-live',
    operation,
    receipt: { ...keys.live, fingerprint: fingerprintOf('live') },
    diagnostics: createDiagnostics('delta'),
  },
  failed: {
    reservationId: 'r-failed',
    operation,
    receipt: { ...keys.failed, fingerprint: fingerprintOf('failed') },
    diagnostics: createDiagnostics('echo'),
  },
};

/**
 * The live reservation's stored diagnostics. Keys are out of shape order and
 * one is unknown, so the stored bytes show the validator's output order and
 * stripping; the paths are non-ASCII so they show UTF-8 is kept.
 */
export const liveDiagnosticsUpdate: WorkspaceCreationDiagnostics =
  Object.assign({ unknownKey: 'stripped' }, {
    repositories: [
      {
        owned: true,
        path: '/w5-fixture/wörkspaces/delta/source',
        status: 'completed',
        role: 'source',
        id: 'source',
        action: 'clone',
      },
      { status: 'started', id: 'member-1', role: 'member', owned: false },
    ],
    phase: 'member-import',
    ownedPaths: ['/w5-fixture/wörkspaces/delta'],
    workspaceId: 'delta',
    kind: 'local-workspace-create',
  } satisfies WorkspaceCreationDiagnostics);

export const failedReservationDiagnostics: W5ReservationFailureDiagnostics = {
  operation,
  errorName: 'Error',
  errorCode: 'EACCES',
};

function outcomeOf(run: () => unknown): unknown {
  try {
    return { result: run() };
  } catch (error) {
    if (typeof error !== 'object' || error === null) throw error;
    // Read structurally: the base and moved error classes are distinct.
    const fields: Record<string, unknown> = {};
    for (const field of ['name', 'code', 'reason', 'details']) {
      const value: unknown = Reflect.get(error, field);
      fields[field] = value;
    }
    return { error: fields };
  }
}

function lookups(log: W5CommitLog): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(keys)) {
    results[name] = log.lookupReceipt(key, fingerprintOf(name));
    results[`${name}:other-parameters`] = log.lookupReceipt(
      key,
      OTHER_FINGERPRINT,
    );
  }
  return results;
}

/**
 * Every read and keyed retry the reopen evidence compares, in order. The
 * diagnostics update rewrites the live reservation with its stored input, and
 * startup recovery marks it interrupted, so both run after the reads.
 */
export function observeW5CommitLog(
  log: W5CommitLog,
  openSecondWriter: () => unknown,
): Record<string, unknown> {
  const revisions: Record<string, number> = {};
  for (const resource of resources) {
    revisions[JSON.stringify(resource)] = log.revision(resource);
  }
  return {
    revisions,
    lookups: lookups(log),
    replays: {
      applied: outcomeOf(() => log.commit(requests.applied)),
      expired: outcomeOf(() => log.commit(requests.expired)),
      pending: outcomeOf(() => log.commit(requests.pending)),
      conflicted: outcomeOf(() => log.commit(requests.conflicted)),
    },
    pendingCommits: log.listPendingCommits(),
    recoveryRequiredCommitIds: log.listRecoveryRequiredCommitIds(),
    recoveryRequiredCommitDiagnostics:
      log.listRecoveryRequiredCommitDiagnostics(),
    reservations: log.listReservations(),
    snapshot: outcomeOf(() => log.snapshot()),
    secondWriter: outcomeOf(openSecondWriter),
    liveDiagnosticsUpdate: outcomeOf(() => {
      log.updateReservationDiagnostics(
        reservations.live.reservationId,
        liveDiagnosticsUpdate,
      );
    }),
    interruptedReservations: log.markInterruptedReservations(),
    afterStartupRecovery: {
      reservations: log.listReservations(),
      lookups: lookups(log),
    },
  };
}
