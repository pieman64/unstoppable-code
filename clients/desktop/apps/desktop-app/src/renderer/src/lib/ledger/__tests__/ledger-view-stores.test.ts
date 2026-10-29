/**
 * @jest-environment jsdom
 */
import type {
  LedgerActorRef,
  LedgerEntriesSearchResult,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewResult } from '@canopy/protocol/ledger-view';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type * as LedgerViewStoresModule from '../ledger-view-stores';

const USER: LedgerActorRef = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'user',
  authorityId: 'authority-1',
};

const PAGE: LedgerViewResult<LedgerEntriesSearchResult> = {
  status: 'ok',
  value: {
    entries: [
      {
        entryId: '00000000-0000-4000-8000-000000000101',
        revision: 1,
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
        highlights: [],
        referenceFiles: [],
        status: 'TODO',
        owner: USER,
        author: USER,
        attributionKind: 'self_reported',
        createdAt: '2026-09-30T10:00:00.000Z',
        updatedAt: '2026-09-30T10:00:00.000Z',
        sourceAvailability: 'available',
      },
    ],
    nextCursor: null,
    hasMore: false,
    watermark: '1',
    actors: [],
  },
};

function signedIn(accountId: string): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    storageAvailable: true,
    account: {
      id: accountId,
      name: 'Someone',
      email: 'someone@example.com',
      role: 'DEVELOPER',
    },
  };
}

const UNREADABLE: CanopyCloudAccountPublicState = {
  read: 'error',
  hasApiKey: false,
  authMode: null,
  credentialSource: null,
  capabilities: [],
  storageAvailable: true,
};

let account: CanopyCloudAccountPublicState = signedIn('account-a');

beforeEach(() => {
  account = signedIn('account-a');
  Reflect.set(window, 'api', {
    loadCanopyCloudAccount: (): Promise<CanopyCloudAccountPublicState> =>
      Promise.resolve(account),
    ledger: {
      searchEntries: (): Promise<LedgerViewResult<LedgerEntriesSearchResult>> =>
        Promise.resolve(PAGE),
      getEntry: jest.fn(),
      onEntriesChanged: (): (() => void) => (): void => undefined,
    },
  });
});

/** The registry with its own module state, as a fresh renderer has it. */
function freshRegistry(): typeof LedgerViewStoresModule {
  let registry: typeof LedgerViewStoresModule | undefined;
  jest.isolateModules(() => {
    registry = jest.requireActual<typeof LedgerViewStoresModule>(
      '../ledger-view-stores',
    );
  });
  if (registry === undefined) throw new Error('The registry did not load');
  return registry;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

function announceAccountChange(): void {
  window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
}

describe('ledgerViewStoreFor', () => {
  it('keeps one view per scope', () => {
    const { ledgerViewStoreFor } = freshRegistry();

    expect(ledgerViewStoreFor('project-1', 'wt-1')).toBe(
      ledgerViewStoreFor('project-1', 'wt-1'),
    );
    expect(ledgerViewStoreFor('project-1', 'wt-2')).not.toBe(
      ledgerViewStoreFor('project-1', 'wt-1'),
    );
  });

  it("forgets every retained view when another account signs in, and keeps them for the same account's refresh", async () => {
    const { ledgerViewStoreFor } = freshRegistry();
    const store = ledgerViewStoreFor('project-1', 'wt-1');
    await store.getState().load();
    store.getState().setQueryText('release');
    await settle();

    // The same account announced again, or an account that can't be read,
    // changes nothing.
    announceAccountChange();
    await settle();
    account = UNREADABLE;
    announceAccountChange();
    await settle();
    expect(store.getState().list.entries).toHaveLength(1);
    expect(store.getState().queryText).toBe('release');

    account = signedIn('account-b');
    announceAccountChange();
    await settle();

    expect(store.getState()).toMatchObject({
      queryText: '',
      list: { status: 'idle', entries: [] },
      selectedEntryId: null,
    });
    // The scope keeps its one view, now empty until it reads again.
    expect(ledgerViewStoreFor('project-1', 'wt-1')).toBe(store);
  });

  it('keeps a view that holds a draft past the retention limit', () => {
    const { ledgerViewStoreFor } = freshRegistry();
    const drafting = ledgerViewStoreFor('project-1', 'wt-0');
    drafting.getState().startEntry();
    const plain = ledgerViewStoreFor('project-1', 'wt-plain');

    for (let index = 1; index <= 8; index += 1) {
      ledgerViewStoreFor('project-1', `wt-${String(index)}`);
    }

    // The oldest views without a draft went; the draft stayed.
    expect(ledgerViewStoreFor('project-1', 'wt-0')).toBe(drafting);
    expect(drafting.getState().composer.draft).not.toBeNull();
    expect(ledgerViewStoreFor('project-1', 'wt-plain')).not.toBe(plain);
  });

  it('keeps a view that holds only a correction draft past the retention limit', () => {
    const { ledgerViewStoreFor, ledgerViewHasDraft } = freshRegistry();
    const correcting = ledgerViewStoreFor('project-1', 'wt-0');
    const entry = PAGE.status === 'ok' ? PAGE.value.entries[0] : undefined;
    if (entry === undefined) throw new Error('The page has no entry.');
    correcting.getState().startCorrection(entry);

    for (let index = 1; index <= 8; index += 1) {
      ledgerViewStoreFor('project-1', `wt-${String(index)}`);
    }

    // A correction draft is kept like a new entry's draft.
    expect(ledgerViewStoreFor('project-1', 'wt-0')).toBe(correcting);
    expect(correcting.getState().corrections[entry.entryId]).toBeDefined();
    // The Feed keeps watching the scope, so the correction draft stays in
    // view when the Feed opens again.
    expect(ledgerViewHasDraft('project-1', 'wt-0')).toBe(true);
  });

  it('says which scopes hold a draft without opening a view', () => {
    const { ledgerViewStoreFor, ledgerViewHasDraft } = freshRegistry();
    const plain = ledgerViewStoreFor('project-1', 'wt-plain');
    ledgerViewStoreFor('project-1', 'wt-draft').getState().startEntry();

    expect(ledgerViewHasDraft('project-1', 'wt-draft')).toBe(true);
    expect(ledgerViewHasDraft('project-1', 'wt-plain')).toBe(false);
    for (let index = 0; index < 20; index += 1) {
      expect(ledgerViewHasDraft('project-1', `unseen-${String(index)}`)).toBe(
        false,
      );
    }
    // Looking opened no view, so none was let go of.
    expect(ledgerViewStoreFor('project-1', 'wt-plain')).toBe(plain);
  });

  it('forgets retained views on sign-out', async () => {
    const { ledgerViewStoreFor } = freshRegistry();
    const store = ledgerViewStoreFor('project-1', 'wt-1');
    await store.getState().load();
    await settle();

    account = {
      read: 'ok',
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    };
    announceAccountChange();
    await settle();

    expect(store.getState().list).toMatchObject({
      status: 'idle',
      entries: [],
    });
  });
});
