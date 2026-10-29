/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  QueuedMessageBubble,
  type QueuedMessageBubbleMessage,
} from '../QueuedMessageBubble';

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

function doubleClick(target: Element): void {
  act(() => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 2 }));
    target.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
  });
}

function render(
  message: QueuedMessageBubbleMessage,
  onEdit: (() => void) | undefined,
): void {
  act(() => {
    root.render(
      <QueuedMessageBubble
        message={message}
        onEdit={onEdit}
        onCancel={jest.fn()}
        attachment={<span data-testid="attachment">file.png</span>}
      />,
    );
  });
}

function text(): Element {
  const paragraph = container.querySelector('p');
  if (!paragraph) throw new Error('Expected queued message text');
  return paragraph;
}

describe('QueuedMessageBubble double-click to edit', () => {
  it('opens the same editor as the Edit badge', () => {
    const onEdit = jest.fn();
    render({ id: 'q1', text: 'queued text' }, onEdit);

    doubleClick(text());

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('does not edit a locked message', () => {
    const onEdit = jest.fn();
    render({ id: 'q1', text: 'queued text', editLocked: true }, onEdit);

    doubleClick(text());

    expect(onEdit).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="queued-message-edit"]'),
    ).toBeNull();
  });

  it('keeps only the Edit badge when the host cannot hold the row', () => {
    const onEdit = jest.fn();
    render({ id: 'q1', text: 'queued text', editLockAdvisory: true }, onEdit);

    doubleClick(text());

    expect(onEdit).not.toHaveBeenCalled();
    const badge = container.querySelector(
      '[data-testid="queued-message-edit"]',
    );
    if (!(badge instanceof HTMLElement)) throw new Error('Expected Edit badge');
    act(() => badge.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('leaves the attachment above the bubble alone', () => {
    const onEdit = jest.fn();
    render({ id: 'q1', text: 'queued text' }, onEdit);
    const attachment = container.querySelector('[data-testid="attachment"]');
    if (!attachment) throw new Error('Expected attachment');

    doubleClick(attachment);

    expect(onEdit).not.toHaveBeenCalled();
  });
});
