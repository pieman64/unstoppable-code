// Sticky, renderer-only view toggles for the Automations Triggered tab.
//
// These are lightweight presentation preferences, so they live in
// `localStorage` (the established renderer pattern — see
// `components/plan-explore/planExploreLayout.ts`) rather than the persisted
// `preferences.json`. Each reader tolerates corrupt/absent state by falling
// back to the documented default.

import { LEGACY_AUTOMATIONS_VIEW_MODE_KEY } from '@/lib/navigation/workflows-target';

/** Top-level view of the Triggered tab. */
export type AutomationsViewMode = 'list' | 'calendar';

/** Calendar sub-view, mirroring Google Calendar's view picker. */
export type CalendarView = 'day' | 'week' | 'month' | 'schedule';

const VIEW_MODE_KEY = LEGACY_AUTOMATIONS_VIEW_MODE_KEY;
const CALENDAR_VIEW_KEY = 'canopy.automations.calendarView';

const VIEW_MODES: readonly AutomationsViewMode[] = ['list', 'calendar'];
const CALENDAR_VIEWS: readonly CalendarView[] = [
  'day',
  'week',
  'month',
  'schedule',
];

function isViewMode(value: string | null): value is AutomationsViewMode {
  return value !== null && VIEW_MODES.some((mode) => mode === value);
}

function isCalendarView(value: string | null): value is CalendarView {
  return value !== null && CALENDAR_VIEWS.some((view) => view === value);
}

/** Last-used view mode; defaults to `'list'`. */
export function loadViewMode(): AutomationsViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY);
    if (isViewMode(raw)) {
      return raw;
    }
  } catch {
    // ignore corrupt / unavailable storage
  }
  return 'list';
}

export function saveViewMode(mode: AutomationsViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // ignore quota errors
  }
}

/** Last-used calendar sub-view; defaults to `'week'`. */
export function loadCalendarView(): CalendarView {
  try {
    const raw = localStorage.getItem(CALENDAR_VIEW_KEY);
    if (isCalendarView(raw)) {
      return raw;
    }
  } catch {
    // ignore corrupt / unavailable storage
  }
  return 'week';
}

export function saveCalendarView(view: CalendarView): void {
  try {
    localStorage.setItem(CALENDAR_VIEW_KEY, view);
  } catch {
    // ignore quota errors
  }
}
