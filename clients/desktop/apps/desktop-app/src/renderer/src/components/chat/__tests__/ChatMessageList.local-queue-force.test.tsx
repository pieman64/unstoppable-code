/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import { CanopyClientProvider } from '@canopy/app-state';
import { CompactQueueProvider } from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatTab } from '@/stores/chatStore';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatState: {
  selectedWorktree: { projectId: string; worktreeId: string };
  worktreeChats: Record<
    string,
    { activeTabId: string; tabs: Array<Partial<ChatTab>> }
  >;
  runtimeByChatId: Record<string, ChatRuntimeState>;
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

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

type TabTurn = Pick<
  Partial<ChatTab>,
  'status' | 'error' | 'sendingLease' | 'pendingTurn'
>;

const pendingLease: ChatTab['sendingLease'] = {
  userMessageId: 'user-1',
  kind: 'send',
  issuedAt: NOW - 1_000,
  deadline: NOW + 14_000,
  state: 'pending',
};

function renderList(
  turn: TabTurn,
  queuedMessages: ChatTab['queuedMessages'],
  compactQueue: boolean,
  runtime?: ChatRuntimeState,
): Document {
  mockChatState.runtimeByChatId = runtime ? { 'chat-1': runtime } : {};
  mockChatState.worktreeChats['project/worktree'] = {
    activeTabId: 'chat-1',
    tabs: [{ id: 'chat-1', messages: [], status: 'idle', ...turn }],
  };
  const html = renderToStaticMarkup(
    <CanopyClientProvider client={ipcCanopyClient}>
      <CompactQueueProvider value={compactQueue}>
        <ChatMessageList
          messages={[]}
          queuedMessages={queuedMessages}
          chatId="chat-1"
          onClearQueuedMessage={jest.fn()}
          onForceQueuedMessage={jest.fn()}
          onEditQueuedMessage={jest.fn()}
        />
      </CompactQueueProvider>
    </CanopyClientProvider>,
  );
  return new DOMParser().parseFromString(html, 'text/html');
}

function forceActions(doc: Document): string[] {
  return Array.from(
    doc.querySelectorAll(
      '[data-testid="queued-message-interrupt"], [data-testid="queued-message-retry"], [data-testid="queued-message-run-now"]',
    ),
    (button) => button.getAttribute('data-testid') ?? '',
  );
}

const localRow = [{ text: 'follow-up' }];

describe('ChatMessageList force action for a renderer-local queued row (CAN-5031)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([false, true])(
    'offers no force action while the head dispatch is pending (compact: %s)',
    (compact) => {
      expect(
        forceActions(
          renderList({ sendingLease: pendingLease }, localRow, compact),
        ),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    'offers no Retry on an idle tab with nothing to recover (compact: %s)',
    (compact) => {
      expect(forceActions(renderList({}, localRow, compact))).toEqual([]);
    },
  );

  it.each([false, true])(
    'does not let an old canonical error override an acknowledged newer bridge (compact: %s)',
    (compact) => {
      expect(
        forceActions(
          renderList(
            {
              status: 'error',
              error: 'old failure',
              pendingTurn: {
                userMessageId: 'new-send',
                timerMessage: {
                  id: 'new-timer',
                  role: 'system',
                  timestamp: NOW - 1_000,
                  blocks: [
                    {
                      type: 'turn_timer',
                      startedAt: NOW - 1_000,
                      completedAt: null,
                    },
                  ],
                },
              },
            },
            localRow,
            compact,
            {
              status: 'failed',
              queuedMessageIds: [],
              error: {
                code: 'provider_error',
                message: 'old failure',
                retryable: true,
                occurredAt: new Date(NOW - 10_000).toISOString(),
              },
            },
          ),
        ),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    'offers Interrupt once the turn streams (compact: %s)',
    (compact) => {
      expect(
        forceActions(renderList({ status: 'streaming' }, localRow, compact)),
      ).toEqual(['queued-message-interrupt']);
    },
  );

  it.each([false, true])(
    'offers Retry after a failed or expired dispatch (compact: %s)',
    (compact) => {
      expect(
        forceActions(renderList({ status: 'error' }, localRow, compact)),
      ).toEqual(['queued-message-retry']);
      expect(
        forceActions(
          renderList(
            { sendingLease: { ...pendingLease, state: 'expired' } },
            localRow,
            compact,
          ),
        ),
      ).toEqual(['queued-message-retry']);
    },
  );

  it.each([false, true])(
    'labels a host background-work hold as Run now (compact: %s)',
    (compact) => {
      expect(
        forceActions(
          renderList(
            {},
            [
              {
                text: 'Wait for background work',
                hostQueueEntryId: 'held',
                turnPhase: 'background',
                waitingReason: 'background_work',
              },
            ],
            compact,
          ),
        ),
      ).toEqual(['queued-message-run-now']);
    },
  );

  it.each([false, true])(
    "keeps a host row's action while a local dispatch is pending (compact: %s)",
    (compact) => {
      expect(
        forceActions(
          renderList(
            { sendingLease: pendingLease },
            [
              {
                text: 'host row',
                hostQueueEntryId: 'q1',
                turnPhase: 'foreground',
              },
            ],
            compact,
          ),
        ),
      ).toEqual(['queued-message-interrupt']);
    },
  );

  it.each([false, true])(
    'only permits the head local row to force during streaming (compact: %s)',
    (compact) => {
      expect(
        forceActions(
          renderList(
            { status: 'streaming' },
            [{ text: 'head' }, { text: 'second' }],
            compact,
          ),
        ),
      ).toEqual(['queued-message-interrupt']);
    },
  );

  it.each([false, true])(
    'locks Run now on a host row behind a setup hold, with no setup copy (compact: %s)',
    (compact) => {
      const doc = renderList(
        { status: 'streaming' },
        [
          {
            text: 'follow-up',
            hostQueueEntryId: 'q1',
            turnPhase: 'foreground',
            forceLocked: true,
          },
        ],
        compact,
      );
      const actions = Array.from(
        doc.querySelectorAll<HTMLElement>(
          '[data-testid="queued-message-interrupt"], [data-testid="queued-message-run-now"]',
        ),
      );
      expect(actions.every((action) => action.hasAttribute('disabled'))).toBe(
        true,
      );
      expect(doc.body.textContent).not.toContain('Setting up');
      // Edit stays: on the bubble directly, in the compact row's menu.
      expect(
        doc.querySelector(
          compact
            ? '[data-testid="queued-message-more"]'
            : '[data-testid="queued-message-edit"]',
        ),
      ).not.toBeNull();
    },
  );

  it('preserves non-head host actions in a mixed compact queue', () => {
    expect(
      forceActions(
        renderList(
          { status: 'streaming' },
          [
            { text: 'local head' },
            {
              text: 'host second',
              hostQueueEntryId: 'q2',
              turnPhase: 'foreground',
            },
            { text: 'local third' },
          ],
          true,
        ),
      ),
    ).toEqual(['queued-message-interrupt', 'queued-message-interrupt']);
  });

  it('keeps the disabled host-admission action behind an active turn', () => {
    const doc = renderList(
      { status: 'streaming' },
      [
        { text: 'accepted', hostQueueEntryId: 'q1', turnPhase: 'foreground' },
        { text: 'awaiting host acceptance', pendingSend: true },
      ],
      true,
    );
    expect(forceActions(doc)).toEqual([
      'queued-message-interrupt',
      'queued-message-interrupt',
    ]);
    expect(
      doc
        .querySelectorAll('[data-testid="queued-message-interrupt"]')[1]
        ?.hasAttribute('disabled'),
    ).toBe(true);
  });

  it.each([false, true])(
    'preserves the host action in a mixed queue during handoff (compact: %s)',
    (compact) => {
      expect(
        forceActions(
          renderList(
            { sendingLease: pendingLease },
            [
              { text: 'host', hostQueueEntryId: 'q1', turnPhase: 'foreground' },
              { text: 'local' },
            ],
            compact,
          ),
        ),
      ).toEqual(['queued-message-interrupt']);
    },
  );
});
