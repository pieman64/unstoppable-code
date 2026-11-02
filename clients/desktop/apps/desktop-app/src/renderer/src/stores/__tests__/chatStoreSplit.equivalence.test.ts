/**
 * Phase 15 store equivalence. The chat store stays the single writer; React
 * reads keyed render stores (`stores/chat/render-stores.ts`) and the sidebar
 * store (`chatSidebarStore.ts`), both derived from the frame-batched view.
 *
 * For one sequence of committed `chat:state-changed` events (snapshot
 * install, streamed content applied per frame, an older-page prepend, tab
 * create, fork, close, archive and restore, a transcript reset, a gap
 * refresh, questions, runtime lifecycle, a second worktree and live
 * delegates), after every step:
 * - every per-chat, per-worktree, tab-strip and sidebar value equals the same
 *   derivation over the view's snapshot (never ahead of it, never stale), by
 *   identity where the old selectors returned store objects;
 * - the chat store's own state is identical whether or not anything reads
 *   the new stores, so the projections are read-only;
 * - streamed content notifies only its own chat's and worktree's stores.
 */
import type {
  CanopyApi,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import type * as ChatStoreModule from '../chatStore';
import type * as ChatSidebarStoreModule from '../chatSidebarStore';
import type * as HydrationModule from '../chat/hydration';
import type * as RenderCadenceModule from '../chat/render-cadence';
import type * as RenderStoresModule from '../chat/render-stores';
import type * as TranscriptPagesModule from '../chat/transcript-pages';
import type * as DelegationStoreModule from '../delegationActivityStore';
import type * as BadgeKeysModule from '@/components/sidebar/chatBadgeKeys';
import type { FrameScheduler } from '../chat/frame-batched-store-view';
import type { ChatState } from '../chat/state';

const getStateMock = jest.fn<
  Promise<ChatStateSnapshot>,
  [{ projectId: string; worktreeId: string }]
>();
const getTranscriptPageMock = jest.fn<Promise<TranscriptPage>, [unknown]>();
const commandMock = jest.fn<
  Promise<ChatCommandResult>,
  [ChatCommandEnvelope<ChatCommand>]
>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

interface Loaded {
  chatStore: typeof ChatStoreModule;
  sidebar: typeof ChatSidebarStoreModule;
  cadence: typeof RenderCadenceModule;
  renderStores: typeof RenderStoresModule;
  pages: typeof TranscriptPagesModule;
  delegation: typeof DelegationStoreModule;
  badgeKeys: typeof BadgeKeysModule;
}

let loadedHydration: typeof HydrationModule | null = null;

// A pending idle-unload timer closes over its module instance, so it keeps a
// `jest.resetModules()` copy of the whole store graph alive until it fires.
function releaseLoadedChatStore(): void {
  loadedHydration?.clearIdleChatUnloadTimer();
  loadedHydration = null;
}

function load(): Loaded {
  releaseLoadedChatStore();
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        loadPreferences: jest
          .fn()
          .mockRejectedValue(new Error('preferences unavailable')),
        savePreferences: jest.fn().mockResolvedValue(undefined),
        discoverWorktreeEnv: jest.fn(),
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        github: {
          setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
          requestFastRefresh: jest.fn().mockResolvedValue(undefined),
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        approvals: {
          pendingRequests: jest.fn().mockResolvedValue([]),
          getResolvedDefault: jest.fn().mockResolvedValue('ask'),
          setMode: jest.fn().mockResolvedValue(undefined),
        },
        chat: {
          loadTabs: jest.fn(),
          activeSessions: jest.fn().mockResolvedValue({ activeChatIds: [] }),
          saveTabs: jest.fn().mockResolvedValue(undefined),
          saveTabsPartial: jest
            .fn()
            .mockResolvedValue({ needsFullSave: false }),
          getChatQueueSnapshot: jest.fn().mockResolvedValue([]),
          getState: getStateMock,
          getTranscriptPage: getTranscriptPageMock,
          setStateScopes: jest.fn().mockResolvedValue(undefined),
          archiveTab: jest.fn().mockResolvedValue([]),
          command: commandMock,
        },
      },
    },
  });
  const chatStore = jest.requireActual<typeof ChatStoreModule>('../chatStore');
  loadedHydration =
    jest.requireActual<typeof HydrationModule>('../chat/hydration');
  return {
    chatStore,
    sidebar: jest.requireActual<typeof ChatSidebarStoreModule>(
      '../chatSidebarStore',
    ),
    cadence: jest.requireActual<typeof RenderCadenceModule>(
      '../chat/render-cadence',
    ),
    renderStores: jest.requireActual<typeof RenderStoresModule>(
      '../chat/render-stores',
    ),
    pages: jest.requireActual<typeof TranscriptPagesModule>(
      '../chat/transcript-pages',
    ),
    delegation: jest.requireActual<typeof DelegationStoreModule>(
      '../delegationActivityStore',
    ),
    badgeKeys: jest.requireActual<typeof BadgeKeysModule>(
      '@/components/sidebar/chatBadgeKeys',
    ),
  };
}

const PROJECT = 'proj';
const WT1 = 'wt1';
const WT2 = 'wt2';
const KEY1 = `${PROJECT}/${WT1}`;
const KEY2 = `${PROJECT}/${WT2}`;

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp = 1,
): PersistedChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp };
}

function descriptor(revision: number, count: number): TranscriptDescriptor {
  return {
    format: 'complete-message-jsonl-v1',
    committedMessageCount: count,
    committedByteLength: count,
    transcriptRevision: revision,
    hasActiveSidecar: true,
    messageCount: count,
  };
}

function persistedTab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [
      message(`${id}-u1`, 'user', `hello ${id}`, 1),
      message(`${id}-a1`, 'assistant', `reply ${id}`, 2),
    ],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(
  worktreeId: string,
  revision: number,
  tabs: PersistedChatTab[],
  runtimeByChatId: ChatStateSnapshot['runtimeByChatId'] = {},
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    worktreeId,
    revision,
    tabsFile: { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' },
    archives: [],
    runtimeByChatId,
    queue: [],
  };
}

function event(
  worktreeId: string,
  baseRevision: number,
  changes: ChatStateChangedEvent['changes'],
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: `${worktreeId}-${baseRevision + 1}`,
    occurredAt: '2026-10-01T00:00:00.000Z',
    projectId: PROJECT,
    worktreeId,
    baseRevision,
    revision: baseRevision + 1,
    changes,
  };
}

function runtime(
  chatId: string,
  status: 'streaming' | 'completed' | 'idle',
  lastActivityAt: number,
): ChatStateChangedEvent['changes'][number] {
  return {
    type: 'runtime.patched',
    chatId,
    runtime: { status, queuedMessageIds: [], lastActivityAt },
  };
}

/** Streamed content: an upsert, an activity-only runtime patch, a descriptor. */
function streamed(
  worktreeId: string,
  base: number,
  chatId: string,
  messageId: string,
  text: string,
  count: number,
): ChatStateChangedEvent {
  return event(worktreeId, base, [
    {
      type: 'message.upserted',
      chatId,
      message: message(messageId, 'assistant', text, base),
    },
    runtime(chatId, 'streaming', base * 10),
    {
      type: 'transcript.updated',
      chatId,
      transcript: descriptor(base + 1, count),
      reset: false,
    },
  ]);
}

function manualScheduler(): FrameScheduler & { runFrame(): void } {
  const frames = new Map<number, () => void>();
  let next = 1;
  return {
    requestFrame(callback): number {
      const handle = next++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle): void {
      frames.delete(handle);
    },
    setTimer(): number {
      return next++;
    },
    clearTimer(): void {
      return undefined;
    },
    isHidden(): boolean {
      return false;
    },
    runFrame(): void {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

type Step =
  | { kind: 'event'; event: ChatStateChangedEvent; refresh?: ChatStateSnapshot }
  | { kind: 'page'; worktreeId: string; chatId: string; older: boolean }
  | { kind: 'delegates'; live: number };

/** The scenario, as built for one fresh store. */
function steps(): Step[] {
  return [
    // Streamed content in chat a1, three provider commits.
    { kind: 'event', event: streamed(WT1, 5, 'a1', 'a1-a2', 'He', 3) },
    { kind: 'event', event: streamed(WT1, 6, 'a1', 'a1-a2', 'Hel', 3) },
    { kind: 'event', event: streamed(WT1, 7, 'a1', 'a1-a2', 'Hello', 3) },
    // The turn completes; chat a1 is unread.
    {
      kind: 'event',
      event: event(WT1, 8, [
        runtime('a1', 'completed', 90),
        { type: 'tab.metadata_patched', tabId: 'a1', patch: { unread: true } },
      ]),
    },
    // Streamed content in the other worktree's chat.
    { kind: 'event', event: streamed(WT2, 5, 'b1', 'b1-a2', 'Other', 3) },
    // Older-page prepend for the body-less chat b2.
    { kind: 'page', worktreeId: WT2, chatId: 'b2', older: false },
    { kind: 'page', worktreeId: WT2, chatId: 'b2', older: true },
    // Tab create, then fork (a tab with fork metadata), then close.
    {
      kind: 'event',
      event: event(WT1, 9, [
        { type: 'tab.upserted', tab: persistedTab('a3', { messages: [] }) },
        { type: 'tab.active_changed', activeTabId: 'a3' },
      ]),
    },
    {
      kind: 'event',
      event: event(WT1, 10, [
        {
          type: 'tab.upserted',
          tab: persistedTab('a4', {
            title: 'Fork of a1',
            forkedFrom: {
              projectId: PROJECT,
              worktreeId: WT1,
              chatId: 'a1',
              atMessageId: 'a1-a1',
            },
          }),
        },
      ]),
    },
    {
      kind: 'event',
      event: event(WT1, 11, [{ type: 'tab.removed', tabId: 'a3' }]),
    },
    // A question in chat a2, answered by removal.
    {
      kind: 'event',
      event: event(WT1, 12, [
        {
          type: 'pending_question.upserted',
          question: {
            requestId: 'q1',
            chatId: 'a2',
            questions: [
              {
                question: 'Continue?',
                header: 'Continue',
                options: ['Yes'],
                multiSelect: false,
              },
            ],
          },
        },
        runtime('a2', 'streaming', 130),
      ]),
    },
    {
      kind: 'event',
      event: event(WT1, 13, [
        { type: 'pending_question.removed', requestId: 'q1', chatId: 'a2' },
        runtime('a2', 'completed', 140),
      ]),
    },
    // Archive chat a4, then restore it.
    {
      kind: 'event',
      event: event(WT1, 14, [
        {
          type: 'archive.upserted',
          archive: {
            chatId: 'a4',
            title: 'Fork of a1',
            archivedAt: '2026-10-01T00:00:00.000Z',
            createdAt: '2026-10-01T00:00:00.000Z',
            turnCount: 1,
            restorable: true,
            unread: false,
          },
        },
        { type: 'tab.removed', tabId: 'a4' },
      ]),
    },
    {
      kind: 'event',
      event: event(WT1, 15, [
        {
          type: 'archive.removed',
          archiveEntryId: 'archive-a4',
          chatId: 'a4',
        },
        { type: 'tab.upserted', tab: persistedTab('a4', { title: 'Fork' }) },
      ]),
    },
    // Reset chat a2 to a point: messages replaced, transcript reset.
    {
      kind: 'event',
      event: event(WT1, 16, [
        {
          type: 'messages.replaced',
          chatId: 'a2',
          messages: [message('a2-u1', 'user', 'hello a2', 1)],
          removedMessageIds: ['a2-u1', 'a2-a1'],
        },
        {
          type: 'transcript.updated',
          chatId: 'a2',
          transcript: descriptor(20, 1),
          reset: true,
        },
      ]),
    },
    // Live managed delegates in chat b1.
    { kind: 'delegates', live: 1 },
    // A gap: revision 19 arrives at 17; the refresh installs revision 20.
    {
      kind: 'event',
      event: event(WT1, 18, [runtime('a1', 'streaming', 200)]),
      refresh: snapshot(
        WT1,
        20,
        [
          persistedTab('a1', { unread: true }),
          persistedTab('a2'),
          persistedTab('a4', { title: 'Fork' }),
        ],
        {
          a1: {
            status: 'streaming',
            queuedMessageIds: [],
            lastActivityAt: 210,
          },
        },
      ),
    },
    { kind: 'event', event: streamed(WT1, 20, 'a1', 'a1-a3', 'After', 3) },
    { kind: 'delegates', live: 0 },
  ];
}

interface Run {
  loaded: Loaded;
  /** The chat store fields after each step. */
  states: unknown[];
}

function storeFields(state: ChatState): unknown {
  return {
    worktreeChats: state.worktreeChats,
    archivedChats: state.archivedChats,
    runtimeByChatId: state.runtimeByChatId,
    pendingQuestions: state.pendingQuestions,
    unreadWorktreeKeys: Array.from(state.unreadWorktreeKeys),
    chatStateSync: state.chatStateSync,
  };
}

async function run(
  options: {
    observe?: (loaded: Loaded, step: Step, phase: 'before' | 'after') => void;
    subscribeAll?: boolean;
  } = {},
): Promise<Run> {
  const loaded = load();
  const { useChatStore, chatStoreRenderView } = loaded.chatStore;
  getStateMock.mockImplementation((request) =>
    Promise.resolve(
      request.worktreeId === WT1
        ? snapshot(WT1, 5, [persistedTab('a1'), persistedTab('a2')], {
            a1: { status: 'idle', queuedMessageIds: [], lastActivityAt: 1 },
          })
        : snapshot(
            WT2,
            5,
            [
              persistedTab('b1'),
              persistedTab('b2', {
                messages: [],
                transcriptLoaded: false,
                transcript: descriptor(5, 4),
              }),
            ],
            {
              b1: {
                status: 'streaming',
                queuedMessageIds: [],
                lastActivityAt: 1,
              },
            },
          ),
    ),
  );
  await useChatStore.getState().loadTabsForTarget(PROJECT, WT1);
  await useChatStore.getState().loadTabsForTarget(PROJECT, WT2);
  await settle();
  if (options.subscribeAll) subscribeEverything(loaded);

  const scheduler = manualScheduler();
  const states: unknown[] = [];
  for (const step of steps()) {
    if (step.kind === 'event') {
      if (step.refresh) {
        getStateMock.mockReset();
        getStateMock.mockResolvedValue(step.refresh);
      }
      const state = useChatStore.getState();
      loaded.cadence.applyChatStateChangedForRender(step.event, {
        apply: state.handleChatStateChanged,
        runtimeByChatId: state.runtimeByChatId,
        view: chatStoreRenderView,
        scheduler,
      });
      await settle();
    } else if (step.kind === 'page') {
      getTranscriptPageMock.mockResolvedValueOnce(
        step.older
          ? {
              messages: [
                message('b2-old1', 'user', 'oldest'),
                message('b2-old2', 'assistant', 'older'),
              ],
              totalMessages: 4,
              transcriptRevision: 5,
            }
          : {
              messages: [
                message('b2-new1', 'user', 'newer'),
                message('b2-new2', 'assistant', 'newest'),
              ],
              before: 2,
              totalMessages: 4,
              transcriptRevision: 5,
            },
      );
      await loaded.pages.loadChatTranscriptPage(
        {
          projectId: PROJECT,
          worktreeId: step.worktreeId,
          chatId: step.chatId,
        },
        step.older,
      );
    } else {
      loaded.delegation.useDelegationActivityStore.setState({
        byChat:
          step.live > 0
            ? {
                [`${KEY2}/b1`]: {
                  projectId: PROJECT,
                  worktreeId: WT2,
                  chatId: 'b1',
                  live: step.live,
                  queued: 0,
                },
              }
            : {},
      });
    }
    options.observe?.(loaded, step, 'before');
    scheduler.runFrame();
    options.observe?.(loaded, step, 'after');
    states.push(storeFields(useChatStore.getState()));
  }
  return { loaded, states };
}

/** Subscribe to every render store the scenario can address. */
function subscribeEverything(loaded: Loaded): void {
  const { chatRenderStores } = loaded.chatStore;
  for (const key of [KEY1, KEY2]) {
    chatRenderStores.worktreeChat(key).subscribe(() => undefined);
    chatRenderStores.tabStrip(key).subscribe(() => undefined);
  }
  for (const [key, chatId] of [
    [KEY1, 'a1'],
    [KEY1, 'a2'],
    [KEY1, 'a3'],
    [KEY1, 'a4'],
    [KEY2, 'b1'],
    [KEY2, 'b2'],
  ] as const) {
    chatRenderStores.chatTab(key, chatId).subscribe(() => undefined);
    chatRenderStores.stripTabById(chatId).subscribe(() => undefined);
  }
  loaded.sidebar.useChatSidebarStore.subscribe(() => undefined);
}

/** Every render-store value equals the same derivation over the view. */
function expectProjectionsMatchView(loaded: Loaded): void {
  const { chatRenderStores, chatStoreRenderView } = loaded.chatStore;
  const view = chatStoreRenderView.getState();
  const { toChatTabStripTab } = loaded.renderStores;
  for (const key of [KEY1, KEY2]) {
    const chatState = view.worktreeChats[key];
    expect(chatRenderStores.worktreeChat(key).getState()).toBe(chatState);
    expect(chatRenderStores.tabStrip(key).getState()).toStrictEqual(
      (chatState?.tabs ?? []).map(toChatTabStripTab),
    );
    for (const chatId of ['a1', 'a2', 'a3', 'a4', 'b1', 'b2']) {
      const tab = chatState?.tabs.find((candidate) => candidate.id === chatId);
      const entry = chatRenderStores.chatTab(key, chatId).getState();
      expect(entry.tab).toBe(tab);
      expect(entry.runtime).toBe(view.runtimeByChatId[chatId]);
    }
  }
  for (const chatId of ['a1', 'a2', 'a3', 'a4', 'b1', 'b2']) {
    const tab = Object.values(view.worktreeChats)
      .flatMap((chatState) => chatState.tabs)
      .find((candidate) => candidate.id === chatId);
    const stripTab = chatRenderStores.stripTabById(chatId).getState();
    if (tab) {
      expect(stripTab).toStrictEqual(toChatTabStripTab(tab));
    } else {
      expect(stripTab).toBeUndefined();
    }
  }

  const sidebar = loaded.sidebar.useChatSidebarStore.getState();
  const live = loaded.delegation.useDelegationActivityStore.getState().byChat;
  expect(sidebar.badgeKeys).toStrictEqual(
    loaded.badgeKeys.deriveChatBadgeKeys(view, live),
  );
  expect(sidebar.unreadWorktreeKeys).toBe(view.unreadWorktreeKeys);
  expect(sidebar.pendingQuestions).toBe(view.pendingQuestions);
  expect(Object.keys(sidebar.worktrees)).toStrictEqual(
    Object.keys(view.worktreeChats),
  );
  for (const [key, chatState] of Object.entries(view.worktreeChats)) {
    expect(sidebar.worktrees[key]?.tabs).toStrictEqual(
      chatState.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        providerType: tab.providerType,
        status: tab.status,
        unread: tab.unread,
        pendingPlanExit: tab.pendingPlanExit,
      })),
    );
  }
}

beforeAll(() => {
  // Compile the store modules once, outside any test's timeout.
  load();
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  releaseLoadedChatStore();
});

describe('chat store split equivalence', () => {
  it('derives every render-store and sidebar value from the view after each step', async () => {
    const seen: string[] = [];
    const { loaded } = await run({
      subscribeAll: true,
      observe: (loaded, step, phase) => {
        seen.push(`${step.kind}:${phase}`);
        expectProjectionsMatchView(loaded);
        if (phase === 'after') {
          // After the frame, React's view (and so every projection) has
          // caught up with the store.
          expect(loaded.chatStore.chatStoreRenderView.getState()).toBe(
            loaded.chatStore.useChatStore.getState(),
          );
        }
      },
    });
    expect(seen).toHaveLength(steps().length * 2);

    // The scenario did what it says.
    const state = loaded.chatStore.useChatStore.getState();
    const tabs = (key: string): string[] =>
      state.worktreeChats[key]?.tabs.map((tab) => tab.id) ?? [];
    expect(tabs(KEY1)).toStrictEqual(['a1', 'a2', 'a4']);
    expect(tabs(KEY2)).toStrictEqual(['b1', 'b2']);
    // The gap refresh installed revision 20; one more event followed.
    expect(state.chatStateSync[KEY1]?.revision).toBe(21);
    expect(getStateMock).toHaveBeenCalled();
    const b2 = state.worktreeChats[KEY2]?.tabs.find((tab) => tab.id === 'b2');
    expect(b2?.messages.map((entry) => entry.id)).toStrictEqual([
      'b2-old1',
      'b2-old2',
      'b2-new1',
      'b2-new2',
    ]);
    const a1 = state.worktreeChats[KEY1]?.tabs.find((tab) => tab.id === 'a1');
    expect(a1?.messages.map((entry) => entry.id)).toContain('a1-a3');
    expect(state.archivedChats[KEY1]).toStrictEqual([]);
    // a1 streams again after the refresh; b1 never completed.
    expect(
      loaded.sidebar.useChatSidebarStore.getState().badgeKeys.streaming,
    ).toBe(`${KEY1},${KEY2}`);
  });

  it('derives the same values when nothing subscribed before the reads', async () => {
    await run({
      observe: (loaded, _step, phase) => {
        if (phase === 'after') expectProjectionsMatchView(loaded);
      },
    });
  });

  it('leaves the chat store state identical whether or not the new stores are read', async () => {
    const plain = await run();
    const projected = await run({
      subscribeAll: true,
      observe: (loaded) => expectProjectionsMatchView(loaded),
    });
    expect(projected.states).toStrictEqual(plain.states);
  });

  it('notifies only the streaming chat and its worktree for streamed content', async () => {
    const loaded = load();
    const { useChatStore, chatStoreRenderView, chatRenderStores } =
      loaded.chatStore;
    // The streaming chat's turn is already running, so each commit's
    // runtime patch is activity-only (streamed content, phase 12).
    getStateMock.mockImplementation((request) =>
      Promise.resolve(
        snapshot(
          request.worktreeId,
          5,
          [
            persistedTab(`${request.worktreeId}-x`),
            persistedTab(`${request.worktreeId}-y`),
          ],
          {
            [`${request.worktreeId}-x`]: {
              status: 'streaming',
              queuedMessageIds: [],
              lastActivityAt: 1,
            },
          },
        ),
      ),
    );
    await useChatStore.getState().loadTabsForTarget(PROJECT, WT1);
    await useChatStore.getState().loadTabsForTarget(PROJECT, WT2);
    await settle();

    const notified: string[] = [];
    const watch = (
      name: string,
      store: { subscribe: (l: () => void) => void },
    ): void => {
      store.subscribe(() => notified.push(name));
    };
    for (const key of [KEY1, KEY2]) {
      watch(`worktree:${key}`, chatRenderStores.worktreeChat(key));
      watch(`strip:${key}`, chatRenderStores.tabStrip(key));
    }
    for (const [key, chatId] of [
      [KEY1, `${WT1}-x`],
      [KEY1, `${WT1}-y`],
      [KEY2, `${WT2}-x`],
    ] as const) {
      watch(`chat:${chatId}`, chatRenderStores.chatTab(key, chatId));
      watch(`stripTab:${chatId}`, chatRenderStores.stripTabById(chatId));
    }
    watch('sidebar', loaded.sidebar.useChatSidebarStore);
    const stripBefore = chatRenderStores.tabStrip(KEY1).getState();
    const sidebarBefore = loaded.sidebar.useChatSidebarStore.getState();

    const scheduler = manualScheduler();
    [5, 6, 7].forEach((base, index) => {
      const state = useChatStore.getState();
      loaded.cadence.applyChatStateChangedForRender(
        streamed(WT1, base, `${WT1}-x`, 'reply', `text ${index}`, 3),
        {
          apply: state.handleChatStateChanged,
          runtimeByChatId: state.runtimeByChatId,
          view: chatStoreRenderView,
          scheduler,
        },
      );
    });
    // Nothing reaches the render stores before the frame.
    expect(notified).toStrictEqual([]);
    scheduler.runFrame();

    expect(notified.sort()).toStrictEqual(
      [`chat:${WT1}-x`, `worktree:${KEY1}`].sort(),
    );
    expect(chatRenderStores.tabStrip(KEY1).getState()).toBe(stripBefore);
    expect(loaded.sidebar.useChatSidebarStore.getState()).toBe(sidebarBefore);
    expect(
      chatRenderStores.chatTab(KEY1, `${WT1}-x`).getState().tab?.messages,
    ).toHaveLength(3);
  });

  it('keeps the archive map identity for a commit that leaves archives unchanged', async () => {
    const { chatStore } = load();
    const { useChatStore } = chatStore;
    getStateMock.mockResolvedValue(
      snapshot(WT1, 5, [persistedTab('a1'), persistedTab('a2')]),
    );
    await useChatStore.getState().loadTabsForTarget(PROJECT, WT1);
    await settle();
    const archivesBefore = useChatStore.getState().archivedChats;
    expect(Object.keys(archivesBefore)).toContain(KEY1);

    useChatStore
      .getState()
      .handleChatStateChanged(streamed(WT1, 5, 'a1', 'a1-a2', 'Hi', 3));
    expect(useChatStore.getState().archivedChats).toBe(archivesBefore);

    useChatStore.getState().handleChatStateChanged(
      event(WT1, 6, [
        {
          type: 'archive.upserted',
          archive: {
            chatId: 'a2',
            title: 'Tab a2',
            archivedAt: '2026-10-01T00:00:00.000Z',
            createdAt: '2026-10-01T00:00:00.000Z',
            turnCount: 1,
            restorable: true,
            unread: false,
          },
        },
        { type: 'tab.removed', tabId: 'a2' },
      ]),
    );
    const archivesAfter = useChatStore.getState().archivedChats;
    expect(archivesAfter).not.toBe(archivesBefore);
    expect(archivesAfter[KEY1]?.map((entry) => entry.chatId)).toStrictEqual([
      'a2',
    ]);
  });
});
