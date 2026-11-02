/**
 * Platform detection and formatting for keyboard hints, without the shortcut
 * registry (`./shortcuts`), so shortcut matching and the few hints every host
 * draws stay small.
 */

/** The two hint vocabularies: macOS glyphs, or the Windows/Linux words. */
export type ShortcutHintPlatform = 'mac' | 'other';

/** One binding's keys, in press order, for each platform. */
export interface ShortcutChord {
  readonly mac: readonly string[];
  readonly other: readonly string[];
}

/**
 * Cmd/Ctrl-click toggles a row in a selection. Defined here rather than in
 * the registry because the shared worktree menu names it on every host; the
 * registry's `toggle-row-selection` entry is this same chord.
 */
export const ROW_SELECTION_CHORD: ShortcutChord = {
  mac: ['⌘', 'Click'],
  other: ['Ctrl', 'Click'],
};

/**
 * Enter presses a dialog's default button. Defined here, like
 * {@link ROW_SELECTION_CHORD}, because the shared confirmation dialogs draw it
 * on every host; the registry's `dialog-confirm` entry is this same chord.
 */
export const DIALOG_CONFIRM_CHORD: ShortcutChord = {
  mac: ['↵'],
  other: ['Enter'],
};

/**
 * Escape closes a dialog, picker or menu. The shared confirmation dialogs
 * draw it inside their Cancel button on every host; the registry's `dismiss`
 * entry is this same chord.
 */
export const DISMISS_CHORD: ShortcutChord = {
  mac: ['esc'],
  other: ['Esc'],
};

interface UserAgentDataLike {
  platform?: string;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: UserAgentDataLike;
}

function readUserAgentDataPlatform(nav: Navigator): string | undefined {
  const navigatorWithUserAgentData: NavigatorWithUserAgentData = nav;
  const platform = navigatorWithUserAgentData.userAgentData?.platform;
  return typeof platform === 'string' ? platform : undefined;
}

/**
 * Whether the app runs on macOS. The one platform
 * check for both shortcut matching and hint display.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const platform =
    readUserAgentDataPlatform(navigator) ?? navigator.platform ?? '';
  return platform.toLowerCase().includes('mac');
}

/** The hint vocabulary for the current platform. */
export function currentShortcutPlatform(): ShortcutHintPlatform {
  return isMacPlatform() ? 'mac' : 'other';
}

/**
 * Joins keys into one display string. macOS glyphs run together (`⌘⇧K`)
 * unless a key is a word (`⌘ Click`); Windows/Linux words are spaced
 * (`Ctrl Shift K`). `splitShortcutKeys` reverses it exactly.
 */
export function joinShortcutKeys(
  keys: readonly string[],
  platform: ShortcutHintPlatform,
): string {
  if (platform === 'mac' && keys.every((key) => key.length === 1)) {
    return keys.join('');
  }
  return keys.join(' ');
}

/** The display string for a chord (`⌘ Click`, `Ctrl Click`). */
export function formatChord(
  chord: ShortcutChord,
  platform: ShortcutHintPlatform = currentShortcutPlatform(),
): string {
  return joinShortcutKeys(chord[platform], platform);
}
