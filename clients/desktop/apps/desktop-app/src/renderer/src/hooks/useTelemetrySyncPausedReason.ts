import { useEffect, useState } from 'react';
import type { TelemetrySyncPausedReason } from '@canopy/desktop-shared/types';

/**
 * Why telemetry sync is paused, or null (CAN-3512).
 *
 * A lean sibling of `useTelemetrySyncStatus` for always-mounted chrome such as
 * the sidebar account menu: it keeps only the reason, so the frequent status
 * events (pending count, syncing) re-render nothing unless the reason changes,
 * and it runs no relative-time ticker.
 */
export function useTelemetrySyncPausedReason(): TelemetrySyncPausedReason | null {
  const [reason, setReason] = useState<TelemetrySyncPausedReason | null>(null);

  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = window.api.telemetrySync.onStatusEvent((status) => {
      received = true;
      setReason(status.pausedReason ?? null);
    });
    void window.api.telemetrySync
      .getStatus()
      .then((initial) => {
        // A live event that landed first is newer than this snapshot.
        if (active && !received) setReason(initial.pausedReason ?? null);
      })
      .catch(() => undefined);
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, []);

  return reason;
}
