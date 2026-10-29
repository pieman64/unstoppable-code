import type { ProviderUsageSummary } from '@canopy/desktop-shared/types';
import {
  CopilotSignInExpiredError,
  CopilotSignInChangedError,
} from './credential-broker';

/** Normalize GitHub's own quota data; never estimate dollars from model prices. */
export async function readCopilotUsageSummary(
  signal: AbortSignal,
): Promise<ProviderUsageSummary> {
  const base: ProviderUsageSummary = {
    provider: 'copilot',
    authState: 'unknown',
    hasRemainingLimits: false,
    lastUpdatedAt: new Date().toISOString(),
  };
  try {
    const { copilotConnectionStatus, readCopilotAccountUsage } =
      await import('./connection');
    const status = await copilotConnectionStatus();
    signal.throwIfAborted();
    if (!status.enabled || !status.account)
      return { ...base, authState: 'unauthenticated' };
    const usage = await readCopilotAccountUsage(signal);
    signal.throwIfAborted();
    return {
      ...base,
      authState: 'authenticated',
      accountLabel: usage.account.login,
      hasRemainingLimits: usage.limits.some(
        (limit) => limit.unlimited || limit.usedPercent !== undefined,
      ),
      rateLimits: usage.limits.map((limit) => ({
        limitId: limit.id,
        limitName: limit.label,
        primary: {
          ...(limit.unlimited ? { unlimited: true } : {}),
          usedPercent: limit.unlimited ? undefined : limit.usedPercent,
          resetsAt: limit.resetsAt,
        },
      })),
    };
  } catch (error) {
    signal.throwIfAborted();
    const needsSignIn =
      error instanceof CopilotSignInExpiredError ||
      error instanceof CopilotSignInChangedError;
    return {
      ...base,
      authState: needsSignIn ? 'unauthenticated' : 'error',
      errorInfo: { kind: needsSignIn ? 'auth' : 'service' },
    };
  }
}
