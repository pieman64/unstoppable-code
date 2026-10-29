/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TransientRetryBanner } from '../TransientRetryBanner';
import { useTransientRetryBannerStore } from '@/stores/transientRetryBannerStore';
import {
  chatBannerKey,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import {
  TRANSIENT_RETRY_STATE_EVENT_TYPE,
  type TransientRetryStateEventData,
} from '@canopy/desktop-shared/types';

const TARGET: ChatBannerTarget = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};

const BANNER = '[data-testid="chat-input-transient-retry-banner"]';
const DISMISS = '[data-testid="chat-input-transient-retry-dismiss"]';

function event(
  overrides: Partial<TransientRetryStateEventData> = {},
): TransientRetryStateEventData {
  return {
    type: TRANSIENT_RETRY_STATE_EVENT_TYPE,
    provider: 'claude',
    active: true,
    attempt: 1,
    maxAttempts: 5,
    nextRetryAt: null,
    exhausted: false,
    ...overrides,
  };
}

describe('TransientRetryBanner', () => {
  const cancelTransientRetry = jest.fn<Promise<void>, [ChatBannerTarget]>();
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    cancelTransientRetry.mockReset();
    cancelTransientRetry.mockResolvedValue(undefined);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { chat: { cancelTransientRetry } },
    });

    useTransientRetryBannerStore.getState().clearForChat(TARGET);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useTransientRetryBannerStore.getState().clearForChat(TARGET);
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    jest.useRealTimers();
  });

  function render(): void {
    act(() => {
      root.render(<TransientRetryBanner target={TARGET} />);
    });
  }

  it('renders nothing without state for the target', () => {
    render();
    expect(container.querySelector(BANNER)).toBeNull();
  });

  it('renders a live countdown that advances with the attempt label', () => {
    useTransientRetryBannerStore
      .getState()
      .setState(
        TARGET,
        event({ attempt: 2, maxAttempts: 5, nextRetryAt: 125_000 }),
      );
    render();

    const banner = container.querySelector(BANNER);
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('attempt 2 of 5');
    expect(banner?.textContent).toContain('2:05');

    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(container.querySelector(BANNER)?.textContent).toContain('2:00');
  });

  it('flips to "Retrying now" when the countdown reaches zero', () => {
    useTransientRetryBannerStore
      .getState()
      .setState(
        TARGET,
        event({ attempt: 3, maxAttempts: 5, nextRetryAt: 3_000 }),
      );
    render();

    expect(container.querySelector(BANNER)?.textContent).toContain(
      'Retrying in 0:03',
    );

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    const banner = container.querySelector(BANNER);
    expect(banner?.textContent).toContain('Retrying now, attempt 3 of 5');
    expect(banner?.textContent).not.toMatch(/\d:\d\d/);
  });

  it('renders the exhausted copy without a countdown', () => {
    useTransientRetryBannerStore.getState().setState(
      TARGET,
      event({
        attempt: 5,
        maxAttempts: 5,
        nextRetryAt: null,
        exhausted: true,
      }),
    );
    render();

    const banner = container.querySelector(BANNER);
    expect(banner?.textContent).toContain('Gave up after 5 of 5 attempts');
    // No `m:ss` countdown is rendered once exhausted.
    expect(banner?.textContent).not.toMatch(/\d:\d\d/);
  });

  it('dismiss cancels the backend cycle and clears local state', () => {
    useTransientRetryBannerStore
      .getState()
      .setState(
        TARGET,
        event({ attempt: 3, maxAttempts: 5, nextRetryAt: 60_000 }),
      );
    render();

    const dismiss = container.querySelector<HTMLButtonElement>(DISMISS);
    expect(dismiss).not.toBeNull();

    act(() => {
      dismiss?.click();
    });

    expect(cancelTransientRetry).toHaveBeenCalledWith(TARGET);
    expect(
      chatBannerKey(TARGET) in
        useTransientRetryBannerStore.getState().stateByChat,
    ).toBe(false);
    expect(container.querySelector(BANNER)).toBeNull();
  });
});
