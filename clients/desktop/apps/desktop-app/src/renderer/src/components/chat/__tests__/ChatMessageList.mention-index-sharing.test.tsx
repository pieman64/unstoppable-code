/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports -- jsdom has no TextEncoder to size agent artifact receipts.
import { TextEncoder as NodeTextEncoder } from 'node:util';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as ReactNamespace from 'react';
import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockFilePathMentionIndexes: Record<string, unknown> = {};
const mockFileIndexEntry = {
  data: {
    repos: [
      {
        repoId: 'repo-sharing',
        repoName: 'repo-sharing',
        absolutePath: '/workspace/repo-sharing',
        rootKind: 'git-repo',
        files: [
          {
            relativePath: 'src/Shared.tsx',
            filename: 'Shared.tsx',
            absolutePath: '/workspace/repo-sharing/src/Shared.tsx',
            isIgnored: false,
          },
        ],
      },
    ] satisfies RepoFileIndex[],
  },
  fetchedAt: 1,
};

jest.mock('@/stores/chatStore', () => {
  const mockState = (): unknown => ({
    selectedWorktree: {
      projectId: 'project-sharing',
      worktreeId: 'worktree-sharing',
    },
    worktreeChats: {
      'project-sharing/worktree-sharing': {
        activeTabId: 'chat-one',
        tabs: [{ id: 'chat-one' }, { id: 'chat-two' }],
      },
    },
    pendingQuestions: {},
    pendingApprovals: {},
    runtimeByChatId: {},
  });
  return {
    useChatStore: (selector: (state: unknown) => unknown): unknown =>
      selector(mockState()),
    ...jest
      .requireActual<
        typeof ChatRenderStoresTestUtils
      >('@/test-utils/chatRenderStores')
      .mockChatRenderHooks(mockState),
  };
});

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, typeof mockFileIndexEntry>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {
        'project-sharing/worktree-sharing': mockFileIndexEntry,
      },
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

jest.mock('../ForkedFromLink', () => ({ ForkedFromLink: (): null => null }));
jest.mock('../TurnGroupRenderer', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  const TurnGroupRenderer = react.memo(function TurnGroupRenderer({
    chatId,
    filePathMentionIndex,
  }: {
    chatId: string;
    filePathMentionIndex: unknown;
  }): JSX.Element {
    mockFilePathMentionIndexes[chatId] = filePathMentionIndex;
    return react.createElement('div', { 'data-chat-id': chatId });
  });
  return { TurnGroupRenderer };
});
jest.mock('../ChatMessageItem', () => ({ ChatMessageItem: (): null => null }));
jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): null => null,
}));
jest.mock('../QueuedMessageEditor', () => ({
  QueuedMessageEditor: (): null => null,
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.assign(globalThis, { TextEncoder: NodeTextEncoder });

const messages: ChatMessage[] = [
  {
    id: 'user-sharing',
    role: 'user',
    blocks: [{ type: 'text', text: 'Open src/Shared.tsx' }],
    timestamp: 1,
  },
  {
    id: 'assistant-sharing',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Done' }],
    timestamp: 2,
  },
  {
    id: 'timer-sharing',
    role: 'system',
    blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 2 }],
    timestamp: 3,
  },
];

let mountedRoot: Root | undefined;

beforeEach(() => {
  globalThis.ResizeObserver = TestResizeObserver;
  for (const chatId of Object.keys(mockFilePathMentionIndexes)) {
    delete mockFilePathMentionIndexes[chatId];
  }
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = undefined;
  }
  document.body.innerHTML = '';
});

describe('ChatMessageList file-path mention index sharing', () => {
  it('shares one file-path mention index across chats in the same worktree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountedRoot = createRoot(host);

    act(() => {
      // The list stops native tasks through the client (turn-state D5).
      mountedRoot?.render(
        <CanopyClientProvider client={ipcCanopyClient}>
          {['chat-one', 'chat-two'].map((chatId) => (
            <ChatMessageList
              key={chatId}
              messages={messages}
              queuedMessages={[]}
              chatId={chatId}
              transcriptTurns={[]}
              targetOverride={{
                projectId: 'project-sharing',
                worktreeId: 'worktree-sharing',
                chatId,
              }}
              onClearQueuedMessage={(): void => undefined}
            />
          ))}
        </CanopyClientProvider>,
      );
    });

    const firstIndex = mockFilePathMentionIndexes['chat-one'];
    const secondIndex = mockFilePathMentionIndexes['chat-two'];
    expect(firstIndex).toBeDefined();
    expect(secondIndex).toBeDefined();
    expect(firstIndex).not.toBeNull();
    expect(secondIndex).not.toBeNull();
    expect(firstIndex).toBe(secondIndex);
  });
});
