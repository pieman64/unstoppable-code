// Browser-safe staleness rules for per-chat AI Credits routing (CAN-4200).
// Main applies them to the authoritative billing decision and the renderer
// applies them to the composer, so both judge staleness by the same rule.

import { normalizeEpochMs } from '@canopy/agent-transcript';
import type { AgentProviderAuthStatus, AiCreditsRoutingState } from './types';

// Defined once in the transcript package so its reducer and these routing
// rules share one seconds-or-milliseconds rule; re-exported for importers.
export { normalizeEpochMs };

/**
 * Identity used to detect a native account switch: the lowercased email,
 * else the label. The opaque auth fingerprint is deliberately not used,
 * because a fresh sign-in to the same account can change it.
 */
export function providerAccountKey(
  status: Pick<AgentProviderAuthStatus, 'accountEmail' | 'accountLabel'>,
): string | null {
  const email = status.accountEmail?.trim().toLowerCase();
  if (email) return email;
  const label = status.accountLabel?.trim();
  return label ? label : null;
}

/**
 * Whether stored routing still applies. Persistent routing always applies.
 * Session routing stops at its reset time, after a native account change, or
 * after a fresh successful observation of restored subscription allowance.
 * Missing activation counts as older than either observation.
 */
export function isAiCreditsRoutingInEffect(
  // Persisted legacy tabs can lack `activatedAt`, so it is optional here.
  routing:
    | (Omit<AiCreditsRoutingState, 'activatedAt'> & { activatedAt?: number })
    | undefined,
  input: {
    now: number;
    accountChangedAt?: number;
    subscriptionRestoredAt?: number;
  },
): boolean {
  if (!routing?.active) return false;
  if (routing.scope === 'persistent') return true;
  // Normalized because older writers stored Codex reset times in seconds.
  const resetsAt =
    routing.resetsAt === undefined
      ? undefined
      : normalizeEpochMs(routing.resetsAt);
  if (resetsAt !== undefined && resetsAt <= input.now) {
    return false;
  }
  if (
    input.accountChangedAt !== undefined &&
    (routing.activatedAt ?? 0) < input.accountChangedAt
  ) {
    return false;
  }
  if (
    input.subscriptionRestoredAt !== undefined &&
    (routing.activatedAt ?? 0) < input.subscriptionRestoredAt
  ) {
    return false;
  }
  return true;
}
