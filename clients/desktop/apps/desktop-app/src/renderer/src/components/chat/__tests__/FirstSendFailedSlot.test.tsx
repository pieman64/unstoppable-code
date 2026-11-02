/**
 * @jest-environment jsdom
 *
 * CAN-5021 — recovery for a Home first send whose model was refused after its
 * chat opened: the chat's own picker, and one retry of the same prompt.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FirstSendFailedSlot } from '../FirstSendFailedSlot';
import { retryFailedFirstSend } from '@/components/home/homeSend';
import { OPEN_MODEL_PICKER_EVENT } from '@/lib/composerShortcutRequests';

jest.mock('@/components/home/homeSend', () => ({
  retryFailedFirstSend: jest.fn(() => Promise.resolve(true)),
}));

const target = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };
const failure = {
  failureId: 'failure-1',
  model: 'claude-sonnet-4-6',
  message:
    'Sonnet 4.6 couldn’t be used to start this chat. Choose another model.',
};

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
  jest.clearAllMocks();
});

function render(active: boolean, failureId = failure.failureId): void {
  act(() => {
    root.render(
      <FirstSendFailedSlot
        target={target}
        failure={{ ...failure, failureId }}
        active={active}
      />,
    );
  });
}

function button(testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement))
    throw new Error(`Missing button ${testId}`);
  return element;
}

it('names the model in one alert with both recovery actions', () => {
  render(true);

  const alerts = container.querySelectorAll('[role="alert"]');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.textContent).toContain('Couldn’t send');
  expect(alerts[0]?.textContent).toContain(failure.message);
  expect(button('first-send-failed-notice-choose-model').textContent).toBe(
    'Choose another model',
  );
  expect(button('first-send-failed-notice-retry').textContent).toBe(
    'Try again',
  );
});

it('opens this chat’s model picker without sending', () => {
  const requests: unknown[] = [];
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent) requests.push(event.detail);
  };
  document.addEventListener(OPEN_MODEL_PICKER_EVENT, listener);
  render(true);

  act(() => button('first-send-failed-notice-choose-model').click());

  document.removeEventListener(OPEN_MODEL_PICKER_EVENT, listener);
  expect(requests).toEqual([{ scope: 'chat', ...target }]);
  expect(retryFailedFirstSend).not.toHaveBeenCalled();
});

it('retries the failed send for this chat', () => {
  render(true);

  act(() => button('first-send-failed-notice-retry').click());

  expect(retryFailedFirstSend).toHaveBeenCalledWith(target);
});

it('takes focus only in the chat the user is looking at', () => {
  render(false);
  expect(document.activeElement).not.toBe(
    button('first-send-failed-notice-choose-model'),
  );

  render(true, 'failure-2');
  expect(document.activeElement).toBe(
    button('first-send-failed-notice-choose-model'),
  );
});
