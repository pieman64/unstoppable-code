import type { ChatReadSelection } from './chat-state-v2-backend';
import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';

/** Portal reads metadata by default and explicitly selects a bounded page for
 * a requested chat. The repository owns freshness and transcript isolation. */
export interface PortalChatTabsCache {
  read(
    workspaceId: string,
    worktreeId: string,
    selection?: ChatReadSelection,
  ): Promise<ChatTabsFile>;
}

/** Shared instance for the portal snapshot read paths. */
export const portalChatTabsCache: PortalChatTabsCache = {
  read: (workspaceId, worktreeId, selection) =>
    readChatTabsFile(workspaceId, worktreeId, selection),
};
