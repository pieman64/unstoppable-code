/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  BackgroundServiceNotice,
  type BackgroundServiceNoticeProps,
} from '../BackgroundServiceNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('BackgroundServiceNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(retry: BackgroundServiceNoticeProps['retry']): {
    notice: HTMLElement | null;
    button: HTMLButtonElement | null;
    onRetry: jest.Mock;
  } {
    const onRetry = jest.fn();
    act(() =>
      root.render(<BackgroundServiceNotice retry={retry} onRetry={onRetry} />),
    );
    return {
      notice: container.querySelector(
        '[data-testid="background-service-notice"]',
      ),
      button: container.querySelector(
        '[data-testid="background-service-notice-retry"]',
      ),
      onRetry,
    };
  }

  it('leads with the state, says what it affects and offers Try again', () => {
    const { notice, button, onRetry } = render('idle');
    expect(notice?.getAttribute('data-notice-intent')).toBe('attention');
    expect(notice?.textContent).toContain(
      "Couldn't reach the background service",
    );
    expect(notice?.textContent).toContain('Files and folders may not load.');
    expect(button?.textContent).toBe('Try again');
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure on screen with a spinning capsule while retrying', () => {
    const { notice, button, onRetry } = render('running');
    expect(notice?.textContent).toContain(
      "Couldn't reach the background service",
    );
    expect(button?.textContent).toBe('Trying again…');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    act(() => button?.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('says a failed retry is still failing and when to try again', () => {
    const { notice, button } = render('failed');
    expect(notice?.textContent).toContain(
      "Still couldn't reach the background service",
    );
    expect(notice?.textContent).toContain('Try again in a moment.');
    expect(button?.disabled).toBe(false);
  });
});
