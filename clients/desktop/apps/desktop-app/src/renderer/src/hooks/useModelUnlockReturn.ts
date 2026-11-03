import { useEffect } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import { MODEL_LIBRARY_UNLOCK_COPY } from '@canopy/ui-shared/components';
import {
  hasAiCreditsArrivalSession,
  reconcileAiCreditsArrivalAccount,
  suspendAiCreditsArrivalAccount,
} from '@/lib/aiCreditsArrivalConfirmation';
import { useNavigationScopeKey } from '@/lib/aiCreditsScope';
import { ensureModelLibraryAccessSubscribed } from '@/lib/modelLibraryAccess';
import {
  hasModelUnlockConfirmationSession,
  reconcileModelUnlockConfirmationAccount,
  recordModelUnlockConfirmation,
  suspendModelUnlockConfirmationAccount,
  useModelUnlockConfirmationStore,
} from '@/lib/modelUnlockConfirmation';
import {
  checkModelUnlockNow,
  clearModelUnlockIntent,
  handleBillingReturnLink,
  reconcileModelUnlockIntentAccount,
  runModelUnlockPolling,
  setModelUnlockConfirmedListener,
  useModelUnlockIntentStore,
  type PendingModelUnlockIntent,
} from '@/lib/modelUnlockIntent';
import { useGitHubStore } from '@/stores/githubStore';
import {
  hasAiCreditsHandoffs,
  reconcileAiCreditsHandoffAccount,
  suspendAiCreditsHandoffAccount,
  useAiCreditsHandoffStore,
  type AiCreditsHandoffAccountIdentity,
} from '@/stores/aiCreditsHandoffStore';

/**
 * Follow a browser checkout back into the app (CAN-4028).
 *
 * Mount exactly once, at the app root. It owns every reason the desktop
 * re-checks access while a purchase is pending — the poll loop, the return
 * link, and a window focus — and every reason it stops: completion, a newer
 * intent, sign-out or an account switch, an owner change, the timeout, and
 * unmount. Keeping them in one place is what guarantees a single loop.
 *
 * None of these triggers decides anything. Each one asks the server again,
 * and `modelUnlockIntent` acts only on that answer.
 */
export function useModelUnlockReturn(): void {
  // The poll loop exists exactly while an intent is `waiting`. Selecting the
  // id rather than the phase restarts the loop for a newer intent and tears it
  // down on every terminal phase with no extra bookkeeping.
  const pollingRequestId = useModelUnlockIntentStore((state) =>
    state.phase === 'waiting' ? state.intent?.requestId : undefined,
  );
  useEffect(() => {
    if (pollingRequestId === undefined) return undefined;
    return runModelUnlockPolling(pollingRequestId);
  }, [pollingRequestId]);

  useEffect(() => {
    let accountReadGeneration = 0;
    let accountReadPending = false;
    let active = true;
    let queuedConfirmation: PendingModelUnlockIntent | null = null;
    ensureModelLibraryAccessSubscribed();
    setModelUnlockConfirmedListener((intent): void => {
      useGitHubStore
        .getState()
        .addToast(MODEL_LIBRARY_UNLOCK_COPY.confirmed, 'success');
      if (intent.chatId === null) return;
      // The in-chat confirmation (CAN-5027) for the chat it started in.
      if (useModelUnlockConfirmationStore.getState().accountReady) {
        recordModelUnlockConfirmation(intent);
      } else {
        queuedConfirmation = intent;
      }
    });
    const unsubscribeReturn = window.api?.onDeepLinkBillingUnlocked?.(
      handleBillingReturnLink,
    );
    // Coming back to the window is the usual way a purchase ends, with or
    // without a return link. Only worth a read while something is pending.
    const handleFocus = (): void => {
      if (
        !accountReadPending &&
        Object.values(useAiCreditsHandoffStore.getState().records).some(
          (record) => record.identityUnverified,
        )
      ) {
        handleAccountChanged();
      }
      const { phase } = useModelUnlockIntentStore.getState();
      if (phase === 'waiting' || phase === 'timed-out') {
        void checkModelUnlockNow();
      }
    };
    // Sign-out and account switches. Resolved against the saved credential
    // rather than assumed from the event, which also fires for a balance
    // change on the same account. A confirmed unlock outlives its pending
    // intent, so its confirmation is reconciled even when nothing is pending.
    // The usage-limit arrival confirmation (CAN-5160) and pending credits
    // checkouts (CAN-5534) share the same guard.
    const handleAccountChanged = (): void => {
      if (
        useModelUnlockIntentStore.getState().intent === null &&
        !hasModelUnlockConfirmationSession() &&
        !hasAiCreditsArrivalSession() &&
        !hasAiCreditsHandoffs()
      ) {
        return;
      }
      const generation = ++accountReadGeneration;
      accountReadPending = true;
      suspendModelUnlockConfirmationAccount();
      suspendAiCreditsArrivalAccount();
      suspendAiCreditsHandoffAccount();
      const reconcile = (
        accountKey: string | null,
        handoffIdentity: AiCreditsHandoffAccountIdentity,
      ): void => {
        if (!active || generation !== accountReadGeneration) return;
        accountReadPending = false;
        reconcileModelUnlockIntentAccount(accountKey);
        reconcileModelUnlockConfirmationAccount(accountKey);
        if (handoffIdentity.kind !== 'unreadable') {
          reconcileAiCreditsArrivalAccount(accountKey);
        }
        // A failed read is not a sign-out for a pending checkout: the browser
        // purchase may still land, so it keeps waiting, unattributed.
        reconcileAiCreditsHandoffAccount(handoffIdentity);
        if (queuedConfirmation?.accountId === accountKey) {
          recordModelUnlockConfirmation(queuedConfirmation);
        }
        queuedConfirmation = null;
      };
      const unreadable = (): void => {
        // An unreadable account cannot be shown to still be the buyer.
        reconcile(null, { kind: 'unreadable' });
      };
      const loadAccount = window.api?.loadCanopyCloudAccount;
      if (typeof loadAccount !== 'function') {
        unreadable();
        return;
      }
      void Promise.resolve()
        .then(() => loadAccount())
        .then((account): void => {
          if (account.read !== undefined && account.read !== 'ok') {
            unreadable();
            return;
          }
          const accountKey = cloudAccountIdentityKey(account);
          reconcile(
            accountKey,
            accountKey === null
              ? { kind: 'signed-out' }
              : { kind: 'account', key: accountKey },
          );
        }, unreadable);
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      handleAccountChanged,
    );
    return (): void => {
      active = false;
      accountReadGeneration++;
      setModelUnlockConfirmedListener(null);
      unsubscribeReturn?.();
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        handleAccountChanged,
      );
    };
  }, []);

  // Owner change. The navigation context is part of every owner scope, so a
  // switch means the pending model may now belong to different work. The
  // purchase itself is unaffected; only the follow-up is dropped, and a
  // confirmation already shown stays.
  const navigationKey = useNavigationScopeKey();
  useEffect(
    () => (): void => {
      clearModelUnlockIntent();
    },
    [navigationKey],
  );
}
