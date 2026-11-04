import type { InitiatedWorkClientPresence } from '@canopy/core-runtime/node/initiated-work';
import { app, type BrowserWindow } from 'electron';

/**
 * A desktop client is connected while its window is open. Hook runs that
 * defer without a client (CAN-4145) wait on this.
 */
export function hookClientPresence(
  getWindow: () => BrowserWindow | null,
): InitiatedWorkClientPresence {
  const attached = (): boolean => {
    const window = getWindow();
    return window !== null && !window.isDestroyed();
  };
  return {
    attached,
    whenAttached: (signal) =>
      new Promise<void>((resolve) => {
        const stop = (): void => {
          app.removeListener('browser-window-created', onCreated);
          signal.removeEventListener('abort', stop);
          resolve();
        };
        // The event fires inside the window's constructor, before the
        // caller stores it; check once that turn has finished.
        const onCreated = (): void => {
          queueMicrotask(() => {
            if (attached()) stop();
          });
        };
        if (attached() || signal.aborted) {
          resolve();
          return;
        }
        app.on('browser-window-created', onCreated);
        signal.addEventListener('abort', stop, { once: true });
      }),
  };
}
