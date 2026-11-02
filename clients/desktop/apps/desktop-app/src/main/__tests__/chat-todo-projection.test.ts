import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: {
    read: jest.fn(),
  },
}));

import {
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import {
  listWorktreeTodoEntities,
  projectChatTodoFromMessages,
  projectWorktreeChatSummaries,
  projectWorktreeChatSummariesStrict,
  projectWorktreeChatTodoRemovals,
  projectWorktreeChatTodos,
  projectWorktreeChatTodosStrict,
} from '../services/chat-service';
import { portalChatTabsCache } from '../services/portal-chat-tabs-cache';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const mockedEnqueuePortalEvent = jest.mocked(enqueuePortalEvent);
const mockedIsCanopyPortalActive = jest.mocked(isCanopyPortalActive);
const mockedPortalChatTabsCache = jest.mocked(portalChatTabsCache);

function todoMessage(id: string, content: string): PersistedChatMessage {
  return {
    id: `message-${id}`,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: `tool-${id}`,
        toolName: 'TodoWrite',
        input: JSON.stringify({
          todos: [{ id, content, status: 'pending' }],
        }),
      },
    ],
  };
}

describe('worktree chat TODO projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsCanopyPortalActive.mockReturnValue(true);
    registerWorkspaceTypes(new Map());
  });

  it('projects one isolated row for every active and inactive chat tab', async () => {
    mockedPortalChatTabsCache.read.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-active',
      tabs: [
        {
          id: 'chat-active',
          title: 'Active',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [todoMessage('active', 'Active TODO')],
        },
        {
          id: 'chat-inactive',
          title: 'Inactive',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [todoMessage('inactive', 'Inactive TODO')],
        },
      ],
    });

    await expect(
      listWorktreeTodoEntities({
        workspaceId: 'workspace-1',
        worktreeId: 'tree-1',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        chatId: 'chat-active',
        items: [
          {
            id: 'todo:active',
            content: 'Active TODO',
            status: 'pending',
          },
        ],
      }),
      expect.objectContaining({
        chatId: 'chat-inactive',
        items: [
          {
            id: 'todo:inactive',
            content: 'Inactive TODO',
            status: 'pending',
          },
        ],
      }),
    ]);
  });

  it('suppresses identical re-projections using the persisted-message fingerprint', () => {
    const target = {
      workspaceId: 'workspace-2',
      worktreeId: 'tree-2',
      chatId: 'chat-fingerprint',
    };
    const persistedMessages = [todoMessage('one', 'First')];

    projectChatTodoFromMessages({
      ...target,
      messages: persistedMessages,
    });
    // Re-projecting the same persisted messages produces the same fingerprint,
    // so repeated save paths must not emit duplicate state deltas.
    projectChatTodoFromMessages({
      ...target,
      messages: persistedMessages,
    });
    projectChatTodoFromMessages({
      ...target,
      messages: persistedMessages,
    });

    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(1);
    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      type: 'portal.state.delta',
      payload: {
        scope: 'chat',
        target: {
          workspaceLocalId: 'workspace-2',
          worktreeLocalId: 'tree-2',
          chatLocalId: 'chat-fingerprint',
        },
        entities: [
          {
            entityType: 'chat_todo',
            localId: 'chat-fingerprint',
            parentLocalId: 'workspace-2:tree-2',
            payload: {
              items: [
                {
                  id: 'todo:one',
                  content: 'First',
                  status: 'pending',
                },
              ],
            },
          },
        ],
      },
    });
  });

  it('removes closed tabs and skips all persisted projection work without a portal session', async () => {
    projectWorktreeChatTodoRemovals({
      workspaceId: 'workspace-3',
      worktreeId: 'tree-3',
      removedChatIds: ['chat-closed'],
    });
    expect(mockedEnqueuePortalEvent.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        removed: [
          {
            entityType: 'chat_todo',
            localId: 'chat-closed',
            parentLocalId: 'workspace-3:tree-3',
          },
        ],
      },
    });

    jest.clearAllMocks();
    mockedIsCanopyPortalActive.mockReturnValue(false);
    await projectWorktreeChatTodos({
      workspaceId: 'workspace-3',
      worktreeId: 'tree-3',
    });

    expect(mockedPortalChatTabsCache.read.mock.calls).toHaveLength(0);
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });

  it('skips persisted projection work for a registered cowork project', async () => {
    registerWorkspaceTypes(new Map([['cowork-workspace-1', 'cowork']]));

    await projectWorktreeChatTodos({
      workspaceId: 'cowork-workspace-1',
      worktreeId: 'cowork-project',
    });

    expect(mockedPortalChatTabsCache.read.mock.calls).toHaveLength(0);
    expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['TODO', projectWorktreeChatTodos, projectWorktreeChatTodosStrict],
    [
      'summary',
      projectWorktreeChatSummaries,
      projectWorktreeChatSummariesStrict,
    ],
  ])(
    'rejects a failed %s read only for the post-commit projection',
    async (_label, bestEffort, strict) => {
      const failure = new Error('chat tabs unreadable');
      const target = { workspaceId: 'workspace-4', worktreeId: 'tree-4' };
      mockedPortalChatTabsCache.read.mockRejectedValueOnce(failure);
      await expect(bestEffort(target)).resolves.toBeUndefined();
      mockedPortalChatTabsCache.read.mockRejectedValueOnce(failure);
      await expect(strict(target)).rejects.toBe(failure);
      expect(mockedEnqueuePortalEvent).not.toHaveBeenCalled();
    },
  );

  it('re-emits a TODO on retry after its emit failed', async () => {
    const target = { workspaceId: 'workspace-5', worktreeId: 'tree-5' };
    mockedPortalChatTabsCache.read.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-retry',
      tabs: [
        {
          id: 'chat-retry',
          title: 'Retry',
          createdAt: '2026-01-01T00:00:00.000Z',
          messages: [todoMessage('retry', 'Retried TODO')],
        },
      ],
    });
    const failure = new Error('Portal sink failed');
    mockedEnqueuePortalEvent.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(projectWorktreeChatTodosStrict(target)).rejects.toBe(failure);
    await expect(
      projectWorktreeChatTodosStrict(target),
    ).resolves.toBeUndefined();
    expect(mockedEnqueuePortalEvent).toHaveBeenCalledTimes(2);
    expect(mockedEnqueuePortalEvent.mock.calls[1]?.[0]).toMatchObject({
      payload: { target: { chatLocalId: 'chat-retry' } },
    });
  });
});
