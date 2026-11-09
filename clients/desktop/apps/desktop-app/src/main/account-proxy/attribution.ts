// Which proxy account served each session's requests (CAN-4020). The proxy
// names the account on every response (`X-CPA-TRACE-ID`), and the loopback
// broker reports each response here, so attribution needs no read of the
// proxy's shared, lossy usage queue. Observability listens to record the
// accounts on each turn's audit entry (CAN-4021).
//
// This module imports no account-proxy service, so observability can load it
// at startup without the proxy's runtime.

import { parseAccountProxyTraceId } from '@canopy/desktop-shared/lib/account-proxy';
import type { AccountProxySessionAccount } from '@canopy/desktop-shared/types/account-proxy';
import type { AgentAuditAccountProxyUsage } from '@canopy/execution-engine/types/observability';

/** What the last account list read knows about an account. */
export interface AccountProxyAccountFacts {
  readonly label: string;
  readonly provider: string;
}

/**
 * Names an account from the last account list read. `authIndex` is only
 * meaningful on `connectionId`: another connection reuses the same ids for
 * other credentials, so a lookup answers null for any other connection.
 */
export type AccountProxyAccountLookup = (
  authIndex: string,
  connectionId: string,
) => AccountProxyAccountFacts | null;

interface AccountRecord {
  requests: number;
  label: string | null;
  provider: string | null;
}

interface SessionRecord {
  connectionId: string;
  lastAuthIndex: string | null;
  readonly accounts: Map<string, AccountRecord>;
}

/**
 * Bounds memory for long-lived apps with many short sessions. The least
 * recently used session goes first, so a chat that is still working outlives
 * a burst of pipeline steps.
 */
const MAX_SESSIONS = 500;
/** Helper calls get a one-off route id that nothing can look up later. */
const UNADDRESSABLE_SESSION_PREFIX = 'ephemeral:';
const sessions = new Map<string, SessionRecord>();

export interface AccountProxyAccountChange {
  readonly sessionId: string;
  readonly authIndex: string;
  readonly previousAuthIndex: string | null;
}

/** One proxied response, named by the account that served it. */
export interface AccountProxyResponse {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly authIndex: string;
  readonly label: string | null;
  readonly provider: string | null;
}

type ChangeListener = (change: AccountProxyAccountChange) => void;
type ResponseListener = (response: AccountProxyResponse) => void;
const changeListeners = new Set<ChangeListener>();
const responseListeners = new Set<ResponseListener>();

/** Called when a session's requests move to another account. */
export function onAccountProxyAccountChange(
  listener: ChangeListener,
): () => void {
  changeListeners.add(listener);
  return (): void => {
    changeListeners.delete(listener);
  };
}

/** Called for every proxied response of an addressable session. */
export function onAccountProxyResponse(listener: ResponseListener): () => void {
  responseListeners.add(listener);
  return (): void => {
    responseListeners.delete(listener);
  };
}

function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(value);
    } catch {
      // Listeners are best effort.
    }
  }
}

/** Records the account named by one response's trace header. */
export function recordAccountProxyResponse(options: {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly traceHeader: string | null;
  readonly lookupAccount: AccountProxyAccountLookup;
  /**
   * Whether this response says which account serves the chat now: a turn
   * that succeeded. A token count or a failed attempt is still counted, but
   * the proxy may answer it from another account without moving the chat,
   * so it neither changes the current account nor reports a move.
   */
  readonly movesChat?: boolean;
}): void {
  const { sessionId, connectionId } = options;
  if (sessionId.startsWith(UNADDRESSABLE_SESSION_PREFIX)) return;
  const trace = parseAccountProxyTraceId(options.traceHeader);
  if (!trace) return;
  let record = sessions.get(sessionId);
  if (record) {
    // Map order is insertion order; re-inserting marks it most recent.
    sessions.delete(sessionId);
  } else {
    if (sessions.size >= MAX_SESSIONS) {
      const leastRecent = sessions.keys().next().value;
      if (leastRecent !== undefined) sessions.delete(leastRecent);
    }
    record = { connectionId, lastAuthIndex: null, accounts: new Map() };
  }
  if (record.connectionId !== connectionId) {
    // A session that moved to another connection starts its count again:
    // the same `auth_index` names another credential there.
    record = { connectionId, lastAuthIndex: null, accounts: new Map() };
  }
  sessions.set(sessionId, record);
  const facts = options.lookupAccount(trace.authIndex, connectionId);
  const account = record.accounts.get(trace.authIndex) ?? {
    requests: 0,
    label: null,
    provider: null,
  };
  account.requests += 1;
  if (facts) {
    account.label = facts.label;
    account.provider = facts.provider;
  }
  record.accounts.set(trace.authIndex, account);
  const previous = record.lastAuthIndex;
  const movesChat = options.movesChat !== false;
  if (movesChat) record.lastAuthIndex = trace.authIndex;
  notify(responseListeners, {
    sessionId,
    connectionId,
    authIndex: trace.authIndex,
    label: account.label,
    provider: account.provider,
  });
  if (movesChat && previous !== null && previous !== trace.authIndex) {
    notify(changeListeners, {
      sessionId,
      authIndex: trace.authIndex,
      previousAuthIndex: previous,
    });
  }
}

/**
 * The accounts that served `sessionId`, most requests first, each with the
 * connection it was recorded under. `lookupAccount` names them from a fresher
 * account list of that connection when it knows them.
 */
export function getAccountProxySessionAccounts(
  sessionId: string,
  lookupAccount?: AccountProxyAccountLookup,
): AccountProxySessionAccount[] {
  const record = sessions.get(sessionId);
  if (!record) return [];
  return Array.from(record.accounts.entries())
    .map(([authIndex, account]) => {
      const facts = lookupAccount?.(authIndex, record.connectionId) ?? null;
      return {
        connectionId: record.connectionId,
        authIndex,
        requests: account.requests,
        current: authIndex === record.lastAuthIndex,
        label: facts?.label ?? account.label,
        provider: facts?.provider ?? account.provider,
      };
    })
    .sort((a, b) => b.requests - a.requests);
}

/** Every account that served `sessionId`, for its audit entry. */
export function getAccountProxySessionUsage(
  sessionId: string,
): AgentAuditAccountProxyUsage | null {
  const record = sessions.get(sessionId);
  if (!record || record.accounts.size === 0) return null;
  return {
    connectionId: record.connectionId,
    accounts: getAccountProxySessionAccounts(sessionId).map((account) => ({
      authIndex: account.authIndex,
      ...(account.label !== null ? { label: account.label } : {}),
      ...(account.provider !== null ? { provider: account.provider } : {}),
      requests: account.requests,
    })),
  };
}

export function forgetAccountProxySession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function resetAccountProxyAttributionForTests(): void {
  sessions.clear();
  changeListeners.clear();
  responseListeners.clear();
}
