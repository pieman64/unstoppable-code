import type {
  WorktreeDiscovery,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import { normalizeGeneratedWorktreeLabel } from '@canopy/protocol/worktree-display-labels';
import { IdentifierValidationError, validateId } from './validation';
import { applyWorktreeRowDecision } from './worktree-record-decision-port';
import type {
  WorktreeDiscoveryDecision,
  WorktreeHealthRecordSource,
  WorktreeRecordOutcome,
  WorktreeRecoveryDecision,
} from './worktree-record-decisions';

export type {
  WorktreeHealthRecordSource,
  WorktreeRecordOutcome,
  WorktreeRecordStatus,
} from './worktree-record-decisions';

/**
 * The W5 system records of one worktree row (CAN-3822): health, discovery and
 * launch reconciliation. They are host commands, not wire operations
 * (CAN-3799 D9): they take no client revision and make no idempotency
 * guarantee. Each one changes only the fields its operation owns, under the
 * per-workspace worktree list lock, so a concurrent create, update or archive
 * keeps its rows and fields. A worktree that is not in the list, or whose list
 * is missing or unreadable, is never written: the list is not created,
 * replaced or emptied, and an archived row is not brought back.
 */

export type WorktreeRecordRefusal = 'invalid-request';

/** A record was refused before the worktree list was read. */
export class WorktreeRecordRefusedError extends Error {
  constructor(
    readonly reason: WorktreeRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeRecordRefusedError';
  }
}

interface WorktreeRowTarget {
  workspaceId: string;
  worktreeId: string;
}

function admitTarget(target: WorktreeRowTarget): void {
  try {
    validateId(target.workspaceId, 'workspaceId');
    validateId(target.worktreeId, 'worktreeId');
  } catch (error) {
    if (error instanceof IdentifierValidationError) {
      throw new WorktreeRecordRefusedError('invalid-request', error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// internal.worktree.health.record
// ---------------------------------------------------------------------------

export interface WorktreeHealthRecord extends WorktreeRowTarget {
  source: WorktreeHealthRecordSource;
  /** The validated issue, or null when the worktree validated healthy. */
  issue: WorktreeHealthIssue | null;
}

const HEALTH_RECORD_SOURCES: ReadonlySet<string> =
  new Set<WorktreeHealthRecordSource>(['health-check', 'diff-stats']);

/**
 * `internal.worktree.health.record`: stores a broken health issue on the row,
 * or clears the stored issue (and a split's recovery flag, which a healthy
 * checkout resolves) when the worktree validated healthy.
 */
export async function recordWorktreeHealth(
  record: WorktreeHealthRecord,
): Promise<WorktreeRecordOutcome> {
  admitTarget(record);
  if (!HEALTH_RECORD_SOURCES.has(record.source)) {
    throw new WorktreeRecordRefusedError(
      'invalid-request',
      'Unknown worktree health record source',
    );
  }
  return applyWorktreeRowDecision(
    { workspaceId: record.workspaceId, worktreeId: record.worktreeId },
    { kind: 'health', source: record.source, issue: record.issue },
  );
}

// ---------------------------------------------------------------------------
// internal.worktree.discovery.record
// ---------------------------------------------------------------------------

/**
 * `environment` stores the worktree-level provider discovery
 * (`worktree:discover` and post-create discovery). `branch-prompt` stores
 * whether the one-time branch naming prompt was sent (task branch naming);
 * a cleared flag is persisted as `false`.
 */
export type WorktreeDiscoveryRecord = WorktreeRowTarget &
  (
    | { kind: 'environment'; discovery: WorktreeDiscovery }
    | { kind: 'branch-prompt'; sent: boolean }
  );

/** `internal.worktree.discovery.record`. */
export async function recordWorktreeDiscovery(
  record: WorktreeDiscoveryRecord,
): Promise<WorktreeRecordOutcome> {
  admitTarget(record);
  return applyWorktreeRowDecision(
    { workspaceId: record.workspaceId, worktreeId: record.worktreeId },
    discoveryDecision(record),
  );
}

function discoveryDecision(
  record: WorktreeDiscoveryRecord,
): WorktreeDiscoveryDecision {
  if (record.kind === 'environment') {
    return { kind: 'discovery.environment', discovery: record.discovery };
  }
  if (record.kind === 'branch-prompt' && typeof record.sent === 'boolean') {
    return { kind: 'discovery.branch-prompt', sent: record.sent };
  }
  throw new WorktreeRecordRefusedError(
    'invalid-request',
    'Unknown worktree discovery record',
  );
}

// ---------------------------------------------------------------------------
// internal.worktree.label.record
// ---------------------------------------------------------------------------

export interface WorktreeGeneratedLabelRecord extends WorktreeRowTarget {
  /** Accepted by `evaluateGeneratedWorktreeLabel`. */
  label: string;
  provisional: boolean;
}

/**
 * `internal.worktree.label.record`: stores a generated display label. It is
 * `unchanged` when the row has a manual label, a label from before label
 * provenance, or a settled generated one. It never renames a Git branch.
 */
export async function recordGeneratedWorktreeLabel(
  record: WorktreeGeneratedLabelRecord,
): Promise<WorktreeRecordOutcome> {
  admitTarget(record);
  const label = normalizeGeneratedWorktreeLabel(record.label);
  if (label === null || label !== record.label) {
    throw new WorktreeRecordRefusedError(
      'invalid-request',
      'Generated worktree labels must be normalized',
    );
  }
  return applyWorktreeRowDecision(
    { workspaceId: record.workspaceId, worktreeId: record.worktreeId },
    { kind: 'label.generated', label, provisional: record.provisional },
  );
}

// ---------------------------------------------------------------------------
// internal.worktree.recovery.reconcile
// ---------------------------------------------------------------------------

/**
 * The row writes of the desktop's automatic launch reconciliation
 * (CAN-3799 D3). Each names the incarnation launch observed by its
 * `createdAt`, so a row replaced since then is reported `not-found`.
 *
 * - `promote-pending`: a `git-pending` row whose checkout is registered
 *   becomes `git-ready` on the branch the checkout is on. A row that is no
 *   longer pending is `unchanged`.
 * - `complete-source-root-repair`: an explicitly approved repair completes the
 *   retained creation journal after root repair and child checkout setup. The
 *   operation identity must still match the observed reservation.
 * - `expose-create-reservation`: a row whose creation journal never completed
 *   becomes `recovery-required` with a broken health issue at the retained
 *   checkout. A row without a creation journal of that operation, or whose
 *   creation completed or already awaits recovery, is `unchanged`.
 * - `expose-split-reservation`: a pending row reserved by a split that never
 *   completed becomes visible with a broken health issue and keeps its
 *   recovery flag for explicit recovery.
 *
 * Rolling back a pending row without a checkout and archiving a ready row
 * whose checkout is gone stay with the create and archive lifecycles. A
 * checkout with no row is never adopted or removed here (CAN-3799 B4).
 */
export type WorktreeRecoveryReconcile = WorktreeRowTarget & {
  createdAt: string;
} & (
    | { kind: 'promote-pending'; branchName: string }
    | { kind: 'complete-source-root-repair'; operationId: string }
    | {
        kind: 'expose-create-reservation';
        operationId: string;
        worktreePath: string;
      }
    | { kind: 'expose-split-reservation'; worktreePath: string }
  );

/** `internal.worktree.recovery.reconcile`. */
export async function reconcileWorktreeRecovery(
  command: WorktreeRecoveryReconcile,
): Promise<WorktreeRecordOutcome> {
  admitTarget(command);
  if (typeof command.createdAt !== 'string' || !command.createdAt) {
    throw new WorktreeRecordRefusedError(
      'invalid-request',
      'A recovery reconcile needs the observed createdAt',
    );
  }
  return applyWorktreeRowDecision(
    { workspaceId: command.workspaceId, worktreeId: command.worktreeId },
    reconcileDecision(command),
  );
}

function reconcileDecision(
  command: WorktreeRecoveryReconcile,
): WorktreeRecoveryDecision {
  const { createdAt } = command;
  switch (command.kind) {
    case 'complete-source-root-repair':
      return {
        kind: 'recovery.complete-source-root-repair',
        createdAt,
        operationId: command.operationId,
      };
    case 'expose-create-reservation':
      return {
        kind: 'recovery.expose-create-reservation',
        createdAt,
        operationId: command.operationId,
        worktreePath: command.worktreePath,
      };
    case 'promote-pending': {
      const { branchName } = command;
      if (typeof branchName !== 'string' || !branchName.trim()) {
        throw new WorktreeRecordRefusedError(
          'invalid-request',
          'A promoted worktree needs a branch name',
        );
      }
      return { kind: 'recovery.promote-pending', createdAt, branchName };
    }
    case 'expose-split-reservation':
      return {
        kind: 'recovery.expose-split-reservation',
        createdAt,
        worktreePath: command.worktreePath,
      };
    default:
      throw new WorktreeRecordRefusedError(
        'invalid-request',
        'Unknown worktree recovery reconcile',
      );
  }
}
