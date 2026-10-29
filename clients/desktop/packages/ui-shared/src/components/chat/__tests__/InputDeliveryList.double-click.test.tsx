/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatInputDeliveryView } from '@canopy/protocol/portal';
import { InputDeliveryList } from '../InputDeliveryList';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const row = (
  state: ChatInputDeliveryView['state'],
  canWithdraw = state === 'pending',
): ChatInputDeliveryView => ({
  id: `row-${state}`,
  revision: 1,
  state,
  text: 'Follow up with the latest test result',
  attachmentCount: 0,
  canWithdraw,
});

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

function render(
  rows: readonly ChatInputDeliveryView[],
  onAction: Parameters<typeof InputDeliveryList>[0]['onAction'],
): void {
  act(() => {
    root.render(<InputDeliveryList rows={rows} onAction={onAction} />);
  });
}

async function doubleClickBubble(): Promise<void> {
  const bubble = container.querySelector(
    '[data-testid="input-delivery-bubble"]',
  );
  if (!bubble) throw new Error('Expected an input-delivery bubble');
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0 };
    bubble.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 1 }));
    bubble.dispatchEvent(new MouseEvent('mousedown', { ...init, detail: 2 }));
    bubble.dispatchEvent(new MouseEvent('dblclick', { ...init, detail: 2 }));
    await Promise.resolve();
  });
}

describe('InputDeliveryList double-click to edit', () => {
  it.each([
    ['pending with withdrawal', row('pending', true), true],
    ['pending without withdrawal', row('pending', false), false],
    ['cancelled', row('cancelled'), true],
    ['sending', row('sending'), false],
    ['cancelling', row('cancelling'), false],
    ['uncertain', row('uncertain'), false],
  ] as const)(
    'opens the editor for %s rows only where Edit is offered',
    async (_label, deliveryRow, editable) => {
      const onAction = jest.fn(() => Promise.resolve());
      render([deliveryRow], onAction);

      await doubleClickBubble();

      expect(onAction.mock.calls).toEqual(
        editable ? [[deliveryRow, 'edit', undefined]] : [],
      );
    },
  );

  it.each(['picked-up', 'queued'] as const)(
    'renders no %s bubble to double-click',
    (state) => {
      render(
        [row(state)],
        jest.fn(() => Promise.resolve()),
      );

      expect(
        container.querySelector('[data-testid="input-delivery-bubble"]'),
      ).toBeNull();
    },
  );

  it('edits inside the shared composer-style card', () => {
    render([{ ...row('pending'), state: 'editing' }], jest.fn());
    const editor = container.querySelector(
      '[data-testid="input-delivery-editor"]',
    );
    expect(editor?.closest('[data-testid="message-edit-card"]')).not.toBeNull();
    expect(editor?.classList.contains('resize-none')).toBe(true);
  });

  it('does not take focus after the user moves to another control while editing is acquired', async () => {
    let finish: () => void = () => undefined;
    const onAction = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render([row('pending')], onAction);
    await doubleClickBubble();
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    render([{ ...row('pending'), state: 'editing' }], onAction);
    expect(document.activeElement).toBe(elsewhere);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    elsewhere.remove();
  });

  it('does not start a second edit while the first is busy', async () => {
    let finish: () => void = () => undefined;
    const onAction = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render([row('pending')], onAction);

    await doubleClickBubble();
    await doubleClickBubble();
    expect(onAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });

  it('keeps a rejected edit explanation after its row disappears', async () => {
    let reject: (error: Error) => void = () => undefined;
    const onAction = jest.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = row('pending');
    render([pending], onAction);

    await doubleClickBubble();
    render([], onAction);
    await act(async () => {
      reject(new Error('This message is no longer available to edit.'));
      await Promise.resolve();
    });

    const notice = container.querySelector(
      '[data-testid="message-edit-notice"]',
    );
    expect(notice?.textContent).toContain(
      'This message is no longer available to edit.',
    );

    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="message-edit-notice-dismiss"]',
    );
    act(() => dismiss?.click());
    expect(
      container.querySelector('[data-testid="message-edit-notice"]'),
    ).toBeNull();
  });

  it('shows a rejection on the row itself while the row remains', async () => {
    const onAction = jest.fn(() =>
      Promise.reject(new Error('The message changed.')),
    );
    render([row('cancelled')], onAction);

    await doubleClickBubble();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The message changed.',
    );
    expect(
      container.querySelector('[data-testid="message-edit-notice"]'),
    ).toBeNull();
  });
});
