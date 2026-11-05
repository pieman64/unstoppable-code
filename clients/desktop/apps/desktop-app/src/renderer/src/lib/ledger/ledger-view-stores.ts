import type { LedgerClient, LedgerFeedClient } from '@canopy/app-core';
import {
  createLedgerFeedStore,
  createLedgerViewStore,
  ledgerViewHoldsDraft,
  type LedgerFeedStore,
  type LedgerViewStore,
} from '@canopy/app-state';
import {
  createLedgerFeedWorkStore,
  type LedgerFeedWorkStore,
} from '@canopy/app-state/ledger-feed';
import {
  ledgerViewScopeKey,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  canopyCloudAccountIdentity,
  isConclusiveAccountRead,
} from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import {
  createIpcLedgerClient,
  createIpcLedgerFeedClient,
} from '@/client/ipc-ledger-client';

/** The renderer's one Ledger client, over the preload API. */
export const desktopLedgerClient: LedgerClient = createIpcLedgerClient();
/** The renderer's Feed reads, shared by its Activity and work stores. */
export const desktopLedgerFeedClient: LedgerFeedClient =
  createIpcLedgerFeedClient();

/**
 * Views kept for the most recently shown scopes, so switching to another
 * worktree and back, or closing and reopening the panel, returns to the same
 * query, page, selection and scroll. A view holding a draft, a new entry's or
 * a correction's, is kept past the limit until every draft is saved or
 * cancelled. Entries stay in memory only.
 */
const RETAINED_LEDGER_VIEWS = 8;
/** A scope view's Activity pages, as the Feed panel shows them. */
const LEDGER_VIEW_PAGE_SIZE = 20;
const retainedViews = new Map<string, LedgerViewStore>();
/** Each Feed panel's Operations and Needs you, kept like its scope view. */
const retainedPanelWork = new Map<string, LedgerFeedWorkStore>();
/** The Feed's view, kept so returning finds its search, selection and drafts. */
let feedStore: LedgerFeedStore | undefined;
let feedWorkStore: LedgerFeedWorkStore | undefined;

/**
 * Who was signed in when the retained views were read; undefined until the
 * first conclusive account read. Views belong to that account: another
 * account's sign-in, or a sign-out, starts every view over, and reads still
 * in flight are dropped.
 */
let viewsAccount: string | null | undefined;
let accountReads = 0;
let watchingAccount = false;

async function checkAccount(): Promise<void> {
  const read = ++accountReads;
  try {
    const account = await window.api.loadCanopyCloudAccount();
    // A degraded read says nothing about who is signed in.
    if (read !== accountReads || !isConclusiveAccountRead(account)) return;
    const identity = canopyCloudAccountIdentity(account);
    if (viewsAccount !== undefined && identity !== viewsAccount) {
      retainedViews.forEach((store) => store.getState().reset());
      retainedPanelWork.forEach((store) => store.getState().reset());
      feedStore?.getState().reset();
      feedWorkStore?.getState().reset();
    }
    viewsAccount = identity;
  } catch {
    // An unreadable account keeps the views as they are.
  }
}

function watchAccount(): void {
  if (watchingAccount) return;
  watchingAccount = true;
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, () => {
    void checkAccount();
  });
  void checkAccount();
}

/** The view store of one task, created on first use. */
export function ledgerViewStoreFor(
  projectId: string,
  worktreeId: string,
): LedgerViewStore {
  return ledgerViewStoreForScope({ projectId, worktreeId });
}

/**
 * The view store of one scope, a task or a global (workflow) Ledger, created
 * on first use.
 */
export function ledgerViewStoreForScope(
  scope: LedgerViewScope,
): LedgerViewStore {
  watchAccount();
  const key = ledgerViewScopeKey(scope);
  const existing = retainedViews.get(key);
  if (existing !== undefined) {
    // Most recently used last.
    retainedViews.delete(key);
    retainedViews.set(key, existing);
    return existing;
  }
  const store = createLedgerViewStore(desktopLedgerClient, scope, {
    pageSize: LEDGER_VIEW_PAGE_SIZE,
  });
  retainedViews.set(key, store);
  while (retainedViews.size > RETAINED_LEDGER_VIEWS) {
    // The oldest view without a draft: letting a draft go would lose what
    // the person wrote.
    const oldest = Array.from(retainedViews.keys()).find(
      (candidate) =>
        candidate !== key && !holdsDraft(retainedViews.get(candidate)),
    );
    if (oldest === undefined) break;
    retainedViews.delete(oldest);
  }
  return store;
}

function holdsDraft(view: LedgerViewStore | undefined): boolean {
  return view !== undefined && ledgerViewHoldsDraft(view.getState());
}

/**
 * Whether a scope's view holds a draft: a new entry's or a correction. The
 * Feed keeps watching such scopes; its task picker checks the new entry's
 * draft itself. Never opens a view.
 */
export function ledgerViewHasDraft(
  projectId: string,
  worktreeId: string,
): boolean {
  return ledgerViewScopeHasDraft({ projectId, worktreeId });
}

/** {@link ledgerViewHasDraft} for any scope, a task or a global Ledger. */
export function ledgerViewScopeHasDraft(scope: LedgerViewScope): boolean {
  return holdsDraft(retainedViews.get(ledgerViewScopeKey(scope)));
}

/** The Feed's view store, created on first use. */
export function ledgerFeedStore(): LedgerFeedStore {
  watchAccount();
  feedStore ??= createLedgerFeedStore(desktopLedgerFeedClient);
  return feedStore;
}

/**
 * One Feed panel's Operations and Needs you: this scope's work rows and
 * reviews, in status order. Kept for the most recent panels, like their views.
 */
export function ledgerPanelWorkStoreFor(
  projectId: string,
  worktreeId: string,
): LedgerFeedWorkStore {
  watchAccount();
  const key = `${projectId}/${worktreeId}`;
  const existing = retainedPanelWork.get(key);
  if (existing !== undefined) {
    retainedPanelWork.delete(key);
    retainedPanelWork.set(key, existing);
    return existing;
  }
  const store = createLedgerFeedWorkStore(
    desktopLedgerFeedClient,
    desktopLedgerClient,
    { scope: { projectId, worktreeId }, sort: 'status' },
  );
  retainedPanelWork.set(key, store);
  while (retainedPanelWork.size > RETAINED_LEDGER_VIEWS) {
    const oldest = retainedPanelWork.keys().next().value;
    if (oldest === undefined) break;
    retainedPanelWork.delete(oldest);
  }
  return store;
}

/** The Feed's Operations and Needs you state, retained between page visits. */
export function ledgerFeedWorkStore(): LedgerFeedWorkStore {
  watchAccount();
  feedWorkStore ??= createLedgerFeedWorkStore(
    desktopLedgerFeedClient,
    desktopLedgerClient,
  );
  return feedWorkStore;
}
