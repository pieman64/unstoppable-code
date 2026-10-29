import { useMemo, type JSX, type ReactNode } from 'react';
import type {
  AutomationAction,
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  addDays,
  addMonths,
  dayWindow,
  formatDayTitle,
  formatMonthTitle,
  formatScheduleTitle,
  formatWeekTitle,
  isSameDay,
  monthGridWindow,
  scheduleWindow,
  startOfDay,
  startOfWeek,
  weekWindow,
  type DateWindow,
} from './calendarDateUtils';
import {
  buildCalendarEvents,
  groupCalendarEvents,
  type CalendarBucket,
  type CalendarEvent,
} from './calendarEvents';
import type { CalendarView } from './calendarPreferences';
import { CalendarToolbar } from './CalendarToolbar';
import { DayWeekTimeGrid } from './DayWeekTimeGrid';
import { MonthGrid } from './MonthGrid';
import { ScheduleAgenda } from './ScheduleAgenda';
import { useNowTick } from './useNowTick';

interface AutomationsCalendarProps {
  activities: ScheduledActivity[];
  recentRuns: ScheduledActivityRun[];
  calendarView: CalendarView;
  anchorDate: Date;
  showDisabled: boolean;
  /** Reserved for selection highlighting; kept for parity with the table. */
  selectedActivityId: string | null;
  onCalendarViewChange: (view: CalendarView) => void;
  onAnchorDateChange: (date: Date) => void;
  onToggleShowDisabled: (showDisabled: boolean) => void;
  onEdit: (activity: ScheduledActivity) => void;
  /**
   * Opens the result of a recorded run. With it, a past or running chip
   * opens that run instead of calling `onEdit`; upcoming chips still edit.
   */
  onOpenRun?: (runId: string) => void;
  onSelect: (id: string | null) => void;
  describeAction: (action: AutomationAction) => string;
  /** Host filters for the toolbar (the Workflows Schedule's Project filter). */
  toolbarFilters?: ReactNode;
}

function computeWindow(view: CalendarView, anchor: Date): DateWindow {
  switch (view) {
    case 'day':
      return dayWindow(anchor);
    case 'week':
      return weekWindow(anchor);
    case 'month':
      return monthGridWindow(anchor);
    case 'schedule':
      return scheduleWindow(anchor);
  }
}

function computeTitle(view: CalendarView, anchor: Date): string {
  switch (view) {
    case 'day':
      return formatDayTitle(anchor);
    case 'week':
      return formatWeekTitle(anchor);
    case 'month':
      return formatMonthTitle(anchor);
    case 'schedule':
      return formatScheduleTitle(anchor);
  }
}

/** Days, in display order, for the Day (one) / Week (seven) time grid. */
function timeGridDays(view: 'day' | 'week', anchor: Date): Date[] {
  if (view === 'day') {
    return [startOfDay(anchor)];
  }
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_unused, index) => addDays(start, index));
}

/** Next anchor for prev (`-1`) / next (`+1`), branching on the sub-view span. */
function shiftAnchor(
  view: CalendarView,
  anchor: Date,
  direction: number,
): Date {
  switch (view) {
    case 'day':
      return addDays(anchor, direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'month':
      return addMonths(anchor, direction);
    case 'schedule':
      return addDays(anchor, 30 * direction);
  }
}

/**
 * Controlled container for the calendar view. Computes the visible window from
 * `(calendarView, anchorDate)`, memoizes occurrence enumeration + past-run
 * overlay (keyed on window milliseconds + inputs — never on `now`), and
 * renders the toolbar, the active sub-view, and an informational truncation
 * banner.
 */
export function AutomationsCalendar({
  activities,
  recentRuns,
  calendarView,
  anchorDate,
  showDisabled,
  selectedActivityId,
  onCalendarViewChange,
  onAnchorDateChange,
  onToggleShowDisabled,
  onEdit,
  onOpenRun,
  onSelect,
  describeAction,
  toolbarFilters,
}: AutomationsCalendarProps): JSX.Element {
  const now = useNowTick();

  const viewWindow = useMemo(
    () => computeWindow(calendarView, anchorDate),
    [calendarView, anchorDate],
  );
  const windowStartMs = viewWindow.start.getTime();
  const windowEndMs = viewWindow.end.getTime();
  const title = useMemo(
    () => computeTitle(calendarView, anchorDate),
    [calendarView, anchorDate],
  );

  // Intentionally NOT keyed on `now`: the now-line ticks each minute but must
  // not re-run occurrence expansion. Re-runs only on navigate / view change /
  // show-disabled toggle / data mutation.
  const { events, truncated } = useMemo(
    () =>
      buildCalendarEvents({
        activities,
        recentRuns,
        rangeStart: new Date(windowStartMs),
        rangeEnd: new Date(windowEndMs),
        includeDisabled: showDisabled,
      }),
    [activities, recentRuns, windowStartMs, windowEndMs, showDisabled],
  );

  // Only the Month overview buckets fires by day; Day / Week time grids and the
  // Schedule agenda bucket by hour, so a short-interval automation reads as one
  // "(N times)" row per hour rather than a single all-day row. Condensing keeps
  // short-interval automations from flooding the view. Keyed off `events` +
  // `bucket`, never `now`.
  const bucket: CalendarBucket = calendarView === 'month' ? 'day' : 'hour';
  const groups = useMemo(
    () => groupCalendarEvents(events, bucket),
    [events, bucket],
  );

  const handleEventClick = (event: CalendarEvent): void => {
    // A recorded run, running ones included, opens what that run did.
    if (onOpenRun && event.kind === 'run' && event.runId !== undefined) {
      if (event.activity !== null) onSelect(event.activity.id);
      onOpenRun(event.runId);
      return;
    }
    if (event.activity === null) {
      return;
    }
    onSelect(event.activity.id);
    onEdit(event.activity);
  };

  const handlePrev = (): void => {
    onAnchorDateChange(shiftAnchor(calendarView, anchorDate, -1));
  };
  const handleNext = (): void => {
    onAnchorDateChange(shiftAnchor(calendarView, anchorDate, 1));
  };
  const handleToday = (): void => {
    onAnchorDateChange(new Date());
  };

  return (
    <div data-testid="automations-calendar" className="flex flex-col gap-3">
      <CalendarToolbar
        title={title}
        calendarView={calendarView}
        showDisabled={showDisabled}
        onToday={handleToday}
        onPrev={handlePrev}
        onNext={handleNext}
        onCalendarViewChange={onCalendarViewChange}
        onToggleShowDisabled={onToggleShowDisabled}
        filters={toolbarFilters}
      />
      {truncated && (
        <div
          data-testid="automations-calendar-truncated-banner"
          role="status"
          className="rounded-md border border-line-attention/40 bg-warning-subtle px-3 py-2 text-xs fg-warning"
        >
          Some automations have more occurrences than can be shown in this
          range.
        </div>
      )}
      {(calendarView === 'day' || calendarView === 'week') && (
        <DayWeekTimeGrid
          days={timeGridDays(calendarView, anchorDate)}
          groups={groups}
          now={now}
          selectedActivityId={selectedActivityId}
          onEventClick={handleEventClick}
        />
      )}
      {calendarView === 'month' && (
        <MonthGrid
          anchorDate={anchorDate}
          groups={groups}
          now={now}
          selectedActivityId={selectedActivityId}
          onEventClick={handleEventClick}
          onAnchorDateChange={onAnchorDateChange}
          onCalendarViewChange={onCalendarViewChange}
        />
      )}
      {calendarView === 'schedule' && (
        <ScheduleAgenda
          groups={groups}
          now={now}
          isAnchoredToday={isSameDay(anchorDate, now)}
          describeAction={describeAction}
          selectedActivityId={selectedActivityId}
          onEventClick={handleEventClick}
        />
      )}
    </div>
  );
}
