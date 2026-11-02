/**
 * Canopy denies `ExitPlanMode` on purpose so the plan routes into its own
 * review UI. Every renderer has to pull the plan body out of the tool input and
 * draw it, or the denial reads as a rejected tool call (CAN-3019). This pins
 * the one extractor all three renderers share.
 */
import {
  extractExitPlanModePlan,
  resolvePlanTurn,
  type PlanTurnToolCall,
} from '../exit-plan-mode-plan';

describe('extractExitPlanModePlan', () => {
  it('returns the plan body', () => {
    expect(
      extractExitPlanModePlan(JSON.stringify({ plan: '# Title\n\nBody' })),
    ).toBe('# Title\n\nBody');
  });

  it('returns null when the input carries no `plan`', () => {
    expect(extractExitPlanModePlan(JSON.stringify({ other: 'x' }))).toBeNull();
  });

  it('returns null for a non-string `plan`', () => {
    expect(extractExitPlanModePlan(JSON.stringify({ plan: 42 }))).toBeNull();
    expect(
      extractExitPlanModePlan(JSON.stringify({ plan: { text: 'x' } })),
    ).toBeNull();
  });

  it('returns null for an empty or whitespace-only plan', () => {
    expect(extractExitPlanModePlan(JSON.stringify({ plan: '' }))).toBeNull();
    expect(
      extractExitPlanModePlan(JSON.stringify({ plan: ' \n\t ' })),
    ).toBeNull();
  });

  it('never throws on malformed JSON', () => {
    expect(extractExitPlanModePlan('not json')).toBeNull();
    expect(extractExitPlanModePlan('')).toBeNull();
    expect(extractExitPlanModePlan('{"plan":')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(extractExitPlanModePlan('"a string"')).toBeNull();
    expect(extractExitPlanModePlan('[{"plan":"x"}]')).toBeNull();
    expect(extractExitPlanModePlan('null')).toBeNull();
  });

  /**
   * The portal wire caps every tool input at 4,000 characters, so a long plan
   * arrives already carrying the truncation marker. The extractor must pass it
   * through untouched — the marker is the honest signal that the transcript
   * body is partial.
   */
  it('passes a wire-truncated body through with its marker intact', () => {
    const truncated = `${'a'.repeat(64)}\n\n[truncated 1234 chars]`;
    expect(extractExitPlanModePlan(JSON.stringify({ plan: truncated }))).toBe(
      truncated,
    );
  });
});

describe('resolvePlanTurn (CAN-5354)', () => {
  const PLAN =
    '  # Plan ✓\n\n1. Edit `src/a.ts`\n2. Run\n\n```ts\nconst x = 1;\n```\n';
  const PLAN_FILE = '/Users/me/.claude/plans/brave-otter.md';
  const write = (
    file_path: string,
    content: unknown,
    outcome: PlanTurnToolCall['outcome'] | null = 'success',
  ): PlanTurnToolCall => ({
    toolName: 'Write',
    input: JSON.stringify({ file_path, content }),
    ...(outcome ? { outcome } : {}),
  });
  const exit = (input: unknown): PlanTurnToolCall => ({
    toolName: 'ExitPlanMode',
    input: typeof input === 'string' ? input : JSON.stringify(input),
  });

  it('copies the ExitPlanMode plan exactly, whitespace and Unicode included', () => {
    expect(resolvePlanTurn([exit({ plan: PLAN })])).toEqual({
      kind: 'complete',
      markdown: PLAN,
    });
  });

  it('accepts a parsed object input and plans longer than the wire cap', () => {
    const long = `# Long\n\n${'- step\n'.repeat(1_000)}`;
    expect(
      resolvePlanTurn([{ toolName: 'ExitPlanMode', input: { plan: long } }]),
    ).toEqual({ kind: 'complete', markdown: long });
  });

  it('uses the plan-file Write before an empty ExitPlanMode', () => {
    expect(resolvePlanTurn([write(PLAN_FILE, PLAN), exit({})])).toEqual({
      kind: 'complete',
      markdown: PLAN,
    });
  });

  it('does not copy an older draft past a successful wire-truncated Write', () => {
    const truncatedWrite: PlanTurnToolCall = {
      toolName: 'Write',
      outcome: 'success',
      input:
        '{"file_path":"/Users/me/.claude/plans/brave-otter.md","content":"# Revised\n\n[truncated 9000 chars]',
    };
    for (const calls of [
      [write(PLAN_FILE, PLAN), truncatedWrite, exit({})],
      [write(PLAN_FILE, PLAN), truncatedWrite],
    ]) {
      expect(resolvePlanTurn(calls)).toEqual({
        kind: 'incomplete',
        reason: 'truncated',
      });
    }
    expect(
      resolvePlanTurn([
        write(PLAN_FILE, PLAN),
        truncatedWrite,
        exit({ plan: 'final' }),
      ]),
    ).toEqual({ kind: 'complete', markdown: 'final' });
  });

  it('prefers the write planFilePath names', () => {
    expect(
      resolvePlanTurn([
        write(PLAN_FILE, PLAN),
        write('/tmp/config/plans/other.md', 'other'),
        exit({ planFilePath: PLAN_FILE }),
      ]),
    ).toEqual({ kind: 'complete', markdown: PLAN });
  });

  it('treats a Write to the default plans directory as a plan turn', () => {
    expect(resolvePlanTurn([write(PLAN_FILE, PLAN)])).toEqual({
      kind: 'complete',
      markdown: PLAN,
    });
  });

  it('ignores unrelated Markdown and failed or unfinished writes', () => {
    expect(resolvePlanTurn([write('/repo/README.md', PLAN)])).toEqual({
      kind: 'none',
    });
    expect(resolvePlanTurn([write('/repo/docs/plans/x.md', PLAN)])).toEqual({
      kind: 'none',
    });
    expect(resolvePlanTurn([write('/repo/README.md', PLAN), exit({})])).toEqual(
      { kind: 'incomplete', reason: 'missing' },
    );
    expect(
      resolvePlanTurn([write(PLAN_FILE, PLAN, 'error'), exit({})]),
    ).toEqual({ kind: 'incomplete', reason: 'missing' });
    expect(resolvePlanTurn([write(PLAN_FILE, PLAN, null), exit({})])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
  });

  it('never uses a write made after the proposal', () => {
    expect(resolvePlanTurn([exit({}), write(PLAN_FILE, PLAN)])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
  });

  it('does not infer plan identity from a project directory named plans', () => {
    expect(
      resolvePlanTurn([write('/repo/docs/plans/unrelated.md', PLAN), exit({})]),
    ).toEqual({ kind: 'incomplete', reason: 'missing' });
  });

  it('accepts an explicitly identified custom plan file outside the default directory', () => {
    const path = '/custom/provider/proposals/current.md';
    expect(
      resolvePlanTurn([write(path, PLAN), exit({ planFilePath: path })]),
    ).toEqual({ kind: 'complete', markdown: PLAN });
  });

  it('resolves the latest proposal, never an older plan', () => {
    expect(
      resolvePlanTurn([exit({ plan: 'first' }), exit({ plan: 'second' })]),
    ).toEqual({ kind: 'complete', markdown: 'second' });
    expect(
      resolvePlanTurn([write(PLAN_FILE, 'first'), exit({}), exit({})]),
    ).toEqual({ kind: 'incomplete', reason: 'missing' });
  });

  it('marks truncated plans incomplete instead of copying them', () => {
    const truncated = `${'{"plan":"# Plan'}\n\n[truncated 512 chars]`;
    expect(resolvePlanTurn([exit(truncated)])).toEqual({
      kind: 'incomplete',
      reason: 'truncated',
    });
    expect(
      resolvePlanTurn([exit({ plan: '# Plan\n\n[truncated 9 chars]' })]),
    ).toEqual({ kind: 'incomplete', reason: 'truncated' });
    expect(
      resolvePlanTurn([write(PLAN_FILE, '# Plan\n\n[truncated 9 chars]')]),
    ).toEqual({ kind: 'incomplete', reason: 'truncated' });
  });

  it('uses this proposal’s complete identified Write when its attached body was truncated', () => {
    expect(
      resolvePlanTurn([
        write(PLAN_FILE, PLAN),
        exit({
          planFilePath: PLAN_FILE,
          plan: '# Partial\n\n[truncated 9000 chars]',
        }),
      ]),
    ).toEqual({ kind: 'complete', markdown: PLAN });
  });

  it('never throws on empty, malformed or non-string plans', () => {
    expect(resolvePlanTurn([exit({ plan: '  \n ' })])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
    expect(resolvePlanTurn([exit({ plan: 42 })])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
    expect(resolvePlanTurn([exit('not json')])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
    expect(
      resolvePlanTurn([{ toolName: 'ExitPlanMode', input: null }]),
    ).toEqual({ kind: 'incomplete', reason: 'missing' });
    expect(resolvePlanTurn([write(PLAN_FILE, 7)])).toEqual({
      kind: 'incomplete',
      reason: 'missing',
    });
  });

  it('leaves turns without a plan alone', () => {
    expect(resolvePlanTurn([])).toEqual({ kind: 'none' });
    expect(
      resolvePlanTurn([{ toolName: 'Bash', input: '{"command":"ls"}' }]),
    ).toEqual({ kind: 'none' });
  });
});
