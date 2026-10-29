/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import {
  NotificationDetailsDialog,
  type NotificationDetailsDialogProps,
} from '../NotificationDetailsDialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('NotificationDetailsDialog', (): void => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach((): void => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(
    props: Partial<NotificationDetailsDialogProps> = {},
  ): jest.Mock<void, []> {
    const onClose = jest.fn<void, []>();
    act(() =>
      root.render(
        <NotificationDetailsDialog
          title="Worktree error"
          titleId="details-title"
          message={'line one\nline two'}
          onClose={onClose}
          dataTestId="details"
          {...props}
        />,
      ),
    );
    return onClose;
  }

  function body(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="details-body"]',
    );
    if (element === null) throw new Error('details body not rendered');
    return element;
  }

  it('shows the full message in a bounded, scrolling box', (): void => {
    render({ tone: 'error' });

    expect(document.querySelector('[data-testid="details"]')).not.toBeNull();
    expect(body().textContent).toBe('line one\nline two');
    expect(body().classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(body().classList.contains('overflow-y-auto')).toBe(true);
    expect(body().classList.contains('border-red-500/20')).toBe(true);
    expect(body().style.maxHeight).toBe('60vh');
    expect(document.getElementById('details-title')?.textContent).toBe(
      'Worktree error',
    );
  });

  it('breaks lines at bare carriage returns', (): void => {
    // Git rewrites progress lines with a bare \r, which CSS does not break on.
    render({ message: 'line one\rline two\r\nline three' });

    expect(body().textContent).toBe('line one\nline two\nline three');
  });

  it('blocks the message from replay only when asked', (): void => {
    render();
    expect(body().classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);

    render({ blockFromReplay: true });
    expect(body().classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('renders the leading and trailing slots around the message', (): void => {
    render({
      leading: <span data-testid="leading">meta</span>,
      trailing: <span data-testid="trailing">actions</span>,
    });

    const order = Array.from(
      document.querySelectorAll(
        '[data-testid="leading"], [data-testid="details-body"], [data-testid="trailing"]',
      ),
    ).map((element) => element.getAttribute('data-testid'));
    expect(order).toEqual(['leading', 'details-body', 'trailing']);
  });

  it('closes from the close button and from Escape', (): void => {
    const onClose = render();

    const close = document.querySelector<HTMLButtonElement>(
      '[data-testid="details"] button[aria-label="Close"]',
    );
    expect(close).not.toBeNull();
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
