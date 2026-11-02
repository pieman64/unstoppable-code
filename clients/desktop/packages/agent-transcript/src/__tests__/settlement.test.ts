import {
  persistedInterruptedSettlementTime,
  selectInterruptedSettlementTime,
  settledToolInterruption,
  supersedeToolInterruptions,
} from '../settlement';
import type { PersistedChatMessage } from '../types';

it.each([
  {
    activity: [150],
    runtimeActivityAt: 180,
    runtimeBelongsToTurn: true,
    expected: 180,
  },
  {
    activity: [180],
    runtimeActivityAt: 150,
    runtimeBelongsToTurn: true,
    expected: 180,
  },
  {
    activity: [150],
    runtimeActivityAt: 190,
    runtimeBelongsToTurn: false,
    expected: 150,
  },
  { activity: [NaN, Infinity, 300], expected: 100 },
  { activity: [50], expected: 100 },
  { activity: [180], completedAt: 130, expected: 130 },
])('selects historical settlement %#', ({ expected, ...input }) => {
  expect(
    selectInterruptedSettlementTime({
      detectedAt: 200,
      startedAt: 100,
      ...input,
    }),
  ).toBe(expected);
});

it('has deterministic malformed-clock fallback', () => {
  expect(
    selectInterruptedSettlementTime({
      detectedAt: NaN,
      activity: [Infinity, 100],
    }),
  ).toBe(0);
  expect(
    selectInterruptedSettlementTime({ detectedAt: 200, activity: [] }),
  ).toBe(200);
});

it('excludes synthetic settlement and subsequent resume activity', () => {
  const messages: PersistedChatMessage[] = [
    {
      id: 'original',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: 'work' }],
    },
    { id: 'work', role: 'assistant', timestamp: 150, blocks: [] },
    {
      id: 'archive-cancel-900-0',
      role: 'system',
      timestamp: 900,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 't',
          toolName: 'Edit',
          output: 'Interrupted by app restart',
          isError: true,
        },
      ],
    },
    {
      id: 'resume',
      role: 'user',
      timestamp: 950,
      blocks: [{ type: 'text', text: 'Continue' }],
    },
  ];
  expect(
    persistedInterruptedSettlementTime(messages, 1000, {
      activeTurn: { userMessageId: 'original', startedAt: 100 },
      lastActivityAt: 999,
    }),
  ).toBe(150);
});

it('only recognizes legacy settlement text on known synthetic carriers', () => {
  const block = {
    type: 'tool_result' as const,
    toolUseId: 't',
    toolName: 'Read',
    output: 'Cancelled',
    isError: false,
  };
  const message: PersistedChatMessage = {
    id: 'real',
    role: 'system',
    timestamp: 100,
    blocks: [block],
  };
  expect(settledToolInterruption(message, block)).toBeUndefined();
  expect(
    settledToolInterruption({ ...message, id: 'archive-cancel-100-0' }, block),
  ).toEqual({ reason: 'stopped', at: 100 });
});

it.each(['parentBlockId', 'parentToolUseId'] as const)(
  'keeps historical root activity and genuine results across a child user row with %s',
  (parentField) => {
    const messages: PersistedChatMessage[] = [
      {
        id: 'root',
        role: 'user',
        timestamp: 100,
        blocks: [{ type: 'text', text: 'Root work' }],
      },
      {
        id: 'call',
        role: 'assistant',
        timestamp: 150,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'edit',
            toolName: 'Edit',
            input: '{}',
          },
        ],
      },
      {
        id: 'child',
        role: 'user',
        timestamp: 200,
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
    expect(
      persistedInterruptedSettlementTime(messages, 1000, {
        activeTurn: { userMessageId: 'root', startedAt: 100 },
        lastActivityAt: 250,
      }),
    ).toBe(300);
    const interrupted: PersistedChatMessage = {
      id: 'archive-cancel-180-0',
      role: 'system',
      timestamp: 180,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'edit',
          toolName: 'Edit',
          output: 'Interrupted by app restart',
          isError: true,
          interruption: { reason: 'app_restart', at: 180 },
        },
      ],
    };
    expect(
      supersedeToolInterruptions([
        ...messages.slice(0, 2),
        interrupted,
        ...messages.slice(2),
      ]).find((message) => message.id === interrupted.id)?.blocks,
    ).toEqual([]);
    expect(
      supersedeToolInterruptions([
        messages[0],
        { ...messages[1], [parentField]: 'agent' },
        { ...interrupted, [parentField]: 'agent' },
        { ...messages[0], id: 'next-root', timestamp: 250 },
        { ...messages[3], [parentField]: 'agent' },
      ]).find((message) => message.id === interrupted.id)?.blocks,
    ).toEqual([]);
  },
);
