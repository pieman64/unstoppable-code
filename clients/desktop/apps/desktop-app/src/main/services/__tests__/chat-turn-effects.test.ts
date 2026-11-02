import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnEffect,
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  applyTurnEffects,
  projectTurnRuntime,
  snapshotTimerRows,
} from '../chat-turn-effects';
import {
  reduceChatState,
  type CanonicalChatState,
} from '../chat-state-reducer';
import type { ChatTurnOwnershipSnapshot } from '../chat-turn-ownership';
import type { ChatTurnStateHandoffSnapshot } from '../chat-turn-state-handoff';
import { persistedMessageToPortalMessage } from '@canopy/agent-transcript';

const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
function message(
  id: string,
  role: PersistedChatMessage['role'],
  timestamp: number,
): PersistedChatMessage {
  return { id, role, timestamp, blocks: [{ type: 'text', text: id }] };
}
function state(messages: PersistedChatMessage[] = []): CanonicalChatState {
  return {
    tabsFile: {
      version: 1,
      activeTabId: 'c',
      tabs: [
        {
          id: 'c',
          title: 'Chat',
          createdAt: '2026-10-18T00:00:00.000Z',
          providerType: 'claude',
          model: 'claude-opus-4-6',
          messages,
        },
      ],
    },
    archivesFile: { version: 1, archived: [] },
    runtimeByChatId: {},
  };
}
function record(id = 'T', userMessageId?: string): ChatTurnRecord {
  return {
    id,
    origin: 'user',
    startedAtMs: 1000,
    pauses: [],
    ...(userMessageId ? { userMessageId, inputIds: [userMessageId] } : {}),
  };
}
function snapshot(
  records: ChatTurnRecord[],
  effects: ChatTurnEffect[] = [],
): ChatTurnStateHandoffSnapshot {
  return {
    key: 'key',
    identity: 1,
    generation: 1,
    scope,
    turn: serializeChatTurnState(initialChatTurnState()),
    turnRecords: records,
    effects,
  };
}
function apply(
  current: CanonicalChatState,
  captured: ChatTurnStateHandoffSnapshot,
): CanonicalChatState {
  const mutations: ChatCoreMutation[] = [];
  applyTurnEffects(current, mutations, captured);
  return reduceChatState(current, mutations);
}
function rows(current: CanonicalChatState): PersistedChatMessage[] {
  return current.tabsFile.tabs[0].messages;
}
function block(
  current: CanonicalChatState,
  id = 'T:timer',
): PersistedChatMessage['blocks'][number] | undefined {
  return rows(current)
    .find((row) => row.id === id)
    ?.blocks.find((item) => item.type === 'turn_timer');
}
function ownership(
  patch: Partial<ChatTurnOwnershipSnapshot> = {},
): ChatTurnOwnershipSnapshot {
  return {
    scope,
    serviceEpoch: Symbol('service'),
    operationEpoch: 0,
    knowledge: 'known',
    unacknowledgedLifecycle: [],
    dispatchOwners: [],
    stopOwners: [],
    hostQueuedInputCount: 0,
    removalAwaitingSettle: false,
    backgroundFreshness: 'fresh',
    ...patch,
  };
}
const open: ChatTurnEffect = {
  type: 'timer.open',
  timerId: 'T:timer',
  turnId: 'T',
  atMs: 1000,
};

describe('canonical timer effects', () => {
  it.each(['completed', 'cancelled', 'failed'] as const)(
    'retains exact-execution %s evidence on a provider-closed timer and its Portal publication',
    (outcome) => {
      const timer: PersistedChatMessage = {
        id: 'T:timer',
        role: 'system',
        timestamp: 1000,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'T',
            userMessageId: 'A',
            startedAt: 1000,
            completedAt: 1400,
          },
        ],
      };
      const current = state([message('A', 'user', 900), timer]);
      const captured = snapshot(
        [{ ...record('T', 'A'), endedAtMs: 1400, outcome }],
        [
          { type: 'timer.close', timerId: 'T:timer', turnId: 'T', atMs: 1400 },
          { type: 'turn.ended', turnId: 'T', outcome },
        ],
      );
      const mutations: ChatCoreMutation[] = [];
      applyTurnEffects(current, mutations, captured);
      const next = reduceChatState(current, mutations);
      expect(block(next)).toMatchObject({
        turnId: 'T',
        outcome,
        completedAt: 1400,
      });
      const published = snapshotTimerRows(mutations, captured);
      expect(published).toHaveLength(1);
      const projected = persistedMessageToPortalMessage({
        scope: 'worktree',
        chatId: 'c',
        message: published[0],
      });
      expect(
        projected.parts?.find((part) => part.kind === 'turn_timer')?.data,
      ).toMatchObject({ turnId: 'T', outcome });
      // Another execution for the same prompt must not inherit this result.
      const retry = apply(
        next,
        snapshot(
          [{ ...record('U', 'A'), startedAtMs: 1500 }],
          [{ type: 'timer.open', timerId: 'U:timer', turnId: 'U', atMs: 1500 }],
        ),
      );
      expect(block(retry, 'U:timer')).not.toHaveProperty('outcome');
      expect(block(retry)).toMatchObject({ outcome });
      expect(apply(retry, captured)).toEqual(retry);
    },
  );

  it('opens a timer at the transcript end as a plain append, so it stays in the live tail', () => {
    // A position after a committed prompt would rewrite committed bytes.
    const mutations: ChatCoreMutation[] = [];
    applyTurnEffects(
      state([message('A', 'user', 900)]),
      mutations,
      snapshot([record('T', 'A')], [open]),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      type: 'message.upserted',
      chatId: 'c',
      message: { id: 'T:timer' },
    });
    expect(mutations[0]).not.toHaveProperty('afterMessageId');
  });

  it('appends bound timers keyed to their anchor turn, never into earlier rows; folds pickup builder mutations', () => {
    const current = state([
      message('A', 'user', 900),
      message('output', 'assistant', 1100),
      message('B', 'user', 1200),
    ]);
    const captured = snapshot([record('T', 'A')], [open]);
    const next = apply(current, captured);
    // Projections place the timer in A's turn by `userMessageId`.
    expect(rows(next).map((row) => row.id)).toEqual([
      'A',
      'output',
      'B',
      'T:timer',
    ]);
    expect(block(next)).toMatchObject({
      type: 'turn_timer',
      turnId: 'T',
      userMessageId: 'A',
      startedAt: 1000,
      completedAt: null,
    });
    expect(apply(next, captured)).toEqual(next);
    const mutations: ChatCoreMutation[] = [
      {
        type: 'message.upserted',
        chatId: 'c',
        message: message('pickup', 'user', 900),
      },
    ];
    applyTurnEffects(
      state(),
      mutations,
      snapshot([record('T', 'pickup')], [open]),
    );
    expect(
      rows(reduceChatState(state(), mutations)).map((row) => row.id),
    ).toEqual(['pickup', 'T:timer']);
  });

  it('appends autonomous timers and binds the same row in place on a late binding without another open', () => {
    const current = state([
      message('old', 'user', 100),
      message('old-output', 'assistant', 200),
      message('auto-output', 'assistant', 1100),
      message('B', 'user', 1200),
    ]);
    const autonomous = apply(current, snapshot([record()], [open]));
    expect(rows(autonomous).map((row) => row.id)).toEqual([
      'old',
      'old-output',
      'auto-output',
      'B',
      'T:timer',
    ]);
    const bound = apply(autonomous, snapshot([record('T', 'B')]));
    expect(rows(bound).map((row) => row.id)).toEqual(
      rows(autonomous).map((row) => row.id),
    );
    expect(rows(bound).filter((row) => row.id === 'T:timer')).toHaveLength(1);
    expect(block(autonomous)).not.toHaveProperty('userMessageId');
    expect(block(bound)).toMatchObject({ userMessageId: 'B' });
    expect(apply(bound, snapshot([record('T', 'B')]))).toEqual(bound);
  });

  it("records a wake's cause on its timer, and drops it once the turn binds to a prompt", () => {
    const wake: ChatTurnRecord = {
      ...record(),
      origin: 'autonomous',
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
    };
    const woken = apply(state(), snapshot([wake], [open]));
    expect(block(woken)).toMatchObject({
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
    });
    const prompted = apply(
      woken,
      snapshot([{ ...wake, origin: 'user', userMessageId: 'B' }]),
    );
    expect(block(prompted)).not.toHaveProperty('spawnedBy');
    // A user turn's timer never carries a cause.
    expect(apply(state(), snapshot([record()], [open]))).toEqual(
      apply(state(), snapshot([record()], [open])),
    );
    expect(
      block(apply(state(), snapshot([record()], [open]))),
    ).not.toHaveProperty('spawnedBy');
  });

  it("keeps a tools-loaded continuation's cause once it binds to its prompt", () => {
    const continuation: ChatTurnRecord = {
      ...record(),
      origin: 'autonomous',
      spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
    };
    const started = apply(state(), snapshot([continuation], [open]));
    const bound = apply(
      started,
      snapshot([{ ...continuation, origin: 'user', userMessageId: 'B' }]),
    );
    expect(block(bound)).toMatchObject({
      userMessageId: 'B',
      spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
    });
  });

  it("records an event wake's cause its result names after the timer opened", () => {
    const wake: ChatTurnRecord = { ...record(), origin: 'autonomous' };
    const woken = apply(state(), snapshot([wake], [open]));
    expect(block(woken)).not.toHaveProperty('spawnedBy');
    const caused = apply(
      woken,
      snapshot([
        {
          ...wake,
          spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1', event: true },
        },
      ]),
    );
    expect(block(caused)).toMatchObject({
      spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1', event: true },
    });
  });

  it('publishes a timer row a binding-only commit changed', () => {
    const wake: ChatTurnRecord = {
      ...record(),
      origin: 'autonomous',
      spawnedBy: { taskId: 'task-1' },
    };
    const woken = apply(state(), snapshot([wake], [open]));
    // A late prompt binding has no timer effect, but it changes the row.
    const binding = snapshot([{ ...wake, origin: 'user', userMessageId: 'B' }]);
    const mutations: ChatCoreMutation[] = [];
    applyTurnEffects(woken, mutations, binding);
    const published = snapshotTimerRows(mutations, binding);
    expect(published.map((row) => row.id)).toEqual(['T:timer']);
    expect(published[0]?.blocks[0]).toMatchObject({ userMessageId: 'B' });
    expect(published[0]?.blocks[0]).not.toHaveProperty('spawnedBy');
    // An unchanged row isn't published again.
    const settled = reduceChatState(woken, mutations);
    const again: ChatCoreMutation[] = [];
    applyTurnEffects(settled, again, binding);
    expect(snapshotTimerRows(again, binding)).toEqual([]);
  });

  it('gives a reused anchor a new timer and never reopens a completed T', () => {
    const first = snapshot(
      [
        {
          ...record('T', 'A'),
          endedAtMs: 1400,
          durationMs: 400,
          outcome: 'completed',
        },
      ],
      [
        open,
        {
          type: 'timer.close',
          timerId: 'T:timer',
          turnId: 'T',
          atMs: 1400,
          durationMs: 400,
        },
      ],
    );
    const settled = apply(state([message('A', 'user', 900)]), first);
    const next = apply(
      settled,
      snapshot(
        [{ ...record('U', 'A'), startedAtMs: 1500 }],
        [{ type: 'timer.open', timerId: 'U:timer', turnId: 'U', atMs: 1500 }],
      ),
    );
    expect(rows(next).map((row) => row.id)).toEqual([
      'A',
      'T:timer',
      'U:timer',
    ]);
    expect(
      block(apply(next, snapshot([record('T', 'A')], [open]))),
    ).toMatchObject({ completedAt: 1400 });
  });

  it('closes a paused settle and is idempotent across repeated pause/resume interval boundaries', () => {
    const pauses = [
      {
        ownerKind: 'approval' as const,
        ownerId: 'approval',
        startedAtMs: 1100,
        endedAtMs: 1300,
      },
      {
        ownerKind: 'question' as const,
        ownerId: 'question',
        startedAtMs: 1200,
        endedAtMs: 1400,
      },
      {
        ownerKind: 'approval' as const,
        ownerId: 'second',
        startedAtMs: 1500,
        endedAtMs: 1700,
      },
    ];
    const captured = snapshot(
      [
        {
          ...record('T', 'A'),
          pauses,
          endedAtMs: 1700,
          durationMs: 200,
          outcome: 'completed',
        },
      ],
      [
        open,
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 1100 },
        { type: 'timer.resume', timerId: 'T:timer', turnId: 'T', atMs: 1400 },
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 1500 },
        {
          type: 'timer.close',
          timerId: 'T:timer',
          turnId: 'T',
          atMs: 1700,
          durationMs: 200,
        },
      ],
    );
    const next = apply(state([message('A', 'user', 900)]), captured);
    expect(block(next)).toMatchObject({
      completedAt: 1700,
      accumulatedPausedDurationMs: 500,
      pausedAt: 1500,
      resumedAt: 1700,
    });
    expect(apply(next, captured)).toEqual(next);
    const duplicateIntervals = snapshot(
      [record('T', 'A')],
      [
        open,
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 1100 },
        { type: 'timer.resume', timerId: 'T:timer', turnId: 'T', atMs: 1400 },
      ],
    );
    const running = apply(
      state([message('A', 'user', 900)]),
      duplicateIntervals,
    );
    expect(block(running)).toMatchObject({ accumulatedPausedDurationMs: 300 });
    expect(apply(running, duplicateIntervals)).toEqual(running);
  });

  it('pauses at its start a timer whose pause owner opened before the turn started', () => {
    // A host question can be stamped before the provider-observed start.
    const pause = {
      ownerKind: 'question' as const,
      ownerId: 'question',
      startedAtMs: 900,
    };
    const paused = snapshot(
      [{ ...record('T', 'A'), pauses: [pause] }],
      [
        open,
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 900 },
      ],
    );
    const next = apply(state([message('A', 'user', 800)]), paused);
    expect(block(next)).toMatchObject({ pausedAt: 1000, resumedAt: null });
    expect(apply(next, paused)).toEqual(next);
    const resumed = apply(
      next,
      snapshot(
        [{ ...record('T', 'A'), pauses: [{ ...pause, endedAtMs: 1300 }] }],
        [{ type: 'timer.resume', timerId: 'T:timer', turnId: 'T', atMs: 1300 }],
      ),
    );
    expect(block(resumed)).toMatchObject({
      pausedAt: 1000,
      resumedAt: 1300,
      accumulatedPausedDurationMs: 300,
    });
  });

  it('resumes at its start a pause that opened and closed before the turn started', () => {
    const captured = snapshot(
      [
        {
          ...record('T', 'A'),
          pauses: [
            {
              ownerKind: 'question',
              ownerId: 'question',
              startedAtMs: 900,
              endedAtMs: 950,
            },
          ],
        },
      ],
      [
        open,
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 900 },
        { type: 'timer.resume', timerId: 'T:timer', turnId: 'T', atMs: 950 },
      ],
    );
    const next = apply(state([message('A', 'user', 800)]), captured);
    expect(block(next)).toMatchObject({
      pausedAt: 1000,
      resumedAt: 1000,
      accumulatedPausedDurationMs: 0,
    });
    expect(apply(next, captured)).toEqual(next);
  });

  it('honors provider duration before reducer elapsed time', () => {
    const captured = snapshot(
      [
        {
          ...record('T', 'A'),
          endedAtMs: 2000,
          durationMs: 250,
          outcome: 'completed',
        },
      ],
      [
        open,
        {
          type: 'timer.close',
          timerId: 'T:timer',
          turnId: 'T',
          atMs: 2000,
          durationMs: 250,
        },
      ],
    );
    const timer = block(apply(state([message('A', 'user', 900)]), captured));
    expect(timer).toMatchObject({ completedAt: 2000, startedAt: 1750 });
  });

  it('retains the original start through approval completion when provider duration differs', () => {
    const captured = snapshot(
      [
        {
          ...record('T', 'A'),
          endedAtMs: 2000,
          durationMs: 250,
          outcome: 'completed',
          pauses: [
            {
              ownerKind: 'approval',
              ownerId: 'approval',
              startedAtMs: 1200,
              endedAtMs: 1400,
            },
          ],
        },
      ],
      [
        open,
        { type: 'timer.pause', timerId: 'T:timer', turnId: 'T', atMs: 1200 },
        { type: 'timer.resume', timerId: 'T:timer', turnId: 'T', atMs: 1400 },
        {
          type: 'timer.close',
          timerId: 'T:timer',
          turnId: 'T',
          atMs: 2000,
          durationMs: 250,
        },
      ],
    );
    const timer = block(apply(state([message('A', 'user', 900)]), captured));
    expect(timer).toMatchObject({
      startedAt: 1000,
      completedAt: 2000,
      accumulatedPausedDurationMs: 200,
    });
    expect(
      apply(apply(state([message('A', 'user', 900)]), captured), captured),
    ).toEqual(apply(state([message('A', 'user', 900)]), captured));
  });

  it('appends a timer whose anchor is outside the selected transcript', () => {
    const next = apply(
      state([message('B', 'user', 1200)]),
      snapshot([record('T', 'A')], [open]),
    );
    expect(rows(next).map((row) => row.id)).toEqual(['B', 'T:timer']);
    expect(block(next)).toMatchObject({ userMessageId: 'A' });
  });
});

describe('canonical runtime projection', () => {
  const idle = serializeChatTurnState(initialChatTurnState());
  const current: PersistedChatTurnState = {
    ...idle,
    phase: 'foreground',
    current: record('T', 'A'),
  };
  it.each(['starting', 'queued'] as const)(
    'canonical current wins over host %s and preserves queue/error/activity metadata',
    (status) => {
      const previous: ChatRuntimeState = {
        status,
        queuedMessageIds: ['B'],
        queuedMessages: [],
        lastActivityAt: 123,
        error: {
          code: 'provider_error',
          message: 'detail',
          retryable: false,
          occurredAt: 'now',
        },
      };
      const projected = projectTurnRuntime(
        previous,
        current,
        ownership({
          dispatchOwners: [
            {
              kind: 'dispatch',
              token: Symbol(),
              operationEpoch: 0,
              reason: 'awaiting-start',
            },
          ],
        }),
      );
      expect(projected).toMatchObject({
        ...previous,
        status: 'streaming',
        turn: current,
        activeTurn: { userMessageId: 'A', startedAt: 1000 },
      });
    },
  );
  it("keeps the host's dispatch identity while an unbound root turn runs", () => {
    // Providers without a root receipt never bind; the dispatch still owns the turn.
    const unbound: PersistedChatTurnState = { ...current, current: record() };
    const activeTurn = { userMessageId: 'D', startedAt: 900 };
    expect(
      projectTurnRuntime(
        { status: 'starting', queuedMessageIds: [], activeTurn },
        unbound,
        ownership(),
      ),
    ).toMatchObject({ status: 'streaming', activeTurn });
  });
  it("keeps an owned dispatch's identity while it starts, before T (phase 15a)", () => {
    const activeTurn = { userMessageId: 'D', startedAt: 900 };
    const dispatch = (userMessageId?: string): ChatTurnOwnershipSnapshot =>
      ownership({
        dispatchOwners: [
          {
            kind: 'dispatch',
            token: Symbol(),
            operationEpoch: 0,
            reason: 'awaiting-start',
            ...(userMessageId ? { userMessageId } : {}),
          },
        ],
      });
    const starting = { status: 'starting' as const, queuedMessageIds: [] };
    expect(
      projectTurnRuntime({ ...starting, activeTurn }, idle, dispatch('D')),
    ).toMatchObject({ status: 'starting', activeTurn });
    // Another dispatch, or a hold with no message, does not adopt a stale identity.
    for (const owner of [dispatch('E'), dispatch()])
      expect(
        projectTurnRuntime({ ...starting, activeTurn }, idle, owner).activeTurn,
      ).toBeUndefined();
  });
  it('maps requires_action and open host pauses to awaiting_input, but not closed pauses', () => {
    expect(
      projectTurnRuntime(
        undefined,
        { ...current, decisionPending: true },
        ownership(),
      ).status,
    ).toBe('awaiting_input');
    const paused: PersistedChatTurnState = {
      ...current,
      current: {
        ...record('T', 'A'),
        pauses: [{ ownerKind: 'approval', ownerId: 'x', startedAtMs: 1100 }],
      },
    };
    expect(projectTurnRuntime(undefined, paused, ownership()).status).toBe(
      'awaiting_input',
    );
    expect(projectTurnRuntime(undefined, current, ownership()).status).toBe(
      'streaming',
    );
  });
  it('projects owned dispatch, queued intent, idle and every ended outcome without background foreground', () => {
    expect(
      projectTurnRuntime(
        undefined,
        idle,
        ownership({
          dispatchOwners: [
            {
              kind: 'dispatch',
              token: Symbol(),
              operationEpoch: 0,
              reason: 'awaiting-start',
            },
          ],
        }),
      ).status,
    ).toBe('starting');
    expect(
      projectTurnRuntime(
        undefined,
        idle,
        ownership({ hostQueuedInputCount: 1 }),
      ).status,
    ).toBe('queued');
    expect(projectTurnRuntime(undefined, idle, ownership()).status).toBe(
      'idle',
    );
    for (const outcome of ['completed', 'cancelled', 'failed'] as const) {
      expect(
        projectTurnRuntime(
          {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'A', startedAt: 1000 },
          },
          {
            ...idle,
            phase: 'background',
            background: {
              native: [{ id: 'child' }],
              managed: { live: 0, queued: 0 },
            },
            lastEnded: { ...record('T', 'A'), outcome, endedAtMs: 2000 },
          },
          ownership(),
        ),
      ).toMatchObject({ status: outcome, activeTurn: undefined });
    }
  });
  it('preserves the empty-completion failed overlay without changing settled ownership or reopening a timer', () => {
    const previous: ChatRuntimeState = {
      status: 'failed',
      queuedMessageIds: [],
      error: {
        code: 'empty_completion',
        message: 'empty',
        retryable: true,
        occurredAt: 'now',
      },
      emptyCompletionRecovery: {
        turnUserMessageId: 'A',
        detectedAt: 2000,
        automaticRetryAllowed: false,
      },
    };
    const ended: PersistedChatTurnState = {
      ...idle,
      lastEnded: { ...record('T', 'A'), endedAtMs: 2000, outcome: 'completed' },
    };
    expect(projectTurnRuntime(previous, ended, ownership())).toMatchObject({
      status: 'failed',
      turn: ended,
      error: previous.error,
      emptyCompletionRecovery: previous.emptyCompletionRecovery,
    });
    expect(
      projectTurnRuntime(
        { status: 'completed', queuedMessageIds: [] },
        ended,
        ownership(),
      ).status,
    ).toBe('completed');
    expect(
      projectTurnRuntime(
        previous,
        { ...current, current: record('U', 'B') },
        ownership(),
      ).status,
    ).toBe('streaming');
  });
});
