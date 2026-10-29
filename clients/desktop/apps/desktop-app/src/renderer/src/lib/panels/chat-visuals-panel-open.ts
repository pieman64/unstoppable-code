import { requestChatVisualReveal, type ChatVisualOwner } from '@canopy/ui-app';
import {
  CHAT_VISUALS_PANEL_KIND,
  CHAT_VISUALS_PANEL_TITLE,
  findPanelByInstanceKey,
  getPanelInstanceKey,
  makeWorktreePanelKey,
  rebindChatVisualsPanel,
} from '@canopy/ui-app/panel-layout-store';
import { desktopChatVisualsKey } from '@/lib/desktop-chat-visuals-key';
import {
  openContentPanel,
  type ContentPanelOpenResult,
} from './chat-panel-sync';

export interface DesktopChatVisualScope {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * The outcome of opening the Chat visuals panel: the content-panel opener's,
 * or `missing-chat` when the chat has no panel in the layout to open beside.
 */
export type DesktopChatVisualsPanelOpenResult =
  | ContentPanelOpenResult
  | { readonly status: 'missing-chat' };

/**
 * Shows a chat's visuals in its worktree's Chat visuals panel. The panel
 * opens the way a file opened from the chat does: beside the chat in an
 * Advanced layout, in the Side Panel in a Minimal one. There is one panel per
 * worktree, so an open one is pointed at this chat and revealed.
 */
export async function openDesktopChatVisualsPanel(
  scope: DesktopChatVisualScope,
): Promise<DesktopChatVisualsPanelOpenResult> {
  const worktreeKey = makeWorktreePanelKey(scope.projectId, scope.worktreeId);
  const chat = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({
      kind: 'chat',
      instance: { chatTabId: scope.chatId },
    }),
  );
  if (chat === null) return { status: 'missing-chat' };
  // One panel per worktree: point an open one at this chat before revealing it.
  rebindChatVisualsPanel(worktreeKey, scope.chatId);
  return openContentPanel(
    worktreeKey,
    {
      kind: CHAT_VISUALS_PANEL_KIND,
      panelId: `panel-chat-visuals-${worktreeKey}`,
      title: CHAT_VISUALS_PANEL_TITLE,
      instance: { chatId: scope.chatId },
    },
    // A visual renders only in the main window, so a chat popped out into
    // an auxiliary window gets its panel in the main window's layout.
    chat.layoutKey === worktreeKey
      ? { origin: { chatTabId: scope.chatId } }
      : {},
  );
}

/**
 * Shows a chat's visuals in its worktree's Chat visuals panel, scrolled to
 * one of them.
 *
 * Resolves false when the chat has no panel in a layout, as in an archived
 * transcript, or when no group takes the Chat visuals panel, so the caller
 * can show the visual in a dialog instead.
 */
export async function expandDesktopChatVisual(
  scope: DesktopChatVisualScope,
  owner: ChatVisualOwner,
): Promise<boolean> {
  const result = await openDesktopChatVisualsPanel(scope);
  if (result.status !== 'placed' && result.status !== 'revealed') return false;
  requestChatVisualReveal(desktopChatVisualsKey(scope), owner.toolUseId);
  return true;
}
