/**
 * Resolve only plan facts the account's own OAuth profile reports. The usage
 * percentage cannot distinguish subscriptions, and the Max tier is ambiguous
 * without the profile's rate-limit descriptor.
 */
export function resolveClaudePlanType(
  subscriptionType: string | null,
  rateLimitTier: string | null,
): string | null {
  const plan = subscriptionType?.trim().toLowerCase() ?? '';
  switch (plan) {
    case 'pro':
      return 'pro';
    case 'enterprise':
      return 'enterprise';
    case 'team':
      return rateLimitTier === 'default_claude_max_5x'
        ? 'team-premium'
        : 'team';
    case 'max':
      return rateLimitTier || 'max';
    default:
      return plan.startsWith('max') ? rateLimitTier || subscriptionType : null;
  }
}

/** Claude Code maps these OAuth organization kinds to subscription types. */
export function claudePlanTypeFromOAuthProfile(
  organizationType: string | null,
  rateLimitTier: string | null,
): string | null {
  switch (organizationType) {
    case 'claude_pro':
      return resolveClaudePlanType('pro', rateLimitTier);
    case 'claude_enterprise':
      return resolveClaudePlanType('enterprise', rateLimitTier);
    case 'claude_team':
      return resolveClaudePlanType('team', rateLimitTier);
    case 'claude_max':
      return resolveClaudePlanType('max', rateLimitTier);
    default:
      return null;
  }
}
