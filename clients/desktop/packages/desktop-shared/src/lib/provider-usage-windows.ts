import type { AgentProviderType } from '../types';
import type {
  ProviderCreditsSnapshot,
  ProviderRateLimitSnapshot,
  ProviderRateLimitWindow,
  ProviderSpendSnapshot,
} from '../types/observability';
import { isClaudeCodeSurface } from './subscription-usage';

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
  spend?: ProviderSpendSnapshot;
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
      ...(limit.spend ? { spend: limit.spend } : {}),
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

const SEVEN_DAY_MINS = 7 * 24 * 60;
const CLAUDE_ALL_MODELS_WEEKLY = new Set(['seven_day', 'weekly_all']);
const CLAUDE_SCOPED_WEEKLY_PREFIX = 'weekly_scoped:';
/** Model families a Claude weekly limit can be scoped to. */
const CLAUDE_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

function sharesClaudeFamily(scopeText: string, model: string): boolean {
  const scope = scopeText.toLowerCase();
  const id = model.toLowerCase();
  return CLAUDE_MODEL_FAMILIES.some(
    (family) => scope.includes(family) && id.includes(family),
  );
}

/** A provider-reported model scope, when the limit carries one. */
function scopedModelMatches(
  limit: ProviderRateLimitSnapshot,
  model: string,
): boolean | undefined {
  const scope = limit.scope?.model;
  if (!scope || (scope.id === null && scope.displayName === null)) {
    return undefined;
  }
  const id = model.toLowerCase();
  const scopeId = scope.id?.toLowerCase();
  if (scopeId && (id === scopeId || id.includes(scopeId))) return true;
  return sharesClaudeFamily(
    `${scope.id ?? ''} ${scope.displayName ?? ''}`,
    model,
  );
}

/**
 * A limit the provider scoped to another surface (Cowork, OAuth apps) bounds
 * that surface, not a Claude Code chat, whatever model it names.
 */
function scopedToOtherSurface(limit: ProviderRateLimitSnapshot): boolean {
  const surface = limit.scope?.surface;
  if (surface === undefined || surface === null) return false;
  return !isClaudeCodeSurface(surface);
}

/** Whether a Claude limit is a 7-day limit that bounds this model. */
function claudeWeeklyApplies(
  limit: ProviderRateLimitSnapshot,
  model: string,
): boolean {
  if (scopedToOtherSurface(limit)) return false;
  const limitId = limit.limitId ?? '';
  const scoped = scopedModelMatches(limit, model);
  if (CLAUDE_ALL_MODELS_WEEKLY.has(limitId)) return scoped ?? true;
  if (limitId === 'seven_day_opus' || limitId === 'seven_day_sonnet') {
    return scoped ?? sharesClaudeFamily(limitId, model);
  }
  if (limitId.startsWith(CLAUDE_SCOPED_WEEKLY_PREFIX)) {
    // Scoped only to the Claude Code surface, with no model: it bounds every
    // model of a Claude Code chat.
    if (scoped === undefined && limit.scope?.surface) return true;
    return (
      scoped ??
      sharesClaudeFamily(
        limitId.slice(CLAUDE_SCOPED_WEEKLY_PREFIX.length),
        model,
      )
    );
  }
  // Cowork, OAuth-app and overage buckets bound other products, not a chat.
  return false;
}

/** Whether a Codex limit bucket bounds this model. */
function codexBucketApplies(
  limit: ProviderRateLimitSnapshot,
  model: string,
): boolean {
  const scoped = scopedModelMatches(limit, model);
  if (scoped !== undefined) return scoped;
  const name = (limit.limitName ?? limit.limitId ?? '').toLowerCase();
  // The main bucket bounds every Codex model; a named one, its own model.
  return (
    name === '' ||
    name === 'codex' ||
    model.toLowerCase().includes(name.replace(/ /g, '-'))
  );
}

function usedShare(
  window: ProviderRateLimitWindow | undefined,
): number | undefined {
  if (!window || window.unlimited === true) return undefined;
  const used = window.usedPercent;
  return used !== undefined && Number.isFinite(used) ? used : undefined;
}

/**
 * The share of the 7-day plan limit that binds a chat's model: of the weekly
 * limits that apply to it (all models, and the model's own), the one closest
 * to its cap. `undefined` when the provider reports no applicable weekly
 * limit with a known share.
 */
export function selectWeeklyLimitUsedPercent(
  provider: AgentProviderType,
  rateLimits: readonly ProviderRateLimitSnapshot[] | undefined,
  model: string,
): number | undefined {
  const shares: number[] = [];
  for (const limit of rateLimits ?? []) {
    if (provider === 'claude') {
      if (!claudeWeeklyApplies(limit, model)) continue;
      const share = usedShare(limit.primary);
      if (share !== undefined) shares.push(share);
    } else if (provider === 'codex') {
      if (!codexBucketApplies(limit, model)) continue;
      for (const window of [limit.primary, limit.secondary]) {
        if (window?.windowDurationMins !== SEVEN_DAY_MINS) continue;
        const share = usedShare(window);
        if (share !== undefined) shares.push(share);
      }
    }
  }
  return shares.length > 0 ? Math.max(...shares) : undefined;
}
