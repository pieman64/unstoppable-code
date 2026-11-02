import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { CanopyClientProvider } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage, ChatTab } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

let mockChatState: {
  selectedWorktree: { projectId: string; worktreeId: string };
  worktreeChats: Record<
    string,
    { activeTabId: string; tabs: Array<Partial<ChatTab>> }
  >;
  runtimeByChatId: Record<string, never>;
  pendingQuestions: Record<string, never>;
  pendingApprovals: Record<string, never>;
};

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown): unknown =>
    selector(mockChatState),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => mockChatState),
}));

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, never>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

// Placement is covered by ChatMessageList.active-turn-render-count; here no
// run is live, so the pinned section renders no run cards.
jest.mock('../useLiveAgentRunKeys', () => ({
  useLiveAgentRunKeys: (): ReadonlySet<string> => new Set(),
}));
jest.mock('../TurnGroupRenderer', () => ({
  TurnGroupRenderer: ({
    group,
  }: {
    group: {
      userMessage: { id: string };
      assistantMessages: Array<{ id: string }>;
    };
  }): JSX.Element => (
    <div data-testid={`turn-${group.userMessage.id}`}>
      turn:{group.userMessage.id}
      {group.assistantMessages.map((response) => (
        <span key={response.id} data-testid={`response-${response.id}`} />
      ))}
    </div>
  ),
}));

jest.mock('../ChatMessageItem', () => ({
  ChatMessageItem: ({ message }: { message: ChatMessage }): JSX.Element => (
    <div data-testid={`message-${message.id}`}>
      message:{message.id}
      {message.blocks.map((block, index) =>
        block.type === 'text' ? <span key={index}>{block.text}</span> : null,
      )}
    </div>
  ),
}));

jest.mock('../QueuedMessageBubble', () => ({
  QueuedMessageBubble: (): JSX.Element => <div />,
}));

function message(
  id: string,
  role: 'user' | 'assistant' | 'system',
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return { id, role, blocks, timestamp: 1 };
}

function textMessage(
  id: string,
  role: 'user' | 'assistant' | 'system',
  text: string,
): ChatMessage {
  return message(id, role, [{ type: 'text', text }]);
}

function timerMessage(id: string): ChatMessage {
  return message(id, 'system', [
    { type: 'turn_timer', startedAt: 1, completedAt: 2 },
  ]);
}

function legacySetupAnnotation(id: string): ChatMessage {
  return message(id, 'system', [{ type: 'pending_setup_info', timestamp: 1 }]);
}

function renderList(messages: ChatMessage[]): string {
  mockChatState = {
    selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
    worktreeChats: {
      'project/worktree': {
        activeTabId: 'chat-1',
        tabs: [{ id: 'chat-1' }],
      },
    },
    runtimeByChatId: {},
    pendingQuestions: {},
    pendingApprovals: {},
  };

  return renderToStaticMarkup(
    <CanopyClientProvider client={ipcCanopyClient}>
      <ChatMessageList
        messages={messages}
        queuedMessages={[]}
        chatId="chat-1"
        onClearQueuedMessage={jest.fn()}
      />
    </CanopyClientProvider>,
  );
}

// CAN-4981: older transcripts persisted a "Chat initiated before project
// setup" annotation. It no longer renders, and must leave no row behind.
describe('ChatMessageList legacy setup annotation', () => {
  it('renders no row for an annotation-only system message above the prompt', () => {
    const html = renderList([
      legacySetupAnnotation('legacy-setup'),
      textMessage('user-1', 'user', 'First prompt'),
      textMessage('assistant-1', 'assistant', 'First answer'),
      timerMessage('timer-1'),
    ]);

    expect(html).not.toContain('legacy-setup');
    expect(html).toContain('data-testid="turn-user-1"');
    // The prompt's section is the first row: no empty wrapper precedes it.
    expect(html).toMatch(
      /data-testid="chat-message-list-content"[^>]*><div class="space-y-2"><div data-chat-sticky-section="user-1"/,
    );
  });

  it('keeps a message that holds meaningful content beside the annotation', () => {
    const html = renderList([
      message('mixed', 'system', [
        { type: 'pending_setup_info', timestamp: 1 },
        { type: 'text', text: 'Setup note' },
      ]),
      textMessage('user-1', 'user', 'First prompt'),
      timerMessage('timer-1'),
    ]);

    expect(html).toContain('data-testid="message-mixed"');
    expect(html).toContain('Setup note');
  });

  it('keeps adjacent system, user, and assistant messages in order', () => {
    const html = renderList([
      textMessage('system-1', 'system', 'Earlier notice'),
      legacySetupAnnotation('legacy-setup'),
      textMessage('user-1', 'user', 'First prompt'),
      legacySetupAnnotation('legacy-setup-in-turn'),
      textMessage('assistant-1', 'assistant', 'First answer'),
      timerMessage('timer-1'),
    ]);

    expect(html).not.toContain('legacy-setup');
    const systemIndex = html.indexOf('data-testid="message-system-1"');
    const turnIndex = html.indexOf('data-testid="turn-user-1"');
    expect(systemIndex).toBeGreaterThanOrEqual(0);
    expect(turnIndex).toBeGreaterThan(systemIndex);
    expect(html).toContain('data-testid="response-assistant-1"');
  });
});
