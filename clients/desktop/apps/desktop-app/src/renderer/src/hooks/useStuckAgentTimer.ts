import { useLayoutEffect, useRef, useState } from 'react';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Returns the number of whole minutes since the last agent event,
 * or null if the threshold has not been reached or the tab is not streaming.
 *
 * `tabId` scopes the timer to a specific chat tab so switching between
 * streaming tabs resets the stuck-agent state immediately instead of
 * leaking the previous tab's elapsed time until the next poll tick.
 */
export function useStuckAgentTimer(
  isStreaming: boolean,
  lastEventAt: number | undefined,
  tabId: string | undefined,
): number | null {
  const [minutesSinceLastEvent, setMinutesSinceLastEvent] = useState<
    number | null
  >(null);
  const lastEventAtRef = useRef(lastEventAt);
  lastEventAtRef.current = lastEventAt;

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

  return minutesSinceLastEvent;
}
