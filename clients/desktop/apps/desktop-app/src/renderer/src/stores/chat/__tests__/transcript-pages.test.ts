/** @jest-environment jsdom */
import { create } from 'zustand';
import type { ChatState } from '../state';
import { registerChatStoreApi } from '../store-ref';
import { fromPersistedTab } from '../persisted-tabs';
import {
  installTranscriptPage,
  loadChatTranscriptPage,
} from '../transcript-pages';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { useChatStore } from '../../chatStore';
import { presentedMessages } from '../optimistic-presentation';
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';

const message = (id: string): PersistedChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  blocks: [{ type: 'text', text: id }],
});
const human: PersistedChatMessage = { ...message('human'), role: 'user' };
const localCommand = (id: string): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: 1,
  blocks: [
    {
      type: 'text',
      text: '<local-command-stdout>hidden output</local-command-stdout>',
    },
  ],
});
const tab = (): ReturnType<typeof fromPersistedTab> =>
  fromPersistedTab({
    id: 'chat',
    title: 'Chat',
    createdAt: '2026-09-05',
    messages: [],
    transcriptLoaded: false,
  });
const initialPage: TranscriptPage = {
  messages: [message('newer')],
  before: 2,
  totalMessages: 3,
  transcriptRevision: 1,
  latestHumanMessage: human,
};

it('keeps a pending send through a stale page and retires it only when the page contains its exact id', () => {
  const pending = { ...human, id: 'pending-send' };
  const timer: PersistedChatMessage = {
    id: 'local-timer',
    role: 'system',
    timestamp: 1,
    blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
  };
  const initial = {
    ...tab(),
    pendingTurn: { userMessageId: pending.id, timerMessage: timer },
    messages: [pending],
    pendingUserMessages: [pending],
  };
  const stale = installTranscriptPage(initial, initialPage, false);
  expect(stale.messages).toContainEqual(pending);
  expect(stale.pendingUserMessages).toEqual([pending]);
  expect(presentedMessages(stale)).toContainEqual(timer);
  const accepted = installTranscriptPage(
    stale,
    { ...initialPage, messages: [pending] },
    false,
  );
  expect(accepted.messages.filter((row) => row.id === pending.id)).toHaveLength(
    1,
  );
  expect(accepted.pendingUserMessages).toBeUndefined();
  expect(presentedMessages(accepted)).toContainEqual(timer);
  const running = installTranscriptPage(
    accepted,
    { ...initialPage, messages: [pending, { ...timer, id: 'real-timer' }] },
    false,
  );
  expect(running.pendingTurn).toBeUndefined();
  expect(
    presentedMessages(running).filter((message) =>
      message.blocks.some((block) => block.type === 'turn_timer'),
    ),
  ).toHaveLength(1);
  expect(
    installTranscriptPage(accepted, initialPage, false).messages,
  ).not.toContainEqual(pending);
});

it('merges inspected turn gaps in ordinal order without moving the global cursor or reopening filled gaps', () => {
  const turn = {
    id: 'human',
    start: 100,
    end: 2000,
    complete: true,
    summary: computeTurnSummary([]),
    finalMessageIds: ['final'],
    before: 1900,
  };
  const page: TranscriptPage = {
    view: 'turns',
    messages: [human, message('final')],
    messageOrdinals: { human: 100, final: 1999 },
    turns: [turn],
    before: 100,
    totalMessages: 2000,
    transcriptRevision: 2,
  };
  const initial = installTranscriptPage(tab(), page, false);
  const expanded = installTranscriptPage(
    initial,
    {
      ...page,
      before: undefined,
      turnId: 'human',
      messages: [human, message('middle'), message('final')],
      messageOrdinals: { human: 100, middle: 1800, final: 1999 },
      turns: [{ ...turn, before: 1400 }],
    },
    true,
  );
  expect(expanded.messages.map((row) => row.id)).toEqual([
    'human',
    'middle',
    'final',
  ]);
  expect(expanded.transcriptWindow?.before).toBe(100);
  expect(expanded.transcriptWindow?.turns?.[0].before).toBe(1400);
  const complete = installTranscriptPage(
    expanded,
    {
      ...page,
      turnId: 'human',
      turns: [{ ...turn, before: undefined }],
    },
    true,
  );
  const overlapping = installTranscriptPage(complete, page, true);
  expect(overlapping.messages.map((row) => row.id)).toEqual([
    'human',
    'middle',
    'final',
  ]);
  expect(overlapping.transcriptWindow?.turns?.[0].before).toBeUndefined();
});

it('keeps the human supplement through paging without duplicating or moving a loaded row', () => {
  const initial = installTranscriptPage(tab(), initialPage, false);
  expect(initial.messages.map((row) => row.id)).toEqual(['human', 'newer']);
  const older = installTranscriptPage(
    initial,
    {
      ...initialPage,
      messages: [human, message('older')],
      before: undefined,
      latestHumanMessage: undefined,
    },
    true,
  );
  expect(older.messages.map((row) => row.id)).toEqual([
    'human',
    'older',
    'newer',
  ]);
  expect(older.transcriptWindow?.latestHumanMessage).toBeUndefined();
});

it('sanitizes persisted page rows before installing them', () => {
  const installed = installTranscriptPage(
    tab(),
    {
      ...initialPage,
      messages: [
        localCommand('hidden-command'),
        message('No response requested.'),
        { ...message('hidden-empty'), blocks: [] },
        message('visible'),
      ],
    },
    false,
  );

  expect(installed.messages.map((row) => row.id)).toEqual(['human', 'visible']);
});

it('does not install a hidden latest-human supplement', () => {
  const installed = installTranscriptPage(
    tab(),
    {
      ...initialPage,
      latestHumanMessage: localCommand('hidden-human'),
    },
    false,
  );

  expect(installed.messages.map((row) => row.id)).toEqual(['newer']);
  expect(installed.transcriptWindow?.latestHumanMessage).toBeUndefined();
});

// A newest-page reload replaces the whole window, so any concurrent change
// invalidates it. Earlier pages merge below the loaded window instead; see the
// streaming-tail case further down.
it.each(['delete', 'stream', 'reset'] as const)(
  'does not apply a stale newest page after %s',
  async (change) => {
    const store = create<ChatState>(() => ({
      ...useChatStore.getInitialState(),
      worktreeChats: { 'p/w': { tabs: [tab()], activeTabId: 'chat' } },
    }));
    registerChatStoreApi(store);
    let resolve: (page: TranscriptPage) => void = () => undefined;
    const read = jest.fn(
      () =>
        new Promise<TranscriptPage>((done) => {
          resolve = done;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { getTranscriptPage: read } },
    });
    const pending = loadChatTranscriptPage({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    store.setState({
      worktreeChats: {
        'p/w': {
          tabs:
            change === 'delete'
              ? []
              : [
                  {
                    ...tab(),
                    messages: change === 'stream' ? [message('live')] : [],
                  },
                ],
          activeTabId: 'chat',
        },
      },
    });
    resolve(initialPage);
    if (change === 'delete') await pending;
    else await expect(pending).rejects.toThrow("Couldn't load messages.");
    expect(
      store
        .getState()
        .worktreeChats['p/w'].tabs.flatMap((row) => row.messages)
        .some((row) => row.id === 'newer'),
    ).toBe(false);
  },
);

const loadedTurnsTab = (): ReturnType<typeof fromPersistedTab> => ({
  ...tab(),
  messages: [message('newer')],
  transcriptLoaded: true,
  transcript: {
    format: 'complete-message-jsonl-v1' as const,
    committedMessageCount: 3,
    committedByteLength: 100,
    transcriptRevision: 1,
    hasActiveSidecar: false,
  },
  transcriptWindow: {
    view: 'turns' as const,
    turns: [],
    before: 2,
    messageOrdinals: { newer: 2 },
    totalMessages: 3,
    transcriptRevision: 1,
  },
});
const olderTurnsPage: TranscriptPage = {
  view: 'turns',
  messages: [message('older')],
  turns: [],
  messageOrdinals: { older: 1 },
  before: 1,
  totalMessages: 4,
  transcriptRevision: 1,
};

it('merges an earlier page below a tail that streamed while it was in flight', async () => {
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': { tabs: [loadedTurnsTab()], activeTabId: 'chat' },
    },
  }));
  registerChatStoreApi(store);
  let resolve: (page: TranscriptPage) => void = () => undefined;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        getTranscriptPage: () =>
          new Promise<TranscriptPage>((done) => {
            resolve = done;
          }),
      },
    },
  });
  const pending = loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );
  // A streamed row lands at the tail and the durable revision advances.
  const current = store.getState().worktreeChats['p/w'].tabs[0];
  store.setState({
    worktreeChats: {
      'p/w': {
        tabs: [
          {
            ...current,
            messages: [...current.messages, message('live')],
            transcript: current.transcript
              ? { ...current.transcript, transcriptRevision: 2 }
              : undefined,
            transcriptWindow: current.transcriptWindow
              ? { ...current.transcriptWindow, transcriptRevision: 2 }
              : undefined,
          },
        ],
        activeTabId: 'chat',
      },
    },
  });
  resolve(olderTurnsPage);
  await expect(pending).resolves.toBeUndefined();
  const installed = store.getState().worktreeChats['p/w'].tabs[0];
  expect(installed.messages.map((row) => row.id)).toEqual([
    'older',
    'newer',
    'live',
  ]);
  expect(installed.transcriptWindow?.before).toBe(1);
});

it('still rejects an earlier page that is newer than the store', async () => {
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': { tabs: [loadedTurnsTab()], activeTabId: 'chat' },
    },
  }));
  registerChatStoreApi(store);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        getTranscriptPage: () =>
          Promise.resolve({ ...olderTurnsPage, transcriptRevision: 5 }),
      },
    },
  });
  await expect(
    loadChatTranscriptPage(
      { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
      true,
    ),
  ).rejects.toThrow("Couldn't load messages.");
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['newer']);
});

it('accepts a page across metadata-only descriptor replacement at the same durable revision', async () => {
  const initial = {
    ...tab(),
    transcript: {
      format: 'complete-message-jsonl-v1' as const,
      committedMessageCount: 3,
      committedByteLength: 100,
      transcriptRevision: 1,
      hasActiveSidecar: false,
    },
  };
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: { 'p/w': { tabs: [initial], activeTabId: 'chat' } },
  }));
  registerChatStoreApi(store);
  let resolve: (page: TranscriptPage) => void = () => undefined;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        getTranscriptPage: () =>
          new Promise<TranscriptPage>((done) => {
            resolve = done;
          }),
      },
    },
  });
  const pending = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  store.setState({
    worktreeChats: {
      'p/w': {
        tabs: [
          {
            ...initial,
            title: 'Renamed',
            transcript: { ...initial.transcript },
          },
        ],
        activeTabId: 'chat',
      },
    },
  });
  resolve(initialPage);
  await pending;
  expect(store.getState().worktreeChats['p/w'].tabs[0]).toMatchObject({
    title: 'Renamed',
    transcriptLoaded: true,
    messages: [human, message('newer')],
  });
});

it.each(['before-read', 'during-read'] as const)(
  'keeps a queued hook cancellable when its initial transcript is persisted (%s)',
  async (timing) => {
    const initial = tab();
    initial.queuedHookPlaceholder = timing === 'before-read';
    initial.queuedMessages = [
      { text: 'Hook prompt', queuedHookQueueId: 'queue-1' },
    ];
    const store = create<ChatState>(() => ({
      ...useChatStore.getInitialState(),
      worktreeChats: { 'p/w': { tabs: [initial], activeTabId: 'chat' } },
    }));
    registerChatStoreApi(store);
    let resolve: (page: TranscriptPage) => void = () => undefined;
    const read = jest.fn(
      () =>
        new Promise<TranscriptPage>((done) => {
          resolve = done;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { getTranscriptPage: read } },
    });
    const pending = loadChatTranscriptPage({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'chat',
    });
    if (timing === 'during-read') {
      store.setState({
        worktreeChats: {
          'p/w': {
            tabs: [{ ...initial, queuedHookPlaceholder: true }],
            activeTabId: 'chat',
          },
        },
      });
    }
    resolve(initialPage);
    await pending;
    const current = store.getState().worktreeChats['p/w'].tabs[0];
    expect(current.messages).toEqual([]);
    expect(current.queuedHookPlaceholder).toBe(true);
    if (timing === 'before-read') expect(read).not.toHaveBeenCalled();
  },
);

it('leaves stale newest-page reads to catch-up without changing lazy older-page loading', async () => {
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': {
        tabs: [{ ...loadedTurnsTab(), transcriptStale: true }],
        activeTabId: 'chat',
      },
    },
  }));
  registerChatStoreApi(store);
  const read = jest.fn(() => Promise.resolve(olderTurnsPage));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
  await loadChatTranscriptPage(target);
  expect(read).not.toHaveBeenCalled();
  await loadChatTranscriptPage(target, true);
  expect(read).toHaveBeenCalledTimes(1);
  const refreshed = store.getState().worktreeChats['p/w'].tabs[0];
  expect(refreshed.messages.map((row) => row.id)).toEqual(['older', 'newer']);
  expect(refreshed.transcriptStale).toBe(true);
});
