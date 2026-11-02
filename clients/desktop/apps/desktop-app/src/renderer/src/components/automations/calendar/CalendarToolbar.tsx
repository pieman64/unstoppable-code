import { type JSX, type ReactNode } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons';
import { CalendarViewPicker } from './CalendarViewPicker';
import type { CalendarView } from './calendarPreferences';

interface CalendarToolbarProps {
  title: string;
  calendarView: CalendarView;
  showDisabled: boolean;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCalendarViewChange: (view: CalendarView) => void;
  onToggleShowDisabled: (showDisabled: boolean) => void;
  /** Host filters, placed before the show-disabled toggle. */
  filters?: ReactNode;
}

/**
 * Top bar of the calendar: `Today` button, prev/next chevrons, the view title,
 * a "Show disabled" toggle, and the Day/Week/Month/Schedule view picker.
 */
export function CalendarToolbar({
  title,
  calendarView,
  showDisabled,
  onToday,
  onPrev,
  onNext,
  onCalendarViewChange,
  onToggleShowDisabled,
  filters,
}: CalendarToolbarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="compact"
        onClick={(): void => onToday()}
        data-testid="automations-calendar-today"
      >
        Today
      </Button>
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={(): void => onPrev()}
          aria-label="Previous"
          data-testid="automations-calendar-prev"
        >
          <ChevronRightIcon width={16} height={16} className="-scale-x-100" />
        </Button>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={(): void => onNext()}
          aria-label="Next"
          data-testid="automations-calendar-next"
        >
          <ChevronRightIcon width={16} height={16} />
        </Button>
      </div>
      <h2
        data-testid="automations-calendar-title"
        className="min-w-0 grow text-s font-semibold fg-primary"
      >
        {title}
      </h2>
      {filters}
      <label
        className="flex cursor-pointer items-center gap-1.5 text-xs fg-secondary select-none"
        data-testid="automations-calendar-show-disabled"
      >
        <input
          type="checkbox"
          checked={showDisabled}
          onChange={(event): void => onToggleShowDisabled(event.target.checked)}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span>Include off</span>
      </label>
      <CalendarViewPicker
        calendarView={calendarView}
        onChange={onCalendarViewChange}
      />
    </div>
  );
}
