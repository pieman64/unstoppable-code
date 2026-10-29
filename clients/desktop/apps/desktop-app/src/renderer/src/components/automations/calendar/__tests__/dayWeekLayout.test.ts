import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { EVENT_MIN_PX, HOUR_PX, layoutDayGroups } from '../dayWeekLayout';
import type { CalendarEvent, CalendarEventGroup } from '../calendarEvents';

function makeActivity(id: string): ScheduledActivity {
  return {
    version: 1,
    id,
    name: `Activity ${id}`,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Run' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    failureCount: 0,
  };
}

function group(id: string, at: Date, endsAt: Date = at): CalendarEventGroup {
  const activity = makeActivity(id);
  const event: CalendarEvent = {
    key: `occurrence:${id}:${at.getTime()}`,
    kind: 'occurrence',
    activityId: id,
    activity,
    name: activity.name,
    at,
    runStatus: null,
    activityDeleted: false,
  };
  return {
    key: `group:${id}:${at.getTime()}`,
    activityId: id,
    at,
    endsAt,
    representative: event,
    count: at.getTime() === endsAt.getTime() ? 1 : 2,
  };
}

describe('layoutDayGroups', () => {
  it('keeps non-overlapping chips full width even when another row splits', () => {
    // Two near-simultaneous chips (9:28 / 9:30 PM) overlap and must split, but
    // the hourly chips on the same day must stay full width — a single split row
    // should never halve the whole column.
    const groups = [
      group('hourly', new Date(2026, 5, 25, 12, 0)),
      group('hourly', new Date(2026, 5, 25, 13, 0)),
      group('a', new Date(2026, 5, 25, 21, 28)),
      group('b', new Date(2026, 5, 25, 21, 30)),
    ];

    const positioned = layoutDayGroups(groups);
    const laneCountAt = (hour: number, minute: number): number | undefined =>
      positioned.find(
        (item) =>
          item.group.at.getHours() === hour &&
          item.group.at.getMinutes() === minute,
      )?.laneCount;

    expect(laneCountAt(12, 0)).toBe(1);
    expect(laneCountAt(13, 0)).toBe(1);
    // The overlapping pair shares a two-lane cluster.
    expect(laneCountAt(21, 28)).toBe(2);
    expect(laneCountAt(21, 30)).toBe(2);
    const lanes = positioned
      .filter((item) => item.group.at.getHours() === 21)
      .map((item) => item.lane)
      .sort();
    expect(lanes).toEqual([0, 1]);
  });

  it('assigns a full-width single lane when nothing overlaps', () => {
    const groups = [
      group('a', new Date(2026, 5, 25, 9, 0)),
      group('b', new Date(2026, 5, 25, 14, 0)),
    ];

    const positioned = layoutDayGroups(groups);

    expect(positioned.every((item) => item.laneCount === 1)).toBe(true);
    expect(positioned.every((item) => item.lane === 0)).toBe(true);
  });

  it('gives a single fire the minimum chip height', () => {
    const positioned = layoutDayGroups([
      group('a', new Date(2026, 5, 25, 9, 0)),
    ]);

    expect(positioned[0]?.height).toBe(EVENT_MIN_PX);
  });

  it('spans a condensed block from its first to its last fire, not beyond', () => {
    // 9:00 → 9:55 condensed group covers the span up to 9:55 and must NOT
    // extend past it (a +EVENT_MIN_PX overhang would spill into the 10:00 row
    // and force the next block into an extra lane).
    const positioned = layoutDayGroups([
      group('a', new Date(2026, 5, 25, 9, 0), new Date(2026, 5, 25, 9, 55)),
    ]);

    const item = positioned[0];
    expect(item).toBeDefined();
    // top at 9:00 → 9 hours of rows.
    expect(item?.top).toBe(9 * HOUR_PX);
    // height covers exactly the 55-minute span — ends at 9:55, before 10:00.
    const expected = (55 / 60) * HOUR_PX;
    expect(item?.height).toBeCloseTo(expected, 5);
    expect(item?.height).toBeGreaterThan(EVENT_MIN_PX);
    // Block bottom stays within the hour (10:00 = 10 * HOUR_PX).
    expect((item?.top ?? 0) + (item?.height ?? 0)).toBeLessThan(10 * HOUR_PX);
  });

  it('keeps consecutive full-hour blocks in a single lane (sequential, no offset)', () => {
    // Two back-to-back hourly groups (12:00–12:55, 1:00–1:55) must not overlap,
    // so neither is pushed into a second lane.
    const positioned = layoutDayGroups([
      group('a', new Date(2026, 5, 25, 0, 0), new Date(2026, 5, 25, 0, 55)),
      group('a', new Date(2026, 5, 25, 1, 0), new Date(2026, 5, 25, 1, 55)),
    ]);

    expect(positioned).toHaveLength(2);
    expect(positioned.every((item) => item.laneCount === 1)).toBe(true);
    expect(positioned.every((item) => item.lane === 0)).toBe(true);
  });
});
