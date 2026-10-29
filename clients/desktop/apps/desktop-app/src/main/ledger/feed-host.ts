import type { CanopyCloudAccountReadResult } from '../lib/canopy-cloud-account-store';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import { onLedgerEntryChanged, onLedgerSyncChanged } from './change-events';
import { createLedgerMirrorReader } from './feed-client';
import {
  LedgerFeedService,
  type LedgerFeedAccount,
  type LedgerFeedLocalScope,
} from './feed-service';
import { getLedgerStoreClient } from './storage-client';
import { ledgerDatabaseExists } from './sync-host';
import { ledgerViewScopeForContainer } from './view-scope';

/*
 * The desktop's Feed (phase 14): the Feed service over the signed-in account,
 * this device's scopes as the Ledger store records them, and the mirror's
 * read API. Any committed change, or change in how entries sync, drops the
 * cached first pages.
 */

/** Who the Feed reads for, from a read of the cloud account. */
export function toLedgerFeedAccount(
  read: CanopyCloudAccountReadResult,
): LedgerFeedAccount {
  if (read.status !== 'ok') return { kind: 'unknown' };
  const id = read.entry?.account?.id.trim() ?? '';
  return read.entry === null ||
    id.length === 0 ||
    read.entry.apiKey.trim().length === 0
    ? { kind: 'signed_out' }
    : { kind: 'signed_in', accountId: id };
}

/** This device's live scopes; none before the Ledger database exists. */
async function listLedgerFeedScopes(): Promise<LedgerFeedLocalScope[]> {
  if (!(await ledgerDatabaseExists())) return [];
  const records = await getLedgerStoreClient().listSyncScopes();
  return records
    .filter((record) => record.scope.lifecycleState !== 'retirement_pending')
    .map((record) => ({
      ledgerId: record.scope.scope.ledgerId,
      accountId: record.scope.accountId,
      container: record.scope.scope.container,
      containerCreatedAt: record.scope.containerCreatedAt,
      archived: record.scope.lifecycleState === 'archived',
    }));
}

let service: LedgerFeedService | undefined;
let unsubscribers: Array<() => void> = [];

/** The app's Feed service. Creating it reads and sends nothing. */
export function getLedgerFeedService(): LedgerFeedService {
  if (service !== undefined) return service;
  const created = new LedgerFeedService({
    readAccount: async (): Promise<LedgerFeedAccount> =>
      toLedgerFeedAccount(await readCanopyCloudAccountWithStatus()),
    listScopes: listLedgerFeedScopes,
    viewScope: ledgerViewScopeForContainer,
    mirror: createLedgerMirrorReader(),
  });
  unsubscribers = [
    onLedgerEntryChanged((): void => created.invalidate()),
    onLedgerSyncChanged((): void => created.invalidate()),
  ];
  service = created;
  return created;
}

/** Drops the Feed service and what it holds in memory. */
export function disposeLedgerFeedService(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  service = undefined;
}
