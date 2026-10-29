import { create } from 'zustand';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import { aiCreditsScopeKey, readNavigationScopeKey } from './aiCreditsScope';

/**
 * Personal model-library access in the renderer (CAN-4028).
 *
 * One shared read of `loadCanopyCloudEntitlements`, bound to the account it
 * describes. Everything that renders or acts on a library lock reads this
 * store, so the picker, Auto, the default lane, and the unlock poll can never
 * disagree about the same account.
 *
 * PERSONAL CONTEXT ONLY. The value is the signed-in person's own access.
 * Organization-owned work uses the separate scoped read through
 * `useWorkModelLibraryAccess`; no personal value is borrowed for that work.
 *
 * `undefined` access means UNKNOWN, never "unlocked" and never "locked": the
 * read has not landed, failed with nothing retained, or came from a server
 * that predates the field. Callers fall back to the guest rules in
 * {@link resolveModelLibraryLock}, and the server still enforces.
 */

/** An access value that still locks advanced models. */
export type LockedModelLibraryAccess = Exclude<ModelLibraryAccess, 'unlocked'>;

interface ModelLibraryAccessState {
  /** Account the value describes. `undefined` until the first read lands. */
  readonly accountKey: string | null | undefined;
  readonly access: ModelLibraryAccess | undefined;
  readonly workAccess?: Readonly<Record<string, ModelLibraryAccessRead>>;
}

export const useModelLibraryAccessStore = create<ModelLibraryAccessState>(
  () => ({ accountKey: undefined, access: undefined }),
);

/** One settled read, as the unlock poll needs it. */
export interface ModelLibraryAccessRead {
  readonly accountKey: string | null;
  readonly access: ModelLibraryAccess | undefined;
  /**
   * True only when THIS read carried the server's own answer. A retained value
   * keeps the picker steady through a blip, but it is the previous answer, so
   * it can never confirm that a payment unlocked anything.
   */
  readonly authoritative: boolean;
  readonly ownerKey?: string;
}

/**
 * The lock that applies to a principal, or `undefined` when nothing is locked.
 *
 * The single place the two inputs are folded, so every surface applies the
 * same rules:
 *
 * - A guest is ALWAYS locked to the allowlist, whatever access says. That is
 *   the funded-guest restriction: a guest's balance never widens the list. The
 *   access value only chooses which remedy the hint names.
 * - A signed-in account is locked only on an explicit `needs_purchase`. An
 *   unknown value, or a guest-shaped value that has not caught up with a
 *   sign-in yet, renders no lock: a wrongly shown purchase lock sells the user
 *   something they may already have, while a wrongly hidden one is still
 *   refused by the server.
 */
export function resolveModelLibraryLock(
  isGuest: boolean,
  access: ModelLibraryAccess | undefined,
): LockedModelLibraryAccess | undefined {
  if (isGuest) {
    return access === 'needs_sign_in_then_purchase' ? access : 'needs_sign_in';
  }
  return access === 'needs_purchase' ? access : undefined;
}

let inFlight: Promise<ModelLibraryAccessRead | null> | null = null;
/** Bumped whenever the account may have changed; stale reads never apply. */
let readEpoch = 0;
const workReads = new Map<string, Promise<ModelLibraryAccessRead | null>>();

/** Fresh access for this scope's authorized owner. Never borrows personal access. */
export function refreshWorkModelLibraryAccess(
  scope?: AiCreditsScopeRequest,
): Promise<ModelLibraryAccessRead | null> {
  const navigationKey = readNavigationScopeKey();
  const key = aiCreditsScopeKey(scope, navigationKey);
  const existing = workReads.get(key);
  if (existing) return existing;
  const epoch = readEpoch;
  const started = (async (): Promise<ModelLibraryAccessRead | null> => {
    const load = window.api?.loadCanopyCloudEntitlements;
    if (!load) return null;
    try {
      const result = await load(scope ?? { kind: 'navigation' });
      if (
        epoch !== readEpoch ||
        navigationKey !== readNavigationScopeKey() ||
        result.modelLibraryAccountKey === undefined ||
        result.modelLibraryOwnerKey === undefined ||
        !result.workModelLibrary
      )
        return null;
      const reported = result.workModelLibrary;
      const read: ModelLibraryAccessRead = {
        accountKey: result.modelLibraryAccountKey,
        ownerKey: result.modelLibraryOwnerKey,
        access:
          reported.status === 'reported' || reported.status === 'retained'
            ? reported.access
            : undefined,
        authoritative: reported.status === 'reported',
      };
      const current = useModelLibraryAccessStore.getState();
      if (
        current.accountKey !== undefined &&
        current.accountKey !== read.accountKey
      )
        return null;
      const entries = { ...current.workAccess, [key]: read };
      const keys = Object.keys(entries);
      if (keys.length > 100 && keys[0]) delete entries[keys[0]];
      useModelLibraryAccessStore.setState({ workAccess: entries });
      return read;
    } catch {
      return null;
    }
  })().finally((): void => {
    if (workReads.get(key) === started) workReads.delete(key);
  });
  workReads.set(key, started);
  return started;
}

async function readOnce(): Promise<ModelLibraryAccessRead | null> {
  const epoch = readEpoch;
  const load = window.api?.loadCanopyCloudEntitlements;
  if (typeof load !== 'function') return null;
  let state: Awaited<ReturnType<typeof load>>;
  try {
    state = await load();
  } catch {
    return null;
  }
  // A main process that predates the field says nothing about access.
  if (
    state.modelLibrary === undefined ||
    state.modelLibraryAccountKey === undefined
  ) {
    return null;
  }
  // The account moved while this was on the wire. Its answer describes the
  // previous account and must not be written or returned.
  if (epoch !== readEpoch) return null;
  const accountKey = state.modelLibraryAccountKey;
  const previous = useModelLibraryAccessStore.getState();
  const sameAccount = previous.accountKey === accountKey;
  const reported = state.modelLibrary;
  const access =
    reported.status === 'reported' || reported.status === 'retained'
      ? reported.access
      : reported.status === 'not-reported'
        ? // A definitive answer from a server without the gate: clear, and let
          // the guest rules decide.
          undefined
        : // Unknown. Keep what we hold for this same account, nothing else.
          sameAccount
          ? previous.access
          : undefined;
  if (!sameAccount || previous.access !== access) {
    useModelLibraryAccessStore.setState({ accountKey, access });
  }
  return { accountKey, access, authoritative: reported.status === 'reported' };
}

/**
 * Re-read personal access from the server and publish it.
 *
 * Single-flight: callers that ask while a read is on the wire share it, so
 * the unlock poll, a window focus, and a return link can never stack reads.
 * Resolves `null` when no answer was obtained; never rejects.
 */
export function refreshModelLibraryAccess(): Promise<ModelLibraryAccessRead | null> {
  if (inFlight !== null) return inFlight;
  const started = readOnce().finally((): void => {
    if (inFlight === started) inFlight = null;
  });
  inFlight = started;
  return started;
}

/**
 * The account may have changed. Drop the previous account's value BEFORE the
 * next read lands rather than after, so it is never rendered for the new one,
 * then read again.
 */
async function reconcileAccount(): Promise<void> {
  const loadAccount = window.api?.loadCanopyCloudAccount;
  if (typeof loadAccount === 'function') {
    let accountKey: string | null = null;
    try {
      accountKey = cloudAccountIdentityKey(await loadAccount());
    } catch {
      accountKey = null;
    }
    const previous = useModelLibraryAccessStore.getState().accountKey;
    if (previous !== undefined && previous !== accountKey) {
      readEpoch += 1;
      inFlight = null;
      workReads.clear();
      useModelLibraryAccessStore.setState({
        accountKey,
        access: undefined,
        workAccess: {},
      });
    }
  }
  await refreshModelLibraryAccess();
}

let subscribed = false;

/**
 * Start following the account, and make sure a first answer is on its way.
 *
 * Idempotent, and called by consumers as they mount, so importing this module
 * from a test or a non-chat window costs nothing. The listener is installed
 * once. The read is requested again by each caller for as long as NO read has
 * ever landed: a first read that failed (offline at launch) would otherwise
 * leave access unknown until the next account event, which may never come.
 * Requests share the single-flight read, so this cannot stack.
 */
export function ensureModelLibraryAccessSubscribed(): void {
  if (typeof window === 'undefined') return;
  if (!subscribed) {
    subscribed = true;
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, (): void => {
      void reconcileAccount();
    });
  }
  if (useModelLibraryAccessStore.getState().accountKey === undefined) {
    void refreshModelLibraryAccess();
  }
}

/** Test-only: resets module state between Jest cases. */
export function resetModelLibraryAccessForTests(): void {
  readEpoch += 1;
  inFlight = null;
  workReads.clear();
  useModelLibraryAccessStore.setState({
    accountKey: undefined,
    access: undefined,
    workAccess: {},
  });
}
