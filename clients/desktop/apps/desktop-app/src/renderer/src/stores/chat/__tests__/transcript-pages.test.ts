/** @jest-environment jsdom */
import { create, type StoreApi } from 'zustand';
import type { ChatState } from '../state';
import { registerChatStoreApi } from '../store-ref';
import { fromPersistedTab } from '../persisted-tabs';
import {
  installTranscriptPage,
  loadChatTranscriptPage,
} from '../transcript-pages';
import type {
  ChatTranscriptPageRequest,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import { applyCanonicalChanges } from '../canonical-changes';
import { useChatStore } from '../../chatStore';
import { useActivityStore } from '../../activityStore';
import { presentedMessages } from '../optimistic-presentation';
import { computeTurnSummary } from '@canopy/desktop-shared/lib/turn-utils';
import {
  loadedTranscriptPageCount,
  recordLoadedTranscriptPage,
  transcriptResetReloadKey,
  replaceLoadedTranscriptPageCount,
  MAX_TRANSCRIPT_RESET_PAGES,
} from '../transcript-reset';

type AdoptedChatTab = Parameters<
  ReturnType<typeof useActivityStore.getState>['adoptChatMessages']
>[2];

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

it('keeps an ordinal-less live row beside its array predecessor when an older page fills in ranks', () => {
  const current = {
    ...tab(),
    messages: [message('predecessor'), message('live')],
    transcriptLoaded: true,
    transcriptWindow: {
      view: 'turns' as const,
      turns: [],
      before: 2,
      messageOrdinals: { predecessor: 2 },
      totalMessages: 4,
      transcriptRevision: 1,
    },
  };
  const installed = installTranscriptPage(
    current,
    {
      view: 'turns',
      messages: [message('older'), message('successor')],
      turns: [],
      messageOrdinals: { older: 1, successor: 3 },
      before: 1,
      totalMessages: 4,
      transcriptRevision: 1,
    },
    true,
  );

  expect(installed.messages.map((row) => row.id)).toEqual([
    'older',
    'predecessor',
    'live',
    'successor',
  ]);
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

const loadedTranscript: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 3,
  committedByteLength: 100,
  transcriptRevision: 1,
  hasActiveSidecar: false,
};
const loadedTranscriptWindow: Omit<TranscriptPage, 'messages'> = {
  view: 'turns',
  turns: [],
  before: 2,
  messageOrdinals: { newer: 2 },
  totalMessages: 3,
  transcriptRevision: 1,
};

const loadedTurnsTab = (): ReturnType<typeof fromPersistedTab> => ({
  ...tab(),
  messages: [message('newer')],
  transcriptLoaded: true,
  transcript: loadedTranscript,
  transcriptWindow: loadedTranscriptWindow,
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

const deferredTranscriptReads = (): {
  read: jest.Mock<
    Promise<TranscriptPage>,
    [request: ChatTranscriptPageRequest]
  >;
  resolve: (index: number, page: TranscriptPage) => void;
} => {
  const resolvers: Array<(page: TranscriptPage) => void> = [];
  const read = jest.fn<Promise<TranscriptPage>, [ChatTranscriptPageRequest]>(
    () =>
      new Promise<TranscriptPage>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  const resolve = (index: number, page: TranscriptPage): void => {
    const finish = resolvers[index];
    if (!finish)
      throw new Error(`No transcript page request at index ${index}`);
    finish(page);
  };
  return { read, resolve };
};

const freshTurnsPage: TranscriptPage = {
  view: 'turns',
  messages: [message('fresh')],
  turns: [],
  messageOrdinals: { fresh: 0 },
  before: undefined,
  totalMessages: 1,
  transcriptRevision: 2,
};

const createTranscriptPageStore = (
  initialTab: ReturnType<typeof fromPersistedTab>,
): StoreApi<ChatState> => {
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': { tabs: [initialTab], activeTabId: 'chat' },
    },
  }));
  registerChatStoreApi(store);
  return store;
};

const resetTranscriptWindow = (
  store: StoreApi<ChatState>,
  revision = 2,
): void => {
  const scope = store.getState().worktreeChats['p/w'];
  const current = scope?.tabs.find((tab) => tab.id === 'chat');
  const transcript = current?.transcript;
  if (!scope || !current || !transcript)
    throw new Error('Expected a transcript descriptor');
  store.setState({
    worktreeChats: {
      ...store.getState().worktreeChats,
      'p/w': {
        ...scope,
        tabs: scope.tabs.map((tab) =>
          tab.id === current.id
            ? {
                ...current,
                transcriptLoaded: false,
                transcript: {
                  ...transcript,
                  transcriptRevision: revision,
                },
                transcriptWindow: current.transcriptWindow
                  ? {
                      ...current.transcriptWindow,
                      transcriptRevision: revision,
                    }
                  : undefined,
              }
            : tab,
        ),
      },
    },
  });
};

it('transparently retries an earlier page from the old window after a retained-window reset', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  const olderRequest = loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );

  resetTranscriptWindow(store);
  deferred.resolve(0, {
    ...olderTurnsPage,
    messages: [message('stale-older')],
    messageOrdinals: { 'stale-older': 1 },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(deferred.read).toHaveBeenCalledTimes(2);
  expect(store.getState().worktreeChats['p/w'].tabs[0].messages).toEqual([
    message('newer'),
  ]);

  deferred.resolve(1, {
    ...freshTurnsPage,
    messages: [message('newer'), message('fresh')],
    messageOrdinals: { newer: 2, fresh: 3 },
  });
  await olderRequest;
  const reloaded = store.getState().worktreeChats['p/w'].tabs[0];
  expect(reloaded.messages.map((row) => row.id)).toEqual(['newer', 'fresh']);

  // The old response did not cross the reset even though its rows were valid
  // for the retained, pre-reset transcript window.
  expect(reloaded.messages.map((row) => row.id)).not.toContain('stale-older');
});

it('coalesces duplicate newest reloads while one retained-window reset is loading', async () => {
  const initial = {
    ...loadedTurnsTab(),
    messages: [message('anchor')],
  };
  const store = createTranscriptPageStore(initial);
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store);

  const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
  const first = loadChatTranscriptPage(target);
  const duplicate = loadChatTranscriptPage(target);
  expect(deferred.read).toHaveBeenCalledTimes(1);

  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [message('anchor'), message('fresh')],
    messageOrdinals: { anchor: 2, fresh: 3 },
  });
  await Promise.all([first, duplicate]);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['anchor', 'fresh']);
});

it('restarts one staged reload at the newest reset revision when another reset arrives in flight', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('anchor'), message('middle'), message('newer')],
    transcriptWindow: {
      view: 'turns',
      turns: [],
      before: 1,
      messageOrdinals: { anchor: 1, middle: 2, newer: 3 },
      totalMessages: 4,
      transcriptRevision: 1,
    },
  });
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store, 2);

  const target = { projectId: 'p', worktreeId: 'w', chatId: 'chat' };
  const reload = loadChatTranscriptPage(target);
  resetTranscriptWindow(store, 3);
  const coalescedReload = loadChatTranscriptPage(target);
  expect(deferred.read).toHaveBeenCalledTimes(1);

  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [message('obsolete-newest')],
    messageOrdinals: { 'obsolete-newest': 3 },
    before: 2,
    transcriptRevision: 2,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(deferred.read).toHaveBeenCalledTimes(2);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['anchor', 'middle', 'newer']);

  deferred.resolve(1, {
    ...freshTurnsPage,
    messages: [message('anchor'), message('newest')],
    messageOrdinals: { anchor: 2, newest: 3 },
    transcriptRevision: 3,
  });
  await Promise.all([reload, coalescedReload]);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['anchor', 'newest']);
});

it('keeps the displayed window intact until staged newest and older pages install atomically', async () => {
  const initialMessages = [
    message('oldest'),
    message('middle'),
    message('newer'),
  ];
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: initialMessages,
    transcriptWindow: {
      view: 'turns',
      turns: [],
      before: 2,
      messageOrdinals: { oldest: 2, middle: 3, newer: 4 },
      totalMessages: 5,
      transcriptRevision: 1,
    },
  });
  replaceLoadedTranscriptPageCount(
    store,
    transcriptResetReloadKey('p/w', 'chat', loadedTurnsTab().createdAt),
    2,
  );
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store);

  const reload = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [message('newest')],
    messageOrdinals: { newest: 7 },
    before: 7,
    totalMessages: 8,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(deferred.read).toHaveBeenCalledTimes(2);
  expect(store.getState().worktreeChats['p/w'].tabs[0].messages).toEqual(
    initialMessages,
  );

  deferred.resolve(1, {
    ...olderTurnsPage,
    messages: [message('oldest'), message('middle'), message('newer')],
    turns: [],
    messageOrdinals: { oldest: 4, middle: 5, newer: 6 },
    before: 4,
    totalMessages: 8,
    transcriptRevision: 2,
  });
  await reload;
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['oldest', 'middle', 'newer', 'newest']);
});

it('loads only the newest page when the pre-reset row is already in the newest page', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('newer')],
  });
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store);

  const reload = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [message('newer'), message('fresh')],
    messageOrdinals: { newer: 2, fresh: 3 },
  });
  await reload;

  expect(deferred.read).toHaveBeenCalledTimes(1);
  expect(deferred.read.mock.calls[0]?.[0]).not.toHaveProperty('before');
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['newer', 'fresh']);
});

it('loads only the newest page for a bottom-follow reset even when older rows were retained', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('oldest'), message('newer')],
  });
  const read = jest.fn(() =>
    Promise.resolve({
      ...freshTurnsPage,
      messages: [message('newest')],
      messageOrdinals: { newest: 4 },
      before: 3,
    }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  resetTranscriptWindow(store);

  await loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    false,
    undefined,
    { retainOlderWindow: false },
  );

  expect(read).toHaveBeenCalledTimes(1);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['newest']);
});

it('bounds a reset reload by transcript page requests, not rows or turns', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('anchor')],
  });
  replaceLoadedTranscriptPageCount(
    store,
    transcriptResetReloadKey('p/w', 'chat', loadedTurnsTab().createdAt),
    MAX_TRANSCRIPT_RESET_PAGES + 2,
  );
  let pageNumber = 0;
  const read = jest.fn((): Promise<TranscriptPage> => {
    pageNumber += 1;
    return Promise.resolve({
      ...freshTurnsPage,
      messages: [message(`page-${pageNumber}`)],
      messageOrdinals: { [`page-${pageNumber}`]: pageNumber },
      before: pageNumber,
      totalMessages: MAX_TRANSCRIPT_RESET_PAGES + 2,
    });
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  resetTranscriptWindow(store);

  await loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });

  expect(read).toHaveBeenCalledTimes(MAX_TRANSCRIPT_RESET_PAGES);
  expect(store.getState().worktreeChats['p/w'].tabs[0].transcriptLoaded).toBe(
    true,
  );
});

it('continues a reset reload from the oldest cursor until the pre-reset anchor is found', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('anchor')],
  });
  replaceLoadedTranscriptPageCount(
    store,
    transcriptResetReloadKey('p/w', 'chat', loadedTurnsTab().createdAt),
    2,
  );
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store);

  const reload = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [message('fresh')],
    messageOrdinals: { fresh: 4 },
    before: 4,
    totalMessages: 6,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(deferred.read).toHaveBeenCalledTimes(2);
  const olderRequest = deferred.read.mock.calls[1]?.[0];
  expect(olderRequest?.before).toBe(4);

  deferred.resolve(1, {
    ...olderTurnsPage,
    messages: [message('anchor'), message('middle'), message('newer')],
    turns: [],
    messageOrdinals: { anchor: 1, middle: 2, newer: 3 },
    before: 1,
    totalMessages: 6,
    transcriptRevision: 2,
  });
  await reload;
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['anchor', 'middle', 'newer', 'fresh']);
});

it('does not merge an old turn page into a reset reload that reuses its turn id', async () => {
  const turn = {
    id: 'turn-id',
    start: 2,
    end: 2,
    complete: true,
    summary: computeTurnSummary([]),
    finalMessageIds: ['newer'],
    before: 1,
  };
  const initial = loadedTurnsTab();
  const initialWindow = initial.transcriptWindow;
  if (!initialWindow || initialWindow.view !== 'turns')
    throw new Error('Expected a turns transcript window');
  const store = createTranscriptPageStore({
    ...initial,
    transcriptWindow: { ...initialWindow, turns: [turn] },
  });
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  const olderRequest = loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
    'turn-id',
  );

  resetTranscriptWindow(store);
  deferred.resolve(0, {
    ...olderTurnsPage,
    turnId: 'turn-id',
    messages: [message('stale-turn-row')],
    messageOrdinals: { 'stale-turn-row': 1 },
    turns: [{ ...turn, start: 1, end: 2 }],
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(deferred.read).toHaveBeenCalledTimes(2);

  deferred.resolve(1, {
    ...freshTurnsPage,
    messages: [message('newer')],
    turns: [{ ...turn, start: 10, end: 10, before: undefined }],
    messageOrdinals: { newer: 10 },
  });
  await olderRequest;
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['newer']);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).not.toContain('stale-turn-row');
});

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

it('accepts an earlier page with a newer revision when main has not reset its ranks', async () => {
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
  ).resolves.toBeUndefined();
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['older', 'newer']);
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

it('stops at the previously loaded page count when the old anchor was removed', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  const key = transcriptResetReloadKey(
    'p/w',
    'chat',
    loadedTurnsTab().createdAt,
  );
  recordLoadedTranscriptPage(store, key, true);
  const read = jest.fn(() => Promise.resolve({ ...freshTurnsPage, before: 4 }));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  resetTranscriptWindow(store);
  await loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(loadedTranscriptPageCount(store, key)).toBe(2);
});

it('retries a rejected in-flight older page through the reset without a load error', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  let rejectRead: (error: Error) => void = () => undefined;
  const read = jest
    .fn<Promise<TranscriptPage>, [ChatTranscriptPageRequest]>()
    .mockImplementationOnce(
      () =>
        new Promise<TranscriptPage>((_resolve, reject) => {
          rejectRead = reject;
        }),
    )
    .mockResolvedValueOnce({
      ...freshTurnsPage,
      messages: [message('newer')],
      messageOrdinals: { newer: 3 },
    });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  const older = loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );
  resetTranscriptWindow(store);
  rejectRead(new Error("Couldn't load messages."));
  await expect(older).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(2);
  expect(store.getState().worktreeChats['p/w'].tabs[0].transcriptLoaded).toBe(
    true,
  );
});

it('counts actual older page installs when bounding the next reset', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  const key = transcriptResetReloadKey(
    'p/w',
    'chat',
    loadedTurnsTab().createdAt,
  );
  const read = jest.fn().mockResolvedValue(olderTurnsPage);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  await loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );
  expect(loadedTranscriptPageCount(store, key)).toBe(2);
});

it('retries an older read invalidated by a locally applied rank-safe reset', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  let rejectRead: (error: Error) => void = () => undefined;
  const read = jest
    .fn<Promise<TranscriptPage>, [ChatTranscriptPageRequest]>()
    .mockImplementationOnce(
      () =>
        new Promise<TranscriptPage>((_resolve, reject) => {
          rejectRead = reject;
        }),
    )
    .mockResolvedValueOnce({ ...olderTurnsPage, transcriptRevision: 2 });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  const pending = loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );
  const scope = store.getState().worktreeChats['p/w'];
  const descriptor = scope.tabs[0].transcript;
  if (!descriptor) throw new Error('Expected descriptor');
  const applied = applyCanonicalChanges(
    {
      chatState: scope,
      archives: [],
      runtimeByChatId: {},
      pendingQuestions: {},
    },
    [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: message('inserted'),
        afterMessageId: 'newer',
      },
      {
        type: 'transcript.updated',
        chatId: 'chat',
        reset: true,
        transcript: { ...descriptor, transcriptRevision: 2 },
      },
    ],
    { projectId: 'p', worktreeId: 'w' },
  );
  store.setState({ worktreeChats: { 'p/w': applied.chatState } });
  rejectRead(new Error("Couldn't load messages."));
  await pending;
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0]).toMatchObject({
    before: 2,
    transcriptRevision: 2,
  });
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['older', 'newer', 'inserted']);
});

it('restores history beyond a sticky prompt included by every newest page', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    messages: [message('prompt'), message('older'), message('newer')],
    transcriptWindow: {
      view: 'turns',
      turns: [],
      before: 5,
      messageOrdinals: { prompt: 0, older: 5, newer: 6 },
      totalMessages: 7,
      transcriptRevision: 1,
    },
  });
  replaceLoadedTranscriptPageCount(
    store,
    transcriptResetReloadKey('p/w', 'chat', loadedTurnsTab().createdAt),
    2,
  );
  const read = jest
    .fn()
    .mockResolvedValueOnce({
      ...freshTurnsPage,
      messages: [message('prompt'), message('fresh')],
      messageOrdinals: { prompt: 0, fresh: 10 },
      before: 10,
    })
    .mockResolvedValueOnce({
      ...freshTurnsPage,
      messages: [message('older'), message('newer')],
      messageOrdinals: { older: 6, newer: 7 },
      before: 6,
    });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  resetTranscriptWindow(store);
  await loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    store.getState().worktreeChats['p/w'].tabs[0].messages.map((row) => row.id),
  ).toEqual(['prompt', 'older', 'newer', 'fresh']);
});

it('lets authoritative replacement content win while preserving new live rows received during reload', async () => {
  const store = createTranscriptPageStore(loadedTurnsTab());
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  resetTranscriptWindow(store);
  const pending = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });
  const scope = store.getState().worktreeChats['p/w'];
  store.setState({
    worktreeChats: {
      'p/w': {
        ...scope,
        tabs: scope.tabs.map((tab) => ({
          ...tab,
          messages: [...tab.messages, message('live')],
          transcript: tab.transcript
            ? { ...tab.transcript, transcriptRevision: 3 }
            : undefined,
        })),
      },
    },
  });
  const authoritative = {
    ...message('newer'),
    blocks: [{ type: 'text' as const, text: 'authoritative replacement' }],
  };
  deferred.resolve(0, {
    ...freshTurnsPage,
    messages: [authoritative],
    messageOrdinals: { newer: 3 },
  });
  await pending;
  expect(store.getState().worktreeChats['p/w'].tabs[0].messages).toEqual([
    authoritative,
    message('live'),
  ]);
});

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

it('installs a catch-up page over a pending reset instead of reloading the reset window', async () => {
  const store = createTranscriptPageStore({
    ...loadedTurnsTab(),
    transcriptStale: true,
  });
  resetTranscriptWindow(store);
  const read = jest.fn(() => Promise.resolve(freshTurnsPage));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  const catchUp = jest.fn(
    (tab: ReturnType<typeof fromPersistedTab>, page: TranscriptPage) => {
      const next = installTranscriptPage(tab, page, false);
      delete next.transcriptStale;
      return next;
    },
  );
  await loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    false,
    undefined,
    { catchUp },
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(catchUp).toHaveBeenCalledTimes(1);
  const caughtUp = store.getState().worktreeChats['p/w'].tabs[0];
  expect(caughtUp.messages.map((row) => row.id)).toEqual(['fresh']);
  expect(caughtUp.transcriptLoaded).toBe(true);
  expect(caughtUp.transcriptStale).toBeUndefined();
});

it('adopts a chat’s background launches when its first page loads', async () => {
  // A chat that was not open at startup loads its messages here. Its
  // background launches need the activity store's adoption and liveness
  // pass, or their launch receipts read as running forever.
  const adoptChatMessages = jest.fn<void, [string, string, AdoptedChatTab]>();
  useActivityStore.setState({ adoptChatMessages });
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: { 'p/w': { tabs: [tab()], activeTabId: 'chat' } },
  }));
  registerChatStoreApi(store);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { getTranscriptPage: () => Promise.resolve(initialPage) },
    },
  });

  await loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });

  expect(adoptChatMessages).toHaveBeenCalledTimes(1);
  const call = adoptChatMessages.mock.calls[0];
  expect(call?.slice(0, 2)).toEqual(['p', 'w']);
  expect(call?.[2].id).toBe('chat');
  expect(
    call?.[2].messages.some((row) => 'id' in row && row.id === 'newer'),
  ).toBe(true);
});

it('does not adopt background activity for an earlier page', async () => {
  const adoptChatMessages = jest.fn();
  useActivityStore.setState({ adoptChatMessages });
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
      chat: { getTranscriptPage: () => Promise.resolve(olderTurnsPage) },
    },
  });

  await loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    true,
  );

  expect(adoptChatMessages).not.toHaveBeenCalled();
});

it('adopts background launches when a hover prefetch loads the chat', async () => {
  // Hovering a tab that is not loaded catches it up through the catch-up
  // callback; the click that follows finds it loaded, so this is the load.
  const adoptChatMessages = jest.fn<void, [string, string, AdoptedChatTab]>();
  useActivityStore.setState({ adoptChatMessages });
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: { 'p/w': { tabs: [tab()], activeTabId: 'chat' } },
  }));
  registerChatStoreApi(store);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { getTranscriptPage: () => Promise.resolve(initialPage) },
    },
  });

  await loadChatTranscriptPage(
    { projectId: 'p', worktreeId: 'w', chatId: 'chat' },
    false,
    undefined,
    { catchUp: (current, page) => installTranscriptPage(current, page, false) },
  );

  expect(adoptChatMessages).toHaveBeenCalledTimes(1);
  expect(adoptChatMessages.mock.calls[0]?.[2].id).toBe('chat');
});

it('adopts background launches when a pending reset reload loads the chat', async () => {
  // A reset on a chat that is not loaded leaves it with a window to reload;
  // opening it then takes the reset reload, not the ordinary page install.
  const adoptChatMessages = jest.fn<void, [string, string, AdoptedChatTab]>();
  useActivityStore.setState({ adoptChatMessages });
  const store = createTranscriptPageStore(loadedTurnsTab());
  resetTranscriptWindow(store);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { getTranscriptPage: () => Promise.resolve(freshTurnsPage) },
    },
  });

  await loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });

  expect(store.getState().worktreeChats['p/w'].tabs[0].transcriptLoaded).toBe(
    true,
  );
  expect(adoptChatMessages).toHaveBeenCalledTimes(1);
  expect(
    adoptChatMessages.mock.calls[0]?.[2].messages.some(
      (row) => 'id' in row && row.id === 'fresh',
    ),
  ).toBe(true);
});

it('adopts background launches when a reset lands during the first page load', async () => {
  const adoptChatMessages = jest.fn<void, [string, string, AdoptedChatTab]>();
  useActivityStore.setState({ adoptChatMessages });
  const store = createTranscriptPageStore(tab());
  const deferred = deferredTranscriptReads();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: deferred.read } },
  });
  const load = loadChatTranscriptPage({
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat',
  });

  // The reset marks the unloaded chat's window for a reload mid-read.
  const scope = store.getState().worktreeChats['p/w'];
  store.setState({
    worktreeChats: {
      'p/w': {
        ...scope,
        tabs: scope.tabs.map((row) => ({
          ...row,
          transcript: loadedTranscript,
          transcriptWindow: {
            ...loadedTranscriptWindow,
            transcriptRevision: 2,
          },
        })),
      },
    },
  });
  deferred.resolve(0, initialPage);
  await new Promise((resolve) => setTimeout(resolve, 0));
  deferred.resolve(1, freshTurnsPage);
  await load;

  expect(deferred.read).toHaveBeenCalledTimes(2);
  expect(store.getState().worktreeChats['p/w'].tabs[0].transcriptLoaded).toBe(
    true,
  );
  expect(adoptChatMessages).toHaveBeenCalledTimes(1);
});

it('normalizes legacy outcome counts at the transcript page boundary without inventing metadata', () => {
  const wire = JSON.parse(
    JSON.stringify({
      ...initialPage,
      view: 'turns',
      messageOrdinals: { newer: 0 },
      turns: [
        {
          id: 'human',
          start: 0,
          end: 1,
          complete: true,
          summary: computeTurnSummary([]),
          finalMessageIds: [],
          outcomes: { blocked: 0, failed: 1 },
          continuations: {
            wake: {
              complete: true,
              summary: computeTurnSummary([]),
              finalMessageIds: [],
              outcomes: { blocked: 0, failed: 2 },
            },
          },
        },
      ],
    }),
  ) as TranscriptPage;
  const installed = installTranscriptPage(tab(), wire, false);
  expect(installed.transcriptWindow?.turns?.[0]?.outcomes).toEqual({
    blocked: 0,
    failed: 1,
    interrupted: 0,
  });
  expect(
    installed.transcriptWindow?.turns?.[0]?.continuations?.wake?.outcomes,
  ).toEqual({ blocked: 0, failed: 2, interrupted: 0 });
  expect(
    installTranscriptPage(
      tab(),
      {
        ...wire,
        turns: wire.turns?.map((turn) => ({ ...turn, outcomes: undefined })),
      },
      false,
    ).transcriptWindow?.turns?.[0]?.outcomes,
  ).toBeUndefined();
});
