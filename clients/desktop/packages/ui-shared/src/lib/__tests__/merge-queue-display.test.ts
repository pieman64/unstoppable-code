import {
  estimateMinutes,
  formatEstimateMinutes,
  mergeQueueLabel,
  mergeQueueStep,
  remainingEstimateSeconds,
} from '../merge-queue-display';

const OBSERVED = Date.parse('2026-10-16T13:30:00.000Z');

describe('mergeQueueStep', () => {
  it('groups GitHub entry states into the three steps', () => {
    expect(mergeQueueStep('queued')).toBe('queued');
    expect(mergeQueueStep('unknown')).toBe('queued');
    expect(mergeQueueStep(undefined)).toBe('queued');
    expect(mergeQueueStep('awaiting_checks')).toBe('testing');
    expect(mergeQueueStep('unmergeable')).toBe('testing');
    expect(mergeQueueStep('mergeable')).toBe('merging');
    expect(mergeQueueStep('locked')).toBe('merging');
  });
});

describe('estimates', () => {
  it('rounds to whole minutes and never shows less than one', () => {
    expect(estimateMinutes(1143)).toBe(19);
    expect(estimateMinutes(89)).toBe(1);
    expect(estimateMinutes(0)).toBe(1);
    expect(formatEstimateMinutes(651)).toBe('11 min');
  });

  it('counts an estimate down from when it was read', () => {
    expect(remainingEstimateSeconds(600, OBSERVED, OBSERVED + 120_000)).toBe(
      480,
    );
    expect(
      remainingEstimateSeconds(
        600,
        new Date(OBSERVED).toISOString(),
        OBSERVED + 30_000,
      ),
    ).toBe(570);
    // Past the estimate it stays at zero, which still reads "1 min".
    expect(remainingEstimateSeconds(60, OBSERVED, OBSERVED + 600_000)).toBe(0);
    // A clock behind the read never adds time.
    expect(remainingEstimateSeconds(60, OBSERVED, OBSERVED - 5_000)).toBe(60);
  });

  it('keeps the estimate as given when the read time is unknown', () => {
    expect(remainingEstimateSeconds(300, 'not a time', OBSERVED)).toBe(300);
    expect(remainingEstimateSeconds(300, undefined, OBSERVED)).toBe(300);
    expect(remainingEstimateSeconds(null, OBSERVED, OBSERVED)).toBeNull();
    expect(remainingEstimateSeconds(undefined, OBSERVED, OBSERVED)).toBeNull();
  });
});

describe('mergeQueueLabel', () => {
  it('shows nothing without a queued pull request', () => {
    expect(mergeQueueLabel([])).toBeNull();
  });

  it('reads a waiting pull request with its position and estimate', () => {
    expect(
      mergeQueueLabel([
        { phase: 'queued', position: 3, remainingSeconds: 1143 },
      ]),
    ).toEqual({ kind: 'queued', position: 3, remainingSeconds: 1143 });
    expect(
      mergeQueueLabel([
        { phase: undefined, position: null, remainingSeconds: null },
      ]),
    ).toEqual({ kind: 'queued', position: null, remainingSeconds: null });
  });

  it('reads the merge group as testing and the last step as merging', () => {
    expect(
      mergeQueueLabel([
        { phase: 'awaiting_checks', position: 1, remainingSeconds: 651 },
      ]),
    ).toEqual({ kind: 'testing', remainingSeconds: 651 });
    for (const phase of ['mergeable', 'locked'] as const) {
      expect(
        mergeQueueLabel([{ phase, position: 1, remainingSeconds: 30 }]),
      ).toEqual({ kind: 'merging' });
    }
    expect(
      mergeQueueLabel([
        { phase: 'unmergeable', position: 1, remainingSeconds: null },
      ]),
    ).toEqual({ kind: 'blocked' });
  });

  it('shows several queued pull requests with the latest estimate', () => {
    expect(
      mergeQueueLabel([
        { phase: 'awaiting_checks', position: 1, remainingSeconds: 412 },
        { phase: 'queued', position: 9, remainingSeconds: 2619 },
      ]),
    ).toEqual({ kind: 'several', count: 2, remainingSeconds: 2619 });
  });

  it('drops the estimate for several when any one is unknown', () => {
    expect(
      mergeQueueLabel([
        { phase: 'queued', position: 2, remainingSeconds: 412 },
        { phase: 'queued', position: 9, remainingSeconds: null },
      ]),
    ).toEqual({ kind: 'several', count: 2, remainingSeconds: null });
    expect(
      mergeQueueLabel([
        { phase: 'locked', position: 1, remainingSeconds: null },
        { phase: 'mergeable', position: 1, remainingSeconds: null },
      ]),
    ).toEqual({ kind: 'merging' });
  });
});
