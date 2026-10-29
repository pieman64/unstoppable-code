import { useEffect } from 'react';
import type { RunCommentsUpdatedEvent } from '@canopy/desktop-shared/types';
import { maybeFireOsNotification } from '@/lib/osNotifications';
import { useChatStore } from '@/stores/chatStore';
import { openRunComments } from '@/stores/runCommentsStore';

/**
 * Bridges the main-process shared-run comment poller (CAN-397) into the
 * renderer: folds the new revision + unread count onto the tab's
 * `SharedRunMetadata` (which drives the unread badge on the share affordances)
 * and fires one OS notification per batch.
 *
 * The poller — not SSE — is the actual delivery mechanism in production today;
 * the `run.detail` realtime signal ships dark until CAN-486.
 */
export function useRunCommentUpdates(): void {
  useEffect(() => {
    const api = window.api?.runs;
    if (!api?.onCommentsUpdated) {
      return;
    }
    return api.onCommentsUpdated((event: RunCommentsUpdatedEvent): void => {
      const { projectId, worktreeId, chatId } = event;
      const store = useChatStore.getState();
      const tab = store.worktreeChats[`${projectId}/${worktreeId}`]?.tabs.find(
        (t) => t.id === chatId,
      );
      const sharedRun = tab && tab.kind !== 'file' ? tab.sharedRun : undefined;
      if (!tab || !sharedRun) {
        // The chat is no longer shared (or is not loaded); nothing to badge.
        return;
      }
      const chatTitle = tab.title;

      void store.setSharedRun(projectId, worktreeId, chatId, {
        ...sharedRun,
        commentRevision: event.commentRevision,
        unreadCommentCount: event.unreadCommentCount,
      });

      // Never notify a user about their own comment (e.g. a reply they just
      // posted from the web viewer), and never for an empty batch.
      if (event.ownCommentsOnly || event.unreadCommentCount <= 0) {
        return;
      }

      const count = event.unreadCommentCount;
      maybeFireOsNotification({
        category: 'Run Comment',
        title: 'New comment on your shared run',
        body:
          count === 1
            ? `1 new comment on “${chatTitle}”`
            : `${count} new comments on “${chatTitle}”`,
        projectId,
        worktreeId,
        chatId,
        onClick: (): void => {
          openRunComments({ projectId, worktreeId, chatId, title: chatTitle });
        },
      });
    });
  }, []);
}
