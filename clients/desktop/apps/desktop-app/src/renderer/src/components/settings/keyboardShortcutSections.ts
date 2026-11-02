import type { CommandId } from '@/lib/keyboardShortcuts';

export const ESSENTIAL_SHORTCUT_COMMAND_IDS: CommandId[] = [
  'open-command-palette',
  'open-file-search-palette',
  'open-shortcuts-settings',
  'new-task',
  'new-chat-tab',
  'close-chat-tab',
  'chat-attachments',
  'open-app-advisor',
  'open-app-advisor-quick-prompt',
  'open-current-pr',
  'open-settings',
];

/**
 * Composer chords (ECW-7984 follow-up). Bare-⌥ bindings that act on whichever
 * composer is on screen — the Home new-task surface or the focused chat.
 */
export const COMPOSER_SHORTCUT_COMMAND_IDS: CommandId[] = [
  'open-workspace-picker',
  'open-model-picker',
  'cycle-effort-level',
  'toggle-dictation',
];

export const NAVIGATION_SHORTCUT_COMMAND_IDS: CommandId[] = [
  'app-history-back',
  'app-history-forward',
  'navigate-overview',
  'navigate-worktrees',
  'navigate-chat',
  'navigate-pipelines',
  'navigate-automations',
  'navigate-feed',
  'navigate-plugins',
  'navigate-audit',
  'navigate-statistics',
  'navigate-usage',
];

/**
 * Context-aware tab/surface chords (ECW-7984): the ⌘T family resolves the
 * focused surface, and the browser/terminal entries only apply while that
 * surface owns focus.
 */
export const SURFACE_SHORTCUT_COMMAND_IDS: CommandId[] = [
  'new-terminal-tab',
  'new-browser-tab',
  'open-terminal',
  'focus-browser-address-bar',
  'find-in-surface',
  'browser-history-back',
  'browser-history-forward',
];

/**
 * Chrome show/hide chords (ECW-7984 follow-up). Kept separate from
 * `PANEL_SHORTCUT_COMMAND_IDS`, which is a strict mirror of the panel-grid
 * binding table (worktree-scoped `panels` commands only).
 */
export const LAYOUT_SHORTCUT_COMMAND_IDS: CommandId[] = ['toggle-sidebar'];

export const PANEL_SHORTCUT_COMMAND_IDS: CommandId[] = [
  'panel-split-right',
  'panel-split-down',
  'panel-focus-next-group',
  'panel-focus-previous-group',
  'panel-focus-group-left',
  'panel-focus-group-right',
  'panel-focus-group-up',
  'panel-focus-group-down',
  'panel-move-to-next-group',
  'panel-toggle-maximize',
  'panel-close-group',
  'panel-even-sizes',
  'panel-select-next-tab',
  'panel-select-previous-tab',
];
