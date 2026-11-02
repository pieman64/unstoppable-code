import {
  decidePresentation,
  IDLE_QUIET_MS,
  type PresentationGateInput,
} from '../presentation-gate';

function input(
  overrides: Partial<PresentationGateInput> = {},
): PresentationGateInput {
  return {
    blockers: [],
    deferred: false,
    milestoneArmed: false,
    lastInteractionAt: null,
    now: 10_000,
    ...overrides,
  };
}

describe('decidePresentation', () => {
  it('presents at once before any interaction when nothing blocks', () => {
    expect(decidePresentation(input())).toEqual({ action: 'present' });
  });

  it('waits without a delay while any hard blocker remains', () => {
    expect(decidePresentation(input({ blockers: ['composer-focus'] }))).toEqual(
      { action: 'wait' },
    );
    expect(
      decidePresentation(
        input({
          deferred: true,
          milestoneArmed: true,
          lastInteractionAt: 0,
          blockers: ['resume-pending'],
        }),
      ),
    ).toEqual({ action: 'wait' });
  });

  it('defers after an interaction until a milestone, however long it is quiet', () => {
    expect(
      decidePresentation(input({ deferred: true, lastInteractionAt: 0 })),
    ).toEqual({ action: 'defer' });
  });

  it('waits out the rest of the quiet window once a milestone is armed', () => {
    expect(
      decidePresentation(
        input({
          deferred: true,
          milestoneArmed: true,
          lastInteractionAt: 9_700,
        }),
      ),
    ).toEqual({ action: 'wait', delayMs: 700 });
  });

  it('presents a deferred decision after a milestone and a full quiet window', () => {
    expect(
      decidePresentation(
        input({
          deferred: true,
          milestoneArmed: true,
          lastInteractionAt: 10_000 - IDLE_QUIET_MS,
        }),
      ),
    ).toEqual({ action: 'present' });
  });
});
