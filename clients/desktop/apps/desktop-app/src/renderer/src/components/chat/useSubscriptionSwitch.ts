import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { NativeAccountProvider } from '@canopy/desktop-shared/types';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import type { SubscriptionSwitchOutcome } from './AiCreditsRoutingStatusBanner';

interface UseSubscriptionSwitchInput {
  /** The composer's chat. */
  target: ChatBannerTarget | null;
  /** The provider the chat bills, when it is a native-account provider. */
  provider: NativeAccountProvider | undefined;
  /** Effective billing framework from the shared resolver. */
  framework: 'subscription' | 'ai-credits' | null;
  /** True while a turn runs; a new turn retires the availability notice. */
  turnActive: boolean;
  /** The existing per-chat subscription transition. */
  selectSubscription: (target: ChatBannerTarget) => void;
  /** Focus the composer, if it is still showing. */
  focusComposer: () => void;
}

interface UseSubscriptionSwitchResult {
  /** Stable handler for the routing card's switch. */
  switchToSubscription: (outcome: SubscriptionSwitchOutcome) => void;
  /** The provider whose limit could not be confirmed, while its notice shows. */
  availabilityNoticeProvider: NativeAccountProvider | null;
  dismissAvailabilityNotice: () => void;
}

interface PendingSwitch {
  targetKey: string;
  outcome: SubscriptionSwitchOutcome;
}

/**
 * Carries an accepted "Switch to subscription" through to its outcome
 * (CAN-4759). The billing transition is optimistic, so the outcome follows the
 * effective framework: once this chat resolves to the subscription, a confirmed
 * limit is restored as the usage-limit banner (clearing its dismissal), an
 * unconfirmed one shows a smaller availability notice, and the composer takes
 * focus. A switch that does not take effect, or whose chat changes first,
 * restores nothing.
 */
export function useSubscriptionSwitch({
  target,
  provider,
  framework,
  turnActive,
  selectSubscription,
  focusComposer,
}: UseSubscriptionSwitchInput): UseSubscriptionSwitchResult {
  const restoreUsageLimit = useAiCreditsBannerStore(
    (state) => state.restoreUsageLimit,
  );
  const targetKey = target ? chatBannerKey(target) : null;
  const latestRef = useRef({ target, targetKey, provider, framework });
  latestRef.current = { target, targetKey, provider, framework };
  const focusComposerRef = useRef(focusComposer);
  focusComposerRef.current = focusComposer;

  // Held in state so the outcome effect runs in the same commit as the
  // billing change; mirrored in a ref so a second accept in the same event is
  // ignored.
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const pendingRef = useRef<PendingSwitch | null>(null);
  const [notice, setNotice] = useState<{
    targetKey: string;
    provider: NativeAccountProvider;
  } | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  const switchToSubscription = useCallback(
    (outcome: SubscriptionSwitchOutcome): void => {
      const current = latestRef.current;
      if (
        !current.target ||
        !current.targetKey ||
        pendingRef.current ||
        outcome.targetKey !== current.targetKey ||
        current.framework !== 'ai-credits'
      )
        return;
      // The card resets on a provider change, but a stale outcome must still
      // never restore another provider's limit.
      if (outcome.provider !== current.provider) return;
      if (
        outcome.kind === 'limited' &&
        (!Number.isFinite(new Date(outcome.resetAt).getTime()) ||
          outcome.resetAt <= Date.now())
      )
        return;
      const next = { targetKey: current.targetKey, outcome };
      pendingRef.current = next;
      setPending(next);
      setNotice(null);
      try {
        selectSubscription(current.target);
      } catch {
        // A rejected optimistic action must leave the credits card retryable.
        pendingRef.current = null;
        setPending(null);
      }
    },
    [selectSubscription],
  );

  // Layout effect so a restored warning paints with the switch, not a frame
  // after the card disappears.
  useLayoutEffect(() => {
    if (!pending) return;
    pendingRef.current = null;
    setPending(null);
    if (
      !target ||
      pending.targetKey !== targetKey ||
      pending.outcome.provider !== provider ||
      framework !== 'subscription'
    ) {
      return;
    }
    const { outcome } = pending;
    if (outcome.kind === 'limited') {
      if (outcome.resetAt <= Date.now()) return;
      restoreUsageLimit(target, {
        provider: outcome.provider,
        resetsAt: outcome.resetAt,
      });
    } else if (outcome.kind === 'unknown') {
      setNotice({ targetKey: pending.targetKey, provider: outcome.provider });
    }
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current);
    }
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (
        latestRef.current.targetKey === pending.targetKey &&
        latestRef.current.provider === outcome.provider &&
        latestRef.current.framework === 'subscription'
      ) {
        focusComposerRef.current();
      }
    });
  }, [framework, pending, provider, restoreUsageLimit, target, targetKey]);

  // A scheduled focus never outlives its chat or the composer.
  useEffect(
    () => (): void => {
      if (focusFrameRef.current !== null) {
        cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
    },
    [targetKey, provider],
  );

  useEffect(() => {
    if (turnActive) setNotice(null);
  }, [turnActive]);

  const dismissAvailabilityNotice = useCallback((): void => {
    setNotice(null);
  }, []);

  return {
    switchToSubscription,
    availabilityNoticeProvider:
      notice !== null &&
      notice.targetKey === targetKey &&
      notice.provider === provider &&
      framework === 'subscription'
        ? notice.provider
        : null,
    dismissAvailabilityNotice,
  };
}
