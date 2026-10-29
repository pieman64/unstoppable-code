import type {
  AgentProviderType,
  AgentUsageOverview,
  ProviderRateLimitWindow,
} from '@canopy/desktop-shared/types';
import type { PipelineStatusReason } from '@canopy/desktop-shared/types/pipeline';

function parseFutureResetMs(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const resetMs = new Date(value).getTime();
  return Number.isFinite(resetMs) && resetMs > nowMs ? resetMs : null;
}

/**
 * Choose the ISO timestamp at which a provider usage-limited session can resume.
 *
 * The "Schedule Resume" banner action uses this, driven entirely by the
 * structured observability usage snapshot and never by parsing visible provider
 * error text. We look at the provider's rate-limit snapshots, inspect each
 * snapshot's `primary` and `secondary` windows, and keep only
 * windows that are genuinely exhausted (`usedPercent >= 100`) with a valid
 * future `resetsAt`. `resetsAt` is normally normalized to ISO before it reaches
 * the renderer, but Codex snapshots are accepted defensively as epoch seconds or
 * milliseconds too. Among those candidates we pick the *most distant* reset so
 * the session resumes only once every saturated window has refilled.
 *
 * @returns the farthest candidate reset time as an ISO 8601 string, or `null`
 *   when no exhausted provider window has a valid future reset.
 */
export function selectProviderUsageLimitResumeAt(
  usage: AgentUsageOverview,
  providerType: AgentProviderType,
  now: Date = new Date(),
): string | null {
  const provider = usage.providers.find(
    (candidate) => candidate.provider === providerType,
  );
  if (!provider?.rateLimits) {
    return null;
  }

  const nowMs = now.getTime();
  let farthestMs = -Infinity;

  const parseResetMs = (value: unknown): number | null => {
    if (typeof value === 'string' && value.length > 0) {
      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const epochMs = value < 1_000_000_000_000 ? value * 1000 : value;
      return Number.isFinite(epochMs) ? epochMs : null;
    }
    return null;
  };

  const considerWindow = (
    window: ProviderRateLimitWindow | undefined,
  ): void => {
    if (!window) {
      return;
    }
    if (typeof window.usedPercent !== 'number' || window.usedPercent < 100) {
      return;
    }
    const resetMs = parseResetMs(window.resetsAt);
    if (resetMs === null) {
      return;
    }
    if (resetMs <= nowMs) {
      return;
    }
    if (resetMs > farthestMs) {
      farthestMs = resetMs;
    }
  };

  for (const snapshot of provider.rateLimits) {
    considerWindow(snapshot.primary);
    considerWindow(snapshot.secondary);
  }

  if (farthestMs === -Infinity) {
    return null;
  }
  return new Date(farthestMs).toISOString();
}

export function selectClaudeUsageLimitResumeAt(
  usage: AgentUsageOverview,
  now: Date = new Date(),
): string | null {
  return selectProviderUsageLimitResumeAt(usage, 'claude', now);
}

/**
 * Select a safe one-time resume timestamp for a group of pipeline usage-limit
 * reasons. Every reason must have a future reset. Native-provider reasons may
 * use the provider usage snapshot as a fallback; AI Credits and local-account
 * reasons must carry their own reset so they are never scheduled against an
 * unrelated native account window.
 */
export function selectPipelineUsageLimitResumeAt(
  reasons: readonly PipelineStatusReason[],
  nativeProviderFallback: string | null,
  now: Date = new Date(),
): string | null {
  if (reasons.length === 0) {
    return null;
  }

  const nowMs = now.getTime();
  const fallbackMs = parseFutureResetMs(nativeProviderFallback, nowMs);
  let latestResetMs = -Infinity;

  for (const reason of reasons) {
    if (reason.kind !== 'provider_usage_limit') {
      return null;
    }
    const explicitResetMs = parseFutureResetMs(reason.resets_at, nowMs);
    const resetMs =
      explicitResetMs ??
      (reason.account_scope === 'native' ? fallbackMs : null);
    if (resetMs === null) {
      return null;
    }
    latestResetMs = Math.max(latestResetMs, resetMs);
  }

  return new Date(latestResetMs).toISOString();
}
