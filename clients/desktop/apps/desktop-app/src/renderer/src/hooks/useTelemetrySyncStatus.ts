import { useEffect, useState } from 'react';
import type { TelemetrySyncStatus } from '@canopy/desktop-shared/types';

/**
 * Subscribe to the main-process `TelemetrySyncService` status bridge.
 *
 * Returns the latest {@link TelemetrySyncStatus} snapshot (null until the first
 * load resolves). The status event only fires on state changes, so a lightweight
 * ~30s ticker is also run to keep any rendered relative-time label
 * (e.g. "Synced 5m ago") fresh between events.
 */
export function useTelemetrySyncStatus(): TelemetrySyncStatus | null {
  const [status, setStatus] = useState<TelemetrySyncStatus | null>(null);
  // Bumped on an interval so consumers re-render and refresh relative-time
  // labels even when no new status event has arrived.
  const [, setTick] = useState(0);

  useEffect(() => {
    let active = true;

    void window.api.telemetrySync.getStatus().then((initial) => {
      if (active) {
        // The initial load resolves asynchronously while `onStatusEvent` is
        // registered synchronously below. If a live status event arrives before
        // this initial snapshot resolves, its newer value must not be clobbered
        // by the older initial snapshot, so only seed when nothing is set yet.
        setStatus((current) => current ?? initial);
      }
    });

    const unsubscribe = window.api.telemetrySync.onStatusEvent((next) => {
      setStatus(next);
    });

    const interval = window.setInterval(() => {
      setTick((prev) => prev + 1);
    }, 30_000);

    return (): void => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, []);

  return status;
}
