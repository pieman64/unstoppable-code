import type { NormalizedStep } from '../types';
import { buildExpressionContext } from '../execution-context';
import { interpolateNormalizedStep } from '../step-interpolation';

function sendStep(
  withValues: Record<string, string | boolean>,
): NormalizedStep {
  return {
    id: 'send',
    uses: 'builtin/send-agent-message',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 5,
    with: withValues,
    skip_on_missing_action: false,
  };
}

const context = buildExpressionContext({ inputs: { x: 'value' } });

// CAN-4551: a converted automation's prompt arrives as written.
describe('literal send text', () => {
  it('leaves text and text_references as written when literal_text is true', () => {
    const step = interpolateNormalizedStep(
      sendStep({
        project_id: '${{ inputs.x }}',
        text: 'Ship ${{ github.ref }} and ${{ inputs.x }}',
        text_references: '[{"displayText":"${{ inputs.x }}"}]',
        literal_text: 'true',
      }),
      context,
    );
    expect(step.with).toEqual({
      project_id: 'value',
      text: 'Ship ${{ github.ref }} and ${{ inputs.x }}',
      text_references: '[{"displayText":"${{ inputs.x }}"}]',
      literal_text: 'true',
    });
  });

  it('takes a YAML boolean true as literal_text', () => {
    expect(
      interpolateNormalizedStep(
        sendStep({ text: 'Ship ${{ github.ref }}', literal_text: true }),
        context,
      ).with?.text,
    ).toBe('Ship ${{ github.ref }}');
  });

  it('evaluates text without literal_text, and for other steps', () => {
    expect(
      interpolateNormalizedStep(
        sendStep({ text: 'Use ${{ inputs.x }}' }),
        context,
      ).with?.text,
    ).toBe('Use value');
    expect(
      interpolateNormalizedStep(
        {
          ...sendStep({ text: 'Use ${{ inputs.x }}', literal_text: 'true' }),
          uses: 'builtin/create-project-entry',
        },
        context,
      ).with?.text,
    ).toBe('Use value');
  });

  it('does not take an expression as literal_text', () => {
    expect(
      interpolateNormalizedStep(
        sendStep({
          text: 'Use ${{ inputs.x }}',
          literal_text: "${{ 'true' }}",
        }),
        context,
      ).with?.text,
    ).toBe('Use value');
  });
});
