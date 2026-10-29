import type { TelemetryProvider } from './index';

/**
 * Providers that have native subscription accounts we attribute turns to.
 * `ollama` is local/free and never carries a subscription plan.
 */
export type SubscriptionProvider = Extract<
  TelemetryProvider,
  'claude' | 'codex'
>;

/**
 * Map a raw provider plan-type string (Claude `subscriptionType`, Codex
 * `planType`) to a stable canonical plan key `` `${provider}:${slug}` ``.
 *
 * Known strings collapse to a curated key so catalog defaults and per-org
 * overrides line up. Unknown strings pass through as
 * `` `${provider}:${lowercasedSlug}` `` so they remain priceable via an
 * override and are never silently dropped (raw plan strings are not
 * contractual — see the plan's normalization risk note).
 */
export function normalizePlanKey(
  provider: SubscriptionProvider,
  rawPlanType: string | null | undefined,
): string {
  const raw = (rawPlanType ?? '').trim().toLowerCase();
  const slug = raw.replace(/[\s_]+/g, '-');
  const known = KNOWN_PLAN_ALIASES[provider][slug];
  if (known) {
    return known;
  }
  const tierMatch = matchClaudeMaxTier(provider, slug);
  if (tierMatch) {
    return tierMatch;
  }
  const fallbackSlug = slug.length > 0 ? slug : 'unknown';
  return `${provider}:${fallbackSlug}`;
}

/**
 * Claude's OAuth `rateLimitTier` carries the only signal that distinguishes Max
 * 5x from Max 20x — the coarser `subscriptionType` reports both as bare `max`.
 * That field is a rate-limit descriptor, not a contractual billing API, and has
 * appeared as e.g. `default_claude_max_20x`, so we substring-match the tier
 * defensively rather than enumerating exact strings. Bare `max` (no tier)
 * intentionally does not match here so it keeps flowing through the alias table
 * to the `claude:max-5x` default.
 */
function matchClaudeMaxTier(
  provider: SubscriptionProvider,
  slug: string,
): string | null {
  if (provider !== 'claude' || !slug.includes('max')) {
    return null;
  }
  // Require the tier digits to be delimited (not part of a longer number) so an
  // unforeseen future tier like `max-25x` does not false-match as 5x.
  if (/(?:^|\D)20x?(?:\D|$)/.test(slug)) {
    return 'claude:max-20x';
  }
  if (/(?:^|\D)5x?(?:\D|$)/.test(slug)) {
    return 'claude:max-5x';
  }
  return null;
}

const KNOWN_PLAN_ALIASES: Record<
  SubscriptionProvider,
  Record<string, string>
> = {
  claude: {
    pro: 'claude:pro',
    max: 'claude:max-5x',
    'max-5x': 'claude:max-5x',
    max5x: 'claude:max-5x',
    'max-5': 'claude:max-5x',
    'max-20x': 'claude:max-20x',
    max20x: 'claude:max-20x',
    'max-20': 'claude:max-20x',
    team: 'claude:team',
    'team-premium': 'claude:team-premium',
    enterprise: 'claude:enterprise',
  },
  codex: {
    plus: 'codex:plus',
    pro: 'codex:pro',
    team: 'codex:business',
    business: 'codex:business',
    enterprise: 'codex:enterprise',
  },
};

/**
 * Catalog default monthly price (USD) per canonical plan key. `null` marks a
 * plan whose price is not publicly listed (enterprise / unknown) and must be
 * set per-org via an override before it contributes to billed cost. Seat-based
 * plans (team/business) use the per-seat list price.
 */
export const DEFAULT_PLAN_PRICES_USD_PER_MONTH: Record<string, number | null> =
  {
    'claude:pro': 20,
    'claude:max-5x': 100,
    'claude:max-20x': 200,
    'claude:team': 30,
    // TODO(billing): confirm the Team Premium seat list price. This is a
    // best-effort default; orgs can correct it via a per-org price override.
    'claude:team-premium': 150,
    'claude:enterprise': null,
    'codex:plus': 20,
    'codex:pro': 200,
    'codex:business': 25,
    'codex:enterprise': null,
  };

const PLAN_LABELS: Record<string, string> = {
  'claude:pro': 'Claude Pro',
  'claude:max-5x': 'Claude Max 5x',
  'claude:max-20x': 'Claude Max 20x',
  'claude:team': 'Claude Team',
  'claude:team-premium': 'Claude Team Premium',
  'claude:enterprise': 'Claude Enterprise',
  'codex:plus': 'ChatGPT Plus',
  'codex:pro': 'ChatGPT Pro',
  'codex:business': 'ChatGPT Business',
  'codex:enterprise': 'ChatGPT Enterprise',
};

/**
 * Provider portion of a canonical plan key, or null when malformed. A valid
 * key is `provider:slug` with a recognized provider and a non-empty slug, so
 * bare prefixes like `claude` or trailing-colon keys like `claude:` are
 * rejected rather than passing validation as usable overrides.
 */
export function providerForPlanKey(
  planKey: string,
): SubscriptionProvider | null {
  const [provider, ...rest] = planKey.split(':');
  const slug = rest.join(':');
  if (slug.length === 0) {
    return null;
  }
  return provider === 'claude' || provider === 'codex' ? provider : null;
}

/**
 * Human-readable label for a plan key. Known keys use a curated label; unknown
 * passthrough keys are title-cased from their slug so they still render
 * sensibly in the settings/overview tables.
 */
export function labelForPlanKey(planKey: string): string {
  const known = PLAN_LABELS[planKey];
  if (known) {
    return known;
  }
  const [provider, ...rest] = planKey.split(':');
  const slug = rest.join(':');
  const providerLabel = provider === 'codex' ? 'ChatGPT' : titleCase(provider);
  const planLabel = titleCase(slug.replace(/-/g, ' '));
  return planLabel ? `${providerLabel} ${planLabel}` : providerLabel;
}

/**
 * Friendly full subscription label for a raw provider plan-type string, or
 * `null` when the plan is absent or unrecognized (`` `${provider}:unknown` ``).
 * Wraps `normalizePlanKey` + `labelForPlanKey` with the shared unknown-guard so
 * the desktop Usage cards and the account-settings provider panels render the
 * same catalog label (e.g. `Claude Max 20x`, `ChatGPT Plus`) and both stay
 * clean instead of showing an editorialized `ChatGPT Unknown` suffix.
 */
export function subscriptionLabelForPlanType(
  provider: SubscriptionProvider,
  rawPlanType: string | null | undefined,
): string | null {
  const planKey = normalizePlanKey(provider, rawPlanType);
  if (planKey === `${provider}:unknown`) {
    return null;
  }
  return labelForPlanKey(planKey);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Effective monthly price for a plan key: the per-org override when set,
 * otherwise the catalog default, otherwise `null` (unpriced).
 */
export function getEffectiveMonthlyPrice(
  planKey: string,
  overrides: ReadonlyMap<string, number>,
): number | null {
  const override = overrides.get(planKey);
  if (override !== undefined) {
    return override;
  }
  const fallback = DEFAULT_PLAN_PRICES_USD_PER_MONTH[planKey];
  return fallback ?? null;
}
