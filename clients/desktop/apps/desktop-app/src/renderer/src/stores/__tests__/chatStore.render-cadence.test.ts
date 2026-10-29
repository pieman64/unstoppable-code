/**
 * Phase 12 store equivalence: committed `chat:state-changed` events applied
 * directly, or through the per-frame render path (`render-cadence.ts` and
 * `chatStoreRenderView`), leave the chat store in the same state after every
 * single event — including duplicate suppression and the revision-gap
 * recovery of `revisioned-sync.ts` (rule 7: keep the last good projection,
 * issue exactly one snapshot query). Only React's view lags, by at most one
 * frame, and it catches up to the store exactly.
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
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import { mergeChatStateChangedEvents } from '@canopy/desktop-shared/lib/chat-state-cadence';
import type * as ChatStoreModule from '../chatStore';
import type * as RenderCadenceModule from '../chat/render-cadence';
import type { FrameScheduler } from '../chat/frame-batched-store-view';

const getStateMock = jest.fn<Promise<ChatStateSnapshot>, []>();
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
  cadence: typeof RenderCadenceModule;
}

function load(): Loaded {
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
          archiveTab: jest.fn().mockResolvedValue([]),
          command: commandMock,
        },
      },
    },
  });
  return {
    chatStore: jest.requireActual<typeof ChatStoreModule>('../chatStore'),
    cadence: jest.requireActual<typeof RenderCadenceModule>(
      '../chat/render-cadence',
    ),
  };
}

beforeAll(() => {
  load();
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
});

const KEY = 'proj/wt';

function persistedTab(messages: PersistedChatMessage[]): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Tab chat-1',
    messages,
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

function snapshot(
  revision: number,
  messages: PersistedChatMessage[],
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'proj',
    worktreeId: 'wt',
    revision,
    tabsFile: {
      version: 1,
      tabs: [persistedTab(messages)],
      activeTabId: 'chat-1',
    },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

function event(
  id: string,
  baseRevision: number,
  revision: number,
  changes: ChatStateChangedEvent['changes'],
): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: id,
    occurredAt: '2026-10-01T00:00:00.000Z',
    projectId: 'proj',
    worktreeId: 'wt',
    baseRevision,
    revision,
    changes,
  };
}

function assistant(id: string, text: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
  };
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

const userMessage: PersistedChatMessage = {
  id: 'u1',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }],
  timestamp: 1,
};

function streamingRuntime(lastActivityAt: number): {
  type: 'runtime.patched';
  chatId: string;
  runtime: {
    status: 'streaming';
    queuedMessageIds: string[];
    lastActivityAt: number;
  };
} {
  return {
    type: 'runtime.patched',
    chatId: 'chat-1',
    runtime: { status: 'streaming', queuedMessageIds: [], lastActivityAt },
  };
}

function content(
  id: string,
  base: number,
  messageId: string,
  text: string,
): ChatStateChangedEvent {
  return event(id, base, base + 1, [
    {
      type: 'message.upserted',
      chatId: 'chat-1',
      message: assistant(messageId, text),
    },
    streamingRuntime(base * 10),
    {
      type: 'transcript.updated',
      chatId: 'chat-1',
      transcript: descriptor(base + 1, 2),
      reset: false,
    },
  ]);
}

/** A streamed reply: start, growing content, a duplicate, an old revision,
 * then completion. */
function streamingEvents(): ChatStateChangedEvent[] {
  return [
    event('e6', 5, 6, [
      streamingRuntime(50),
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: assistant('a1', 'H'),
      },
    ]),
    content('e7', 6, 'a1', 'He'),
    content('e8', 7, 'a1', 'Hel'),
    content('e8', 7, 'a1', 'stale duplicate'),
    content('e9', 8, 'a1', 'Hello'),
    event('e5-old', 4, 5, [
      { type: 'message.removed', chatId: 'chat-1', messageId: 'a1' },
    ]),
    content('e10', 9, 'a2', 'Second message'),
    event('e11', 10, 11, [
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'completed',
          queuedMessageIds: [],
          lastActivityAt: 120,
        },
      },
    ]),
  ];
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

interface Observation {
  /** Store state after each event (scope, sync status, runtime). */
  steps: unknown[];
  /** Revisions React's view published after hydration, in order. */
  published: (number | null | undefined)[];
  snapshotQueries: number;
}

async function deliver(
  events: ChatStateChangedEvent[],
  mode: 'direct' | 'per-frame',
  options: { refresh?: ChatStateSnapshot; frameAfter?: number[] } = {},
): Promise<Observation> {
  const { chatStore, cadence } = load();
  const { useChatStore, chatStoreRenderView } = chatStore;
  getStateMock.mockResolvedValueOnce(snapshot(5, [userMessage]));
  await useChatStore.getState().loadTabsForTarget('proj', 'wt');
  getStateMock.mockClear();
  if (options.refresh) getStateMock.mockResolvedValue(options.refresh);

  // Revisions React's view moved to, without repeats (one event publishes
  // its projection and then its sync status).
  const published: (number | null | undefined)[] = [];
  chatStoreRenderView.subscribe((state) => {
    const revision = state.chatStateSync[KEY]?.revision;
    if (published[published.length - 1] !== revision) published.push(revision);
  });
  const scheduler = manualScheduler();
  const steps: unknown[] = [];
  events.forEach((next, index) => {
    const state = useChatStore.getState();
    if (mode === 'direct') {
      state.handleChatStateChanged(next);
    } else {
      cadence.applyChatStateChangedForRender(next, {
        apply: state.handleChatStateChanged,
        runtimeByChatId: state.runtimeByChatId,
        view: chatStoreRenderView,
        scheduler,
      });
    }
    const after = useChatStore.getState();
    steps.push({
      scope: after.worktreeChats[KEY],
      sync: after.chatStateSync[KEY],
      runtime: after.runtimeByChatId,
    });
    if (options.frameAfter?.includes(index)) scheduler.runFrame();
  });
  scheduler.runFrame();
  expect(chatStoreRenderView.getState()).toBe(useChatStore.getState());
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return {
    steps,
    published: published.filter(
      (revision) => typeof revision === 'number' && revision > 5,
    ),
    snapshotQueries: getStateMock.mock.calls.length,
  };
}

function isSubsequence<T>(candidate: T[], sequence: T[]): boolean {
  let index = 0;
  for (const value of sequence) {
    if (index < candidate.length && candidate[index] === value) index += 1;
  }
  return index === candidate.length;
}

describe('per-frame chat rendering', () => {
  it('leaves the store identical after every event', async () => {
    const events = streamingEvents();
    const direct = await deliver(events, 'direct');
    const perFrame = await deliver(events, 'per-frame');

    expect(perFrame.steps).toStrictEqual(direct.steps);
    expect(perFrame.snapshotQueries).toBe(0);
    expect(direct.published).toEqual([6, 7, 8, 9, 10, 11]);
    // e6 starts the turn (its runtime appears) and e11 completes it, so both
    // render at once. The streamed content between them (e7 to e10) renders
    // with e11's first store update, whose projection still carries sync
    // revision 10, then e11's sync status. Nothing renders out of order.
    expect(perFrame.published).toEqual([6, 10, 11]);
    expect(isSubsequence(perFrame.published, direct.published)).toBe(true);
  });

  it('renders each frame in revision order across frame boundaries', async () => {
    const events = streamingEvents();
    const direct = await deliver(events, 'direct');
    const perFrame = await deliver(events, 'per-frame', {
      frameAfter: [1, 4],
    });

    expect(perFrame.steps).toStrictEqual(direct.steps);
    expect(perFrame.published).toEqual([6, 7, 9, 10, 11]);
    expect(isSubsequence(perFrame.published, direct.published)).toBe(true);
  });

  it('keeps gap recovery identical: last good projection, one snapshot query', async () => {
    const all = streamingEvents();
    // e7 is lost: e8 arrives on a gap.
    const events = [all[0], all[2], all[4]];
    const refresh = snapshot(9, [userMessage, assistant('a1', 'Hello')]);

    const direct = await deliver(events, 'direct', { refresh });
    const perFrame = await deliver(events, 'per-frame', { refresh });

    expect(direct.snapshotQueries).toBe(1);
    expect(perFrame.snapshotQueries).toBe(1);
    expect(perFrame.steps).toStrictEqual(direct.steps);
  });

  it('applies a burst merged by main exactly as the events it merges', async () => {
    const all = streamingEvents();
    // Without the duplicate and the stale revision: e6, e7, e8, e9, e10, e11.
    const sequence = [all[0], all[1], all[2], all[4], all[6], all[7]];
    const burst = [all[1], all[2], all[4], all[6]] as const;
    const merged = mergeChatStateChangedEvents(burst);
    expect(merged).toMatchObject({ baseRevision: 6, revision: 10 });

    for (const mode of ['direct', 'per-frame'] as const) {
      const separate = await deliver(sequence, mode);
      const together = await deliver([all[0], merged, all[7]], mode);
      expect(together.snapshotQueries).toBe(0);
      expect(together.steps).toStrictEqual([
        separate.steps[0],
        separate.steps[4],
        separate.steps[5],
      ]);
    }
  });
});
