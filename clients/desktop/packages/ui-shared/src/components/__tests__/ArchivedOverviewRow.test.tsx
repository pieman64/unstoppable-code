/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ARCHIVED_ROW_ACTIONS_RESERVE_WIDE,
  ArchivedOverviewRow,
} from '../ArchivedOverviewRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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

it('renders an openable row that reserves the action slot on wide and touch layouts', () => {
  const onOpen = jest.fn();
  act(() =>
    root.render(
      <ArchivedOverviewRow
        state="deleted"
        title="Deleted task"
        stateTooltip="Removed soon"
        stateTestId="row-state"
        date="Sep 16, 2026"
        dateTooltip="Deleted Sep 16, 2026"
        trailing={<span data-testid="row-trailing">12 MB</span>}
        onOpen={onOpen}
        openTestId="row-open"
        actions={<button type="button">⋯</button>}
        testId="row"
      />,
    ),
  );
  const row = container.querySelector('[data-testid="row"]');
  expect(row?.getAttribute('data-state')).toBe('deleted');
  expect(row?.className).toContain('pointer-coarse:min-h-11');
  const open = container.querySelector('[data-testid="row-open"]');
  expect(open).toBeInstanceOf(HTMLButtonElement);
  expect(open?.className).toContain(ARCHIVED_ROW_ACTIONS_RESERVE_WIDE);
  expect(open?.className).toContain('pointer-coarse:pr-12');
  expect(
    container
      .querySelector('[data-testid="row-state"]')
      ?.getAttribute('aria-label'),
  ).toBe('Deleted');
  expect(
    container.querySelector('[data-testid="row-trailing"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[title="Deleted Sep 16, 2026"]')?.className,
  ).toContain('tabular-nums');
  if (!(open instanceof HTMLButtonElement)) throw new Error('Missing row');
  act(() => open.click());
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('swaps the state icon for a spinner and marks the row busy', () => {
  act(() =>
    root.render(
      <ArchivedOverviewRow
        state="archived"
        title="Archived task"
        stateTooltip="Kept"
        stateTestId="row-state"
        busy
        date="Sep 16, 2026"
        actions={null}
        testId="row"
      />,
    ),
  );
  const row = container.querySelector('[data-testid="row"]');
  expect(row?.getAttribute('aria-busy')).toBe('true');
  expect(container.querySelector('[data-testid="row-state"]')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
});
