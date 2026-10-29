import type { LedgerClient } from '@canopy/app-core';
import { createLedgerViewStore, type LedgerViewStore } from '@canopy/app-state';
import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import { ledgerPanelUiState } from '../ledger-panel-ui-state';

const USER = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
} as const;

const ENTRY: LedgerEntrySearchItem = {
  entryId: '00000000-0000-4000-8000-000000000101',
  revision: 1,
  type: 'TASK',
  title: 'Write the release notes',
  content: 'Cover the Feed panel.',
  highlights: [],
  referenceFiles: [],
  status: 'TODO',
  owner: USER,
  author: USER,
  attributionKind: 'self_reported',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  sourceAvailability: 'available',
};

function notRead(): Promise<never> {
  return Promise.reject(new Error('Not read'));
}

const CLIENT: LedgerClient = {
  searchEntries: notRead,
  getEntry: notRead,
  addEntry: notRead,
  updateEntry: notRead,
  onEntriesChanged: () => (): void => undefined,
};

function viewStore(): LedgerViewStore {
  return createLedgerViewStore(CLIENT, {
    projectId: 'project-1',
    worktreeId: 'wt-1',
  });
}

function reported(store: LedgerViewStore): unknown {
  return ledgerPanelUiState(store.getState(), 'project-1', 'wt-1');
}

describe('ledgerPanelUiState', () => {
  it('reports no draft while nothing is written', () => {
    expect(reported(viewStore())).not.toHaveProperty('draft');
  });

  it("reports a new entry's draft, shown or set aside", () => {
    const store = viewStore();
    store.getState().startEntry();
    expect(reported(store)).toMatchObject({ draft: 'shown' });
  });

  it('reports a correction draft as a draft on screen', () => {
    const store = viewStore();
    store.getState().startCorrection(ENTRY);

    expect(store.getState().composer.draft).toBeNull();
    expect(reported(store)).toMatchObject({ draft: 'shown' });
  });

  it('never reports the text of a draft', () => {
    const store = viewStore();
    store.getState().startCorrection(ENTRY);
    store
      .getState()
      .updateCorrection(ENTRY.entryId, { content: 'Secret correction' });

    expect(JSON.stringify(reported(store))).not.toContain('Secret');
  });
});
