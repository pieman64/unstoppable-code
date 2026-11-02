import type { Input } from 'electron';
import type { BrowserShortcutEventAction } from '@canopy/desktop-shared/types';

/**
 * Browser-owned hotkey routing for the native in-app browser page (ECW-7984).
 *
 * The renderer's global shortcut dispatcher (`useGlobalShortcuts`) listens on
 * the main renderer window's DOM. When keyboard focus sits inside a browser
 * `WebContentsView`, keydown events go to that view's own webContents and the
 * renderer never sees them — so browser chords must be intercepted in the main
 * process via `before-input-event` on the page webContents
 * (`BrowserService.attachWebContentsListeners`).
 *
 * The chord set is deliberately small and mirrors standard desktop browsers:
 *
 * - macOS: Cmd+T (new tab), Cmd+L (focus address bar), Cmd+B (toggle app
 *   sidebar), Cmd+F (open the find bar in browser mode, CAN-3048), Cmd+W
 *   (close tab), Cmd+Left / Cmd+Right (history back / forward).
 * - Windows/Linux: Ctrl+T, Ctrl+L, Ctrl+B, Ctrl+F, Ctrl+W, and the
 *   platform-conventional Alt+Left / Alt+Right for history back / forward.
 * - The app's panel tab-cycle chords (CAN-4616), so cycling also works from a
 *   focused page: Cmd+Shift+] / Cmd+Shift+[ on macOS, and Ctrl+Tab /
 *   Ctrl+Shift+Tab and Ctrl+PageDown / Ctrl+PageUp elsewhere. These match the
 *   desktop browsers' own tab-switching chords.
 *
 * Other Shift and Alt variants (for example Cmd+Shift+F, or Cmd+Shift+W,
 * which is close-window on macOS) are never claimed. Cmd+F preempts a page's
 * own find handler, like the other chords.
 *
 * Handled chords are consumed exactly once (`event.preventDefault()` stops
 * delivery to page JavaScript); everything else passes through untouched.
 */

/** What a handled browser-page chord should do. */
export type BrowserShortcutAction =
  | 'back'
  | 'forward'
  | BrowserShortcutEventAction;

export type BrowserShortcutInput = Pick<
  Input,
  'type' | 'code' | 'alt' | 'control' | 'meta' | 'shift'
>;

/**
 * Pure resolver mapping a `before-input-event` `Input` to a browser shortcut
 * action, or `null` when the input is not a browser-owned chord. Uses
 * `input.code` (physical key) so the mapping is layout-stable, mirroring
 * `shouldBlockBeforeInput` in `main/menu.ts`.
 */
export function resolveBrowserShortcutAction(
  input: BrowserShortcutInput,
  platform: NodeJS.Platform,
): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') {
    return null;
  }
  const isMac = platform === 'darwin';
  const tabCycle = resolveTabCycleAction(input, isMac);
  if (tabCycle !== null) {
    return tabCycle;
  }
  if (input.shift) {
    return null;
  }

  if (isMac) {
    if (!input.meta || input.control || input.alt) {
      return null;
    }
    switch (input.code) {
      case 'KeyT':
        return 'new-tab';
      case 'KeyL':
        return 'focus-address-bar';
      case 'KeyB':
        return 'toggle-sidebar';
      case 'KeyF':
        return 'find-in-page';
      case 'KeyW':
        return 'close-tab';
      case 'ArrowLeft':
        return 'back';
      case 'ArrowRight':
        return 'forward';
      default:
        return null;
    }
  }

  if (input.control && !input.meta && !input.alt) {
    switch (input.code) {
      case 'KeyT':
        return 'new-tab';
      case 'KeyL':
        return 'focus-address-bar';
      case 'KeyB':
        return 'toggle-sidebar';
      case 'KeyF':
        return 'find-in-page';
      case 'KeyW':
        return 'close-tab';
      default:
        return null;
    }
  }
  // Windows/Linux browser convention: Alt+Left / Alt+Right for history.
  if (input.alt && !input.control && !input.meta) {
    switch (input.code) {
      case 'ArrowLeft':
        return 'back';
      case 'ArrowRight':
        return 'forward';
      default:
        return null;
    }
  }
  return null;
}

/**
 * The panel tab-cycle chords, mirroring the shared `PANEL_SHORTCUT_BINDINGS`
 * tab-cycle entries in `@canopy/ui-app` (macOS by physical bracket key, since
 * Shift turns `]` into `}`).
 */
function resolveTabCycleAction(
  input: BrowserShortcutInput,
  isMac: boolean,
): 'select-next-tab' | 'select-previous-tab' | null {
  if (input.alt) {
    return null;
  }
  if (isMac) {
    if (!input.meta || input.control || !input.shift) {
      return null;
    }
    switch (input.code) {
      case 'BracketRight':
        return 'select-next-tab';
      case 'BracketLeft':
        return 'select-previous-tab';
      default:
        return null;
    }
  }
  if (!input.control || input.meta) {
    return null;
  }
  switch (input.code) {
    case 'Tab':
      return input.shift ? 'select-previous-tab' : 'select-next-tab';
    case 'PageDown':
      return input.shift ? null : 'select-next-tab';
    case 'PageUp':
      return input.shift ? null : 'select-previous-tab';
    default:
      return null;
  }
}
