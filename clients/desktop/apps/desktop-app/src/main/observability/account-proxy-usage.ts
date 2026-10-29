// The account-proxy accounts that served one audit entry (CAN-4021). A chat
// turn adds each proxied response as it arrives; a pipeline step copies its
// route's whole count when it ends, because each step attempt has a route of
// its own.

import type { AccountProxyResponse } from '../account-proxy/attribution';
import type {
  AgentAuditAccountProxyAccount,
  AgentAuditAccountProxyUsage,
} from '@canopy/desktop-shared/types/observability';

/** Bounds an entry; a turn that moved this often keeps its busiest accounts. */
export const MAX_AUDIT_ACCOUNT_PROXY_ACCOUNTS = 16;

function byRequests(
  left: AgentAuditAccountProxyAccount,
  right: AgentAuditAccountProxyAccount,
): number {
  return right.requests - left.requests;
}

/** `usage` with one more response from `response`'s account. */
export function addAccountProxyResponse(
  usage: AgentAuditAccountProxyUsage | undefined,
  response: AccountProxyResponse,
): AgentAuditAccountProxyUsage {
  // The same `auth_index` names another credential on another connection.
  const accounts =
    usage && usage.connectionId === response.connectionId ? usage.accounts : [];
  const existing = accounts.find(
    (account) => account.authIndex === response.authIndex,
  );
  const label = response.label ?? existing?.label;
  const provider = response.provider ?? existing?.provider;
  const next: AgentAuditAccountProxyAccount = {
    authIndex: response.authIndex,
    ...(label !== undefined ? { label } : {}),
    ...(provider !== undefined ? { provider } : {}),
    requests: (existing?.requests ?? 0) + 1,
  };
  return {
    connectionId: response.connectionId,
    accounts: [...accounts.filter((account) => account !== existing), next]
      .sort(byRequests)
      .slice(0, MAX_AUDIT_ACCOUNT_PROXY_ACCOUNTS),
  };
}

/** A route's count, bounded like a turn's. */
export function boundAccountProxyUsage(
  usage: AgentAuditAccountProxyUsage,
): AgentAuditAccountProxyUsage {
  return {
    connectionId: usage.connectionId,
    accounts: [...usage.accounts]
      .sort(byRequests)
      .slice(0, MAX_AUDIT_ACCOUNT_PROXY_ACCOUNTS),
  };
}

/**
 * Several routes' counts for one entry, such as a pipeline step that paused
 * and resumed on a new route. Routes of the latest connection add up; an
 * `auth_index` of another connection names another credential, so those
 * routes are left out.
 */
export function mergeAccountProxyUsages(
  usages: readonly AgentAuditAccountProxyUsage[],
): AgentAuditAccountProxyUsage | undefined {
  const latest = usages[usages.length - 1];
  if (!latest) return undefined;
  const accounts = new Map<string, AgentAuditAccountProxyAccount>();
  for (const usage of usages) {
    if (usage.connectionId !== latest.connectionId) continue;
    for (const account of usage.accounts) {
      const existing = accounts.get(account.authIndex);
      const label = account.label ?? existing?.label;
      const provider = account.provider ?? existing?.provider;
      accounts.set(account.authIndex, {
        authIndex: account.authIndex,
        ...(label !== undefined ? { label } : {}),
        ...(provider !== undefined ? { provider } : {}),
        requests: (existing?.requests ?? 0) + account.requests,
      });
    }
  }
  return boundAccountProxyUsage({
    connectionId: latest.connectionId,
    accounts: Array.from(accounts.values()),
  });
}
