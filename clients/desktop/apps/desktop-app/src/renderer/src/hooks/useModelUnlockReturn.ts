import { useEffect } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import { MODEL_LIBRARY_UNLOCK_COPY } from '@canopy/ui-shared/components';
import { useNavigationScopeKey } from '@/lib/aiCreditsScope';
import { ensureModelLibraryAccessSubscribed } from '@/lib/modelLibraryAccess';
import {
  checkModelUnlockNow,
  clearModelUnlockIntent,
  handleBillingReturnLink,
  reconcileModelUnlockIntentAccount,
  runModelUnlockPolling,
  setModelUnlockConfirmedListener,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { useGitHubStore } from '@/stores/githubStore';

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
    ensureModelLibraryAccessSubscribed();
    setModelUnlockConfirmedListener((): void => {
      useGitHubStore
        .getState()
        .addToast(MODEL_LIBRARY_UNLOCK_COPY.confirmed, 'success');
    });
    const unsubscribeReturn = window.api?.onDeepLinkBillingUnlocked?.(
      handleBillingReturnLink,
    );
    // Coming back to the window is the usual way a purchase ends, with or
    // without a return link. Only worth a read while something is pending.
    const handleFocus = (): void => {
      const { phase } = useModelUnlockIntentStore.getState();
      if (phase === 'waiting' || phase === 'timed-out') {
        void checkModelUnlockNow();
      }
    };
    // Sign-out and account switches. Resolved against the saved credential
    // rather than assumed from the event, which also fires for a balance
    // change on the same account.
    const handleAccountChanged = (): void => {
      if (useModelUnlockIntentStore.getState().intent === null) return;
      const loadAccount = window.api?.loadCanopyCloudAccount;
      if (typeof loadAccount !== 'function') return;
      void loadAccount().then(
        (account): void => {
          reconcileModelUnlockIntentAccount(cloudAccountIdentityKey(account));
        },
        (): void => {
          // An unreadable account cannot be shown to still be the buyer.
          reconcileModelUnlockIntentAccount(null);
        },
      );
    };
    window.addEventListener('focus', handleFocus);
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      handleAccountChanged,
    );
    return (): void => {
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
  // purchase itself is unaffected; only the follow-up is dropped.
  const navigationKey = useNavigationScopeKey();
  useEffect(
    () => (): void => {
      clearModelUnlockIntent();
    },
    [navigationKey],
  );
}
