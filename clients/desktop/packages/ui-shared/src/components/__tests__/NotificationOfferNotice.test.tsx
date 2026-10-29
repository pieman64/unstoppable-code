/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  NotificationOfferNotice,
  type NotificationOfferNoticeProps,
} from '../NotificationOfferNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('NotificationOfferNotice', () => {
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

  function render(props: Partial<NotificationOfferNoticeProps> = {}): {
    onEnable: jest.Mock;
    onDismiss: jest.Mock;
  } {
    const onEnable = jest.fn();
    const onDismiss = jest.fn();
    act(() => {
      root.render(
        <NotificationOfferNotice
          busyAction={null}
          saveFailed={false}
          onEnable={onEnable}
          onDismiss={onDismiss}
          {...props}
        />,
      );
    });
    return { onEnable, onDismiss };
  }

  function button(testId: string): HTMLButtonElement {
    const element = container.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`Missing button ${testId}`);
    }
    return element;
  }

  it('offers exactly two choices in a polite live region', () => {
    const { onEnable, onDismiss } = render();
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain(
      'A task finished while you were away',
    );
    expect(container.textContent).toContain(
      'Turn on notifications to hear when a run finishes or needs you.',
    );
    const buttons = container.querySelectorAll('button');
    expect(Array.from(buttons, (entry) => entry.textContent)).toEqual([
      'Not now',
      'Turn on notifications',
    ]);
    expect(buttons[1].className).toContain('focus-ring');

    act(() => {
      button('notification-offer-notice-enable').click();
    });
    act(() => {
      button('notification-offer-notice-dismiss').click();
    });
    expect(onEnable).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['enable', 'notification-offer-notice-enable', 'Turning on…'],
    ['dismiss', 'notification-offer-notice-dismiss', 'Saving…'],
  ] as const)(
    'labels only the %s action as busy and disables both',
    (busyAction, busyTestId, label) => {
      render({ busyAction });
      expect(button(busyTestId).textContent).toBe(label);
      expect(button(busyTestId).getAttribute('aria-busy')).toBe('true');
      expect(button('notification-offer-notice-enable').disabled).toBe(true);
      expect(button('notification-offer-notice-dismiss').disabled).toBe(true);
    },
  );

  it('shows a retry message after a failed save and keeps both choices', () => {
    render({ saveFailed: true });
    expect(
      container.querySelector(
        '[data-testid="notification-offer-notice-save-error"]',
      )?.textContent,
    ).toBe("Couldn't save your choice. Try again.");
    expect(button('notification-offer-notice-enable').disabled).toBe(false);
    expect(button('notification-offer-notice-dismiss').disabled).toBe(false);
  });

  it('never moves focus when it mounts', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    render();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it.each(['enable', 'dismiss'] as const)(
    'retries the original %s choice',
    (retryAction) => {
      render({ saveFailed: true, retryAction });
      const selected = button(`notification-offer-notice-${retryAction}`);
      expect(selected.textContent).toBe('Try again');
      expect(selected.disabled).toBe(false);
      const other = button(
        `notification-offer-notice-${retryAction === 'enable' ? 'dismiss' : 'enable'}`,
      );
      expect(other.disabled).toBe(true);
    },
  );
});
