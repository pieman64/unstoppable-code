import { resolveTurnCompletionStatus } from '../turn-completion-status';

const NONE = { blocked: 0, failed: 0, interrupted: 0 };
const INTERRUPTED_STEP = { blocked: 0, failed: 0, interrupted: 1 };

describe('resolveTurnCompletionStatus (CAN-5178)', () => {
  it('has no terminal status while the turn runs, whatever the evidence', () => {
    for (const recorded of [
      undefined,
      'failed',
      'cancelled',
      'interrupted',
    ] as const) {
      expect(
        resolveTurnCompletionStatus({
          settled: false,
          recorded,
          outcomes: INTERRUPTED_STEP,
        }),
      ).toBeUndefined();
    }
  });

  it('lets a recorded failure or cancellation outrank interruption', () => {
    expect(
      resolveTurnCompletionStatus({
        settled: true,
        recorded: 'failed',
        outcomes: INTERRUPTED_STEP,
      }),
    ).toBe('failed');
    expect(
      resolveTurnCompletionStatus({
        settled: true,
        recorded: 'cancelled',
        outcomes: INTERRUPTED_STEP,
      }),
    ).toBe('cancelled');
  });

  it('interrupts a turn with restart evidence and no interrupted tool', () => {
    expect(
      resolveTurnCompletionStatus({
        settled: true,
        recorded: 'interrupted',
        outcomes: NONE,
      }),
    ).toBe('interrupted');
    expect(
      resolveTurnCompletionStatus({ settled: true, recorded: 'interrupted' }),
    ).toBe('interrupted');
  });

  it('interrupts a turn from an interrupted step alone', () => {
    expect(
      resolveTurnCompletionStatus({
        settled: true,
        outcomes: INTERRUPTED_STEP,
      }),
    ).toBe('interrupted');
  });

  it('keeps a turn with only tool errors complete', () => {
    expect(
      resolveTurnCompletionStatus({
        settled: true,
        outcomes: { blocked: 1, failed: 2, interrupted: 0 },
      }),
    ).toBe('complete');
    expect(resolveTurnCompletionStatus({ settled: true })).toBe('complete');
  });
});
