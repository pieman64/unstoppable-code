import type { TerminalSession } from '@canopy/protocol/terminal';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import {
  ensureTerminalPanelVisible,
  type TerminalPanelActivationSource,
} from '@/lib/panels/terminal-panel-activation';

export interface DesktopTerminalRunHostOptions {
  readonly projectId: string;
  readonly worktreeId: string;
  /** Panel group that issued the run; null uses the worktree's default terminal placement. */
  readonly panelPlacement?: TerminalPanelActivationSource | null;
  readonly ownerDocument?: Document;
  /** Focus the revealed terminal. Defaults to true. */
  readonly focus?: boolean;
}

/**
 * Desktop hydrate/reveal callbacks for `runCommandInTerminal`: hydrate the
 * worktree's terminal store, add the new PTY as a group, and show its panel.
 */
export function desktopTerminalRunHost({
  projectId,
  worktreeId,
  panelPlacement = null,
  ownerDocument,
  focus = true,
}: DesktopTerminalRunHostOptions): {
  hydrate: () => Promise<void>;
  reveal: (session: TerminalSession) => void;
} {
  return {
    hydrate: (): Promise<void> =>
      ensureTerminalWorktreeHydrated(projectId, worktreeId),
    reveal: (session): void => {
      const terminalStore = useTerminalStore.getState();
      terminalStore.setDrawerCollapsed(projectId, worktreeId, false);
      terminalStore.addGroupWithTerminal(session);
      ensureTerminalPanelVisible(
        makeWorktreePanelKey(projectId, worktreeId),
        panelPlacement,
        {
          terminalId: session.id,
          focus,
          ...(ownerDocument ? { focusOwnerDocument: ownerDocument } : {}),
        },
      );
    },
  };
}

/** Reveal and focus an already running terminal instead of spawning another. */
export function revealDesktopTerminal(
  options: DesktopTerminalRunHostOptions & { readonly terminalId: string },
): void {
  ensureTerminalPanelVisible(
    makeWorktreePanelKey(options.projectId, options.worktreeId),
    options.panelPlacement ?? null,
    {
      terminalId: options.terminalId,
      focus: options.focus !== false,
      ...(options.ownerDocument
        ? { focusOwnerDocument: options.ownerDocument }
        : {}),
    },
  );
}
