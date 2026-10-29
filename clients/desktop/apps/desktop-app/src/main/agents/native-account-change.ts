// Native account change tracking for AI Credits routing (CAN-4200).
//
// Session-scoped AI Credits routing ("Use AI Credits" from the usage-limit
// banner) covers the limit of the account that hit it. When the user signs
// into a different Claude or Codex account, that limit no longer applies, so
// the routing must stop. This module records the last confirmed native
// account per billed provider in preferences, and the time it last changed.
// Main reads the change time synchronously on the routing path; the renderer
// reads the same preference to hide the routing card.

import type { NativeAccountProvider } from '@canopy/desktop-shared/types';
import { providerAccountKey } from '@canopy/desktop-shared/ai-credits-routing-state';
import type { ConfirmedProviderAuthEvent } from '../auth/provider-auth-state';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { clearProviderQuotaReached } from './ai-credits-quota-state';

type ConfirmedProviderAuthSubscribe = (
  listener: (event: ConfirmedProviderAuthEvent) => void,
) => () => void;

const changedAtByProvider = new Map<NativeAccountProvider, number>();
// One chain serializes the seed and every read-compare-write, so a replayed
// and a live observation can neither race nor double-write.
let trackingChain: Promise<void> = Promise.resolve();

/**
 * When the provider's native account last changed to a different account,
 * in ms since epoch. `undefined` until a change is recorded.
 */
export function getNativeAccountChangedAt(
  provider: NativeAccountProvider,
): number | undefined {
  return changedAtByProvider.get(provider);
}

async function seedChangedAt(): Promise<void> {
  const accounts = (await readPreferencesFile()).nativeProviderAccounts;
  for (const provider of ['claude', 'codex'] as const) {
    const changedAt = accounts?.[provider]?.changedAt;
    if (changedAt !== undefined && !changedAtByProvider.has(provider)) {
      changedAtByProvider.set(provider, changedAt);
    }
  }
}

async function recordConfirmedAccount(
  provider: NativeAccountProvider,
  accountKey: string,
  observedAt: number,
  clearRoutingCaches: () => void,
): Promise<void> {
  const outcome: { changedAt?: number } = {};
  await updatePreferencesFile((latest) => {
    delete outcome.changedAt;
    const accounts = latest.nativeProviderAccounts ?? {};
    const previous = accounts[provider];
    if (previous?.accountKey === accountKey) return null;
    // The first account observed after this shipped is a baseline, not a
    // change: no earlier account is known to compare it with.
    if (!previous) {
      return {
        nativeProviderAccounts: { ...accounts, [provider]: { accountKey } },
      };
    }
    const changedAt = observedAt;
    outcome.changedAt = changedAt;
    return {
      nativeProviderAccounts: {
        ...accounts,
        [provider]: { accountKey, changedAt },
      },
    };
  });
  const { changedAt } = outcome;
  if (changedAt === undefined) return;
  // Main's view first, so a renderer re-reading on the broadcast and the next
  // routing decision agree.
  changedAtByProvider.set(provider, changedAt);
  broadcastPreferencesChanged();
  clearProviderQuotaReached(provider);
  clearRoutingCaches();
}

/**
 * Record each confirmed native sign-in. A different account than the one last
 * recorded counts as a change for every connect source, so a switch made
 * while the app was closed is seen at startup. Sign-out is not a change.
 * `clearRoutingCaches` is injected so this module, which the routing path
 * reads, does not import `ai-credits-routing` back.
 */
export function startNativeAccountChangeTracking({
  subscribe,
  clearRoutingCaches,
}: {
  subscribe: ConfirmedProviderAuthSubscribe;
  clearRoutingCaches: () => void;
}): () => void {
  trackingChain = trackingChain.then(seedChangedAt).catch((error: unknown) => {
    logMainProcessWarn(
      'native-account-change: failed to read recorded accounts',
      error instanceof Error ? error.message : String(error),
    );
  });
  // Listeners run in the observation's call path: queue the work and return.
  return subscribe((event) => {
    const { provider } = event;
    const accountKey = providerAccountKey(event.status);
    if (accountKey === null) return;
    // Stamped now, not when the queued write runs, so routing chosen on the
    // new account in between is not judged older than the switch.
    const observedAt = Date.now();
    trackingChain = trackingChain
      .then(() =>
        recordConfirmedAccount(
          provider,
          accountKey,
          observedAt,
          clearRoutingCaches,
        ),
      )
      .catch((error: unknown) => {
        logMainProcessWarn(
          `native-account-change: failed to record ${provider} account`,
          error instanceof Error ? error.message : String(error),
        );
      });
  });
}

/** Test seams: wait for queued observations, and forget recorded changes. */
export const nativeAccountChangeTestSeams = {
  whenIdle(): Promise<void> {
    return trackingChain;
  },
  reset(): void {
    changedAtByProvider.clear();
    trackingChain = Promise.resolve();
  },
};
