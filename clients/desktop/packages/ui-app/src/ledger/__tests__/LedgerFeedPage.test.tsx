/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LedgerClient } from '@canopy/app-core';
import {
  createLedgerFeedStore,
  createLedgerViewStore,
} from '@canopy/app-state';
import type { LedgerFeedPage as LedgerFeedPageValue } from '@canopy/protocol/ledger-view';
import {
  LEDGER_FEED_SUBTITLE,
  LEDGER_FEED_TITLE,
  LedgerFeedPage,
} from '../LedgerFeedPage';
import type { LedgerFeedLocal } from '../LedgerFeed';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const EMPTY_PAGE: LedgerFeedPageValue = {
  rows: [],
  actors: [],
  nextCursor: null,
  hasMore: false,
  notice: null,
};

function unused(): never {
  throw new Error('Not read in this test');
}

const LOCAL_CLIENT: LedgerClient = {
  searchEntries: unused,
  getEntry: unused,
  addEntry: unused,
  updateEntry: unused,
  listOwners: unused,
  subscribeChanges: () => (): void => undefined,
};

const LOCAL: LedgerFeedLocal = {
  client: LOCAL_CLIENT,
  navigator: { openSource: unused, openFile: unused },
  scopeStore: (scope) => createLedgerViewStore(LOCAL_CLIENT, scope),
  scopeHasDraft: () => false,
  describeScope: () => null,
  addableScopes: [
    {
      scope: { projectId: 'project-1', worktreeId: 'wt-1' },
      label: 'fix-parser',
      project: 'Canopy',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage(
  capabilities: { ledgerFeed?: boolean; ledgerLocal?: boolean },
  local: LedgerFeedLocal | undefined,
): Promise<void> {
  const store = createLedgerFeedStore({
    searchFeed: () => Promise.resolve({ status: 'ok', value: EMPTY_PAGE }),
    getFeedEntry: unused,
  });
  act(() =>
    root.render(
      <LedgerFeedPage
        capabilities={capabilities}
        store={store}
        {...(local === undefined ? {} : { local })}
        visible
      />,
    ),
  );
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

function find(testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe('LedgerFeedPage', () => {
  it('puts the heading and the Feed in one 640px page column', async () => {
    await renderPage({ ledgerFeed: true, ledgerLocal: true }, LOCAL);

    const column = find('ledger-feed-page-column');
    expect(column?.getAttribute('class')).toContain('max-w-176');
    expect(column?.querySelector('h1')?.textContent).toBe(LEDGER_FEED_TITLE);
    expect(
      column?.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe(LEDGER_FEED_SUBTITLE);
    expect(column?.querySelector('[data-testid="ledger-feed"]')).not.toBe(null);
    expect(find('ledger-feed-add-entry')).not.toBeNull();
  });

  it('reads only without `ledgerLocal`, whatever the host passes', async () => {
    await renderPage({ ledgerFeed: true }, LOCAL);

    expect(find('ledger-feed')).not.toBeNull();
    expect(find('ledger-feed-add-entry')).toBeNull();
  });

  it('renders nothing without `ledgerFeed`', async () => {
    await renderPage({ ledgerLocal: true }, LOCAL);

    expect(container.innerHTML).toBe('');
  });
});
