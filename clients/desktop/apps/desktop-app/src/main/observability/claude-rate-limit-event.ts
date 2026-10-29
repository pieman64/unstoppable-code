import type { ProviderRateLimitSnapshot } from '@canopy/desktop-shared/types';

type ClaudeRateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

type ClaudeRateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage';

interface ParsedClaudeRateLimitEvent {
  rateLimitType: ClaudeRateLimitType;
  usedPercent?: number;
  resetsAt?: string;
}

const WEEKLY_SCOPED_PREFIX = 'weekly_scoped:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaudeRateLimitStatus(
  value: unknown,
): value is ClaudeRateLimitStatus {
  return (
    value === 'allowed' || value === 'allowed_warning' || value === 'rejected'
  );
}

function isClaudeRateLimitType(value: unknown): value is ClaudeRateLimitType {
  return (
    value === 'five_hour' ||
    value === 'seven_day' ||
    value === 'seven_day_opus' ||
    value === 'seven_day_sonnet' ||
    value === 'seven_day_overage_included' ||
    value === 'overage'
  );
}

function parseResetsAt(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function parseClaudeRateLimitEvent(
  info: unknown,
): ParsedClaudeRateLimitEvent | null {
  if (!isRecord(info)) {
    return null;
  }

  const status = info.status;
  const rateLimitType = info.rateLimitType;
  if (
    !isClaudeRateLimitStatus(status) ||
    !isClaudeRateLimitType(rateLimitType)
  ) {
    return null;
  }

  const resetsAt = parseResetsAt(info.resetsAt);
  const utilization = info.utilization;
  const usedPercent =
    status === 'rejected'
      ? 100
      : typeof utilization === 'number' &&
          Number.isFinite(utilization) &&
          utilization >= 0 &&
          utilization <= 1
        ? utilization * 100
        : undefined;

  return {
    rateLimitType,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function hasScopedModel(limitId: string, model: string): boolean {
  return (
    limitId.startsWith(WEEKLY_SCOPED_PREFIX) &&
    limitId.slice(WEEKLY_SCOPED_PREFIX.length).toLowerCase().includes(model)
  );
}

function matchesRateLimitType(
  limitId: string | undefined,
  rateLimitType: ClaudeRateLimitType,
): boolean {
  if (limitId === undefined) {
    return false;
  }

  switch (rateLimitType) {
    case 'five_hour':
      return limitId === 'session' || limitId === 'five_hour';
    case 'seven_day':
      return limitId === 'weekly_all' || limitId === 'seven_day';
    case 'seven_day_opus':
      return limitId === 'seven_day_opus' || hasScopedModel(limitId, 'opus');
    case 'seven_day_sonnet':
      return (
        limitId === 'seven_day_sonnet' || hasScopedModel(limitId, 'sonnet')
      );
    case 'seven_day_overage_included':
    case 'overage':
      return false;
  }
}

interface ClaudeRateLimitWindowObservation {
  limitId: string;
  usedPercent?: number;
  resetsAt?: string;
}

interface ClaudeRateLimitObservation {
  /** Null when no published values changed, even if a field was observed. */
  rateLimits: ProviderRateLimitSnapshot[] | null;
  windows: ClaudeRateLimitWindowObservation[];
}

/** Records supplied fields independently of whether their values changed. */
export function observeClaudeRateLimitWindows(
  current: readonly ProviderRateLimitSnapshot[],
  info: unknown,
): ClaudeRateLimitObservation | null {
  const event = parseClaudeRateLimitEvent(info);
  if (
    event === null ||
    (event.usedPercent === undefined && event.resetsAt === undefined)
  ) {
    return null;
  }

  const windows: ClaudeRateLimitWindowObservation[] = [];
  let changed = false;
  const patched = current.map((snapshot) => {
    const primary = snapshot.primary;
    if (
      primary === undefined ||
      snapshot.limitId === undefined ||
      !matchesRateLimitType(snapshot.limitId, event.rateLimitType)
    ) {
      return snapshot;
    }

    windows.push({
      limitId: snapshot.limitId,
      ...(event.usedPercent === undefined
        ? {}
        : { usedPercent: event.usedPercent }),
      ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
    });
    const usedPercentChanged =
      event.usedPercent !== undefined &&
      primary.usedPercent !== event.usedPercent;
    const resetsAtChanged =
      event.resetsAt !== undefined && primary.resetsAt !== event.resetsAt;
    if (!usedPercentChanged && !resetsAtChanged) return snapshot;

    changed = true;
    return {
      ...snapshot,
      primary: {
        ...primary,
        ...(event.usedPercent === undefined
          ? {}
          : { usedPercent: event.usedPercent }),
        ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }),
      },
    };
  });

  return windows.length === 0
    ? null
    : { rateLimits: changed ? patched : null, windows };
}

/** Applies changed SDK values to existing windows; no-op updates return null. */
export function patchClaudeRateLimitEvent(
  current: readonly ProviderRateLimitSnapshot[],
  info: unknown,
): ProviderRateLimitSnapshot[] | null {
  return observeClaudeRateLimitWindows(current, info)?.rateLimits ?? null;
}
