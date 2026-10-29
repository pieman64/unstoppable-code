/**
 * Caller-seeded pipeline input values (the onboarding "Create a Task Plan"
 * preselection): declared inputs are overlaid on defaults, unknown and
 * prototype-inherited seed names are dropped, everything else keeps its
 * initialized default.
 */

import type { PipelineInputDef } from '@canopy/desktop-shared/types/pipeline';
import { seedInitialInputValues } from '../pipelineTriggerInputs';

const DEFS: Record<string, PipelineInputDef> = {
  model: {
    type: 'choice',
    options: ['opus', '$fast', '$default-codex'],
    default: '$default-codex',
  },
  notes: { type: 'string' },
};

describe('seedInitialInputValues', () => {
  it('returns plain defaults when no seeds are provided', () => {
    expect(seedInitialInputValues(DEFS, undefined)).toEqual({
      model: '$default-codex',
      notes: '',
    });
  });

  it('overlays seeds for declared inputs only', () => {
    expect(
      seedInitialInputValues(DEFS, {
        model: 'opus',
        'not-an-input': 'dropped',
      }),
    ).toEqual({ model: 'opus', notes: '' });
  });

  it('ignores prototype-inherited seed names', () => {
    expect(
      seedInitialInputValues(DEFS, {
        toString: 'nope',
        constructor: 'nope',
      }),
    ).toEqual({ model: '$default-codex', notes: '' });
  });
});
