import {
  adjustUiScale,
  clampUiScale,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
} from '../ui-scale';

describe('interface scale range', () => {
  it('spans 50-200% in 5% steps', () => {
    expect(UI_SCALE_MIN).toBe(50);
    expect(UI_SCALE_MAX).toBe(200);
    expect(UI_SCALE_STEP).toBe(5);
    expect(UI_SCALE_DEFAULT).toBe(100);
  });
});

describe('clampUiScale', () => {
  it('keeps supported values untouched', () => {
    expect(clampUiScale(50)).toBe(50);
    expect(clampUiScale(100)).toBe(100);
    expect(clampUiScale(150)).toBe(150);
    expect(clampUiScale(200)).toBe(200);
  });

  it('clamps outside the supported range', () => {
    expect(clampUiScale(10)).toBe(50);
    expect(clampUiScale(1000)).toBe(200);
    // 300 was briefly the ceiling; it must now clamp like any other
    // out-of-range value rather than surviving as a legal scale.
    expect(clampUiScale(300)).toBe(200);
  });

  it('snaps to the 5% grid', () => {
    expect(clampUiScale(112)).toBe(110);
    expect(clampUiScale(113)).toBe(115);
  });

  it('falls back to 100% for values that are not finite numbers', () => {
    expect(clampUiScale(Number.NaN)).toBe(UI_SCALE_DEFAULT);
    expect(clampUiScale(Number.POSITIVE_INFINITY)).toBe(UI_SCALE_DEFAULT);
  });
});

describe('adjustUiScale', () => {
  it('steps one grid stop per invocation', () => {
    expect(adjustUiScale(100, 'in')).toBe(105);
    expect(adjustUiScale(100, 'out')).toBe(95);
    expect(adjustUiScale(105, 'in')).toBe(110);
    expect(adjustUiScale(95, 'out')).toBe(90);
  });

  it('lands on the next grid stop in the requested direction from an off-grid value', () => {
    // Only a hand-edited `preferences.json` reaches an off-grid scale, but a
    // step from one must still move, and must move the way the user asked.
    expect(adjustUiScale(123, 'in')).toBe(125);
    expect(adjustUiScale(123, 'out')).toBe(120);
  });

  it('stops at the ends of the range instead of wrapping or overshooting', () => {
    expect(adjustUiScale(200, 'in')).toBe(200);
    expect(adjustUiScale(195, 'in')).toBe(200);
    expect(adjustUiScale(50, 'out')).toBe(50);
    expect(adjustUiScale(55, 'out')).toBe(50);
    expect(adjustUiScale(1000, 'in')).toBe(200);
    expect(adjustUiScale(10, 'out')).toBe(50);
  });

  it('returns 100% for actual size from anywhere in the range', () => {
    expect(adjustUiScale(50, 'actual-size')).toBe(100);
    expect(adjustUiScale(100, 'actual-size')).toBe(100);
    expect(adjustUiScale(200, 'actual-size')).toBe(100);
  });

  it('treats an unreadable current scale as 100%', () => {
    expect(adjustUiScale(Number.NaN, 'in')).toBe(105);
    expect(adjustUiScale(undefined, 'out')).toBe(95);
  });
});
