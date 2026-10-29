import {
  isShortcutEvent,
  isTerminalTarget,
  type ShortcutEventLike,
} from '@/lib/keyboardShortcuts';
import {
  resolveFallbackFindTarget,
  runFindShortcut,
  type FindShortcutEvent,
} from '@/lib/find/findShortcut';
import {
  runNewTabShortcut,
  type RunNewTabShortcutParams,
} from '@/lib/newTabShortcut';

export interface AuxPanelNewTabKeyEvent extends ShortcutEventLike {
  preventDefault: () => void;
  target: EventTarget | null;
}

export interface HandleAuxPanelNewTabShortcutParams extends Omit<
  RunNewTabShortcutParams,
  'target'
> {
  event: AuxPanelNewTabKeyEvent;
}

/**
 * Handles Cmd/Ctrl+T in a pulled-out panel's child Window. Returns whether the
 * chord was claimed so callers can share the resolver without duplicating the
 * platform and terminal-passthrough guards.
 */
export function handleAuxPanelNewTabShortcut({
  event,
  ...shortcutParams
}: HandleAuxPanelNewTabShortcutParams): boolean {
  if (event.ctrlKey && !event.metaKey && isTerminalTarget(event.target)) {
    return false;
  }
  if (!isShortcutEvent(event, 't')) {
    return false;
  }

  event.preventDefault();
  runNewTabShortcut({
    ...shortcutParams,
    target: event.target,
  });
  return true;
}

export interface HandleAuxPanelFindShortcutParams {
  event: FindShortcutEvent;
  /** The pulled-out panel window's own document. */
  childDocument: Document;
  /** The aux layout's active group, read only when no surface owns the key. */
  readActiveGroupId: () => string | null;
}

/**
 * Handles Cmd/Ctrl+F in a pulled-out panel's child Window (CAN-3048). The main
 * window's global listener never sees child-window keydowns, so this routes
 * the chord to the floating find bar with a fallback scoped to the child
 * document's active panel group.
 */
export function handleAuxPanelFindShortcut({
  event,
  childDocument,
  readActiveGroupId,
}: HandleAuxPanelFindShortcutParams): boolean {
  // Matching the main window: a terminal with a registered find controller
  // takes Cmd/Ctrl+F (the one CAN-338 exception), and never resolves to a
  // sibling surface's bar; its other Ctrl chords stay with the shell.
  if (isTerminalTarget(event.target)) {
    if (isShortcutEvent(event, 'f')) return runFindShortcut(event, () => null);
    if (event.ctrlKey && !event.metaKey) return false;
  }
  return runFindShortcut(event, () =>
    resolveFallbackFindTarget(childDocument, readActiveGroupId()),
  );
}
