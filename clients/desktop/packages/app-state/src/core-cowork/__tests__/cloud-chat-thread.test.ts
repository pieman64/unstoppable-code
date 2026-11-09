import type { ChatStoreState } from '../../chat/create-chat-store';
import {
  bindCloudChatThread,
  CloudChatStopUnavailableError,
  type CloudChatThreadTarget,
} from '../cloud-chat-thread';
import {
  CoreCoworkRequestError,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
  type CoreCoworkStream,
} from '../invoker';

const target: CloudChatThreadTarget = {
  key: 'web-core:chat-1',
  workspaceId: 'ws-1',
  worktreeId: 'chat-1',
  chatId: 'chat-1',
};

const message = (id: string, text: string): Record<string, unknown> => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 1,
});

function snapshot(status: string, revision = 4): Record<string, unknown> {
  return {
    workspaceId: 'ws-1',
    worktreeId: 'chat-1',
    revision,
    eventsCursor: { daemonEpoch: 'e1', sequence: revision },
    tabs: { activeTabId: 'chat-1', items: [] },
    archives: [],
    runtimeByChatId: { 'chat-1': { status, queuedMessageIds: [] } },
    queue: [],
  };
}

function transcript(
  ...messages: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    messages,
    totalMessages: messages.length,
    transcriptRevision: 1,
  };
}

type StreamRead = { done: true } | { done: false; value: unknown };

/** A stream the test feeds frame by frame. */
function controlledStream(): CoreCoworkStream & {
  push(frame: unknown): void;
  end(): void;
  closed: boolean;
} {
  const reads: StreamRead[] = [];
  let waiting: ((value: StreamRead) => void) | null = null;
  const deliver = (read: StreamRead): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(read);
    } else reads.push(read);
  };
  const stream = {
    closed: false,
    push(frame: unknown): void {
      deliver({ done: false, value: frame });
    },
    end(): void {
      deliver({ done: true });
    },
    next(): Promise<StreamRead> {
      const read = reads.shift();
      if (read) return Promise.resolve(read);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close(): Promise<void> {
      stream.closed = true;
      return Promise.resolve();
    },
  };
  return stream;
}

function ok(value: unknown): CanopyCoreRelayLikeReply {
  return { ok: true, value };
}

interface Harness {
  readonly thread: ReturnType<typeof bindCloudChatThread>;
  readonly calls: { method: string; params: Record<string, unknown> }[];
  readonly state: {
    hydrate: jest.Mock<void, [string, unknown[], Record<string, unknown>]>;
    reset: jest.Mock<void, [string]>;
    bindOptimisticSend: jest.Mock<void, [string, unknown]>;
    rollbackOptimisticSend: jest.Mock<void, [string, unknown]>;
    threads: Record<string, { messages: Record<string, unknown>[] }>;
  };
  readonly stream: ReturnType<typeof controlledStream>;
  /** Each core.chat.live.events stream the thread opened, oldest first. */
  readonly lives: ReturnType<typeof controlledStream>[];
  /** Holds the next live open until the returned function is called. */
  readonly deferLive: () => () => void;
  readonly project: jest.Mock;
}

function harness(
  handlers: Record<
    string,
    (
      params: Record<string, unknown>,
    ) => CanopyCoreRelayLikeReply | Promise<CanopyCoreRelayLikeReply>
  >,
  options: { readonly liveRefused?: boolean } = {},
): Harness {
  const stream = controlledStream();
  const lives: ReturnType<typeof controlledStream>[] = [];
  let liveGate: Promise<void> | null = null;
  const deferLive = (): (() => void) => {
    let open = (): void => undefined;
    liveGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return open;
  };
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const invoker: CoreCoworkInvoker = {
    request: (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected ${method}`);
      return Promise.resolve(handler(params));
    },
    openStream: (method, params) => {
      calls.push({ method, params });
      if (method !== 'core.chat.live.events') return Promise.resolve(stream);
      if (options.liveRefused)
        return Promise.reject(
          new CoreCoworkRequestError({
            kind: 'capability_unavailable',
            message:
              'core.chat.live.events is not available on this connection.',
            retry: { kind: 'never' },
          }),
        );
      const live = controlledStream();
      lives.push(live);
      const gate = liveGate;
      liveGate = null;
      return gate === null ? Promise.resolve(live) : gate.then(() => live);
    },
  };
  const state: Harness['state'] = {
    hydrate: jest.fn<void, [string, unknown[], Record<string, unknown>]>(),
    reset: jest.fn<void, [string]>(),
    bindOptimisticSend: jest.fn<void, [string, unknown]>(),
    rollbackOptimisticSend: jest.fn<void, [string, unknown]>(),
    threads: {},
  };
  const chatStore = {
    getState: (): ChatStoreState => state as unknown as ChatStoreState,
  };
  let ids = 0;
  const project = jest.fn(
    ({ messages }: { chatKey: string; messages: readonly unknown[] }) =>
      messages.map((each) => ({
        messageId: (each as { id: string }).id,
        createdAtMs: 1,
      })),
  );
  const thread = bindCloudChatThread({
    invoker,
    target,
    chatStore,
    project: project as never,
    newId: () => `id-${(ids += 1)}`,
    reopenDelayMs: 5,
    liveReopenDelayMs: 5,
    liveHoldMs: 40,
  });
  return { thread, calls, state, stream, lives, deferLive, project };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('cloud chat thread binding (CAN-4185)', () => {
  it('a core.chat.events batch from another client updates the open transcript live', async () => {
    const { calls, state, stream, project } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hello'))),
    });
    await flush();
    expect(calls.find((c) => c.method === 'core.chat.events')?.params).toEqual({
      scope: { projectId: 'ws-1', worktreeId: 'chat-1' },
      cursor: { daemonEpoch: 'e1', sequence: 4 },
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('m2', 'From the web'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
        ],
      },
    });
    await flush();
    const last = state.hydrate.mock.calls.at(-1);
    expect(last?.[0]).toBe('web-core:chat-1');
    expect(last?.[1]).toEqual([
      { messageId: 'm1', createdAtMs: 1, presentationOrder: 0 },
      { messageId: 'm2', createdAtMs: 1, presentationOrder: 1 },
    ]);
    expect(last?.[2]).toMatchObject({ turnActive: true, status: 'streaming' });
    expect(project).toHaveBeenLastCalledWith({
      chatKey: 'web-core:chat-1',
      messages: [message('m1', 'Hello'), message('m2', 'From the web')],
    });
  });

  it('skips the replayed batch of a cursorless open and follows live, without re-reading', async () => {
    const withoutCursor = snapshot('idle', 4);
    delete withoutCursor.eventsCursor;
    const { calls, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(withoutCursor),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    const batch = (base: number, id: string): Record<string, unknown> => ({
      schemaVersion: 1,
      eventId: `ev-${base + 1}`,
      occurredAt: '2026-11-07T15:00:00.000Z',
      projectId: 'ws-1',
      worktreeId: 'chat-1',
      baseRevision: base,
      revision: base + 1,
      changes: [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: message(id, id),
        },
      ],
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 4 },
      item: batch(3, 'old'),
    });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: batch(4, 'new'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      calls.filter((c) => c.method === 'core.chat.snapshot.get'),
    ).toHaveLength(1);
    expect(stream.closed).toBe(false);
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      { messageId: 'new', createdAtMs: 1, presentationOrder: 0 },
    ]);
  });

  it('re-reads the snapshot when a batch does not follow the held revision', async () => {
    const { calls, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 9 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-9',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 8,
        revision: 9,
        changes: [
          { type: 'message.removed', chatId: 'chat-1', messageId: 'x' },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      calls.filter((c) => c.method === 'core.chat.snapshot.get'),
    ).toHaveLength(2);
    expect(stream.closed).toBe(true);
  });

  it('a lost send reply asks for the receipt before resending, and never sends twice', async () => {
    const sends: Record<string, unknown>[] = [];
    const { thread, calls, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) => {
        sends.push(params);
        return {
          ok: false,
          error: {
            kind: 'unavailable',
            message: 'Lost.',
            retry: { kind: 'same_idempotency_key' },
          },
        };
      },
      'core.chat.send.receipt': (params) =>
        ok({
          outcome: 'matched',
          receipt: {
            commandId: params.commandId,
            revision: 5,
            outcome: 'applied',
            entityId: 'turn-1',
          },
        }),
    });
    await flush();
    await thread.send({ text: 'Hi', optimisticLocalId: 'local-1' });
    expect(sends).toHaveLength(1);
    const receipt = calls.find((c) => c.method === 'core.chat.send.receipt');
    expect(receipt?.params.commandId).toBe(sends[0]?.commandId);
    expect(sends[0]?._meta).toEqual({ idempotencyKey: sends[0]?.commandId });
    expect(state.bindOptimisticSend).toHaveBeenCalledWith('web-core:chat-1', {
      optimisticLocalId: 'local-1',
      userMessageId: sends[0]?.messageId,
    });
    expect(state.rollbackOptimisticSend).not.toHaveBeenCalled();
  });

  it('resends a missing send once under the same command id and key', async () => {
    const sends: Record<string, unknown>[] = [];
    const { thread } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) => {
        sends.push(params);
        return sends.length === 1
          ? {
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'Lost.',
                retry: { kind: 'same_idempotency_key' },
              },
            }
          : ok({
              commandId: params.commandId,
              revision: 5,
              outcome: 'applied',
            });
      },
      'core.chat.send.receipt': () => ok({ outcome: 'missing' }),
    });
    await flush();
    await thread.send({ text: 'Hi' });
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
  });

  it('stop cancels the turn this client started from idle, not a follow-up queued behind it, before any runtime report', async () => {
    const turnIds = ['turn-7', 'turn-8'];
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          entityId: turnIds.shift(),
        }),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    await thread.send({ text: 'Go' });
    await thread.send({ text: 'Then this' });
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-7', reason: 'user' });
  });

  it('stop cancels a turn another client started, by the id the web core reports', async () => {
    const withTurn = {
      ...snapshot('streaming'),
      runtimeByChatId: {
        'chat-1': {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurnId: 'turn-web',
        },
      },
    };
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(withTurn),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-web', reason: 'user' });
  });

  it('refuses stop with no turn of its own, and sends nothing', async () => {
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    await expect(thread.stop()).rejects.toBeInstanceOf(
      CloudChatStopUnavailableError,
    );
    expect(calls.some((c) => c.method === 'core.chat.turn.cancel')).toBe(false);
  });

  it('closing for offline drops the thread and ends its stream', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'x'))),
    });
    await flush();
    thread.close();
    expect(state.reset).toHaveBeenCalledWith('web-core:chat-1');
    expect(stream.closed).toBe(true);
    const hydrations = state.hydrate.mock.calls.length;
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {},
    });
    await flush();
    expect(state.hydrate.mock.calls.length).toBe(hydrations);
  });

  it('a streamed update to an existing message moves its revision forward', async () => {
    const { state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript(message('m1', 'Hel'))),
    });
    await flush();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('m1', 'Hello world'),
          },
        ],
      },
    });
    await flush();
    const projected = state.hydrate.mock.calls.at(-1)?.[1] as {
      messageId: string;
      updatedAtMs?: number;
    }[];
    expect(projected[0]?.updatedAtMs).toBeGreaterThan(1);
  });

  it('reconciles an optimistic send with the canonical message id from the receipt', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          messageId: 'srv-1',
        }),
    });
    await flush();
    await thread.send({ text: 'Hi', optimisticLocalId: 'local-1' });
    expect(state.bindOptimisticSend).toHaveBeenLastCalledWith(
      'web-core:chat-1',
      { optimisticLocalId: 'local-1', userMessageId: 'srv-1' },
    );
  });

  it('shows its own queued send until it runs', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'applied',
          messageId: 'srv-2',
        }),
    });
    await flush();
    await thread.send({ text: 'Next please' });
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'streaming', queuedMessageIds: ['srv-2'] },
          },
        ],
      },
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      queuedMessages: [
        {
          id: 'srv-2',
          text: 'Next please',
          origin: 'desktop',
          supersedesUserMessageId: 'srv-2',
        },
      ],
    });
  });

  it('loads older transcript pages from the position the newest page returned', async () => {
    const pages: Record<string, unknown>[] = [];
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        pages.push(params);
        return params.before === undefined
          ? ok({ ...transcript(message('m101', 'new')), before: 100 })
          : ok(transcript(message('m1', 'old')));
      },
    });
    await flush();
    await thread.loadOlder();
    expect(pages[1]?.before).toBe(100);
    expect(state.hydrate.mock.calls.at(-1)?.[1]).toEqual([
      { messageId: 'm1', createdAtMs: 1, presentationOrder: 0 },
      { messageId: 'm101', createdAtMs: 1, presentationOrder: 1 },
    ]);
    await thread.loadOlder();
    expect(pages).toHaveLength(2);
  });

  it('answers a question pending at open through core.chat.question.respond, keyed by question id', async () => {
    const { thread, calls } = harness({
      'core.chat.snapshot.get': () =>
        ok({
          ...snapshot('awaiting_input'),
          pendingQuestions: [
            {
              requestId: 'q-1',
              chatId: 'chat-1',
              questions: [
                { id: 'which', question: 'Which?', options: ['A', 'B'] },
              ],
            },
          ],
        }),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.question.respond': () => ok({}),
    });
    await flush();
    expect(thread.getQuestions()).toEqual([
      {
        requestId: 'q-1',
        questions: [{ id: 'which', question: 'Which?', options: ['A', 'B'] }],
        answered: false,
      },
    ]);
    await thread.answerQuestion('q-1', [
      { question: 'Which?', selectedOptions: ['B'] },
    ]);
    expect(
      calls.find((c) => c.method === 'core.chat.question.respond')?.params,
    ).toEqual({
      chatId: 'chat-1',
      questionId: 'q-1',
      answers: { which: { selectedOptions: ['B'] } },
    });
    expect(thread.getQuestions()).toEqual([]);
  });

  it('says in the thread when a send is rejected, after rolling back its optimistic row', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'rejected',
          reason: 'Out of credits.',
        }),
    });
    await flush();
    await expect(
      thread.send({ text: 'Hi', optimisticLocalId: 'local-1' }),
    ).rejects.toThrow('Out of credits.');
    expect(state.rollbackOptimisticSend).toHaveBeenCalledWith(
      'web-core:chat-1',
      { localId: 'local-1' },
    );
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      turnActive: false,
      error: "Your message wasn't sent: Out of credits.",
    });
  });

  it('stops a turn waiting on a question, by the id the web core reports', async () => {
    const waiting = {
      ...snapshot('awaiting_input'),
      runtimeByChatId: {
        'chat-1': {
          status: 'awaiting_input',
          queuedMessageIds: [],
          activeTurnId: 'turn-q',
        },
      },
    };
    const { thread, calls, state } = harness({
      'core.chat.snapshot.get': () => ok(waiting),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.turn.cancel': () => ok({}),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      turnActive: true,
    });
    await thread.stop();
    expect(
      calls.find((c) => c.method === 'core.chat.turn.cancel')?.params,
    ).toEqual({ chatId: 'chat-1', turnId: 'turn-q', reason: 'user' });
  });

  it('a rejected follow-up keeps the running turn active and only adds the notice', async () => {
    const { thread, state } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('streaming')),
      'core.chat.transcript.page': () => ok(transcript()),
      'core.chat.message.send': (params) =>
        ok({
          commandId: params.commandId,
          revision: 5,
          outcome: 'rejected',
          reason: 'Queue is full.',
        }),
    });
    await flush();
    await expect(thread.send({ text: 'Also this' })).rejects.toThrow(
      'Queue is full.',
    );
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'streaming',
      turnActive: true,
      error: "Your message wasn't sent: Queue is full.",
    });
  });

  it('keeps older pages it loaded when a refresh re-reads the newest page', async () => {
    let newestCalls = 0;
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        if (params.before !== undefined)
          return ok(transcript(message('m1', 'old')));
        newestCalls += 1;
        return ok({
          ...transcript(message('m101', 'new'), message('m102', 'newer')),
          before: 100,
        });
      },
    });
    await flush();
    await thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: false,
          },
        ],
      },
    });
    await flush();
    expect(newestCalls).toBe(2);
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual([
      'm1',
      'm101',
      'm102',
    ]);
  });

  it('shows a session parked awaiting input with no running turn as idle, and refuses stop', async () => {
    const { thread, state, calls } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('awaiting_input')),
      'core.chat.transcript.page': () => ok(transcript()),
    });
    await flush();
    expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
      status: 'idle',
      turnActive: false,
    });
    await expect(thread.stop()).rejects.toBeInstanceOf(
      CloudChatStopUnavailableError,
    );
    expect(calls.some((c) => c.method === 'core.chat.turn.cancel')).toBe(false);
  });

  it('drops older pages it kept when the transcript is reset', async () => {
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) =>
        params.before !== undefined
          ? ok(transcript(message('m1', 'old')))
          : ok({ ...transcript(message('m101', 'new')), before: 100 }),
    });
    await flush();
    await thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ],
      },
    });
    await flush();
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual(['m101']);
  });

  it('drops an older page that was requested before a transcript reset, even when it lands during the reset read', async () => {
    let answerOlder: (reply: CanopyCoreRelayLikeReply) => void = () => {};
    let answerRefresh: (reply: CanopyCoreRelayLikeReply) => void = () => {};
    let reads = 0;
    const newest = ok({ ...transcript(message('m101', 'new')), before: 100 });
    const { thread, state, stream } = harness({
      'core.chat.snapshot.get': () => ok(snapshot('idle')),
      'core.chat.transcript.page': (params) => {
        if (params.before !== undefined)
          return new Promise<CanopyCoreRelayLikeReply>((resolve) => {
            answerOlder = resolve;
          });
        reads += 1;
        if (reads === 1) return newest;
        return new Promise<CanopyCoreRelayLikeReply>((resolve) => {
          answerRefresh = resolve;
        });
      },
    });
    await flush();
    const older = thread.loadOlder();
    stream.push({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: 5 },
      item: {
        schemaVersion: 1,
        eventId: 'ev-5',
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: 4,
        revision: 5,
        changes: [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ],
      },
    });
    await flush();
    answerOlder(ok(transcript(message('m1', 'obsolete'))));
    await older;
    answerRefresh(newest);
    await flush();
    const latest = (state.hydrate.mock.calls.at(-1)?.[1] ?? []) as {
      messageId: string;
    }[];
    expect(latest.map((each) => each.messageId)).toEqual(['m101']);
  });

  describe('live reply (CAN-5984)', () => {
    const prompt = (id: string, text: string): Record<string, unknown> => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 1,
    });
    const liveTurn = (
      text: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      kind: 'item',
      cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 1 },
      item: {
        kind: 'turn',
        chatId: 'chat-1',
        turnId: 'turn-1',
        promptMessageId: 'p1',
        text,
        reasoning: '',
        state: 'streaming',
        ...overrides,
      },
    });
    const shown = (state: Harness['state']): unknown[] =>
      state.hydrate.mock.calls.at(-1)?.[1] ?? [];
    const LIVE_ID = 'web-core:chat-1:live:turn-1';

    it('live text and reasoning show in the open thread', async () => {
      const { thread, calls, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      expect(
        calls.find((c) => c.method === 'core.chat.live.events')?.params,
      ).toEqual({
        scope: { workspaceId: 'ws-1', worktreeId: 'chat-1', chatId: 'chat-1' },
      });
      lives[0]?.push(liveTurn('Hel', { reasoning: 'Thinking' }));
      await flush();
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        expect.objectContaining({
          messageId: LIVE_ID,
          chatId: 'web-core:chat-1',
          role: 'assistant',
          status: 'streaming',
          text: 'Hel',
          parts: [{ kind: 'thinking', data: { text: 'Thinking' } }],
          presentationOrder: 1,
        }),
      ]);
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 3,
          text: 'lo',
          reasoningOffset: 8,
          reasoning: '...',
        },
      });
      await flush();
      expect(shown(state)[1]).toMatchObject({
        text: 'Hello',
        parts: [{ kind: 'thinking', data: { text: 'Thinking...' } }],
      });
    });

    it('the committed reply replaces the live one in one publish, with no duplicate', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Hello'));
      await flush();
      const firstShown = state.hydrate.mock.calls.length;
      // Core finished; the transcript has not caught up yet: keep showing it.
      lives[0]?.push(
        liveTurn('Hello there', { state: 'finished', messageId: 'a1' }),
      );
      await flush();
      expect(shown(state)[1]).toMatchObject({
        messageId: LIVE_ID,
        status: 'complete',
        text: 'Hello there',
      });
      stream.push({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: 5 },
        item: {
          schemaVersion: 1,
          eventId: 'ev-5',
          occurredAt: '2026-11-07T15:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: 4,
          revision: 5,
          changes: [
            {
              type: 'message.upserted',
              chatId: 'chat-1',
              message: message('a1', 'Hello there'),
            },
            {
              type: 'runtime.patched',
              chatId: 'chat-1',
              runtime: { status: 'idle', queuedMessageIds: [] },
            },
          ],
        },
      });
      await flush();
      const last = state.hydrate.mock.calls.at(-1);
      expect(last?.[1]).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        { messageId: 'a1', createdAtMs: 1, presentationOrder: 1 },
      ]);
      // The store keeps rows a merge omits, so dropping the live row replaces.
      expect(last?.[2]).toMatchObject({ replaceMessages: true });
      // Every publish since the reply appeared shows it once: live or committed.
      for (const [, messages] of state.hydrate.mock.calls.slice(
        firstShown - 1,
      )) {
        const replies = messages.filter(
          (each) =>
            (each as { messageId: string }).messageId === LIVE_ID ||
            (each as { messageId: string }).messageId === 'a1',
        );
        expect(replies).toHaveLength(1);
      }
    });

    it('a reopened thread shows the reply in progress, or the committed reply once the turn ended', async () => {
      const { thread, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Hello'));
      // An append cut from other lengths is a gap: reopen for the whole reply.
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 9,
          text: 'x',
          reasoningOffset: 0,
          reasoning: '',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(lives[0]?.closed).toBe(true);
      expect(shown(state)[1]).toMatchObject({ text: 'Hello' });
      // The reopened stream rebuilds the reply in progress.
      lives[1]?.push(liveTurn('Hello world'));
      await flush();
      expect(shown(state)[1]).toMatchObject({
        messageId: LIVE_ID,
        text: 'Hello world',
      });

      // Opened after the turn ended: the committed reply only, no live stream.
      const ended = harness({
        'core.chat.snapshot.get': () => ok(snapshot('idle')),
        'core.chat.transcript.page': () =>
          ok(transcript(prompt('p1', 'Hi'), message('a1', 'Hello world'))),
      });
      ended.thread.setLive(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ended.lives).toHaveLength(0);
      expect(shown(ended.state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
        { messageId: 'a1', createdAtMs: 1, presentationOrder: 1 },
      ]);
    });

    const feedBatch = (
      revision: number,
      changes: Record<string, unknown>[],
    ): Record<string, unknown> => ({
      kind: 'item',
      cursor: { daemonEpoch: 'e1', sequence: revision },
      item: {
        schemaVersion: 1,
        eventId: `ev-${revision}`,
        occurredAt: '2026-11-07T15:00:00.000Z',
        projectId: 'ws-1',
        worktreeId: 'chat-1',
        baseRevision: revision - 1,
        revision,
        changes,
      },
    });
    const idle = {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: { status: 'idle', queuedMessageIds: [] },
    };

    it('a turn ending a batch before its committed message holds the reply until the message lands', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done.', { state: 'finished', messageId: 'a1' }));
      await flush();
      const firstShown = state.hydrate.mock.calls.length;
      stream.push(feedBatch(5, [idle]));
      await flush();
      // The turn stopped, the reply has not committed yet: keep showing it.
      expect(shown(state).at(-1)).toMatchObject({ messageId: LIVE_ID });
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        turnActive: false,
      });
      stream.push(
        feedBatch(6, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
      for (const [, messages] of state.hydrate.mock.calls.slice(
        firstShown - 1,
      )) {
        const replies = messages.filter((each) =>
          [LIVE_ID, 'a1'].includes((each as { messageId: string }).messageId),
        );
        expect(replies).toHaveLength(1);
      }
    });

    it('a turn that ends with no committed reply drops its live reply after a short hold', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Half an'));
      await flush();
      expect(shown(state)).toHaveLength(2);
      // The turn failed: the web core reports it idle, with no reply.
      stream.push(feedBatch(5, [idle]));
      await flush();
      expect(shown(state)).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        replaceMessages: true,
        turnActive: false,
      });
    });

    it('a whole transcript read after the turn stopped, without the reply, drops it at once', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Half an'));
      await flush();
      stream.push(feedBatch(5, [idle]));
      await flush();
      expect(shown(state)).toHaveLength(2);
      stream.push(
        feedBatch(6, [
          {
            type: 'transcript.updated',
            chatId: 'chat-1',
            transcript: {},
            reset: true,
          },
        ]),
      );
      await flush();
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
    });

    it('another assistant message mid-turn leaves the live reply streaming; its own commit drops it', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Part one'));
      await flush();
      const batch = (
        revision: number,
        changes: Record<string, unknown>[],
      ): Record<string, unknown> => ({
        kind: 'item',
        cursor: { daemonEpoch: 'e1', sequence: revision },
        item: {
          schemaVersion: 1,
          eventId: `ev-${revision}`,
          occurredAt: '2026-11-07T15:00:00.000Z',
          projectId: 'ws-1',
          worktreeId: 'chat-1',
          baseRevision: revision - 1,
          revision,
          changes,
        },
      });
      // An assistant message after the prompt that is not this reply.
      stream.push(
        batch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('other-1', 'Not the reply'),
          },
        ]),
      );
      await flush();
      expect(shown(state).at(-1)).toMatchObject({
        messageId: LIVE_ID,
        text: 'Part one',
      });
      lives[0]?.push({
        kind: 'item',
        cursor: { daemonEpoch: 'web-core-chat-live-1', sequence: 2 },
        item: {
          kind: 'append',
          chatId: 'chat-1',
          turnId: 'turn-1',
          textOffset: 8,
          text: ', part two',
          reasoningOffset: 0,
          reasoning: '',
        },
      });
      await flush();
      expect(shown(state).at(-1)).toMatchObject({
        text: 'Part one, part two',
      });
      lives[0]?.push(
        liveTurn('Part one, part two', { state: 'finished', messageId: 'a1' }),
      );
      stream.push(
        batch(6, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Part one, part two'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'idle', queuedMessageIds: [] },
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'other-1', 'a1']);
    });

    it('only the chat on screen follows its live reply', async () => {
      const { thread, state, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      await flush();
      // Retained but hidden: no live stream.
      expect(lives).toHaveLength(0);
      thread.setLive(true);
      await flush();
      expect(lives).toHaveLength(1);
      lives[0]?.push(liveTurn('Hello'));
      await flush();
      expect(shown(state)).toHaveLength(2);
      // Hidden again: the stream ends and the reply waits for the transcript.
      thread.setLive(false);
      await flush();
      expect(lives[0]?.closed).toBe(true);
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      // Shown again: a fresh attach rebuilds the reply in progress.
      thread.setLive(true);
      await flush();
      expect(lives).toHaveLength(2);
      lives[1]?.push(liveTurn('Hello again'));
      await flush();
      expect(shown(state)[1]).toMatchObject({ text: 'Hello again' });
    });

    it('a committed reply and the turn end landing before the live finish show the reply once', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done'));
      await flush();
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
          idle,
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
    });

    it('a live stream that finishes opening after the chat is hidden is closed and not followed', async () => {
      const { thread, state, lives, deferLive } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      await flush();
      const release = deferLive();
      thread.setLive(true);
      await flush();
      thread.setLive(false);
      release();
      await flush();
      expect(lives).toHaveLength(1);
      expect(lives[0]?.closed).toBe(true);
      const publishes = state.hydrate.mock.calls.length;
      lives[0]?.push(liveTurn('Should not show'));
      await flush();
      expect(state.hydrate.mock.calls.length).toBe(publishes);
    });

    it("a queued next turn starting does not keep the previous turn's live reply beside its commit", async () => {
      const running = (activeTurnId: string): Record<string, unknown> => ({
        ...snapshot('streaming'),
        runtimeByChatId: {
          'chat-1': { status: 'streaming', queuedMessageIds: [], activeTurnId },
        },
      });
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(running('turn-1')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done'));
      await flush();
      // Turn 1 committed and turn 2 runs before turn 1's live finish.
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: {
              status: 'streaming',
              queuedMessageIds: [],
              activeTurnId: 'turn-2',
            },
          },
        ]),
      );
      await flush();
      expect(
        shown(state).map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1']);
    });

    it('dropping a live reply keeps a send still in flight', async () => {
      const { thread, state, stream, lives } = harness({
        'core.chat.snapshot.get': () => ok(snapshot('streaming')),
        'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
      });
      thread.setLive(true);
      await flush();
      lives[0]?.push(liveTurn('Done.', { state: 'finished', messageId: 'a1' }));
      await flush();
      const inFlight = {
        messageId: 'optimistic-next',
        chatId: 'web-core:chat-1',
        role: 'user',
        status: 'complete',
        text: 'And another thing',
        createdAtMs: Date.now(),
      };
      state.threads['web-core:chat-1'] = {
        messages: [...shown(state), inFlight] as Record<string, unknown>[],
      };
      stream.push(
        feedBatch(5, [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: message('a1', 'Done.'),
          },
        ]),
      );
      await flush();
      const last = state.hydrate.mock.calls.at(-1);
      expect(last?.[2]).toMatchObject({ replaceMessages: true });
      expect(
        last?.[1].map((each) => (each as { messageId: string }).messageId),
      ).toEqual(['p1', 'a1', 'optimistic-next']);
    });

    it('hiding a failed chat keeps its error', async () => {
      const { thread, state } = harness({
        'core.chat.snapshot.get': () => ({
          ok: false,
          error: {
            kind: 'not_found',
            message: 'The chat was not found.',
            retry: { kind: 'never' },
          },
        }),
        'core.chat.transcript.page': () => ok(transcript()),
      });
      await flush();
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        status: 'error',
      });
      const publishes = state.hydrate.mock.calls.length;
      thread.setLive(true);
      thread.setLive(false);
      await flush();
      expect(state.hydrate.mock.calls.length).toBe(publishes);
    });

    it('a refused live stream leaves the transcript working and is not retried', async () => {
      const { thread, calls, state } = harness(
        {
          'core.chat.snapshot.get': () => ok(snapshot('streaming')),
          'core.chat.transcript.page': () => ok(transcript(prompt('p1', 'Hi'))),
        },
        { liveRefused: true },
      );
      thread.setLive(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        calls.filter((c) => c.method === 'core.chat.live.events'),
      ).toHaveLength(1);
      expect(shown(state)).toEqual([
        { messageId: 'p1', createdAtMs: 1, presentationOrder: 0 },
      ]);
      expect(state.hydrate.mock.calls.at(-1)?.[2]).toMatchObject({
        status: 'streaming',
        turnActive: true,
      });
    });
  });
});
