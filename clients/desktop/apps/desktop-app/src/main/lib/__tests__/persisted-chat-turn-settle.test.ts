import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  hydrateChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  buildPersistedTurnInterruptedMutations,
  hasOpenPersistedChatTurn,
  settlePersistedInterruptedMessages,
  settlePersistedInterruptedStream,
  settlePersistedForkMessages,
  closeOpenPersistedToolUses,
} from '../persisted-chat-settle';

const openTurn = (
  withPause: boolean,
): ReturnType<typeof serializeChatTurnState> => {
  const state = hydrateChatTurnState({
    phase: 'foreground',
    decisionPending: false,
    catchingUp: false,
    current: {
      id: 'open-turn',
      origin: 'user',
      startedAtMs: 100,
      pauses: withPause
        ? [
            {
              ownerKind: 'approval',
              ownerId: 'approval-owner',
              startedAtMs: 150,
            },
          ]
        : [],
    },
    endedTurnIds: [],
    background: { native: [], managed: { live: 0, queued: 0 } },
  });
  if (!state) throw new Error('Invalid open turn fixture');
  return serializeChatTurnState(state);
};

function runtimePatch(
  mutations: ReturnType<typeof buildPersistedTurnInterruptedMutations>,
): Extract<
  ReturnType<typeof buildPersistedTurnInterruptedMutations>[number],
  { type: 'runtime.patched' }
> {
  const patch = mutations.find(
    (mutation) => mutation.type === 'runtime.patched',
  );
  if (!patch || patch.type !== 'runtime.patched')
    throw new Error('Missing runtime settlement mutation');
  return patch;
}

describe('persisted chat turn restart settlement', () => {
  it.each([
    { description: 'an open reducer turn', withPause: false },
    {
      description: 'an open pause owner despite legacy idle status',
      withPause: true,
    },
  ])('settles $description with a terminal restart', ({ withPause }) => {
    const runtime: ChatRuntimeState = {
      status: 'idle',
      queuedMessageIds: [],
      turn: openTurn(withPause),
    };

    const patch = runtimePatch(
      buildPersistedTurnInterruptedMutations('chat', [], runtime, 200),
    );

    expect(patch.runtime.status).toBe('interrupted');
    expect(patch.runtime.turn?.current).toBeUndefined();
    expect(patch.runtime.turn?.lastEnded).toMatchObject({
      id: 'open-turn',
      endedAtMs: 200,
      outcome: 'cancelled',
      terminalReason: 'restart',
    });
    expect(patch.runtime.turn?.lastEnded?.pauses).toEqual(
      withPause
        ? [
            {
              ownerKind: 'approval',
              ownerId: 'approval-owner',
              startedAtMs: 150,
              endedAtMs: 200,
            },
          ]
        : [],
    );
  });

  it('hydrates missing persisted turn state as an initial turn before settlement', () => {
    const runtime: ChatRuntimeState = { status: 'idle', queuedMessageIds: [] };
    const patch = runtimePatch(
      buildPersistedTurnInterruptedMutations('chat', [], runtime, 200),
    );

    expect(patch.runtime.turn).toEqual({
      phase: 'idle',
      decisionPending: false,
      catchingUp: false,
      endedTurnIds: [],
      background: { native: [], managed: { live: 0, queued: 0 } },
    });
  });

  it('detects an open reducer turn and ignores an absent turn value', () => {
    expect(hasOpenPersistedChatTurn(openTurn(false))).toBe(true);
    expect(hasOpenPersistedChatTurn(undefined)).toBe(false);
  });
});

const interruptedMessages: PersistedChatMessage[] = [
  {
    id: 'original',
    role: 'user',
    timestamp: 100,
    blocks: [{ type: 'text', text: 'Edit' }],
  },
  {
    id: 'timer',
    role: 'system',
    timestamp: 100,
    blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: null }],
  },
  {
    id: 'work',
    role: 'assistant',
    timestamp: 180,
    blocks: [
      { type: 'tool_use', toolUseId: 'edit', toolName: 'Edit', input: '{}' },
    ],
  },
];

it.each(['parentBlockId', 'parentToolUseId'] as const)(
  'preserves completed root tools across a child-directed user row with %s',
  (parentField) => {
    const messages: PersistedChatMessage[] = [
      ...interruptedMessages,
      {
        id: 'child',
        role: 'user',
        timestamp: 190,
        [parentField]: 'agent',
        blocks: [{ type: 'text', text: 'Child follow-up' }],
      },
      {
        id: 'real',
        role: 'system',
        timestamp: 300,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'edit',
            toolName: 'Edit',
            output: 'saved',
            isError: false,
          },
        ],
      },
    ];
    expect(closeOpenPersistedToolUses(messages, 1000)).toBe(messages);
    const settled = settlePersistedInterruptedMessages(messages, 1000);
    expect(settled.find((message) => message.id === 'timer')?.blocks).toEqual([
      { type: 'turn_timer', startedAt: 100, completedAt: 300 },
    ]);
    expect(
      settled
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool_result'),
    ).toEqual(messages.at(-1)?.blocks);
  },
);

it.each(['parentBlockId', 'parentToolUseId'] as const)(
  'preserves a genuine late child result across root prompts through %s',
  async (parentField) => {
    const messages: PersistedChatMessage[] = [
      interruptedMessages[0],
      {
        id: 'agent',
        role: 'assistant',
        timestamp: 110,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'agent',
            toolName: 'Agent',
            input: '{}',
          },
          {
            type: 'tool_result',
            toolUseId: 'agent',
            toolName: 'Agent',
            output: 'started',
            isError: false,
          },
        ],
      },
      { ...interruptedMessages[2], id: 'child-call', [parentField]: 'agent' },
      {
        id: 'next-user',
        role: 'user',
        timestamp: 200,
        blocks: [{ type: 'text', text: 'Other work' }],
      },
      {
        id: 'child-result',
        role: 'assistant',
        timestamp: 300,
        [parentField]: 'agent',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'edit',
            toolName: 'Edit',
            output: 'saved',
            isError: false,
          },
        ],
      },
    ];
    expect(closeOpenPersistedToolUses(messages, 1000)).toBe(messages);
    expect(settlePersistedInterruptedMessages(messages, 1000)).toEqual(
      messages,
    );
    async function* rows(): AsyncGenerator<PersistedChatMessage> {
      yield* await Promise.resolve(messages);
    }
    const streamed = [];
    for await (const row of settlePersistedInterruptedStream(rows, 1000))
      streamed.push(row);
    expect(streamed).toEqual(messages);
    const mutations = buildPersistedTurnInterruptedMutations(
      'chat',
      messages,
      {
        status: 'streaming',
        queuedMessageIds: [],
        activeTurn: { userMessageId: 'original', startedAt: 100 },
      },
      1000,
    );
    expect(
      mutations.filter((mutation) => mutation.type === 'message.upserted'),
    ).toEqual([]);
  },
);

it('settles at historical activity and records explicit interruption metadata', () => {
  const mutations = buildPersistedTurnInterruptedMutations(
    'chat',
    interruptedMessages,
    {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurn: { userMessageId: 'original', startedAt: 100 },
      lastActivityAt: 170,
    },
    100000,
  );
  expect(runtimePatch(mutations).runtime.lastActivityAt).toBe(180);
  const upserts = mutations.flatMap((mutation) =>
    mutation.type === 'message.upserted' ? [mutation.message] : [],
  );
  expect(upserts.find((message) => message.id === 'timer')).toMatchObject({
    blocks: [{ completedAt: 180 }],
  });
  expect(
    upserts.find((message) => message.id.startsWith('archive-cancel-')),
  ).toMatchObject({
    timestamp: 180,
    blocks: [
      {
        type: 'tool_result',
        isError: true,
        interruption: { reason: 'app_restart', at: 180 },
      },
    ],
  });
});

it('keeps malformed timer pause accounting finite and non-negative', () => {
  const messages: PersistedChatMessage[] = [
    {
      id: 'timer',
      role: 'system',
      timestamp: 100,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: NaN,
          completedAt: null,
          pausedAt: Infinity,
          accumulatedPausedDurationMs: NaN,
        },
      ],
    },
  ];
  expect(
    settlePersistedInterruptedMessages(messages, 200)[0].blocks,
  ).toMatchObject([
    { completedAt: 100, accumulatedPausedDurationMs: 0, pausedAt: null },
  ]);
});

it('never settles the newer turn or matches repeated tool ids across turns', () => {
  const newer: PersistedChatMessage[] = [
    ...interruptedMessages,
    {
      id: 'resume',
      role: 'user',
      timestamp: 500,
      blocks: [{ type: 'text', text: 'Continue' }],
    },
    {
      id: 'new-timer',
      role: 'system',
      timestamp: 500,
      blocks: [{ type: 'turn_timer', startedAt: 500, completedAt: null }],
    },
    {
      id: 'new-result',
      role: 'assistant',
      timestamp: 600,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          toolName: 'Edit',
          output: 'done',
          isError: false,
        },
      ],
    },
  ];
  const mutations = buildPersistedTurnInterruptedMutations(
    'chat',
    newer,
    {
      status: 'streaming',
      queuedMessageIds: [],
      activeTurn: { userMessageId: 'original', startedAt: 100 },
      lastActivityAt: 600,
    },
    100000,
  );
  expect(runtimePatch(mutations).runtime.lastActivityAt).toBe(180);
  expect(
    mutations.some(
      (m) => m.type === 'message.upserted' && m.message.id === 'new-timer',
    ),
  ).toBe(false);
  const synthetic = mutations
    .flatMap((mutation) =>
      mutation.type === 'message.upserted' ? [mutation.message] : [],
    )
    .find((message) => message.id.startsWith('archive-cancel-'));
  expect(synthetic).toMatchObject({
    blocks: [
      { toolUseId: 'edit', interruption: { reason: 'app_restart', at: 180 } },
    ],
  });
});

it('archive settlement is historical, idempotent and fork settlement retains event time', async () => {
  const archived = settlePersistedInterruptedMessages(
    interruptedMessages,
    100000,
  );
  expect(archived.find((m) => m.id === 'timer')?.blocks).toEqual([
    expect.objectContaining({ completedAt: 180 }),
  ]);
  expect(settlePersistedInterruptedMessages(archived, 200000)).toBe(archived);
  expect(
    settlePersistedForkMessages(interruptedMessages, 500).at(-1)?.blocks,
  ).toEqual([
    expect.objectContaining({ interruption: { reason: 'fork', at: 500 } }),
  ]);
  async function* rows(): AsyncGenerator<PersistedChatMessage> {
    yield* await Promise.resolve(interruptedMessages);
  }
  const migrated = [];
  for await (const row of settlePersistedInterruptedStream(rows, 100000))
    migrated.push(row);
  expect(migrated.find((m) => m.id === 'timer')?.blocks).toEqual([
    expect.objectContaining({ completedAt: 180 }),
  ]);
  expect(migrated.at(-1)?.blocks).toEqual([
    expect.objectContaining({
      interruption: { reason: 'app_restart', at: 180 },
    }),
  ]);
});

it('a genuine late result supersedes a synthetic interruption in its own turn', () => {
  const interrupted = settlePersistedInterruptedMessages(
    interruptedMessages,
    1000,
  );
  const real: PersistedChatMessage = {
    id: 'late-result',
    role: 'system',
    timestamp: 190,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'edit',
        toolName: 'Edit',
        output: 'saved',
        isError: false,
      },
    ],
  };
  const settled = settlePersistedInterruptedMessages(
    [...interrupted, real],
    2000,
  );
  const results = settled
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'tool_result');
  expect(results).toEqual(real.blocks);
});

it('does not pair a different child thread result with a reused tool id', () => {
  const messages: PersistedChatMessage[] = [
    ...interruptedMessages,
    {
      id: 'child-call',
      role: 'assistant',
      timestamp: 180,
      parentBlockId: 'child',
      codexThreadId: 'thread-b',
      blocks: [
        { type: 'tool_use', toolUseId: 'edit', toolName: 'Edit', input: '{}' },
      ],
    },
    {
      id: 'child-result',
      role: 'system',
      timestamp: 190,
      parentBlockId: 'child',
      codexThreadId: 'thread-a',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          toolName: 'Edit',
          output: 'saved',
          isError: false,
        },
      ],
    },
  ];
  const settled = closeOpenPersistedToolUses(messages, 200);
  const synthetic = settled.slice(messages.length);
  expect(synthetic).toHaveLength(2);
  expect(synthetic[0]).toMatchObject({
    blocks: [{ toolUseId: 'edit', interruption: { at: 200 } }],
  });
  expect(synthetic[1]).toMatchObject({
    parentBlockId: 'child',
    codexThreadId: 'thread-b',
    blocks: [{ toolUseId: 'edit', interruption: { at: 200 } }],
  });
  expect(closeOpenPersistedToolUses(settled, 300)).toBe(settled);
});
