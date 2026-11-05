import { useCallback, useEffect, useMemo, useState } from 'react';
import { notificationOfferCardProps } from '@canopy/ui-shared/components';
import {
  useSuggestionCornerOffer,
  type SuggestionCornerModel,
} from '@canopy/ui-app/suggestions';
import { brandText } from '@/lib/brand';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  answerOsNotificationOffer,
  type OsNotificationOfferAnswerResult,
  type OsNotificationOfferChoice,
  useOsNotificationOfferStore,
} from '@/lib/osNotificationOffer';
import { refreshOsNotificationPrefs } from '@/lib/osNotifications';
import { useGitHubStore } from '@/stores/githubStore';

function isDocumentFocused(): boolean {
  return typeof document.hasFocus === 'function' && document.hasFocus();
}

/**
 * Follow-up for an opt-in after the answer is saved. A refusal by the OS gets
 * one in-app warning with a way to fix it; it never raises a native banner and
 * carries no completion marker, so it cannot re-arm the offer. Unsupported and
 * error results stay quiet, as the opt-in always has.
 */
async function finishOptIn(
  result: OsNotificationOfferAnswerResult,
): Promise<void> {
  const addToast = useGitHubStore.getState().addToast;
  if (result.kind === 'opt-in-failed') {
    addToast(
      'Couldn’t turn on notifications. You can turn them on in Settings → Notifications.',
      'error',
      undefined,
      { forceInApp: true, suppressOsNotification: true },
    );
    return;
  }
  if (result.kind !== 'enabled') return;
  if (result.optIn.enabled) {
    try {
      const preferences = await window.api.loadPreferences();
      refreshOsNotificationPrefs(preferences.osNotifications);
    } catch {
      // The next preference load refreshes the cache.
    }
  }
  if (result.optIn.reason === 'os-denied') {
    addToast(
      `Your system is blocking notifications from ${brandText.appName}. Allow them in system settings.`,
      'warning',
      undefined,
      {
        title: 'Notifications are blocked',
        forceInApp: true,
        suppressOsNotification: true,
        persistent: true,
        action: {
          label: 'Open settings',
          onClick: (): void => {
            void window.api.openOsNotificationSettings();
          },
        },
      },
    );
  }
}

/**
 * Desktop producer for the one-time notification offer (CAN-4005, CAN-4343).
 * Offers the pending offer to the shared suggestion corner. While the window
 * is blurred the claim keeps its slot but the card is not presentable, so
 * nothing renders or spends the corner cap; refocusing shows it again. A
 * refused claim keeps the unanswered offer and asks again on the next focus.
 */
export function OsNotificationOfferProducer(): null {
  const pending = useOsNotificationOfferStore((state) => state.pending);
  const answering = useOsNotificationOfferStore((state) => state.answering);
  const saveFailed = useOsNotificationOfferStore((state) => state.saveFailed);
  const answerChoice = useOsNotificationOfferStore(
    (state) => state.answerChoice,
  );
  const [focused, setFocused] = useState(isDocumentFocused);
  const [focusCount, setFocusCount] = useState(0);

  useEffect(() => {
    const onFocus = (): void => {
      setFocused(true);
      setFocusCount((count) => count + 1);
    };
    const onBlur = (): void => {
      setFocused(false);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    // A focus change between the first render and subscribing is not missed.
    setFocused(isDocumentFocused());
    return (): void => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const answer = useCallback((choice: OsNotificationOfferChoice): void => {
    void answerOsNotificationOffer(choice).then(finishOptIn);
  }, []);

  const model = useMemo(
    (): SuggestionCornerModel | null =>
      pending
        ? {
            suggestionId: 'os-notification-offer',
            retainWhenHidden: true,
            presentable: focused,
            // Its two answers are final: no Don't show again.
            card: notificationOfferCardProps({
              busyAction: answering,
              saveFailed,
              retryAction: saveFailed ? answerChoice : null,
              onEnable: () => {
                answer('enable');
              },
              onDismiss: () => {
                answer('dismiss');
              },
              testId: 'os-notification-offer',
            }),
          }
        : null,
    [pending, focused, answering, saveFailed, answerChoice, answer],
  );
  const claim = useSuggestionCornerOffer(
    'os-notification-offer',
    model,
    focusCount,
  );

  useCurrentUiStateReporter(
    'osNotificationOffer.banner',
    pending && focused && claim.status === 'active' ? { open: true } : null,
  );
  return null;
}
