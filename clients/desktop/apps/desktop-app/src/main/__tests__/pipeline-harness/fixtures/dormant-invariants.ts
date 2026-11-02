import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatTurnLifecycleEvent,
  TurnOrigin,
} from '@canopy/protocol/canopy-core';
import type {
  DormantInvariantOptions,
  InvariantId,
  PipelineChatTarget,
  PipelineEffect,
  PipelineTraceEvent,
  RevisionTraceEvent,
} from '../contracts';

export interface DormantInvariantFixture {
  id: Extract<InvariantId, 1 | 2 | 3 | 4 | 5 | 6 | 15 | 19>;
  passing: readonly PipelineTraceEvent[];
  failing: readonly PipelineTraceEvent[];
  failingSeqs: readonly number[];
  passingOptions?: DormantInvariantOptions;
  failingOptions?: DormantInvariantOptions;
}

const target: PipelineChatTarget = {
  projectId: 'dormant-project',
  worktreeId: 'dormant-worktree',
  chatId: 'dormant-chat',
};

function stamp(
  seq: number,
  logicalAt = seq,
): Pick<PipelineTraceEvent, 'seq' | 'at' | 'logicalAt'> {
  return { seq, at: seq, logicalAt };
}

function currentTurn(
  id: string,
  startedAtMs: number,
  options: {
    origin?: ChatTurnRecord['origin'];
    userMessageId?: string;
    pauses?: ChatTurnRecord['pauses'];
  } = {},
): ChatTurnRecord {
  return {
    id,
    origin: options.origin ?? 'user',
    startedAtMs,
    pauses: options.pauses ?? [],
    ...(options.userMessageId === undefined
      ? {}
      : {
          userMessageId: options.userMessageId,
          inputIds: [options.userMessageId],
        }),
  };
}

function turnState(
  phase: PersistedChatTurnState['phase'],
  current?: ChatTurnRecord,
  extra: Partial<PersistedChatTurnState> = {},
): PersistedChatTurnState {
  return {
    phase,
    decisionPending: false,
    catchingUp: false,
    ...(current === undefined ? {} : { current }),
    endedTurnIds: [],
    background: { native: [], managed: { live: 0, queued: 0 } },
    ...extra,
  };
}

function runtime(turn: PersistedChatTurnState): ChatRuntimeState {
  return {
    status: turn.phase === 'foreground' ? 'streaming' : 'idle',
    queuedMessageIds: [],
    turn,
  };
}

function timerRow(
  id: string,
  startedAt: number,
  completedAt: number | null,
  pause: { pausedAt?: number | null; resumedAt?: number | null } = {},
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: startedAt,
    blocks: [
      {
        type: 'turn_timer',
        startedAt,
        completedAt,
        ...(pause.pausedAt === undefined ? {} : { pausedAt: pause.pausedAt }),
        ...(pause.resumedAt === undefined
          ? {}
          : { resumedAt: pause.resumedAt }),
      },
    ],
  };
}

function timerId(turnId: string): string {
  return `${turnId}:timer`;
}

function revision(
  seq: number,
  rows: readonly PersistedChatMessage[],
  turn: PersistedChatTurnState,
): RevisionTraceEvent {
  return {
    ...stamp(seq),
    kind: 'revision',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    revision: seq,
    baseRevision: seq - 1,
    source: 'provider',
    chats: {
      [target.chatId]: {
        runtime: runtime(turn),
        rows,
        inputDelivery: undefined,
      },
    },
  };
}

function lifecycle(
  seq: number,
  event: ChatTurnLifecycleEvent,
): PipelineTraceEvent {
  return { ...stamp(seq), kind: 'turn-lifecycle', target, event };
}

function started(
  seq: number,
  lifecycleSequence: number,
  options: {
    turnId?: string;
    origin?: TurnOrigin;
    userMessageId?: string;
    startedAtMs?: number;
    provider?: ChatTurnLifecycleEvent['provider'];
  } = {},
): PipelineTraceEvent {
  const turnId = options.turnId ?? 'turn-1';
  const userMessageIds =
    options.userMessageId === undefined ? [] : [options.userMessageId];
  const event: ChatTurnLifecycleEvent = {
    version: 1,
    provider: options.provider ?? 'claude',
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    processEpoch: 'dormant-epoch',
    sequence: lifecycleSequence,
    eventId: `started-${lifecycleSequence}`,
    observedAtMs: options.startedAtMs ?? 10,
    type: 'TurnStarted',
    phase: 'start',
    turnId,
    origin: options.origin ?? 'user',
    binding: 'bound',
    submissionIds: userMessageIds,
    userMessageIds,
    providerUserMessageUuids: [],
    startedAtMs: options.startedAtMs ?? 10,
  };
  return lifecycle(seq, event);
}

function ended(
  seq: number,
  lifecycleSequence: number,
  turnId = 'turn-1',
  userMessageId = 'user-1',
  provider: ChatTurnLifecycleEvent['provider'] = 'claude',
): PipelineTraceEvent {
  const userMessageIds = userMessageId ? [userMessageId] : [];
  const event: ChatTurnLifecycleEvent = {
    version: 1,
    provider,
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    processEpoch: 'dormant-epoch',
    sequence: lifecycleSequence,
    eventId: `ended-${lifecycleSequence}`,
    observedAtMs: 30,
    type: 'TurnEnded',
    turnId,
    origin: 'user',
    binding: 'bound',
    submissionIds: userMessageIds,
    userMessageIds,
    providerUserMessageUuids: [],
    endedAtMs: 30,
    outcome: 'completed',
    source: 'result',
  };
  return lifecycle(seq, event);
}

function checkpoint(
  seq: number,
  label: string,
  values: {
    logicalAt?: number;
    liveness?: { foreground: boolean; background: boolean };
    sessionTurnActive?: boolean;
    queueTurnActive?: boolean;
    admissionBlocked?: boolean;
    userInitiated?: boolean;
  } = {},
): PipelineTraceEvent {
  return {
    ...stamp(seq, values.logicalAt),
    kind: 'checkpoint',
    label,
    target,
    ...(values.liveness === undefined ? {} : { liveness: values.liveness }),
    ...(values.sessionTurnActive === undefined
      ? {}
      : { sessionTurnActive: values.sessionTurnActive }),
    ...(values.queueTurnActive === undefined
      ? {}
      : { queueTurnActive: values.queueTurnActive }),
    ...(values.admissionBlocked === undefined
      ? {}
      : { admissionBlocked: values.admissionBlocked }),
    ...(values.userInitiated === undefined
      ? {}
      : { userInitiated: values.userInitiated }),
  };
}

function effect(seq: number, value: PipelineEffect): PipelineTraceEvent {
  return { ...stamp(seq), kind: 'effect', target, effect: value };
}

function providerFrame(
  seq: number,
  type: string,
  turnKey: string,
): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'provider',
    provider: 'claude',
    target,
    direction: 'to-canopy',
    type,
    turnKey,
  };
}

function queueEvent(
  seq: number,
  ids: readonly string[],
  turnActive: boolean,
  admissionBlocked?: boolean,
): PipelineTraceEvent {
  return {
    ...stamp(seq),
    kind: 'queue',
    turnActive,
    ...(admissionBlocked === undefined ? {} : { admissionBlocked }),
    event: {
      ...target,
      queue: ids.map((id) => ({
        id,
        text: `queued ${id}`,
        origin: 'desktop',
        enqueuedAtMs: 1,
      })),
    },
  };
}

function idleAfterTurn(
  turnId: string,
  userMessageId: string | undefined,
  startedAtMs: number,
  endedAtMs: number,
): PersistedChatTurnState {
  return turnState('idle', undefined, {
    lastEnded: {
      ...currentTurn(turnId, startedAtMs, { userMessageId }),
      endedAtMs,
      outcome: 'completed',
      durationMs: endedAtMs - startedAtMs,
    },
    endedTurnIds: [turnId],
  });
}

const olderTranscriptRow: PersistedChatMessage = {
  id: 'older-row',
  role: 'user',
  timestamp: 1,
  blocks: [
    {
      type: 'text',
      text: 'Older content omitted from the bounded transcript.',
    },
  ],
};
const retainedAnchorRow: PersistedChatMessage = {
  id: 'retained-anchor',
  role: 'assistant',
  timestamp: 2,
  blocks: [{ type: 'text', text: 'Retained transcript anchor.' }],
};

function withOlderTranscript(
  trace: readonly PipelineTraceEvent[],
): readonly PipelineTraceEvent[] {
  return trace.map((event) => {
    if (event.kind !== 'revision') return event;
    return {
      ...event,
      chats: Object.fromEntries(
        Object.entries(event.chats).map(([chatId, view]) => [
          chatId,
          view.rows === undefined
            ? view
            : { ...view, rows: [olderTranscriptRow, ...view.rows] },
        ]),
      ),
    };
  });
}

const sameCurrent = turnState(
  'foreground',
  currentTurn('turn-1', 10, { userMessageId: 'user-1' }),
);

const sameHistoryBounded: readonly PipelineTraceEvent[] = [
  started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
  revision(
    2,
    [retainedAnchorRow, timerRow(timerId('turn-1'), 10, null)],
    sameCurrent,
  ),
];

const movedTimerFull: readonly PipelineTraceEvent[] = [
  started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
  revision(
    2,
    [
      olderTranscriptRow,
      timerRow('wrong-timer-placement', 10, null),
      retainedAnchorRow,
    ],
    sameCurrent,
  ),
];

const pairedPausedAndAutonomous: readonly PipelineTraceEvent[] = [
  started(1, 1, { turnId: 'paused-turn', userMessageId: 'user-paused' }),
  revision(
    2,
    [
      retainedAnchorRow,
      timerRow(timerId('paused-turn'), 10, null, { pausedAt: 20 }),
    ],
    turnState(
      'foreground',
      currentTurn('paused-turn', 10, {
        userMessageId: 'user-paused',
        pauses: [
          { ownerKind: 'approval', ownerId: 'approval-1', startedAtMs: 20 },
        ],
      }),
    ),
  ),
  ended(3, 2, 'paused-turn', 'user-paused'),
  revision(
    4,
    [
      retainedAnchorRow,
      timerRow(timerId('paused-turn'), 10, 30, {
        pausedAt: 20,
        resumedAt: 25,
      }),
    ],
    idleAfterTurn('paused-turn', 'user-paused', 10, 30),
  ),
  started(5, 3, {
    turnId: 'autonomous-turn',
    origin: 'autonomous',
    startedAtMs: 40,
  }),
  revision(
    6,
    [retainedAnchorRow, timerRow(timerId('autonomous-turn'), 40, null)],
    turnState(
      'foreground',
      currentTurn('autonomous-turn', 40, { origin: 'autonomous' }),
    ),
  ),
];
const pairedPausedAndAutonomousFull = withOlderTranscript(
  pairedPausedAndAutonomous,
);

export const DORMANT_INVARIANT_FIXTURES: readonly DormantInvariantFixture[] = [
  {
    id: 1,
    passing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(2, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
    ],
    failing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(
        2,
        [
          timerRow(timerId('turn-1'), 10, null),
          timerRow('legacy-timer-turn-1', 10, null),
        ],
        sameCurrent,
      ),
    ],
    failingSeqs: [2],
  },
  {
    id: 2,
    passing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(2, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
    ],
    failing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(2, [timerRow(timerId('turn-1'), 10, 30)], sameCurrent),
    ],
    failingSeqs: [2],
  },
  {
    id: 3,
    passing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      ended(2, 2),
      revision(
        3,
        [timerRow(timerId('turn-1'), 10, 30)],
        idleAfterTurn('turn-1', 'user-1', 10, 30),
      ),
    ],
    failing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      ended(2, 2),
      revision(
        3,
        [timerRow(timerId('turn-1'), 10, null)],
        idleAfterTurn('turn-1', 'user-1', 10, 30),
      ),
    ],
    failingSeqs: [2, 3],
  },
  {
    id: 4,
    passing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(2, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
      started(3, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(4, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
    ],
    failing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(2, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
      started(3, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      revision(
        4,
        [timerRow(timerId('turn-1'), 10, null)],
        turnState('foreground', currentTurn('late-turn', 40), {
          decisionPending: true,
        }),
      ),
    ],
    failingSeqs: [2, 3, 4],
  },
  {
    id: 5,
    passing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      effect(2, {
        name: 'wake-lock-acquire',
        holder: `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
      }),
      revision(3, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
      queueEvent(4, [], true, true),
      checkpoint(5, 'foreground', {
        sessionTurnActive: true,
        queueTurnActive: true,
        admissionBlocked: true,
      }),
    ],
    failing: [
      started(1, 1, { userMessageId: 'user-1', startedAtMs: 10 }),
      effect(2, {
        name: 'wake-lock-acquire',
        holder: `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
      }),
      revision(3, [timerRow(timerId('turn-1'), 10, null)], sameCurrent),
      queueEvent(4, [], true, true),
      checkpoint(5, 'foreground', {
        sessionTurnActive: true,
        queueTurnActive: false,
        admissionBlocked: false,
      }),
    ],
    failingSeqs: [1, 5],
  },
  {
    id: 6,
    passing: pairedPausedAndAutonomous,
    failing: sameHistoryBounded,
    failingSeqs: [2],
    passingOptions: { fullTranscriptTrace: pairedPausedAndAutonomousFull },
    failingOptions: { fullTranscriptTrace: movedTimerFull },
  },
  {
    id: 15,
    passing: [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'gate-released', {
        logicalAt: 100,
        liveness: { foreground: false, background: false },
        queueTurnActive: false,
      }),
    ],
    failing: [
      checkpoint(1, 'drained', {
        logicalAt: 0,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
      checkpoint(2, 'deadline', {
        logicalAt: 501,
        liveness: { foreground: false, background: false },
        queueTurnActive: true,
      }),
    ],
    failingSeqs: [1, 2],
  },
  {
    id: 19,
    passing: [
      started(1, 1, {
        turnId: 'autonomous-turn',
        origin: 'autonomous',
        startedAtMs: 10,
      }),
      effect(2, {
        name: 'wake-lock-acquire',
        holder: `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
      }),
      revision(
        3,
        [timerRow(timerId('autonomous-turn'), 10, null)],
        turnState(
          'foreground',
          currentTurn('autonomous-turn', 10, { origin: 'autonomous' }),
        ),
      ),
      providerFrame(4, 'sdk:assistant', 'provider-turn-autonomous'),
      checkpoint(5, 'autonomous-active', {
        sessionTurnActive: true,
        queueTurnActive: true,
      }),
      providerFrame(6, 'sdk:result', 'provider-turn-autonomous'),
      ended(7, 2, 'autonomous-turn', ''),
      revision(
        8,
        [timerRow(timerId('autonomous-turn'), 40, 60)],
        idleAfterTurn('autonomous-turn', undefined, 40, 60),
      ),
      checkpoint(9, 'autonomous-settled', {
        sessionTurnActive: false,
        queueTurnActive: false,
      }),
    ],
    failing: [
      queueEvent(1, ['queued-user'], false),
      started(2, 1, { userMessageId: 'queued-user', startedAtMs: 10 }),
      effect(3, {
        name: 'wake-lock-acquire',
        holder: `chat:${target.projectId}/${target.worktreeId}/${target.chatId}`,
      }),
      revision(
        4,
        [timerRow(timerId('turn-1'), 10, null)],
        turnState(
          'foreground',
          currentTurn('turn-1', 10, { userMessageId: 'queued-user' }),
        ),
      ),
      queueEvent(5, ['queued-user'], true),
      providerFrame(6, 'sdk:assistant', 'provider-turn-queued'),
      checkpoint(7, 'foreground', {
        sessionTurnActive: true,
        queueTurnActive: true,
      }),
    ],
    failingSeqs: [1, 2, 4],
  },
];
