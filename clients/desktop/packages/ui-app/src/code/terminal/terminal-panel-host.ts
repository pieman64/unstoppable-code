import type { TerminalSession } from '@canopy/protocol/terminal';

/**
 * Host placement and mount policy for a shared terminal panel. Mount may read
 * worktree state, attach preserved history, and list terminals. Only automatic
 * shutdown-session restore is gated by restoreOnReveal (default true). Cloud
 * hosts pass false so mounting cannot wake their sandbox. Spawn requires Start
 * or a queued user gesture; explicit Restart remains available.
 *
 * Every recovery option is opt-in. A host that sets none of them (desktop)
 * keeps the surface's own Start button, bottom Restart bar and error text.
 */
export interface TerminalPanelHost {
  getBinding: (worktreeKey: string, panelId: string) => string | undefined;
  bindTerminal: (
    worktreeKey: string,
    panelId: string,
    session: TerminalSession,
  ) => boolean;
  prepareWorktree?: (
    projectId: string,
    worktreeId: string,
    worktreeKey: string,
  ) => Promise<void>;
  /** Disable automatic shutdown-session restore for hosts that must not wake on mount. */
  restoreOnReveal?: boolean;
  /**
   * The host renders the panel's only recovery UI: the empty-panel Start
   * action, restart/wake notices and their errors. The surface then renders
   * no Start button, no bottom Restart bar and no error text, and reports
   * failures of the starts it begins itself through `onRecoveryError`.
   */
  ownsRecoveryUi?: boolean;
  /**
   * Hands the host the panel's start action: the same spawn-and-bind path as
   * the Start button and queued Add panel gestures. It resolves once a new
   * terminal is spawned, bound to this panel and given the caret, or without
   * spawning if the panel is already bound. It rejects with the original
   * error, and also when the terminal client changes before the terminal is
   * bound. A call made while a start is in flight joins that attempt and its
   * result, and takes over reporting it: a joined attempt's failure then
   * arrives only as this rejection. Registering never spawns. Returns the
   * unregister function.
   */
  registerStart?: (panelId: string, start: () => Promise<void>) => () => void;
  /**
   * Hands the host the panel's restart action, including replay, remount and
   * focus. It resolves once the bound terminal is live again. It rejects with
   * the original error, when the panel has no bound terminal, when another
   * terminal of this panel is still restarting, and when the terminal client
   * changes mid-restart. A call made while the same terminal restarts joins
   * that attempt and its result. Returns the unregister function.
   */
  registerRestart?: (
    panelId: string,
    restart: () => Promise<void>,
  ) => () => void;
  /**
   * Hears failures of starts the surface began itself (a queued Add panel or
   * reveal gesture) while `ownsRecoveryUi` is true, with the original error.
   * Registered start/restart failures reject instead, including a surface-
   * begun attempt that a registered start joined before it failed. Failures
   * after the terminal client changed are dropped. Unused without
   * `ownsRecoveryUi`.
   */
  onRecoveryError?: (error: unknown) => void;
  /**
   * Hears whether a start of this panel is in flight, whoever began it: true
   * when the spawn begins, false once it settles. A host that owns the
   * recovery UI uses it to show a surface-begun start (a queued Add panel
   * gesture) as busy rather than offering an enabled Start. Optional; a host
   * that sets nothing (desktop) sees no change.
   */
  onStartingChange?: (starting: boolean) => void;
}
