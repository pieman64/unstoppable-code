import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 10_000; // 10 seconds

/** The confirmation answer for one quiet period of one tab. */
interface QuietPeriodConfirmation {
  key: string;
  active: boolean;
}

/**
 * Returns the number of whole minutes since the last agent event,
 * or null if the threshold has not been reached, the tab is not streaming,
 * or the quiet period has not been confirmed.
 *
 * `tabId` scopes the timer to a specific chat tab so switching between
 * streaming tabs resets the stuck-agent state immediately instead of
 * leaking the previous tab's elapsed time until the next poll tick.
 *
 * Once a quiet period reaches the threshold, `confirmQuietPeriod` runs once
 * for it (an awaited read of canonical runtime). The warning shows only if it
 * answers true; false or a rejection keeps it hidden until a new agent event
 * starts another quiet period, which confirms again.
 */
export function useStuckAgentTimer(
  isStreaming: boolean,
  lastEventAt: number | undefined,
  tabId: string | undefined,
  confirmQuietPeriod: () => Promise<boolean>,
): number | null {
  const [minutesSinceLastEvent, setMinutesSinceLastEvent] = useState<
    number | null
  >(null);
  const [confirmation, setConfirmation] =
    useState<QuietPeriodConfirmation | null>(null);
  const lastEventAtRef = useRef(lastEventAt);
  lastEventAtRef.current = lastEventAt;
  const confirmQuietPeriodRef = useRef(confirmQuietPeriod);
  confirmQuietPeriodRef.current = confirmQuietPeriod;

  const quietPeriodKey =
    isStreaming && lastEventAt != null
      ? `${tabId ?? ''}\u0000${String(lastEventAt)}`
      : null;
  const needsConfirmation =
    quietPeriodKey !== null &&
    minutesSinceLastEvent !== null &&
    confirmation?.key !== quietPeriodKey;

  // A turn that stops qualifying forgets its answer, so qualifying again
  // reads canonical runtime afresh.
  useLayoutEffect(() => {
    if (quietPeriodKey === null) setConfirmation(null);
  }, [quietPeriodKey]);

  useEffect(() => {
    if (!needsConfirmation || quietPeriodKey === null) return;
    let current = true;
    void confirmQuietPeriodRef
      .current()
      .catch(() => false)
      .then((active) => {
        if (current) setConfirmation({ key: quietPeriodKey, active });
      });
    return (): void => {
      current = false;
    };
  }, [needsConfirmation, quietPeriodKey]);

  // Agent events can arrive much more frequently than the polling interval.
  // Re-evaluate synchronously so a warning from the previous quiet period does
  // not linger for up to ten seconds after the agent visibly responds.
  useLayoutEffect(() => {
    if (!isStreaming || lastEventAt == null) {
      setMinutesSinceLastEvent(null);
      return;
    }

    const elapsed = Date.now() - lastEventAt;
    setMinutesSinceLastEvent(
      elapsed >= STUCK_THRESHOLD_MS ? Math.floor(elapsed / 60_000) : null,
    );
  }, [isStreaming, lastEventAt, tabId]);

  useLayoutEffect(() => {
    if (!isStreaming || lastEventAt == null) {
      setMinutesSinceLastEvent(null);
      return;
    }

    const check = (): void => {
      const ts = lastEventAtRef.current;
      if (ts == null) {
        setMinutesSinceLastEvent(null);
        return;
      }
      const elapsed = Date.now() - ts;
      setMinutesSinceLastEvent(
        elapsed >= STUCK_THRESHOLD_MS ? Math.floor(elapsed / 60_000) : null,
      );
    };

    let id: number | undefined;

    const startPolling = (): void => {
      check();
      if (id == null) {
        id = window.setInterval(check, POLL_INTERVAL_MS);
      }
    };

    const stopPolling = (): void => {
      if (id != null) {
        window.clearInterval(id);
        id = undefined;
      }
    };

    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === 'visible') {
      startPolling();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, tabId]); // lastEventAt intentionally read via ref; tabId resets on tab switch

  if (confirmation === null || !confirmation.active) return null;
  if (confirmation.key === quietPeriodKey) return minutesSinceLastEvent;
  // A runtime write can move `lastEventAt` while the tab stays quiet past the
  // threshold. Keep the confirmed warning (and its notice's checked state)
  // while the newer period of the same tab confirms; its answer decides next.
  return needsConfirmation &&
    confirmation.key.startsWith(`${tabId ?? ''}\u0000`)
    ? minutesSinceLastEvent
    : null;
}
