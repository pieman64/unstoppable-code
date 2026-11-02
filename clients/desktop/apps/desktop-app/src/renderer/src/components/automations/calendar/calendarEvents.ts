// Calendar event model shared by every Automations calendar sub-view.
//
// A "calendar event" is a single fire plotted on the calendar. It is either:
//  - an `occurrence`: a predicted future fire enumerated from the cron/one-time
//    trigger via the shared `enumerateAutomationOccurrences` helper, or
//  - a `run`: a historical fire pulled from `recentRuns`, carrying the real
//    terminal status (and possibly orphaned if its activity was deleted).
//
// `buildCalendarEvents` merges both sources within a window and de-dupes
// already-fired occurrences against runs so each fire renders as a single chip.

import { enumerateAutomationOccurrences } from '@canopy/desktop-shared/lib/automations';
import type {
  AutomationRunStatus,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';

/** Predicted future fire vs. historical `recentRuns` fire. */
export type CalendarEventKind = 'occurrence' | 'run';

export interface CalendarEvent {
  /** Stable React key (kind-prefixed so an occurrence and run never collide). */
  key: string;
  kind: CalendarEventKind;
  /** Owning activity id — set even for orphan runs so chips stay locatable. */
  activityId: string;
  /** Resolved live activity; always set for occurrences, null for orphan runs. */
  activity: ScheduledActivity | null;
  /** Display label: the activity name, or the run's captured name when orphaned. */
  name: string;
  /** Local instant the fire occurs / occurred. */
  at: Date;
  /** Terminal status for `run` events; null for occurrences. */
  runStatus: AutomationRunStatus | null;
  /** True when a `run`'s `activityId` no longer resolves to a live activity. */
  activityDeleted: boolean;
  /** The recorded run a `run` event stands for; absent for occurrences. */
  runId?: string;
}

export interface BuildCalendarEventsParams {
  activities: ScheduledActivity[];
  recentRuns: ScheduledActivityRun[];
  rangeStart: Date;
  rangeEnd: Date;
  includeDisabled: boolean;
}

export interface BuildCalendarEventsResult {
  events: CalendarEvent[];
  /** Informational: some activity hit its per-activity occurrence cap. */
  truncated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// A minute-granularity cron fires at most 1440×/day, so this (with headroom)
// lets the per-activity occurrence cap scale to the visible window. Without
// scaling, the shared default cap is exhausted within the first few days for a
// short-interval cron, so Month/Week views stop showing it past the first week.
const MAX_OCCURRENCES_PER_ACTIVITY_PER_DAY = 1500;

/**
 * Per-activity occurrence cap sized to the visible window so every day that has
 * fires is represented — not just until a fixed global cap runs out. A 42-day
 * month grid of an every-minute cron (~60k fires) is fully covered; the cap
 * stays a backstop against pathological sub-minute inputs.
 */
function windowOccurrenceCap(rangeStart: Date, rangeEnd: Date): number {
  const span = rangeEnd.getTime() - rangeStart.getTime();
  const days = Math.max(1, Math.ceil(span / DAY_MS));
  return days * MAX_OCCURRENCES_PER_ACTIVITY_PER_DAY;
}

/**
 * Merge enumerated occurrences and past runs within `[rangeStart, rangeEnd)`
 * into a single, time-sorted list of {@link CalendarEvent}s.
 *
 * De-dupe: the window can cover already-fired days, so `enumerateAutomationOccurrences`
 * may predict an occurrence that also exists as a `recentRuns` entry. We build a
 * key set from the in-window runs (`${activityId}:${scheduledFor ms}`) and drop
 * any enumerated occurrence whose `${activity.id}:${occursAt ms}` key collides,
 * keeping the run (it carries the real status). Cron `occursAt` and run
 * `scheduledFor` are both minute-aligned local instants from the same cron math,
 * so the keys for one fire match exactly.
 */
export function buildCalendarEvents(
  params: BuildCalendarEventsParams,
): BuildCalendarEventsResult {
  const { activities, recentRuns, rangeStart, rangeEnd, includeDisabled } =
    params;

  const { occurrences, truncated } = enumerateAutomationOccurrences(
    activities,
    {
      rangeStart,
      rangeEnd,
      includeDisabled,
      maxOccurrencesPerActivity: windowOccurrenceCap(rangeStart, rangeEnd),
    },
  );

  const activityById = new Map<string, ScheduledActivity>();
  for (const activity of activities) {
    activityById.set(activity.id, activity);
  }

  const rangeStartTime = rangeStart.getTime();
  const rangeEndTime = rangeEnd.getTime();

  // Past-run overlay + de-dupe key set, built only from runs we actually keep.
  const runKeys = new Set<string>();
  const runEvents: CalendarEvent[] = [];
  for (const run of recentRuns) {
    const at = new Date(run.scheduledFor);
    const atTime = at.getTime();
    if (Number.isNaN(atTime)) {
      continue;
    }
    if (atTime < rangeStartTime || atTime >= rangeEndTime) {
      continue;
    }
    const activity = activityById.get(run.activityId) ?? null;
    runKeys.add(`${run.activityId}:${atTime}`);
    runEvents.push({
      key: `run:${run.id}`,
      kind: 'run',
      activityId: run.activityId,
      activity,
      name: activity?.name ?? run.activityName,
      at,
      runStatus: run.status,
      activityDeleted: activity === null,
      runId: run.id,
    });
  }

  const occurrenceEvents: CalendarEvent[] = [];
  for (const occurrence of occurrences) {
    if (runKeys.has(occurrence.key)) {
      continue;
    }
    occurrenceEvents.push({
      key: `occurrence:${occurrence.key}`,
      kind: 'occurrence',
      activityId: occurrence.activity.id,
      activity: occurrence.activity,
      name: occurrence.activity.name,
      at: occurrence.occursAt,
      runStatus: null,
      activityDeleted: false,
    });
  }

  const events = [...occurrenceEvents, ...runEvents].sort(
    (left, right) => left.at.getTime() - right.at.getTime(),
  );

  return { events, truncated };
}

/** Whether an event opens the edit form on click (orphan runs never do). */
export function isCalendarEventClickable(event: CalendarEvent): boolean {
  return event.activity !== null;
}

/** Stable DOM hooks shared by every rendered chip / agenda row. */
export interface CalendarEventChipAttributes {
  'data-testid': 'automations-calendar-event';
  'data-activity-id': string;
  'data-event-kind': CalendarEventKind;
  'aria-selected'?: true;
  'data-selected'?: 'true';
  'data-run-status'?: AutomationRunStatus;
  'data-activity-deleted'?: 'true';
}

/**
 * The `data-*` attribute bag that every chip / agenda row spreads onto its
 * root, so the Electron suite can count, filter, and click events uniformly.
 */
export function calendarEventChipAttributes(
  event: CalendarEvent,
  selected = false,
): CalendarEventChipAttributes {
  const attributes: CalendarEventChipAttributes = {
    'data-testid': 'automations-calendar-event',
    'data-activity-id': event.activityId,
    'data-event-kind': event.kind,
  };
  if (selected) {
    attributes['aria-selected'] = true;
    attributes['data-selected'] = 'true';
  }
  if (event.runStatus !== null) {
    attributes['data-run-status'] = event.runStatus;
  }
  if (event.activityDeleted) {
    attributes['data-activity-deleted'] = 'true';
  }
  return attributes;
}

/**
 * Tailwind classes for an event's border/background/text. Upcoming occurrences
 * are sky; runs are status-colored (green / red / grey / sky) so they read
 * distinctly from predicted fires. Disabled occurrences are dimmed + dashed.
 */
export function calendarEventToneClasses(event: CalendarEvent): string {
  if (event.kind === 'run') {
    switch (event.runStatus) {
      case 'success':
        return 'border-fg-success-strong/50 bg-success-subtle fg-success-strong';
      case 'failure':
        return 'border-line-destructive bg-destructive-subtle fg-destructive';
      case 'running':
        return 'border-fg-info/50 bg-info-subtle fg-info';
      case 'missed':
        return 'bg-warning-subtle fg-warning';
      case 'skipped':
      case 'canceled':
      default:
        return 'bg-fg-primary/[0.06] fg-secondary';
    }
  }
  const disabled = isPausedOccurrence(event) ? ' border-dashed opacity-50' : '';
  return `border-fg-info/40 bg-info-subtle fg-info${disabled}`;
}

/**
 * A predicted fire of a paused automation. It rests at `opacity-50`
 * (`calendarEventToneClasses`), so its hover dim starts from there
 * (`calendarEventInteractionClasses`).
 */
function isPausedOccurrence(event: CalendarEvent): boolean {
  return (
    event.kind === 'occurrence' &&
    event.activity !== null &&
    !event.activity.enabled
  );
}

/** Selection treatment matching the Triggered table's selected-row affordance. */
export function calendarEventSelectedClasses(selected: boolean): string {
  return selected
    ? 'ring-2 ring-line-selected ring-offset-1 ring-offset-base'
    : '';
}

/**
 * Cursor and hover classes for a grid chip. Hover dims one step below the
 * chip's resting opacity, instantly, and never brightens: 100% to 90%, and a
 * paused occurrence 50% to 40% rather than up to 90%.
 */
export function calendarEventInteractionClasses(event: CalendarEvent): string {
  if (!isCalendarEventClickable(event)) {
    return 'cursor-default';
  }
  return isPausedOccurrence(event)
    ? 'cursor-pointer hover:opacity-40'
    : 'cursor-pointer hover:opacity-90';
}

/** Short local time label, e.g. "9:00 AM". */
export function formatEventTime(at: Date): string {
  return at.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Occurrence condensing — collapse repeated fires of one automation per bucket
// ---------------------------------------------------------------------------
//
// Short-interval automations (e.g. an every-5-minute cron) would otherwise
// flood a column / cell with chips. Each view condenses fires of the SAME
// activity that land in the same time bucket into a single chip carrying a
// "(N times)" indicator. The bucket granularity depends on the view: the Day /
// Week time grids and the Schedule agenda bucket by hour; only the Month
// overview buckets by day. Occurrence and run fires never merge (different
// `kind`), so a condensed chip always keeps a single, coherent tone.

/** Bucket granularity for condensing repeated fires. */
export type CalendarBucket = 'hour' | 'day';

/** A condensed set of same-activity, same-kind fires within one time bucket. */
export interface CalendarEventGroup {
  /** Stable React key. */
  key: string;
  /** Owning activity id (shared by every event in the group). */
  activityId: string;
  /** Earliest instant in the bucket — drives positioning and the start label. */
  at: Date;
  /**
   * Latest instant in the bucket. Equals `at` for a single fire; for a
   * condensed group it is the last scheduled fire, so a time-grid block can
   * span the whole range and the label can read "9:00 AM – 9:55 AM".
   */
  endsAt: Date;
  /**
   * Event chosen for tone / attributes / click. For run groups this is the
   * most-severe-status fire; for occurrence groups it is the earliest.
   */
  representative: CalendarEvent;
  /** Number of fires condensed into this group (always >= 1). */
  count: number;
}

// Higher = more attention-worthy; drives both the representative pick and the
// condensed chip's tone for run groups that mix statuses within one bucket.
const RUN_STATUS_SEVERITY: Record<AutomationRunStatus, number> = {
  failure: 5,
  missed: 4,
  running: 3,
  canceled: 2,
  skipped: 1,
  success: 0,
};

function bucketKeyFor(at: Date, bucket: CalendarBucket): string {
  const base = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
  return bucket === 'hour' ? `${base}-${at.getHours()}` : base;
}

function runSeverity(event: CalendarEvent): number {
  return event.runStatus === null ? -1 : RUN_STATUS_SEVERITY[event.runStatus];
}

/**
 * Condense `events` into per-(activity, kind, bucket) groups. An event alone in
 * its bucket becomes a group of one (count 1). Groups are returned sorted
 * ascending by their earliest instant.
 */
export function groupCalendarEvents(
  events: CalendarEvent[],
  bucket: CalendarBucket,
): CalendarEventGroup[] {
  const byKey = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = `${event.kind}:${event.activityId}:${bucketKeyFor(
      event.at,
      bucket,
    )}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, [event]);
    } else {
      existing.push(event);
    }
  }

  const groups: CalendarEventGroup[] = [];
  byKey.forEach((bucketEvents, key) => {
    const sorted = [...bucketEvents].sort(
      (left, right) => left.at.getTime() - right.at.getTime(),
    );
    const earliest = sorted[0];
    const latest = sorted[sorted.length - 1];
    if (earliest === undefined || latest === undefined) {
      return;
    }
    let representative = earliest;
    if (earliest.kind === 'run') {
      for (const event of sorted) {
        if (runSeverity(event) > runSeverity(representative)) {
          representative = event;
        }
      }
    }
    groups.push({
      key: `group:${key}`,
      activityId: earliest.activityId,
      at: earliest.at,
      endsAt: latest.at,
      representative,
      count: sorted.length,
    });
  });

  groups.sort((left, right) => left.at.getTime() - right.at.getTime());
  return groups;
}

/**
 * "(N times)" suffix for a condensed group, or `null` when the group is a
 * single fire (so callers can render the plain name without a redundant "(1
 * times)").
 */
export function formatGroupCount(count: number): string | null {
  return count > 1 ? `(${count} times)` : null;
}

/**
 * Time label for a group: a single time for one fire, or a "first – last"
 * range spanning the condensing window for a condensed group (e.g.
 * "9:00 AM – 9:55 AM").
 */
export function formatGroupTimeRange(group: CalendarEventGroup): string {
  const start = formatEventTime(group.at);
  if (group.endsAt.getTime() <= group.at.getTime()) {
    return start;
  }
  return `${start} – ${formatEventTime(group.endsAt)}`;
}
