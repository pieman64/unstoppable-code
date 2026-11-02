/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerSelectionReason } from '../ComposerSelectionReason';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(onAction: () => void): HTMLButtonElement {
  act(() => {
    root.render(
      <ComposerSelectionReason
        reason="Most recent"
        actionLabel="Switch"
        actionAccessibleName="Switch project"
        onAction={onAction}
        testId="reason"
      />,
    );
  });
  const button = container.querySelector('[data-testid="reason-action"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error('no action');
  return button;
}

it('reads as the reason, a separator, and the action', () => {
  render(jest.fn());
  expect(container.querySelector('[data-testid="reason"]')?.textContent).toBe(
    'Most recent·Switch',
  );
});

it('names the action for assistive technology and keeps it a real button', () => {
  const button = render(jest.fn());
  expect(button.getAttribute('aria-label')).toBe('Switch project');
  expect(button.type).toBe('button');
  expect(button.textContent).toBe('Switch');
});

it('runs the action on click', () => {
  const onAction = jest.fn();
  const button = render(onAction);
  act(() => button.click());
  expect(onAction).toHaveBeenCalledTimes(1);
});

it('hides the separator from assistive technology', () => {
  render(jest.fn());
  const hidden = container.querySelector('[aria-hidden="true"]');
  expect(hidden?.textContent).toBe('·');
});
