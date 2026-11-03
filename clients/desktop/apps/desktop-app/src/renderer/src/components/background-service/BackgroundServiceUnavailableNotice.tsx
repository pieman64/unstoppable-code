import { useCallback, useEffect, useState, type JSX } from 'react';
import { BackgroundServiceNotice } from '@canopy/ui-shared/components';
import type {
  BackgroundServiceApi,
  BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

function getApi(): BackgroundServiceApi | undefined {
  return typeof window !== 'undefined'
    ? window.api?.backgroundService
    : undefined;
}

/**
 * Persistent notice while this computer's background service can't be
 * reached, with Try again (CAN-5541). Mounted in the in-app notification
 * column; it renders nothing, and never calls the blocked channels, in a
 * window that shows another computer.
 */
export function BackgroundServiceUnavailableNotice(): JSX.Element | null {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const [status, setStatus] = useState<BackgroundServiceStatus | null>(null);

  // Pushes, the first read and retry answers can land in any order.
  const accept = useCallback((next: BackgroundServiceStatus): void => {
    setStatus((previous) =>
      previous && previous.sequence >= next.sequence ? previous : next,
    );
  }, []);

  useEffect(() => {
    const api = local ? getApi() : undefined;
    if (!api) return undefined;
    const unsubscribe = api.onStatusChanged(accept);
    // Off the critical path: the notice is never needed for first paint.
    api.getStatus().then(accept, () => undefined);
    return unsubscribe;
  }, [local, accept]);

  if (!local || status?.state !== 'unavailable') return null;
  return (
    <BackgroundServiceNotice
      retry={status.retry}
      onRetry={(): void => {
        getApi()
          ?.retry()
          .then(accept, () => undefined);
      }}
    />
  );
}
