import { ONBOARDING_CHECKLIST_ITEM_IDS } from '@canopy/desktop-shared/types';
import type {
  OnboardingChecklistItemId,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import { readLockFile } from '../skills/lock-file';
import { loadCanopyCloudAccount } from './canopy-cloud-account-store';
import {
  hasEverSentChatMessage,
  resetChatHistoryScanForTests,
} from './chat-history-scan';
import {
  latchOnboardingChecklistItemComplete,
  readOnboardingChecklistPersistedState,
} from './onboarding-checklist-state';

/**
 * Live product-state derivation for the sidebar onboarding checklist
 * (CAN-788; step set revised by CAN-2663). Every signal is a cheap read
 * against the canonical store for that domain — completion is never inferred
 * from clicks or page views. A signal that cannot be evaluated (missing file,
 * failed collaborator) counts as incomplete rather than failing the whole
 * snapshot; the durable latches in `onboarding-checklist-state.ts` keep
 * previously observed completions stable regardless.
 *
 * `connect-accounts` is deliberately absent here: provider auth probes are
 * renderer-owned (cached hooks; the Codex probe can spawn an app-server), so
 * the renderer reports that item's completion through the
 * `onboarding-checklist:mark-item-complete` IPC and only its latch is
 * consulted main-side.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function evaluateSafely(
  signal: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await signal();
  } catch {
    return false;
  }
}

/**
 * Whether a real (non-guest) Canopy Cloud account is signed in.
 *
 * The guest check is the whole point of this signal. Every fresh install
 * mints a consented guest credential so the included AI Credits work without
 * signup, and that guest resolves as a real cloud user — so a plain
 * "has credential" test would render "Create an account" pre-completed for
 * literally every user, including the ones the step exists to reach.
 *
 * A degraded/unavailable secure-store read collapses to `null` here, which
 * yields `false` (incomplete). That is the safe direction: an inconclusive
 * read must never latch the item complete, and the next successful read
 * completes it.
 */
async function hasRealCloudAccount(): Promise<boolean> {
  const account = await loadCanopyCloudAccount();
  return account !== null && !isGuestAccount(account);
}

function hasInstalledSkill(): Promise<boolean> {
  const lock: unknown = readLockFile();
  if (!isRecord(lock) || !isRecord(lock.skills)) return Promise.resolve(false);
  return Promise.resolve(Object.keys(lock.skills).length > 0);
}

async function hasInstalledPlugin(): Promise<boolean> {
  const result = await loadMarketplacesCacheOnly();
  if (!result.success || result.data === undefined) return false;
  return result.data.marketplaces.some((marketplace) =>
    marketplace.plugins.some(
      (plugin) =>
        plugin.globalInstallStatus?.claude?.installed === true ||
        plugin.globalInstallStatus?.codex?.installed === true,
    ),
  );
}

async function hasInstalledCapability(): Promise<boolean> {
  if (await evaluateSafely(hasInstalledSkill)) return true;
  return evaluateSafely(hasInstalledPlugin);
}

/**
 * Compute the checklist wire snapshot: persisted latches merged with live
 * derivation, latching any newly satisfied item so it stays complete. The
 * latch writes are awaited so a snapshot is never ahead of durable state for
 * long enough to lose an observation across an immediate quit.
 */
export async function computeOnboardingChecklistState(): Promise<OnboardingChecklistState> {
  const persisted = await readOnboardingChecklistPersistedState();
  const latched = (itemId: OnboardingChecklistItemId): boolean =>
    persisted.completedItems[itemId] !== undefined;

  const [chatStarted, capabilityInstalled, accountCreated] = await Promise.all([
    // `hasEverSentChatMessage` is the shared memoized backfill for installs
    // that predate this item; live sends latch through
    // `notifyOnboardingChecklistChatStarted()` so a first send never waits on
    // a rescan.
    latched('start-chat')
      ? Promise.resolve(true)
      : evaluateSafely(hasEverSentChatMessage),
    latched('add-capability')
      ? Promise.resolve(true)
      : hasInstalledCapability(),
    latched('create-account')
      ? Promise.resolve(true)
      : evaluateSafely(hasRealCloudAccount),
  ]);

  const completion: Record<OnboardingChecklistItemId, boolean> = {
    'start-chat': chatStarted,
    'connect-accounts': latched('connect-accounts'),
    'add-capability': capabilityInstalled,
    'create-account': accountCreated,
  };

  const newlyComplete = ONBOARDING_CHECKLIST_ITEM_IDS.filter(
    (itemId) => completion[itemId] && !latched(itemId),
  );
  await Promise.all(
    newlyComplete.map((itemId) => latchOnboardingChecklistItemComplete(itemId)),
  );

  return {
    items: ONBOARDING_CHECKLIST_ITEM_IDS.map((itemId) => ({
      id: itemId,
      complete: completion[itemId],
    })),
    dismissedAt: persisted.dismissedAt,
    snoozedUntil: persisted.snoozedUntil,
    providersNotUsed: persisted.providersNotUsed,
  };
}

export function resetOnboardingChecklistProgressForTests(): void {
  resetChatHistoryScanForTests();
}
