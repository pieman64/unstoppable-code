import type { VaultStore } from './store';
import type { VaultStoredIntent } from './store-records';

/*
 * Restart reconciliation and tombstone retention (CAN-4500 unit E). The store
 * shows what every earlier write left, so the put and delete paths settle
 * each intent from the records alone when they open; these are the rules
 * they share. Retention never forgets an accepted key: a committed delete
 * intent keeps its entry removed once the tombstone goes. Inert, like the
 * rest of this folder.
 */

/** Tombstones are kept 30 days from the delete's commit (2026-10-29 checkpoint). */
export const VAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Removes every tombstone committed at least the retention period before
 * `now`, at open and on each trusted reconcile. Only the ref's `deleted`
 * becomes `absent`: the entry's intents stay, so its accepted keys keep
 * replaying. Best effort: a tombstone that stays only keeps its ref reading
 * `deleted`, and the next attempt tries again. A commit time that does not
 * parse is kept. Returns the entry IDs it tried to prune; an uncertain prune
 * leaves the store faulted.
 */
export function pruneExpiredTombstones(
  store: VaultStore,
  now: Date,
): readonly string[] {
  const cutoff = now.getTime() - VAULT_TOMBSTONE_RETENTION_MS;
  const expired = store
    .listTombstones()
    .filter((tombstone) => Date.parse(tombstone.committedAt) <= cutoff)
    .map((tombstone) => tombstone.entryId);
  if (expired.length > 0) store.pruneTombstones(expired);
  return expired;
}

/**
 * True when a delete was accepted after this committed put against an
 * earlier revision. That happens only while the put's commit was uncertain:
 * the delete superseded it in-process, so its landed revision publishes
 * nothing after a restart either.
 */
export function isSupersededCommit(
  put: VaultStoredIntent,
  intents: readonly VaultStoredIntent[],
): boolean {
  const { outcomeRevision } = put;
  return (
    put.kind === 'put' &&
    outcomeRevision !== null &&
    intents.some(
      (intent) =>
        intent.kind === 'delete' &&
        intent.entryId === put.entryId &&
        intent.sequence > put.sequence &&
        intent.expectedRevision !== null &&
        intent.expectedRevision < outcomeRevision,
    )
  );
}
