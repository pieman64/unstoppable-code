import { type JSX, type ReactNode } from 'react';
import { Button, Heading } from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons';
import { ToggleSwitch } from '@canopy/ui-shared/components';
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
      <Heading
        level={2}
        variant="title"
        data-testid="automations-calendar-title"
        className="min-w-0 grow"
      >
        {title}
      </Heading>
      {filters}
      <div className="flex items-center gap-1.5 text-xs fg-secondary">
        <ToggleSwitch
          size="sm"
          label="Include off"
          checked={showDisabled}
          onChange={onToggleShowDisabled}
          dataTestId="automations-calendar-show-disabled"
        />
        <span aria-hidden="true">Include off</span>
      </div>
      <CalendarViewPicker
        calendarView={calendarView}
        onChange={onCalendarViewChange}
      />
    </div>
  );
}
