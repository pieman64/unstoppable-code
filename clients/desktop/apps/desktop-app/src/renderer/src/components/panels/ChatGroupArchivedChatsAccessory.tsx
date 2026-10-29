import { memo, type JSX } from 'react';
import type { PanelGroupModel } from '@canopy/ui-shared/panels';
import { useWorktreeChatRenderState } from '@/stores/chatStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { ArchivedChatsControl } from '@/components/chat/ArchivedChatsControl';

export interface ChatGroupArchivedChatsAccessoryProps {
  projectId: string;
  worktreeId: string;
  group: PanelGroupModel;
  /** Forwarded to {@link ArchivedChatsControl}. The primary instance owns
   * the global open-archives events and the App Advisor UI-state slice. It is
   * the worktree header's control (PrStatusBar). Header-less scoped surfaces
   * pass false. */
  primarySurface: boolean;
  /**
   * `tabStrip`: the control as one of the strip's own icon
   * buttons, spaced like the Activity toggle beside it.
   */
  variant?: 'header' | 'tabStrip';
}

/**
 * Tab-strip accessory hosting the archived-chats control next to the chat
 * tabs in header-less scopes. Worktrees use PrStatusBar instead. Rendered by the
 * desktop PanelGridSurface for every group holding chat tabs, but it mounts
 * the control in exactly ONE group:
 *
 * - the main-layout group holding the chat store's ACTIVE tab (unique per
 *   worktree), or
 * - when NO main-layout group holds it — the active chat's group has been
 *   popped out to an auxiliary window, whose grid renders no accessories —
 *   the first main-layout group with chat tabs, or
 * - when the main layout has NO chat groups at all (the sole chat group was
 *   popped out), the first main-layout group of any kind. Without these
 *   fallbacks the scoped control would unmount entirely, leaving its archive
 *   UI unreachable while a chat was popped out.
 *
 * In the tab-strip variant a maximized group owns it outright,
 * since maximizing hides every other group, and groups inside a collapsed
 * branch are skipped, since the branch bar hides them.
 *
 * Every instance derives the same owner from the same layout snapshot, so
 * the single-instance invariant holds without cross-instance coordination.
 */
export const ChatGroupArchivedChatsAccessory = memo(
  function ChatGroupArchivedChatsAccessory({
    projectId,
    worktreeId,
    group,
    primarySurface,
    variant = 'header',
  }: ChatGroupArchivedChatsAccessoryProps): JSX.Element | null {
    const activeChatTabId = useWorktreeChatRenderState(
      `${projectId}/${worktreeId}`,
      (chatState) => chatState?.activeTabId ?? null,
    );
    const ownerGroupId = usePanelLayoutStore((s): string | null => {
      const layout =
        s.layouts[makeWorktreePanelKey(projectId, worktreeId)] ?? null;
      if (layout === null) return null;
      // Header-less scopes keep archive access when a maximize hides the
      // chat group:
      // the maximized group, the only one visible, owns it instead.
      if (
        variant === 'tabStrip' &&
        layout.maximizedGroupId !== null &&
        layout.groups[layout.maximizedGroupId] !== undefined
      ) {
        return layout.maximizedGroupId;
      }
      // A collapsed branch hides its groups behind a bar with no accessory
      // slot, so the tab-strip control must live in a group outside it.
      const hiddenGroupIds =
        variant === 'tabStrip'
          ? new Set(
              (layout.controller.getCollapsedBranches?.() ?? []).flatMap(
                (branch) => branch.groupIds,
              ),
            )
          : null;
      let firstGroupId: string | null = null;
      let firstChatGroupId: string | null = null;
      for (const [groupId, state] of Object.entries(layout.groups)) {
        if (hiddenGroupIds?.has(groupId) === true) continue;
        firstGroupId ??= groupId;
        const chatTabs = state.tabs.filter((tab) => tab.kind === 'chat');
        if (chatTabs.length === 0) continue;
        firstChatGroupId ??= groupId;
        if (
          activeChatTabId !== null &&
          chatTabs.some((tab) => tab.instance?.chatTabId === activeChatTabId)
        ) {
          return groupId;
        }
      }
      return firstChatGroupId ?? firstGroupId;
    });
    if (group.groupId !== ownerGroupId) {
      return null;
    }
    if (variant === 'tabStrip') {
      // No wrapper: the control renders nothing without archived chats, and
      // an empty wrapper would still carry the margin. Spaced and centered on
      // the title row like the Activity toggle.
      return (
        <ArchivedChatsControl
          scope={{ projectId, worktreeId }}
          primarySurface={primarySurface}
          variant="tabStrip"
          className="ml-1 inline-flex self-center last:mr-1"
        />
      );
    }
    return (
      <div className="flex shrink-0 items-center">
        <ArchivedChatsControl
          scope={{ projectId, worktreeId }}
          primarySurface={primarySurface}
        />
      </div>
    );
  },
);
