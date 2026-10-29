/**
 * Chat-tab → panel binding vocabulary shared by the default-layout builder
 * and the chat ⇄ panel sync bridge.
 *
 * One chatStore tab maps to exactly one per-entity panel:
 * - chat tabs   → kind `chat`,      instance `{ chatTabId }`
 * - file tabs   → kind `file-diff`, instance `{ fileTabId, filePath }`
 *
 * Panel ids are DERIVED from the chat tab id (`panel-chat-<id>` /
 * `panel-file-<id>`) so bound panels are deterministically addressable —
 * UI automation selects `panel-tab-panel-chat-<chatTabId>` without
 * discovering generated ids, and the default layout and the sync bridge
 * mint identical ids for the same tab.
 *
 * This module exists (instead of living in chat-panel-sync.ts) so
 * default-layout.ts can import it without creating a module cycle with the
 * bridge.
 */
import type { PanelKind } from '@canopy/protocol';
import type { ChatTab } from '@/stores/chatStore';

/** The deterministic panel id for a chatStore tab's bound panel. */
export function panelIdForChatTab(tab: Pick<ChatTab, 'id' | 'kind'>): string {
  return tab.kind === 'file' ? `panel-file-${tab.id}` : `panel-chat-${tab.id}`;
}

/** One chatStore tab's full panel seed (kind + instance + title + id). */
export interface ChatTabPanelSeed {
  readonly kind: PanelKind;
  readonly panelId: string;
  readonly instance: Readonly<Record<string, string>>;
  readonly title: string;
}

/** The panel seed (kind + instance + title + panel id) for one chat tab. */
export function chatTabToPanelSeed(tab: ChatTab): ChatTabPanelSeed {
  if (tab.kind === 'file') {
    return {
      kind: 'file-diff',
      panelId: panelIdForChatTab(tab),
      instance: {
        fileTabId: tab.id,
        ...(tab.filePath !== undefined ? { filePath: tab.filePath } : {}),
      },
      title: tab.title,
    };
  }
  return {
    kind: 'chat',
    panelId: panelIdForChatTab(tab),
    instance: { chatTabId: tab.id },
    title: tab.title,
  };
}
