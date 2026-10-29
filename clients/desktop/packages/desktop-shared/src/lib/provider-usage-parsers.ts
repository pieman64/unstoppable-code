import type {
  ProviderRateLimitSnapshot,
  ProviderRateLimitWindow,
} from '../types/observability';

export interface ClaudeUsageDetails {
  rateLimits: ProviderRateLimitSnapshot[];
  rateLimitTier?: string;
}

type ClaudeUsageLimit = {
  kind: string;
  group: string;
  percent: number;
  resetsAt?: string;
  scope?: {
    model?: { id: string | null; displayName: string | null };
    surface?: string | null;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function toIsoString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function formatClaudeUsageLimitName(key: string): string {
  switch (key) {
    case 'five_hour':
      return '5-hour window';
    case 'session':
      return 'Session';
    case 'seven_day':
    case 'weekly_all':
      return '7-day window';
    case 'seven_day_sonnet':
      return '7-day Sonnet';
    case 'seven_day_opus':
      return '7-day Opus';
    case 'seven_day_cowork':
      return '7-day Cowork';
    case 'seven_day_oauth_apps':
      return '7-day OAuth Apps';
    default:
      return key
        .split('_')
        .filter((part) => part.length > 0)
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(' ');
  }
}

function parseClaudeUsageLimitScope(
  value: Record<string, unknown>,
): ClaudeUsageLimit['scope'] {
  const model = readRecord(value, 'model');
  const surface = value.surface === null ? null : readString(value, 'surface');
  if (!model && surface === undefined) return null;
  return {
    ...(model
      ? {
          model: {
            id: model.id === null ? null : (readString(model, 'id') ?? null),
            displayName:
              model.display_name === null
                ? null
                : (readString(model, 'display_name') ?? null),
          },
        }
      : {}),
    ...(surface !== undefined ? { surface } : {}),
  };
}

function parseClaudeUsageLimit(value: unknown): ClaudeUsageLimit | null {
  if (!isRecord(value)) return null;
  const kind = readString(value, 'kind');
  const percent = readNumber(value, 'percent');
  if (!kind || percent === undefined) return null;

  const group = readString(value, 'group');
  const base = {
    kind,
    group: group ?? 'unknown',
    percent,
    resetsAt: toIsoString(readString(value, 'resets_at')),
  };
  if (kind === 'session') return { ...base, group: 'session', scope: null };
  if (kind === 'weekly_all') return { ...base, group: 'weekly', scope: null };

  const scopeRecord = readRecord(value, 'scope');
  const scope = scopeRecord ? parseClaudeUsageLimitScope(scopeRecord) : null;
  if (kind === 'weekly_scoped') {
    return scope ? { ...base, group: 'weekly', scope } : null;
  }
  return { ...base, scope };
}

function claudeUsageLimitWindowDurationMins(
  limit: ClaudeUsageLimit,
): number | undefined {
  if (limit.kind === 'session' || limit.group === 'session') return 5 * 60;
  if (limit.kind.startsWith('weekly') || limit.group === 'weekly') {
    return 7 * 24 * 60;
  }
  return undefined;
}

function claudeUsageLimitScopeLabel(
  scope: ClaudeUsageLimit['scope'],
): string | null {
  return (
    scope?.model?.displayName ?? scope?.model?.id ?? scope?.surface ?? null
  );
}

function claudeUsageLimitName(limit: ClaudeUsageLimit): string {
  if (limit.kind === 'session') {
    return claudeUsageLimitWindowDurationMins(limit) === 5 * 60
      ? '5-hour window'
      : 'Session';
  }
  const scopeLabel = claudeUsageLimitScopeLabel(limit.scope);
  if (limit.kind === 'weekly_scoped' && scopeLabel) {
    return `7-day ${scopeLabel}`;
  }
  if (limit.kind === 'weekly_all') return '7-day window';
  if (scopeLabel)
    return `${formatClaudeUsageLimitName(limit.kind)} ${scopeLabel}`;
  return formatClaudeUsageLimitName(limit.kind);
}

function claudeUsageLimitId(limit: ClaudeUsageLimit): string {
  const scopeLabel = claudeUsageLimitScopeLabel(limit.scope);
  return scopeLabel ? `${limit.kind}:${scopeLabel}` : limit.kind;
}

function parseClaudeUsageLimits(
  payload: Record<string, unknown>,
  rateLimitTier?: string,
): ProviderRateLimitSnapshot[] {
  return readArray(payload, 'limits')
    .map(parseClaudeUsageLimit)
    .filter((limit): limit is ClaudeUsageLimit => limit !== null)
    .map((limit) => ({
      limitId: claudeUsageLimitId(limit),
      limitName: claudeUsageLimitName(limit),
      planType: rateLimitTier,
      primary: {
        usedPercent: limit.percent,
        resetsAt: limit.resetsAt,
        windowDurationMins: claudeUsageLimitWindowDurationMins(limit),
      },
    }));
}

/** Pure normalization of Claude's modern and legacy OAuth usage responses. */
export function parseClaudeUsageDetails(
  body: unknown,
  rateLimitTier?: string,
): ClaudeUsageDetails {
  const payload = isRecord(body) ? body : {};
  const rateLimits: ProviderRateLimitSnapshot[] = [];
  const modernLimits = parseClaudeUsageLimits(payload, rateLimitTier);

  if (modernLimits.length > 0) {
    rateLimits.push(...modernLimits);
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (key === 'extra_usage' || !isRecord(value)) continue;
      const usedPercent = readNumber(value, 'utilization');
      const resetsAt = toIsoString(readString(value, 'resets_at'));
      if (usedPercent === undefined && resetsAt === undefined) continue;
      rateLimits.push({
        limitId: key,
        limitName: formatClaudeUsageLimitName(key),
        planType: rateLimitTier,
        primary: { usedPercent, resetsAt },
      });
    }
  }

  const extraUsage = readRecord(payload, 'extra_usage');
  if (extraUsage) {
    const totalUsd = readNumber(extraUsage, 'monthly_limit');
    const usedUsd = readNumber(extraUsage, 'used_credits');
    const isEnabled = readBoolean(extraUsage, 'is_enabled');
    const usedPercent = readNumber(extraUsage, 'utilization');
    const remainingUsd =
      totalUsd !== undefined && usedUsd !== undefined
        ? totalUsd - usedUsd
        : undefined;
    if (
      isEnabled === true ||
      totalUsd !== undefined ||
      usedUsd !== undefined ||
      usedPercent !== undefined
    ) {
      rateLimits.push({
        limitId: 'extra_usage',
        limitName: 'Extra usage',
        planType: rateLimitTier,
        primary: usedPercent !== undefined ? { usedPercent } : undefined,
        credits: { usedUsd, totalUsd, remainingUsd },
      });
    }
  }

  return { rateLimits, rateLimitTier };
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCodexResetAt(value: unknown): string | undefined {
  const epoch = readFiniteNumber(value);
  if (epoch === undefined && typeof value === 'string') {
    return toIsoString(value);
  }
  if (epoch === undefined) return undefined;
  const milliseconds = epoch < 1_000_000_000_000 ? epoch * 1000 : epoch;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function parseCodexWhamWindow(
  value: unknown,
): ProviderRateLimitWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = readFiniteNumber(value.used_percent);
  const windowSeconds = readFiniteNumber(value.limit_window_seconds);
  const resetsAt = readCodexResetAt(value.reset_at);
  if (
    usedPercent === undefined &&
    windowSeconds === undefined &&
    resetsAt === undefined
  ) {
    return undefined;
  }
  return {
    usedPercent,
    resetsAt,
    windowDurationMins:
      windowSeconds !== undefined && windowSeconds > 0
        ? windowSeconds / 60
        : undefined,
  };
}

function parseCodexWhamRateLimit(
  rateLimit: unknown,
  defaults: { readonly limitId?: string; readonly limitName?: string },
  planType?: string,
): ProviderRateLimitSnapshot | undefined {
  if (!isRecord(rateLimit)) return undefined;
  const primary = parseCodexWhamWindow(rateLimit.primary_window);
  const secondary = parseCodexWhamWindow(rateLimit.secondary_window);
  if (!primary && !secondary) return undefined;
  return {
    limitId: readString(rateLimit, 'limit_id') ?? defaults.limitId,
    limitName: readString(rateLimit, 'limit_name') ?? defaults.limitName,
    planType: readString(rateLimit, 'plan_type') ?? planType,
    primary,
    secondary,
  };
}

function parseCodexWhamCredits(
  value: unknown,
): ProviderRateLimitSnapshot['credits'] {
  if (!isRecord(value)) return undefined;
  const remainingUsd = readFiniteNumber(value.balance);
  return remainingUsd === undefined ? undefined : { remainingUsd };
}

/** Pure normalization of the raw ChatGPT Codex `wham/usage` response. */
export function parseCodexWhamUsage(
  body: unknown,
): ProviderRateLimitSnapshot[] {
  if (!isRecord(body)) return [];
  const planType = readString(body, 'plan_type');
  const snapshots: ProviderRateLimitSnapshot[] = [];
  const base = parseCodexWhamRateLimit(
    body.rate_limit,
    { limitId: 'codex', limitName: 'Codex' },
    planType,
  );
  const credits = parseCodexWhamCredits(body.credits);
  if (base) {
    snapshots.push({ ...base, ...(credits ? { credits } : {}) });
  } else if (credits) {
    snapshots.push({ limitId: 'credits', limitName: 'Credits', credits });
  }

  const review = parseCodexWhamRateLimit(
    body.code_review_rate_limit,
    { limitId: 'code_review', limitName: 'Code review' },
    planType,
  );
  if (review) snapshots.push(review);

  const additional = body.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (!isRecord(entry)) continue;
      const limitName = readString(entry, 'limit_name');
      const limitId = readString(entry, 'limit_id') ?? limitName;
      const snapshot = parseCodexWhamRateLimit(
        entry.rate_limit,
        {
          ...(limitId ? { limitId } : {}),
          ...(limitName ? { limitName } : {}),
        },
        planType,
      );
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return snapshots;
}
