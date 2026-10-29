/**
 * Pure surface-resolution rule for context-aware Cmd/Ctrl+T (ECW-7984).
 *
 * Kept dependency-light (only the target predicates) so the rule is trivially
 * unit-testable; the store-aware dispatch lives in `newTabShortcut.ts`.
 */
import {
  isBrowserSurfaceTarget,
  isTerminalTarget,
} from '@/lib/keyboardShortcuts';

/** The tab type a Cmd/Ctrl+T press should create. */
export type NewTabSurfaceKind = 'chat' | 'terminal' | 'browser';

export interface NewTabSurfaceContext {
  /** The keydown event target, for focus-based resolution. */
  target: EventTarget | null;
  /**
   * The active panel kind of the focused panel group (open string per the
   * ui-shared registry), or null when the worktree has no layout.
   */
  activePanelKind: string | null;
}

/**
 * Keyboard focus wins over panel-group activity, and a merely visible
 * browser/terminal panel never steals the chord — only the focused target or
 * the ACTIVE group routes away from chat:
 *
 * - a focused terminal (xterm / terminal host) → terminal tab;
 * - focused browser chrome (tab strip, address bar, inspector) → browser tab;
 * - otherwise the active panel group's kind: terminal → terminal tab,
 *   browser → browser tab, and everything else (chat, file tabs,
 *   activity/file-explorer/usage panels, or no layout at all) falls back to
 *   the surface's primary tab type — a chat tab — without navigating away.
 */
export function resolveNewTabSurface(
  context: NewTabSurfaceContext,
): NewTabSurfaceKind {
  if (isTerminalTarget(context.target)) {
    return 'terminal';
  }
  if (isBrowserSurfaceTarget(context.target)) {
    return 'browser';
  }
  if (context.activePanelKind === 'terminal') {
    return 'terminal';
  }
  if (context.activePanelKind === 'browser') {
    return 'browser';
  }
  return 'chat';
}
