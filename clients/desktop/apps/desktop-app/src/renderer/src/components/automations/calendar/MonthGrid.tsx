import { useMemo, type JSX } from 'react';
import {
  isToday,
  monthGridDays,
  startOfDay,
  startOfMonth,
} from './calendarDateUtils';
import {
  calendarEventChipAttributes,
  calendarEventInteractionClasses,
  calendarEventSelectedClasses,
  calendarEventToneClasses,
  formatEventTime,
  formatGroupCount,
  isCalendarEventClickable,
  type CalendarEvent,
  type CalendarEventGroup,
} from './calendarEvents';
import type { CalendarView } from './calendarPreferences';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import { Button, Surface } from '@canopy/ui-shared/components';

/** Max event chips shown per cell before collapsing into a "+N more" button. */
export const MAX_CHIPS_PER_CELL = 3;

interface MonthGridProps {
  anchorDate: Date;
  /** Condensed fire groups (one chip per group). */
  groups: CalendarEventGroup[];
  now: Date;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
  onAnchorDateChange: (date: Date) => void;
  onCalendarViewChange: (view: CalendarView) => void;
}

interface MonthEventChipProps {
  group: CalendarEventGroup;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
}

function MonthEventChip({
  group,
  selectedActivityId,
  onEventClick,
}: MonthEventChipProps): JSX.Element {
  const event = group.representative;
  const clickable = isCalendarEventClickable(event);
  const selected = selectedActivityId === group.activityId;
  const countLabel = formatGroupCount(group.count);
  const title =
    countLabel === null
      ? `${formatEventTime(group.at)} · ${event.name}`
      : `${formatEventTime(group.at)} · ${event.name} ${countLabel}`;
  return (
    <RichHoverTooltip
      content={title}
      triggerWrapperClassName="w-full"
      surfaceClassName="w-max max-w-80"
      surfacePadding="compact"
    >
      <button
        type="button"
        {...calendarEventChipAttributes(event, selected)}
        data-event-count={group.count}
        onClick={
          clickable
            ? (clickEvent): void => {
                clickEvent.stopPropagation();
                onEventClick(event);
              }
            : undefined
        }
        disabled={!clickable}
        className={`flex w-full items-center gap-1 overflow-hidden rounded border px-1 py-0.5 text-left text-3xs leading-none transition-colors ${calendarEventToneClasses(
          event,
        )} ${calendarEventSelectedClasses(
          selected,
        )} ${calendarEventInteractionClasses(event)}`}
      >
        <span className="shrink-0 tabular-nums opacity-80">
          {formatEventTime(group.at)}
        </span>
        <span className="truncate">{event.name}</span>
        {countLabel !== null && (
          <span className="ml-auto shrink-0 tabular-nums opacity-70">
            {countLabel}
          </span>
        )}
      </button>
    </RichHoverTooltip>
  );
}

/**
 * Six-row (6×7) month grid. Out-of-month days are dimmed; today's date carries
 * a red marker. Each cell shows up to `MAX_CHIPS_PER_CELL` condensed chips, then
 * a "+N more" button that jumps to that day's Day view.
 */
export function MonthGrid({
  anchorDate,
  groups,
  now,
  selectedActivityId,
  onEventClick,
  onAnchorDateChange,
  onCalendarViewChange,
}: MonthGridProps): JSX.Element {
  const days = useMemo(() => monthGridDays(anchorDate), [anchorDate]);
  const currentMonth = startOfMonth(anchorDate).getMonth();
  const weekdayLabels = useMemo(
    () =>
      days
        .slice(0, 7)
        .map((day) => day.toLocaleDateString(undefined, { weekday: 'short' })),
    [days],
  );
  const groupsByDay = useMemo(() => {
    const nextGroupsByDay = new Map<number, CalendarEventGroup[]>();
    for (const group of groups) {
      const key = startOfDay(group.at).getTime();
      const dayGroups = nextGroupsByDay.get(key);
      if (dayGroups === undefined) {
        nextGroupsByDay.set(key, [group]);
      } else {
        dayGroups.push(group);
      }
    }
    return nextGroupsByDay;
  }, [groups]);

  return (
    <Surface variant="outline" className="overflow-hidden">
      <div className="grid grid-cols-7 border-b bg-fg-primary/[0.02]">
        {weekdayLabels.map((label) => (
          <div
            key={label}
            className="px-2 py-1.5 text-center text-3xs fg-secondary "
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth = day.getMonth() === currentMonth;
          const today = isToday(day, now);
          const dayGroups = groupsByDay.get(startOfDay(day).getTime()) ?? [];
          const overflow = dayGroups.length > MAX_CHIPS_PER_CELL;
          const shown = overflow
            ? dayGroups.slice(0, MAX_CHIPS_PER_CELL - 1)
            : dayGroups;
          const moreCount = dayGroups.length - shown.length;
          return (
            <div
              key={day.getTime()}
              className="flex min-h-24 flex-col gap-0.5 border-t border-l p-1 first:border-l-0 [&:nth-child(7n+1)]:border-l-0"
            >
              <div
                className={`mb-0.5 flex h-5 w-5 items-center justify-center self-start rounded-full text-2xs ${
                  today
                    ? 'bg-destructive font-semibold text-white'
                    : inMonth
                      ? 'fg-primary'
                      : 'fg-secondary/50'
                }`}
              >
                {day.getDate()}
              </div>
              {shown.map((group) => (
                <MonthEventChip
                  key={group.key}
                  group={group}
                  selectedActivityId={selectedActivityId}
                  onEventClick={onEventClick}
                />
              ))}
              {moreCount > 0 && (
                // The link takes the cell's 3xs copy size; the inset lines it
                // up with the chips' labels.
                <div className="px-1 py-0.5 text-3xs">
                  <Button
                    variant="link"
                    onClick={(): void => {
                      onAnchorDateChange(day);
                      onCalendarViewChange('day');
                    }}
                  >
                    +{moreCount} more
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Surface>
  );
}
