import { formatPlanCommentTime } from '../plan-comments';

describe('formatPlanCommentTime', () => {
  const now = Date.UTC(2026, 5, 19, 18, 0, 0);
  const iso = (deltaMs: number): string =>
    new Date(now - deltaMs).toISOString();

  it('renders sub-minute times as "just now"', () => {
    expect(formatPlanCommentTime(iso(5_000), now).relative).toBe('just now');
  });

  it('renders minute, hour, and day buckets', () => {
    expect(formatPlanCommentTime(iso(5 * 60_000), now).relative).toBe('5m ago');
    expect(formatPlanCommentTime(iso(3 * 3_600_000), now).relative).toBe(
      '3h ago',
    );
    expect(formatPlanCommentTime(iso(2 * 86_400_000), now).relative).toBe(
      '2d ago',
    );
  });

  it('falls back to a short date past a week and keeps an absolute tooltip', () => {
    const result = formatPlanCommentTime(iso(10 * 86_400_000), now);
    expect(result.relative).not.toMatch(/ago/);
    expect(result.absolute).not.toBe('');
  });

  it('tolerates an unparseable timestamp', () => {
    expect(formatPlanCommentTime('not-a-date', now)).toEqual({
      relative: '',
      absolute: 'not-a-date',
    });
  });
});
