import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  buildCalendarEvents,
  calendarEventInteractionClasses,
  calendarEventToneClasses,
  formatGroupCount,
  formatGroupTimeRange,
  groupCalendarEvents,
  type CalendarEvent,
} from '../calendarEvents';

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

function occurrence(activityId: string, at: Date): CalendarEvent {
  const activity = makeActivity(activityId);
  return {
    key: `occurrence:${activityId}:${at.getTime()}`,
    kind: 'occurrence',
    activityId,
    activity,
    name: activity.name,
    at,
    runStatus: null,
    activityDeleted: false,
  };
}

describe('groupCalendarEvents', () => {
  it('condenses same-activity fires within an hour bucket into one group', () => {
    const events = [0, 5, 10, 15].map((minute) =>
      occurrence('a', new Date(2026, 5, 25, 9, minute)),
    );

    const groups = groupCalendarEvents(events, 'hour');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(4);
    // Representative / position is the earliest fire in the bucket.
    expect(groups[0]?.at.getMinutes()).toBe(0);
    // `endsAt` tracks the last fire so the block can span the window.
    expect(groups[0]?.endsAt.getMinutes()).toBe(15);
  });

  it('keeps fires in different hour buckets separate under hour bucketing', () => {
    const events = [
      occurrence('a', new Date(2026, 5, 25, 9, 0)),
      occurrence('a', new Date(2026, 5, 25, 10, 0)),
    ];

    const groups = groupCalendarEvents(events, 'hour');

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.count === 1)).toBe(true);
  });

  it('condenses an entire day under day bucketing', () => {
    const events = [9, 10, 11, 12].map((hour) =>
      occurrence('a', new Date(2026, 5, 25, hour, 0)),
    );

    const groups = groupCalendarEvents(events, 'day');

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(4);
  });

  it('never merges different activities or different kinds', () => {
    const at = new Date(2026, 5, 25, 9, 0);
    const runEvent: CalendarEvent = {
      key: 'run:r1',
      kind: 'run',
      activityId: 'a',
      activity: makeActivity('a'),
      name: 'Activity a',
      at: new Date(2026, 5, 25, 9, 30),
      runStatus: 'success',
      activityDeleted: false,
    };

    const groups = groupCalendarEvents(
      [occurrence('a', at), occurrence('b', at), runEvent],
      'hour',
    );

    // a-occurrence, b-occurrence, a-run → three distinct groups.
    expect(groups).toHaveLength(3);
  });

  it('picks the most-severe run status as the representative', () => {
    const base = (
      minute: number,
      status: 'success' | 'failure',
    ): CalendarEvent => ({
      key: `run:${minute}`,
      kind: 'run',
      activityId: 'a',
      activity: makeActivity('a'),
      name: 'Activity a',
      at: new Date(2026, 5, 25, 9, minute),
      runStatus: status,
      activityDeleted: false,
    });

    const groups = groupCalendarEvents(
      [base(0, 'success'), base(5, 'failure'), base(10, 'success')],
      'hour',
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.representative.runStatus).toBe('failure');
    // Positioning still uses the earliest fire.
    expect(groups[0]?.at.getMinutes()).toBe(0);
  });

  it('returns groups sorted ascending by earliest instant', () => {
    const groups = groupCalendarEvents(
      [
        occurrence('a', new Date(2026, 5, 25, 14, 0)),
        occurrence('b', new Date(2026, 5, 25, 9, 0)),
      ],
      'hour',
    );

    expect(groups.map((group) => group.activityId)).toEqual(['b', 'a']);
  });
});

describe('formatGroupCount', () => {
  it('returns null for a single fire', () => {
    expect(formatGroupCount(1)).toBeNull();
  });

  it('returns an "(N times)" label for repeated fires', () => {
    expect(formatGroupCount(12)).toBe('(12 times)');
  });
});

describe('formatGroupTimeRange', () => {
  it('returns a single time (no dash) for a one-fire group', () => {
    const [group] = groupCalendarEvents(
      [occurrence('a', new Date(2026, 5, 25, 9, 0))],
      'hour',
    );
    expect(group).toBeDefined();
    if (group !== undefined) {
      expect(formatGroupTimeRange(group)).not.toContain('–');
    }
  });

  it('returns a "first – last" range covering the condensing window', () => {
    const events = [0, 30, 55].map((minute) =>
      occurrence('a', new Date(2026, 5, 25, 9, minute)),
    );
    const [group] = groupCalendarEvents(events, 'hour');
    expect(group).toBeDefined();
    if (group !== undefined) {
      const label = formatGroupTimeRange(group);
      const [start, end] = label.split(' – ');
      expect(end).toBeDefined();
      // Start is the first fire (9:00), end is the last (9:55).
      expect(start).toBe(
        group.at.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        }),
      );
      expect(end).toBe(
        group.endsAt.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit',
        }),
      );
    }
  });
});

describe('buildCalendarEvents window coverage', () => {
  it('shows a short-interval cron across the whole month window, not just the first week', () => {
    // Every-5-minute cron (~288 fires/day). Over a 42-day month grid this far
    // exceeds the shared default per-activity cap (2000, ~7 days), so without a
    // window-scaled cap the later weeks would render empty.
    const activity: ScheduledActivity = {
      version: 1,
      id: 'frequent',
      name: 'Frequent',
      enabled: true,
      schedule: { kind: 'cron', expression: '*/5 * * * *', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Run' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      failureCount: 0,
    };

    const rangeStart = new Date(2026, 5, 1, 0, 0, 0, 0);
    const rangeEnd = new Date(2026, 5, 1, 0, 0, 0, 0);
    rangeEnd.setDate(rangeEnd.getDate() + 42);

    const { events, truncated } = buildCalendarEvents({
      activities: [activity],
      recentRuns: [],
      rangeStart,
      rangeEnd,
      includeDisabled: false,
    });

    expect(truncated).toBe(false);

    // There must be fires on the final day of the window (day 41), proving
    // coverage extends past the first week.
    const lastDayStart = new Date(2026, 5, 1, 0, 0, 0, 0);
    lastDayStart.setDate(lastDayStart.getDate() + 41);
    const onLastDay = events.filter(
      (event) =>
        event.at.getTime() >= lastDayStart.getTime() &&
        event.at.getTime() < rangeEnd.getTime(),
    );
    expect(onLastDay.length).toBeGreaterThan(0);

    // Condensed by day, the last day collapses to one group carrying the full
    // count (288 fires).
    const lastDayGroups = groupCalendarEvents(onLastDay, 'day');
    expect(lastDayGroups).toHaveLength(1);
    expect(lastDayGroups[0]?.count).toBe(288);
  });
});

describe('calendarEventInteractionClasses', () => {
  const at = new Date(2026, 5, 25, 9, 0);

  it('dims an enabled occurrence on hover', () => {
    expect(calendarEventInteractionClasses(occurrence('a', at))).toBe(
      'cursor-pointer hover:opacity-90',
    );
  });

  it('dims a paused occurrence below its resting opacity instead of brightening it', () => {
    const event = occurrence('a', at);
    const paused: CalendarEvent = {
      ...event,
      activity: event.activity && { ...event.activity, enabled: false },
    };

    expect(calendarEventToneClasses(paused)).toContain('opacity-50');
    expect(calendarEventInteractionClasses(paused)).toBe(
      'cursor-pointer hover:opacity-40',
    );
    expect(calendarEventInteractionClasses(paused)).not.toContain(
      'hover:opacity-90',
    );
  });

  it('dims a past run of a paused automation from full opacity', () => {
    const event = occurrence('a', at);
    const run: CalendarEvent = {
      ...event,
      kind: 'run',
      runStatus: 'success',
      activity: event.activity && { ...event.activity, enabled: false },
    };

    expect(calendarEventToneClasses(run)).not.toContain('opacity-50');
    expect(calendarEventInteractionClasses(run)).toBe(
      'cursor-pointer hover:opacity-90',
    );
  });

  it('leaves an event without an automation non-interactive', () => {
    const orphan: CalendarEvent = { ...occurrence('a', at), activity: null };

    expect(calendarEventInteractionClasses(orphan)).toBe('cursor-default');
  });
});
