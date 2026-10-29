import { proposedPlanText } from '../structured-turn';
import type { ThreadItem } from '../generated/v2/ThreadItem';

describe('proposedPlanText', () => {
  it('prefers the latest completed native plan item', () => {
    const items: ThreadItem[] = [
      { type: 'plan', id: 'plan-1', text: 'First plan' },
      {
        type: 'agentMessage',
        id: 'message-1',
        text: '<proposed_plan>Tagged fallback</proposed_plan>',
        phase: null,
        memoryCitation: null,
      },
      { type: 'plan', id: 'plan-2', text: 'Final native plan' },
    ];

    expect(
      proposedPlanText(items, '<proposed_plan>Tagged fallback</proposed_plan>'),
    ).toBe('Final native plan');
  });

  it('falls back to an explicit proposed-plan block in the final message', () => {
    expect(
      proposedPlanText(
        [],
        'Ready.\n<proposed_plan>\n# Ship it\n</proposed_plan>',
      ),
    ).toBe('# Ship it');
  });
});
