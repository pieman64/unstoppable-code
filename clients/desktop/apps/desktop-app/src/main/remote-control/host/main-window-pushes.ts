import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { observeWebContentsSends } from '../../lib/web-contents-send';
import { observeMissingWindowSends } from '../../lib/window-send';

/**
 * Observes what main sends to this computer's app window so remote sessions
 * see main-window-only events (for example the streaming chat events of a
 * turn started here). It watches only while a session listens, and sees
 * each message as main published it, before any per-page encoding.
 */
export interface MainWindowPushSource {
  subscribe(
    listener: (channel: string, args: ReadonlyArray<unknown>) => void,
  ): () => void;
}

/**
 * Channels main addresses to each subscribed page separately. Bridge windows
 * are among those pages (`ipc/index.ts`) and declare their controller's
 * subscriptions, so the app window's copy, cut to that window's own, is not
 * mirrored.
 */
const PER_PAGE_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.chatStateChanged,
]);

/**
 * Channels main addresses to one App Advisor window. A copy meant for this
 * computer's own window must not run in the controller's too; main reaches
 * the controller's windows through its bridges instead.
 */
const ADDRESSED_CHANNELS: ReadonlySet<string> = new Set([
  IPC_CHANNELS.appAdvisorToolRequest,
  IPC_CHANNELS.appAdvisorToolRequestCancelled,
  IPC_CHANNELS.appAdvisorWindowCommand,
  IPC_CHANNELS.appAdvisorWindowStateChanged,
  IPC_CHANNELS.appAdvisorWindowUiStateChanged,
]);

function isMirrored(channel: string): boolean {
  return !PER_PAGE_CHANNELS.has(channel) && !ADDRESSED_CHANNELS.has(channel);
}

export function createMainWindowPushSource(
  getMainWebContents: () => object | null,
): MainWindowPushSource {
  const listeners = new Set<
    (channel: string, args: ReadonlyArray<unknown>) => void
  >();
  let stopObserving: (() => void) | null = null;

  const observe = (
    target: object,
    channel: string,
    args: readonly unknown[],
  ): void => {
    if (!isMirrored(channel) || target !== getMainWebContents()) {
      return;
    }
    for (const listener of Array.from(listeners)) listener(channel, args);
  };

  // While the app window is closed (macOS keeps the app running), main's
  // sends to it fail before any page sees them; the controller still needs
  // them. Sends to a missing window while the app window is open were meant
  // for another window and are not mirrored.
  const observeMissing = (channel: string, args: readonly unknown[]): void => {
    if (!isMirrored(channel) || getMainWebContents() !== null) return;
    for (const listener of Array.from(listeners)) listener(channel, args);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (stopObserving === null) {
        const stopSends = observeWebContentsSends(observe);
        const stopMissing = observeMissingWindowSends(observeMissing);
        stopObserving = (): void => {
          stopSends();
          stopMissing();
        };
      }
      return (): void => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopObserving !== null) {
          stopObserving();
          stopObserving = null;
        }
      };
    },
  };
}
