import type { VaultStoredIntent } from './store-records';

/** Supplied only after authenticating the current entry and its contiguous chain. */
interface AuthenticatedMigrationLineage {
  readonly entryId: string;
  readonly importSequence: number;
  readonly revision: number;
}

/** Migration fences only; does not change vault mutation or replay semantics. */
export function isLiveMigrationIntent(
  intent: VaultStoredIntent,
  intents: readonly VaultStoredIntent[],
  isRunning: (sequence: number) => boolean,
  lineage?: AuthenticatedMigrationLineage,
): boolean {
  if (isRunning(intent.sequence)) return true;
  if (intent.state !== 'pending') return false;
  // Committed deletes outlive tombstone pruning and permanently forbid writes.
  if (
    intents.some(
      (item) =>
        item.entryId === intent.entryId &&
        item.kind === 'delete' &&
        item.state === 'committed',
    )
  )
    return false;
  return (
    lineage === undefined ||
    lineage.entryId !== intent.entryId ||
    intent.family !== 'copilot-account' ||
    intent.kind !== 'put' ||
    intent.sequence <= lineage.importSequence ||
    intent.expectedRevision === null ||
    intent.expectedRevision >= lineage.revision
  );
}
