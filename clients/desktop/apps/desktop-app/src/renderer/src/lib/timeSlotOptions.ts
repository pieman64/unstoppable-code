// The quarter-hour time choices of a one-time schedule, shared by the
// Schedule message dialog and the automation form so both offer the same
// `Select` in place of a native time input.

import {
  toIsoDateValue,
  type SelectOption,
} from '@canopy/ui-shared/components';

/** A time picker offers a time every quarter hour. */
const TIME_SLOT_STEP_MINUTES = 15;
const MINUTES_PER_DAY = 24 * 60;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function slotValue(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A local time of day as `HH:MM`, the value a time field holds. */
export function toTimeSlotValue(date: Date): string {
  return slotValue(minutesOfDay(date));
}

let timeLabelFormat: Intl.DateTimeFormat | null = null;

function timeLabel(value: string): string {
  timeLabelFormat ??= new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const [hours = 0, minutes = 0] = value.split(':').map(Number);
  return timeLabelFormat.format(new Date(2000, 0, 1, hours, minutes));
}

/**
 * The first quarter hour at least five minutes after `now`, so a new
 * schedule defaults to a time that is still in the future when it is saved.
 */
export function defaultScheduleRunAt(now: Date = new Date()): Date {
  const earliest = new Date(now.getTime() + 5 * 60 * 1000);
  const minutes = minutesOfDay(earliest);
  const rounded =
    Math.ceil(minutes / TIME_SLOT_STEP_MINUTES) * TIME_SLOT_STEP_MINUTES -
    minutes;
  earliest.setMinutes(earliest.getMinutes() + rounded, 0, 0);
  return earliest;
}

/**
 * The latest time that has passed on `date`, as `HH:MM`: now on today, and
 * `null` on any other day.
 */
export function passedTimeOn(
  date: string,
  now: Date = new Date(),
): string | null {
  return date === toIsoDateValue(now) ? toTimeSlotValue(now) : null;
}

/**
 * Every quarter hour of the day as `Select` options, plus each `keep` time
 * (a saved time off the quarter hour stays selectable). Times up to `passed`
 * (from `passedTimeOn`) stay listed but can't be chosen.
 */
export function buildTimeSlotOptions({
  keep = [],
  passed = null,
}: {
  /** `HH:MM` times to list even when they are off the quarter hour. */
  readonly keep?: readonly string[];
  readonly passed?: string | null;
}): SelectOption[] {
  const slots = new Set<string>(keep.filter((time) => time !== ''));
  for (
    let minutes = 0;
    minutes < MINUTES_PER_DAY;
    minutes += TIME_SLOT_STEP_MINUTES
  ) {
    slots.add(slotValue(minutes));
  }
  return [...slots].sort().map((slot) => ({
    value: slot,
    label: timeLabel(slot),
    disabled: passed !== null && slot <= passed,
  }));
}
