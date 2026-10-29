/**
 * Brings the panel bound to one chat into view, wherever it lives.
 *
 * Sending a message to a chat from another surface (a pipeline run's Chat
 * follow-up) must leave that chat visible. Selecting the chat in the chat
 * store is not enough: the chat↔panel bridge reveals only when the active
 * chat tab CHANGES, so a chat that is already the worktree's active tab stays
 * hidden behind another tab, inside a collapsed group, behind a maximized
 * sibling, or in a pulled-out window.
 *
 * The lookup spans the owner's whole layout family, so the chat is found in
 * an auxiliary window as well as the main layout, and the reveal itself is
 * `revealPanel` (exit a conflicting maximize, expand, select, focus, and bring
 * the owning OS window forward). It never moves the tab.
 *
 * A chat tab whose panel is not in the layout yet (the owner's layout has not
 * loaded, or the sync bridge has not materialized a new tab's panel) is waited
 * for, briefly: the bridge owns materialization, exactly as when a chat is
 * selected normally.
 */
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import { ensureWorktreePanelLayout } from './persistence-bridge';
import { revealPanel } from './panel-reveal';

export interface ChatPanelRevealTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

export interface RevealChatPanelOptions {
  /** How long to wait for a missing panel to appear. Defaults to 2 seconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS = 25;

function locate(target: ChatPanelRevealTarget): PanelInstanceLocation | null {
  return findPanelByInstanceKey(
    makeWorktreePanelKey(target.projectId, target.worktreeId),
    getPanelInstanceKey({
      kind: 'chat',
      instance: { chatTabId: target.chatId },
    }),
  );
}

/**
 * Reveals the chat's panel. Resolves `true` once the panel was revealed and
 * `false` when it never appeared within the timeout (nothing is mutated).
 */
export async function revealChatPanel(
  target: ChatPanelRevealTarget,
  options: RevealChatPanelOptions = {},
): Promise<boolean> {
  const ownerKey = makeWorktreePanelKey(target.projectId, target.worktreeId);
  let location = locate(target);
  if (location === null) {
    if (usePanelLayoutStore.getState().layouts[ownerKey] === undefined) {
      await ensureWorktreePanelLayout(ownerKey).catch(() => undefined);
    }
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    location = locate(target);
    while (location === null && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, POLL_INTERVAL_MS);
      });
      location = locate(target);
    }
  }
  if (location === null) return false;
  revealPanel(location);
  return true;
}
