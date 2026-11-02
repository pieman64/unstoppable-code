import type {
  ChatStateService,
  ProviderEventIngestResult,
} from '../services/chat-state-service';
import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(),
  completePersistedTabTurnTimers: jest.fn((tab: unknown) => tab),
}));

jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));

const completeChatTurnMock = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    completeChatTurn: completeChatTurnMock,
  })),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

const ingestProviderEventMock = jest.fn<
  Promise<boolean>,
  [Record<string, unknown>]
>(() => Promise.resolve(true));

const ingestProviderEventWithResultMock = jest.fn<
  Promise<ProviderEventIngestResult>,
  [Record<string, unknown>]
>(() => Promise.resolve({ outcome: 'applied' }));

const updateCompatibilityTabMock = jest.fn<
  ReturnType<ChatStateService['updateCompatibilityTab']>,
  Parameters<ChatStateService['updateCompatibilityTab']>
>();

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    ingestProviderEvent: ingestProviderEventMock,
    ingestProviderEventWithResult: ingestProviderEventWithResultMock,
    updateCompatibilityTab: updateCompatibilityTabMock,
  })),
}));

import { writeChatTabsFile } from '../lib/chat-tabs';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { sendToWindow } from '../lib/window-send';
import {
  commitProviderChatEvent,
  completePersistedChatTabTurn,
  emitChatDispatchFailure,
  persistOrgMemoryUsedForChat,
  removePersistedChatTab,
  upsertPersistedChatTab,
} from '../lib/chat-tab-dispatch-utils';

const writeChatTabsFileMock = jest.mocked(writeChatTabsFile);
const readChatTabsFileMock = jest.mocked(readChatTabsFile);
const sendToWindowMock = jest.mocked(sendToWindow);

function persistedTab(id: string): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [],
    createdAt: new Date().toISOString(),
  };
}

function lastWrittenFile(): ChatTabsFile {
  const lastCall =
    writeChatTabsFileMock.mock.calls[
      writeChatTabsFileMock.mock.calls.length - 1
    ];
  if (!lastCall) {
    throw new Error('Expected writeChatTabsFile to have been called');
  }
  return lastCall[2];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('commitProviderChatEvent', () => {
  it('passes a large Codex MCP result to shared ingest without truncation', async () => {
    const body = `start-${'x'.repeat(65_536)}-end`;
    const data = {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          id: 'mcp-call-large',
          type: 'mcp_tool_call',
          status: 'completed',
          result: { content: [{ type: 'text', text: body }] },
        },
      },
    };

    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      providerType: 'codex',
      event: {
        data,
        sequence: 0,
        sequenceNamespace: 'initial',
      },
    });

    expect(ingestProviderEventWithResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ data }),
    );
    expect(body).toHaveLength(65_546);
  });

  it('namespaces mutation ids when a provider stream resumes at sequence zero', async () => {
    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      event: {
        data: { type: 'assistant', message: 'initial' },
        sequence: 0,
        sequenceNamespace: 'initial',
      },
    });
    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      event: {
        data: { type: 'assistant', message: 'resumed' },
        sequence: 0,
        sequenceNamespace: 'reload-request',
      },
    });

    expect(
      ingestProviderEventWithResultMock.mock.calls.map(
        ([event]) => event.mutationId,
      ),
    ).toEqual([
      'chat-1:user-1:provider:initial:0',
      'chat-1:user-1:provider:reload-request:0',
    ]);
  });

  it('prefers the provider that produced the event', async () => {
    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      event: {
        data: { type: 'user', message: { content: [] } },
        sequence: 0,
        sequenceNamespace: 'initial',
        providerType: 'claude',
      },
    });
    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      providerType: 'codex',
      event: {
        data: { type: 'user', message: { content: [] } },
        sequence: 1,
        sequenceNamespace: 'initial',
        providerType: 'claude',
      },
    });
    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      providerType: 'codex',
      event: {
        data: { type: 'user', message: { content: [] } },
        sequence: 2,
        sequenceNamespace: 'initial',
      },
    });

    expect(
      ingestProviderEventWithResultMock.mock.calls.map(
        ([event]) => event.providerType,
      ),
    ).toEqual(['claude', 'claude', 'codex']);
  });

  it.each([
    ['ordinary applied event', { outcome: 'applied' }],
    ['ordinary activity-only event', { outcome: 'activity-only' }],
    ['ordinary not-applied event', { outcome: 'not-applied' }],
    [
      'accepted starting pickup despite a not-applied event',
      { outcome: 'not-applied', pickup: 'accepted' },
    ],
    [
      'already-accepted starting pickup despite a not-applied event',
      { outcome: 'not-applied', pickup: 'already-accepted' },
    ],
    [
      'rejected starting pickup',
      { outcome: 'not-applied', pickup: 'rejected' },
    ],
  ] as const)(
    'returns the canonical result unchanged for %s',
    async (_description, result) => {
      ingestProviderEventWithResultMock.mockResolvedValueOnce(result);
      await expect(
        commitProviderChatEvent({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          event: {
            data: { type: 'system', subtype: 'status' },
            sequence: 0,
            sequenceNamespace: 'initial',
          },
        }),
      ).resolves.toBe(result);
    },
  );

  it('preserves provider and root-turn identities for canonical ingestion', async () => {
    const data = { type: 'assistant', message: 'response' };

    await commitProviderChatEvent({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      userMessageId: 'user-1',
      providerType: 'claude',
      event: {
        data,
        sequence: 4,
        sequenceNamespace: 'resume',
        turnUserMessageId: 'root-turn-1',
      },
    });

    expect(ingestProviderEventWithResultMock).toHaveBeenCalledWith({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data,
      mutationId: 'chat-1:user-1:provider:resume:4',
      providerType: 'claude',
      turnUserMessageId: 'root-turn-1',
    });
  });
});

describe('upsertPersistedChatTab', () => {
  it('waits for an in-flight renderer mutation before reading the tabs file', async () => {
    let releaseRendererMutation: (() => void) | undefined;
    const rendererMutation = enqueueChatTabMutation(
      'proj',
      'wt',
      () =>
        new Promise<void>((resolve) => {
          releaseRendererMutation = resolve;
        }),
    );
    await Promise.resolve();

    readChatTabsFileMock.mockResolvedValue({
      version: 1,
      tabs: [persistedTab('existing')],
      activeTabId: 'existing',
    });
    const hostUpsert = upsertPersistedChatTab({
      projectId: 'proj',
      worktreeId: 'wt',
      tab: persistedTab('host-tab'),
      activateTab: false,
    });

    await Promise.resolve();
    const readCountBeforeRelease = readChatTabsFileMock.mock.calls.length;

    releaseRendererMutation?.();
    await rendererMutation;
    await hostUpsert;
    expect(readCountBeforeRelease).toBe(0);
    expect(readChatTabsFileMock).toHaveBeenCalledTimes(1);
  });

  it('activates the tab when activateTab is true', async () => {
    readChatTabsFileMock.mockResolvedValue({
      version: 1,
      tabs: [persistedTab('existing')],
      activeTabId: 'existing',
      lastActiveChatProvider: 'claude',
    });

    await upsertPersistedChatTab({
      projectId: 'proj',
      worktreeId: 'wt',
      tab: persistedTab('new-tab'),
      activateTab: true,
    });

    expect(lastWrittenFile().activeTabId).toBe('new-tab');
    expect(lastWrittenFile().lastActiveChatProvider).toBe('claude');
  });

  it('keeps the existing active tab when activateTab is false', async () => {
    readChatTabsFileMock.mockResolvedValue({
      version: 1,
      tabs: [persistedTab('existing')],
      activeTabId: 'existing',
    });

    await upsertPersistedChatTab({
      projectId: 'proj',
      worktreeId: 'wt',
      tab: persistedTab('new-tab'),
      activateTab: false,
    });

    expect(lastWrittenFile().activeTabId).toBe('existing');
  });

  it('never persists an empty activeTabId when adding a tab to an empty file', async () => {
    // Regression: a hook chat upserted with activateTab: false into a fresh
    // worktree (no tabs file yet) used to persist { tabs: [tab],
    // activeTabId: '' }, leaving the chat panel with no visible tab.
    readChatTabsFileMock.mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });

    await upsertPersistedChatTab({
      projectId: 'proj',
      worktreeId: 'wt',
      tab: persistedTab('hook-tab'),
      activateTab: false,
    });

    const written = lastWrittenFile();
    expect(written.tabs.map((tab) => tab.id)).toEqual(['hook-tab']);
    expect(written.activeTabId).toBe('hook-tab');
  });

  // The fallback must agree with the trusted-send rule: an active id that no
  // longer names a tab is as good as none, so a background upsert selects the
  // new tab rather than carrying a dangling id forward.
  it('replaces a stale activeTabId that names no tab when activateTab is false', async () => {
    readChatTabsFileMock.mockResolvedValue({
      version: 1,
      tabs: [persistedTab('existing')],
      activeTabId: 'gone',
    });

    await upsertPersistedChatTab({
      projectId: 'proj',
      worktreeId: 'wt',
      tab: persistedTab('hook-tab'),
      activateTab: false,
    });

    expect(lastWrittenFile().activeTabId).toBe('hook-tab');
  });
});

describe('other persisted chat tab mutations', () => {
  it.each([
    [
      'remove',
      (): Promise<void> =>
        removePersistedChatTab({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'existing',
        }),
    ],
    [
      'complete',
      (): Promise<void> =>
        completePersistedChatTabTurn({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'existing',
        }),
    ],
  ])(
    'serializes %s behind an in-flight renderer mutation',
    async (_name, mutate) => {
      let releaseRendererMutation: (() => void) | undefined;
      const rendererMutation = enqueueChatTabMutation(
        'proj',
        'wt',
        () =>
          new Promise<void>((resolve) => {
            releaseRendererMutation = resolve;
          }),
      );
      await Promise.resolve();
      readChatTabsFileMock.mockResolvedValue({
        version: 1,
        tabs: [persistedTab('existing')],
        activeTabId: 'existing',
      });

      const hostMutation = mutate();
      await Promise.resolve();
      const readCountBeforeRelease = readChatTabsFileMock.mock.calls.length;

      releaseRendererMutation?.();
      await rendererMutation;
      await hostMutation;
      expect(readCountBeforeRelease).toBe(0);
    },
  );
});

describe('persistOrgMemoryUsedForChat', () => {
  let currentTab: PersistedChatTab | null;

  beforeEach(() => {
    currentTab = {
      ...persistedTab('chat-1'),
      messages: [
        {
          id: 'user-1',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Release question' }],
        },
      ],
    };
    updateCompatibilityTabMock.mockImplementation((_scope, chatId, update) => {
      const next =
        currentTab?.id === chatId ? update(currentTab, undefined) : null;
      if (next) currentTab = next;
      return Promise.resolve({
        updated: next !== null,
        tabsFile: {
          version: 1,
          activeTabId: currentTab?.id ?? '',
          tabs: currentTab ? [currentTab] : [],
        },
      });
    });
  });

  it('normalizes facts and saves the search id through the canonical transaction', async () => {
    await expect(
      persistOrgMemoryUsedForChat({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        userMessageId: 'user-1',
        searchId: 'search-1',
        facts: [
          {
            factText: 'A'.repeat(600),
            validAt: null,
            sourceTurnIds: ['turn-1'],
          },
        ],
      }),
    ).resolves.toBe(true);
    expect(currentTab?.memoryByMessageId?.['user-1']).toEqual({
      searchId: 'search-1',
      facts: [
        { factText: 'A'.repeat(500), validAt: null, sourceTurnIds: ['turn-1'] },
      ],
    });
    expect(readChatTabsFileMock).not.toHaveBeenCalled();
    expect(writeChatTabsFileMock).not.toHaveBeenCalled();
  });

  it('does not create a missing chat', async () => {
    currentTab = null;
    await expect(
      persistOrgMemoryUsedForChat({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'missing',
        userMessageId: 'user-1',
        facts: [{ factText: 'Fact.', validAt: null, sourceTurnIds: [] }],
      }),
    ).resolves.toBe(false);
    expect(currentTab).toBeNull();
  });

  it.each(['user', 'assistant'] as const)(
    'ignores an absent or non-user target when the remaining message is %s',
    async (role) => {
      currentTab = {
        ...persistedTab('chat-1'),
        messages: [
          {
            id: role === 'user' ? 'other-user' : 'user-1',
            role,
            timestamp: 1,
            blocks: [],
          },
        ],
      };
      await expect(
        persistOrgMemoryUsedForChat({
          projectId: 'proj',
          worktreeId: 'wt',
          chatId: 'chat-1',
          userMessageId: 'user-1',
          facts: [{ factText: 'Fact.', validAt: null, sourceTurnIds: [] }],
        }),
      ).resolves.toBe(false);
      expect(currentTab.memoryByMessageId).toBeUndefined();
    },
  );

  it('ignores an empty memory result without a transaction', async () => {
    await expect(
      persistOrgMemoryUsedForChat({
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        userMessageId: 'user-1',
        facts: [],
      }),
    ).resolves.toBe(false);
    expect(updateCompatibilityTabMock).not.toHaveBeenCalled();
  });
});

describe('emitChatDispatchFailure', () => {
  it('reports the failed turn as a setup failure (CAN-4629)', async () => {
    await emitChatDispatchFailure({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      errorMessage: 'dispatch rejected',
      getWindow: jest.fn(() => null),
    });

    expect(completeChatTurnMock).toHaveBeenCalledWith(
      'proj',
      'wt',
      'chat-1',
      'failure',
      'dispatch rejected',
      { setupFailure: true },
    );
  });

  it('commits the failed runtime before notifying the renderer', async () => {
    let releaseCommit: ((applied: boolean) => void) | undefined;
    ingestProviderEventMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseCommit = resolve;
        }),
    );
    const getWindow = jest.fn(() => null);

    const request = emitChatDispatchFailure({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      errorMessage: 'dispatch rejected',
      getWindow,
    });
    await Promise.resolve();

    const committedEvent = ingestProviderEventMock.mock.calls[0]?.[0];
    expect(committedEvent).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      data: { type: 'error', error: 'dispatch rejected' },
      source: 'provider',
    });
    expect(committedEvent?.mutationId).toMatch(/^dispatch-failure:/);
    expect(sendToWindowMock).not.toHaveBeenCalled();

    releaseCommit?.(true);
    await request;

    expect(sendToWindowMock).toHaveBeenCalledWith(
      null,
      'chat:event',
      expect.objectContaining({
        chatId: 'chat-1',
        data: { type: 'error', error: 'dispatch rejected' },
      }),
    );
  });
});
