import type { AgentProviderType } from '../types';
import type {
  ProviderCreditsSnapshot,
  ProviderRateLimitSnapshot,
  ProviderRateLimitWindow,
  ProviderSpendSnapshot,
  RetainedAccountUsageSnapshot,
} from '@canopy/execution-engine/types/observability';

export const MAX_RETAINED_ACCOUNTS_PER_PROVIDER = 10;

// Typed as readonly string[] so `.includes(value)` type-checks without
// a cast; the `value is AgentProviderType` predicate is the declared narrowing.
const KNOWN_PROVIDERS: readonly string[] = [
  'claude',
  'codex',
  'ollama',
  'cursor',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAgentProviderType(value: unknown): value is AgentProviderType {
  return typeof value === 'string' && KNOWN_PROVIDERS.includes(value);
}

export function computeAccountKey(
  provider: AgentProviderType,
  email: string | undefined,
  subscription: string | undefined,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }
  const normalizedSubscription = subscription?.trim().toLowerCase() ?? '';
  return `${provider}:${normalizedEmail}:${normalizedSubscription}`;
}

function windowHasFutureReset(
  window: ProviderRateLimitWindow | undefined,
  nowMs: number,
): boolean {
  if (!window?.resetsAt) {
    return false;
  }
  const resetMs = new Date(window.resetsAt).getTime();
  return Number.isFinite(resetMs) && resetMs > nowMs;
}

export function snapshotHasFutureReset(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  nowMs: number,
): boolean {
  if (!rateLimits) {
    return false;
  }
  return rateLimits.some(
    (limit) =>
      windowHasFutureReset(limit.primary, nowMs) ||
      windowHasFutureReset(limit.secondary, nowMs),
  );
}

function capturedAtSortMs(
  snapshot: RetainedAccountUsageSnapshot,
): number | null {
  const parsed = Date.parse(snapshot.capturedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareSnapshotsByCapturedAtDesc(
  a: RetainedAccountUsageSnapshot,
  b: RetainedAccountUsageSnapshot,
): number {
  const aMs = capturedAtSortMs(a);
  const bMs = capturedAtSortMs(b);
  if (aMs === null && bMs === null) {
    return a.accountKey.localeCompare(b.accountKey);
  }
  if (aMs === null) {
    return 1;
  }
  if (bMs === null) {
    return -1;
  }
  return bMs - aMs || a.accountKey.localeCompare(b.accountKey);
}

export function pruneRetainedAccountSnapshots(
  snapshots: RetainedAccountUsageSnapshot[],
  nowMs: number,
): RetainedAccountUsageSnapshot[] {
  const relevant = snapshots.filter((snapshot) =>
    snapshotHasFutureReset(snapshot.rateLimits, nowMs),
  );

  const byProvider = new Map<
    AgentProviderType,
    RetainedAccountUsageSnapshot[]
  >();
  for (const snapshot of relevant) {
    const list = byProvider.get(snapshot.provider) ?? [];
    list.push(snapshot);
    byProvider.set(snapshot.provider, list);
  }

  const result: RetainedAccountUsageSnapshot[] = [];
  for (const list of Array.from(byProvider.values())) {
    list.sort(compareSnapshotsByCapturedAtDesc);
    result.push(...list.slice(0, MAX_RETAINED_ACCOUNTS_PER_PROVIDER));
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeWindow(
  value: Record<string, unknown>,
): ProviderRateLimitWindow {
  const resetsAt =
    typeof value.resetsAt === 'string' || typeof value.resetsAt === 'number'
      ? value.resetsAt
      : undefined;
  return {
    limit: optionalNumber(value.limit),
    remaining: optionalNumber(value.remaining),
    usedPercent: optionalNumber(value.usedPercent),
    resetsAt,
    windowDurationMins: optionalNumber(value.windowDurationMins),
  };
}

function normalizeCredits(
  value: Record<string, unknown>,
): ProviderCreditsSnapshot {
  return {
    totalUsd: optionalNumber(value.totalUsd),
    usedUsd: optionalNumber(value.usedUsd),
    remainingUsd: optionalNumber(value.remainingUsd),
    expiresAt: optionalString(value.expiresAt),
  };
}

function normalizeSpend(value: Record<string, unknown>): ProviderSpendSnapshot {
  const currency = optionalString(value.currency);
  const used = optionalNumber(value.used);
  const limit = optionalNumber(value.limit);
  return {
    ...(currency !== undefined &&
    /^[A-Z]{3}$/.test(currency) &&
    new Intl.DisplayNames('en', { type: 'currency', fallback: 'none' }).of(
      currency,
    ) !== undefined
      ? { currency }
      : {}),
    ...(used !== undefined && used >= 0 ? { used } : {}),
    ...(value.limit === null
      ? { limit: null }
      : limit !== undefined && limit >= 0
        ? { limit }
        : {}),
    ...(typeof value.isEnabled === 'boolean'
      ? { isEnabled: value.isEnabled }
      : {}),
  };
}

function normalizeScope(
  value: Record<string, unknown>,
): ProviderRateLimitSnapshot['scope'] {
  const model = isRecord(value.model) ? value.model : undefined;
  return {
    ...(model
      ? {
          model: {
            id: optionalString(model.id) ?? null,
            displayName: optionalString(model.displayName) ?? null,
          },
        }
      : {}),
    ...(value.surface === null || typeof value.surface === 'string'
      ? { surface: value.surface }
      : {}),
  };
}

function normalizeRateLimit(
  entry: Record<string, unknown>,
  provider: AgentProviderType,
): ProviderRateLimitSnapshot {
  return {
    limitId: optionalString(entry.limitId),
    limitName: optionalString(entry.limitName),
    planType: optionalString(entry.planType),
    primary: isRecord(entry.primary)
      ? normalizeWindow(entry.primary)
      : undefined,
    secondary: isRecord(entry.secondary)
      ? normalizeWindow(entry.secondary)
      : undefined,
    // Old Claude overage credits had ambiguous units and no currency metadata.
    credits:
      !(provider === 'claude' && entry.limitId === 'extra_usage') &&
      isRecord(entry.credits)
        ? normalizeCredits(entry.credits)
        : undefined,
    spend: isRecord(entry.spend) ? normalizeSpend(entry.spend) : undefined,
    scope: isRecord(entry.scope) ? normalizeScope(entry.scope) : undefined,
  };
}

export function normalizeRetainedAccountSnapshot(
  value: unknown,
): RetainedAccountUsageSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isAgentProviderType(value.provider)) {
    return null;
  }
  const provider = value.provider;
  if (typeof value.accountKey !== 'string' || value.accountKey.length === 0) {
    return null;
  }
  if (typeof value.capturedAt !== 'string' || value.capturedAt.length === 0) {
    return null;
  }
  const rateLimits: ProviderRateLimitSnapshot[] | undefined = Array.isArray(
    value.rateLimits,
  )
    ? value.rateLimits
        .filter(isRecord)
        .map((entry) => normalizeRateLimit(entry, provider))
    : undefined;
  return {
    provider: value.provider,
    accountKey: value.accountKey,
    accountEmail: optionalString(value.accountEmail),
    accountLabel: optionalString(value.accountLabel),
    subscriptionLabel: optionalString(value.subscriptionLabel),
    rateLimits,
    capturedAt: value.capturedAt,
  };
}
