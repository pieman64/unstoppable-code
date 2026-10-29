/**
 * Canopy denies `ExitPlanMode` on purpose so the plan routes into its own
 * review UI. Every renderer has to pull the plan body out of the tool input and
 * draw it, or the denial reads as a rejected tool call (CAN-3019). This pins
 * the one extractor all three renderers share.
 */
import { extractExitPlanModePlan } from '../exit-plan-mode-plan';

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
