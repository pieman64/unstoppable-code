import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useShallow } from 'zustand/shallow';
import type { SubagentTree } from '@canopy/agent-transcript';
import type { ManagedDelegationTreeEntry } from '@canopy/desktop-shared/types';
import type { SubagentTreeLoadState } from '@canopy/ui-app/subagents';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { useChatStore, type ChatMessage } from '@/stores/chatStore';
import { hydratedKeys } from '@/stores/chat/hydration';
import {
  acquireSubagentTree,
  getSubagentTreeSnapshot,
  subscribeSubagentTree,
  updateSubagentTreeRootChat,
} from './subagent-tree-store';
import type { SubagentHostScope } from './subagent-scope';

/** Shared, per-root query consumed by the Subagents and subagent-chat panels. */
export interface SubagentTreeQuery {
  readonly tree: SubagentTree | null;
  readonly treeState: SubagentTreeLoadState;
  readonly settled: boolean;
  readonly rootChatOpen: boolean;
  readonly hydrated: boolean;
  readonly managedEntries: ReadonlyMap<string, ManagedDelegationTreeEntry>;
}

export interface UseSubagentTreeOptions {
  readonly enabled: boolean;
}

interface RootChatProjection {
  readonly messages: readonly ChatMessage[] | null;
  readonly hydrated: boolean;
  readonly rootChatOpen: boolean;
  readonly title: string;
}

const EMPTY_PROJECTION: RootChatProjection = {
  messages: null,
  hydrated: false,
  rootChatOpen: false,
  title: '',
};

const NOOP_UNSUBSCRIBE = (): void => undefined;

/** Reads one root chat without subscribing to unrelated worktree chat updates. */
export function useSubagentTree(
  scope: SubagentHostScope | null,
  rootChatId: string | null,
  options: UseSubagentTreeOptions,
): SubagentTreeQuery {
  const enabled = options.enabled && scope !== null && rootChatId !== null;
  const projectId = scope?.projectId;
  const worktreeId = scope?.worktreeId;

  const projection = useChatStore(
    useShallow((state): RootChatProjection => {
      if (!enabled || projectId === undefined || worktreeId === undefined) {
        return EMPTY_PROJECTION;
      }
      const worktreeKey = `${projectId}/${worktreeId}`;
      const hydrated = hydratedKeys.has(worktreeKey);
      const tab = state.worktreeChats[worktreeKey]?.tabs.find(
        (candidate) => candidate.id === rootChatId && candidate.kind !== 'file',
      );
      const rootChatOpen = hydrated && tab !== undefined;
      return {
        messages: rootChatOpen && tab ? tab.messages : null,
        hydrated,
        rootChatOpen,
        title: rootChatOpen && tab ? getChatTabLabel(tab) : (rootChatId ?? ''),
      };
    }),
  );

  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (!enabled || !scope || !rootChatId) return NOOP_UNSUBSCRIBE;
      return subscribeSubagentTree(scope, rootChatId, listener);
    },
    [enabled, rootChatId, scope],
  );

  const getSnapshot = useCallback(
    () => getSubagentTreeSnapshot(scope, rootChatId),
    [rootChatId, scope],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !scope || !rootChatId) return undefined;
    return acquireSubagentTree(scope, rootChatId);
  }, [enabled, projectId, rootChatId, scope, worktreeId]);

  useEffect(() => {
    if (!enabled || !scope || !rootChatId) return;
    updateSubagentTreeRootChat(scope, rootChatId, projection);
  }, [enabled, projectId, projection, rootChatId, scope, worktreeId]);

  return snapshot;
}
