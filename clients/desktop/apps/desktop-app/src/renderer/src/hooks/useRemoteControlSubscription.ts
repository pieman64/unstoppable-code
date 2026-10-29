import { useEffect } from 'react';
import {
  getRemoteControlApi,
  useRemoteControlStore,
} from '@/stores/remoteControlStore';

/**
 * Mirrors main's remote access state into `useRemoteControlStore`: an
 * initial `getState()` fetch plus every pushed `onStateChanged` snapshot.
 * Mount once in an always-mounted root (`App.tsx`). Windows without the
 * bridge keep the store's signed-out default, which hides every surface.
 */
export function useRemoteControlSubscription(): void {
  const hydrate = useRemoteControlStore((s) => s.hydrate);
  const setState = useRemoteControlStore((s) => s.setState);

  useEffect(() => {
    const api = getRemoteControlApi();
    if (!api) return undefined;
    let disposed = false;

    void hydrate();

    const dispose = api.onStateChanged((next) => {
      if (disposed) return;
      setState(next);
    });

    return (): void => {
      disposed = true;
      dispose();
    };
  }, [hydrate, setState]);
}
