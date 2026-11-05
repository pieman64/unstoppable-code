import type { ProviderRateLimitSnapshot } from '../types/observability';

interface SubscriptionUsageContext {
  provider: string;
  rateLimits: readonly ProviderRateLimitSnapshot[] | undefined;
  model?: string;
  surface?: string;
  nowMs?: number;
}

/** Known Claude families have aliases as well as versioned model identifiers. */
function modelFamily(model: string): string | undefined {
  const normalized = model.toLowerCase();
  for (const family of ['sonnet', 'opus', 'haiku', 'fable']) {
    if (normalized.includes(family)) return family;
  }
  return undefined;
}

/** Whether a provider-reported surface names Claude Code (`cli` included). */
export function isClaudeCodeSurface(surface: string): boolean {
  return surfaceFamily(surface) === 'claude-code';
}

function surfaceFamily(surface: string): string | undefined {
  const normalized = surface.toLowerCase().replace(/[ _-]/g, '');
  if (normalized === 'claudecode' || normalized === 'cli') return 'claude-code';
  if (normalized === 'cowork') return 'cowork';
  if (normalized === 'oauthapps') return 'oauth_apps';
  return undefined;
}

/** Overage funding is independent of included subscription allowance. */
export function subscriptionUsageLimits({
  provider,
  rateLimits,
  model,
  surface,
}: SubscriptionUsageContext): readonly ProviderRateLimitSnapshot[] {
  return (rateLimits ?? []).filter((limit) => {
    if (provider !== 'claude') return true;
    if (limit.limitId === 'extra_usage') return false;
    const scopedModel =
      limit.scope?.model?.id ?? limit.scope?.model?.displayName;
    if (scopedModel && model) {
      const scopedFamily = modelFamily(scopedModel);
      const requestedFamily = modelFamily(model);
      if (scopedFamily && requestedFamily && scopedFamily !== requestedFamily)
        return false;
    }
    const scopedSurface = limit.scope?.surface;
    if (scopedSurface && surface) {
      const scopedFamily = surfaceFamily(scopedSurface);
      const requestedFamily = surfaceFamily(surface);
      if (scopedFamily && requestedFamily && scopedFamily !== requestedFamily)
        return false;
    }
    return true;
  });
}

export interface SubscriptionUsageAvailability {
  status: 'available' | 'limited' | 'unknown';
  /** Only present when every blocking window has a valid future reset. */
  resetsAt?: number;
}

function resetTime(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const epoch =
    typeof value === 'number'
      ? value < 1_000_000_000_000
        ? value * 1000
        : value
      : Date.parse(value);
  return Number.isFinite(epoch) && Number.isFinite(new Date(epoch).getTime())
    ? epoch
    : undefined;
}

/** A successful fresh fetch is required separately before using headroom to clear fallback. */
export function classifySubscriptionUsage(
  context: SubscriptionUsageContext,
): SubscriptionUsageAvailability {
  const limits = subscriptionUsageLimits(context);
  const nowMs = context.nowMs ?? Date.now();
  let readable = false;
  let unknown = limits.length === 0;
  let limited = false;
  let missingReset = false;
  let latestReset: number | undefined;
  for (const limit of limits) {
    const windows = [limit.primary, limit.secondary].filter(
      (window) => window !== undefined,
    );
    if (windows.length === 0) unknown = true;
    for (const window of windows) {
      if (window.unlimited === true) {
        readable = true;
        continue;
      }
      const percent = window.usedPercent;
      if (percent === undefined || !Number.isFinite(percent) || percent < 0) {
        unknown = true;
        continue;
      }
      readable = true;
      if (percent < 100) continue;
      const reset = resetTime(window.resetsAt);
      if (reset !== undefined && reset <= nowMs) {
        unknown = true;
        continue;
      }
      limited = true;
      if (reset === undefined) missingReset = true;
      else latestReset = Math.max(latestReset ?? reset, reset);
    }
  }
  if (limited)
    return {
      status: 'limited',
      ...(!missingReset && latestReset !== undefined
        ? { resetsAt: latestReset }
        : {}),
    };
  return { status: readable && !unknown ? 'available' : 'unknown' };
}
