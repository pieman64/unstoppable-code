import {
  describeCleanRun,
  groupCleanSteps,
  type CleanUnitRole,
} from '../clean-step-runs';
import {
  describeStepCounts,
  describeStepKinds,
  stepKindOfToolCall,
} from '../step-words';

type Unit = { id: string; role: CleanUnitRole };

function group(units: Unit[]): string[] {
  return groupCleanSteps(
    units,
    (unit) => unit.role,
    (unit) => unit.id,
  ).map((segment) =>
    segment.kind === 'run'
      ? `run(${segment.items.map((unit) => unit.id).join(',')})`
      : segment.item.id,
  );
}

describe('groupCleanSteps', () => {
  it('folds every step between two replies into one run', () => {
    expect(
      group([
        { id: 'tool-1', role: 'step' },
        { id: 'question', role: 'step' },
        { id: 'tool-2', role: 'step' },
        { id: 'failed-1', role: 'step' },
        { id: 'thought', role: 'step' },
        { id: 'reply-1', role: 'break' },
        { id: 'failed-2', role: 'step' },
        { id: 'tool-3', role: 'step' },
        { id: 'reply-2', role: 'break' },
      ]),
    ).toEqual([
      'run(tool-1,question,tool-2,failed-1,thought)',
      'reply-1',
      'run(failed-2,tool-3)',
      'reply-2',
    ]);
  });

  it('folds a single step too', () => {
    expect(
      group([
        { id: 'reply-1', role: 'break' },
        { id: 'tool', role: 'step' },
        { id: 'reply-2', role: 'break' },
      ]),
    ).toEqual(['reply-1', 'run(tool)', 'reply-2']);
  });

  it('keeps silent units inside a run without splitting it', () => {
    expect(
      group([
        { id: 'tool-1', role: 'step' },
        { id: 'empty-thought', role: 'silent' },
        { id: 'tool-2', role: 'step' },
      ]),
    ).toEqual(['run(tool-1,empty-thought,tool-2)']);
  });

  it('leaves silent units alone when no step joins them', () => {
    expect(
      group([
        { id: 'reply', role: 'break' },
        { id: 'empty-thought', role: 'silent' },
      ]),
    ).toEqual(['reply', 'empty-thought']);
  });

  it('keys a run by its first unit, so it keeps its key as it grows', () => {
    const units: Unit[] = [{ id: 'first', role: 'step' }];
    const key = (list: Unit[]): string => {
      const [segment] = groupCleanSteps(
        list,
        (unit) => unit.role,
        (unit) => unit.id,
      );
      return segment?.kind === 'run' ? segment.key : '';
    };
    expect(key(units)).toBe('first');
    expect(key([...units, { id: 'second', role: 'step' }])).toBe('first');
  });
});

describe('describeCleanRun', () => {
  it('counts what the run did, in the order kinds first appear', () => {
    expect(
      describeCleanRun([
        { kind: 'command' },
        { kind: 'read' },
        { kind: 'command' },
        { kind: 'read' },
        { kind: 'command' },
        { kind: 'command', failed: true },
      ]),
    ).toEqual({
      label: 'Ran 4 commands, read 2 files',
      failed: 1,
      blocked: 0,
      interrupted: 0,
      kind: 'command',
    });
  });

  it('counts an interrupted step once, never also as an error', () => {
    // The CAN-5178 turn: a successful Read, then an Edit a restart cut off.
    expect(
      describeCleanRun([
        { kind: 'read' },
        { kind: 'edit', failed: true, interrupted: true },
      ]),
    ).toEqual({
      label: 'Read 1 file, edited 1 file',
      failed: 0,
      blocked: 0,
      interrupted: 1,
      kind: 'read',
    });
    expect(
      describeCleanRun([
        { kind: 'command', blocked: true, interrupted: true },
        { kind: 'command', failed: true },
      ]),
    ).toMatchObject({ blocked: 1, failed: 1, interrupted: 0 });
  });

  it('counts a blocked step once, as blocked rather than failed', () => {
    expect(
      describeCleanRun([
        { kind: 'command', failed: true, blocked: true },
        { kind: 'command', blocked: true },
        { kind: 'command', failed: true },
      ]),
    ).toMatchObject({ label: 'Ran 1 command', blocked: 2, failed: 1 });
  });

  it('never claims that a blocked-only run executed', () => {
    expect(
      describeCleanRun([{ kind: 'command', blocked: true }]),
    ).toMatchObject({
      label: 'No tools ran',
      blocked: 1,
      failed: 0,
      kind: 'command',
    });
  });

  it('leaves thinking out unless the run only thought', () => {
    const run = describeCleanRun([{ kind: 'thinking' }, { kind: 'search' }]);
    expect(run.label).toBe('Searched once');
    // The line leads with what its words name, not the thought before it.
    expect(run.kind).toBe('search');
    expect(describeCleanRun([{ kind: 'thinking' }]).label).toBe('Thought');
  });

  it('names questions and helper agents', () => {
    expect(
      describeCleanRun([
        { kind: 'other' },
        { kind: 'question' },
        { kind: 'agent' },
        { kind: 'agent' },
      ]).label,
    ).toBe('Used 1 tool, asked a question, ran 2 agents');
  });
});

describe('plan-file writes (CAN-5355)', () => {
  const PLAN_PATH = '/Users/test/.claude/plans/draft.md';

  it.each([
    ['object', { file_path: PLAN_PATH, content: '# Plan' }],
    ['serialized', JSON.stringify({ file_path: PLAN_PATH, content: '# Plan' })],
    ['Windows', { file_path: 'C:\\Users\\test\\.claude\\plans\\draft.md' }],
  ])('classifies a %s plan Write as wrote plan', (_label, input) => {
    expect(
      stepKindOfToolCall({ toolName: 'Write', family: 'write', input }),
    ).toBe('plan');
  });

  it.each([
    ['Write', 'write', { file_path: 'docs/plans/draft.md' }],
    ['Write', 'write', { file_path: '/repo/not.claude/plans/draft.md' }],
    ['Write', 'write', '{"file_path":"/Users/test/.claude/plans/dr'],
    ['Write', 'write', undefined],
    ['Edit', 'edit', { file_path: PLAN_PATH }],
  ] as const)('keeps %s %p as an ordinary edit', (toolName, family, input) => {
    expect(stepKindOfToolCall({ toolName, family, input })).toBe('edit');
  });

  it('falls back to the family for every other tool', () => {
    expect(
      stepKindOfToolCall({ toolName: 'Grep', family: 'grep', input: {} }),
    ).toBe('search');
  });

  it('reads a plan-only run as wrote plan, without an edit count', () => {
    expect(
      describeCleanRun([{ kind: 'search' }, { kind: 'plan' }]),
    ).toMatchObject({ label: 'Searched once, wrote plan', failed: 0 });
  });

  it('counts only project writes as edits in a mixed run', () => {
    expect(
      describeCleanRun([
        { kind: 'plan' },
        { kind: 'edit' },
        { kind: 'plan' },
        { kind: 'edit' },
      ]),
    ).toMatchObject({
      label: 'Wrote plan 2 times, edited 2 files',
      kind: 'plan',
    });
  });

  it('never claims a failed plan write succeeded, and still counts it', () => {
    expect(
      describeCleanRun([
        { kind: 'search', failed: true },
        { kind: 'plan', failed: true },
      ]),
    ).toMatchObject({
      label: "Searched once, couldn't write plan",
      failed: 2,
      kind: 'search',
    });
    expect(
      describeCleanRun([
        { kind: 'plan', failed: true },
        { kind: 'plan' },
        { kind: 'plan', failed: true },
      ]),
    ).toMatchObject({
      label: "Couldn't write plan 2 times, wrote plan",
      failed: 2,
      kind: 'plan',
    });
  });

  it('uses the same words in step counts and step kinds', () => {
    expect(describeStepCounts([['plan', 1]])).toBe('Wrote plan');
    expect(
      describeStepCounts([
        ['plan', 3],
        ['edit', 1],
      ]),
    ).toBe('Wrote plan 3 times, edited 1 file');
    expect(
      describeStepKinds([
        ['plan', 2],
        ['search', 1],
      ]),
    ).toBe('Wrote plan 2 times, searched the code');
  });
});
