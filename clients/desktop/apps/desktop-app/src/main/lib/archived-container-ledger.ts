import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import {
  LEDGER_INTENT_REFUSING_WAIT_MS,
  ledgerDatabaseMayExist,
  notifyLedgerContainerPurged,
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';
import {
  ledgerIncarnationRetiredByPurge,
  ledgerRestoreMappingOf,
} from '../ledger/lifecycle-containers';
import { readArchivedContainerManifestIncludingExpired } from './archived-containers';
import { isErrnoException } from './type-guards';

/**
 * The Ledger side of permanently deleting an archived container, shared by
 * the ordinary deletion (`archived-containers:delete`) and the retained
 * archive discard (CAN-5338), so both keep the same mapping guarantees.
 */

/** Why a deletion did not happen: the archive's Ledger mapping was not saved. */
export const LEDGER_ARCHIVE_NOT_SAVED_MESSAGE =
  "Couldn't delete this item. Try again.";

/**
 * Tells the Ledger that an archived container was permanently deleted. The
 * scope of the container it was archived from retires, unless a restore
 * recorded a destination: that scope belongs to the restored container, so
 * its reattach is queued instead. Call only after the purge committed. The
 * participants return at once, so no archive lock is held while they wait on
 * Ledger storage.
 */
export function notifyLedgerOfArchivedContainerDeletion(
  manifest: ArchivedContainerManifest,
): void {
  try {
    const retired = ledgerIncarnationRetiredByPurge(manifest);
    if (retired !== null) notifyLedgerContainerPurged(retired);
    const mapping = ledgerRestoreMappingOf(manifest);
    if (mapping !== null) {
      notifyLedgerContainerRestored(mapping.archived, mapping.restored);
    }
  } catch {
    // The participants never throw. A defect in one must not fail a committed
    // deletion; startup reconciliation settles the scope.
  }
}

/**
 * Before a partially restored archive is deleted, makes its Ledger mapping
 * durable in the intent journal: the archive's `restoredTo` may be the only
 * lasting record of where its scope belongs. Waits a bounded time, and only
 * when the Ledger database exists. False when a Ledger exists but the
 * mapping could not be saved: the archive must then stay, and the deletion
 * can be retried.
 */
export async function recordLedgerMappingBeforeDeletion(
  manifest: ArchivedContainerManifest,
): Promise<boolean> {
  try {
    const mapping = ledgerRestoreMappingOf(manifest);
    if (mapping === null) return true;
    const recording = await recordLedgerRestoreIntent(
      mapping.archived,
      mapping.restored,
      { waitMs: LEDGER_INTENT_REFUSING_WAIT_MS },
    );
    return recording !== 'not_durable';
  } catch {
    return false;
  }
}

/**
 * The archive's manifest, expired or not, or null when it is missing or can
 * never be read (malformed): then it holds no mapping to keep, and startup
 * reconciliation settles the scope. Any other read failure may pass, and the
 * manifest may hold the only lasting record of a partial restore, so while a
 * Ledger database may exist it rejects and the deletion can be retried.
 */
export async function readArchivedIdentity(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerManifest | null> {
  try {
    return await readArchivedContainerManifestIncludingExpired(
      projectId,
      containerId,
    );
  } catch (error) {
    if (
      isErrnoException(error) &&
      error.code !== 'ENOENT' &&
      error.code !== 'ENOTDIR' &&
      (await ledgerDatabaseMayExist())
    ) {
      throw new Error(LEDGER_ARCHIVE_NOT_SAVED_MESSAGE);
    }
    return null;
  }
}
