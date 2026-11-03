/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CalendarViewPicker } from '../CalendarViewPicker';

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
  document.body.innerHTML = '';
});

function trigger(): HTMLButtonElement {
  const button = document.querySelector(
    '[data-testid="automations-calendar-view-picker"]',
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('calendar view trigger not found');
  }
  return button;
}

describe('CalendarViewPicker', () => {
  it('opens a listbox of views with the current one selected, and picks one', () => {
    const onChange = jest.fn();
    act(() => {
      root.render(
        <CalendarViewPicker calendarView="week" onChange={onChange} />,
      );
    });

    act(() => trigger().click());
    const menu = document.querySelector(
      '[data-testid="automations-calendar-view-menu"]',
    );
    expect(menu?.getAttribute('role')).toBe('listbox');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(
      document
        .querySelector('[data-testid="automations-calendar-view-week"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');

    const month = document.querySelector<HTMLButtonElement>(
      '[data-testid="automations-calendar-view-month"]',
    );
    act(() => month?.click());

    expect(onChange).toHaveBeenCalledWith('month');
    expect(
      document.querySelector('[data-testid="automations-calendar-view-menu"]'),
    ).toBeNull();
  });

  it('closes on Escape without changing the view', () => {
    const onChange = jest.fn();
    act(() => {
      root.render(
        <CalendarViewPicker calendarView="week" onChange={onChange} />,
      );
    });

    act(() => trigger().click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(
      document.querySelector('[data-testid="automations-calendar-view-menu"]'),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
