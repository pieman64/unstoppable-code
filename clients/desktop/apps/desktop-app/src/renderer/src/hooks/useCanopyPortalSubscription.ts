import { useEffect } from 'react';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';

/**
 * Subscribes the renderer to push updates from the main-process portal
 * worker.
 *
 * - Registers an `onStateChanged` listener that mirrors every broadcast into
 *   `useCanopyPortalStore`.
 * - Performs an initial `getState()` fetch on mount so the store reflects the
 *   current main-process state even when no subsequent broadcast happens.
 * - Disposes the listener on unmount via the `onStateChanged` disposer
 *   returned by the preload bridge.
 *
 * The hook is safe to mount in `App.tsx` (or any always-mounted root): the
 * preload bridge guarantees disposers are stable, so React Strict Mode
 * remounts produce at most one active IPC listener.
 */
export function useCanopyPortalSubscription(): void {
  const hydrate = useCanopyPortalStore((s) => s.hydrate);
  const setState = useCanopyPortalStore((s) => s.setState);

  useEffect(() => {
    let disposed = false;

    void hydrate();

    const dispose = window.api.canopyPortal.onStateChanged((next) => {
      if (disposed) {
        return;
      }
      setState(next);
    });

    return (): void => {
      disposed = true;
      dispose();
    };
  }, [hydrate, setState]);
}
