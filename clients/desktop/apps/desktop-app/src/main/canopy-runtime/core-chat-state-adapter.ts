import type {
  CanopyQueryHandlerMap,
  CanopyQueryResult,
  CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import type {
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatRuntimeStatus,
} from '@canopy/desktop-shared/types';
import {
  CanopyOperationError,
  canopyCapabilityUnavailableError,
  canopyInvalidArgumentError,
  canopyInternalError,
} from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';
import { chatDisplayLabel } from '@canopy/protocol';

export interface ChatStateProjectionCapture {
  captureState(result: ChatStateSnapshot): void;
}

type ChatStateQueries = Pick<
  CanopyQueryHandlerMap,
  'core.chat.snapshot.get' | 'core.chat.list'
>;
type CoreChatSnapshotGetResult = CanopyQueryResult<'core.chat.snapshot.get'>;
type CoreChatListResult = CanopyQueryResult<'core.chat.list'>;

function requireLocalScope(scope: CanopyWorkspaceScope): void {
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  ) {
    throw canopyCapabilityUnavailableError(
      'The selected chat authority or target is unavailable.',
    );
  }
}

function projectSnapshot(
  snapshot: ChatStateSnapshot,
  chatId?: string,
): CoreChatSnapshotGetResult {
  const selectedTabs = chatId
    ? snapshot.tabsFile.tabs.filter((tab) => tab.id === chatId)
    : snapshot.tabsFile.tabs;
  const selectedArchives = chatId
    ? snapshot.archives.filter((archive) => archive.chatId === chatId)
    : snapshot.archives;
  const runtimeByChatId: CoreChatSnapshotGetResult['runtimeByChatId'] = {};
  for (const [id, runtime] of Object.entries(snapshot.runtimeByChatId)) {
    if (chatId && id !== chatId) continue;
    runtimeByChatId[id] = {
      status: runtime.status,
      queuedMessageIds: runtime.queuedMessageIds,
      ...(runtime.lastActivityAt === undefined
        ? {}
        : { lastActivityAt: runtime.lastActivityAt }),
    };
  }
  return {
    workspaceId: snapshot.projectId,
    worktreeId: snapshot.worktreeId,
    revision: snapshot.revision,
    tabs: {
      activeTabId: snapshot.tabsFile.activeTabId,
      items: selectedTabs.map((tab) => ({
        chatId: tab.id,
        title: chatDisplayLabel({
          customTitle: tab.customTitle,
          fallback: tab.title,
        }),
        kind: tab.kind ?? 'chat',
        createdAt: tab.createdAt,
        ...(tab.unread === undefined ? {} : { unread: tab.unread }),
        ...(tab.providerType === undefined
          ? {}
          : { providerId: tab.providerType }),
      })),
    },
    archives: selectedArchives.map((archive) => ({
      chatId: archive.chatId,
      title: chatDisplayLabel({
        customTitle: archive.customTitle,
        fallback: archive.title,
      }),
      archivedAt: archive.archivedAt,
      createdAt: archive.createdAt,
      turnCount: archive.turnCount,
      unread: archive.unread,
      restorable: archive.restorable,
    })),
    runtimeByChatId,
    queue: snapshot.queue
      .filter((item) => !chatId || item.chatId === chatId)
      .map((item) => ({
        chatId: item.chatId,
        entries: item.queue.map((entry) => ({
          id: entry.id,
          origin: entry.origin,
          enqueuedAtMs: entry.enqueuedAtMs,
        })),
      })),
  };
}

function listState(
  status: ChatRuntimeStatus | undefined,
): CoreChatListResult['items'][number]['state'] {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'starting':
    case 'streaming':
    case 'completing':
      return 'running';
    case 'awaiting_input':
      return 'awaiting_user';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

export function createCoreChatStateAdapter(
  getPort: () => ChatStateCommandPort | null,
  capture?: ChatStateProjectionCapture,
): ChatStateQueries {
  return {
    'core.chat.snapshot.get': async (
      params,
    ): Promise<CoreChatSnapshotGetResult> => {
      requireLocalScope(params.scope);
      const port = getPort();
      if (!port) throw new Error('Chat state service is unavailable.');
      let snapshot: ChatStateSnapshot;
      try {
        snapshot = await port.getState({
          projectId: params.scope.workspaceId,
          worktreeId: params.scope.worktreeId,
        });
      } catch (error) {
        throw canopyInternalError('Chat state read failed.', error);
      }
      capture?.captureState(snapshot);
      return projectSnapshot(snapshot, params.chatId);
    },
    'core.chat.list': async (params): Promise<CoreChatListResult> => {
      requireLocalScope(params.scope);
      const port = getPort();
      if (!port) throw new Error('Chat state service is unavailable.');
      const snapshot = await port.getState({
        projectId: params.scope.workspaceId,
        worktreeId: params.scope.worktreeId,
      });
      const cursorParts = params.cursor?.match(/^(0|[1-9]\d*):(0|[1-9]\d*)$/);
      const cursorRevision = cursorParts ? Number(cursorParts[1]) : 0;
      const offset = cursorParts ? Number(cursorParts[2]) : 0;
      if (
        (params.cursor !== undefined && cursorParts === null) ||
        !Number.isSafeInteger(cursorRevision) ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw canopyInvalidArgumentError('Invalid chat list cursor.');
      if (cursorParts && cursorRevision !== snapshot.revision)
        throw new CanopyOperationError({
          kind: 'conflict',
          message: 'Chat list changed; restart from the first page.',
          retry: { kind: 'never' },
        });
      const pageSize = params.pageSize ?? 100;
      const items: CoreChatListResult['items'] = [
        ...snapshot.tabsFile.tabs
          .filter((tab) => (tab.kind ?? 'chat') === 'chat')
          .map((tab) => ({
            chatId: tab.id,
            workspaceId: snapshot.projectId,
            worktreeId: snapshot.worktreeId,
            title: chatDisplayLabel({
              customTitle: tab.customTitle,
              fallback: tab.title,
            }),
            state: listState(snapshot.runtimeByChatId[tab.id]?.status),
            revision: snapshot.revision,
            createdAt: tab.createdAt,
            ...(tab.providerType === undefined
              ? {}
              : { providerId: tab.providerType }),
            ...(tab.model === undefined ? {} : { modelId: tab.model }),
          })),
        ...snapshot.archives.map((archive) => ({
          chatId: archive.chatId,
          workspaceId: snapshot.projectId,
          worktreeId: snapshot.worktreeId,
          title: chatDisplayLabel({
            customTitle: archive.customTitle,
            fallback: archive.title,
          }),
          state: 'archived' as const,
          revision: snapshot.revision,
          createdAt: archive.createdAt,
        })),
      ];
      const page = items.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      return {
        items: page,
        nextCursor:
          nextOffset < items.length
            ? `${snapshot.revision}:${nextOffset}`
            : null,
      };
    },
  };
}
