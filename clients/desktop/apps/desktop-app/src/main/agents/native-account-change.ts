// Native account and subscription recovery tracking for AI Credits routing.
//
// Session-scoped AI Credits routing ("Use AI Credits" from the usage-limit
// banner) covers the limit of the account that hit it. When the user signs
// into a different Claude or Codex account, that limit no longer applies, so
// the routing must stop. This module records the last confirmed native
// account per billed provider in preferences, and the time it last changed.
// A fresh successful allowance read also records a separate fetch-start
// watermark. Main reads both synchronously on the routing path; the renderer
// reads the same preference to hide stale session routing. Persistent choices
// are never invalidated by allowance recovery.

import type { NativeAccountProvider } from '@canopy/desktop-shared/types';
import { providerAccountKey } from '@canopy/desktop-shared/ai-credits-routing-state';
import type { ConfirmedProviderAuthEvent } from '../auth/provider-auth-state';
import {
  readPreferencesFile,
  updatePreferencesFile,
} from '../lib/preferences-store';
import { broadcastPreferencesChanged } from '../lib/preferences-broadcast';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  canReconcileProviderQuotaReached,
  clearProviderQuotaReached,
  reconcileProviderQuotaReached,
} from './ai-credits-quota-state';

type ConfirmedProviderAuthSubscribe = (
  listener: (event: ConfirmedProviderAuthEvent) => void,
) => () => void;

const changedAtByProvider = new Map<NativeAccountProvider, number>();
const restoredAtByProvider = new Map<NativeAccountProvider, number>();
// One chain serializes the seed and every read-compare-write, so account
// changes and allowance observations cannot overwrite each other.
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

/** Fetch-start watermark of the latest fresh, successful native allowance read. */
export function getNativeSubscriptionRestoredAt(
  provider: NativeAccountProvider,
): number | undefined {
  return restoredAtByProvider.get(provider);
}

async function seedChangedAt(): Promise<void> {
  const accounts = (await readPreferencesFile()).nativeProviderAccounts;
  for (const provider of ['claude', 'codex'] as const) {
    const changedAt = accounts?.[provider]?.changedAt;
    if (changedAt !== undefined && !changedAtByProvider.has(provider)) {
      changedAtByProvider.set(provider, changedAt);
    }
    const restoredAt = accounts?.[provider]?.subscriptionRestoredAt;
    if (restoredAt !== undefined && !restoredAtByProvider.has(provider)) {
      restoredAtByProvider.set(provider, restoredAt);
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
  restoredAtByProvider.delete(provider);
  broadcastPreferencesChanged();
  clearProviderQuotaReached(provider);
  clearRoutingCaches();
}

/**
 * Reconcile only a fresh, successful, same-account subscription read. The
 * caller has already classified all applicable windows as available; neither
 * cached/error reads nor usage-fetch 429s call this path. Its fetch-start
 * watermark protects a routing choice made while the read was in flight.
 */
export async function recordNativeSubscriptionRestored(
  provider: NativeAccountProvider,
  accountKey: string,
  fetchStartedAt: number,
  isCurrentObservation: () => boolean,
): Promise<boolean> {
  if (
    !accountKey.trim() ||
    !Number.isFinite(fetchStartedAt) ||
    fetchStartedAt <= 0
  ) {
    return false;
  }
  let recorded = false;
  let priorRestoredAt: number | undefined;
  trackingChain = trackingChain
    .then(async () => {
      if (
        !isCurrentObservation() ||
        !canReconcileProviderQuotaReached(provider, fetchStartedAt)
      )
        return;
      await updatePreferencesFile((latest) => {
        recorded = false;
        const accounts = latest.nativeProviderAccounts ?? {};
        const previous = accounts[provider];
        if (
          (previous !== undefined && previous.accountKey !== accountKey) ||
          (previous?.subscriptionRestoredAt ?? 0) >= fetchStartedAt ||
          !isCurrentObservation() ||
          !canReconcileProviderQuotaReached(provider, fetchStartedAt)
        ) {
          return null;
        }
        priorRestoredAt = previous?.subscriptionRestoredAt;
        recorded = true;
        return {
          nativeProviderAccounts: {
            ...accounts,
            [provider]: {
              ...previous,
              accountKey,
              subscriptionRestoredAt: fetchStartedAt,
            },
          },
        };
      });
      if (!recorded) return;
      if (
        !isCurrentObservation() ||
        !reconcileProviderQuotaReached(provider, fetchStartedAt)
      ) {
        // A newer observation or rejection arrived during the pending write.
        // Undo only our own watermark; never erase another newer read.
        await updatePreferencesFile((latest) => {
          const accounts = latest.nativeProviderAccounts ?? {};
          const current = accounts[provider];
          if (
            current?.accountKey !== accountKey ||
            current.subscriptionRestoredAt !== fetchStartedAt
          ) {
            return null;
          }
          const nextAccount = { ...current };
          delete nextAccount.subscriptionRestoredAt;
          if (priorRestoredAt !== undefined) {
            nextAccount.subscriptionRestoredAt = priorRestoredAt;
          }
          return {
            nativeProviderAccounts: {
              ...accounts,
              [provider]: nextAccount,
            },
          };
        });
        recorded = false;
        return;
      }
      restoredAtByProvider.set(provider, fetchStartedAt);
      broadcastPreferencesChanged();
    })
    .catch((error: unknown) => {
      recorded = false;
      logMainProcessWarn(
        `native-account-change: failed to record ${provider} subscription recovery`,
        error instanceof Error ? error.message : String(error),
      );
    });
  await trackingChain;
  return recorded;
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
    restoredAtByProvider.clear();
    trackingChain = Promise.resolve();
  },
};
