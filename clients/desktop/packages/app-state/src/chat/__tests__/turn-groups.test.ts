import type {
  PortalChatMessage,
  PortalChatPart,
  PortalChatToolFamily,
} from '@canopy/protocol/portal';
import {
  computeIncrementalTurnGroups,
  createEmptyTurnGroupCache,
  hasLiveTurnTimer,
  isTurnTimerMessage,
} from '../turn-groups';

function msg(
  partial: Partial<PortalChatMessage> &
    Pick<PortalChatMessage, 'messageId' | 'role'>,
): PortalChatMessage {
  return {
    chatId: 'c1',
    status: 'complete',
    text: '',
    createdAtMs: 0,
    ...partial,
  };
}

function toolPart(toolFamily: PortalChatToolFamily): PortalChatPart {
  return { kind: 'tool_use', toolFamily };
}

/** An `ExitPlanMode` tool call: the plan-mode turn's concluding content. */
function exitPlanModePart(): PortalChatPart {
  return {
    kind: 'tool_use',
    toolFamily: 'plan',
    data: {
      toolUseId: 't1',
      toolName: 'ExitPlanMode',
      input: JSON.stringify({ plan: '# Plan\n\nDo the thing.' }),
    },
  };
}

function timerPart(completedAt?: number): PortalChatPart {
  return {
    kind: 'turn_timer',
    data: {
      startedAt: 1,
      ...(completedAt !== undefined ? { completedAt } : {}),
    },
  };
}

describe('computeIncrementalTurnGroups', () => {
  it.each(['assistant', 'system'] as const)(
    'keeps a contextual error text part visible in a completed %s message',
    (role) => {
      const [group] = computeIncrementalTurnGroups(
        'c1',
        [
          msg({ messageId: 'u1', role: 'user', text: 'continue' }),
          msg({
            messageId: 'step',
            role: 'assistant',
            parts: [toolPart('read')],
          }),
          msg({
            messageId: 'error',
            role,
            parts: [
              {
                kind: 'text',
                data: {
                  text: 'API Error: 400 messages.4.content: Invalid input',
                  errorCode: 'claude_ai_credits_fallback_rejected',
                },
              },
            ],
          }),
        ],
        createEmptyTurnGroupCache(),
      );
      expect(group.finalMessageIds).toEqual(['error']);
      expect(group.intermediateMessageIds).toEqual(['step']);
    },
  );

  it('reports a streaming turn as incomplete', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'go' }),
        msg({
          messageId: 'a1',
          role: 'assistant',
          status: 'streaming',
          text: 'working',
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.complete).toBe(false);
  });

  it('keeps incomplete assistant messages in transcript order', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'go' }),
        msg({ messageId: 'answer', role: 'assistant', text: 'Checking.' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          status: 'streaming',
          parts: [toolPart('read')],
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect([...group.intermediateMessageIds, ...group.finalMessageIds]).toEqual(
      ['answer', 'tool'],
    );
  });

  it('completes a prior turn when a later user message follows an orphaned live timer', () => {
    const groups = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'first' }),
        msg({
          messageId: 'timer-1',
          role: 'system',
          status: 'streaming',
          parts: [timerPart()],
        }),
        msg({ messageId: 'u2', role: 'user', text: 'second' }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].complete).toBe(true);
    expect(groups[1].complete).toBe(true);
  });

  it('counts non-empty thinking and prose intermediates', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'thinking',
          role: 'assistant',
          parts: [
            { kind: 'thinking', data: { text: 'reasoning' } },
            { kind: 'thinking', data: { text: '   ' } },
          ],
        }),
        msg({ messageId: 'prose', role: 'assistant', text: 'Checking.' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({ messageId: 'answer', role: 'assistant', text: 'Done.' }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.summary).toEqual({
      thinkingCount: 1,
      messageCount: 1,
      readCount: 1,
    });
  });

  it('folds trailing tool-only messages after the final answer', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({ messageId: 'answer', role: 'assistant', text: 'Done.' }),
        msg({
          messageId: 'trailing-tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.finalMessageIds).toEqual(['answer']);
    expect(group.intermediateMessageIds).toEqual(['trailing-tool']);
    expect(group.expandedMessageIds).toEqual(['answer', 'trailing-tool']);
  });

  it('keeps consecutive final prose messages visible', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({
          messageId: 'answer-1',
          role: 'assistant',
          text: 'First conclusion.',
        }),
        msg({
          messageId: 'answer-2',
          role: 'assistant',
          text: 'Second conclusion.',
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.intermediateMessageIds).toEqual(['tool']);
    expect(group.finalMessageIds).toEqual(['answer-1', 'answer-2']);
  });

  it('keeps image and task-management messages adjacent to the final answer visible', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({
          messageId: 'image',
          role: 'assistant',
          parts: [{ kind: 'image' }],
        }),
        msg({
          messageId: 'task',
          role: 'assistant',
          parts: [
            {
              kind: 'tool_use',
              toolFamily: 'todo',
              data: { toolName: 'TaskUpdate' },
            },
          ],
        }),
        msg({ messageId: 'answer', role: 'assistant', text: 'Done.' }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.intermediateMessageIds).toEqual(['tool']);
    expect(group.finalMessageIds).toEqual(['image', 'task', 'answer']);
  });

  it('folds task-management messages when the turn has no final anchor', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({
          messageId: 'task',
          role: 'assistant',
          parts: [
            {
              kind: 'tool_use',
              toolFamily: 'todo',
              data: { toolName: 'TaskUpdate' },
            },
          ],
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.intermediateMessageIds).toEqual(['tool', 'task']);
    expect(group.finalMessageIds).toEqual([]);
  });

  it('keeps a system notice visible without promoting an adjacent task message', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({
          messageId: 'task',
          role: 'assistant',
          parts: [
            {
              kind: 'tool_use',
              toolFamily: 'todo',
              data: { toolName: 'TodoWrite' },
            },
          ],
        }),
        msg({
          messageId: 'notice',
          role: 'system',
          text: 'Context was reset.',
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.intermediateMessageIds).toEqual(['tool', 'task']);
    expect(group.finalMessageIds).toEqual(['notice']);
  });

  it('collapses trailing tools while keeping the answer and system error visible', () => {
    const messages = [
      msg({ messageId: 'u', role: 'user', text: 'Inspect' }),
      msg({
        messageId: 'answer',
        role: 'assistant',
        text: 'Checking the file.',
      }),
      msg({ messageId: 'tool', role: 'assistant', parts: [toolPart('read')] }),
      msg({
        messageId: 'error',
        role: 'system',
        text: 'Error: Session failed.',
      }),
    ];
    const [group] = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(group.finalMessageIds).toEqual(['answer', 'error']);
    expect(group.intermediateMessageIds).toEqual(['tool']);
    expect(group.summary).toMatchObject({ readCount: 1 });
  });

  it('keeps an account proxy switch visible alongside a completed answer', () => {
    const messages = [
      msg({ messageId: 'u', role: 'user', text: 'Add retries' }),
      msg({ messageId: 'first', role: 'assistant', text: 'Wrapping it.' }),
      msg({
        messageId: 'switch',
        role: 'system',
        parts: [
          {
            kind: 'account_switch',
            data: {
              occurredAt: 2,
              account: 'sam@example.com',
              previousAccount: 'ops@example.com',
              previousAtLimit: true,
            },
          },
        ],
      }),
      msg({ messageId: 'tool', role: 'assistant', parts: [toolPart('read')] }),
      msg({ messageId: 'answer', role: 'assistant', text: 'Done.' }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(groups[0].finalMessageIds).toEqual(['switch', 'answer']);
    expect(groups[0].intermediateMessageIds).toEqual(['first', 'tool']);
  });

  it('keeps system notices visible alongside a completed answer', () => {
    const messages = [
      msg({ messageId: 'u', role: 'user', text: 'Inspect' }),
      msg({ messageId: 'notice', role: 'system', text: 'Context was reset.' }),
      msg({ messageId: 'tool', role: 'assistant', parts: [toolPart('read')] }),
      msg({ messageId: 'answer', role: 'assistant', text: 'Done.' }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(groups[0].finalMessageIds).toEqual(['notice', 'answer']);
    expect(groups[0].intermediateMessageIds).toEqual(['tool']);
  });

  it('anchors the final segment on an ExitPlanMode plan when the turn has no text (CAN-3019)', () => {
    // Plan mode ends on a tool call, not prose: the ExitPlanMode message
    // carries the plan in its tool input and no `text` at all. Anchoring only
    // on text collapsed the entire turn behind the "N steps" chip, so a Remote
    // Control user who asked for a plan saw nothing but the step count.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'plan it', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 2,
        parts: [toolPart('bash')],
      }),
      msg({
        messageId: 'plan',
        role: 'assistant',
        createdAtMs: 3,
        parts: [exitPlanModePart()],
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].finalMessageIds).toEqual(['plan']);
    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
  });

  it("hides the plan's own denial tool_result behind the collapse (CAN-3019)", () => {
    // Canopy denies ExitPlanMode on purpose, so the provider emits a
    // "The user doesn't want to proceed with this tool use" result right after
    // the plan. Desktop routes it to `trailingToolMessages`, which the
    // collapsed turn never renders; anything after the plan anchor must stay
    // out of the final segment here too, or the web transcript tells the user
    // they rejected the plan they just wrote.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'plan it', createdAtMs: 1 }),
      msg({
        messageId: 'plan',
        role: 'assistant',
        createdAtMs: 2,
        parts: [exitPlanModePart()],
      }),
      msg({
        messageId: 'tool:deny',
        role: 'assistant',
        createdAtMs: 3,
        parts: [
          {
            kind: 'tool_result',
            data: {
              toolUseId: 't1',
              output: "The user doesn't want to proceed with this tool use.",
              isError: true,
            },
          },
        ],
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].finalMessageIds).toEqual(['plan']);
    expect(groups[0].intermediateMessageIds).toEqual(['tool:deny']);
  });

  it('keeps an ExitPlanMode message adjacent to the final answer visible', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 'plan',
        role: 'assistant',
        createdAtMs: 2,
        parts: [exitPlanModePart()],
      }),
      msg({
        messageId: 'answer',
        role: 'assistant',
        text: 'done',
        createdAtMs: 3,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].finalMessageIds).toEqual(['plan', 'answer']);
    expect(groups[0].intermediateMessageIds).toEqual([]);
  });

  it('stops the final-segment extension at a tool-only message after a plan', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 'plan',
        role: 'assistant',
        createdAtMs: 2,
        parts: [exitPlanModePart()],
      }),
      msg({
        messageId: 'tool',
        role: 'assistant',
        createdAtMs: 3,
        parts: [toolPart('read')],
      }),
      msg({
        messageId: 'answer',
        role: 'assistant',
        text: 'done',
        createdAtMs: 4,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].finalMessageIds).toEqual(['answer']);
    expect(groups[0].intermediateMessageIds).toEqual(['plan', 'tool']);
  });

  it('anchors a turn on the user message and treats the textual answer as final', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'hi', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: 'hello there',
        createdAtMs: 2,
      }),
    ];
    const cache = createEmptyTurnGroupCache();
    const groups = computeIncrementalTurnGroups('c1', messages, cache);

    expect(groups).toHaveLength(1);
    expect(groups[0].userMessageId).toBe('u1');
    expect(groups[0].intermediateMessageIds).toEqual([]);
    expect(groups[0].finalMessageIds).toEqual(['a1']);
    expect(groups[0].summary).toBeUndefined();
  });

  it('omits the summary for a streaming turn with no intermediate messages', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'hi', createdAtMs: 1 }),
        msg({
          messageId: 'answer',
          role: 'assistant',
          status: 'streaming',
          text: 'hello',
          createdAtMs: 2,
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.complete).toBe(false);
    expect(group.intermediateMessageIds).toEqual([]);
    expect(group.summary).toBeUndefined();
  });

  it('omits the summary when streaming hides settled intermediates', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'inspect' }),
        msg({
          messageId: 'tool',
          role: 'assistant',
          parts: [toolPart('read')],
        }),
        msg({
          messageId: 'answer',
          role: 'assistant',
          status: 'streaming',
          text: 'Still working',
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(group.complete).toBe(false);
    expect(group.intermediateMessageIds).toEqual([]);
    expect(group.summary).toBeUndefined();
  });

  it('splits tool-only steps into intermediate and tallies a summary', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'do it', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [toolPart('bash'), toolPart('bash'), toolPart('read')],
        createdAtMs: 2,
      }),
      msg({
        messageId: 'a2',
        role: 'assistant',
        text: 'done',
        createdAtMs: 3,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
    expect(groups[0].finalMessageIds).toEqual(['a2']);
    expect(groups[0].summary).toEqual({ bashCount: 2, readCount: 1 });
  });

  it('counts agent parts as agents', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'do it', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [{ kind: 'agent', data: {} }, toolPart('read')],
        createdAtMs: 2,
      }),
      msg({
        messageId: 'a2',
        role: 'assistant',
        text: 'done',
        createdAtMs: 3,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
    expect(groups[0].finalMessageIds).toEqual(['a2']);
    expect(groups[0].summary).toEqual({ agentCount: 1, readCount: 1 });
  });

  it('maps unmapped tool families into otherCount', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'x', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [toolPart('skill'), toolPart('monitor')],
        createdAtMs: 2,
      }),
      msg({ messageId: 'a2', role: 'assistant', text: 'ok', createdAtMs: 3 }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(groups[0].summary).toEqual({ otherCount: 2 });
  });

  it('keeps Computer Use calls in their dedicated summary bucket', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'x', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [toolPart('computer-use'), toolPart('computer-use')],
        createdAtMs: 2,
      }),
      msg({ messageId: 'a2', role: 'assistant', text: 'ok', createdAtMs: 3 }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(groups[0].summary).toEqual({ computerUseCount: 2 });
  });

  it('treats a turn with no textual answer as entirely intermediate', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'x', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [toolPart('bash')],
        createdAtMs: 2,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
    expect(groups[0].finalMessageIds).toEqual([]);
  });

  it('preserves the object reference of a completed group across an unrelated streaming update', () => {
    const cache = createEmptyTurnGroupCache();
    const turn1: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'first', createdAtMs: 1 }),
      msg({ messageId: 'a1', role: 'assistant', text: 'done', createdAtMs: 2 }),
    ];
    const firstPass = computeIncrementalTurnGroups('c1', turn1, cache);
    const completedGroup = firstPass[0];

    // A new, still-streaming turn arrives; the settled first turn is unchanged.
    const turn2: PortalChatMessage[] = [
      ...turn1,
      msg({ messageId: 'u2', role: 'user', text: 'second', createdAtMs: 3 }),
      msg({
        messageId: 'a2',
        role: 'assistant',
        text: 'thinking',
        status: 'streaming',
        createdAtMs: 4,
      }),
    ];
    const secondPass = computeIncrementalTurnGroups('c1', turn2, cache);

    expect(secondPass).toHaveLength(2);
    expect(secondPass[0]).toBe(completedGroup); // reused by reference
  });

  it('does not reuse a streaming turn group by reference', () => {
    const cache = createEmptyTurnGroupCache();
    const streaming: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'x', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: 'partial',
        status: 'streaming',
        createdAtMs: 2,
      }),
    ];
    const first = computeIncrementalTurnGroups('c1', streaming, cache);
    const second = computeIncrementalTurnGroups('c1', streaming, cache);
    expect(second[0]).not.toBe(first[0]);
  });

  it('floats a completed turn timer after the final answer and out of the summary', () => {
    // The timer's createdAtMs is pinned to the turn start, so it arrives
    // before the assistant messages in transcript order.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 't1',
        role: 'system',
        parts: [timerPart(9)],
        createdAtMs: 1,
      }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: '',
        parts: [toolPart('bash')],
        createdAtMs: 2,
      }),
      msg({ messageId: 'a2', role: 'assistant', text: 'done', createdAtMs: 3 }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
    expect(groups[0].finalMessageIds).toEqual(['a2', 't1']);
    expect(groups[0].summary).toEqual({ bashCount: 1 });
  });

  it('floats a live timer to the end and keeps the turn uncached', () => {
    const cache = createEmptyTurnGroupCache();
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 't1',
        role: 'system',
        status: 'streaming',
        parts: [timerPart()],
        createdAtMs: 1,
      }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        text: 'so far',
        createdAtMs: 2,
      }),
    ];
    const first = computeIncrementalTurnGroups('c1', messages, cache);
    const second = computeIncrementalTurnGroups('c1', messages, cache);

    expect(first[0].finalMessageIds).toEqual(['a1', 't1']);
    expect(second[0]).not.toBe(first[0]); // live timer → turn stays uncached
  });

  it('reuses a completed group containing a timer by reference across recomputes', () => {
    const cache = createEmptyTurnGroupCache();
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 't1',
        role: 'system',
        parts: [timerPart(9)],
        createdAtMs: 1,
      }),
      msg({ messageId: 'a1', role: 'assistant', text: 'done', createdAtMs: 2 }),
    ];
    const first = computeIncrementalTurnGroups('c1', messages, cache);
    const second = computeIncrementalTurnGroups('c1', messages, cache);

    expect(second[0]).toBe(first[0]);
  });

  it('does not float a mixed-part system message', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 's1',
        role: 'system',
        parts: [timerPart(9), toolPart('bash')],
        createdAtMs: 1,
      }),
      msg({ messageId: 'a1', role: 'assistant', text: 'done', createdAtMs: 2 }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    // Not timer-only → treated as an ordinary assistant-side message.
    expect(groups[0].intermediateMessageIds).toEqual(['s1']);
    expect(groups[0].finalMessageIds).toEqual(['a1']);
  });

  it('invalidates the cache when the chat id changes', () => {
    const cache = createEmptyTurnGroupCache();
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'x', createdAtMs: 1 }),
      msg({ messageId: 'a1', role: 'assistant', text: 'y', createdAtMs: 2 }),
    ];
    const a = computeIncrementalTurnGroups('c1', messages, cache);
    const b = computeIncrementalTurnGroups('c2', messages, cache);
    expect(b[0]).not.toBe(a[0]);
    expect(cache.chatId).toBe('c2');
  });
});

describe('isTurnTimerMessage', () => {
  it('matches only timer-only system messages', () => {
    const timerOnly = msg({
      messageId: 's1',
      role: 'system',
      parts: [timerPart()],
    });
    const mixed = msg({
      messageId: 's2',
      role: 'system',
      parts: [timerPart(), toolPart('bash')],
    });
    const assistantTimer = msg({
      messageId: 'a1',
      role: 'assistant',
      parts: [timerPart()],
    });
    const empty = msg({ messageId: 's3', role: 'system', parts: [] });

    expect(isTurnTimerMessage(timerOnly)).toBe(true);
    expect(isTurnTimerMessage(mixed)).toBe(false);
    expect(isTurnTimerMessage(assistantTimer)).toBe(false);
    expect(isTurnTimerMessage(empty)).toBe(false);
  });
});

describe('hasLiveTurnTimer', () => {
  const liveTimer = (id: string): PortalChatMessage =>
    msg({
      messageId: id,
      role: 'system',
      status: 'streaming',
      parts: [timerPart()],
    });

  it('detects a live streaming timer in the current turn', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      liveTimer('t1'),
    ];
    expect(hasLiveTurnTimer(messages)).toBe(true);
  });

  it('ignores an orphaned timer from an interrupted earlier turn', () => {
    // A mid-turn client dispose() never settles open turns, leaving
    // completedAt unset forever. That orphan must not suppress the next
    // turn's send→timer-gap fallback spinner.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'first', createdAtMs: 1 }),
      liveTimer('t-orphan'),
      msg({ messageId: 'u2', role: 'user', text: 'second', createdAtMs: 5 }),
    ];
    expect(hasLiveTurnTimer(messages)).toBe(false);
  });

  it('ignores a current-turn timer whose message is no longer streaming', () => {
    // Mirrors the store's openTimer liveness rule: a settled or repaired
    // timer frame is not "working" even if completedAt never landed.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 't1',
        role: 'system',
        status: 'complete',
        parts: [timerPart()],
      }),
    ];
    expect(hasLiveTurnTimer(messages)).toBe(false);
  });

  it('ignores a completed timer and mixed-part system messages', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({
        messageId: 't1',
        role: 'system',
        status: 'streaming',
        parts: [timerPart(9)],
      }),
      msg({
        messageId: 's1',
        role: 'system',
        status: 'streaming',
        parts: [timerPart(), toolPart('bash')],
      }),
    ];
    expect(hasLiveTurnTimer(messages)).toBe(false);
  });
});
