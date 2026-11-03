import { create } from 'zustand';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import type { AiCreditsCheckFeedbackKind } from '@canopy/ui-shared';
import type {
  AiCreditsArrivalHandoff,
  AiCreditsArrivalOrigin,
} from '@/lib/aiCreditsArrivalConfirmation';

/**
 * The pending browser checkout of a chat banner's Get AI Credits (CAN-5534).
 *
 * The hand-off used to live in the CTA instance, so switching chats reset it:
 * the waiting copy, Check again and Reopen billing disappeared, a fresh
 * purchase action returned, and the arrival handle was cancelled. It now lives
 * here, for the renderer session only: it survives remounts, hidden banners
 * and navigation, never an app reload.
 *
 * One record per purchase scope (`aiCreditsWalletKey`: project, worktree and
 * navigation context, without the chat), so every chat banner in that scope
 * shows the return controls instead of a second checkout. A record still
 * remembers the chat and banner that started it: the arrival is that chat's.
 *
 * A record ends only when coverage is confirmed, its originating usage-limit
 * notice is dismissed, {@link AI_CREDITS_HANDOFF_MAX_AGE_MS} passes, or the
 * account changes. Timing out restores the purchase action; it does not mean
 * the browser checkout was cancelled.
 */

/** Fixed lifetime from the successful browser open. Nothing extends it. */
export const AI_CREDITS_HANDOFF_MAX_AGE_MS = 10 * 60_000;

export interface AiCreditsHandoffRecord {
  readonly id: string;
  /** The purchase scope this record suppresses fresh purchases in. */
  readonly walletKey: string;
  /** `chatBannerKey` of the chat that started it, when it had one. */
  readonly originChatKey: string | null;
  /** The originating chat's own credits scope key. */
  readonly originScopeKey: string;
  /** The banner whose click started it; `null` when it tracks no arrival. */
  readonly origin: AiCreditsArrivalOrigin | null;
  readonly startedAt: number;
  /** The last explicit Check again verdict, shared by every chat in scope. */
  readonly feedback: AiCreditsCheckFeedbackKind | null;
  /** The buying account; `undefined` while it is being identified. */
  readonly accountKey: string | undefined;
  /**
   * The account could not be read since. The record stays, but a coverage
   * found meanwhile is not attributed to its chat.
   */
  readonly identityUnverified: boolean;
  readonly accountGeneration: number;
}

interface AiCreditsHandoffState {
  readonly records: Readonly<Record<string, AiCreditsHandoffRecord>>;
  /** Bumped whenever the account session ends; fences every async result. */
  readonly accountGeneration: number;
}

export const useAiCreditsHandoffStore = create<AiCreditsHandoffState>(() => ({
  records: {},
  accountGeneration: 0,
}));

/**
 * Arrival handles, by record id. Outside Zustand state: they are live objects
 * with their own lifecycle, not presentation.
 */
const arrivalHandles = new Map<string, AiCreditsArrivalHandoff>();
/** One initial browser open per purchase scope until its record exists. */
const openingLatches = new Map<string, object>();
/** The account established by a reconcile or identity read, if any. */
let knownAccountKey: string | null | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let handoffCounter = 0;
const invalidatedIdentities = new Set<string>();

function isExpired(record: AiCreditsHandoffRecord, now: number): boolean {
  return now >= record.startedAt + AI_CREDITS_HANDOFF_MAX_AGE_MS;
}

function releaseHandle(id: string): void {
  arrivalHandles.get(id)?.cancel();
  arrivalHandles.delete(id);
  invalidatedIdentities.delete(id);
}

function setRecords(
  records: Readonly<Record<string, AiCreditsHandoffRecord>>,
  accountGeneration?: number,
): void {
  useAiCreditsHandoffStore.setState(
    accountGeneration === undefined
      ? { records }
      : { records, accountGeneration },
  );
  scheduleExpiry();
}

function withoutRecord(
  walletKey: string,
): Readonly<Record<string, AiCreditsHandoffRecord>> {
  const next = { ...useAiCreditsHandoffStore.getState().records };
  delete next[walletKey];
  return next;
}

/** One timer for the earliest deadline, whether or not a banner is mounted. */
function scheduleExpiry(): void {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const records = Object.values(useAiCreditsHandoffStore.getState().records);
  if (records.length === 0) return;
  const deadline = Math.min(
    ...records.map((r) => r.startedAt + AI_CREDITS_HANDOFF_MAX_AGE_MS),
  );
  expiryTimer = setTimeout(
    (): void => {
      expiryTimer = null;
      expireAiCreditsHandoffs();
    },
    Math.max(0, deadline - Date.now()),
  );
}

/**
 * End every record past its deadline. Also called before adopting or
 * completing one: a suspended machine fires its timer late.
 */
export function expireAiCreditsHandoffs(now = Date.now()): void {
  const { records } = useAiCreditsHandoffStore.getState();
  const expired = Object.values(records).filter((r) => isExpired(r, now));
  if (expired.length === 0) return;
  const next = { ...records };
  for (const record of expired) {
    delete next[record.walletKey];
    releaseHandle(record.id);
  }
  setRecords(next);
}

/** The pending hand-off for a purchase scope, or `null`. */
export function selectAiCreditsHandoff(
  state: AiCreditsHandoffState,
  walletKey: string | null,
): AiCreditsHandoffRecord | null {
  return walletKey === null ? null : (state.records[walletKey] ?? null);
}

/**
 * Whether this exact record is still the scope's pending hand-off for the
 * account generation an async operation started under.
 */
export function isAiCreditsHandoffCurrent(
  walletKey: string,
  id: string,
  accountGeneration: number,
): boolean {
  expireAiCreditsHandoffs();
  const state = useAiCreditsHandoffStore.getState();
  return (
    state.accountGeneration === accountGeneration &&
    state.records[walletKey]?.id === id
  );
}

export function hasAiCreditsHandoffs(): boolean {
  return (
    openingLatches.size > 0 ||
    Object.keys(useAiCreditsHandoffStore.getState().records).length > 0
  );
}

/**
 * Take the scope's initial-open latch, or `null` when another CTA holds it or
 * a hand-off is already pending, so two mounted CTAs cannot both launch a
 * checkout. Release it once the open settles.
 */
export function claimAiCreditsHandoffOpening(walletKey: string): object | null {
  expireAiCreditsHandoffs();
  if (openingLatches.has(walletKey)) return null;
  if (useAiCreditsHandoffStore.getState().records[walletKey]) return null;
  const token = {};
  openingLatches.set(walletKey, token);
  return token;
}

export function releaseAiCreditsHandoffOpening(
  walletKey: string,
  token: object,
): void {
  if (openingLatches.get(walletKey) === token) openingLatches.delete(walletKey);
}

export interface BeginAiCreditsHandoffInput {
  readonly walletKey: string;
  readonly originChatKey: string | null;
  readonly originScopeKey: string;
  readonly origin: AiCreditsArrivalOrigin | null;
  /** The generation the open started under; a later one rejects it. */
  readonly accountGeneration: number;
  /** Owned by the store from here on, adopted or not. */
  readonly arrival: AiCreditsArrivalHandoff | null;
}

/**
 * Record a successful browser open. An existing record for the scope is
 * adopted unchanged, keeping its baseline and deadline; the new arrival
 * handle is then cancelled. `null` when the account changed meanwhile.
 */
export function beginAiCreditsHandoff(
  input: BeginAiCreditsHandoffInput,
): AiCreditsHandoffRecord | null {
  expireAiCreditsHandoffs();
  const state = useAiCreditsHandoffStore.getState();
  if (state.accountGeneration !== input.accountGeneration) {
    input.arrival?.cancel();
    return null;
  }
  const existing = state.records[input.walletKey];
  if (existing) {
    input.arrival?.cancel();
    return existing;
  }
  const record: AiCreditsHandoffRecord = {
    id: `credits-handoff-${Date.now().toString(36)}-${++handoffCounter}`,
    walletKey: input.walletKey,
    originChatKey: input.originChatKey,
    originScopeKey: input.originScopeKey,
    origin: input.origin,
    startedAt: Date.now(),
    feedback: null,
    // The arrival may already have verified the buyer before browser opening.
    // Keep that identity if this store's follow-up read is temporarily offline.
    accountKey: input.arrival?.accountKey ?? undefined,
    identityUnverified: false,
    accountGeneration: state.accountGeneration,
  };
  if (input.arrival !== null) arrivalHandles.set(record.id, input.arrival);
  setRecords({ ...state.records, [input.walletKey]: record });
  identifyAccount(record);
  return record;
}

/** Bind a new record to the account it was bought from. */
function identifyAccount(record: AiCreditsHandoffRecord): void {
  const loadAccount = window.api?.loadCanopyCloudAccount;
  if (typeof loadAccount !== 'function') {
    markUnverified(record);
    return;
  }
  const settle = (key: string | null): void => {
    if (
      !isAiCreditsHandoffCurrent(
        record.walletKey,
        record.id,
        record.accountGeneration,
      )
    )
      return;
    if (key === null) {
      markUnverified(record);
      return;
    }
    if (
      (record.accountKey !== undefined && record.accountKey !== key) ||
      (knownAccountKey !== undefined && knownAccountKey !== key)
    ) {
      endAiCreditsHandoff(
        record.walletKey,
        record.id,
        record.accountGeneration,
      );
      return;
    }
    knownAccountKey = key;
    updateRecord(record.walletKey, record.id, record.accountGeneration, {
      accountKey: key,
      identityUnverified: false,
    });
  };
  // Through a promise chain, so a synchronous bridge throw is a failed read.
  void Promise.resolve()
    .then(() => loadAccount())
    .then(
      (account): void => {
        if (account.read !== undefined && account.read !== 'ok') {
          settle(null);
          return;
        }
        const key = cloudAccountIdentityKey(account);
        if (key === null) {
          if (
            isAiCreditsHandoffCurrent(
              record.walletKey,
              record.id,
              record.accountGeneration,
            )
          ) {
            reconcileAiCreditsHandoffAccount({ kind: 'signed-out' });
          }
          return;
        }
        settle(key);
      },
      (): void => settle(null),
    );
}

function markUnverified(record: AiCreditsHandoffRecord): void {
  updateRecord(record.walletKey, record.id, record.accountGeneration, {
    identityUnverified: true,
  });
}

function updateRecord(
  walletKey: string,
  id: string,
  accountGeneration: number,
  patch: Partial<
    Pick<
      AiCreditsHandoffRecord,
      'feedback' | 'accountKey' | 'identityUnverified'
    >
  >,
): boolean {
  if (!isAiCreditsHandoffCurrent(walletKey, id, accountGeneration))
    return false;
  const { records } = useAiCreditsHandoffStore.getState();
  const record = records[walletKey];
  if (!record) return false;
  setRecords({ ...records, [walletKey]: { ...record, ...patch } });
  return true;
}

/** Store the last explicit Check again verdict for every chat in scope. */
export function setAiCreditsHandoffFeedback(
  walletKey: string,
  id: string,
  accountGeneration: number,
  feedback: AiCreditsCheckFeedbackKind | null,
): void {
  const record = useAiCreditsHandoffStore.getState().records[walletKey];
  if (record?.id === id && record.feedback === feedback) return;
  updateRecord(walletKey, id, accountGeneration, { feedback });
}

/**
 * Coverage confirmed. The first caller for this record and generation records
 * the arrival for the originating chat, then removes the record; every later
 * or stale caller gets `false` and changes nothing. Announce after this.
 */
export function completeAiCreditsHandoff(
  walletKey: string,
  id: string,
  accountGeneration: number,
): boolean {
  if (!isAiCreditsHandoffCurrent(walletKey, id, accountGeneration))
    return false;
  const record = useAiCreditsHandoffStore.getState().records[walletKey];
  // Keep both the checkout and its baseline until the buyer is verified.
  if (record?.identityUnverified !== false || record.accountKey === undefined)
    return false;
  const handle = arrivalHandles.get(id);
  arrivalHandles.delete(id);
  invalidatedIdentities.delete(id);
  handle?.recordCovered();
  setRecords(withoutRecord(walletKey));
  return true;
}

/**
 * End a record without coverage: its originating usage-limit notice was
 * dismissed, or its account changed. Naming it means a late call cannot end a
 * newer record for the same scope.
 */
export function endAiCreditsHandoff(
  walletKey: string,
  id: string,
  accountGeneration: number,
): void {
  if (!isAiCreditsHandoffCurrent(walletKey, id, accountGeneration)) return;
  releaseHandle(id);
  setRecords(withoutRecord(walletKey));
}

/** Fence in-flight work immediately, before the root's identity read settles. */
export function suspendAiCreditsHandoffAccount(): void {
  const state = useAiCreditsHandoffStore.getState();
  const accountGeneration = state.accountGeneration + 1;
  const records: Record<string, AiCreditsHandoffRecord> = {};
  for (const [key, record] of Object.entries(state.records)) {
    if (record.accountKey === undefined) invalidatedIdentities.add(record.id);
    records[key] = { ...record, accountGeneration, identityUnverified: true };
  }
  openingLatches.clear();
  setRecords(records, accountGeneration);
}

/** What a root-level account re-read found. */
export type AiCreditsHandoffAccountIdentity =
  | { readonly kind: 'account'; readonly key: string }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unreadable' };

function endSession(): void {
  const state = useAiCreditsHandoffStore.getState();
  for (const id of arrivalHandles.keys()) releaseHandle(id);
  openingLatches.clear();
  invalidatedIdentities.clear();
  setRecords({}, state.accountGeneration + 1);
}

/**
 * Bring records in line with the saved account. The same account keeps them
 * (a credits refresh announces as an account change too); sign-out or a
 * different account ends them for good. An unreadable account is not a
 * sign-out: records stay but are not attributed until it reads again.
 */
export function reconcileAiCreditsHandoffAccount(
  identity: AiCreditsHandoffAccountIdentity,
): void {
  if (identity.kind === 'unreadable') {
    const { records } = useAiCreditsHandoffStore.getState();
    const next: Record<string, AiCreditsHandoffRecord> = {};
    for (const [key, record] of Object.entries(records)) {
      next[key] = { ...record, identityUnverified: true };
    }
    if (Object.keys(next).length > 0) setRecords(next);
    return;
  }
  if (identity.kind === 'signed-out') {
    knownAccountKey = null;
    endSession();
    return;
  }
  const changed =
    knownAccountKey !== undefined && knownAccountKey !== identity.key;
  knownAccountKey = identity.key;
  if (changed) {
    endSession();
    return;
  }
  const { records } = useAiCreditsHandoffStore.getState();
  const next: Record<string, AiCreditsHandoffRecord> = {};
  let dropped = false;
  for (const [key, record] of Object.entries(records)) {
    if (
      invalidatedIdentities.has(record.id) ||
      (record.accountKey !== undefined && record.accountKey !== identity.key)
    ) {
      releaseHandle(record.id);
      dropped = true;
      continue;
    }
    // Still identifying: its own read settles it against this account.
    next[key] =
      record.accountKey === identity.key
        ? { ...record, identityUnverified: false }
        : record;
  }
  if (dropped || Object.keys(next).length > 0) setRecords(next);
}

/** Test-only: resets module state between Jest cases. */
export function resetAiCreditsHandoffsForTests(): void {
  for (const id of arrivalHandles.keys()) releaseHandle(id);
  openingLatches.clear();
  knownAccountKey = undefined;
  invalidatedIdentities.clear();
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  useAiCreditsHandoffStore.setState({
    records: {},
    accountGeneration:
      useAiCreditsHandoffStore.getState().accountGeneration + 1,
  });
}
