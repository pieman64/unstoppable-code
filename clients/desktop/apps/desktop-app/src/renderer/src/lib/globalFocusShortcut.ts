import {
  formatAcceleratorForDisplay,
  type ShortcutPlatform,
} from '@canopy/desktop-shared/lib/global-shortcut-accelerator';
import { COMMAND_DEFINITIONS, isMacPlatform } from './keyboardShortcuts';

/**
 * The renderer's own platform for chord display and validation before the
 * main-process status (which carries the authoritative platform) has loaded.
 */
export function rendererShortcutPlatform(): ShortcutPlatform {
  if (isMacPlatform()) return 'darwin';
  if (
    typeof navigator !== 'undefined' &&
    (navigator.platform ?? '').toLowerCase().includes('linux')
  ) {
    return 'linux';
  }
  return 'win32';
}

/**
 * `data-testid` of the Settings → Shortcuts section that owns the OS focus
 * shortcut; also the `openSettings` scroll target the checklist's "Change
 * shortcut" action uses.
 */
export const GLOBAL_FOCUS_SHORTCUT_SETTINGS_TARGET =
  'settings-global-focus-shortcut';

function shortcutKey(display: string): string {
  return display.replace(/\s+/g, '').toLowerCase();
}

/** What already claims a chord the recorder just captured. */
export interface InAppShortcutConflict {
  /** How the owner is named to the user. */
  title: string;
}

/**
 * Chords the View menu always claims for stepping `PreferencesData.uiScale`.
 * They are native menu accelerators owned by the main process, so they never
 * appear in `COMMAND_DEFINITIONS` — but the OS hands a global shortcut the keydown
 * first, so recording ⌘0 here would silently shadow Actual Size.
 *
 * Only the spellings the recorder can actually produce are listed, and it
 * produces two for Zoom In. `acceleratorFromKeyboardEvent` adds `Shift`
 * whenever the event carries it, and `+` on most layouts is Shift plus the
 * `=` key, so pressing what the user thinks of as ⌘+ yields
 * `CommandOrControl+Shift+=` — the likeliest chord to collide, and the one
 * a list holding only `CommandOrControl+=` would miss. The menu claims both
 * through its `CommandOrControl+Plus` registration, which is itself absent
 * here because `parseAccelerator` rejects it (`Plus` is not a key token) and
 * no keyboard event ever yields that spelling.
 */
const INTERFACE_SCALE_MENU_ACCELERATORS: readonly {
  title: string;
  accelerator: string;
}[] = [
  { title: 'Zoom In', accelerator: 'CommandOrControl+=' },
  { title: 'Zoom In', accelerator: 'CommandOrControl+Shift+=' },
  { title: 'Zoom Out', accelerator: 'CommandOrControl+-' },
  { title: 'Actual Size', accelerator: 'CommandOrControl+0' },
];

/**
 * What already owns `displayShortcut`, if anything. A global shortcut is
 * intercepted by the OS before the renderer ever sees the keydown, so
 * recording ⌘K as the focus chord would silently break the command palette
 * while the app is focused (CAN-1963). Compares platform display strings —
 * the recorder and `COMMAND_DEFINITIONS` both produce them — ignoring case
 * and spacing.
 */
export function findInAppShortcutConflict(
  displayShortcut: string,
  platform: ShortcutPlatform = rendererShortcutPlatform(),
): InAppShortcutConflict | null {
  const key = shortcutKey(displayShortcut);
  if (key.length === 0) return null;
  const command = COMMAND_DEFINITIONS.find(
    (definition) =>
      definition.shortcut !== undefined &&
      shortcutKey(definition.shortcut) === key,
  );
  if (command !== undefined) {
    return { title: command.title };
  }
  const menuItem = INTERFACE_SCALE_MENU_ACCELERATORS.find(
    (item) =>
      shortcutKey(formatAcceleratorForDisplay(item.accelerator, platform)) ===
      key,
  );
  return menuItem === undefined ? null : { title: menuItem.title };
}
