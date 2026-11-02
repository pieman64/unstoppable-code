import type {
  PortalChatMessage,
  PortalChatPart,
  PortalChatToolFamily,
} from '@canopy/protocol/portal';
import {
  computeIncrementalTurnGroups,
  computePortalTurnOutcomes,
  createEmptyTurnGroupCache,
  getPortalTurnOutcomeSteps,
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
  it.each([false, true])(
    'excludes canonical plan writes from completed Portal fallback summaries (failed: %s, CAN-5355)',
    (failed) => {
      const parts: PortalChatPart[] = [
        ...[
          '/Users/test/.claude/plans/draft.md',
          'C:\\Users\\test\\.claude\\plans\\draft.md',
          'docs/plans/draft.md',
        ].map(
          (file_path, i): PortalChatPart => ({
            kind: 'tool_use',
            toolFamily: 'write',
            data: {
              toolUseId: `w${i}`,
              toolName: 'Write',
              input: i === 0 ? { file_path } : JSON.stringify({ file_path }),
              result: {
                output: failed ? 'EACCES' : 'Written',
                isError: failed,
              },
            },
          }),
        ),
        {
          kind: 'tool_use',
          toolFamily: 'edit',
          data: {
            toolUseId: 'edit',
            toolName: 'Edit',
            input: '{"file_path":"src/index.ts"}',
          },
        },
        {
          kind: 'tool_use',
          toolFamily: 'plan',
          data: {
            toolUseId: 'exit',
            toolName: 'ExitPlanMode',
            input: '{}',
            result: { output: 'canopy_plan_handoff', isError: true },
          },
        },
      ];
      const rows = [
        msg({ messageId: 'u', role: 'user', text: 'Plan' }),
        msg({
          messageId: 'tools',
          role: 'assistant',
          parts: parts.slice(0, -1),
        }),
        msg({
          messageId: 'handoff',
          role: 'assistant',
          parts: parts.slice(-1),
        }),
        msg({ messageId: 'final', role: 'assistant', text: 'Done' }),
      ];
      const [group] = computeIncrementalTurnGroups(
        'c1',
        rows,
        createEmptyTurnGroupCache(),
      );
      expect(group.summary).toEqual({ writeCount: 1, editCount: 1 });
      expect(computePortalTurnOutcomes([rows[1], rows[2]])).toMatchObject({
        failed: failed ? 3 : 0,
      });
    },
  );

  it('keeps child-directed continuesTurn input and interrupted tools in the original recovery turn', () => {
    const rows = [
      msg({ messageId: 'original', role: 'user', text: 'Read and edit' }),
      msg({ messageId: 'timer', role: 'system', parts: [timerPart(14000)] }),
      msg({
        messageId: 'read',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            toolFamily: 'read',
            data: {
              toolUseId: 'read',
              toolName: 'Read',
              result: { isError: false, output: 'ok' },
            },
          },
        ],
      }),
      msg({
        messageId: 'child',
        role: 'user',
        continuesTurn: true,
        text: 'Background follow-up',
      }),
      msg({
        messageId: 'edit',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            toolFamily: 'edit',
            data: {
              toolUseId: 'edit',
              toolName: 'Edit',
              result: {
                isError: true,
                output: 'Interrupted',
                interruption: { reason: 'app_restart', at: 14000 },
              },
            },
          },
        ],
      }),
      msg({ messageId: 'resume', role: 'user', text: 'Continue' }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      rows,
      createEmptyTurnGroupCache(),
    );
    expect(groups.map((group) => group.userMessageId)).toEqual([
      'original',
      'resume',
    ]);
    expect(groups[0].summary).toMatchObject({ readCount: 1, editCount: 1 });
    const counted = rows.filter((row) =>
      groups[0].intermediateMessageIds.includes(row.messageId),
    );
    expect(computePortalTurnOutcomes(counted, rows)).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 1,
    });
  });

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

  it('keeps a Codex account model notice row visible (CAN-4716)', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'Fix the build' }),
        msg({
          messageId: 'error',
          role: 'system',
          parts: [
            {
              kind: 'text',
              data: {
                text: "Error: The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
                modelAccessFailure: {
                  kind: 'model_unsupported',
                  model: 'gpt-6.1-sol',
                  modelLabel: '6.1 Sol',
                },
              },
            },
          ],
        }),
      ],
      createEmptyTurnGroupCache(),
    );
    expect(group.finalMessageIds).toEqual(['error']);
  });

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

  it("shows a failed turn's error once when its saved Error row also arrives", () => {
    // The live failed frame and the saved `Error: …` row are one failure
    // under two ids; a history merge keeps both.
    const error = 'The Cursor version check exited before it completed.';
    const messages = [
      msg({ messageId: 'u1', role: 'user', text: 'Hi' }),
      msg({
        messageId: 'c1:c1:u1:provider:initial:1:0',
        role: 'system',
        text: `Error: ${error}`,
      }),
      msg({
        messageId: 'u1:assistant',
        role: 'assistant',
        status: 'failed',
        text: error,
      }),
      msg({ messageId: 'u1:timer', role: 'system', parts: [timerPart(2)] }),
      msg({ messageId: 'u2', role: 'user', text: 'Again' }),
      msg({
        messageId: 'c1:c1:u2:provider:initial:1:0',
        role: 'system',
        text: `Error: ${error}`,
      }),
    ];
    const [failed, other] = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(failed.finalMessageIds).toEqual(['u1:assistant', 'u1:timer']);
    expect(failed.expandedMessageIds).toEqual(['u1:assistant', 'u1:timer']);
    expect(failed.intermediateMessageIds).toEqual([]);
    // Without a failed message in its turn, the Error row is the only copy.
    expect(other.finalMessageIds).toEqual(['c1:c1:u2:provider:initial:1:0']);
  });

  it('drops the saved Error row when it arrives after the failed message', () => {
    const [group] = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'Hi' }),
        msg({
          messageId: 'u1:assistant',
          role: 'assistant',
          status: 'failed',
          text: 'Disk full.',
        }),
        msg({ messageId: 'saved', role: 'system', text: 'Error: Disk full.' }),
      ],
      createEmptyTurnGroupCache(),
    );
    expect(group.finalMessageIds).toEqual(['u1:assistant']);
  });

  it('keeps a saved Error row that has parts or names another failure', () => {
    const messages = [
      msg({ messageId: 'u1', role: 'user', text: 'Hi' }),
      msg({
        messageId: 'action',
        role: 'system',
        text: 'Error: Sign in again.',
        parts: [{ kind: 'text', data: { text: 'Error: Sign in again.' } }],
      }),
      msg({ messageId: 'other', role: 'system', text: 'Error: Disk full.' }),
      msg({
        messageId: 'u1:assistant',
        role: 'assistant',
        status: 'failed',
        text: 'Sign in again.',
      }),
    ];
    const [group] = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );
    expect(group.finalMessageIds).toEqual(['action', 'other', 'u1:assistant']);
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

  it("places a canonical timer in its anchor's turn, not where it was appended", () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'go', createdAtMs: 1 }),
      msg({ messageId: 'a1', role: 'assistant', text: 'done', createdAtMs: 2 }),
      msg({ messageId: 'u2', role: 'user', text: 'again', createdAtMs: 3 }),
      msg({ messageId: 'a2', role: 'assistant', text: 'ok', createdAtMs: 4 }),
      msg({
        messageId: 't1',
        role: 'system',
        parts: [
          {
            kind: 'turn_timer',
            data: { turnId: 'turn-1', userMessageId: 'u1', completedAt: 9 },
          },
        ],
        createdAtMs: 5,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups[0].finalMessageIds).toEqual(['a1', 't1']);
    expect(groups[1].finalMessageIds).toEqual(['a2']);
  });

  it('gives a wake its own turn, named from the call that started its task (turn-state phase 40e)', () => {
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'run tests', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            toolFamily: 'bash',
            data: {
              toolUseId: 'tool-1',
              toolName: 'Bash',
              input: { command: 'npm test', description: 'Run the tests' },
            },
          },
        ],
        createdAtMs: 2,
      }),
      msg({
        messageId: 't1',
        role: 'system',
        parts: [
          {
            kind: 'turn_timer',
            data: { turnId: 'turn-1', userMessageId: 'u1', completedAt: 3 },
          },
        ],
        createdAtMs: 1,
      }),
      msg({
        messageId: 'tw',
        role: 'system',
        status: 'streaming',
        parts: [
          {
            kind: 'turn_timer',
            data: {
              turnId: 'wake',
              spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1' },
              completedAt: null,
            },
          },
        ],
        createdAtMs: 4,
      }),
      msg({
        messageId: 'a-wake',
        role: 'assistant',
        status: 'streaming',
        text: 'The tests passed.',
        createdAtMs: 5,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups.map((group) => group.userMessageId)).toEqual(['u1', 'tw']);
    expect(groups[0]).toMatchObject({ complete: true });
    // The prompt's tool call is its own step; its timer closes it.
    expect(groups[0].intermediateMessageIds).toEqual(['a1']);
    expect(groups[0].finalMessageIds).toEqual(['t1']);
    expect(groups[1]).toMatchObject({
      complete: false,
      wake: { taskLabel: 'Run the tests', spawningUserMessageId: 'u1' },
      finalMessageIds: ['a-wake', 'tw'],
    });
    expect(groups[0]).not.toHaveProperty('wake');
  });

  it("names an event wake's spawning call and marks it an event", () => {
    const wakeTimer = (
      messageId: string,
      spawnedBy: Record<string, unknown>,
    ): PortalChatMessage =>
      msg({
        messageId,
        role: 'system',
        parts: [
          {
            kind: 'turn_timer',
            data: { turnId: messageId, spawnedBy, completedAt: 9 },
          },
        ],
        createdAtMs: 4,
      });
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'watch it', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'tool-monitor',
              toolName: 'Monitor',
              input: { command: 'tail -f x', description: 'build log errors' },
            },
          },
        ],
        createdAtMs: 2,
      }),
      wakeTimer('tw-event', {
        taskId: 'task-1',
        toolUseId: 'tool-monitor',
        event: true,
      }),
      wakeTimer('tw-missing', { taskId: 'task-2', toolUseId: 'missing' }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups.map((group) => [group.userMessageId, group.wake])).toEqual([
      ['u1', undefined],
      [
        'tw-event',
        {
          taskLabel: 'build log errors',
          spawningUserMessageId: 'u1',
          spawningToolUseId: 'tool-monitor',
          event: true,
        },
      ],
      ['tw-missing', {}],
    ]);
  });

  it('heads a cron fire with its own turn, named from the scheduled prompt', () => {
    const messages: PortalChatMessage[] = [
      msg({
        messageId: 'u1',
        role: 'user',
        text: 'schedule it',
        createdAtMs: 1,
      }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'tool-cron',
              toolName: 'CronCreate',
              input: { cron: '0 9 * * *', prompt: 'Check the deploy' },
            },
          },
        ],
        createdAtMs: 2,
      }),
      msg({
        messageId: 'tw-cron',
        role: 'system',
        parts: [
          {
            kind: 'turn_timer',
            data: {
              turnId: 'tw-cron',
              spawnedBy: { toolUseId: 'tool-cron', scheduled: true },
              completedAt: 9,
            },
          },
        ],
        createdAtMs: 4,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups.map((group) => [group.userMessageId, group.wake])).toEqual([
      ['u1', undefined],
      [
        'tw-cron',
        {
          taskLabel: 'Check the deploy',
          spawningUserMessageId: 'u1',
          spawningToolUseId: 'tool-cron',
          scheduled: true,
        },
      ],
    ]);
  });

  it("heads a tools-loaded continuation with its own turn, though it shares the prompt's anchor", () => {
    const timer = (
      messageId: string,
      data: Record<string, unknown>,
      status: PortalChatMessage['status'] = 'complete',
    ): PortalChatMessage =>
      msg({
        messageId,
        role: 'system',
        status,
        parts: [{ kind: 'turn_timer', data: { startedAt: 1, ...data } }],
      });
    // Storage order: each execution's timer is appended when it opens.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'load Slack' }),
      timer('t1', { turnId: 'turn-1', userMessageId: 'u1', completedAt: 2 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'tool-load',
              toolName: 'mcp__canopy__LoadDeferredTools',
              input: { items: [{ ref: 'deferred:v1:slack' }] },
            },
          },
        ],
      }),
      timer(
        't-resume',
        {
          turnId: 'resume-turn',
          userMessageId: 'u1',
          spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
        },
        'streaming',
      ),
      msg({ messageId: 'a-resume', role: 'assistant', text: 'Loaded.' }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
      true,
    );

    expect(
      groups.map((group) => [
        group.userMessageId,
        group.wake,
        [...group.intermediateMessageIds, ...group.finalMessageIds],
      ]),
    ).toEqual([
      ['u1', undefined, ['a1', 't1']],
      [
        't-resume',
        {
          spawningUserMessageId: 'u1',
          spawningToolUseId: 'tool-load',
          toolsLoaded: true,
        },
        ['a-resume', 't-resume'],
      ],
    ]);
  });

  it('keeps a resumed execution of a tools-loaded continuation in the continuation turn', () => {
    const timer = (
      messageId: string,
      data: Record<string, unknown>,
    ): PortalChatMessage =>
      msg({
        messageId,
        role: 'system',
        parts: [{ kind: 'turn_timer', data: { startedAt: 1, ...data } }],
      });
    const groups = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'load Slack' }),
        timer('t1', { turnId: 'turn-1', userMessageId: 'u1', completedAt: 2 }),
        timer('t-resume', {
          turnId: 'resume-turn',
          userMessageId: 'u1',
          spawnedBy: { toolUseId: 'tool-load', toolsLoaded: true },
          completedAt: 3,
        }),
        msg({ messageId: 'a-stopped', role: 'assistant', text: 'Working' }),
        timer('t-again', { turnId: 'again-turn', userMessageId: 'u1' }),
        msg({ messageId: 'a-again', role: 'assistant', text: 'Done.' }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(
      groups.map((group) => [
        group.userMessageId,
        [...group.intermediateMessageIds, ...group.finalMessageIds],
      ]),
    ).toEqual([
      ['u1', ['t1']],
      ['t-resume', ['a-stopped', 'a-again', 't-resume', 't-again']],
    ]);
  });

  it("links a tools-loaded continuation to its prompt when the load call's id is not the transcript's", () => {
    const groups = computeIncrementalTurnGroups(
      'c1',
      [
        msg({ messageId: 'u1', role: 'user', text: 'load Slack' }),
        msg({
          messageId: 't-resume',
          role: 'system',
          parts: [
            {
              kind: 'turn_timer',
              data: {
                turnId: 'resume-turn',
                userMessageId: 'u1',
                spawnedBy: { toolUseId: '3', toolsLoaded: true },
                completedAt: 9,
              },
            },
          ],
        }),
      ],
      createEmptyTurnGroupCache(),
    );

    expect(groups.map((group) => [group.userMessageId, group.wake])).toEqual([
      ['u1', undefined],
      ['t-resume', { spawningUserMessageId: 'u1', toolsLoaded: true }],
    ]);
  });

  it('reads a wake cause the Portal event stream delivers as a JSON string', () => {
    // The Portal's event stream flattens nested part data to strings.
    const messages: PortalChatMessage[] = [
      msg({ messageId: 'u1', role: 'user', text: 'watch it', createdAtMs: 1 }),
      msg({
        messageId: 'a1',
        role: 'assistant',
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'tool-monitor',
              toolName: 'Monitor',
              input: JSON.stringify({ description: 'build log errors' }),
            },
          },
        ],
        createdAtMs: 2,
      }),
      msg({
        messageId: 'tw-event',
        role: 'system',
        parts: [
          {
            kind: 'turn_timer',
            data: {
              turnId: 'tw-event',
              pausedAt: 'undefined',
              spawnedBy: JSON.stringify({
                taskId: 'task-1',
                toolUseId: 'tool-monitor',
                event: true,
              }),
              completedAt: 9,
            },
          },
        ],
        createdAtMs: 4,
      }),
    ];
    const groups = computeIncrementalTurnGroups(
      'c1',
      messages,
      createEmptyTurnGroupCache(),
    );

    expect(groups.map((group) => [group.userMessageId, group.wake])).toEqual([
      ['u1', undefined],
      [
        'tw-event',
        {
          taskLabel: 'build log errors',
          spawningUserMessageId: 'u1',
          spawningToolUseId: 'tool-monitor',
          event: true,
        },
      ],
    ]);
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

describe('computePortalTurnOutcomes (CAN-4810)', () => {
  it('separates interrupted results, retains metadata, and gates resultless fallback on complete settlement', () => {
    const interruption = { reason: 'app_restart', at: 14 };
    const counted = [
      steps([
        call(
          'interrupted',
          JSON.stringify({
            isError: true,
            output: 'Interrupted',
            interruption,
          }),
        ),
        call('neutral', { isError: false, interruption }),
        call('error', { isError: true, output: 'real error' }),
        call('pending'),
      ]),
    ];
    expect(computePortalTurnOutcomes(counted)).toEqual({
      blocked: 0,
      failed: 1,
      interrupted: 2,
    });
    expect(getPortalTurnOutcomeSteps(counted)).toEqual([
      expect.objectContaining({
        toolUseId: 'interrupted',
        outcome: 'interrupted',
        interruption,
      }),
      expect.objectContaining({
        toolUseId: 'neutral',
        outcome: 'interrupted',
        interruption,
      }),
      expect.objectContaining({ toolUseId: 'error', outcome: 'failed' }),
    ]);
    for (const evidence of [
      { settled: false, resultsComplete: true },
      { settled: true, resultsComplete: false },
    ])
      expect(
        computePortalTurnOutcomes(counted, counted, evidence).interrupted,
      ).toBe(2);
    const evidence = { settled: true, resultsComplete: true };
    expect(
      computePortalTurnOutcomes(counted, counted, evidence).interrupted,
    ).toBe(3);
    expect(
      getPortalTurnOutcomeSteps(counted, counted, evidence).at(-1),
    ).toMatchObject({ toolUseId: 'pending', outcome: 'interrupted' });
    const realResult = steps([result('pending', false)], 'result');
    expect(
      computePortalTurnOutcomes(counted, [...counted, realResult], evidence)
        .interrupted,
    ).toBe(2);
  });
  it.each([
    { settled: false, resultsComplete: true, count: 0 },
    { settled: true, resultsComplete: false, count: 0 },
    { settled: true, resultsComplete: true, count: 1 },
  ])(
    'classifies resultless calls without IDs with settlement/completeness $settled/$resultsComplete',
    ({ settled, resultsComplete, count }) => {
      const counted = [
        steps([
          { kind: 'tool_use', data: { toolName: 'Bash', input: '{}' } },
          {
            kind: 'tool_use',
            data: {
              toolName: 'Read',
              result: { output: 'done', isError: false },
            },
          },
        ]),
      ];
      expect(
        computePortalTurnOutcomes(counted, counted, {
          settled,
          resultsComplete,
        }),
      ).toEqual({ interrupted: count, failed: 0, blocked: 0 });
    },
  );

  const call = (
    toolUseId: string,
    result?: unknown,
    toolName = 'Bash',
  ): PortalChatPart => ({
    kind: 'tool_use',
    toolFamily: 'bash',
    data: {
      toolUseId,
      toolName,
      input: '{}',
      ...(result === undefined ? {} : { result }),
    },
  });
  const result = (toolUseId: string, isError: boolean): PortalChatPart => ({
    kind: 'tool_result',
    data: { toolUseId, output: 'fixture', isError },
  });
  const steps = (parts: PortalChatPart[], id = 'a1'): PortalChatMessage =>
    msg({ messageId: id, role: 'assistant', parts });

  it('counts a failed call once and never reports a blocked step', () => {
    expect(
      computePortalTurnOutcomes([
        steps([
          call('ok', { output: 'done', isError: false }),
          call('bad', { output: 'denied', isError: true }),
          call('bad', { output: 'denied', isError: true }),
        ]),
      ]),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
  });

  it('reads persisted JSON results', () => {
    expect(
      computePortalTurnOutcomes([
        steps([call('bad', JSON.stringify({ output: 'x', isError: true }))]),
      ]),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
  });

  it('keeps a newer folded result authoritative over an earlier carried result', () => {
    const older = steps([call('retry'), result('retry', true)], 'older');
    const newer = steps([call('retry', { isError: false })], 'newer');
    expect(computePortalTurnOutcomes([older, newer])).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
  });

  it('deduplicates repeated carried results and ignores unreadable results', () => {
    expect(
      computePortalTurnOutcomes([
        steps([call('bad'), call('pending', 'unreadable')]),
        steps([result('bad', true), result('bad', true)], 'results'),
      ]),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
  });

  it('matches results carried on other messages, including trailing ones', () => {
    const counted = [steps([call('late'), call('ok')])];
    const final = steps([result('late', true), result('ok', false)], 'a2');
    expect(computePortalTurnOutcomes(counted)).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
    expect(computePortalTurnOutcomes(counted, [...counted, final])).toEqual({
      blocked: 0,
      failed: 1,
      interrupted: 0,
    });
  });

  it('ignores unassociated results, pending calls and plan-mode errors', () => {
    expect(
      computePortalTurnOutcomes([
        steps([
          call('pending'),
          call('plan', { output: 'rejected', isError: true }, 'ExitPlanMode'),
          call('enter', { output: 'rejected', isError: true }, 'EnterPlanMode'),
          result('orphan', true),
          result('plan', true),
        ]),
      ]),
    ).toEqual({ blocked: 0, failed: 0, interrupted: 0 });
  });

  it('does not count failures from another turn', () => {
    const counted = [steps([call('mine')])];
    const otherTurn = steps([result('theirs', true)], 'b1');
    expect(computePortalTurnOutcomes(counted, [...counted, otherTurn])).toEqual(
      { blocked: 0, failed: 0, interrupted: 0 },
    );
  });

  describe('getPortalTurnOutcomeSteps', () => {
    it('lists failed calls in transcript order with their display call and output', () => {
      const counted = [
        steps([
          call('ok', { output: 'done', isError: false }),
          {
            kind: 'tool_use',
            toolFamily: 'read',
            data: {
              toolUseId: 'read',
              toolName: 'Read',
              input: { file_path: 'absent.txt' },
            },
          },
          call('bash', {
            output: 'Exit code 1\nzsh: no matches found',
            isError: true,
          }),
          call('anonymous-free', { output: 'oops', isError: true }, 'Grep'),
        ]),
      ];
      const trailing = steps(
        [
          {
            kind: 'tool_result',
            data: {
              toolUseId: 'read',
              output: 'Failed to read file',
              isError: true,
            },
          },
        ],
        'a2',
      );
      const all = [...counted, trailing];

      expect(getPortalTurnOutcomeSteps(counted, all)).toEqual([
        {
          toolUseId: 'read',
          outcome: 'failed',
          toolName: 'Read',
          input: '{"file_path":"absent.txt"}',
          output: 'Failed to read file',
        },
        {
          toolUseId: 'bash',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{}',
          output: 'Exit code 1\nzsh: no matches found',
        },
        {
          toolUseId: 'anonymous-free',
          outcome: 'failed',
          toolName: 'Grep',
          input: '{}',
          output: 'oops',
        },
      ]);
      expect(computePortalTurnOutcomes(counted, all)).toEqual({
        blocked: 0,
        failed: 3,
        interrupted: 0,
      });
    });

    it('lets the latest result win, reading persisted JSON and content text', () => {
      const recovered = [
        steps([call('retry'), result('retry', true)], 'older'),
        steps([call('retry', { isError: false })], 'newer'),
      ];
      expect(getPortalTurnOutcomeSteps(recovered)).toEqual([]);

      const regressed = [
        steps([
          call('flaky', { output: 'fine', isError: false }),
          call(
            'persisted',
            JSON.stringify({ content: 'denied by hook', isError: true }),
          ),
          result('flaky', true),
        ]),
      ];
      expect(getPortalTurnOutcomeSteps(regressed)).toEqual([
        {
          toolUseId: 'flaky',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{}',
          output: 'fixture',
        },
        {
          toolUseId: 'persisted',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{}',
          output: 'denied by hook',
        },
      ]);
    });

    it('counts but does not list a failed call without an id', () => {
      const counted = [
        steps([
          {
            kind: 'tool_use',
            toolFamily: 'bash',
            data: { toolName: 'Bash', result: { output: 'x', isError: true } },
          },
        ]),
      ];
      expect(computePortalTurnOutcomes(counted)).toEqual({
        blocked: 0,
        failed: 1,
        interrupted: 0,
      });
      expect(getPortalTurnOutcomeSteps(counted)).toEqual([]);
    });

    it('omits output when the failing result carries no text', () => {
      expect(
        getPortalTurnOutcomeSteps([steps([call('bare', { isError: true })])]),
      ).toEqual([
        {
          toolUseId: 'bare',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{}',
        },
      ]);
    });

    it('ignores plan-mode errors and failures from another turn', () => {
      const counted = [
        steps([
          call('mine'),
          call('plan', { output: 'rejected', isError: true }, 'ExitPlanMode'),
        ]),
      ];
      const otherTurn = steps([result('theirs', true)], 'b1');
      expect(
        getPortalTurnOutcomeSteps(counted, [...counted, otherTurn]),
      ).toEqual([]);
    });
  });
});
