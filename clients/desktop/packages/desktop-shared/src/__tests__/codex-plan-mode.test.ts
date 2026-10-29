import {
  buildCodexPlanModeDeveloperInstructions,
  DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from '../codex-plan-mode';

describe('Codex plan mode instructions', () => {
  it('explicitly revokes plan-only restrictions in default mode', () => {
    expect(DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain('Default mode');
    expect(DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      'Plan mode instructions are no longer active',
    );
    expect(DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain('edit files');
    expect(DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain('write commands');
  });

  it('requires implementation-ready completion contract sections', () => {
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('Completion Contract');
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('Acceptance Matrix');
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      'Non-Goals And Deferrals',
    );
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('cannot-ship');
  });

  it('forbids deferring required behavior as placeholders or future work', () => {
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('stub');
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('placeholder');
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain('future work');
    expect(PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      'Required behavior must be implemented',
    );
  });

  it('carries the completion contract into required final proposal mode', () => {
    const instructions = buildCodexPlanModeDeveloperInstructions('required');

    expect(instructions).toContain('Completion Contract');
    expect(instructions).toContain('Acceptance Matrix');
    expect(instructions).toContain('cannot-ship');
    expect(instructions).toContain('Your final response must include');
  });
});
