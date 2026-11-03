/**
 * Display status for a tracked plan. The stored review status stays
 * `pending | approved | dismissed`; `implementing` and `implemented` are
 * derived here from execution evidence and are never persisted.
 */
export type PlanDisplayStatusKind =
  | 'pending'
  | 'approved'
  | 'dismissed'
  | 'implementing'
  | 'implemented'
  | 'unknown';

/**
 * One implementation attempt's outcome, normalized by the host. `active`
 * covers queued, running and paused work; only an explicit successful
 * terminal outcome is `succeeded`.
 */
export type PlanExecutionOutcome =
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface PlanExecutionEvidence {
  /** `pipeline` attempts navigate with Open run, `chat` with Open chat. */
  readonly kind: 'pipeline' | 'chat';
  /**
   * The attempt's identity, unique within its kind. A chat attempt is one
   * linked turn, so hosts compose it from the chat and its user message
   * rather than reusing the chat id.
   */
  readonly id: string;
  readonly outcome: PlanExecutionOutcome;
  /** ISO time the attempt started; attempts without one cannot be placed. */
  readonly startedAt?: string;
  /** ISO time a terminal attempt ended, when the host knows it. */
  readonly endedAt?: string;
  /** Plan revision the attempt executed, when the host knows it. */
  readonly revisionNumber?: number;
}

export interface PlanDisplayStatusInput {
  /** The stored review status; hosts may pass values outside the enum. */
  readonly reviewStatus: string | undefined;
  readonly currentRevisionNumber?: number;
  /**
   * ISO creation time of the current revision. An attempt that started
   * before it executed an earlier revision and does not count.
   */
  readonly currentRevisionCreatedAt?: string;
  readonly evidence?: readonly PlanExecutionEvidence[];
}

export interface PlanDisplayStatus {
  readonly kind: PlanDisplayStatusKind;
  /** Sentence-case badge label, naming the venue once execution is known. */
  readonly label: string;
  /** The attempt behind Implementing or Implemented. */
  readonly selected?: PlanExecutionEvidence;
  /** The most recent attempt, when it failed or was cancelled. */
  readonly latestUnsuccessful?: PlanExecutionEvidence;
  /** Execute stays primary only while the plan awaits review. */
  readonly executeEmphasis: 'primary' | 'secondary';
  /**
   * `open` replaces Execute with a link to the selected attempt while it
   * runs and after it succeeds; retries move to the overflow menu.
   */
  readonly primaryAction: 'execute' | 'open';
}

const STORED_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  dismissed: 'Dismissed',
} as const;

const EXECUTION_LABELS = {
  implementing: {
    chat: 'Implementing in chat',
    pipeline: 'Implementing in workflow',
  },
  implemented: {
    chat: 'Finished in chat',
    pipeline: 'Implemented in workflow',
  },
} as const;

// Duplicate live/persisted reports share a start time. Prefer a terminal
// report over an active one; contradictory terminal reports conservatively
// retain the unsuccessful outcome, independent of collection order.
const OUTCOME_PRIORITY: Record<PlanExecutionOutcome, number> = {
  active: 0,
  succeeded: 1,
  cancelled: 2,
  failed: 3,
};

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function timeOf(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

/** Newest first; equal times fall back to the id so order never decides. */
function compareAttempts(
  left: { evidence: PlanExecutionEvidence; time: number },
  right: { evidence: PlanExecutionEvidence; time: number },
): number {
  if (left.time !== right.time) return right.time - left.time;
  const leftKey = `${left.evidence.kind}:${left.evidence.id}`;
  const rightKey = `${right.evidence.kind}:${right.evidence.id}`;
  if (leftKey === rightKey) return 0;
  return leftKey < rightKey ? 1 : -1;
}

/**
 * Attempts that apply to the current revision, deduplicated by kind and id
 * and ordered newest first. A duplicate keeps its most recent report.
 */
function relevantAttempts(
  input: PlanDisplayStatusInput,
): PlanExecutionEvidence[] {
  const revisionTime = timeOf(input.currentRevisionCreatedAt);
  const byId = new Map<
    string,
    { evidence: PlanExecutionEvidence; time: number }
  >();
  for (const evidence of input.evidence ?? []) {
    if (
      evidence.revisionNumber !== undefined &&
      input.currentRevisionNumber !== undefined &&
      evidence.revisionNumber !== input.currentRevisionNumber
    ) {
      continue;
    }
    const time = timeOf(evidence.startedAt);
    if (time === null) continue;
    if (
      input.currentRevisionNumber !== undefined &&
      revisionTime === null &&
      evidence.revisionNumber !== input.currentRevisionNumber
    )
      continue;
    if (revisionTime !== null && time < revisionTime) continue;
    const key = `${evidence.kind}:${evidence.id}`;
    const existing = byId.get(key);
    if (
      !existing ||
      time > existing.time ||
      (time === existing.time &&
        OUTCOME_PRIORITY[evidence.outcome] >
          OUTCOME_PRIORITY[existing.evidence.outcome])
    ) {
      byId.set(key, { evidence, time });
    }
  }
  return [...byId.values()]
    .sort(compareAttempts)
    .map((entry) => entry.evidence);
}

/**
 * Resolve the status a plan's badge shows. Pending and Dismissed always
 * reflect the stored review. An approved plan shows Implementing while any
 * relevant attempt is active, otherwise Implemented when one succeeded,
 * otherwise Approved. Missing or unplaceable evidence never upgrades it.
 */
export function resolvePlanDisplayStatus(
  input: PlanDisplayStatusInput,
): PlanDisplayStatus {
  const review = input.reviewStatus;
  if (review === 'pending') {
    return {
      kind: 'pending',
      label: STORED_LABELS.pending,
      executeEmphasis: 'primary',
      primaryAction: 'execute',
    };
  }
  if (review === 'dismissed') {
    return {
      kind: 'dismissed',
      label: STORED_LABELS.dismissed,
      executeEmphasis: 'secondary',
      primaryAction: 'execute',
    };
  }
  if (review !== 'approved') {
    return {
      kind: 'unknown',
      label: review ? sentenceCase(review) : '',
      executeEmphasis: 'primary',
      primaryAction: 'execute',
    };
  }

  const attempts = relevantAttempts(input);
  const latest = attempts[0];
  const latestUnsuccessful =
    latest && (latest.outcome === 'failed' || latest.outcome === 'cancelled')
      ? latest
      : undefined;
  const active = attempts.find((attempt) => attempt.outcome === 'active');
  if (active) {
    return {
      kind: 'implementing',
      label: EXECUTION_LABELS.implementing[active.kind],
      selected: active,
      ...(latestUnsuccessful ? { latestUnsuccessful } : {}),
      executeEmphasis: 'secondary',
      primaryAction: 'open',
    };
  }
  const succeeded = attempts.find((attempt) => attempt.outcome === 'succeeded');
  if (succeeded) {
    return {
      kind: 'implemented',
      label: EXECUTION_LABELS.implemented[succeeded.kind],
      selected: succeeded,
      ...(latestUnsuccessful ? { latestUnsuccessful } : {}),
      executeEmphasis: 'secondary',
      primaryAction: 'open',
    };
  }
  return {
    kind: 'approved',
    label: STORED_LABELS.approved,
    ...(latestUnsuccessful ? { latestUnsuccessful } : {}),
    executeEmphasis: 'secondary',
    primaryAction: 'execute',
  };
}
