import {
  classifyTurnStepOutcome,
  isTurnOutcomeCounts,
  readTurnOutcomeCounts,
  type ToolInterruptionReason,
} from '../portal';

describe('turn outcome contract', () => {
  it('normalizes legacy wire counts without inventing available metadata', () => {
    expect(readTurnOutcomeCounts({ blocked: 2, failed: 1 })).toEqual({
      blocked: 2,
      failed: 1,
      interrupted: 0,
    });
    expect(isTurnOutcomeCounts({ blocked: 2, failed: 1 })).toBe(false);
    expect(readTurnOutcomeCounts(undefined)).toBeUndefined();
    expect(readTurnOutcomeCounts({})).toBeUndefined();
    for (const invalid of [
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
    ]) {
      for (const key of ['blocked', 'failed', 'interrupted']) {
        const counts = {
          blocked: 0,
          failed: 0,
          interrupted: 0,
          [key]: invalid,
        };
        expect(readTurnOutcomeCounts(counts)).toBeUndefined();
        expect(isTurnOutcomeCounts(counts)).toBe(false);
      }
    }
    const counts = { blocked: 1, failed: 2, interrupted: 3 };
    expect(readTurnOutcomeCounts(JSON.parse(JSON.stringify(counts)))).toEqual(
      counts,
    );
  });

  it.each<ToolInterruptionReason>([
    'app_restart',
    'fork',
    'stopped',
    'unknown',
  ])(
    'gives blocked precedence over %s interruption and interruption over errors',
    (reason) => {
      const result = { isError: true, interruption: { reason, at: 0 } };
      expect(classifyTurnStepOutcome(result, true)).toBe('blocked');
      expect(classifyTurnStepOutcome(result, false)).toBe('interrupted');
      expect(
        classifyTurnStepOutcome({ ...result, isError: false }, false),
      ).toBe('interrupted');
    },
  );

  it('requires settlement and complete results before classifying an absent result', () => {
    expect(classifyTurnStepOutcome(undefined, false)).toBeUndefined();
    for (const settled of [false, true])
      for (const resultsComplete of [false, true]) {
        const evidence = { settled, resultsComplete };
        expect(classifyTurnStepOutcome(undefined, false, evidence)).toBe(
          settled && resultsComplete ? 'interrupted' : undefined,
        );
        expect(
          classifyTurnStepOutcome({ isError: false }, false, evidence),
        ).toBeUndefined();
        expect(
          classifyTurnStepOutcome({ isError: true }, false, evidence),
        ).toBe('failed');
      }
  });
});
