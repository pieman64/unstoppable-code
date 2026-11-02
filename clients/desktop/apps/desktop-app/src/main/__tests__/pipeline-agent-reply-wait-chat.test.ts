import { isInputLedger } from '@canopy/desktop-shared/chat-input-delivery';
import type {
  ChatStateChangedEvent,
  ChatStateSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { ChatReadContext } from '../project-discovery/chat-target';
import { waitForAgentReplyTurn } from '../pipelines/agent-reply-wait';
import {
  createChatReplyWaitDeps,
  locateInputInChat,
  type ChatReplyWaitServices,
} from '../pipelines/agent-reply-wait-chat';
import { getChatQueueService } from '../services/chat-queue-service';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from './helpers/chat-state-service-fixture';

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const OTHER_SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-2' };

interface AttemptSpec {
  pickedUp?: boolean;
  root?: string;
}

function row(
  id: string,
  state: string,
  attempts: AttemptSpec[] = [],
): Record<string, unknown> {
  return {
    id,
    revision: 1,
    createdAt: 1,
    state,
    text: 'hello',
    settingsKey: 'settings',
    payload: {
      projectId: SCOPE.projectId,
      worktreeId: SCOPE.worktreeId,
      chatId: 'chat-1',
      userMessageId: id,
      text: 'hello',
    },
    attempts: attempts.map((attempt, index) => ({
      id: `${id}-attempt-${index}`,
      generation: 'generation-1',
      provider: 'claude',
      createdAt: 1 + index,
      ...(attempt.pickedUp ? { pickedUpAt: 2 + index } : {}),
      ...(attempt.root !== undefined
        ? { rootUserMessageId: attempt.root }
        : {}),
    })),
  };
}

function ledger(rows: Record<string, unknown>[]): unknown {
  return { version: 1, epoch: 0, rows };
}

function snapshot(
  tabs: Array<{ id: string; inputDelivery?: unknown }>,
  queued: Record<string, Array<{ id: string; userMessageId: string }>> = {},
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    ...SCOPE,
    revision: 1,
    tabsFile: {
      tabs: tabs.map((tab) => tab as unknown as PersistedChatTab),
    },
    archives: [],
    runtimeByChatId: Object.fromEntries(
      Object.entries(queued).map(([chatId, entries]) => [
        chatId,
        {
          status: 'idle',
          queuedMessageIds: entries.map((entry) => entry.id),
          queuedMessages: entries.map((entry) => ({
            id: entry.id,
            request: { userMessageId: entry.userMessageId },
          })),
        },
      ]),
    ),
    queue: [],
  } as unknown as ChatStateSnapshot;
}

describe('locateInputInChat', () => {
  it('builds ledgers the production guard accepts', () => {
    expect(
      isInputLedger(
        ledger([row('m', 'picked-up', [{ pickedUp: true, root: 'm' }])]),
      ),
    ).toBe(true);
  });

  it.each([
    [
      'a queued entry matched by queue row ID',
      snapshot([{ id: 'chat-1' }], {
        'chat-1': [{ id: 'queue-row', userMessageId: 'user-msg' }],
      }),
      'queue-row',
      { kind: 'queued', userMessageId: 'user-msg' },
    ],
    [
      'a queued entry matched by its user message ID',
      snapshot([{ id: 'chat-1' }], {
        'chat-1': [{ id: 'queue-row', userMessageId: 'user-msg' }],
      }),
      'user-msg',
      { kind: 'queued', userMessageId: 'user-msg' },
    ],
    [
      'a picked-up row rooted at itself',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([
            row('m', 'picked-up', [{ pickedUp: true, root: 'm' }]),
          ]),
        },
      ]),
      'm',
      { kind: 'turn', turnId: 'm' },
    ],
    [
      'a steered row',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([
            row('steer', 'picked-up', [{ pickedUp: true, root: 'root' }]),
          ]),
        },
      ]),
      'steer',
      { kind: 'turn', turnId: 'root' },
    ],
    [
      // The accepted prompt marks an agent-sent row picked up with no
      // delivery attempt, as a Codex chat does: the row opened the turn.
      'a row the accepted prompt picked up without an attempt',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([row('m', 'picked-up')]),
        },
      ]),
      'm',
      { kind: 'turn', turnId: 'm' },
    ],
    [
      'a row whose latest picked-up attempt wins',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([
            row('m', 'sending', [
              { pickedUp: true, root: 'first-root' },
              { root: 'second-root' },
            ]),
          ]),
        },
      ]),
      'm',
      { kind: 'turn', turnId: 'first-root' },
    ],
    [
      'a cancelled row with no pickup',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([row('m', 'cancelled', [{}])]),
        },
      ]),
      'm',
      { kind: 'cancelled_row' },
    ],
    [
      'a row still sending',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([row('m', 'sending', [{}])]),
        },
      ]),
      'm',
      { kind: 'pending' },
    ],
    [
      'an unknown ID',
      snapshot([{ id: 'chat-1', inputDelivery: ledger([]) }]),
      'nope',
      { kind: 'not_in_ledger' },
    ],
    [
      'a stale queue row ID that differs from the user message ID',
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([
            row('user-msg', 'picked-up', [
              { pickedUp: true, root: 'user-msg' },
            ]),
          ]),
        },
      ]),
      'stale-queue-row',
      { kind: 'not_in_ledger' },
    ],
    [
      "a message held only by another chat's ledger",
      snapshot(
        [
          { id: 'chat-1', inputDelivery: ledger([]) },
          {
            id: 'chat-2',
            inputDelivery: ledger([
              row('m', 'picked-up', [{ pickedUp: true, root: 'm' }]),
            ]),
          },
        ],
        { 'chat-2': [{ id: 'q', userMessageId: 'queued-elsewhere' }] },
      ),
      'm',
      { kind: 'not_in_ledger' },
    ],
    [
      'a tab with no inputDelivery ledger',
      snapshot([{ id: 'chat-1' }]),
      'm',
      { kind: 'not_in_ledger' },
    ],
  ])('%s', (_label, state, messageId, expected) => {
    expect(locateInputInChat(state, 'chat-1', messageId)).toEqual(expected);
  });

  it('does not match a queue entry held by another chat', () => {
    expect(
      locateInputInChat(
        snapshot([{ id: 'chat-1' }], {
          'chat-2': [{ id: 'q', userMessageId: 'user-msg' }],
        }),
        'chat-1',
        'user-msg',
      ),
    ).toEqual({ kind: 'not_in_ledger' });
  });
});

const CONTEXT = {
  address: {
    projectId: SCOPE.projectId,
    taskId: SCOPE.worktreeId,
    chatId: 'chat-1',
  },
  scope: {
    workspaceId: SCOPE.projectId,
    worktreeId: SCOPE.worktreeId,
    chatId: 'chat-1',
  },
} as unknown as ChatReadContext;

type SettledTurnResult = Awaited<
  ReturnType<ChatReplyWaitServices['chatState']['settledTurn']>
>;

function fakeServices(
  options: {
    snapshot?: ChatStateSnapshot;
    inTranscript?: string[];
    active?: Awaited<ReturnType<ChatReplyWaitServices['activeInput']>>;
    latest?: string | null;
    settled?: Partial<SettledTurnResult>;
  } = {},
): ChatReplyWaitServices & {
  emit(event: Pick<ChatStateChangedEvent, 'projectId' | 'worktreeId'>): void;
  listeners: Set<(event: ChatStateChangedEvent) => void>;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  return {
    listeners,
    emit: (event): void => {
      listeners.forEach((listener) =>
        listener({
          schemaVersion: 1,
          eventId: 'e',
          occurredAt: '2026-10-26T00:00:00.000Z',
          baseRevision: 0,
          revision: 1,
          changes: [],
          ...event,
        }),
      );
    },
    chatState: {
      settledTurn: jest.fn((target) =>
        Promise.resolve({
          outcome: 'pending' as const,
          userMessageId: target.userMessageId,
          abandoned: false,
          ...options.settled,
        }),
      ),
      // Stands in for services.chatState.subscribe, the wait's change feed.
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      hasTranscriptMessage: (_scope, _chatId, messageId) =>
        Promise.resolve((options.inTranscript ?? []).includes(messageId)),
    },
    readSnapshot: () =>
      Promise.resolve(options.snapshot ?? snapshot([{ id: 'chat-1' }])),
    activeInput: () => Promise.resolve(options.active ?? { state: 'idle' }),
    latestSettledTurnId: () => Promise.resolve(options.latest ?? null),
  };
}

describe('createChatReplyWaitDeps', () => {
  const cancelledSnapshot = snapshot([
    {
      id: 'chat-1',
      inputDelivery: ledger([row('m', 'cancelled', [{}])]),
    },
  ]);

  it.each([
    [
      'a cancelled row the transcript holds',
      cancelledSnapshot,
      ['m'],
      { kind: 'turn', turnId: 'm' },
    ],
    [
      'a cancelled row the transcript lacks',
      cancelledSnapshot,
      [],
      { kind: 'never_ran' },
    ],
    [
      'a legacy message the transcript holds',
      undefined,
      ['m'],
      { kind: 'turn', turnId: 'm' },
    ],
  ])('locates %s', async (_label, state, inTranscript, expected) => {
    const deps = createChatReplyWaitDeps(
      CONTEXT,
      fakeServices({ ...(state ? { snapshot: state } : {}), inTranscript }),
    );
    await expect(deps.locateInput('m')).resolves.toEqual(expected);
  });

  it('re-checks an ID nothing holds once before reporting it unknown', async () => {
    // The first read can land between queue removal and the ledger commit.
    const deps = createChatReplyWaitDeps(CONTEXT, fakeServices());
    await expect(deps.locateInput('m')).resolves.toEqual({ kind: 'pending' });
    await expect(deps.locateInput('m')).resolves.toEqual({ kind: 'unknown' });
  });

  it('keeps waiting for a message seen queued while it moves to the ledger', async () => {
    const snapshots = [
      snapshot([{ id: 'chat-1' }], {
        'chat-1': [{ id: 'queue-row', userMessageId: 'user-msg' }],
      }),
      // Dispatched: out of the queue, not yet in the ledger or transcript.
      snapshot([{ id: 'chat-1' }]),
    ];
    const deps = createChatReplyWaitDeps(CONTEXT, {
      ...fakeServices(),
      readSnapshot: () =>
        Promise.resolve(snapshots.shift() ?? snapshot([{ id: 'chat-1' }])),
    });
    await expect(deps.locateInput('queue-row')).resolves.toEqual({
      kind: 'pending',
    });
    await expect(deps.locateInput('queue-row')).resolves.toEqual({
      kind: 'pending',
    });
  });

  it('follows a queue row ID to its user message once the entry dispatches', async () => {
    const snapshots = [
      snapshot([{ id: 'chat-1' }], {
        'chat-1': [{ id: 'queue-row', userMessageId: 'user-msg' }],
      }),
      snapshot([
        {
          id: 'chat-1',
          inputDelivery: ledger([
            row('user-msg', 'picked-up', [
              { pickedUp: true, root: 'user-msg' },
            ]),
          ]),
        },
      ]),
    ];
    const deps = createChatReplyWaitDeps(CONTEXT, {
      ...fakeServices(),
      readSnapshot: () =>
        Promise.resolve(snapshots.shift() ?? snapshot([{ id: 'chat-1' }])),
    });
    await expect(deps.locateInput('queue-row')).resolves.toEqual({
      kind: 'pending',
    });
    await expect(deps.locateInput('queue-row')).resolves.toEqual({
      kind: 'turn',
      turnId: 'user-msg',
    });
  });

  it.each([
    [
      { state: 'active', inputId: 'running' } as const,
      null,
      { kind: 'turn', turnId: 'running' },
    ],
    [{ state: 'active' } as const, null, { kind: 'unknown' }],
    [{ state: 'pending', inputId: 'q' } as const, null, { kind: 'pending' }],
    [{ state: 'unknown' } as const, null, { kind: 'unknown' }],
    [{ state: 'idle' } as const, 'latest', { kind: 'turn', turnId: 'latest' }],
    [{ state: 'idle' } as const, null, { kind: 'none' }],
  ])(
    'maps the current input %j (latest %s)',
    async (active, latest, expected) => {
      const deps = createChatReplyWaitDeps(
        CONTEXT,
        fakeServices({ active, latest }),
      );
      await expect(deps.currentTurn()).resolves.toEqual(expected);
    },
  );

  it('maps the settlement and the turn that ended', async () => {
    const services = fakeServices({
      settled: {
        outcome: 'completed',
        userMessageId: 'resume',
        abandoned: false,
      },
    });
    const deps = createChatReplyWaitDeps(CONTEXT, services);
    await expect(deps.settle('turn-1')).resolves.toEqual({
      outcome: 'completed',
      endedTurnId: 'resume',
      abandoned: false,
    });
    expect(services.chatState.settledTurn).toHaveBeenCalledWith({
      ...SCOPE,
      chatId: 'chat-1',
      userMessageId: 'turn-1',
    });
  });

  it('falls back to the bound turn when the settlement names none', async () => {
    const deps = createChatReplyWaitDeps(
      CONTEXT,
      fakeServices({ settled: { outcome: 'failed', userMessageId: null } }),
    );
    await expect(deps.settle('turn-1')).resolves.toMatchObject({
      endedTurnId: 'turn-1',
    });
  });

  it("completes an idle legacy chat's latest transcript turn the owner never accepted", async () => {
    const deps = createChatReplyWaitDeps(
      CONTEXT,
      fakeServices({ latest: 'legacy-turn' }),
    );
    await expect(deps.currentTurn()).resolves.toEqual({
      kind: 'turn',
      turnId: 'legacy-turn',
    });
    await expect(deps.settle('legacy-turn')).resolves.toEqual({
      outcome: 'completed',
      endedTurnId: 'legacy-turn',
      abandoned: false,
    });
  });

  it('keeps a message-bound turn pending on an idle chat', async () => {
    const deps = createChatReplyWaitDeps(CONTEXT, fakeServices());
    await expect(deps.settle('message-turn')).resolves.toMatchObject({
      outcome: 'pending',
    });
  });

  it('keeps the legacy turn pending once the chat is no longer idle', async () => {
    let active: { state: 'idle' } | { state: 'active'; inputId: string } = {
      state: 'idle',
    };
    const services = fakeServices({ latest: 'legacy-turn' });
    services.activeInput = (): Promise<typeof active> =>
      Promise.resolve(active);
    const deps = createChatReplyWaitDeps(CONTEXT, services);
    await deps.currentTurn();
    active = { state: 'active', inputId: 'new-turn' };
    await expect(deps.settle('legacy-turn')).resolves.toMatchObject({
      outcome: 'pending',
    });
  });

  it("wakes only on the chat's scope and detaches", () => {
    const services = fakeServices();
    const deps = createChatReplyWaitDeps(CONTEXT, services);
    const listener = jest.fn();
    const unsubscribe = deps.onChange(listener);
    services.emit(OTHER_SCOPE);
    expect(listener).not.toHaveBeenCalled();
    services.emit(SCOPE);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(services.listeners.size).toBe(0);
  });
});

describe('createChatReplyWaitDeps over a real chat-state service', () => {
  let fixture: ChatStateServiceFixture;

  beforeEach(() => {
    fixture = createChatStateServiceFixture();
    jest
      .spyOn(getChatQueueService(), 'holdsUserMessage')
      .mockReturnValue(false);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture.dispose();
  });

  async function seededDeps(): Promise<
    ReturnType<typeof createChatReplyWaitDeps>
  > {
    await fixture.createChat(SCOPE);
    await fixture.acceptTurn(SCOPE, 'user-turn');
    return createChatReplyWaitDeps(CONTEXT, {
      chatState: fixture.service,
      readSnapshot: () => fixture.service.getState(SCOPE),
      activeInput: () => Promise.resolve({ state: 'idle' }),
      latestSettledTurnId: () => Promise.resolve(null),
    });
  }

  it('wakes on the settlement commit and reports the turn that ended', async () => {
    const deps = await seededDeps();
    await expect(deps.locateInput('user-turn')).resolves.toEqual({
      kind: 'turn',
      turnId: 'user-turn',
    });
    await fixture.setRuntime(SCOPE, 'streaming', 'user-turn');
    const result = waitForAgentReplyTurn(deps, {
      messageId: 'user-turn',
      deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      coalesceMs: 0,
    });
    await fixture.setRuntime(SCOPE, 'completed', 'user-turn');
    await expect(result).resolves.toEqual({
      kind: 'settled',
      turnId: 'user-turn',
      endedTurnId: 'user-turn',
      state: 'completed',
    });
  });

  it('does not resolve on commits to another scope', async () => {
    const deps = await seededDeps();
    await fixture.setRuntime(SCOPE, 'streaming', 'user-turn');
    await fixture.createChat(OTHER_SCOPE);
    const settle = jest.spyOn(deps, 'settle');
    const result = waitForAgentReplyTurn(deps, {
      messageId: 'user-turn',
      deadlineAt: Date.now() + 1_500,
      signal: new AbortController().signal,
      coalesceMs: 0,
    });
    await fixture.setRuntime(OTHER_SCOPE, 'completed', 'other-turn');
    await expect(result).resolves.toEqual({
      kind: 'timed_out',
      turnId: 'user-turn',
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'cancelled'] as const)(
    'reports a %s turn',
    async (status) => {
      const deps = await seededDeps();
      await fixture.setRuntime(SCOPE, 'streaming', 'user-turn');
      const result = waitForAgentReplyTurn(deps, {
        messageId: 'user-turn',
        deadlineAt: Date.now() + 60_000,
        signal: new AbortController().signal,
        coalesceMs: 0,
      });
      await fixture.setRuntime(SCOPE, status, 'user-turn');
      await expect(result).resolves.toMatchObject({ state: status });
    },
  );
});
