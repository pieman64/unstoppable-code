import type { AgentProviderType } from '../types';
import type {
  ProviderCreditsSnapshot,
  ProviderRateLimitSnapshot,
} from '../types/observability';

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One displayable plan limit window, normalized from a provider's rate-limit
 * snapshots. Shared by the desktop Usage page and the Remote Control
 * `provider_usage` projection so both show the same titles and durations.
 */
export interface ProviderUsageWindow {
  /** Explicit provider quota semantics, independent of missing usage. */
  unlimited?: boolean;
  /** Stable across refreshes and reordering: `<limit id>-<primary|secondary>`. */
  key: string;
  title: string;
  usedPercent?: number;
  resetsAt?: string | number;
  windowDurationMs?: number;
  credits?: ProviderCreditsSnapshot;
  /**
   * Codex reports its balance as a count of credits (carried in
   * `credits.remainingUsd`); every other provider's credits are dollars.
   */
  creditsAreCount?: boolean;
}

function rateLimitSortKey(limit: ProviderRateLimitSnapshot): number {
  const name = (limit.limitName ?? limit.limitId ?? '').toLowerCase();
  if (name === 'codex') {
    return 0;
  }
  return 1;
}

function claudeWindowDurationMs(limitId?: string): number | undefined {
  if (!limitId) {
    return undefined;
  }
  if (limitId === 'five_hour' || limitId === 'session') {
    return FIVE_HOUR_MS;
  }
  if (limitId.startsWith('seven_day') || limitId.startsWith('weekly')) {
    return SEVEN_DAY_MS;
  }
  return undefined;
}

function codexSuffix(limit: ProviderRateLimitSnapshot): string {
  const base = limit.limitName ?? limit.limitId ?? '';
  if (base.toLowerCase() === 'codex' || base.length === 0) {
    return 'window';
  }
  return base;
}

function toWindowDurationMs(windowDurationMins?: number): number | undefined {
  if (windowDurationMins === undefined || windowDurationMins <= 0) {
    return undefined;
  }
  return windowDurationMins * 60 * 1000;
}

function formatWindowDuration(windowDurationMins?: number): string | null {
  if (windowDurationMins === undefined || windowDurationMins <= 0) {
    return null;
  }
  if (windowDurationMins % (24 * 60) === 0) {
    const days = windowDurationMins / (24 * 60);
    return `${days}-day`;
  }
  if (windowDurationMins % 60 === 0) {
    const hours = windowDurationMins / 60;
    return `${hours}-hour`;
  }
  return `${windowDurationMins}-minute`;
}

function codexWindowTitle(
  fallbackPrefix: string,
  suffix: string,
  windowDurationMins?: number,
): string {
  const durationLabel = formatWindowDuration(windowDurationMins);
  return `${durationLabel ?? fallbackPrefix} ${suffix}`;
}

function toWindows(
  provider: AgentProviderType,
  limit: ProviderRateLimitSnapshot,
): ProviderUsageWindow[] {
  const limitKey = limit.limitId ?? limit.limitName ?? 'default';

  if (provider === 'codex') {
    const suffix = codexSuffix(limit);
    const windows: ProviderUsageWindow[] = [];
    if (limit.primary) {
      windows.push({
        key: `${limitKey}-primary`,
        title: codexWindowTitle(
          'Primary',
          suffix,
          limit.primary.windowDurationMins,
        ),
        usedPercent: limit.primary.usedPercent,
        resetsAt: limit.primary.resetsAt,
        windowDurationMs: toWindowDurationMs(limit.primary.windowDurationMins),
        credits: limit.credits,
        creditsAreCount: true,
      });
    }
    if (limit.secondary) {
      windows.push({
        key: `${limitKey}-secondary`,
        title: codexWindowTitle(
          'Secondary',
          suffix,
          limit.secondary.windowDurationMins,
        ),
        usedPercent: limit.secondary.usedPercent,
        resetsAt: limit.secondary.resetsAt,
        windowDurationMs: toWindowDurationMs(
          limit.secondary.windowDurationMins,
        ),
        credits: limit.credits,
        creditsAreCount: true,
      });
    }
    if (
      windows.length === 0 &&
      limit.credits &&
      (limit.credits.usedUsd !== undefined ||
        limit.credits.remainingUsd !== undefined)
    ) {
      windows.push({
        key: `${limitKey}-balance`,
        title: limit.limitName || 'Credits',
        credits: limit.credits,
        creditsAreCount: true,
      });
    }
    return windows;
  }

  return [
    {
      key: `${limitKey}-primary`,
      title: limit.limitName ?? limit.limitId ?? 'Current window',
      ...(limit.primary?.unlimited === true ? { unlimited: true } : {}),
      usedPercent: limit.primary?.usedPercent,
      resetsAt: limit.primary?.resetsAt,
      windowDurationMs:
        toWindowDurationMs(limit.primary?.windowDurationMins) ??
        claudeWindowDurationMs(limit.limitId),
      credits: limit.credits,
    },
  ];
}

/**
 * Flatten a provider's rate-limit snapshots into display windows: the main
 * Codex bucket first, Codex primary/secondary buckets expanded and titled by
 * duration, and legacy Claude keys given their implied durations.
 */
export function buildProviderUsageWindows(
  provider: AgentProviderType,
  rateLimits: readonly ProviderRateLimitSnapshot[] | undefined,
): ProviderUsageWindow[] {
  return [...(rateLimits ?? [])]
    .sort((a, b) => rateLimitSortKey(a) - rateLimitSortKey(b))
    .flatMap((limit) => toWindows(provider, limit));
}
