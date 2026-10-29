// Timestamps capture arrivals by polling the received-item counter. The
// capture recorder keeps no wall-clock times, so this is the only arrival
// evidence; resolution is the polling interval.
import { performance } from 'node:perf_hooks';

/**
 * @param {{ snapshot: () => { counts: { received: number } } }} capture
 * @param {{ intervalMs?: number, now?: () => number }} [options]
 */
export function startArrivalPoller(
  capture,
  { intervalMs = 25, now = () => performance.now() } = {},
) {
  let seen = capture.snapshot().counts.received;
  const arrivals = [];
  const tick = () => {
    const received = capture.snapshot().counts.received;
    const at = now();
    while (seen < received) {
      seen += 1;
      arrivals.push({ index: arrivals.length + 1, atMs: at });
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    /** Arrival times in received order (index 1 = first item of this window). */
    arrivals: () => arrivals.map((entry) => ({ ...entry })),
    flush: tick,
    stop() {
      clearInterval(timer);
      tick();
    },
    resolutionMs: intervalMs,
  };
}
