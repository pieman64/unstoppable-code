import type { ApprovalDeliveryPresence } from '@canopy/core-runtime/node/agent/approvals';
import { app } from 'electron';
import type { SendableBrowserWindow } from './window-send';

interface DestroyedEvents {
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

function hasDestroyedEvents(
  contents: object,
): contents is object & DestroyedEvents {
  return (
    'once' in contents &&
    typeof contents.once === 'function' &&
    'removeListener' in contents &&
    typeof contents.removeListener === 'function'
  );
}

/**
 * The window that shows one approval, as a delivery target (CAN-4129).
 * Attached while the window and its renderer exist. Decides only where and
 * when a card is shown; the chat wait lifecycle's presence decides no-client.
 */
export function windowClientPresence(
  getWindow: () => SendableBrowserWindow | null,
): ApprovalDeliveryPresence {
  const attached = (): boolean => {
    const window = getWindow();
    return (
      window !== null &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed()
    );
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
    whenDetached: (signal) =>
      new Promise<void>((resolve) => {
        const window = getWindow();
        if (window === null || !attached() || signal.aborted) {
          resolve();
          return;
        }
        const contents = window.webContents;
        if (!hasDestroyedEvents(contents)) {
          signal.addEventListener('abort', () => resolve(), { once: true });
          return;
        }
        const done = (): void => {
          contents.removeListener('destroyed', done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        contents.once('destroyed', done);
        signal.addEventListener('abort', done, { once: true });
      }),
  };
}
