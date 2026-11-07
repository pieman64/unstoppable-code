import { type JSX } from 'react';
import type { AutomationAction } from '@canopy/desktop-shared/types';
import { isSameDay, isToday } from './calendarDateUtils';
import {
  calendarEventChipAttributes,
  calendarEventToneClasses,
  formatGroupCount,
  formatGroupTimeRange,
  isCalendarEventClickable,
  type CalendarEvent,
  type CalendarEventGroup,
} from './calendarEvents';
import { ListRow, Surface } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

interface ScheduleAgendaProps {
  /** Condensed fire groups (one row per group), pre-sorted ascending. */
  groups: CalendarEventGroup[];
  now: Date;
  /**
   * Whether the 30-day window is anchored on today (default / after `Today`),
   * which selects the empty-state copy.
   */
  isAnchoredToday: boolean;
  describeAction: (action: AutomationAction) => string;
  selectedActivityId: string | null;
  onEventClick: (event: CalendarEvent) => void;
}

interface AgendaDay {
  day: Date;
  groups: CalendarEventGroup[];
}

function groupByDay(groups: CalendarEventGroup[]): AgendaDay[] {
  const days: AgendaDay[] = [];
  for (const group of groups) {
    const last = days.length > 0 ? days[days.length - 1] : undefined;
    if (last !== undefined && isSameDay(last.day, group.at)) {
      last.groups.push(group);
    } else {
      days.push({ day: group.at, groups: [group] });
    }
  }
  return days;
}

function secondaryText(
  group: CalendarEventGroup,
  describeAction: (action: AutomationAction) => string,
): string {
  const activity = group.representative.activity;
  if (activity !== null) {
    return describeAction(activity.action);
  }
  return 'Deleted activity';
}

/**
 * Chronological agenda grouped by day — one date header per day, one row per
 * condensed fire group (time · name · "(N times)" · action). Groups arrive
 * pre-sorted ascending, so the day grouping is a single linear pass.
 */
export function ScheduleAgenda({
  groups,
  now,
  isAnchoredToday,
  describeAction,
  selectedActivityId,
  onEventClick,
}: ScheduleAgendaProps): JSX.Element {
  if (groups.length === 0) {
    return (
      <Surface variant="dashed">
        <div className="px-3 py-10 text-center text-s fg-secondary">
          {isAnchoredToday
            ? 'No upcoming triggers in the next 30 days.'
            : 'No triggers in this range.'}
        </div>
      </Surface>
    );
  }

  const days = groupByDay(groups);
  return (
    <Surface
      variant="outline"
      padding="compact"
      gap="group"
      className="overflow-hidden"
    >
      {days.map((agendaDay) => (
        <div key={agendaDay.day.getTime()} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 border-b pb-1">
            <span
              className={`text-s font-semibold ${
                isToday(agendaDay.day, now) ? 'fg-destructive' : 'fg-primary'
              }`}
            >
              {agendaDay.day.toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </div>
          {agendaDay.groups.map((group) => {
            const event = group.representative;
            const clickable = isCalendarEventClickable(event);
            const selected = selectedActivityId === group.activityId;
            const countLabel = formatGroupCount(group.count);
            return (
              <ListRow
                key={group.key}
                {...calendarEventChipAttributes(event, selected)}
                data-event-count={group.count}
                selected={selected}
                onClick={
                  clickable
                    ? (clickEvent): void => {
                        clickEvent.stopPropagation();
                        onEventClick(event);
                      }
                    : undefined
                }
                disabled={!clickable}
                icon={
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full border ${calendarEventToneClasses(
                      event,
                    )}`}
                  />
                }
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="shrink-0 tabular-nums whitespace-nowrap fg-secondary">
                    {formatGroupTimeRange(group)}
                  </span>
                  <span className="shrink-0 font-medium fg-primary">
                    {event.name}
                  </span>
                  {countLabel !== null && (
                    <span className="shrink-0 tabular-nums fg-secondary">
                      {countLabel}
                    </span>
                  )}
                  <span
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} min-w-0 truncate fg-secondary`}
                  >
                    {secondaryText(group, describeAction)}
                  </span>
                </span>
              </ListRow>
            );
          })}
        </div>
      ))}
    </Surface>
  );
}
