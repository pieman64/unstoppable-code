import { BrowserWindow, type WebContents, type WebFrameMain } from 'electron';
import { sendToWebContents } from './web-contents-send';

type SendableWebFrameMain = Pick<WebFrameMain, 'detached' | 'isDestroyed'>;

interface SendableWebContents extends Pick<
  WebContents,
  'isCrashed' | 'isDestroyed' | 'send'
> {
  mainFrame: SendableWebFrameMain;
}

export interface SendableBrowserWindow {
  isDestroyed(): boolean;
  webContents: SendableWebContents;
}

export type WindowSendFailureReason =
  | 'no_window'
  | 'window_destroyed'
  | 'webcontents_destroyed'
  | 'webcontents_crashed'
  | 'frame_destroyed'
  | 'frame_detached'
  | 'render_frame_disposed';

export type WindowSendResult =
  | { delivered: true }
  | { delivered: false; reason: WindowSendFailureReason };

// The 'Render frame was disposed' message is confirmed in Electron 28–40.
// If a future Electron upgrade changes this string the error will be rethrown
// instead of silently swallowed — monitor for unexpected main-process crashes
// after major Electron bumps.
function isRendererUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Render frame was disposed')
  );
}

function getSendFailureReason(
  window: SendableBrowserWindow | null,
): WindowSendFailureReason | null {
  if (!window) {
    return 'no_window';
  }

  if (window.isDestroyed()) {
    return 'window_destroyed';
  }

  const { webContents } = window;
  if (webContents.isDestroyed()) {
    return 'webcontents_destroyed';
  }
  if (webContents.isCrashed()) {
    return 'webcontents_crashed';
  }

  const { mainFrame } = webContents;
  if (mainFrame.isDestroyed()) {
    return 'frame_destroyed';
  }
  if (mainFrame.detached) {
    return 'frame_detached';
  }

  return null;
}

type MissingWindowSendObserver = (
  channel: string,
  args: readonly unknown[],
) => void;

const missingWindowSendObservers: MissingWindowSendObserver[] = [];

/**
 * Observes sends addressed to a window that is not there (null or
 * destroyed). Device remote control uses it to keep forwarding main-window
 * events to a controller while this computer's app window is closed.
 */
export function observeMissingWindowSends(
  observer: MissingWindowSendObserver,
): () => void {
  missingWindowSendObservers.push(observer);
  return (): void => {
    const index = missingWindowSendObservers.indexOf(observer);
    if (index >= 0) missingWindowSendObservers.splice(index, 1);
  };
}

function notifyMissingWindowSend(
  channel: string,
  args: readonly unknown[],
): void {
  for (const observer of missingWindowSendObservers.slice()) {
    try {
      observer(channel, args);
    } catch {
      // An observer cannot fail the send it watched.
    }
  }
}

export function sendToWindowDetailed(
  window: SendableBrowserWindow | null,
  channel: string,
  ...args: unknown[]
): WindowSendResult {
  const failureReason = getSendFailureReason(window);
  if (failureReason) {
    if (failureReason === 'no_window' || failureReason === 'window_destroyed') {
      notifyMissingWindowSend(channel, args);
    }
    return { delivered: false, reason: failureReason };
  }

  if (window === null) {
    throw new Error(
      'Expected a non-null window after sendability checks succeeded',
    );
  }

  try {
    sendToWebContents(window.webContents, channel, ...args);
    return { delivered: true };
  } catch (error) {
    if (isRendererUnavailableError(error)) {
      return { delivered: false, reason: 'render_frame_disposed' };
    }
    throw error;
  }
}

export function sendToWindow(
  window: SendableBrowserWindow | null,
  channel: string,
  ...args: unknown[]
): boolean {
  return sendToWindowDetailed(window, channel, ...args).delivered;
}

/**
 * Broadcast a target-keyed renderer event to every live Electron window.
 * Consumers are responsible for filtering by identifiers in the payload.
 */
export function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, channel, ...args);
  }
}
