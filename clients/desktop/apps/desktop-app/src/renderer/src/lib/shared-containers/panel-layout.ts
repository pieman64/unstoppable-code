import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { isSharedContainerPanelKind } from './panel-allowlist';

type SharedContainerRunLayoutAvailability =
  | 'loading'
  | 'unsupported'
  | 'unpublished'
  | 'available';

/**
 * Whether a restored terminal tab should be purged rather than left on screen.
 *
 * `loading` is the one state that must preserve it. Main has not answered yet,
 * so purging there would destroy a legitimately restored terminal every time
 * an allowed share is opened.
 *
 * Every resolved non-consented state purges. A stale terminal tab that renders
 * "This panel is not available in a shared container" is worse than no tab: it
 * advertises a capability the share does not have, and it is the first thing a
 * recipient sees on a view-only share (CAN-2831 feedback).
 *
 * Purging `unsupported` and `unpublished` cannot orphan a live PTY. In both
 * states `runAllowed` is false, so `terminal` is outside the allowlist, the
 * add-tab menu excludes it, and the run sheet is unreachable — this session
 * cannot have spawned one. What the tab holds is leftover layout from a
 * session when the share WAS runnable. The one path that can strand a running
 * process, explicit revocation, is `available` + denied, and main stops the
 * container's terminals and script runs before it returns that status.
 */
export function shouldCloseSharedContainerTerminalLayout(
  availability: SharedContainerRunLayoutAvailability,
  allowed: boolean,
): boolean {
  return availability !== 'loading' && !allowed;
}

function allowedForContainer(kind: string, runEnabled: boolean): boolean {
  return isSharedContainerPanelKind(kind, runEnabled);
}

/**
 * Drop every panel the recipient view may not mount for the given consent.
 *
 * The layout itself is the standard one: the publisher's sanitized layout is
 * applied by main the first time the share opens, and the standard default
 * layout covers a share that published none. This purge only removes kinds
 * the access-derived allowlist refuses, which is also what closes a terminal
 * tab when run consent is revoked (CAN-2831). Callers must kill the
 * container's processes BEFORE calling this, or a closed tab leaves a live PTY
 * with no UI attached to it.
 *
 * `runEnabled` is required rather than defaulted for the same reason it is in
 * the allowlist: a caller that has not resolved consent yet must not be able
 * to silently keep a terminal tab alive.
 */
export function repairSharedContainerPanelLayout(
  worktreeKey: string,
  runEnabled: boolean,
  liveTerminalIds?: ReadonlySet<string>,
): void {
  const store = usePanelLayoutStore.getState();
  const existing = store.layouts[worktreeKey];
  if (!existing) return;

  for (const [groupId, group] of Object.entries(existing.groups)) {
    const refused = group.tabs
      .filter((tab) => {
        if (!allowedForContainer(tab.kind, runEnabled)) return true;
        if (tab.kind !== 'terminal' || liveTerminalIds === undefined) {
          return false;
        }
        const terminalId = tab.instance?.terminalId;
        return terminalId === undefined || !liveTerminalIds.has(terminalId);
      })
      .map((tab) => tab.panelId);
    if (refused.length > 0) store.closeTabs(worktreeKey, groupId, refused);
  }
}
