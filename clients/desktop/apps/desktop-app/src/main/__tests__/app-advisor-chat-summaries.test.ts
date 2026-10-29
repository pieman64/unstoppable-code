import type {
  AppAdvisorWatcherSummary,
  ChatTabsFile,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => false),
}));

// Finding #4 (CAN-3624 review): `chatSummaryEntity` is shared by
// `listWorktreeChatSummaries` and `listAppAdvisorChatSummaries`. Mock its two
// Cursor-projecting collaborators so a test can assert the worktree-only
// Cursor catalog rows and `providerAvailability.cursor` never reach App
// Advisor, while still reaching the worktree projection.
const mockPeekPortalProviderAvailability = jest.fn(
  (): { ollama?: boolean; cursor?: boolean } => ({ ollama: true }),
);
const mockPeekProviderNativeAuthAvailability = jest.fn(
  (): { ollama?: boolean } => ({ ollama: true }),
);
jest.mock('../auth/provider-auth-state', () => ({
  peekPortalProviderAvailability: (): unknown =>
    mockPeekPortalProviderAvailability(),
  peekProviderNativeAuthAvailability: (): unknown =>
    mockPeekProviderNativeAuthAvailability(),
}));

const mockBuildProjectedModelCatalog = jest.fn(
  (
    _defaultModel: string | undefined,
    options?: { cursor?: boolean },
  ): Array<{
    id: string;
    label: string;
    provider: string;
    kind: 'model';
    available: boolean;
  }> =>
    options?.cursor === true
      ? [
          {
            id: 'cursor-default',
            label: 'Cursor',
            provider: 'cursor',
            kind: 'model',
            available: true,
          },
        ]
      : [
          {
            id: 'claude-default',
            label: 'Claude',
            provider: 'claude',
            kind: 'model',
            available: true,
          },
        ],
);
jest.mock('../portal/model-catalog-projection', () => ({
  buildProjectedModelCatalog: (
    defaultModel: string | undefined,
    options?: { cursor?: boolean },
  ): unknown => mockBuildProjectedModelCatalog(defaultModel, options),
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: {
    read: jest.fn(),
  },
}));

jest.mock('../agents/session-manager', () => ({
  getSession: jest.fn(),
  getActiveSessionInfos: jest.fn(() => []),
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: jest.fn(() => ({
    getWorktreeSnapshots: jest.fn(() => []),
  })),
}));

const listAnsweredQuestionsMock = jest.fn<
  Array<{
    requestId: string;
    chatId: string;
    question: unknown;
    answer: unknown;
  }>,
  []
>(() => []);
jest.mock('../ipc/app-advisor', () => ({
  getLatestAppAdvisorWindowUiState: jest.fn(() => undefined),
  listPendingAppAdvisorAskUserQuestions: jest.fn(() => []),
  listAnsweredAppAdvisorAskUserQuestions: listAnsweredQuestionsMock,
}));

const listWorkEntryIdsMock = jest.fn<Promise<string[]>, [string]>(() =>
  Promise.resolve([]),
);
const listWorkEntriesMock = jest.fn(() =>
  Promise.resolve([
    {
      id: 'entry-one',
      title: 'Desktop first entry',
      createdAt: '2026-07-31T00:00:00.000Z',
      lastMessageAt: '2026-08-01T00:00:00.000Z',
      providerType: 'codex' as const,
      chatCount: 2,
    },
  ]),
);
const resolveWorkEntryForChatMock = jest.fn(() =>
  Promise.resolve({ entryId: null, archivedInEntryId: null }),
);
jest.mock('../lib/cowork-work-entries', () => ({
  listWorkEntryIds: listWorkEntryIdsMock,
  listWorkEntries: listWorkEntriesMock,
  resolveWorkEntryForChat: resolveWorkEntryForChatMock,
}));

const watchersListMock = jest.fn<Promise<AppAdvisorWatcherSummary[]>, []>(() =>
  Promise.resolve([]),
);
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    list: watchersListMock,
  })),
}));

import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getAppAdvisorChatTranscriptSeed,
  listAppAdvisorChatSummaries,
  projectAllAppAdvisorChatSummaries,
  listWorktreeChatSummaries,
} from '../services/chat-service';
import { PORTAL_CHAT_SEED_MESSAGE_LIMIT } from '../services/chat-transcript-projector';
import { portalChatTabsCache } from '../services/portal-chat-tabs-cache';
import {
  isCanopyPortalActive,
  enqueuePortalEvent,
} from '../portal/portal-event-bus';

const mockedPortalChatTabsCache = jest.mocked(portalChatTabsCache);
const mockedIsCanopyPortalActive = jest.mocked(isCanopyPortalActive);

function watcherSummary(
  chatId: string,
  status: AppAdvisorWatcherSummary['status'],
  projectId = APP_ADVISOR_PROJECT_ID,
): AppAdvisorWatcherSummary {
  return {
    id: `watcher-${chatId}-${status}-${projectId}`,
    trigger: 'worktree_chat_completion',
    status,
    label: 'Watcher',
    target: {
      kind: 'worktree_chat',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'watched-chat',
    },
    destination: {
      projectId,
      worktreeId: 'entry-one',
      chatId,
    },
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function tabsFile(chatIds: string[]): {
  version: 1;
  activeTabId: string | null;
  tabs: Array<Record<string, unknown>>;
} {
  return {
    version: 1,
    activeTabId: chatIds[0] ?? null,
    tabs: chatIds.map((id) => ({
      id,
      title: `Chat ${id}`,
      messages: [],
      createdAt: '2026-08-01T00:00:00.000Z',
    })),
  };
}

describe('answered ask-user question projection (CAN-2608)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchersListMock.mockResolvedValue([]);
    listAnsweredQuestionsMock.mockReturnValue([]);
    mockedPortalChatTabsCache.read.mockImplementation(() =>
      Promise.resolve(tabsFile(['advisor-chat-a', 'advisor-chat-b']) as never),
    );
  });

  it('drops Advisor catalog deltas when the publishing session is replaced during a read', async () => {
    mockedIsCanopyPortalActive.mockReturnValue(true);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedPortalChatTabsCache.read.mockImplementationOnce(async () => {
      await gate;
      return {
        version: 1,
        activeTabId: 'chat-1',
        tabs: [{ id: 'chat-1', title: 'Chat', createdAt: '', messages: [] }],
      };
    });
    let current = true;
    const pending = projectAllAppAdvisorChatSummaries(() => current);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedPortalChatTabsCache.read.mock.calls).toHaveLength(1);
    current = false;
    release();
    await pending;
    expect(enqueuePortalEvent).not.toHaveBeenCalled();
    mockedIsCanopyPortalActive.mockReturnValue(false);
  });

  it('projects answered questions with answers so the transcript card can converge', async () => {
    const question = {
      question: 'Which task?',
      options: [{ label: 'Navigate' }, { label: 'Other' }],
    };
    const answer = {
      question: 'Which task?',
      selectedOptions: ['Navigate'],
    };
    listAnsweredQuestionsMock.mockReturnValue([
      { requestId: 'req-1', chatId: 'advisor-chat-a', question, answer },
    ]);

    const summaries = await listAppAdvisorChatSummaries('entry-one');
    const byChatId = new Map(summaries.map((s) => [s.chatId, s]));
    expect(byChatId.get('advisor-chat-a')?.pendingQuestions).toEqual([
      {
        requestId: 'req-1',
        questions: [question],
        answered: true,
        answers: [answer],
      },
    ]);
    // Other chats keep the explicit empty array that clears stale cards.
    expect(byChatId.get('advisor-chat-b')?.pendingQuestions).toEqual([]);
  });

  it('projects Work Entry identity and registry order with every sub-chat', async () => {
    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      workEntryId: 'entry-one',
      workEntryTitle: 'Desktop first entry',
      workEntryOrder: 0,
      workEntryCreatedAt: '2026-07-31T00:00:00.000Z',
      workEntryLastMessageAt: '2026-08-01T00:00:00.000Z',
    });
  });
});

describe('chat summary usage-limit banner mirroring (CAN-2601)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchersListMock.mockResolvedValue([]);
  });

  it('projects an undismissed persisted usage-limit banner onto the summary', async () => {
    const file = tabsFile(['advisor-chat-a', 'advisor-chat-b']);
    file.tabs[0].llmProviderUsageLimitBanner = {
      provider: 'claude',
      message: "You've hit your session limit",
      detectedAt: 1_700_000_000_000,
      dismissKey: 'req-1',
      resetsAt: 1_700_000_360_000,
    };
    // Dismissed on the desktop: must NOT reach the wire.
    file.tabs[1].llmProviderUsageLimitBanner = {
      provider: 'codex',
      message: 'limit',
      detectedAt: 1_700_000_000_000,
      dismissKey: 'req-2',
    };
    file.tabs[1].dismissedLlmProviderUsageLimitBannerKey = 'req-2';
    mockedPortalChatTabsCache.read.mockResolvedValue(file as never);

    const summaries = await listAppAdvisorChatSummaries('entry-one');
    const byChatId = new Map(summaries.map((s) => [s.chatId, s]));
    expect(byChatId.get('advisor-chat-a')?.usageLimit).toEqual({
      provider: 'claude',
      message: "You've hit your session limit",
      resetsAt: 1_700_000_360_000,
      dismissKey: 'req-1',
    });
    expect(byChatId.get('advisor-chat-b')).toBeDefined();
    expect(byChatId.get('advisor-chat-b')).not.toHaveProperty('usageLimit');
  });

  it('re-shows on the wire when a later limit event has a new dismiss key', async () => {
    const file = tabsFile(['advisor-chat-a']);
    file.tabs[0].llmProviderUsageLimitBanner = {
      provider: 'claude',
      message: 'limit again',
      detectedAt: 1_700_000_400_000,
      dismissKey: 'req-3',
    };
    // A stale dismissal of an OLDER banner must not suppress the new one.
    file.tabs[0].dismissedLlmProviderUsageLimitBannerKey = 'req-1';
    mockedPortalChatTabsCache.read.mockResolvedValue(file as never);

    const summaries = await listAppAdvisorChatSummaries('entry-one');
    expect(summaries[0]?.usageLimit).toMatchObject({ dismissKey: 'req-3' });
  });
});

describe('legacy execution harness projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchersListMock.mockResolvedValue([]);
  });

  it('projects the effective harness for a started tab without a persisted lock', async () => {
    const file: ChatTabsFile = {
      version: 1,
      activeTabId: 'advisor-chat-a',
      tabs: [
        {
          id: 'advisor-chat-a',
          title: 'Started legacy chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          providerType: 'codex',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Started',
              timestamp: 1_700_000_000_000,
            },
          ],
        },
      ],
    };
    mockedPortalChatTabsCache.read.mockResolvedValue(file);

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries[0]?.executionHarness).toBe('codex');
  });

  it('does not project a Claude lock for a started providerless tab', async () => {
    const file: ChatTabsFile = {
      version: 1,
      activeTabId: 'advisor-chat-a',
      tabs: [
        {
          id: 'advisor-chat-a',
          title: 'Started providerless chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [
            {
              id: 'message-1',
              role: 'user',
              content: 'Started',
              timestamp: 1_700_000_000_000,
            },
          ],
        },
      ],
    };
    mockedPortalChatTabsCache.read.mockResolvedValue(file);

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries[0]?.executionHarness).toBeUndefined();
  });

  it.each([0, 1])(
    'projects native metadata with %s messages without loading its body',
    async (messageCount) => {
      const file: ChatTabsFile = {
        version: 1,
        activeTabId: 'advisor-chat-a',
        tabs: [
          {
            id: 'advisor-chat-a',
            title: 'Native chat',
            createdAt: '2026-08-01T00:00:00.000Z',
            providerType: 'claude',
            sdkSessionId: 'persisted-session',
            messages: [],
            transcript: {
              format: 'complete-message-jsonl-v1',
              messageCount,
              committedMessageCount: messageCount,
              committedByteLength: messageCount * 100,
              transcriptRevision: 1,
              hasActiveSidecar: false,
            },
          },
        ],
      };
      Object.defineProperty(file.tabs[0], 'messages', {
        enumerable: false,
        get: () => {
          throw new Error('Transcript body was not requested');
        },
      });
      mockedPortalChatTabsCache.read.mockResolvedValue(file);
      const summaries = await listAppAdvisorChatSummaries('entry-one');
      expect(summaries[0]?.messageCount).toBe(messageCount);
      expect(summaries[0]?.executionHarness).toBe(
        messageCount > 0 ? 'claude' : undefined,
      );
    },
  );

  it('does not lock an empty tab solely because it has a preallocated session', async () => {
    const file: ChatTabsFile = {
      version: 1,
      activeTabId: 'advisor-chat-a',
      tabs: [
        {
          id: 'advisor-chat-a',
          title: 'Empty terminal chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          providerType: 'claude',
          sdkSessionId: 'preallocated-session',
          messages: [],
        },
      ],
    };
    mockedPortalChatTabsCache.read.mockResolvedValue(file);

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries[0]?.executionHarness).toBeUndefined();
  });
});

describe('listAppAdvisorChatSummaries armed watcher counts (CAN-2569)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchersListMock.mockResolvedValue([]);
    mockedPortalChatTabsCache.read.mockImplementation(() =>
      Promise.resolve(tabsFile(['advisor-chat-a', 'advisor-chat-b']) as never),
    );
  });

  it('counts only armed App Advisor-destined watchers per chat and omits zero', async () => {
    watchersListMock.mockResolvedValue([
      watcherSummary('advisor-chat-a', 'active'),
      watcherSummary('advisor-chat-a', 'active', APP_ADVISOR_PROJECT_ID),
      // Not armed: fired/failed watchers no longer deliver.
      watcherSummary('advisor-chat-a', 'delivery_failed'),
      watcherSummary('advisor-chat-b', 'fired'),
      // Worktree-destined watcher must not count against an App Advisor chat
      // that happens to share the chat id.
      watcherSummary('advisor-chat-b', 'active', 'project-1'),
    ]);

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    const byChatId = new Map(summaries.map((s) => [s.chatId, s]));
    expect(byChatId.get('advisor-chat-a')?.armedWatcherCount).toBe(2);
    // Zero counts are omitted from the wire (the browser projector clears the
    // cached value on omission).
    expect(byChatId.get('advisor-chat-b')).toBeDefined();
    expect(byChatId.get('advisor-chat-b')).not.toHaveProperty(
      'armedWatcherCount',
    );
  });

  it('never leaks a persisted hidden watcher context into the projected summary (CAN-2569)', async () => {
    // A watcher-delivered message persists on the tab WITH its hiddenContext
    // (the provider-only watcher event payload). The projected
    // `app_advisor_chat` summary is built from that same tab, so a substring
    // scan over the full serialized projection is the leak check. The
    // renderer→dispatch delivery chain itself is covered by the CAN-2570 E2E
    // spec; the dispatch-level portal/turn-record contract lives in
    // app-advisor-chat-service.test.ts.
    mockedPortalChatTabsCache.read.mockResolvedValue({
      version: 1,
      activeTabId: 'advisor-watcher-chat',
      tabs: [
        {
          id: 'advisor-watcher-chat',
          title: 'Watcher chat',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [
            {
              id: 'watcher-message-1',
              role: 'user',
              timestamp: 1754006400000,
              blocks: [
                {
                  type: 'text',
                  text: 'Pipeline completion watcher fired',
                },
              ],
              hiddenContext: {
                kind: 'canopy-watcher-event',
                text: '<watcher_event>HIDDEN-WATCHER-SECRET-2569</watcher_event>',
              },
            },
          ],
        },
      ],
    } as never);

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.chatId).toBe('advisor-watcher-chat');
    expect(summaries[0]?.messageCount).toBe(1);
    expect(JSON.stringify(summaries)).not.toContain(
      'HIDDEN-WATCHER-SECRET-2569',
    );
  });

  it('still projects summaries when the watcher store read fails', async () => {
    watchersListMock.mockRejectedValue(new Error('watchers file corrupt'));

    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries.map((s) => s.chatId).sort()).toEqual([
      'advisor-chat-a',
      'advisor-chat-b',
    ]);
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('armedWatcherCount');
    }
  });
});

describe('getAppAdvisorChatTranscriptSeed (CAN-2562)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('seeds every entry chat transcript interleaved by time, without routing or hidden context', async () => {
    listWorkEntryIdsMock.mockResolvedValue(['entry-one', 'entry-two']);
    mockedPortalChatTabsCache.read.mockImplementation(
      (_workspaceId: string, entryId: string) =>
        Promise.resolve({
          version: 1,
          activeTabId: null,
          tabs: [
            {
              id: `${entryId}-chat`,
              title: entryId,
              createdAt: '2026-08-01T00:00:00.000Z',
              messages: [
                {
                  id: `${entryId}-m1`,
                  role: 'user',
                  timestamp: entryId === 'entry-one' ? 1000 : 2000,
                  blocks: [{ type: 'text', text: `hello from ${entryId}` }],
                  hiddenContext: {
                    kind: 'canopy-watcher-event',
                    text: 'SEED-HIDDEN-SECRET-2562',
                  },
                },
                {
                  id: `${entryId}-m2`,
                  role: 'assistant',
                  timestamp: entryId === 'entry-one' ? 3000 : 1500,
                  blocks: [{ type: 'text', text: `reply in ${entryId}` }],
                },
              ],
            },
            {
              id: `${entryId}-terminal`,
              title: 'terminal',
              kind: 'terminal',
              createdAt: '2026-08-01T00:00:00.000Z',
              messages: [
                {
                  id: `${entryId}-t1`,
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'terminal tab excluded' }],
                },
              ],
            },
          ],
        } satisfies ChatTabsFile),
    );

    const seed = await getAppAdvisorChatTranscriptSeed();

    expect(seed.truncated).toBe(false);
    // Interleaved by createdAtMs across entries, not grouped per entry.
    expect(seed.messages.map((m) => m.messageId)).toEqual([
      'entry-one-m1',
      'entry-two-m2',
      'entry-two-m1',
      'entry-one-m2',
    ]);
    const serialized = JSON.stringify(seed.messages);
    // Visible text only: no workspace routing, no hidden context, and no
    // non-chat tabs.
    expect(serialized).toContain('hello from entry-one');
    expect(serialized).not.toContain('workspaceLocalId');
    expect(serialized).not.toContain('SEED-HIDDEN-SECRET-2562');
    expect(serialized).not.toContain('terminal tab excluded');
  });

  it('hydrates only the preferred chat instead of projecting every App Advisor history', async () => {
    listWorkEntryIdsMock.mockResolvedValue(['entry-target', 'entry-huge']);
    resolveWorkEntryForChatMock.mockResolvedValue({
      entryId: 'entry-target',
      archivedInEntryId: null,
    });
    mockedPortalChatTabsCache.read.mockImplementation(
      (_workspaceId: string, entryId: string) =>
        Promise.resolve({
          version: 1,
          activeTabId: entryId === 'entry-target' ? 'chat-target' : 'chat-huge',
          tabs: [
            {
              id: entryId === 'entry-target' ? 'chat-target' : 'chat-huge',
              title: entryId,
              createdAt: '2026-08-01T00:00:00.000Z',
              messages: Array.from(
                { length: entryId === 'entry-target' ? 2 : 2_000 },
                (_, index) => ({
                  id: `${entryId}-m${index}`,
                  role: index % 2 === 0 ? 'user' : 'assistant',
                  timestamp: index + 1,
                  blocks: [{ type: 'text', text: `${entryId}-${index}` }],
                }),
              ),
            },
          ],
        } satisfies ChatTabsFile),
    );

    const seed = await getAppAdvisorChatTranscriptSeed({
      chatId: 'chat-target',
    });

    expect(resolveWorkEntryForChatMock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'chat-target',
    );
    expect(mockedPortalChatTabsCache.read.mock.calls).toEqual([
      [APP_ADVISOR_PROJECT_ID, 'entry-target'],
      [
        APP_ADVISOR_PROJECT_ID,
        'entry-target',
        { chatIds: ['chat-target'], pageOnly: true },
      ],
    ]);
    expect(seed.messages.map((message) => message.chatId)).toEqual([
      'chat-target',
      'chat-target',
    ]);
    expect(seed.truncated).toBe(true);
  });

  it('retains a whole suffixed message group when the raw cutoff splits it', async () => {
    resolveWorkEntryForChatMock.mockResolvedValue({
      entryId: 'entry-target',
      archivedInEntryId: null,
    });
    const fillerCount = PORTAL_CHAT_SEED_MESSAGE_LIMIT - 1;
    mockedPortalChatTabsCache.read.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-target',
      tabs: [
        {
          id: 'chat-target',
          title: 'Target',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: [
            {
              id: 'assistant-group',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'base content' }],
            },
            {
              id: 'assistant-group:2',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'middle content' }],
            },
            {
              id: 'assistant-group:3',
              role: 'assistant',
              timestamp: 3,
              blocks: [{ type: 'text', text: 'suffix content' }],
            },
            ...Array.from(
              { length: fillerCount },
              (_, index): PersistedChatMessage => ({
                id: `filler-${index}`,
                role: 'assistant',
                timestamp: index + 4,
                blocks: [{ type: 'text', text: `filler ${index}` }],
              }),
            ),
          ],
        },
      ],
    });

    const seed = await getAppAdvisorChatTranscriptSeed({
      chatId: 'chat-target',
    });

    expect(seed.messages).toHaveLength(PORTAL_CHAT_SEED_MESSAGE_LIMIT);
    expect(seed.messages[0]).toMatchObject({
      messageId: 'assistant-group',
      text: 'base content\n\nmiddle content\n\nsuffix content',
    });
    expect(
      seed.messages.some(
        (message) =>
          message.messageId === 'assistant-group:2' ||
          message.messageId === 'assistant-group:3',
      ),
    ).toBe(false);
  });

  it('reports truncation when raw suffix groups collapse below the projected limit', async () => {
    listWorkEntryIdsMock.mockResolvedValue(['entry-grouped']);
    mockedPortalChatTabsCache.read.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-grouped',
      tabs: [
        {
          id: 'chat-grouped',
          title: 'Grouped',
          createdAt: '2026-08-01T00:00:00.000Z',
          messages: Array.from(
            { length: 200 },
            (_, groupIndex): PersistedChatMessage[] =>
              Array.from({ length: 3 }, (_, suffixIndex) => ({
                id:
                  suffixIndex === 0
                    ? `group-${groupIndex}`
                    : `group-${groupIndex}:${suffixIndex + 1}`,
                role: 'assistant',
                timestamp: groupIndex * 3 + suffixIndex,
                blocks: [
                  {
                    type: 'text',
                    text: `group ${groupIndex} part ${suffixIndex}`,
                  },
                ],
              })),
          ).flat(),
        },
      ],
    });

    const seed = await getAppAdvisorChatTranscriptSeed();

    // The raw 600-row source is capped to the last 300 rows, which project to
    // only 100 canonical groups. The final 300-row limiter cannot infer the
    // omitted prefix, so the pre-projection cap must carry this metadata.
    expect(seed.messages).toHaveLength(100);
    expect(seed.messages[0]?.messageId).toBe('group-100');
    expect(seed.truncated).toBe(true);
  });

  it('rejects when the registry read fails — a partial seed must not masquerade as complete', async () => {
    listWorkEntryIdsMock.mockRejectedValue(new Error('registry down'));
    await expect(getAppAdvisorChatTranscriptSeed()).rejects.toThrow(
      'registry down',
    );
  });

  it('rejects when any entry tabs read fails', async () => {
    listWorkEntryIdsMock.mockResolvedValue(['entry-one', 'entry-two']);
    mockedPortalChatTabsCache.read.mockImplementation(
      (_workspaceId: string, entryId: string) =>
        entryId === 'entry-two'
          ? Promise.reject(new Error('tabs unreadable'))
          : (Promise.resolve({
              version: 1,
              activeTabId: null,
              tabs: [],
            }) as never),
    );
    await expect(getAppAdvisorChatTranscriptSeed()).rejects.toThrow(
      'tabs unreadable',
    );
  });
});

describe('Cursor rows never leak into App Advisor summaries (finding #4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    watchersListMock.mockResolvedValue([]);
    listWorkEntriesMock.mockResolvedValue([
      {
        id: 'entry-one',
        title: 'Desktop first entry',
        createdAt: '2026-07-31T00:00:00.000Z',
        lastMessageAt: '2026-08-01T00:00:00.000Z',
        providerType: 'codex',
        chatCount: 2,
      },
    ]);
    mockedPortalChatTabsCache.read.mockImplementation(() =>
      Promise.resolve(tabsFile(['chat-a']) as never),
    );
    // The worktree-only Cursor projection only runs while a portal client is
    // connected — see `chatSummaryEntity`'s `isCanopyPortalActive()` gate.
    mockedIsCanopyPortalActive.mockReturnValue(true);
    mockPeekPortalProviderAvailability.mockReturnValue({
      ollama: true,
      cursor: true,
    });
    mockPeekProviderNativeAuthAvailability.mockReturnValue({ ollama: true });
  });

  it('projects Cursor catalog rows and providerAvailability.cursor for App Advisor summaries', async () => {
    const summaries = await listAppAdvisorChatSummaries('entry-one');

    expect(summaries).toHaveLength(1);
    const options = summaries.flatMap(
      (summary) => summary.availableModels ?? [],
    );
    expect(options.some((option) => option.provider === 'cursor')).toBe(true);
    expect(summaries[0]?.providerAvailability?.cursor).toBe(true);
  });

  it('still projects Cursor catalog rows and providerAvailability.cursor for worktree chat summaries', async () => {
    const summaries = await listWorktreeChatSummaries({
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });

    expect(summaries).toHaveLength(1);
    const options = summaries.flatMap(
      (summary) => summary.availableModels ?? [],
    );
    expect(options.some((option) => option.provider === 'cursor')).toBe(true);
    expect(summaries[0]?.providerAvailability?.cursor).toBe(true);
  });
});
