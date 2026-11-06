/**
 * CAN-4114: the desktop core composes chat commit projections;
 * `ChatStateService` stays their only source and the only chat writer.
 */
import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import type { ChatSearchService } from '../chat-search/service';
import {
  setChatTabsRequiredDurabilityObserver,
  setChatTabsWriteObserver,
  type ChatTabsWriteDelta,
} from '../lib/chat-tabs';
import {
  createChatTabsAuxiliaryProjectionObserver,
  type ChatTabsAuxiliaryProjectionSteps,
} from '../lib/chat-tabs-auxiliary-projection';

export type ChildSearchDirtyEvent = Parameters<
  ChatSearchService['childSearchDirty']
>[0];

/** The search index operations the core projection calls. */
export type CoreChatProjectionSearch = Pick<
  ChatSearchService,
  'projectLiveTabs' | 'indexWorktreeArchives' | 'childSearchDirty'
>;

export interface CoreChatProjectionHost {
  /** Resolved on each use so the index opens lazily, as today. */
  search(): CoreChatProjectionSearch;
  subscribeChildSearchDirty(
    listener: (event: ChildSearchDirtyEvent) => void,
  ): () => void;
  /** The required activity watermark, awaited under the commit's reservation. */
  touchTargetAfterCommit(projectId: string, worktreeId: string): Promise<void>;
  /** Every step except search, which the core composes. */
  steps: Omit<ChatTabsAuxiliaryProjectionSteps, 'indexSearch'>;
}

export interface CoreChatProjections {
  /** Removes both observers and the child-search subscription. */
  uninstall(): void;
}

let installed = false;

/** D4: whether a projected commit can have changed the scope's archived chats. */
export function shouldReindexArchives(
  previousTabIds: ReadonlySet<string> | undefined,
  data: ChatTabsFile,
  delta: ChatTabsWriteDelta | undefined,
): boolean {
  void data;
  if (delta === undefined || previousTabIds === undefined) return true;
  if (delta.removedTabIds.length > 0) return true;
  return delta.changedTabIds.some((tabId) => !previousTabIds.has(tabId));
}

/** Installs the post-commit projections. Throws when already installed. */
export function installCoreChatProjections(
  host: CoreChatProjectionHost,
): CoreChatProjections {
  if (installed) {
    throw new Error('Core chat projections are already installed.');
  }
  installed = true;
  const knownTabIds = new Map<string, ReadonlySet<string>>();

  const unsubscribe = host.subscribeChildSearchDirty((event) =>
    host.search().childSearchDirty(event),
  );

  setChatTabsRequiredDurabilityObserver(async (projectId, worktreeId) => {
    await host.touchTargetAfterCommit(projectId, worktreeId);
  });

  const indexSearch: ChatTabsAuxiliaryProjectionSteps['indexSearch'] = (
    projectId,
    worktreeId,
    data,
    delta,
    isCurrent,
  ) => {
    const key = `${projectId}\u0000${worktreeId}`;
    const previous = knownTabIds.get(key);
    let projected: ReturnType<CoreChatProjectionSearch['projectLiveTabs']>;
    try {
      const search = host.search();
      if (shouldReindexArchives(previous, data, delta)) {
        search.indexWorktreeArchives(projectId, worktreeId);
      }
      // Partial persistence identifies exactly which tabs changed. Applying the
      // same delta to search avoids rebuilding FTS for large, unchanged
      // transcripts while keeping concurrent rename/close operations correct.
      projected = search.projectLiveTabs(
        projectId,
        worktreeId,
        data,
        delta,
        isCurrent,
      );
    } catch (error) {
      knownTabIds.delete(key);
      throw error;
    }
    knownTabIds.set(key, new Set(data.tabs.map((tab) => tab.id)));
    return projected;
  };

  setChatTabsWriteObserver(
    createChatTabsAuxiliaryProjectionObserver({ ...host.steps, indexSearch }),
  );

  let active = true;
  return {
    uninstall(): void {
      if (!active) return;
      active = false;
      unsubscribe();
      setChatTabsWriteObserver(null);
      setChatTabsRequiredDurabilityObserver(null);
      knownTabIds.clear();
      installed = false;
    },
  };
}
