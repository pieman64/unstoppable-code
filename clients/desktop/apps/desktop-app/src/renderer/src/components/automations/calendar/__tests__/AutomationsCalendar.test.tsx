/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { AutomationsCalendar } from '../AutomationsCalendar';
import type { CalendarView } from '../calendarPreferences';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ANCHOR = new Date(2027, 0, 4, 8, 0);

const ACTIVITY: ScheduledActivity = {
  version: 1,
  id: 'activity-1',
  name: 'Acme payments standup',
  enabled: true,
  schedule: {
    kind: 'one_time',
    runAt: new Date(2027, 0, 4, 10, 0).toISOString(),
    timezone: 'local',
  },
  action: { type: 'app_advisor_prompt', prompt: 'Summarize yesterday' },
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  failureCount: 0,
};

describe('AutomationsCalendar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(calendarView: CalendarView): void {
    act(() => {
      root.render(
        <AutomationsCalendar
          activities={[ACTIVITY]}
          recentRuns={[]}
          calendarView={calendarView}
          anchorDate={ANCHOR}
          showDisabled={false}
          selectedActivityId={null}
          onCalendarViewChange={jest.fn()}
          onAnchorDateChange={jest.fn()}
          onToggleShowDisabled={jest.fn()}
          onEdit={jest.fn()}
          onSelect={jest.fn()}
          describeAction={(): string => 'Pipeline acme-deploy'}
        />,
      );
    });
  }

  function spansWithText(text: string): HTMLSpanElement[] {
    return Array.from(container.querySelectorAll('span')).filter(
      (span) => span.textContent === text,
    );
  }

  it.each<CalendarView>(['day', 'week', 'month', 'schedule'])(
    'shows the automation name in the %s view',
    (view) => {
      render(view);

      expect(spansWithText('Acme payments standup').length).toBeGreaterThan(0);
    },
  );

  it('shows the action description in the schedule agenda', () => {
    render('schedule');

    expect(spansWithText('Pipeline acme-deploy')).toHaveLength(1);
  });
});
