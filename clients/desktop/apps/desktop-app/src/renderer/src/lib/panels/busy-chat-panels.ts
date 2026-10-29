/**
 * Render-time view of which chat panels cannot close right now, for the panel
 * grids' `canCloseTab` seam. A busy chat (active turn or live delegates) keeps
 * its panel: the tab × is withheld and the context menu's Close is disabled.
 *
 * The click paths re-check the live state (`closePanelTab`), so this snapshot
 * only has to be current enough to render.
 */
import { useMemo } from 'react';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import { useChatTabStrip } from '@/stores/chatStore';
import {
  isChatTabBusy,
  type ChatTabCloseFields,
} from '@/stores/chat/close-guard';
import {
  useDelegationActivityStore,
  type DelegationActivityState,
} from '@/stores/delegationActivityStore';

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Comma-joined ids of the chats that cannot close. A string, so the memo
 * only produces a new value when a chat's closeability flips.
 */
function busyChatSignature(
  tabs: readonly ChatTabCloseFields[],
  projectId: string,
  worktreeId: string,
  delegationState: DelegationActivityState,
): string {
  return tabs
    .filter((tab) => isChatTabBusy(tab, projectId, worktreeId, delegationState))
    .map((tab) => tab.id)
    .join(',');
}

/** The ids of this worktree's chats that cannot close right now. */
export function useBusyChatIds(
  projectId: string | null,
  worktreeId: string | null,
): ReadonlySet<string> {
  const delegationState = useDelegationActivityStore((state) => state);
  // The strip projection changes only when a strip-visible field does, which
  // includes everything closeability reads, never on streamed content.
  const tabs = useChatTabStrip(
    projectId === null || worktreeId === null
      ? null
      : `${projectId}/${worktreeId}`,
  );
  const signature = useMemo(
    (): string =>
      projectId === null || worktreeId === null
        ? ''
        : busyChatSignature(tabs, projectId, worktreeId, delegationState),
    [tabs, projectId, worktreeId, delegationState],
  );
  return useMemo(
    (): ReadonlySet<string> =>
      signature === '' ? EMPTY_IDS : new Set(signature.split(',')),
    [signature],
  );
}

/** Whether a panel tab is bound to one of the busy chats. */
export function isBusyChatPanel(
  tab: Pick<PanelTabModel, 'kind' | 'instance'>,
  busyChatIds: ReadonlySet<string>,
): boolean {
  const chatTabId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
  return chatTabId !== undefined && busyChatIds.has(chatTabId);
}

/**
 * A `canCloseTab` for grids with no other close restriction: `undefined`
 * (every tab closable) unless a chat is busy.
 */
export function useBusyChatCanCloseTab(
  projectId: string | null,
  worktreeId: string | null,
): ((tab: PanelTabModel) => boolean) | undefined {
  const busyChatIds = useBusyChatIds(projectId, worktreeId);
  return useMemo(
    () =>
      busyChatIds.size === 0
        ? undefined
        : (tab: PanelTabModel): boolean => !isBusyChatPanel(tab, busyChatIds),
    [busyChatIds],
  );
}
