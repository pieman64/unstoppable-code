/**
 * Shared setup for the `chatStore.revisioned*.test.ts` suites.
 *
 * Every test re-imports the chat store graph after `jest.resetModules()`.
 * Each hydration also arms a ten-minute idle-unload timer whose callback
 * retains that graph, so `loadChatStore` and the shared `afterEach` cancel it
 * (CAN-5053). Before that cleanup each test retained about 33 MB, and the
 * single 144-test file ran a 4 GB CI Jest worker out of memory. With it, each
 * file here retains under 0.8 GB.
 *
 * `workerIdleMemoryLimit` only recycles a worker between files, so the split
 * also bounds the damage if a leak returns. Keep each revisioned test file
 * under about 50 tests (under 2 GB even at the old 33 MB per test). Add new
 * tests to the file whose topic fits, or to a new sibling
 * `chatStore.revisioned<Topic>.test.ts`, rather than growing one past that.
 */
import type {
  ActivityLiveBgTasksResponse,
  CanopyApi,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandResult,
  ChatStateChangedEvent,
  ChatStateSnapshot,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type * as ChatStoreModule from '../chatStore';
import type * as ChatHydrationModule from '../chat/hydration';
import type * as LiveBackgroundTaskStoreModule from '../liveBackgroundTaskStore';

export const loadPreferencesMock = jest.fn();
export const loadTabsMock = jest.fn();
export const activeSessionsMock = jest.fn();
export const saveTabsMock = jest.fn();
export const saveTabsPartialMock = jest.fn();
export const getChatQueueSnapshotMock = jest.fn();
export const getStateMock = jest.fn();
export const archiveTabMock = jest.fn();
export const changeModelMock = jest.fn();
export const forkOpenWorktreeTabsMock = jest.fn();
export const commandMock = jest.fn<
  Promise<ChatCommandResult>,
  [ChatCommandEnvelope<ChatCommand>]
>();
export const discoverWorktreeEnvMock = jest.fn();
export const pendingApprovalRequestsMock = jest.fn();
export const getResolvedDefaultMock = jest.fn();
export const setModeMock = jest.fn().mockResolvedValue(undefined);
export const toggleThinkingLevelMock = jest.fn().mockResolvedValue(undefined);
export const togglePlanModeMock = jest.fn().mockResolvedValue(undefined);

declare global {
  interface Window {
    api: CanopyApi;
  }
}

let clearIdleChatUnloadTimer: (() => void) | undefined;

export function loadChatStore(): typeof ChatStoreModule {
  // Module resets do not cancel the ten-minute hydration timer. Its callback
  // retains the previous store graph, including on reloads within one test.
  clearIdleChatUnloadTimer?.();
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        loadPreferences: loadPreferencesMock,
        savePreferences: jest.fn().mockResolvedValue(undefined),
        discoverWorktreeEnv: discoverWorktreeEnvMock,
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        github: {
          setForegroundWorktree: jest.fn().mockResolvedValue(undefined),
          requestFastRefresh: jest.fn().mockResolvedValue(undefined),
          requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
        },
        approvals: {
          pendingRequests: pendingApprovalRequestsMock,
          getResolvedDefault: getResolvedDefaultMock,
          setMode: setModeMock,
        },
        chat: {
          loadTabs: loadTabsMock,
          activeSessions: activeSessionsMock,
          saveTabs: saveTabsMock,
          saveTabsPartial: saveTabsPartialMock,
          getChatQueueSnapshot: getChatQueueSnapshotMock,
          getState: getStateMock,
          archiveTab: archiveTabMock,
          changeModel: changeModelMock,
          toggleThinkingLevel: toggleThinkingLevelMock,
          togglePlanMode: togglePlanModeMock,
          forkOpenWorktreeTabs: forkOpenWorktreeTabsMock,
          command: commandMock,
        },
      },
    },
  });
  const store = jest.requireActual<typeof ChatStoreModule>('../chatStore');
  clearIdleChatUnloadTimer =
    jest.requireActual<typeof ChatHydrationModule>(
      '../chat/hydration',
    ).clearIdleChatUnloadTimer;
  return store;
}

export function persistedTab(
  id: string,
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab {
  return {
    id,
    title: `Tab ${id}`,
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        blocks: [{ type: 'text', text: 'hello there' }],
        timestamp: 1,
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function tabsFile(
  tabs: PersistedChatTab[],
  activeTabId: string,
): ChatTabsFile {
  return { version: 1, tabs, activeTabId };
}

export function snapshot(
  revision: number,
  tabs: PersistedChatTab[],
  activeTabId: string,
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'proj',
    worktreeId: 'wt',
    revision,
    tabsFile: tabsFile(tabs, activeTabId),
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

let eventCounter = 0;
export function changeEvent(
  baseRevision: number,
  revision: number,
  changes: ChatStateChangedEvent['changes'],
): ChatStateChangedEvent {
  eventCounter += 1;
  return {
    schemaVersion: 1,
    eventId: `evt-${String(eventCounter)}`,
    occurredAt: new Date().toISOString(),
    projectId: 'proj',
    worktreeId: 'wt',
    baseRevision,
    revision,
    changes,
  };
}

export function providerBatchAggregateEvent(
  baseRevision: number,
  revision: number,
): ChatStateChangedEvent {
  const upsert = (
    id: string,
    text: string,
  ): ChatStateChangedEvent['changes'][number] => ({
    type: 'message.upserted',
    chatId: 'chat-1',
    message: {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: 2,
    },
  });
  return changeEvent(baseRevision, revision, [
    upsert('chat-1-m2', 'growing text 1'),
    upsert('chat-1-m2', 'growing text 2'),
    upsert('chat-1-m2', 'final aggregate content'),
    {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: {
        status: 'streaming',
        queuedMessageIds: [],
        lastActivityAt: 101,
      },
    },
    {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: {
        status: 'streaming',
        queuedMessageIds: ['aggregate-queued'],
        lastActivityAt: 102,
      },
    },
    upsert('chat-1-m3', 'new aggregate row'),
  ]);
}

export function commandResult(
  commandId: string,
  outcome: ChatCommandResult['outcome'],
): ChatCommandResult {
  return { commandId, revision: 9, outcome };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export async function flushPendingWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushMicrotasks();
}

export const KEY = 'proj/wt';

export type TestBackgroundTaskType =
  | 'local_agent'
  | 'local_workflow'
  | 'local_bash';

export const PROVIDER_TASK_TYPES: readonly TestBackgroundTaskType[] = [
  'local_agent',
  'local_workflow',
];

export function setLiveBackgroundTask(taskType: TestBackgroundTaskType): void {
  const liveTasks = jest.requireActual<typeof LiveBackgroundTaskStoreModule>(
    '../liveBackgroundTaskStore',
  );
  liveTasks.useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    sessionActive: true,
    liveTasks: [{ taskId: 'task-1', taskType }],
  });
}

export function settleLiveBackgroundTask(): void {
  const liveTasks = jest.requireActual<typeof LiveBackgroundTaskStoreModule>(
    '../liveBackgroundTaskStore',
  );
  liveTasks.useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    sessionActive: true,
    liveTasks: [],
  });
}

export function installLiveTaskPullBridge(
  listLiveBgTasks: (request: {
    projectId: string;
    worktreeId: string;
  }) => Promise<ActivityLiveBgTasksResponse>,
): void {
  Object.assign(window.api, { activity: { listLiveBgTasks } });
}

export function canonicalAutoArchiveSnapshot(): ChatStateSnapshot {
  const initial = snapshot(
    5,
    [persistedTab('chat-1', { autoArchive: true }), persistedTab('keeper')],
    'chat-1',
  );
  initial.runtimeByChatId = {
    'chat-1': {
      status: 'streaming',
      queuedMessageIds: [],
      lastActivityAt: 100,
    },
  };
  return initial;
}

export function completeCanonicalTurn(
  useChatStore: typeof ChatStoreModule.useChatStore,
): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
  });
  useChatStore.getState().handleChatEvent({
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    data: { type: 'result', is_error: false, result: 'Completed' },
  });
  useChatStore.getState().handleChatStateChanged(
    changeEvent(5, 6, [
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 200,
        },
      },
    ]),
  );
}

export async function hydrate(
  useChatStore: (typeof ChatStoreModule)['useChatStore'],
  tabs: PersistedChatTab[] = [persistedTab('chat-1')],
): Promise<void> {
  getStateMock.mockResolvedValue(snapshot(5, tabs, tabs[0]?.id ?? ''));
  await useChatStore.getState().loadTabsForTarget('proj', 'wt');
}

/** Registers the per-file hooks every revisioned suite needs. */
export function installRevisionedChatStoreHooks(): void {
  // Each test re-imports chatStore after `jest.resetModules()`. With a cold
  // transform cache, the first import compiles the whole store graph and can
  // exceed the per-test timeout. Load it once before the tests run.
  beforeAll(() => {
    loadChatStore();
  }, 60_000);

  beforeEach(() => {
    jest.clearAllMocks();
    // Null model defaults: `ensureModelDefaultsLoaded` absorbs the failure and
    // the defaults resolvers fall back to built-ins (matches cold startup
    // before preferences load).
    loadPreferencesMock.mockRejectedValue(new Error('preferences unavailable'));
    activeSessionsMock.mockResolvedValue({ activeChatIds: [] });
    getChatQueueSnapshotMock.mockResolvedValue([]);
    saveTabsMock.mockResolvedValue(undefined);
    saveTabsPartialMock.mockResolvedValue({ needsFullSave: false });
    pendingApprovalRequestsMock.mockResolvedValue([]);
    getResolvedDefaultMock.mockResolvedValue('ask');
    archiveTabMock.mockResolvedValue([]);
    changeModelMock.mockResolvedValue(true);
    forkOpenWorktreeTabsMock.mockResolvedValue({ tabBindings: {} });
  });

  afterEach(() => {
    clearIdleChatUnloadTimer?.();
    const liveTasks = jest.requireActual<typeof LiveBackgroundTaskStoreModule>(
      '../liveBackgroundTaskStore',
    );
    liveTasks.resetLiveBackgroundTaskStoreForTests();
    Reflect.deleteProperty(global, 'window');
  });
}
