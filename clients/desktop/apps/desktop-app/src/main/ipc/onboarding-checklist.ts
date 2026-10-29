import {
  IPC_CHANNELS,
  ONBOARDING_CHECKLIST_PROVIDERS,
} from '@canopy/desktop-shared/types';
import type {
  OnboardingChecklistMarkItemCompleteRequest,
  OnboardingChecklistSetProviderNotUsedRequest,
  OnboardingChecklistSnoozeRequest,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { subscribeCanopyCloudAccountChanges } from '../lib/canopy-cloud-account-store';
import { computeOnboardingChecklistState } from '../lib/onboarding-checklist-progress';
import {
  latchOnboardingChecklistItemComplete,
  setOnboardingChecklistDismissedAt,
  setOnboardingChecklistProviderNotUsed,
  setOnboardingChecklistSnoozedUntil,
} from '../lib/onboarding-checklist-state';
import { sendToAllWindows } from '../lib/window-send';
import { requestActivationRecompute } from '../notifications/campaigns/scheduler';
import { registerIpcHandler } from './register';

/**
 * IPC surface for the persistent sidebar onboarding checklist (CAN-788).
 * Mutations resolve with the fresh post-mutation snapshot and additionally
 * broadcast it on `onboarding-checklist:changed` so every window converges
 * without reload.
 */
async function broadcastState(): Promise<OnboardingChecklistState> {
  const state = await computeOnboardingChecklistState();
  sendToAllWindows(IPC_CHANNELS.onboardingChecklistChanged, state);
  return state;
}

/**
 * The Getting Started notification sequence (CAN-3013) treats a dismissed
 * checklist as an opt-out and a snoozed one as a hold. Both are event-driven
 * suppressions, so the handlers that change them re-arm the scheduler.
 * Deliberately NOT part of `broadcastState()`: item completion and
 * provider-not-used marks also broadcast, but cannot change the sequence's
 * answer, and each recompute costs an uncached preference read plus a
 * checklist derivation with synchronous filesystem reads on the main loop.
 * No-ops until the journey has started.
 */
function recomputeGettingStartedSequence(): void {
  requestActivationRecompute();
}

export async function handleGetOnboardingChecklistState(): Promise<OnboardingChecklistState> {
  return computeOnboardingChecklistState();
}

export async function handleDismissOnboardingChecklist(): Promise<OnboardingChecklistState> {
  await setOnboardingChecklistDismissedAt(new Date().toISOString());
  const state = await broadcastState();
  recomputeGettingStartedSequence();
  return state;
}

export async function handleSnoozeOnboardingChecklist(
  request: OnboardingChecklistSnoozeRequest,
): Promise<OnboardingChecklistState> {
  const until = request?.until;
  if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) {
    throw new Error('Invalid snooze deadline: expected an ISO-8601 timestamp.');
  }
  await setOnboardingChecklistSnoozedUntil(until);
  const state = await broadcastState();
  recomputeGettingStartedSequence();
  return state;
}

export async function handleRestoreOnboardingChecklist(): Promise<OnboardingChecklistState> {
  await setOnboardingChecklistDismissedAt(null);
  await setOnboardingChecklistSnoozedUntil(null);
  const state = await broadcastState();
  recomputeGettingStartedSequence();
  return state;
}

export async function handleSetOnboardingChecklistProviderNotUsed(
  request: OnboardingChecklistSetProviderNotUsedRequest,
): Promise<OnboardingChecklistState> {
  const provider = request?.provider;
  if (
    typeof provider !== 'string' ||
    !(ONBOARDING_CHECKLIST_PROVIDERS as readonly string[]).includes(provider)
  ) {
    throw new Error(
      `Unknown onboarding checklist provider: ${String(provider)}`,
    );
  }
  await setOnboardingChecklistProviderNotUsed(
    request.provider,
    request.notUsed === true,
  );
  return broadcastState();
}

export async function handleMarkOnboardingChecklistItemComplete(
  request: OnboardingChecklistMarkItemCompleteRequest,
): Promise<OnboardingChecklistState> {
  // Every other item is derived main-side from real product state; accepting
  // renderer latches for them would let a click count as progress.
  if (request?.itemId !== 'connect-accounts') {
    throw new Error(
      'Only the renderer-derived connect-accounts item can be latched over IPC.',
    );
  }
  await latchOnboardingChecklistItemComplete(request.itemId);
  return broadcastState();
}

export function registerOnboardingChecklistHandlers(): void {
  registerIpcHandler<[], OnboardingChecklistState>(
    IPC_CHANNELS.onboardingChecklistGetState,
    () => handleGetOnboardingChecklistState(),
  );
  registerIpcHandler<[], OnboardingChecklistState>(
    IPC_CHANNELS.onboardingChecklistDismiss,
    () => handleDismissOnboardingChecklist(),
  );
  registerIpcHandler<
    [OnboardingChecklistSnoozeRequest],
    OnboardingChecklistState
  >(IPC_CHANNELS.onboardingChecklistSnooze, (_event, request) =>
    handleSnoozeOnboardingChecklist(request),
  );
  registerIpcHandler<[], OnboardingChecklistState>(
    IPC_CHANNELS.onboardingChecklistRestore,
    () => handleRestoreOnboardingChecklist(),
  );
  registerIpcHandler<
    [OnboardingChecklistSetProviderNotUsedRequest],
    OnboardingChecklistState
  >(IPC_CHANNELS.onboardingChecklistSetProviderNotUsed, (_event, request) =>
    handleSetOnboardingChecklistProviderNotUsed(request),
  );
  registerIpcHandler<
    [OnboardingChecklistMarkItemCompleteRequest],
    OnboardingChecklistState
  >(IPC_CHANNELS.onboardingChecklistMarkItemComplete, (_event, request) =>
    handleMarkOnboardingChecklistItemComplete(request),
  );

  // Sign-in and sign-out both change whether a real (non-guest) account
  // exists, and neither goes through a checklist mutation, so re-derive on
  // the account store's own change signal rather than waiting for the next
  // incidental refresh.
  //
  // The signal is broader than that, though: it fires on EVERY account
  // persist, including the 20-minute org-enforced-settings re-probe
  // (`services/org-enforced-settings.ts`). Re-deriving on each of those would
  // run a full skills-lock read + marketplace-cache load + latch write and
  // broadcast to every window, forever, for users who finished or dismissed
  // the checklist months ago. So gate on the only transition that can change
  // this item: whether a real (non-guest) account exists.
  //
  // `null` means "not yet observed" and deliberately does NOT match either
  // boolean, so the first event always broadcasts once. Seeding from the
  // first event instead would swallow the case where that first event IS the
  // sign-in — exactly the transition this subscription exists to catch.
  let hadRealAccount: boolean | null = null;
  subscribeCanopyCloudAccountChanges((entry) => {
    const hasRealAccount = entry !== null && !isGuestAccount(entry);
    if (hadRealAccount === hasRealAccount) return;
    // Assign synchronously so the gate stays atomic — two same-value persists
    // arriving before the first broadcast settles must not both get through —
    // but roll back if the broadcast actually failed, so a rejected sign-in
    // broadcast is retried by the next persist instead of being swallowed
    // forever by the gate. The rollback is conditional so it cannot clobber a
    // newer transition that landed while this broadcast was in flight.
    const previous = hadRealAccount;
    hadRealAccount = hasRealAccount;
    void broadcastState().catch(() => {
      if (hadRealAccount === hasRealAccount) {
        hadRealAccount = previous;
      }
    });
  });
}

/**
 * Latch `start-chat` the moment a message is dispatched. The memoized history
 * backfill in `onboarding-checklist-progress.ts` only covers chats that
 * already had messages when this process started, so without this a user's
 * very first send would leave the card showing "Start a chat" until some
 * unrelated refresh happened to run.
 *
 * Fire-and-forget and fully swallowed: checklist bookkeeping must never
 * disrupt or delay sending a message.
 */
export function notifyOnboardingChecklistChatStarted(): void {
  void (async (): Promise<void> => {
    try {
      const { changed } =
        await latchOnboardingChecklistItemComplete('start-chat');
      if (changed) {
        await broadcastState();
      }
    } catch {
      // Never let checklist bookkeeping surface on the send path.
    }
  })();
}
