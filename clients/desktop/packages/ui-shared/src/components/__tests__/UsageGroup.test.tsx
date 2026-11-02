/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  formatUsageResetPhrase,
  formatUsageUpdatedPhrase,
  newestUsageUpdate,
  usageLevel,
  usagePlanLabel,
  usageWindowElapsedPercent,
  UsageProviderGroup,
  UsageRefreshButton,
  UsageRowList,
  UsageWindowRow,
  type UsageLimitCard,
} from '../UsageGroup';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// Local noon, so day arithmetic does not depend on the runner's time zone.
const NOW_MS = new Date(2030, 2, 4, 12, 0, 0).getTime();
const HOUR_MS = 60 * 60 * 1000;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderRow(window: UsageLimitCard): HTMLElement {
  act(() =>
    root.render(
      <UsageRowList>
        <UsageWindowRow window={window} nowMs={NOW_MS} />
      </UsageRowList>,
    ),
  );
  const row = container.querySelector<HTMLElement>(
    `[data-testid="usage-window-${window.key}"]`,
  );
  expect(row).toBeInstanceOf(HTMLElement);
  if (!row) throw new Error('row missing');
  return row;
}

describe('usageLevel', () => {
  it('stays neutral below 80%, warns from 80% and turns red from 95%', () => {
    expect(usageLevel(0)).toBe('normal');
    expect(usageLevel(79.9)).toBe('normal');
    expect(usageLevel(80)).toBe('warning');
    expect(usageLevel(94.9)).toBe('warning');
    expect(usageLevel(95)).toBe('danger');
    expect(usageLevel(100)).toBe('danger');
  });
});

describe('formatUsageResetPhrase', () => {
  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });

  it('says today, tomorrow, a weekday within the week, then the date', () => {
    const today = NOW_MS + 3 * HOUR_MS;
    expect(formatUsageResetPhrase(today, NOW_MS)).toBe(
      `today at ${time(today)}`,
    );
    const tomorrow = NOW_MS + 20 * HOUR_MS;
    expect(formatUsageResetPhrase(tomorrow, NOW_MS)).toBe(
      `tomorrow at ${time(tomorrow)}`,
    );
    const thisWeek = NOW_MS + 3 * 24 * HOUR_MS;
    expect(formatUsageResetPhrase(thisWeek, NOW_MS)).toBe(
      `${new Date(thisWeek).toLocaleDateString(undefined, { weekday: 'short' })} at ${time(thisWeek)}`,
    );
    const later = NOW_MS + 20 * 24 * HOUR_MS;
    expect(formatUsageResetPhrase(later, NOW_MS)).toBe(
      new Date(later).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      }),
    );
  });

  it('reads nothing for a missing or unreadable time', () => {
    expect(formatUsageResetPhrase(undefined, NOW_MS)).toBeNull();
    expect(formatUsageResetPhrase('not a date', NOW_MS)).toBeNull();
  });
});

describe('formatUsageUpdatedPhrase and newestUsageUpdate', () => {
  it('reads just now under a minute, then a short age', () => {
    expect(formatUsageUpdatedPhrase(NOW_MS - 20_000, NOW_MS)).toBe(
      'Updated just now',
    );
    expect(formatUsageUpdatedPhrase(NOW_MS - 3 * 60_000, NOW_MS)).toBe(
      'Updated 3m ago',
    );
    expect(formatUsageUpdatedPhrase(null, NOW_MS)).toBeNull();
  });

  it('takes the newest readable time', () => {
    expect(
      newestUsageUpdate([
        undefined,
        new Date(NOW_MS - 5_000).toISOString(),
        NOW_MS - 60_000,
        'bad',
      ]),
    ).toBe(NOW_MS - 5_000);
    expect(newestUsageUpdate([null, undefined])).toBeNull();
  });
});

describe('usagePlanLabel', () => {
  it('drops the provider name in front of a plan', () => {
    expect(usagePlanLabel('Claude', 'Claude Max 20x')).toBe('Max 20x');
    expect(usagePlanLabel('Codex', 'ChatGPT Pro')).toBe('ChatGPT Pro');
    expect(usagePlanLabel('Claude', 'Claude')).toBe('Claude');
    expect(usagePlanLabel('Claude', '  ')).toBeNull();
    expect(usagePlanLabel('Claude', undefined)).toBeNull();
  });
});

describe('UsageWindowRow', () => {
  it('shows a neutral meter, a whole percent and the reset in words', () => {
    const row = renderRow({
      key: 'five-hour',
      title: '5-hour window',
      usedPercent: 4,
      resetsAt: NOW_MS + 3 * HOUR_MS,
    });
    expect(row.textContent).toContain('5-hour window');
    expect(row.textContent).toContain('Resets today at');
    expect(row.textContent).toContain('4%');
    expect(
      row.querySelector('[role="progressbar"] > div')?.className,
    ).toContain('bg-fg-tertiary');
    expect(
      row.querySelector('[data-usage-level]')?.getAttribute('data-usage-level'),
    ).toBe('normal');
  });

  it('colours a window near its limit and says so', () => {
    const warning = renderRow({
      key: 'weekly',
      title: '7-day window',
      usedPercent: 82,
      resetsAt: NOW_MS + 20 * HOUR_MS,
    });
    expect(
      warning.querySelector('[role="progressbar"] > div')?.className,
    ).toContain('bg-warning');
    expect(warning.textContent).not.toContain('Almost at the limit');

    const danger = renderRow({
      key: 'weekly',
      title: '7-day window',
      usedPercent: 96,
      resetsAt: NOW_MS + 20 * HOUR_MS,
    });
    expect(
      danger.querySelector('[role="progressbar"] > div')?.className,
    ).toContain('bg-destructive');
    // The colour says it; the quiet line is the plain reset.
    expect(danger.textContent).not.toContain('Almost at the limit');
    expect(danger.textContent).toContain('Resets tomorrow');
    // Only the fill carries the level; the percent stays primary.
    const percent = danger.querySelector('[data-usage-level]');
    expect(percent?.className).toContain('fg-primary');
    // The compact button's label size, a step under the row title.
    expect(percent?.className).toContain('text-xs');
    expect(percent?.className).not.toMatch(/fg-(warning|destructive)/);

    const unused = renderRow({ key: 'idle', title: 'Idle', usedPercent: 0 });
    expect(unused.querySelector('[data-usage-level]')?.className).toContain(
      'fg-tertiary',
    );
    const used = renderRow({ key: 'one', title: 'One', usedPercent: 1 });
    expect(used.querySelector('[data-usage-level]')?.className).toContain(
      'fg-primary',
    );

    const reached = renderRow({
      key: 'weekly',
      title: '7-day',
      usedPercent: 100,
    });
    expect(reached.textContent).toContain('Limit reached');
  });

  it('names its meter and says what the value means (CAN-4969)', () => {
    const meter = (row: HTMLElement): Element | null =>
      row.querySelector('[role="progressbar"]');
    const danger = renderRow({
      key: 'weekly',
      title: '7-day window',
      usedPercent: 98,
      resetsAt: NOW_MS + 20 * HOUR_MS,
    });
    expect(meter(danger)?.getAttribute('aria-label')).toBe(
      '7-day window: 98% used',
    );
    expect(meter(danger)?.getAttribute('aria-valuenow')).toBe('98');
    expect(meter(danger)?.getAttribute('aria-valuetext')).toMatch(
      /^98% used, Almost at the limit, resets tomorrow at /,
    );
    expect(
      meter(
        renderRow({ key: 'reached', title: '5-hour', usedPercent: 100 }),
      )?.getAttribute('aria-valuetext'),
    ).toBe('100% used, Limit reached');
    expect(
      meter(
        renderRow({
          key: 'stale',
          title: '5-hour',
          usedPercent: 100,
          resetsAt: NOW_MS - HOUR_MS,
        }),
      )?.getAttribute('aria-valuetext'),
    ).toBe('100% used');
  });

  it('marks how far through its window a limit is with a triangle', () => {
    const elapsed = (row: HTMLElement): SVGElement | null =>
      row.querySelector<SVGElement>('[data-testid="usage-window-elapsed"]');
    // A 5-hour window resetting in 2 hours is 60% through.
    const row = renderRow({
      key: 'five-hour',
      title: '5-hour window',
      usedPercent: 30,
      resetsAt: NOW_MS + 2 * HOUR_MS,
      windowDurationMs: 5 * HOUR_MS,
    });
    const triangle = elapsed(row);
    expect(triangle).toBeInstanceOf(SVGElement);
    expect(triangle?.style.left).toBe('60%');
    expect(triangle?.getAttribute('aria-label')).toBe('Window elapsed: 60%');
    // Under the meter, not beside it.
    expect(
      triangle?.parentElement?.querySelector('[role="progressbar"]'),
    ).toBeInstanceOf(HTMLElement);

    // No window length, no reset, or a passed reset: no triangle.
    expect(
      elapsed(
        renderRow({
          key: 'a',
          title: 'A',
          usedPercent: 30,
          resetsAt: NOW_MS + HOUR_MS,
        }),
      ),
    ).toBeNull();
    expect(
      elapsed(
        renderRow({
          key: 'b',
          title: 'B',
          usedPercent: 30,
          windowDurationMs: 5 * HOUR_MS,
        }),
      ),
    ).toBeNull();
    expect(
      elapsed(
        renderRow({
          key: 'c',
          title: 'C',
          usedPercent: 30,
          resetsAt: NOW_MS - HOUR_MS,
          windowDurationMs: 5 * HOUR_MS,
        }),
      ),
    ).toBeNull();
  });

  it('keeps a window whose reset passed uncoloured and says so', () => {
    const row = renderRow({
      key: 'stale',
      title: '5-hour window',
      usedPercent: 97,
      resetsAt: NOW_MS - HOUR_MS,
    });
    expect(row.textContent).toContain('Reset time has passed');
    expect(row.textContent).not.toContain('Almost at the limit');
    expect(
      row.querySelector('[data-usage-level]')?.getAttribute('data-usage-level'),
    ).toBe('normal');
  });

  it('names credits, spend, unlimited and unknown usage without a fake 0%', () => {
    expect(
      renderRow({
        key: 'codex',
        title: '7-day window',
        usedPercent: 2,
        credits: { remainingUsd: 62_500 },
        creditsAreCount: true,
      }).textContent,
    ).toContain('62,500 credits left');
    expect(
      renderRow({
        key: 'cursor',
        title: 'Included usage',
        usedPercent: 0,
        credits: { usedUsd: 12.5, remainingUsd: 7.5 },
      }).textContent,
    ).toContain('$7.50 left · $12.50 spent');
    const unlimited = renderRow({
      key: 'premium',
      title: 'Premium requests',
      unlimited: true,
      usedPercent: 40,
    });
    expect(unlimited.textContent).toContain('Unlimited');
    expect(unlimited.querySelector('[role="progressbar"]')).toBeNull();
    const unknown = renderRow({ key: 'unknown', title: 'Current window' });
    expect(unknown.textContent).toContain('Usage unavailable');
    expect(unknown.textContent).not.toMatch(/0%/);
  });
});

describe('usageWindowElapsedPercent', () => {
  it('clamps to the window and ignores unusable times', () => {
    const windowDurationMs = 10 * HOUR_MS;
    expect(
      usageWindowElapsedPercent(
        { resetsAt: NOW_MS + 9 * HOUR_MS, windowDurationMs },
        NOW_MS,
      ),
    ).toBeCloseTo(10);
    expect(
      usageWindowElapsedPercent(
        { resetsAt: NOW_MS + 20 * HOUR_MS, windowDurationMs },
        NOW_MS,
      ),
    ).toBe(0);
    expect(
      usageWindowElapsedPercent(
        { resetsAt: 'not a date', windowDurationMs },
        NOW_MS,
      ),
    ).toBeUndefined();
    expect(
      usageWindowElapsedPercent(
        { resetsAt: NOW_MS + HOUR_MS, windowDurationMs: 0 },
        NOW_MS,
      ),
    ).toBeUndefined();
  });
});

describe('UsageProviderGroup', () => {
  const quiet: UsageLimitCard[] = [
    { key: 'included', title: 'Included usage', usedPercent: 0 },
    { key: 'auto', title: 'Auto', usedPercent: 0.4 },
    { key: 'api', title: 'API', usedPercent: 0 },
  ];

  function renderGroup(windows: UsageLimitCard[]): void {
    act(() =>
      root.render(
        <UsageProviderGroup
          title="Cursor"
          plan="Pro"
          planTestId="plan"
          windows={windows}
          nowMs={NOW_MS}
          testId="group"
          rows={<div data-testid="account-row">Account</div>}
        />,
      ),
    );
  }

  it('leads the heading with the provider brand mark', () => {
    for (const provider of ['claude', 'codex']) {
      act(() =>
        root.render(
          <UsageProviderGroup
            title={provider}
            provider={provider}
            windows={[]}
            nowMs={NOW_MS}
          />,
        ),
      );
      const mark = container.querySelector(
        'h2 [data-testid="usage-group-provider-mark"]',
      );
      expect(mark).toBeInstanceOf(SVGElement);
      expect(mark?.getAttribute('aria-hidden')).toBe('true');
    }
    // No provider, no mark.
    renderGroup(quiet.slice(0, 1));
    expect(
      container.querySelector('[data-testid="usage-group-provider-mark"]'),
    ).toBeNull();
  });

  it('names the provider and plan in the heading', () => {
    renderGroup(quiet.slice(0, 1));
    expect(container.querySelector('h2')?.textContent).toBe('Cursor · Pro');
    expect(container.querySelector('[data-testid="plan"]')?.textContent).toBe(
      'Pro',
    );
    // The heading is never a control.
    expect(container.querySelector('h2 button')).toBeNull();
    expect(
      container.querySelector('[data-testid="account-row"]'),
    ).toBeInstanceOf(HTMLElement);
  });

  it('shows every window and the account row, however many are unused', () => {
    renderGroup(quiet);
    expect(container.querySelector('h2 button')).toBeNull();
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+ limits/);
    expect(
      container.querySelectorAll('[data-testid^="usage-window-"]'),
    ).toHaveLength(3);
    expect(
      container.querySelector('[data-testid="account-row"]'),
    ).toBeInstanceOf(HTMLElement);
  });
});

describe('UsageRefreshButton', () => {
  it('is a labelled round button that cannot run twice at once', () => {
    const onRefresh = jest.fn();
    act(() =>
      root.render(
        <UsageRefreshButton refreshing={false} onRefresh={onRefresh} />,
      ),
    );
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toBe('Refresh usage');
    act(() => button?.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(<UsageRefreshButton refreshing onRefresh={onRefresh} />),
    );
    expect(container.querySelector('button')?.disabled).toBe(true);
  });
});
