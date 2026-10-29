/** @jest-environment jsdom */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type {
  ChatInterestChatRef,
  ChatStateChange,
  ChatStateChangedEvent,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import { useChatStore } from '../../chatStore';
import { registerChatStoreApi } from '../store-ref';
import { fromPersistedTab } from '../persisted-tabs';
import type { ChatState } from '../state';
import type { ChatTab } from '../types';
import { applyCanonicalChanges } from '../canonical-changes';
import {
  catchUpStaleChat,
  getStaleChatCatchUpState,
  recordStaleChatCatchUpChanges,
  startStaleChatCatchUp,
} from '../stale-catch-up';
import type { ChatInterestListener } from '@/lib/chat-interest/tracker';

const target: ChatInterestChatRef = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'chat',
};
const row = (text: string): PersistedChatMessage => ({
  id: 'answer',
  role: 'assistant' as const,
  timestamp: 1,
  blocks: [{ type: 'text' as const, text }],
});
const descriptor = (revision: number): TranscriptDescriptor => ({
  format: 'complete-message-jsonl-v1' as const,
  committedMessageCount: 1,
  committedByteLength: 100,
  transcriptRevision: revision,
  hasActiveSidecar: false,
});
const page = (text = 'page', revision = 1): TranscriptPage => ({
  view: 'turns',
  messages: [row(text)],
  messageOrdinals: { answer: 0 },
  turns: [],
  totalMessages: 1,
  transcriptRevision: revision,
});

interface Harness {
  store: UseBoundStore<StoreApi<ChatState>>;
  read: jest.Mock<Promise<TranscriptPage>, [unknown]>;
  apply: (...changes: ChatStateChange[]) => void;
  tab: () => ChatTab;
}

function setup(stale = true): Harness {
  const store = create<ChatState>(() => ({
    ...useChatStore.getInitialState(),
    worktreeChats: {
      'p/w': {
        activeTabId: 'chat',
        tabs: [
          {
            ...fromPersistedTab({
              id: 'chat',
              title: 'Chat',
              createdAt: 'now',
              messages: [row('cached')],
              transcript: descriptor(1),
            }),
            ...(stale ? { transcriptStale: true as const } : {}),
          },
        ],
      },
    },
    chatStateSync: { 'p/w': { phase: 'live', revision: 1 } },
  }));
  registerChatStoreApi(store);
  const read = jest.fn<Promise<TranscriptPage>, [unknown]>(() =>
    Promise.resolve(page()),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { getTranscriptPage: read } },
  });
  let revision = 1;
  const apply = (...changes: ChatStateChange[]): void => {
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      occurredAt: 'now',
      ...target,
      eventId: `event-${++revision}`,
      baseRevision: revision - 1,
      revision,
      changes,
    };
    store.setState((state) => {
      const next = applyCanonicalChanges(
        {
          chatState: state.worktreeChats['p/w'],
          archives: [],
          runtimeByChatId: {},
          pendingQuestions: {},
        },
        changes,
        target,
      );
      recordStaleChatCatchUpChanges(event);
      return { worktreeChats: { 'p/w': next.chatState } };
    });
  };
  return {
    store,
    read,
    apply,
    tab: (): ChatTab => store.getState().worktreeChats['p/w'].tabs[0],
  };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => registerChatStoreApi(useChatStore));

it('awaits declaration acknowledgement, retains cached rows, and replays live bodies newer than the page', async () => {
  const h = setup();
  let acknowledge = (): void => undefined;
  let resolve: (page: TranscriptPage) => void = () => undefined;
  h.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = catchUpStaleChat(
    target,
    () =>
      new Promise<void>((done) => {
        acknowledge = done;
      }),
  );
  await tick();
  expect(h.read).not.toHaveBeenCalled();
  expect(h.tab().messages).toEqual([row('cached')]);
  acknowledge();
  await tick();
  h.apply(
    { type: 'message.upserted', chatId: 'chat', message: row('live') },
    { type: 'transcript.updated', chatId: 'chat', transcript: descriptor(2) },
  );
  resolve(page());
  await pending;
  expect(h.tab().messages).toEqual([row('live')]);
  expect(h.tab().transcriptStale).toBeUndefined();
  expect(h.tab().transcriptWindow?.transcriptRevision).toBe(2);
});

it.each(['messages.replaced', 'reset', 'messages.omitted'] as const)(
  'restarts after %s during a read',
  async (kind) => {
    const h = setup();
    let resolve: (page: TranscriptPage) => void = () => undefined;
    h.read
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(page('fresh', 3));
    const pending = catchUpStaleChat(target, () => Promise.resolve());
    await tick();
    if (kind === 'reset')
      h.apply({
        type: 'transcript.updated',
        chatId: 'chat',
        transcript: descriptor(2),
        reset: true,
      });
    else if (kind === 'messages.replaced')
      h.apply({ type: kind, chatId: 'chat', messages: [row('replacement')] });
    else h.apply({ type: kind, chatId: 'chat' });
    resolve(page());
    await pending;
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.tab().messages).toEqual([row('fresh')]);
    expect(h.tab().transcriptStale).toBeUndefined();
  },
);

it('bounds reset retries to three and keeps stale on failure', async () => {
  const h = setup();
  h.read.mockImplementation(() => {
    h.apply({
      type: 'transcript.updated',
      chatId: 'chat',
      transcript: descriptor(2),
      reset: true,
    });
    return Promise.resolve(page());
  });
  await expect(
    catchUpStaleChat(target, () => Promise.resolve()),
  ).rejects.toThrow("Couldn't load messages.");
  expect(h.read).toHaveBeenCalledTimes(3);
  expect(h.tab().transcriptStale).toBe(true);
  expect(getStaleChatCatchUpState(target).error).toBe(
    "Couldn't load messages.",
  );
});

it('a refresh failure retains stale and cached rows', async () => {
  const h = setup();
  h.read.mockRejectedValue(new Error('read failed'));
  await expect(
    catchUpStaleChat(target, () => Promise.resolve()),
  ).rejects.toThrow("Couldn't load messages.");
  expect(h.tab().transcriptStale).toBe(true);
  expect(h.tab().messages).toEqual([row('cached')]);
});

it('hydrates an untracked scope before reading its page', async () => {
  const h = setup();
  const order: string[] = [];
  h.store.setState({
    chatStateSync: {},
    hydrateChatScopeRevisioned: () => {
      order.push('hydrate');
      return Promise.resolve('installed');
    },
  });
  h.read.mockImplementation(() => {
    order.push('page');
    return Promise.resolve(page());
  });
  await catchUpStaleChat(target, () => {
    order.push('interest');
    return Promise.resolve();
  });
  expect(order).toEqual(['interest', 'hydrate', 'page']);
});

it('catches up a marker racing an already-focused declaration and does not loop on failure', async () => {
  const h = setup(false);
  let listener: ChatInterestListener = () => undefined;
  const flush = jest.fn(() => Promise.resolve());
  const stop = startStaleChatCatchUp({
    current: () => ({ focused: [target], warm: [] }),
    subscribe: (next) => {
      listener = next;
      return (): void => undefined;
    },
    flush,
  });
  h.apply({ type: 'messages.omitted', chatId: 'chat' });
  await tick();
  expect(flush).toHaveBeenCalledTimes(1);
  expect(h.tab().transcriptStale).toBeUndefined();
  h.read.mockRejectedValue(new Error('failed'));
  h.apply({ type: 'messages.omitted', chatId: 'chat' });
  await tick();
  listener({ focused: [target], warm: [] });
  h.apply({
    type: 'tab.metadata_patched',
    tabId: 'chat',
    patch: { title: 'new' },
  });
  await tick();
  expect(h.read).toHaveBeenCalledTimes(2);
  expect(h.tab().transcriptStale).toBe(true);
  stop();
});

it('delays cached-row loading presentation for 300 ms', async () => {
  jest.useFakeTimers();
  const h = setup();
  let resolve: (page: TranscriptPage) => void = () => undefined;
  h.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = catchUpStaleChat(target, () => Promise.resolve());
  await tick();
  expect(getStaleChatCatchUpState(target).loading).toBe(false);
  jest.advanceTimersByTime(299);
  expect(getStaleChatCatchUpState(target).loading).toBe(false);
  jest.advanceTimersByTime(1);
  expect(getStaleChatCatchUpState(target).loading).toBe(true);
  resolve(page());
  await pending;
  expect(getStaleChatCatchUpState(target)).toEqual({
    loading: false,
    error: null,
  });
  jest.useRealTimers();
});

it('replays only the newer part of a cadence batch, including a removal', async () => {
  const h = setup();
  const removeMe = { ...row('remove me'), id: 'remove-me' };
  let resolve: (page: TranscriptPage) => void = () => undefined;
  h.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = catchUpStaleChat(target, () => Promise.resolve());
  await tick();
  h.apply(
    { type: 'message.upserted', chatId: 'chat', message: row('before page') },
    { type: 'transcript.updated', chatId: 'chat', transcript: descriptor(2) },
    { type: 'message.removed', chatId: 'chat', messageId: removeMe.id },
    { type: 'message.upserted', chatId: 'chat', message: row('after page') },
    { type: 'transcript.updated', chatId: 'chat', transcript: descriptor(3) },
  );
  resolve({
    ...page('snapshot', 2),
    messages: [row('snapshot'), removeMe],
    messageOrdinals: { answer: 0, 'remove-me': 1 },
  });
  await pending;
  expect(h.tab().messages).toEqual([row('after page')]);
  expect(h.tab().transcriptWindow?.transcriptRevision).toBe(3);
});

it('a failed declaration never starts the page read or clears stale', async () => {
  const h = setup();
  await expect(
    catchUpStaleChat(target, () =>
      Promise.reject(new Error('declaration failed')),
    ),
  ).rejects.toThrow("Couldn't load messages.");
  expect(h.read).not.toHaveBeenCalled();
  expect(h.tab().transcriptStale).toBe(true);
});

it('does not resurrect a tab removed while its page is in flight', async () => {
  const h = setup();
  let resolve: (page: TranscriptPage) => void = () => undefined;
  h.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = catchUpStaleChat(target, () => Promise.resolve());
  await tick();
  h.apply({ type: 'tab.removed', tabId: 'chat' });
  resolve(page());
  await pending;
  expect(h.store.getState().worktreeChats['p/w'].tabs).toEqual([]);
});
