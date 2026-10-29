import type { LedgerClient, LedgerFeedClient } from '@canopy/app-core';
import type { LedgerApi } from '@canopy/desktop-shared/types';

/**
 * The desktop Ledger client: the preload's Ledger API, which reads and writes
 * through main's dispatcher. Every call resolves with a result; a transport
 * failure (an IPC rejection) still rejects, and the view store reports it.
 */
export function createIpcLedgerClient(
  api: () => LedgerApi = (): LedgerApi => window.api.ledger,
): LedgerClient {
  return {
    searchEntries: (request) => api().searchEntries(request),
    getEntry: (request) => api().getEntry(request),
    addEntry: (request) => api().addEntry(request),
    updateEntry: (request) => api().updateEntry(request),
    listOwners: (request) => api().listOwners(request),
    subscribeChanges: (handler) => api().onEntriesChanged(handler),
  };
}

/** The desktop Feed client: main's Feed service, over the preload API. */
export function createIpcLedgerFeedClient(
  api: () => LedgerApi = (): LedgerApi => window.api.ledger,
): LedgerFeedClient {
  return {
    searchFeed: (request) => api().searchFeed(request),
    getFeedEntry: (request) => api().getFeedEntry(request),
  };
}
