import type {
  LedgerActorLabel,
  LedgerErrorReason,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewResult,
  LedgerViewUnavailableReason,
} from '@canopy/protocol/ledger-view';
import { sameLedgerValue } from './ledger-structural-sharing';

/*
 * What the Ledger panel's and the Feed's stores share: how a read's result
 * becomes something to show, and the search text the Ledger accepts.
 */

/** Why a read gave nothing to show. Never an empty result. */
export type LedgerViewProblem =
  | {
      readonly kind: 'unavailable';
      readonly reason: LedgerViewUnavailableReason;
    }
  | {
      readonly kind: 'error';
      readonly reason: LedgerErrorReason | 'UNKNOWN';
      readonly message: string;
    };

/** What a read that failed means to a view. */
export function problemOf(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): LedgerViewProblem {
  return result.status === 'unavailable'
    ? { kind: 'unavailable', reason: result.reason }
    : { kind: 'error', reason: result.reason, message: result.message };
}

/** A transport failure the client did not turn into a result. */
export function thrownResult(error: unknown): LedgerViewResult<never> {
  return {
    status: 'error',
    reason: 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Query text as the Ledger accepts it: no control characters, bounded. */
export { normalizeLedgerViewQuery as normalizeQuery } from '@canopy/protocol/ledger-view';

/** Adds labels to those a view already holds. */
export function withActors(
  current: Readonly<Record<string, LedgerActorLabel>>,
  labels: readonly LedgerActorLabel[] | undefined,
): Readonly<Record<string, LedgerActorLabel>> {
  if (labels === undefined || labels.length === 0) return current;
  // Unchanged labels keep the same object, so a refresh redraws nothing.
  const changed = labels.filter(
    (label) => !sameLedgerValue(current[label.actorId], label),
  );
  if (changed.length === 0) return current;
  const next: Record<string, LedgerActorLabel> = { ...current };
  for (const label of changed) next[label.actorId] = label;
  return next;
}
