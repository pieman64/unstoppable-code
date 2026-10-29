/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchivedStateFilterDropdown } from '../ArchivedStateFilterDropdown';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
it('hides deleted state when its checked option is toggled', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onChange = jest.fn();
  act(() =>
    root.render(
      <ArchivedStateFilterDropdown hiddenStates={[]} onChange={onChange} />,
    ),
  );
  act(() => container.querySelector('button')?.click());
  const option = document.querySelector(
    '[data-testid="archived-overview-filter-option-deleted"]',
  );
  if (!(option instanceof HTMLElement))
    throw new Error('Missing deleted filter');
  act(() => option.click());
  expect(onChange).toHaveBeenCalledWith(['deleted']);
  act(() => root.unmount());
  container.remove();
});

it('reserves the leading check rail on unchecked rows so labels never shift', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ArchivedStateFilterDropdown
        hiddenStates={['deleted']}
        onChange={jest.fn()}
      />,
    ),
  );
  act(() => container.querySelector('button')?.click());

  const unchecked = document.querySelector(
    '[data-testid="archived-overview-filter-option-deleted"]',
  );
  const checked = document.querySelector(
    '[data-testid="archived-overview-filter-option-archived"]',
  );
  // This is a leading-checkbox menu: collapsing the rail on unchecked rows
  // would slide their icon and label 24px left of the checked ones and make
  // every toggle jump horizontally.
  expect(
    unchecked?.querySelector('[data-picker-selected-check="false"]'),
  ).not.toBeNull();
  expect(
    checked?.querySelector('[data-picker-selected-check="true"]'),
  ).not.toBeNull();

  act(() => root.unmount());
  container.remove();
});
