import {
  mergePipelineInputs,
  resolvePipelineInputs,
} from '../execution-context';

// Input validation errors reach people through run-start toasts, hook toasts
// and the CLI, so they name the item the way the UI does (CAN-4651).
describe('workflow input validation copy', () => {
  it('names workflow inputs in aggregated validation errors', () => {
    expect(() =>
      resolvePipelineInputs(
        {
          enabled: { type: 'boolean' },
          required_name: { type: 'string', required: true },
        },
        { enabled: 'not-bool', extra: '1' },
      ),
    ).toThrow(
      [
        'Workflow input validation failed:',
        '- Workflow input "extra" is not declared',
        '- Workflow input "enabled" must be "true" or "false"',
        '- Workflow input "required_name" is required',
      ].join('\n'),
    );
  });

  it('names workflow inputs when overrides target undeclared inputs', () => {
    expect(() =>
      mergePipelineInputs(undefined, undefined, { reviewer: 'alice' }),
    ).toThrow(
      [
        'Workflow input validation failed:',
        '- Workflow input "reviewer" is not declared',
      ].join('\n'),
    );
  });
});
