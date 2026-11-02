/**
 * The one shortcut registry. Every keyboard hint the app draws (a key cap in
 * a tooltip, the chip inside a button, a picker footer, a menu row, the
 * shortcuts settings page) reads its keys from here, so a binding is spelled
 * once and every hint formats it the same way on each platform: macOS glyphs
 * (`⌘K`, `↵`, `esc`) and Windows/Linux words (`Ctrl K`, `Enter`, `Esc`).
 *
 * The registry is imported only where it is drawn (desktop surfaces and their
 * shared pickers), through `@canopy/ui-shared/lib/shortcuts`, so hosts that
 * never draw these hints do not ship it. Platform detection and the
 * formatter live in `./shortcut-platform`.
 *
 * This is display data only. The handlers that bind these chords live with
 * their surfaces (desktop `keyboardShortcuts.ts`, the shared panel commands,
 * the find router); adding an entry here does not bind a key.
 */

import type { KeyHint } from '../components/KeyHintFooter';
import {
  currentShortcutPlatform,
  DIALOG_CONFIRM_CHORD,
  DISMISS_CHORD,
  joinShortcutKeys,
  ROW_SELECTION_CHORD,
  type ShortcutChord,
  type ShortcutHintPlatform,
} from './shortcut-platform';

export {
  currentShortcutPlatform,
  isMacPlatform,
  joinShortcutKeys,
  type ShortcutChord,
  type ShortcutHintPlatform,
} from './shortcut-platform';

/** The platform's main modifier, then `key` (`⌘K`, `Ctrl K`). */
function primary(key: string, otherKey: string = key): ShortcutChord {
  return { mac: ['⌘', key], other: ['Ctrl', otherKey] };
}

/** The main modifier and Shift, then `key` (`⌘⇧K`, `Ctrl Shift K`). */
function primaryShift(key: string): ShortcutChord {
  return { mac: ['⌘', '⇧', key], other: ['Ctrl', 'Shift', key] };
}

/** The main modifier and Option/Alt, then `key` (`⌘⌥←`, `Ctrl Alt ←`). */
function primaryAlt(key: string): ShortcutChord {
  return { mac: ['⌘', '⌥', key], other: ['Ctrl', 'Alt', key] };
}

/** Option/Alt alone, then `key` (`⌥W`, `Alt W`). */
function alt(key: string): ShortcutChord {
  return { mac: ['⌥', key], other: ['Alt', key] };
}

/** Control on every platform, then `key` (`⌃M`, `Ctrl M`). */
function control(key: string): ShortcutChord {
  return { mac: ['⌃', key], other: ['Ctrl', key] };
}

/** Browser-style history: ⌘ and an arrow on macOS, Alt and an arrow elsewhere. */
function history(arrow: '←' | '→'): ShortcutChord {
  return { mac: ['⌘', arrow], other: ['Alt', arrow] };
}

const SHORTCUT_REGISTRY = {
  // App commands, keyed by the desktop command id that binds them.
  'open-command-palette': primary('K'),
  'open-file-search-palette': primary('P'),
  'new-task': primary('N'),
  'new-chat-tab': primary('T'),
  'new-terminal-tab': primary('T'),
  'new-browser-tab': primary('T'),
  'focus-browser-address-bar': primary('L'),
  'find-in-surface': primary('F'),
  'browser-history-back': history('←'),
  'browser-history-forward': history('→'),
  'app-history-back': history('←'),
  'app-history-forward': history('→'),
  'toggle-sidebar': primary('B'),
  'open-workspace-picker': alt('W'),
  'open-model-picker': alt('M'),
  'cycle-effort-level': alt('T'),
  'toggle-dictation': control('M'),
  'open-terminal': control('`'),
  'chat-attachments': primary('U'),
  'close-chat-tab': primary('W'),
  'open-app-advisor': primary('L'),
  'open-app-advisor-quick-prompt': primaryShift('L'),
  'open-settings': primary(','),
  'open-shortcuts-settings': primaryShift('K'),
  'open-current-pr': primaryShift('G'),
  'navigate-overview': primary('1'),
  'navigate-worktrees': primary('2'),
  'navigate-chat': primary('3'),
  'navigate-pipelines': primary('4'),
  'navigate-plugins': primary('5'),
  'navigate-audit': primary('6'),
  'navigate-usage': primary('7'),
  'navigate-automations': primary('8'),
  'navigate-statistics': primary('9'),
  'panel-split-right': primary('\\'),
  'panel-split-down': primaryShift('D'),
  'panel-focus-next-group': primary(']'),
  'panel-focus-previous-group': primary('['),
  'panel-focus-group-left': primaryAlt('←'),
  'panel-focus-group-right': primaryAlt('→'),
  'panel-focus-group-up': primaryAlt('↑'),
  'panel-focus-group-down': primaryAlt('↓'),
  'panel-move-to-next-group': primaryShift('M'),
  'panel-toggle-maximize': primaryShift('F'),
  'panel-close-group': primaryShift('W'),
  'panel-even-sizes': primaryShift('E'),
  // Tab cycling follows each platform's tab convention: ⌘⇧] / ⌘⇧[ on macOS,
  // Ctrl+Tab / Ctrl+Shift+Tab elsewhere.
  'panel-select-next-tab': { mac: ['⌘', '⇧', ']'], other: ['Ctrl', 'Tab'] },
  'panel-select-previous-tab': {
    mac: ['⌘', '⇧', '['],
    other: ['Ctrl', 'Shift', 'Tab'],
  },
  // Windows/Linux alternates for tab cycling, drawn only on `other`. macOS
  // has no alternate, so `mac` repeats the primary chord.
  'panel-select-next-tab-alternate': {
    mac: ['⌘', '⇧', ']'],
    other: ['Ctrl', 'PageDown'],
  },
  'panel-select-previous-tab-alternate': {
    mac: ['⌘', '⇧', '['],
    other: ['Ctrl', 'PageUp'],
  },

  // Surface-scoped bindings that are not app commands.
  'terminal-send-to-chat': primary('L'),
  undo: primary('Z'),
  redo: primaryShift('Z'),
  'toggle-row-selection': ROW_SELECTION_CHORD,

  // Keys a focused list, picker or composer reads.
  'send-message': { mac: ['↵'], other: ['Enter'] },
  'list-move': { mac: ['↑', '↓'], other: ['↑', '↓'] },
  'list-open': { mac: ['↵'], other: ['Enter'] },
  dismiss: DISMISS_CHORD,
  'dialog-confirm': DIALOG_CONFIRM_CHORD,
  'palette-commands-prefix': { mac: ['>'], other: ['>'] },
} as const satisfies Record<string, ShortcutChord>;

/** Every binding a hint can name. */
export type ShortcutId = keyof typeof SHORTCUT_REGISTRY;

/** Read-only view of the registry, for docs and tests. */
export const SHORTCUTS: Readonly<Record<ShortcutId, ShortcutChord>> =
  SHORTCUT_REGISTRY;

/** One cap per key, in press order (`['⌘', 'K']`, `['Ctrl', 'K']`). */
export function shortcutKeys(
  id: ShortcutId,
  platform: ShortcutHintPlatform = currentShortcutPlatform(),
): readonly string[] {
  return SHORTCUTS[id][platform];
}

/** The display string for a binding (`⌘K` on macOS, `Ctrl K` elsewhere). */
export function formatShortcut(
  id: ShortcutId,
  platform: ShortcutHintPlatform = currentShortcutPlatform(),
): string {
  return joinShortcutKeys(shortcutKeys(id, platform), platform);
}

/**
 * The legend every keyboard picker shows: ↑↓ move, ↵ `actionLabel`, esc
 * close, with the keys read from the registry for the platform.
 */
export function pickerKeyHints(
  actionLabel: string,
  platform?: ShortcutHintPlatform,
): readonly KeyHint[] {
  return [
    { shortcut: shortcutKeys('list-move', platform), label: 'move' },
    { shortcut: shortcutKeys('list-open', platform), label: actionLabel },
    { shortcut: shortcutKeys('dismiss', platform), label: 'close' },
  ];
}
