/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { CanopyClientProvider } from '@canopy/app-state';
import { CompactQueueProvider } from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatTab } from '@/stores/chatStore';
import type { ScheduledQueuedMessage } from '@/lib/worktreeSessionPromptAutomations';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatState: {
  selectedWorktree: { projectId: string; worktreeId: string };
  worktreeChats: Record<
    string,
    { activeTabId: string; tabs: Array<Partial<ChatTab>> }
  >;
  runtimeByChatId: Record<string, never>;
  pendingQuestions: Record<string, never>;
  pendingApprovals: Record<string, never>;
} = {
  selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
  worktreeChats: {
    'project/worktree': {
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', messages: [] }],
    },
  },
  runtimeByChatId: {},
  pendingQuestions: {},
  pendingApprovals: {},
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

const scheduled: ScheduledQueuedMessage = {
  automationId: 'automation-1',
  activityName: 'Later',
  chatId: 'chat-1',
  scheduleKind: 'one_time',
  scheduledAt: '2099-01-01T09:00:00.000Z',
  text: 'scheduled follow-up',
};

function renderList(
  editing: {
    editingQueuedMessageIndex?: number;
    editingScheduledMessageId?: string;
  },
  compactQueue = false,
): Document {
  const html = renderToStaticMarkup(
    <CanopyClientProvider client={ipcCanopyClient}>
      <CompactQueueProvider value={compactQueue}>
        <ChatMessageList
          messages={[]}
          queuedMessages={[
            { text: 'first queued', hostQueueEntryId: 'q1' },
            { text: 'second queued', hostQueueEntryId: 'q2' },
          ]}
          chatId="chat-1"
          onClearQueuedMessage={jest.fn()}
          onEditQueuedMessage={jest.fn()}
          scheduledMessages={[scheduled]}
          onEditScheduledMessage={jest.fn()}
          {...editing}
        />
      </CompactQueueProvider>
    </CanopyClientProvider>,
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

function editButtons(doc: Document): string[] {
  return Array.from(
    doc.querySelectorAll('[data-testid="queued-message-edit"]'),
    (button) => button.getAttribute('aria-label') ?? '',
  );
}

describe('ChatMessageList with one editor in the composer place', () => {
  it('offers Edit on every queued and scheduled row when nothing is edited', () => {
    expect(editButtons(renderList({}))).toEqual([
      'Edit queued message',
      'Edit queued message',
      'Edit scheduled message',
    ]);
  });

  it('offers no other Edit while a queued message is edited', () => {
    const doc = renderList({ editingQueuedMessageIndex: 0 });
    expect(doc.body.textContent).not.toContain('first queued');
    expect(editButtons(doc)).toEqual([]);
  });

  it('offers no other Edit while a scheduled message is edited', () => {
    const doc = renderList({ editingScheduledMessageId: 'automation-1' });
    expect(doc.body.textContent).not.toContain('scheduled follow-up');
    expect(editButtons(doc)).toEqual([]);
  });

  it('offers Edit again once the scheduled message being edited is gone', () => {
    // The scheduled message fired or was deleted while its editor was open,
    // so its editor closed; the queue must not stay locked by its id.
    const doc = renderList({ editingScheduledMessageId: 'automation-gone' });
    expect(editButtons(doc)).toEqual([
      'Edit queued message',
      'Edit queued message',
      'Edit scheduled message',
    ]);
  });

  it('leaves the edited message out of the compact queue list', () => {
    const doc = renderList({ editingQueuedMessageIndex: 0 }, true);
    const list = doc.querySelector('[aria-label="Queued messages"]');
    expect(list?.textContent).toContain('second queued');
    expect(doc.body.textContent).not.toContain('first queued');
    // The editor is the host's, in the composer's place, not in the list.
    expect(
      doc.querySelector('[data-testid="queued-message-editor"]'),
    ).toBeNull();
  });
});
