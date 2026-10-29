import {
  USAGE_ALERT_CRITICAL_THRESHOLD,
  USAGE_ALERT_WARNING_THRESHOLD,
} from '@canopy/protocol/provider-usage';
import type {
  AgentUsageOverview,
  ProviderRateLimitWindow,
  ProviderUsageSummary,
} from '../types/observability';
import type { AiCreditsRoutingMode, CanopyCloudAiCreditsState } from '../types';
import type { AccountProxyStatus } from '../types/account-proxy';
import { resolveAiCreditsFundingSource } from './ai-credits-funding';
import {
  accountProxyAccountsForHarness,
  isAccountProxyAccountReady,
  resolveProviderAccountSource,
  type AccountProxyHarness,
} from './account-proxy';

export type UsageAlertLevel = 'normal' | 'warning' | 'critical';

export {
  USAGE_ALERT_CRITICAL_THRESHOLD,
  USAGE_ALERT_WARNING_THRESHOLD,
} from '@canopy/protocol/provider-usage';

const ACCOUNT_PROXY_HARNESSES: readonly AccountProxyHarness[] = [
  'claude',
  'codex',
];

/**
 * One harness's account proxy pool: critical when none of its accounts can
 * take a request, warning when every ready account is past the warning
 * threshold. One account at a limit is routine while others serve. A harness
 * with no accounts on the proxy raises nothing: routing defaults on for both
 * harnesses, and a proxy that serves only one of them is not a usage problem.
 */
function accountProxyPoolAlertLevel(
  accountProxy: AccountProxyStatus,
  harness: AccountProxyHarness,
): UsageAlertLevel {
  const accounts = accountProxyAccountsForHarness(
    accountProxy.accounts,
    harness,
  );
  if (accounts.length === 0) return 'normal';
  const ready = accounts.filter(isAccountProxyAccountReady);
  if (ready.length === 0) return 'critical';
  return ready.every((account) =>
    account.limits.some(
      (limit) => limit.usedPercent >= USAGE_ALERT_WARNING_THRESHOLD,
    ),
  )
    ? 'warning'
    : 'normal';
}

/**
 * What decides where a harness's work goes: the account proxy's state and the
 * global AI Credits mode, which main weighs before the proxy.
 */
export interface UsageAlertAccountProxyRoute {
  readonly status: AccountProxyStatus | null;
  /** The global AI Credits mode; null until it loads. */
  readonly aiCreditsRoutingMode: AiCreditsRoutingMode | null;
}

/** The pool level of each harness whose work runs through the proxy. */
function accountProxyPools(
  accountProxy: UsageAlertAccountProxyRoute | null | undefined,
): ReadonlyMap<string, UsageAlertLevel> {
  const pools = new Map<string, UsageAlertLevel>();
  const status = accountProxy?.status;
  if (!accountProxy || !status) return pools;
  for (const harness of ACCOUNT_PROXY_HARNESSES) {
    if (
      resolveProviderAccountSource({
        status,
        harness,
        aiCreditsRoutingMode: accountProxy.aiCreditsRoutingMode,
      }) === 'native'
    ) {
      continue;
    }
    pools.set(harness, accountProxyPoolAlertLevel(status, harness));
  }
  return pools;
}

/**
 * The provider usage alert. A harness whose work runs through the account
 * proxy is judged by its proxy pool, not by the user's own sign-in, whose
 * limits no longer bound that work. A harness whose work goes elsewhere, such
 * as AI Credits set to route every session, raises nothing for its pool.
 */
export function computeUsageAlertLevel(
  usage: AgentUsageOverview,
  accountProxy?: UsageAlertAccountProxyRoute | null,
): UsageAlertLevel {
  const pools = accountProxyPools(accountProxy);
  const poolLevels = Array.from(pools.values());
  if (poolLevels.includes('critical')) return 'critical';
  let hasWarning = poolLevels.includes('warning');
  for (const provider of usage.providers) {
    if (pools.has(provider.provider)) continue;
    for (const rl of provider.rateLimits ?? []) {
      const windows: Array<ProviderRateLimitWindow | undefined> = [
        rl.primary,
        rl.secondary,
      ];
      for (const w of windows) {
        if (w?.usedPercent != null) {
          if (w.usedPercent >= USAGE_ALERT_CRITICAL_THRESHOLD) {
            return 'critical';
          }
          if (w.usedPercent >= USAGE_ALERT_WARNING_THRESHOLD) {
            hasWarning = true;
          }
        }
      }
    }
  }
  return hasWarning ? 'warning' : 'normal';
}

export function usagePercentColorClass(percent: number): string {
  if (percent >= USAGE_ALERT_CRITICAL_THRESHOLD) return 'fg-destructive';
  if (percent >= USAGE_ALERT_WARNING_THRESHOLD) return 'fg-warning';
  return 'fg-secondary';
}

/**
 * Amber-warning threshold for AI-credit balance. AI credits have no quota/total,
 * so the percent-based thresholds do not apply; this is a tunable fixed floor of
 * remaining credits below which the balance is considered "low".
 */
export const AI_CREDITS_LOW_BALANCE_WARNING = 4;

/** True when a cloud provider (Claude/Codex) has an authenticated plan. */
function isAuthenticatedCloudProvider(provider: ProviderUsageSummary): boolean {
  return (
    (provider.provider === 'claude' || provider.provider === 'codex') &&
    provider.authState === 'authenticated'
  );
}

/** True when any of the provider's rate-limit windows is at critical usage. */
function isProviderOutOfQuota(provider: ProviderUsageSummary): boolean {
  for (const rl of provider.rateLimits ?? []) {
    for (const w of [rl.primary, rl.secondary]) {
      if (
        w?.usedPercent != null &&
        w.usedPercent >= USAGE_ALERT_CRITICAL_THRESHOLD
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether AI Credits are currently the active method for executing LLMs, which
 * is what gates AI-credit alert coloring:
 *
 * - `'on'` (always): active.
 * - `'off'` (never) / null: never active — coloring is never influenced.
 * - `'on-quota'` (when needed): active only when no non-credit provider can
 *   serve right now — either there is no authenticated Claude/Codex plan (AI
 *   Credits are the only option) or every authenticated Claude/Codex plan is at
 *   critical usage (out of quota). Ollama (local, no quota) is ignored.
 *
 * This follows main's routing. While a harness routes through the account
 * proxy, `on-quota` never sends its work to AI Credits, whatever its pool's
 * state: the work waits for a proxy account, or fails when the proxy has none
 * (see `aiCreditsOutrankAccountProxy`). That harness still takes work
 * without AI Credits, so they are not the active method.
 */
export function isAiCreditsActiveMethod(
  routingMode: AiCreditsRoutingMode | null,
  usage: AgentUsageOverview,
  accountProxy?: AccountProxyStatus | null,
): boolean {
  if (routingMode === 'on') return true;
  if (routingMode !== 'on-quota') return false;
  // The resolver applies main's rule that `on-quota` never outranks the proxy.
  const proxyServesAHarness = ACCOUNT_PROXY_HARNESSES.some(
    (harness) =>
      resolveProviderAccountSource({
        status: accountProxy ?? null,
        harness,
        aiCreditsRoutingMode: routingMode,
      }) === 'account-proxy',
  );
  if (proxyServesAHarness) return false;
  return usage.providers
    .filter(isAuthenticatedCloudProvider)
    .every(isProviderOutOfQuota);
}

/**
 * Compute the sidebar/usage alert level for AI-credit balance.
 *
 * Coloring only applies when AI Credits are the active execution method (see
 * {@link isAiCreditsActiveMethod}), so users who are not currently relying on
 * credits are not nagged. Returns 'normal' when disconnected, when the account
 * has no matching UD account, or on transient error.
 */
export function computeAiCreditsAlertLevel(
  state: CanopyCloudAiCreditsState | null,
  routingMode: AiCreditsRoutingMode | null,
  usage: AgentUsageOverview,
  accountProxy?: AccountProxyStatus | null,
): UsageAlertLevel {
  if (!state || !state.connected || state.noUdAccount || state.error) {
    return 'normal';
  }
  if (!isAiCreditsActiveMethod(routingMode, usage, accountProxy)) {
    return 'normal';
  }
  // An org pool covering an empty personal wallet is a healthy state, not an
  // "you're out of credits" one. Deliberately no low-pool warning tier: the pool
  // is not the user's to refill, so warning about it is noise they cannot act on.
  if (resolveAiCreditsFundingSource(state).kind === 'org-pool') return 'normal';
  const credits = state.balance?.credits ?? 0;
  if (state.balance?.eligible !== true || credits <= 0) return 'critical';
  if (credits < AI_CREDITS_LOW_BALANCE_WARNING) return 'warning';
  return 'normal';
}

/** Combine several alert levels, taking the most severe. */
export function maxUsageAlertLevel(
  ...levels: UsageAlertLevel[]
): UsageAlertLevel {
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warning')) return 'warning';
  return 'normal';
}

/** Map an alert level to the same color class semantics as the sidebar. */
export function usageAlertColorClass(level: UsageAlertLevel): string {
  // Semantic fg roles keep the alert colors readable in both color modes;
  // raw hue utilities like text-amber-400 wash out on light backgrounds.
  if (level === 'critical') return 'fg-destructive';
  if (level === 'warning') return 'fg-warning';
  return 'fg-secondary';
}

/** Map an alert level to the matching usage-meter/indicator background. */
export function usageAlertBackgroundClass(level: UsageAlertLevel): string {
  // Semantic bg roles match usageAlertColorClass and stay visible in both
  // color modes.
  if (level === 'critical') return 'bg-destructive';
  if (level === 'warning') return 'bg-warning';
  return 'bg-accent';
}
