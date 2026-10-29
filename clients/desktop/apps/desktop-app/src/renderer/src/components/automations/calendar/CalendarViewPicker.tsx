import { useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import { useAnchoredMenu } from '@/hooks/useAnchoredMenu';
import type { CalendarView } from './calendarPreferences';

const VIEW_LABELS: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  schedule: 'Schedule',
};

const VIEW_ORDER: readonly CalendarView[] = [
  'day',
  'week',
  'month',
  'schedule',
];

const MENU_WIDTH = 160;

interface CalendarViewPickerProps {
  calendarView: CalendarView;
  onChange: (view: CalendarView) => void;
}

/**
 * Google-Calendar-style "Week ▾" dropdown of Day / Week / Month / Schedule.
 * Uses the shared `useAnchoredMenu` hook (same pattern as `StatusBadgeDropdown`
 * in `AutomationsPage`) so positioning + outside-click-close behave identically.
 */
export function CalendarViewPicker({
  calendarView,
  onChange,
}: CalendarViewPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredMenu(
    open,
    setOpen,
    anchorRef,
    menuRef,
    MENU_WIDTH,
  );

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(): void => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="automations-calendar-view-picker"
        className="focus-ring inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium fg-primary transition hover:bg-secondary"
      >
        <span>{VIEW_LABELS[calendarView]}</span>
        <ChevronDownIcon width={12} height={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            onClick={(event): void => event.stopPropagation()}
            className="rounded-lg bg-popover p-1 shadow-lg"
            style={{
              position: 'fixed',
              zIndex: 'var(--z-index-dropdown)',
              width: MENU_WIDTH,
              ...(position
                ? { top: position.top, left: position.left }
                : { visibility: 'hidden' }),
            }}
          >
            {VIEW_ORDER.map((view) => {
              const selected = view === calendarView;
              return (
                <button
                  key={view}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={`automations-calendar-view-${view}`}
                  onClick={(): void => {
                    setOpen(false);
                    onChange(view);
                  }}
                  className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-secondary ${
                    selected ? 'bg-secondary fg-primary' : 'fg-primary'
                  }`}
                >
                  {VIEW_LABELS[view]}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
