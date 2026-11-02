import type {
  LedgerContainer,
  LedgerErrorReason,
} from '@canopy/protocol/canopy-core';

import {
  LEDGER_SCOPE_LIFECYCLE_STATES,
  type LedgerScopeLifecycleState,
} from './types';

/**
 * Pure scope lifecycle rules. A scope follows its container:
 *
 * - `active`: the container is live, and the scope accepts writes.
 * - `archived`: the container is archived; the scope is read-only.
 * - `retirement_pending`: the container was permanently deleted; the scope is
 *   read-only and waits to be purged. It never becomes live again.
 * - `purged`: the scope and every row that belongs to it are gone.
 *
 * The allowed moves are `active → archived` (archive), `archived → active`
 * (restore, including a rebind to the restored container), any state →
 * `retirement_pending` (permanent deletion or retention purge), and
 * `retirement_pending → purged`. Requesting the state a scope is already in
 * changes nothing. Every other move is refused: a retiring scope never comes
 * back, and a live scope is never removed without being retired first.
 *
 * A global scope has no container to follow: it is always `active`, and the
 * repository refuses every lifecycle command for it (`FORBIDDEN` on
 * `container.kind`), changing nothing. Startup reconciliation, deletion and
 * retention must skip it; `hasLedgerContainerLifecycle` tells them apart.
 *
 * The repository applies these rules inside its transaction.
 */

/** A lifecycle state, or the removal of the scope. */
export type LedgerScopeLifecycleTarget = LedgerScopeLifecycleState | 'purged';

/** Every move each state allows, besides staying where it is. */
export const LEDGER_SCOPE_LIFECYCLE_TRANSITIONS: {
  readonly [From in LedgerScopeLifecycleState]: readonly LedgerScopeLifecycleTarget[];
} = {
  active: ['archived', 'retirement_pending'],
  archived: ['active', 'retirement_pending'],
  retirement_pending: ['purged'],
};

/**
 * How a requested move resolves: `unchanged` for the current state (an
 * idempotent no-op), `transition` for an allowed move, `forbidden` otherwise.
 */
export type LedgerScopeLifecycleStep = 'unchanged' | 'transition' | 'forbidden';

export function ledgerScopeLifecycleStep(
  from: LedgerScopeLifecycleState,
  to: LedgerScopeLifecycleTarget,
): LedgerScopeLifecycleStep {
  if (from === to) return 'unchanged';
  return LEDGER_SCOPE_LIFECYCLE_TRANSITIONS[from].includes(to)
    ? 'transition'
    : 'forbidden';
}

/** True when the move is allowed, counting a same-state no-op as allowed. */
export function canTransitionLedgerScope(
  from: LedgerScopeLifecycleState,
  to: LedgerScopeLifecycleTarget,
): boolean {
  return ledgerScopeLifecycleStep(from, to) !== 'forbidden';
}

/** Only `active` scopes accept writes; the others fail `SCOPE_RETIRED`. */
export function isLedgerScopeWritable(
  state: LedgerScopeLifecycleState,
): boolean {
  return state === 'active';
}

/**
 * A rebind points a scope at another container incarnation and reactivates
 * it, so it is the restore transition: only an `archived` scope qualifies.
 */
export function canRebindLedgerScope(
  state: LedgerScopeLifecycleState,
): boolean {
  return ledgerScopeLifecycleStep(state, 'active') === 'transition';
}

/** Only a `retirement_pending` scope may be purged. */
export function canPurgeLedgerScope(state: LedgerScopeLifecycleState): boolean {
  return ledgerScopeLifecycleStep(state, 'purged') === 'transition';
}

/**
 * The store error reason for a refused move away from `from`.
 * `SCOPE_RETIRED` when the scope is retiring, since it can never change
 * again; `FORBIDDEN` when the scope is live (`active` or `archived`), since a
 * live scope must be retired before it is purged and an active scope is never
 * moved to another container.
 */
export function ledgerScopeLifecycleRejection(
  from: LedgerScopeLifecycleState,
): Extract<LedgerErrorReason, 'SCOPE_RETIRED' | 'FORBIDDEN'> {
  return from === 'retirement_pending' ? 'SCOPE_RETIRED' : 'FORBIDDEN';
}

/**
 * True for a scope that follows its container's lifecycle: every container
 * except `global`, which no archive, deletion, retention, run deletion or
 * account change ever retires.
 */
export function hasLedgerContainerLifecycle(
  container: LedgerContainer,
): boolean {
  return container.kind !== 'global';
}

export function isLedgerScopeLifecycleState(
  value: unknown,
): value is LedgerScopeLifecycleState {
  return LEDGER_SCOPE_LIFECYCLE_STATES.some(
    (state: LedgerScopeLifecycleState): boolean => state === value,
  );
}
