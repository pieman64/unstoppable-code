import type { LedgerContainer } from '@canopy/protocol/canopy-core';

/**
 * A committed Ledger change, as interfaces learn of it: the container whose
 * ledger changed, the entry and its new revision. Never content.
 */
export interface LedgerEntryChange {
  readonly container: LedgerContainer;
  /** The ledger that changed; a global (workflow) view is addressed by it. */
  readonly ledgerId: string;
  readonly entryId: string;
  readonly revision: number;
  /** A pending title marker resolved without a further revision change. */
  readonly titleResolved?: true;
}

export type LedgerEntryChangeListener = (change: LedgerEntryChange) => void;

const listeners = new Set<LedgerEntryChangeListener>();
/** Calls in progress whose changes listeners must not hear (E2E only). */
let withheld = 0;

/** Subscribes to committed changes. Returns the unsubscribe. */
export function onLedgerEntryChanged(
  listener: LedgerEntryChangeListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Tells every listener about a committed change. A listener that throws is
 * skipped: a change has already committed when it is reported.
 */
export function notifyLedgerEntryChanged(change: LedgerEntryChange): void {
  if (withheld > 0) return;
  listeners.forEach((listener): void => {
    try {
      listener(change);
    } catch {
      // Interfaces refresh from the next change or their next read.
    }
  });
}

/**
 * A change in how a Ledger's entries sync, with no new revision: never
 * content, and never an ID beyond the container and its ledger.
 */
export type LedgerSyncChange =
  /** The mirror acknowledged entries, or the scope's audience or repair changed. */
  | {
      readonly kind: 'scope';
      readonly container: LedgerContainer;
      readonly ledgerId: string;
    }
  /** What may sync changed for every scope: the account, sharing or policy. */
  | { readonly kind: 'all' }
  /** Scopes of a merged guest account now belong to the account it became. */
  | { readonly kind: 'accounts_rebound' };

export type LedgerSyncChangeListener = (change: LedgerSyncChange) => void;

const syncListeners = new Set<LedgerSyncChangeListener>();

/** Subscribes to sync changes. Returns the unsubscribe. */
export function onLedgerSyncChanged(
  listener: LedgerSyncChangeListener,
): () => void {
  syncListeners.add(listener);
  return (): void => {
    syncListeners.delete(listener);
  };
}

/** Tells every listener about a sync change. A listener that throws is skipped. */
export function notifyLedgerSyncChanged(change: LedgerSyncChange): void {
  syncListeners.forEach((listener): void => {
    try {
      listener(change);
    } catch {
      // Interfaces refresh from the next change or their next read.
    }
  });
}

/**
 * E2E only: runs `commit` without telling listeners about the changes made
 * meanwhile, as when an interface has not heard of a change yet. Specs use it
 * to stage a revision conflict deterministically.
 */
export async function withLedgerChangesWithheldForE2e<Result>(
  commit: () => Promise<Result>,
): Promise<Result> {
  withheld += 1;
  try {
    return await commit();
  } finally {
    withheld -= 1;
  }
}
