import type { LedgerFileRef } from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedEntryRequest,
  LedgerFeedPage,
  LedgerFeedRequest,
  LedgerViewAddRequest,
  LedgerViewChangedEvent,
  LedgerViewEntry,
  LedgerViewEntryRequest,
  LedgerViewFileCandidate,
  LedgerViewOpenResult,
  LedgerViewOwnerPage,
  LedgerViewOwnersRequest,
  LedgerViewReceipt,
  LedgerViewResult,
  LedgerViewScope,
  LedgerViewSearchRequest,
  LedgerViewSourceTarget,
  LedgerViewUpdateRequest,
} from '@canopy/protocol/ledger-view';
import type { LedgerEntriesSearchResult } from '@canopy/protocol/canopy-core';
import type { Unsubscribe } from '../events/domain-events';

/**
 * The seam the shared Ledger views depend on. Desktop implements it over IPC
 * to `core.ledger.*`; the stores and components never see a transport. Every
 * call resolves, never rejects: failures arrive as {@link LedgerViewResult}
 * errors so a view can never mistake one for an empty Ledger or a saved
 * change.
 */
export interface LedgerClient {
  searchEntries(
    request: LedgerViewSearchRequest,
  ): Promise<LedgerViewResult<LedgerEntriesSearchResult>>;
  getEntry(
    request: LedgerViewEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>>;
  /** Adds an entry as the person using the view. */
  addEntry(
    request: LedgerViewAddRequest,
  ): Promise<LedgerViewResult<LedgerViewReceipt>>;
  /** Changes an entry's status or owner as the person using the view. */
  updateEntry(
    request: LedgerViewUpdateRequest,
  ): Promise<LedgerViewResult<LedgerViewReceipt>>;
  /** One page of the owners the person may assign. */
  listOwners(
    request: LedgerViewOwnersRequest,
  ): Promise<LedgerViewResult<LedgerViewOwnerPage>>;
  /** Committed changes, coalesced by the host. */
  subscribeChanges(
    handler: (event: LedgerViewChangedEvent) => void,
  ): Unsubscribe;
}

/**
 * Host navigation for Ledger sources. Opening never starts, resumes or
 * restores anything as a side effect; an unavailable target resolves with
 * a message instead.
 */
export interface LedgerNavigator {
  openSource(
    scope: LedgerViewScope,
    target: LedgerViewSourceTarget,
  ): Promise<LedgerViewOpenResult>;
  /** Opens a reference file of the scope in the file panel, at its line. */
  openFile(
    scope: LedgerViewScope,
    file: LedgerFileRef,
  ): Promise<LedgerViewOpenResult>;
}

/**
 * Host file search for an entry's references: files under the scope's logical
 * roots, as root IDs and relative paths. Choosing one never uploads it.
 */
export interface LedgerFilePicker {
  searchFiles(
    scope: LedgerViewScope,
    query: string,
    limit: number,
  ): Promise<readonly LedgerViewFileCandidate[]>;
}

/**
 * The global Feed's reads (LD03): the person's entries on every device and,
 * when asked, their teammates', merged with this device's own scopes. Like
 * {@link LedgerClient}, every call resolves; a failure is a result.
 */
export interface LedgerFeedClient {
  searchFeed(
    request: LedgerFeedRequest,
  ): Promise<LedgerViewResult<LedgerFeedPage>>;
  /** A row of another device or a teammate, read only. */
  getFeedEntry(
    request: LedgerFeedEntryRequest,
  ): Promise<LedgerViewResult<LedgerViewEntry>>;
}
