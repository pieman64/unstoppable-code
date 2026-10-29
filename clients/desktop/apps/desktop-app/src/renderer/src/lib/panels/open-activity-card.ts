import type { ActivitySectionId } from '@canopy/desktop-shared/types';
import {
  openContentPanel,
  type ContentPanelOpenResult,
} from './chat-panel-sync';

/**
 * Open one activity section as its own `activity-card` tab beside a chat:
 * in the chat's side group (a new group to its right when it has none), or
 * the Minimal Side Panel. A card already open for the section is revealed
 * where it is instead, because the section id is the card's identity.
 */
export function openActivityCardBesideChat(
  worktreeKey: string,
  section: { readonly id: ActivitySectionId; readonly title: string },
  originChatTabId: string,
): Promise<ContentPanelOpenResult> {
  return openContentPanel(
    worktreeKey,
    {
      kind: 'activity-card',
      panelId: `panel-activity-card-${section.id}`,
      title: section.title,
      instance: { sectionId: section.id },
    },
    { origin: { chatTabId: originChatTabId } },
  );
}
