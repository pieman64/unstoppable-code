import type { JSX } from 'react';
import { Notice, RetryCountdown } from '@canopy/ui-shared';
import type { ChatBannerTarget } from '@/stores/aiCreditsBannerStore';
import {
  useTransientRetryBannerStore,
  useTransientRetryState,
} from '@/stores/transientRetryBannerStore';

interface TransientRetryBannerProps {
  /**
   * The chat this banner belongs to. Works on every surface because retry state
   * is keyed by target and fed centrally from the main process. Pass `null` to
   * render nothing.
   */
  target: ChatBannerTarget | null;
}

/**
 * Shared transient-retry banner. Rendered once in the universal `ChatInput`, it
 * surfaces on every chat surface, driven by the target-keyed retry store which
 * the main process feeds authoritatively over the chat-event pipeline.
 *
 * The banner is a pure view of pushed state — the attempt count, cap, and next
 * retry time all come straight from the event payload. While a retry is
 * scheduled it counts down once a second to `nextRetryAt`; when the countdown
 * reaches zero the main-process timer is dispatching the retry, so the copy
 * flips to "Retrying now" until the outcome event re-arms or clears the cycle.
 * Once the cycle is exhausted it stays put with the give-up copy and no
 * countdown. Dismissing it stops the backend retry cycle (not just hides it) and
 * clears the local state immediately.
 */
export function TransientRetryBanner({
  target,
}: TransientRetryBannerProps): JSX.Element | null {
  const state = useTransientRetryState(target);
  const clearForChat = useTransientRetryBannerStore((s) => s.clearForChat);

  if (!target || !state) return null;

  const dismiss = (): void => {
    // Fire-and-forget: dismissing stops the backend retry cycle. Clearing local
    // state hides the banner immediately without waiting for the round-trip.
    void window.api.chat.cancelTransientRetry(target);
    clearForChat(target);
  };

  return (
    <Notice
      intent="attention"
      title="Temporary provider error"
      data-testid="chat-input-transient-retry-banner"
      onDismiss={dismiss}
      dismissLabel="Dismiss transient retry notice"
      dismissTestId="chat-input-transient-retry-dismiss"
    >
      <RetryCountdown {...state} />
    </Notice>
  );
}
