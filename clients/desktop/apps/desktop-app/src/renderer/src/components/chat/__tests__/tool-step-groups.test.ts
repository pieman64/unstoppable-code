import { mergeToolResults } from '../message-transforms';
import type { DisplayBlock, DisplayMessage } from '../types';
import {
  cleanBlockRole,
  describeCleanSteps,
  describeSteps,
  firstStepKind,
  isFoldableToolMessage,
  runningToolUse,
  segmentCleanSteps,
  segmentToolSteps,
  summarizeToolSteps,
  TURN_COUNT_KINDS,
  TURN_COUNT_ORDER,
  turnStepCounts,
} from '../tool-step-groups';
import type { TurnSummaryCounts } from '../types';
import { SHOW_VISUAL_TOOL_ALIASES } from '@/lib/canopy-tool-aliases';
import { safetyDeniedMessage } from '@canopy/protocol/approvals';

type ToolUseBlock = Extract<DisplayBlock, { type: 'tool_use' }>;

let nextId = 0;

function toolUse(
  toolName: string,
  input: object = {},
  result: ToolUseBlock['result'] | 'running' = { output: 'ok', isError: false },
): ToolUseBlock {
  nextId += 1;
  return {
    type: 'tool_use',
    toolUseId: `tool-${nextId}`,
    toolName,
    input: JSON.stringify(input),
    ...(result === 'running' ? {} : { result }),
  };
}

function message(
  id: string,
  blocks: DisplayBlock[],
  role: DisplayMessage['role'] = 'assistant',
): DisplayMessage {
  return { id, role, blocks, timestamp: 1 };
}

function text(id: string, value: string): DisplayMessage {
  return message(id, [{ type: 'text', text: value }]);
}

function shape(messages: DisplayMessage[]): string[] {
  return segmentToolSteps(messages).map((segment) =>
    segment.kind === 'message'
      ? segment.message.id
      : `[${segment.messages.map((m) => m.id).join(',')}]`,
  );
}

describe('segmentToolSteps', () => {
  it.each(SHOW_VISUAL_TOOL_ALIASES)(
    'keeps pending ShowVisual alias %s outside compact tool runs',
    (alias) => {
      expect(
        shape([
          message('before', [toolUse('Read')]),
          message('visual', [toolUse(alias, {}, 'running')]),
          message('after', [toolUse('Read')]),
        ]),
      ).toEqual(['before', 'visual', 'after']);
    },
  );

  it('keeps a completed visual reference standalone regardless of provider title', () => {
    const visual = toolUse(
      'Cursor visual renderer',
      {},
      {
        output: 'Shown',
        isError: false,
        visualRef: {
          version: 1,
          visualId: 'vis_123e4567-e89b-12d3-a456-426614174000',
          artifactId: `sha256-v1-${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          byteLength: 8,
          mediaType: 'text/html',
          title: 'Cursor chart',
          maxHeight: 320,
        },
      },
    );
    expect(
      shape([
        message('a', [toolUse('Read')]),
        message('b', [visual]),
        message('c', [toolUse('Read')]),
      ]),
    ).toEqual(['a', 'b', 'c']);
  });
  it('folds back-to-back tool calls and thinking between two messages', () => {
    expect(
      shape([
        text('t1', 'Looking first.'),
        message('a', [toolUse('Grep', { pattern: 'x' })]),
        message('b', [{ type: 'thinking', text: 'Hmm' }]),
        message('c', [toolUse('Read', { file_path: '/a.ts' })]),
        text('t2', 'Found it.'),
        message('d', [toolUse('Edit', { file_path: '/a.ts' })]),
        message('e', [toolUse('Bash', { command: 'npm test' })]),
      ]),
    ).toEqual(['t1', '[a,b,c]', 't2', '[d,e]']);
  });

  it('leaves a single tool call as its own row', () => {
    expect(
      shape([
        message('th', [{ type: 'thinking', text: 'Hmm' }]),
        message('a', [toolUse('Read', { file_path: '/a.ts' })]),
        text('t1', 'Done.'),
      ]),
    ).toEqual(['th', 'a', 't1']);
  });

  it('keeps the group key on its first message as the run grows', () => {
    const first = message('a', [toolUse('Read', { file_path: '/a.ts' })]);
    const second = message('b', [toolUse('Read', { file_path: '/b.ts' })]);
    const third = message('c', [toolUse('Read', { file_path: '/c.ts' })]);
    const [before] = segmentToolSteps([first, second]);
    const [after] = segmentToolSteps([first, second, third]);
    expect(before?.kind === 'steps' && before.key).toBe('a');
    expect(after?.kind === 'steps' && after.key).toBe('a');
  });

  it.each([
    ['a question', toolUse('AskUserQuestion', { questions: [] })],
    ['a plan', toolUse('ExitPlanMode', { plan: '# Plan' })],
    ['a skill', toolUse('Skill', { skill: 'review' })],
    [
      'a failed call',
      toolUse(
        'Bash',
        { command: 'npm test' },
        { output: 'boom', isError: true },
      ),
    ],
  ])('never folds %s, and it splits the run', (_label, block) => {
    expect(
      shape([
        message('a', [toolUse('Read', { file_path: '/a.ts' })]),
        message('b', [toolUse('Read', { file_path: '/b.ts' })]),
        message('x', [block]),
        message('c', [toolUse('Read', { file_path: '/c.ts' })]),
        message('d', [toolUse('Read', { file_path: '/d.ts' })]),
      ]),
    ).toEqual(['[a,b]', 'x', '[c,d]']);
  });

  it('never folds user, system, or host-generated messages', () => {
    expect(isFoldableToolMessage(message('u', [toolUse('Read')], 'user'))).toBe(
      false,
    );
    expect(
      isFoldableToolMessage(message('s', [toolUse('Read')], 'system')),
    ).toBe(false);
    expect(
      isFoldableToolMessage(
        message('h', [{ ...toolUse('Read'), isSystemMessage: true }]),
      ),
    ).toBe(false);
    expect(isFoldableToolMessage(message('empty', []))).toBe(false);
  });
});

describe('summarizeToolSteps', () => {
  it('reads like a sentence, kinds in first-seen order', () => {
    expect(
      summarizeToolSteps([
        toolUse('Grep', { pattern: 'x' }),
        toolUse('Read', { file_path: '/a.ts' }),
        toolUse('Glob', { pattern: '*.ts' }),
        toolUse('Read', { file_path: '/b.ts' }),
        toolUse('Bash', { command: 'npm test' }),
      ]),
    ).toBe('Searched 2 times, read 2 files, ran 1 command');
  });

  it('counts edits and writes together as edited files', () => {
    expect(
      summarizeToolSteps([
        toolUse('Edit', { file_path: '/a.ts' }),
        toolUse('Write', { file_path: '/b.ts' }),
      ]),
    ).toBe('Edited 2 files');
  });

  it('names a single search in the singular', () => {
    expect(
      summarizeToolSteps([
        toolUse('Grep', { pattern: 'x' }),
        toolUse('Edit', { file_path: '/a.ts' }),
      ]),
    ).toBe('Searched 1 time, edited 1 file');
  });
});

describe('runningToolUse', () => {
  it('returns the last call while it has no result', () => {
    const running = toolUse('Bash', { command: 'npm test' }, 'running');
    expect(runningToolUse([toolUse('Read'), running])).toBe(running);
  });

  it('returns nothing once the last call has finished', () => {
    expect(runningToolUse([toolUse('Read'), toolUse('Bash')])).toBeUndefined();
  });
});

describe('clean chat look step words', () => {
  it('says what a run did without counting it', () => {
    expect(
      describeSteps([
        toolUse('Bash', { command: 'ls' }),
        toolUse('Bash', { command: 'pwd' }),
        toolUse('Read', { file_path: 'a.ts' }),
        toolUse('Grep', { pattern: 'x' }),
      ]),
    ).toBe('Ran commands, read a file, searched the code');
  });

  function counts(overrides: Partial<TurnSummaryCounts>): TurnSummaryCounts {
    const zero: TurnSummaryCounts = {
      messages: 0,
      thinking: 0,
      bash: 0,
      read: 0,
      readLines: 0,
      writeEdit: 0,
      plan: 0,
      fileEdit: 0,
      fileAdd: 0,
      fileDelete: 0,
      search: 0,
      grep: 0,
      web: 0,
      agent: 0,
      workflow: 0,
      tasks: 0,
      taskStop: 0,
      skills: 0,
      monitor: 0,
      claude: 0,
      scheduleWakeup: 0,
      askUser: 0,
      scriptOutput: 0,
      watcher: 0,
      canopy: 0,
      graph: 0,
      appAdvisor: 0,
      pipelineEditor: 0,
      computerUse: 0,
      mcp: 0,
      other: 0,
    };
    return { ...zero, ...overrides };
  }

  it('orders every counted summary key exactly once', () => {
    expect([...TURN_COUNT_ORDER].sort()).toEqual(
      Object.keys(TURN_COUNT_KINDS).sort(),
    );
    expect(new Set(TURN_COUNT_ORDER).size).toBe(TURN_COUNT_ORDER.length);
  });

  it('reads a finished turn in chip order, without messages', () => {
    expect(
      turnStepCounts(
        counts({
          messages: 3,
          thinking: 1,
          bash: 2,
          readLines: 1,
          fileEdit: 2,
        }),
      ),
    ).toEqual([
      ['thinking', 1],
      ['command', 2],
      ['read', 1],
      ['edit', 2],
    ]);
  });

  it('leads a run with its first step kind', () => {
    expect(
      firstStepKind([toolUse('Read', { file_path: 'a.ts' }), toolUse('Bash')]),
    ).toBe('read');
    expect(firstStepKind([])).toBeUndefined();
  });
});

describe('clean chat look runs', () => {
  it('counts an interrupted call once, never as an error (CAN-5178)', () => {
    const interrupted = toolUse(
      'Edit',
      { file_path: '/repo/a.ts' },
      {
        output: 'Interrupted',
        isError: true,
        interruption: { reason: 'app_restart', at: 15_000 },
      },
    );
    const [segment] = segmentCleanSteps([
      message('m1', [
        toolUse('Read', { file_path: '/repo/a.ts' }),
        interrupted,
      ]),
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({
      failed: 0,
      blocked: 0,
      interrupted: 1,
    });
  });

  it('counts a call without a result only once its turn settled with every result loaded', () => {
    const [segment] = segmentCleanSteps([
      message('m1', [toolUse('Read'), toolUse('Edit', {}, 'running')]),
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment).interrupted).toBe(0);
    expect(
      describeCleanSteps(segment, undefined, {
        settled: false,
        resultsComplete: true,
      }).interrupted,
    ).toBe(0);
    expect(
      describeCleanSteps(segment, undefined, {
        settled: true,
        resultsComplete: false,
      }).interrupted,
    ).toBe(0);
    expect(
      describeCleanSteps(segment, undefined, {
        settled: true,
        resultsComplete: true,
      }),
    ).toMatchObject({ interrupted: 1, failed: 0 });
  });

  it.each<DisplayBlock>([
    {
      type: 'agent',
      toolUseId: 'agent-resultless',
      subagentType: 'general-purpose',
      description: 'Inspect the changes',
      prompt: 'Inspect',
      runInBackground: false,
      subBlocks: [],
    },
    {
      type: 'workflow',
      toolUseId: 'workflow-resultless',
      workflowName: 'Inspect',
      summary: 'Inspect the changes',
    },
  ])(
    'counts a resultless $type as interrupted only with settled, complete evidence',
    (block) => {
      const [segment] = segmentCleanSteps([message('m1', [block])]);
      if (segment?.kind !== 'steps') throw new Error('expected a run');
      expect(describeCleanSteps(segment).interrupted).toBe(0);
      expect(
        describeCleanSteps(segment, undefined, {
          settled: false,
          resultsComplete: true,
        }).interrupted,
      ).toBe(0);
      expect(
        describeCleanSteps(segment, undefined, {
          settled: true,
          resultsComplete: false,
        }).interrupted,
      ).toBe(0);
      expect(
        describeCleanSteps(segment, undefined, {
          settled: true,
          resultsComplete: true,
        }),
      ).toMatchObject({ interrupted: 1, failed: 0, blocked: 0 });
    },
  );

  it('keeps a blocked receipt ahead of interruption in clean run counts', () => {
    const [segment] = segmentCleanSteps([
      message('m1', [
        toolUse(
          'Bash',
          {},
          {
            output: safetyDeniedMessage('force-push'),
            isError: true,
            interruption: { reason: 'app_restart', at: 14 },
          },
        ),
        toolUse('Read'),
      ]),
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({
      blocked: 1,
      failed: 0,
      interrupted: 0,
    });
  });

  it('promotes an interrupted result with non-denial text using the authoritative denial IDs', () => {
    const call = toolUse(
      'Edit',
      {},
      {
        output: 'Interrupted by restart',
        isError: true,
        interruption: { reason: 'app_restart', at: 14 },
      },
    );
    const [segment] = segmentCleanSteps([message('m1', [call])]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(
      describeCleanSteps(
        segment,
        undefined,
        undefined,
        new Set([call.toolUseId]),
      ),
    ).toMatchObject({ blocked: 1, failed: 0, interrupted: 0 });
  });

  it('counts recognized denials as blocked, never as failed', () => {
    const safety = toolUse(
      'Bash',
      { command: 'git push --force' },
      {
        output: `PreToolUse:Bash hook error: ${safetyDeniedMessage('force-push')}`,
        isError: true,
      },
    );
    const userDenied = toolUse(
      'Bash',
      { command: 'git reset --hard' },
      {
        output:
          'PreToolUse:Bash hook error: The user denied this tool call: Not on this branch.',
        isError: true,
      },
    );
    const failed = toolUse(
      'Bash',
      {},
      { output: 'no such file', isError: true },
    );
    const [segment] = segmentCleanSteps([
      message('m1', [safety, userDenied, failed, toolUse('Read')]),
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({
      blocked: 2,
      failed: 1,
    });
    // Blocked calls stay visible outside classic folds, as errors do.
    expect(isFoldableToolMessage(message('m2', [safety]))).toBe(false);
  });

  it('never counts a correlated safety receipt as another blocked call', () => {
    const call = toolUse(
      'Bash',
      { command: 'git push --force' },
      {
        output: safetyDeniedMessage('force-push'),
        isError: true,
      },
    );
    const segments = segmentCleanSteps([
      message('call', [call]),
      message(
        'receipt',
        [
          {
            type: 'approval_safety_denied_info',
            receiptId: 'receipt-1',
            timestamp: 2,
            reason: 'force-push',
            command: 'git push --force',
            mode: 'ask',
            toolUseId: call.toolUseId,
          },
        ],
        'system',
      ),
    ]);
    const totals = segments.reduce(
      (counts, segment) => {
        if (segment.kind !== 'steps') return counts;
        const described = describeCleanSteps(segment);
        return {
          blocked: counts.blocked + described.blocked,
          failed: counts.failed + described.failed,
        };
      },
      { blocked: 0, failed: 0 },
    );
    expect(totals).toEqual({ blocked: 1, failed: 0 });
  });

  it('reports zero blocked steps for an ordinary failure', () => {
    const [segment] = segmentCleanSteps([
      message('m1', [toolUse('Bash', {}, { output: 'boom', isError: true })]),
    ]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({
      blocked: 0,
      failed: 1,
    });
  });

  it.each(['Agent', 'Task'])(
    'counts a denied %s through the real projection as blocked',
    (toolName) => {
      const projected = mergeToolResults([
        {
          id: 'agent-denied',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'agent-1',
              toolName,
              input: JSON.stringify({
                subagent_type: 'Explore',
                prompt: 'Inspect',
              }),
            },
            {
              type: 'tool_result',
              toolUseId: 'agent-1',
              toolName,
              output:
                'PreToolUse:Agent hook error: The user denied this tool call: Keep this local.',
              isError: true,
            },
          ],
        },
      ]);
      expect(projected[0]?.blocks[0]?.type).toBe('agent');
      const [segment] = segmentCleanSteps(projected);
      if (segment?.kind !== 'steps') throw new Error('expected a run');
      expect(describeCleanSteps(segment)).toMatchObject({
        label: 'No tools ran',
        blocked: 1,
        failed: 0,
      });
    },
  );

  it('counts a background agent whose final output failed as a failure', () => {
    const agent: DisplayBlock = {
      type: 'agent',
      toolUseId: 'agent-1',
      subagentType: 'general-purpose',
      description: 'Audit the toolbar',
      prompt: 'Audit',
      runInBackground: true,
      result: { output: 'Async agent launched', isError: false },
      taskOutputResult: { output: 'crashed', isError: true },
      subBlocks: [],
    };
    const [segment] = segmentCleanSteps([message('m1', [agent])]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({ failed: 1 });
  });

  it('keeps an older MCP sign-in error on its own row', () => {
    // No structured auth metadata, only the error text: the row still
    // offers to reconnect, so it must not fold into a closed line.
    const legacy = toolUse(
      'mcp__linear__list_issues',
      {},
      {
        output: 'MCP error -32001: MCP server authorization required',
        isError: true,
      },
    );
    expect(cleanBlockRole(legacy)).toBe('break');
    expect(
      cleanBlockRole(
        toolUse('Bash', {}, { output: 'no such file', isError: true }),
      ),
    ).toBe('step');
  });

  it('counts a failed Codex helper as a failure', () => {
    const codex: DisplayBlock = {
      type: 'codex_agent',
      agentBlockId: 'codex',
      callId: 'spawn',
      status: 'completed',
      senderThreadId: 'parent',
      receiverThreadIds: ['child'],
      prompt: 'Review',
      description: 'Review',
      displayName: 'Reviewer',
      agentsStates: { child: { status: 'errored' } },
      subBlocks: [],
    };
    const [segment] = segmentCleanSteps([message('m1', [codex])]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    expect(describeCleanSteps(segment)).toMatchObject({ failed: 1 });
  });
});

describe('plan-file writes in the clean chat look (CAN-5355)', () => {
  const PLAN = { file_path: '/Users/test/.claude/plans/draft.md' };
  const FAILED = { output: 'Write failed', isError: true };

  function run(blocks: DisplayBlock[]): ReturnType<typeof describeCleanSteps> {
    const [segment] = segmentCleanSteps([message('m1', blocks)]);
    if (segment?.kind !== 'steps') throw new Error('expected a run');
    return describeCleanSteps(segment);
  }

  it('reads a plan-only write as wrote plan, with no edit count or error', () => {
    expect(
      run([toolUse('Grep', { pattern: 'x' }), toolUse('Write', PLAN)]),
    ).toMatchObject({
      label: 'Searched once, wrote plan',
      failed: 0,
      firstKind: 'search',
    });
    expect(describeSteps([toolUse('Write', PLAN)])).toBe('Wrote plan');
    expect(summarizeToolSteps([toolUse('Write', PLAN)])).toBe('Wrote plan');
  });

  it('does not claim pending, interrupted or failed plan writes succeeded in compact or clean summaries', () => {
    for (const [result, label] of [
      ['running', 'Writing plan'],
      [{ output: 'EACCES', isError: true }, "Couldn't write plan"],
      [
        {
          output: '',
          isError: true,
          interruption: { reason: 'app_restart', at: 1 },
        },
        'Plan write interrupted',
      ],
    ] as const) {
      const block = toolUse('Write', PLAN, result);
      expect(run([block]).label).toBe(label);
      expect(describeSteps([block])).toBe(label);
      expect(summarizeToolSteps([block])).toBe(label);
    }
  });

  it('counts only project writes as edits in a mixed run', () => {
    expect(
      run([
        toolUse('Write', PLAN),
        toolUse('Write', { file_path: 'docs/plans/draft.md' }),
        toolUse('Edit', { file_path: 'src/index.ts' }),
      ]).label,
    ).toBe('Wrote plan, edited 2 files');
  });

  it('keeps real failures and never claims a failed plan write succeeded', () => {
    expect(
      run([toolUse('Grep', { pattern: 'x' }, FAILED), toolUse('Write', PLAN)]),
    ).toMatchObject({ label: 'Searched once, wrote plan', failed: 1 });
    expect(
      run([
        toolUse('Grep', { pattern: 'x' }, FAILED),
        toolUse('Write', PLAN, FAILED),
      ]),
    ).toMatchObject({
      label: "Searched once, couldn't write plan",
      failed: 2,
    });
  });
});
