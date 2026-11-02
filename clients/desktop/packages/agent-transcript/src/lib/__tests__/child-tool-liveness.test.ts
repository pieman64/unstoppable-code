import type { CodexAgentCallBlock, PersistedChatMessage } from '../../types';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  parseAgentTranscriptLines,
  type TranscriptReducerState,
  type TranscriptReducerOptions,
} from '../transcript-parser';

import {
  readChildToolLivenessStamp,
  type ChildToolLiveness,
} from '../child-tool-liveness';

function options(
  childToolLiveness: ChildToolLiveness,
): TranscriptReducerOptions {
  let id = 0;
  return {
    now: 10,
    createMessageId: (): string => `generated-${++id}`,
    childToolLiveness,
  };
}

function tool(
  id: string,
  routing: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [
      { type: 'tool_use', toolUseId: id, toolName: 'Bash', input: '{}' },
    ],
    ...routing,
  };
}

function state(messages: PersistedChatMessage[]): TranscriptReducerState {
  return {
    ...createEmptyTranscriptReducerState(),
    messages,
    sdkSessionId: 'root',
  };
}

function closedIds(messages: PersistedChatMessage[]): string[] {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === 'tool_result' ? [block.toolUseId] : [],
    ),
  );
}

const terminals = [
  {
    name: 'Claude result',
    event: { type: 'result' },
    reduce: applyClaudeTranscriptEvent,
  },
  {
    name: 'Claude error',
    event: { type: 'error', error: 'Session aborted' },
    reduce: applyClaudeTranscriptEvent,
  },
  {
    name: 'Codex startup failure',
    event: {
      type: 'result',
      subtype: 'codex_error',
      is_error: true,
      result: 'Failed',
    },
    reduce: applyCodexTranscriptEvent,
  },
];

const cases: {
  label: string;
  liveness: ChildToolLiveness;
  closed: string[];
}[] = [
  {
    label: 'live parent',
    liveness: {
      kind: 'known',
      liveParentToolUseIds: ['outer'],
      hasUncorrelatedLiveTask: false,
    },
    closed: ['root-tool'],
  },
  {
    label: 'known ended parent',
    liveness: {
      kind: 'known',
      liveParentToolUseIds: [],
      hasUncorrelatedLiveTask: false,
    },
    closed: ['root-tool', 'child'],
  },
  {
    label: 'uncorrelated live task',
    liveness: {
      kind: 'known',
      liveParentToolUseIds: [],
      hasUncorrelatedLiveTask: true,
    },
    closed: ['root-tool'],
  },
  { label: 'unknown', liveness: { kind: 'unknown' }, closed: ['root-tool'] },
  {
    label: 'no live session',
    liveness: { kind: 'no-live-session' },
    closed: ['root-tool', 'child'],
  },
];

for (const terminal of terminals) {
  describe(terminal.name, () => {
    it.each(cases)('$label', ({ liveness, closed }) => {
      const next = terminal.reduce(
        state([tool('root-tool'), tool('child', { parentToolUseId: 'outer' })]),
        terminal.event,
        options(liveness),
      );
      expect(closedIds(next.messages)).toEqual(closed);
    });

    it.each([
      'running',
      'pendingInit',
      'future-status',
      'interrupted',
      'completed',
      'errored',
      'shutdown',
      'notFound',
      'cancelled',
    ])('Codex receiver %s', (status) => {
      const block: CodexAgentCallBlock = {
        type: 'codex_agent_call',
        agentBlockId: 'agent',
        callId: 'call',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'root',
        receiverThreadIds: ['receiver'],
        prompt: '',
        agentsStates: { receiver: { status } },
      };
      const messages = [
        tool('root-tool', { codexThreadId: 'root' }),
        {
          id: 'agent',
          role: 'assistant',
          timestamp: 1,
          blocks: [block],
        } satisfies PersistedChatMessage,
        tool('child', { parentBlockId: 'agent', codexThreadId: 'receiver' }),
      ];
      const next = terminal.reduce(
        state(messages),
        terminal.event,
        options({
          kind: 'known',
          liveParentToolUseIds: [],
          hasUncorrelatedLiveTask: false,
        }),
      );
      expect(closedIds(next.messages)).toEqual([
        'root-tool',
        ...(['running', 'pendingInit', 'future-status'].includes(status)
          ? []
          : ['child']),
      ]);
      expect(next.messages[1].blocks).toEqual([block]);
    });

    it('keeps unresolved Codex children and unknown root threads open', () => {
      const initial = {
        ...state([
          tool('unresolved', {
            parentBlockId: 'missing',
            codexThreadId: 'receiver',
          }),
          tool('unknown-thread', { codexThreadId: 'other' }),
        ]),
        sdkSessionId: undefined,
      };
      expect(
        closedIds(
          terminal.reduce(initial, terminal.event, options({ kind: 'unknown' }))
            .messages,
        ),
      ).toEqual([]);
    });
  });
}

function assistant(id: string, parent?: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: id,
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
  };
}

it('keeps a nested Claude subtree grouped under its outer live task', () => {
  const events = [
    assistant('outer'),
    assistant('nested-agent', 'outer'),
    assistant('nested-bash', 'outer'),
    { type: 'result' },
  ];
  const live = events.reduce(
    (previous, event) =>
      applyClaudeTranscriptEvent(
        previous,
        event,
        options({
          kind: 'known',
          liveParentToolUseIds: ['outer'],
          hasUncorrelatedLiveTask: false,
        }),
      ),
    createEmptyTranscriptReducerState(),
  );
  expect(closedIds(live.messages)).toEqual(['outer']);
});

it.each(terminals)(
  'replays a stamped $name just like live reduction',
  ({ event, reduce }) => {
    const liveness: ChildToolLiveness = {
      kind: 'known',
      liveParentToolUseIds: ['outer'],
      hasUncorrelatedLiveTask: false,
    };
    const events = [
      assistant('root-tool'),
      assistant('child', 'outer'),
      { ...event, canopy_child_tool_liveness: liveness },
    ];
    const beforeTerminal = events
      .slice(0, -1)
      .reduce(
        (previous, frame) =>
          applyClaudeTranscriptEvent(
            previous,
            frame,
            options({ kind: 'unknown' }),
          ),
        createEmptyTranscriptReducerState(),
      );
    const live = reduce(
      beforeTerminal,
      events[events.length - 1],
      options({ kind: 'no-live-session' }),
    );
    // Claude message frames exercise shared terminal handling even for codex_error.
    const replay = parseAgentTranscriptLines(
      events.map((frame) => JSON.stringify(frame)),
      'claude',
    );
    expect(closedIds(live.messages)).toEqual(closedIds(replay.messages));
    expect(closedIds(replay.messages)).toEqual(['root-tool']);
  },
);

it('replay is conservative unless the finished transcript is explicitly settled', () => {
  const lines = [
    assistant('root-tool'),
    assistant('child', 'outer'),
    { type: 'result' },
  ].map((frame) => JSON.stringify(frame));
  expect(
    closedIds(parseAgentTranscriptLines(lines, 'claude').messages),
  ).toEqual(['root-tool']);
  expect(
    closedIds(
      parseAgentTranscriptLines(lines, 'claude', { closeOpenTurnAtEnd: true })
        .messages,
    ),
  ).toEqual(['root-tool', 'child']);
});

it.each([applyClaudeTranscriptEvent, applyCodexTranscriptEvent])(
  'ended-child event is selective, idempotent, and a no-op without matches',
  (reduce) => {
    const initial = state([
      tool('root-tool'),
      tool('child', { parentToolUseId: 'outer' }),
      tool('nested', { parentToolUseId: 'outer' }),
      tool('other', { parentToolUseId: 'other-parent' }),
    ]);
    const event = {
      type: 'canopy_child_tools_ended',
      parent_tool_use_ids: ['outer'],
      reason: 'task finished',
    };
    const next = reduce(initial, event, options({ kind: 'unknown' }));
    expect(closedIds(next.messages)).toEqual(['child', 'nested']);
    expect(reduce(next, event, options({ kind: 'unknown' }))).toBe(next);
    expect(
      reduce(
        initial,
        { ...event, parent_tool_use_ids: ['missing'] },
        options({ kind: 'unknown' }),
      ),
    ).toBe(initial);
    const real = applyClaudeTranscriptEvent(
      next,
      {
        type: 'user',
        parent_tool_use_id: 'outer',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'child',
              content: 'actual output',
            },
          ],
        },
      },
      options({ kind: 'unknown' }),
    );
    expect(
      closedIds(real.messages).filter((id) => id === 'child'),
    ).toHaveLength(1);
    expect(
      real.messages
        .flatMap((message) => message.blocks)
        .find(
          (block) =>
            block.type === 'tool_result' && block.toolUseId === 'child',
        ),
    ).toMatchObject({ output: 'actual output' });
  },
);

it('does not duplicate a real child result after parent synthetic cancellation', () => {
  const closed = applyClaudeTranscriptEvent(
    state([tool('child', { parentToolUseId: 'outer' })]),
    { type: 'result' },
    options({ kind: 'no-live-session' }),
  );
  const real = applyClaudeTranscriptEvent(
    closed,
    {
      type: 'user',
      parent_tool_use_id: 'outer',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'child', content: 'real' },
        ],
      },
    },
    options({ kind: 'unknown' }),
  );
  expect(closedIds(real.messages)).toEqual(['child']);
});

it.each([
  undefined,
  null,
  [],
  {},
  { canopy_child_tool_liveness: null },
  { canopy_child_tool_liveness: { kind: 'future' } },
  {
    canopy_child_tool_liveness: {
      kind: 'known',
      liveParentToolUseIds: ['outer'],
    },
  },
  {
    canopy_child_tool_liveness: {
      kind: 'known',
      liveParentToolUseIds: [1],
      hasUncorrelatedLiveTask: false,
    },
  },
  {
    canopy_child_tool_liveness: {
      kind: 'known',
      liveParentToolUseIds: [],
      hasUncorrelatedLiveTask: 'false',
    },
  },
])('rejects absent or malformed stamps: %j', (event) => {
  expect(readChildToolLivenessStamp(event)).toBeUndefined();
});

it.each(cases)('reads a valid $label stamp', ({ liveness }) => {
  expect(
    readChildToolLivenessStamp({ canopy_child_tool_liveness: liveness }),
  ).toEqual(liveness);
});

it.each(terminals)(
  'malformed stamps on $name fall back to the option',
  ({ reduce, event }) => {
    const next = reduce(
      state([tool('root-tool'), tool('child', { parentToolUseId: 'outer' })]),
      {
        ...event,
        canopy_child_tool_liveness: { kind: 'known', liveParentToolUseIds: [] },
      },
      options({ kind: 'unknown' }),
    );
    expect(closedIds(next.messages)).toEqual(['root-tool']);
  },
);

it('does not settle tools on a continuing Claude session', () => {
  const next = applyClaudeTranscriptEvent(
    state([tool('root-tool'), tool('child', { parentToolUseId: 'outer' })]),
    { type: 'result', canopy_session_continues: true },
    options({ kind: 'no-live-session' }),
  );
  expect(closedIds(next.messages)).toEqual([]);
});

const codexEvents = [
  { type: 'thread.started', thread_id: 'root' },
  {
    type: 'item.started',
    thread_id: 'root',
    item: {
      type: 'command_execution',
      id: 'root-tool',
      command: 'pwd',
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    thread_id: 'root',
    item: {
      type: 'collab_agent_tool_call',
      id: 'spawn',
      tool: 'spawnAgent',
      status: 'completed',
      sender_thread_id: 'root',
      receiver_thread_ids: ['receiver'],
      agents_states: { receiver: { status: 'running' } },
    },
  },
  {
    type: 'item.started',
    thread_id: 'receiver',
    item: {
      type: 'command_execution',
      id: 'child',
      command: 'pwd',
      status: 'in_progress',
    },
  },
];

it('uses sdkSessionId as the root Codex thread and replays a stamped startup failure consistently', () => {
  const initial = codexEvents.reduce(
    (previous, event) =>
      applyCodexTranscriptEvent(previous, event, options({ kind: 'unknown' })),
    createEmptyTranscriptReducerState(),
  );
  expect(initial.sdkSessionId).toBe('root');
  expect(
    initial.messages.find((message) => message.id === 'codex-child'),
  ).toMatchObject({
    parentBlockId: 'codex-agent-spawn',
    codexThreadId: 'receiver',
  });
  const event = {
    type: 'result',
    subtype: 'codex_error',
    is_error: true,
    result: 'Failed',
    canopy_child_tool_liveness: { kind: 'unknown' },
  };
  const next = applyCodexTranscriptEvent(
    initial,
    event,
    options({ kind: 'no-live-session' }),
  );
  const replay = parseAgentTranscriptLines(
    [...codexEvents, event].map((frame) => JSON.stringify(frame)),
    'codex',
  );
  expect(closedIds(next.messages)).toEqual(['codex-root-tool']);
  expect(closedIds(replay.messages)).toEqual(closedIds(next.messages));
});

it('pairs a late Codex child completion with its synthetic cancellation only once', () => {
  const initial = codexEvents.reduce(
    (previous, event) =>
      applyCodexTranscriptEvent(previous, event, options({ kind: 'unknown' })),
    createEmptyTranscriptReducerState(),
  );
  const closed = applyCodexTranscriptEvent(
    initial,
    { type: 'result', subtype: 'codex_error', is_error: true },
    options({ kind: 'no-live-session' }),
  );
  const completed = applyCodexTranscriptEvent(
    closed,
    {
      type: 'item.completed',
      thread_id: 'receiver',
      item: {
        type: 'command_execution',
        id: 'child',
        command: 'pwd',
        status: 'completed',
        aggregated_output: 'real output',
        exit_code: 0,
      },
    },
    options({ kind: 'unknown' }),
  );
  expect(closedIds(completed.messages)).toEqual([
    'codex-child',
    'codex-root-tool',
  ]);
  expect(
    completed.messages
      .flatMap((message) => message.blocks)
      .find(
        (block) =>
          block.type === 'tool_result' && block.toolUseId === 'codex-child',
      ),
  ).toMatchObject({ output: 'real output' });
});

it('replays ended-child events without closing roots or unlisted siblings', () => {
  const events = [
    assistant('root-tool'),
    assistant('child', 'outer'),
    assistant('other', 'sibling'),
    { type: 'canopy_child_tools_ended', parent_tool_use_ids: ['outer'] },
  ];
  expect(
    closedIds(
      parseAgentTranscriptLines(
        events.map((frame) => JSON.stringify(frame)),
        'claude',
      ).messages,
    ),
  ).toEqual(['child']);
});

it.each(terminals)(
  'keeps unresolved Codex parents open with a known root on $name',
  ({ reduce, event }) => {
    const initial = state([
      tool('unresolved', {
        parentBlockId: 'missing',
        codexThreadId: 'receiver',
      }),
      tool('unlinked', { codexThreadId: 'receiver' }),
      tool('missing-receiver', { parentBlockId: 'missing' }),
    ]);
    expect(
      closedIds(
        reduce(
          initial,
          event,
          options({
            kind: 'known',
            liveParentToolUseIds: [],
            hasUncorrelatedLiveTask: false,
          }),
        ).messages,
      ),
    ).toEqual([]);
    expect(
      closedIds(
        reduce(initial, event, options({ kind: 'no-live-session' })).messages,
      ),
    ).toEqual(['unresolved', 'unlinked', 'missing-receiver']);
  },
);

it('closes only the terminal receiver of a multi-receiver Codex block', () => {
  const block: CodexAgentCallBlock = {
    type: 'codex_agent_call',
    agentBlockId: 'agent',
    callId: 'call',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'root',
    receiverThreadIds: ['live', 'ended'],
    prompt: '',
    agentsStates: {
      live: { status: 'running' },
      ended: { status: 'completed' },
    },
  };
  const initial = state([
    { id: 'agent', role: 'assistant', timestamp: 1, blocks: [block] },
    tool('live', { parentBlockId: 'agent', codexThreadId: 'live' }),
    tool('ended', { parentBlockId: 'agent', codexThreadId: 'ended' }),
    tool('unknown', { parentBlockId: 'agent', codexThreadId: 'unknown' }),
  ]);
  const next = applyCodexTranscriptEvent(
    initial,
    { type: 'result', subtype: 'codex_error', is_error: true },
    options({ kind: 'unknown' }),
  );
  expect(closedIds(next.messages)).toEqual(['ended']);
  expect(
    next.messages.find((message) =>
      message.blocks.some((block) => block.type === 'tool_result'),
    ),
  ).toMatchObject({ parentBlockId: 'agent', codexThreadId: 'ended' });
});
