import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function cents(value: unknown): number | undefined {
  const number = nonnegative(value);
  return number !== undefined && Number.isSafeInteger(number)
    ? number
    : undefined;
}

function epoch(value: unknown): number | undefined {
  const number =
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    number <= 8_640_000_000_000_000
    ? number
    : undefined;
}

/** Pinned DashboardService JSON: spend amounts are cents, hardLimit is dollars.
 * Optional percentages are already 0–100, not fractions. Do not infer context. */
export function cursorUsageRateLimits(
  usage: Record<string, unknown>,
  hardLimit: Record<string, unknown>,
  planInfo: Record<string, unknown> = {},
): ProviderRateLimitSnapshot[] {
  const start = epoch(usage.billingCycleStart);
  const end = epoch(usage.billingCycleEnd) ?? epoch(planInfo.billingCycleEnd);
  const window = {
    ...(end ? { resetsAt: new Date(end).toISOString() } : {}),
    ...(start && end && end > start
      ? { windowDurationMins: (end - start) / 60_000 }
      : {}),
  };
  const result: ProviderRateLimitSnapshot[] = [];
  if (isRecord(usage.planUsage)) {
    const plan = usage.planUsage;
    const limit = cents(plan.limit);
    // Proto3 non-optional scalar omissions decode as zero. Optional percentage
    // fields remain unknown when omitted, unless spend/limit supplies a ratio.
    const spent =
      plan.includedSpend === undefined ? 0 : cents(plan.includedSpend);
    const remaining =
      plan.remaining === undefined && limit !== undefined
        ? 0
        : cents(plan.remaining);
    const percent =
      nonnegative(plan.totalPercentUsed) ??
      (limit !== undefined && limit > 0 && spent !== undefined
        ? (spent / limit) * 100
        : undefined);
    if (percent !== undefined || limit !== undefined)
      result.push({
        limitId: 'cursor-plan',
        limitName: 'Included usage',
        primary: {
          ...window,
          ...(percent !== undefined ? { usedPercent: percent } : {}),
        },
        ...(limit !== undefined
          ? {
              credits: {
                totalUsd: limit / 100,
                ...(remaining !== undefined
                  ? { remainingUsd: remaining / 100 }
                  : {}),
              },
            }
          : {}),
      });
    for (const [field, id, label] of [
      ['autoPercentUsed', 'cursor-auto', 'Auto'],
      ['apiPercentUsed', 'cursor-api', 'API'],
    ] as const) {
      const usedPercent = nonnegative(plan[field]);
      if (usedPercent !== undefined)
        result.push({
          limitId: id,
          limitName: label,
          primary: { ...window, usedPercent },
        });
    }
  }
  if (isRecord(usage.spendLimitUsage)) {
    const spend = usage.spendLimitUsage;
    const used = cents(spend.individualUsed ?? 0);
    const team = spend.limitType === 'team';
    const individual = cents(spend.individualLimit);
    const hard = nonnegative(hardLimit.hardLimit);
    const disabled = team
      ? individual === 0
      : hardLimit.noUsageBasedAllowed === true || hard === 0;
    const unlimited = !team && hard !== undefined && hard >= 2147483647;
    const limitUsd = team
      ? individual === undefined
        ? undefined
        : individual / 100
      : hard;
    if (used !== undefined) {
      const finiteLimit =
        !disabled && !unlimited && limitUsd !== undefined && limitUsd > 0;
      result.push({
        limitId: 'cursor-on-demand',
        limitName: disabled
          ? 'On-demand usage (disabled)'
          : unlimited
            ? 'On-demand usage (no spending limit)'
            : 'On-demand usage',
        primary: {
          ...window,
          ...(finiteLimit
            ? { usedPercent: (used / 100 / limitUsd) * 100 }
            : {}),
        },
        credits: {
          usedUsd: used / 100,
          ...(finiteLimit
            ? {
                totalUsd: limitUsd,
                remainingUsd: Math.max(0, limitUsd - used / 100),
              }
            : {}),
        },
      });
    }
  }
  return result;
}
