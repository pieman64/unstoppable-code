/**
 * @jest-environment jsdom
 */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProviderUsageErrorInfo } from '@canopy/desktop-shared/types';
import { usageFetchErrorHeadline } from '@canopy/desktop-shared/lib/usage-fetch-error';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { UsageErrorNotice } from '../UsageErrorNotice';

const LABEL = 'Claude';
const TEST_ID_PREFIX = 'usage-provider-claude';
const RETRY_BUTTON_TEST_ID = `${TEST_ID_PREFIX}-error-retry`;
const FIXTURE_NOW = new Date(2026, 9, 13, 15, 40);
const EIGHT_MINUTES = 8 * 60 * 1000;

interface UsageErrorNoticeTestOptions {
  showingRetainedUsage?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
}

const mountedRoots: Root[] = [];

function usageErrorNoticeElement(
  info: ProviderUsageErrorInfo,
  options: UsageErrorNoticeTestOptions = {},
): JSX.Element {
  const componentOptions: UsageErrorNoticeTestOptions = {
    ...options,
    onRetry: options.onRetry ?? jest.fn(),
  };
  return (
    <UsageErrorNotice
      label={LABEL}
      testIdPrefix={TEST_ID_PREFIX}
      info={info}
      {...componentOptions}
    />
  );
}

function renderUsageErrorNotice(
  info: ProviderUsageErrorInfo,
  options: UsageErrorNoticeTestOptions = {},
): {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(usageErrorNoticeElement(info, options));
  });

  return {
    container,
    root,
    unmount: (): void => {
      act(() => root.unmount());
      const rootIndex = mountedRoots.indexOf(root);
      if (rootIndex >= 0) {
        mountedRoots.splice(rootIndex, 1);
      }
    },
  };
}

function noticeMessage(container: HTMLDivElement): string {
  return (
    container.querySelector(
      `[data-testid="${TEST_ID_PREFIX}-error"] .text-pretty`,
    )?.textContent ?? ''
  );
}

function retryButton(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `[data-testid="${RETRY_BUTTON_TEST_ID}"]`,
  );
}

function rateLimitedInfo(
  options: {
    retryAt?: string;
    message?: string;
    detail?: string;
  } = {},
): ProviderUsageErrorInfo {
  return { kind: 'rate_limited', ...options };
}

function retryAtAfter(milliseconds: number): string {
  return new Date(FIXTURE_NOW.getTime() + milliseconds).toISOString();
}

function formattedRetrySentence(retryAt: string): string {
  const timeLabel = formatUsageLimitTimeLabel(retryAt);
  if (timeLabel === null) {
    throw new Error(`Expected a formatted time label for ${retryAt}`);
  }
  return `You can try again after ${timeLabel}.`;
}

afterEach((): void => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.splice(0, mountedRoots.length);
  document.body.innerHTML = '';
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('UsageErrorNotice regression behavior', () => {
  const unchangedErrorCases: Array<{
    kind: 'auth' | 'network' | 'service' | 'unsupported' | 'unknown';
    title: string;
  }> = [
    { kind: 'auth', title: 'Sign-in expired' },
    { kind: 'network', title: 'No connection' },
    { kind: 'service', title: 'Usage unavailable' },
    { kind: 'unsupported', title: 'Usage not available' },
    { kind: 'unknown', title: 'Usage not loaded' },
  ];
  const retainedUsageOptions: Array<{
    name: string;
    props: UsageErrorNoticeTestOptions;
  }> = [
    { name: 'unset', props: {} },
    { name: 'enabled', props: { showingRetainedUsage: true } },
  ];

  for (const errorCase of unchangedErrorCases) {
    for (const retainedUsageOption of retainedUsageOptions) {
      it(`preserves ${errorCase.kind} copy and retry behavior when showingRetainedUsage is ${retainedUsageOption.name}`, (): void => {
        const info: ProviderUsageErrorInfo = { kind: errorCase.kind };
        const onRetry = jest.fn();
        const { container } = renderUsageErrorNotice(info, {
          onRetry,
          ...retainedUsageOption.props,
        });
        const expectedCopy = `${errorCase.title}. ${usageFetchErrorHeadline(errorCase.kind, LABEL)}`;

        expect(noticeMessage(container)).toBe(expectedCopy);
        expect(noticeMessage(container).toLowerCase()).not.toContain(
          'last numbers',
        );
        expect(noticeMessage(container).toLowerCase()).not.toContain(
          'try again after',
        );

        const button = retryButton(container);
        if (errorCase.kind === 'unsupported') {
          expect(button).toBeNull();
        } else {
          expect(button?.textContent).toBe('Try again');
          expect(button?.disabled).toBe(false);
        }
      });
    }
  }
});

describe('UsageErrorNotice rate-limited behavior', () => {
  it('explains retained usage and a future retry time in order, using the shared time label', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const retryAt = retryAtAfter(EIGHT_MINUTES);
    const info = rateLimitedInfo({
      message: 'Claude has temporarily paused its usage checks.',
      retryAt,
    });
    const { container } = renderUsageErrorNotice(info, {
      showingRetainedUsage: true,
    });

    expect(noticeMessage(container)).toBe(
      `Usage checks paused. Claude has temporarily paused its usage checks. These are the last numbers Claude reported. ${formattedRetrySentence(retryAt)}`,
    );
    expect(noticeMessage(container)).not.toContain(
      'Claude is limiting usage checks right now.',
    );
    expect(retryButton(container)?.textContent).toBe('Try again');
    expect(retryButton(container)?.disabled).toBe(true);
  });

  it('shows the cold-start message and keeps retry available when retryAt is absent', (): void => {
    const onRetry = jest.fn();
    const { container } = renderUsageErrorNotice(rateLimitedInfo(), {
      onRetry,
    });
    const copy = noticeMessage(container);
    const button = retryButton(container);

    expect(copy).toBe(
      'Usage checks paused. Claude is limiting usage checks right now. Try again later.',
    );
    expect(copy.toLowerCase()).not.toContain('last numbers');
    expect(button?.textContent).toBe('Try again');
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('allows retry immediately when the retry time has already passed', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const retryAt = new Date(FIXTURE_NOW.getTime() - 60_000).toISOString();
    const { container } = renderUsageErrorNotice(rateLimitedInfo({ retryAt }));

    expect(noticeMessage(container)).toBe(
      'Usage checks paused. Claude is limiting usage checks right now. You can try again now.',
    );
    expect(retryButton(container)?.disabled).toBe(false);
  });

  it('does not wait for an unparseable retry time', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const { container } = renderUsageErrorNotice(
      rateLimitedInfo({ retryAt: 'not-a-date' }),
    );

    expect(retryButton(container)?.disabled).toBe(false);
  });

  it('keeps the action disabled while retrying even without a retry time', (): void => {
    const { container } = renderUsageErrorNotice(rateLimitedInfo(), {
      retrying: true,
    });

    expect(retryButton(container)?.disabled).toBe(true);
  });

  it('enables retry automatically when the future retry time passes and invokes onRetry when clicked', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const retryAt = retryAtAfter(EIGHT_MINUTES);
    const onRetry = jest.fn();
    const { container } = renderUsageErrorNotice(rateLimitedInfo({ retryAt }), {
      onRetry,
    });
    const button = retryButton(container);

    expect(button?.disabled).toBe(true);
    act(() => {
      jest.advanceTimersByTime(EIGHT_MINUTES);
    });
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('clears the scheduled retry timer when unmounted', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const { container, unmount } = renderUsageErrorNotice(
      rateLimitedInfo({ retryAt: retryAtAfter(EIGHT_MINUTES) }),
    );

    expect(retryButton(container)?.disabled).toBe(true);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('replaces the old retry timer when retryAt changes to a later time', (): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FIXTURE_NOW.getTime()));
    const firstRetryAt = retryAtAfter(EIGHT_MINUTES);
    const laterRetryAt = retryAtAfter(12 * 60 * 1000);
    const { container, root } = renderUsageErrorNotice(
      rateLimitedInfo({ retryAt: firstRetryAt }),
    );
    const button = retryButton(container);

    act(() => {
      root.render(
        usageErrorNoticeElement(rateLimitedInfo({ retryAt: laterRetryAt })),
      );
    });
    expect(button?.disabled).toBe(true);
    expect(noticeMessage(container)).toBe(
      `Usage checks paused. Claude is limiting usage checks right now. ${formattedRetrySentence(laterRetryAt)}`,
    );

    act(() => {
      jest.advanceTimersByTime(EIGHT_MINUTES);
    });
    expect(button?.disabled).toBe(true);
    act(() => {
      jest.advanceTimersByTime(4 * 60 * 1000);
    });
    expect(button?.disabled).toBe(false);
  });

  it('keeps the Show details toggle and disclosure behavior unchanged', (): void => {
    const { container } = renderUsageErrorNotice(
      rateLimitedInfo({ detail: 'Raw provider response for diagnosis.' }),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      `[data-testid="${TEST_ID_PREFIX}-error-details-toggle"]`,
    );

    expect(toggle?.textContent).toBe('Show details');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector(
        `[data-testid="${TEST_ID_PREFIX}-error-details"]`,
      ),
    ).toBeNull();

    act(() => toggle?.click());
    expect(toggle?.textContent).toBe('Hide details');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector(`[data-testid="${TEST_ID_PREFIX}-error-details"]`)
        ?.textContent,
    ).toBe('Raw provider response for diagnosis.');

    act(() => toggle?.click());
    expect(toggle?.textContent).toBe('Show details');
    expect(
      container.querySelector(
        `[data-testid="${TEST_ID_PREFIX}-error-details"]`,
      ),
    ).toBeNull();
  });
});
