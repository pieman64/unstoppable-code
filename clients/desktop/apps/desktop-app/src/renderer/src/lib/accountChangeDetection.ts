import type {
  AgentProviderAuthStatus,
  AgentProviderType,
} from '@canopy/desktop-shared/types';

function fingerprint(status: AgentProviderAuthStatus): string {
  if (status.authFingerprint?.trim()) {
    return status.authFingerprint.trim();
  }
  return `${status.accountLabel ?? ''}::${status.detail ?? ''}`;
}

function planType(
  provider: AgentProviderType,
  status: AgentProviderAuthStatus,
): string | null {
  const value = status.planType?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (provider !== 'claude') {
    return value;
  }

  // Claude's auth payload reports Max and Team at lower resolution than the
  // OAuth credential store. A failed credential read can therefore make the
  // same account alternate between `max` and an enriched rate-limit tier (or
  // between `team` and `team-premium`). Do not infer an account change from a
  // value that cannot identify the underlying plan/seat precisely.
  if (value === 'max' || value === 'team') {
    return null;
  }

  // The enriched Max tier is not a contractual string. Canonicalize the known
  // forms so equivalent precise representations compare equal.
  const slug = value.replace(/[\s_]+/g, '-');
  if (slug.includes('max')) {
    if (/(?:^|\D)20x?(?:\D|$)/.test(slug)) {
      return 'max-20x';
    }
    if (/(?:^|\D)5x?(?:\D|$)/.test(slug)) {
      return 'max-5x';
    }
  }
  return slug;
}

/**
 * True when `after` is a verified login that resolves to a different account
 * than `before`. Subscription accounts compare by normalized email and, when
 * both statuses expose it, plan type. This treats the same email on a different
 * subscription/seat plan as a new quota source. Other (API-key/bedrock) logins
 * fall back to the auth fingerprint (label + detail).
 */
export function isDifferentProviderAccount(
  provider: AgentProviderType,
  before: AgentProviderAuthStatus | null,
  after: AgentProviderAuthStatus,
): boolean {
  if (!after.authenticated) return false;
  if (!before || !before.authenticated) return true;

  const afterEmail = after.accountEmail?.trim().toLowerCase();
  const beforeEmail = before.accountEmail?.trim().toLowerCase();
  if (
    before.accountKind === 'subscription' &&
    after.accountKind === 'subscription' &&
    afterEmail &&
    beforeEmail
  ) {
    if (afterEmail !== beforeEmail) {
      return true;
    }
    const afterPlanType = planType(provider, after);
    const beforePlanType = planType(provider, before);
    return Boolean(
      afterPlanType && beforePlanType && afterPlanType !== beforePlanType,
    );
  }
  return fingerprint(before) !== fingerprint(after);
}
