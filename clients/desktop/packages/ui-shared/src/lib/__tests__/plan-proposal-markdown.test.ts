import { stripProposedPlanEnvelope } from '../plan-proposal-markdown';

describe('stripProposedPlanEnvelope', () => {
  it('formats a complete assistant proposal without changing its body', () => {
    expect(
      stripProposedPlanEnvelope(
        ' \n<proposed_plan>\n# A plan\n\n1. Verify.\n</proposed_plan> ',
      ),
    ).toBe('# A plan\n\n1. Verify.');
  });

  it.each([
    '<proposed_plan> </proposed_plan>',
    '<proposed_plan># Still streaming',
    'Example: <proposed_plan># Quoted</proposed_plan>',
    '```xml\n<proposed_plan># Code</proposed_plan>\n```',
    '# Ordinary Markdown',
  ])('preserves non-envelope text: %s', (text) => {
    expect(stripProposedPlanEnvelope(text)).toBe(text);
  });
});
