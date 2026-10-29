import { Menu, Tray, type NativeImage } from 'electron';

/**
 * Background presence for the activation journey (CAN-1967 phase 4).
 *
 * macOS already keeps the app alive when the last window closes — that is the
 * platform convention and `window-all-closed` has always skipped quit there.
 * Windows quits instead, so scheduled campaigns can never fire for a Windows
 * user who closed the window. Close-to-tray fixes that.
 *
 * The tray is REQUIRED on Windows once close-to-tray is on: without it a
 * closed window leaves a running app with no way back to it.
 */

export interface BackgroundPresenceDecision {
  platform: NodeJS.Platform;
  closeToTray: boolean;
}

/**
 * Whether `window-all-closed` should quit. macOS never quits here regardless
 * of the preference, preserving existing behavior; other platforms quit unless
 * the user has close-to-tray on.
 */
/**
 * Windows only. macOS never quits here, and Linux is deliberately excluded:
 * the Settings toggle is Windows-gated, so treating Linux like Windows would
 * make the app stay resident with no way for a Linux user to turn it off --
 * and tray support there varies by desktop environment.
 */
export function shouldQuitOnAllWindowsClosed(
  decision: BackgroundPresenceDecision,
): boolean {
  if (decision.platform !== 'win32') return decision.platform !== 'darwin';
  return !decision.closeToTray;
}

/**
 * Whether a tray icon is needed. Only Windows: macOS reaches a windowless app
 * through the Dock, which `app.on('activate')` already handles.
 */
export function shouldCreateTray(
  decision: BackgroundPresenceDecision,
): boolean {
  return decision.platform === 'win32' && decision.closeToTray;
}

/**
 * Whether to show the one-time "still running in the tray" notice. Shown once
 * per install: without it, a Windows user who closes the window reasonably
 * concludes the app quit.
 */
export function shouldDiscloseCloseToTray(options: {
  disclosedAt: string | undefined;
}): boolean {
  return options.disclosedAt === undefined;
}

/**
 * `window-all-closed` is synchronous, so the preference is cached here rather
 * than read from disk on the quit path. Seeded at startup and refreshed by
 * `applyPreferenceSideEffects`.
 */
let closeToTrayEnabled = true;

export function setCloseToTrayPreference(enabled: boolean): void {
  closeToTrayEnabled = enabled;
}

/**
 * Close-to-tray rides the activation-journey flag rather than shipping on its
 * own. It is the riskiest part of the journey work -- it changes what the
 * close button does, there is no Windows CI, and verification is manual -- so
 * it would otherwise be the one piece taking effect for every non-macOS user
 * while the campaigns it exists to serve stay dark. Flag off means the app
 * quits on close exactly as it does today.
 */
let journeyFlagEnabled = false;

export function setActivationJourneyFlagEnabled(enabled: boolean): void {
  journeyFlagEnabled = enabled;
}

/** The raw journey flag, independent of the close-to-tray preference. */
export function isActivationJourneyEnabled(): boolean {
  return journeyFlagEnabled;
}

export function isCloseToTrayEnabled(): boolean {
  return closeToTrayEnabled && journeyFlagEnabled;
}

let tray: Tray | null = null;

export interface TrayOptions {
  icon: string | NativeImage;
  appName: string;
  onOpen: () => void;
  onQuit: () => void;
}

export function ensureBackgroundTray(options: TrayOptions): Tray | null {
  if (tray !== null && !tray.isDestroyed()) return tray;
  try {
    tray = new Tray(options.icon);
  } catch {
    // A tray that cannot be created must not take the app down; the window
    // still exists at this point and close-to-tray is disabled below.
    tray = null;
    return null;
  }
  tray.setToolTip(options.appName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${options.appName}`, click: options.onOpen },
      { type: 'separator' },
      { label: 'Quit', click: options.onQuit },
    ]),
  );
  tray.on('click', options.onOpen);
  tray.on('double-click', options.onOpen);
  return tray;
}

/**
 * Returns whether a tray existed to disclose against. Callers stamp the
 * one-time `closeToTrayDisclosedAt` marker only on `true`: burning the single
 * disclosure while no tray icon exists would leave the user with no window,
 * no icon, and no further notice.
 */
export function discloseCloseToTray(appName: string): boolean {
  if (tray === null || tray.isDestroyed()) return false;
  try {
    tray.displayBalloon({
      title: `${appName} is still running`,
      content:
        'Agents keep working in the background. Click the tray icon to reopen, or turn this off in Settings.',
    });
  } catch {
    // Balloons are best-effort; the tray icon itself is the durable affordance.
  }
  return true;
}

let trayOptions: TrayOptions | null = null;

/**
 * Remember how to build the tray so a later preference change can create one.
 * The tray used to be built once at app-ready, so a user who enabled
 * close-to-tray mid-session and then closed the window got a resident app
 * with no window AND no tray icon -- `focusMainWindow()` no-ops on a null
 * window, so Task Manager was the only way out.
 */
export function setTrayOptions(options: TrayOptions): void {
  trayOptions = options;
}

/**
 * Bring the tray in line with the current preference. Returns whether a tray
 * exists afterwards, so a caller can fall back to disabling close-to-tray
 * when creation fails rather than stranding the user.
 */
export function syncBackgroundTray(options: {
  platform: NodeJS.Platform;
  closeToTray: boolean;
}): boolean {
  if (!shouldCreateTray(options)) {
    destroyBackgroundTray();
    return false;
  }
  if (trayOptions === null) return tray !== null && !tray.isDestroyed();
  return ensureBackgroundTray(trayOptions) !== null;
}

/**
 * Bring the tray in line with the current effective preference and report
 * whether the result is acceptable. Returns false ONLY when a tray was wanted
 * and could not be created -- callers disable close-to-tray on false, and
 * returning false merely because no tray was wanted (every non-Windows
 * platform) would clobber the stored preference on every startup and save.
 */
export function syncActivationTray(): boolean {
  const options = {
    platform: process.platform,
    closeToTray: isCloseToTrayEnabled(),
  };
  const wanted = shouldCreateTray(options);
  const ready = syncBackgroundTray(options);
  return !wanted || ready;
}

export function destroyBackgroundTray(): void {
  if (tray !== null && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}
