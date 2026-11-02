/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { formatTimingTimestamp } from '../../lib/pipeline-timing-display';
import { PipelineDispatchedTime } from '../PipelineDispatchedTime';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const STARTED_AT = '2026-06-03T01:00:00.000Z';
const TWO_HOURS_LATER = Date.parse(STARTED_AT) + 2 * 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function hoverTooltipText(target: Element | null): string | null | undefined {
  jest.useFakeTimers();
  try {
    act(() => {
      target?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(500));
    return document.body.querySelector('[role="tooltip"]')?.textContent;
  } finally {
    jest.useRealTimers();
  }
}

describe('PipelineDispatchedTime', () => {
  it('labels the relative start time as dispatched', () => {
    render(
      <PipelineDispatchedTime
        startedAt={STARTED_AT}
        now={TWO_HOURS_LATER}
        testId="dispatched"
      />,
    );
    const time = container.querySelector('time');
    expect(time?.dateTime).toBe(STARTED_AT);
    expect(time?.textContent).toBe('Dispatched 2h ago');
    expect(time?.getAttribute('data-testid')).toBe('dispatched');
  });

  it('shows the exact start time on hover', () => {
    render(
      <PipelineDispatchedTime startedAt={STARTED_AT} now={TWO_HOURS_LATER} />,
    );
    expect(hoverTooltipText(container.querySelector('time'))).toBe(
      formatTimingTimestamp(STARTED_AT),
    );
  });

  it.each([[''], ['not-a-date'], [undefined]])(
    'renders nothing for an unknown start (%p)',
    (startedAt) => {
      render(
        <PipelineDispatchedTime startedAt={startedAt} now={TWO_HOURS_LATER} />,
      );
      expect(container.innerHTML).toBe('');
    },
  );

  it('still renders a start that is ahead of the local clock', () => {
    render(
      <PipelineDispatchedTime
        startedAt={STARTED_AT}
        now={Date.parse(STARTED_AT) - 60 * 1000}
      />,
    );
    const time = container.querySelector('time');
    expect(time?.dateTime).toBe(STARTED_AT);
    expect(hoverTooltipText(time)).toBe(formatTimingTimestamp(STARTED_AT));
  });

  it('right-aligns the menu variant and keeps the row variant inline', () => {
    render(
      <PipelineDispatchedTime
        startedAt={STARTED_AT}
        now={TWO_HOURS_LATER}
        variant="menu"
      />,
    );
    const menuTime = container.querySelector('time');
    expect(menuTime?.parentElement?.className).toContain('ml-auto');
    expect(menuTime?.className).toContain('text-3xs');

    render(
      <PipelineDispatchedTime startedAt={STARTED_AT} now={TWO_HOURS_LATER} />,
    );
    const rowTime = container.querySelector('time');
    expect(rowTime?.parentElement?.className).not.toContain('ml-auto');
    expect(rowTime?.className).toContain('text-2xs');
  });
});
