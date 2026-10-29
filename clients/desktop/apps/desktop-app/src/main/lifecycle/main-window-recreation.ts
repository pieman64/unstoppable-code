// Main-window recreation and focus-after-create (CAN-1963). macOS keeps the
// app alive with no window, or with only a paired computer's window open, so
// the OS focus shortcut, Dock activation, the tray, and a remote window's
// switch back to this computer all need "make sure a main window exists, then
// bring it forward".
// `mainWindow` stays null for the whole preferences read, so two requests in
// quick succession (a held global hotkey auto-repeats; a Dock click can race a
// tray click) would otherwise both create a window and orphan the first. The
// creation is single-flight and the focus rules are pure so `main/index.ts`
// only binds them to process state.

import { singleFlight } from '../lib/single-flight';

/** The slice of `BrowserWindow` the recreation logic needs. */
export interface RecreatableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  once(event: 'ready-to-show', listener: () => void): unknown;
}

export interface MainWindowRecreationDeps<TPreferences> {
  getMainWindow: () => RecreatableWindow | null;
  readPreferences: () => Promise<TPreferences>;
  /** Create the window from saved preferences; must set the main window. */
  createWindow: (preferences: TPreferences) => void;
  /** Bring the live main window to the front (`steal` semantics are the caller's). */
  focusMainWindow: () => void;
  /** False when a build must record the trigger without showing anything. */
  shouldHandleTrigger: () => boolean;
  onRecreationFailure: (error: unknown) => void;
}

export interface MainWindowRecreation {
  /** Ensure a live main window exists; concurrent callers share one creation. */
  ensureMainWindow: () => Promise<void>;
  /**
   * Focus the live main window, or recreate it and focus it once shown. Every
   * explicit "switch to this computer's window" request goes through here.
   */
  showMainWindow: (focus: () => void) => void;
  /** Handle an OS focus-shortcut delivery: focus now, or recreate then focus. */
  handleFocusShortcutTrigger: () => void;
}

export function createMainWindowRecreation<TPreferences>(
  deps: MainWindowRecreationDeps<TPreferences>,
): MainWindowRecreation {
  const liveWindow = (): RecreatableWindow | null => {
    const win = deps.getMainWindow();
    return win !== null && !win.isDestroyed() ? win : null;
  };

  const ensureMainWindow = singleFlight(async (): Promise<void> => {
    const preferences = await deps.readPreferences();
    // A window may have appeared during the read (another caller's creation
    // finished, or the app is mid-startup); never create a second one.
    if (liveWindow() !== null) return;
    deps.createWindow(preferences);
  });

  const showMainWindow = (focus: () => void): void => {
    if (liveWindow() !== null) {
      focus();
      return;
    }
    ensureMainWindow()
      .then(() => {
        const win = liveWindow();
        if (win === null) return;
        // Already shown (a creation that raced this one, or a second press
        // whose listener would attach after the event): focus now, since
        // `ready-to-show` will never fire again.
        if (win.isVisible()) {
          focus();
          return;
        }
        win.once('ready-to-show', focus);
      })
      .catch(deps.onRecreationFailure);
  };

  const handleFocusShortcutTrigger = (): void => {
    if (!deps.shouldHandleTrigger()) return;
    showMainWindow(deps.focusMainWindow);
  };

  return { ensureMainWindow, showMainWindow, handleFocusShortcutTrigger };
}
