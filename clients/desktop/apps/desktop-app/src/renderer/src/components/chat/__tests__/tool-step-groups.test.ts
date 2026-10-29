import type { DisplayBlock, DisplayMessage } from '../types';
import {
  describeSteps,
  firstStepKind,
  isFoldableToolMessage,
  runningToolUse,
  segmentToolSteps,
  summarizeToolSteps,
  TURN_COUNT_KINDS,
  TURN_COUNT_ORDER,
  turnStepCounts,
} from '../tool-step-groups';
import type { TurnSummaryCounts } from '../types';
import { SHOW_VISUAL_TOOL_ALIASES } from '@/lib/canopy-tool-aliases';

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
