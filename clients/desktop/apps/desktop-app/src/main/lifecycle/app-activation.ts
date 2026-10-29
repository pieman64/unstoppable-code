// Which window a Dock click (macOS `activate`) or the tray's open action
// brings forward (CAN-4247). The main window and the windows showing a paired
// computer are peers: with the main window closed, an open remote window is
// focused instead of recreating the main window. The rules are pure so
// `main/index.ts` only binds them to process state.

/** The slice of `BrowserWindow` the activation rules need. */
export interface ActivationWindow {
  isDestroyed(): boolean;
}

export type AppActivationTarget<TWindow> =
  | { kind: 'focus'; window: TWindow }
  | { kind: 'recreate-main' };

export interface AppActivationWindows<TWindow> {
  mainWindow: TWindow | null;
  /** Windows showing a paired computer, oldest first. */
  remoteWindows: readonly TWindow[];
  /** Larger is more recent; undefined when the window never had focus. */
  lastFocusedAt: (window: TWindow) => number | undefined;
}

function isLive<TWindow extends ActivationWindow>(
  window: TWindow | null,
): window is TWindow {
  return window !== null && !window.isDestroyed();
}

/**
 * Focus the most recently focused open window. Without focus history, prefer
 * the main window, then the newest remote window; with no open window,
 * recreate the main window.
 */
export function resolveAppActivationTarget<TWindow extends ActivationWindow>(
  windows: AppActivationWindows<TWindow>,
): AppActivationTarget<TWindow> {
  const remoteWindows = windows.remoteWindows.filter(isLive);
  const candidates = isLive(windows.mainWindow)
    ? [windows.mainWindow, ...remoteWindows]
    : remoteWindows;
  if (candidates.length === 0) return { kind: 'recreate-main' };

  let target: TWindow | null = null;
  let targetFocusedAt = 0;
  for (const window of candidates) {
    const focusedAt = windows.lastFocusedAt(window);
    if (focusedAt !== undefined && focusedAt > targetFocusedAt) {
      target = window;
      targetFocusedAt = focusedAt;
    }
  }
  if (target !== null) return { kind: 'focus', window: target };
  if (isLive(windows.mainWindow)) {
    return { kind: 'focus', window: windows.mainWindow };
  }
  return { kind: 'focus', window: candidates[candidates.length - 1] };
}

/**
 * The tray's open action always brings back a live main window: on Windows,
 * closing it to the tray only hides it, and the tray is the way back to it.
 */
export function resolveTrayOpenTarget<TWindow extends ActivationWindow>(
  windows: AppActivationWindows<TWindow>,
): AppActivationTarget<TWindow> {
  if (isLive(windows.mainWindow)) {
    return { kind: 'focus', window: windows.mainWindow };
  }
  return resolveAppActivationTarget(windows);
}
