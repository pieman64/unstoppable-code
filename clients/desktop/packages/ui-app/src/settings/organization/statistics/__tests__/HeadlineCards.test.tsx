/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TelemetryHeadlineCard } from '@canopy/protocol/telemetry';

import { HeadlineCards, type TrendColorScheme } from '../HeadlineCards';

let container: HTMLDivElement;
let root: Root;

function render(
  cards: TelemetryHeadlineCard[],
  trendColorScheme?: TrendColorScheme,
): void {
  act(() => {
    root.render(
      <HeadlineCards cards={cards} trendColorScheme={trendColorScheme} />,
    );
  });
}

function cardText(key: string): string {
  return (
    container.querySelector(`[data-testid="usage-card-${key}"]`)?.textContent ??
    ''
  );
}

function trendChipClass(key: string): string {
  const card = container.querySelector(`[data-testid="usage-card-${key}"]`);
  // The trend chip is the inline-flex paragraph inside the card.
  const chip = card?.querySelector('p.inline-flex');
  return chip?.className ?? '';
}

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

describe('HeadlineCards trend chip', () => {
  it('shows a percent trend with the "vs. prior" suffix when a prior exists', () => {
    render([
      {
        key: 'totalCostUsd',
        label: 'Observed usage',
        value: 110,
        previousValue: 100,
        unit: 'currency',
      },
    ]);
    const text = cardText('totalCostUsd');
    expect(text).toContain('+10.0%');
    expect(text).toContain('vs. prior');
  });

  it('shows a "New" chip without the suffix when the prior window was zero', () => {
    render([
      {
        key: 'totalCostUsd',
        label: 'Observed usage',
        value: 4.36,
        previousValue: 0,
        unit: 'currency',
      },
    ]);
    const text = cardText('totalCostUsd');
    expect(text).toContain('New');
    expect(text).not.toContain('vs. prior');
  });

  it('renders no trend chip for count tiles that have no comparison value', () => {
    render([
      {
        key: 'worktrees',
        label: 'Worktrees',
        value: 2,
        previousValue: null,
        unit: 'count',
      },
    ]);
    const text = cardText('worktrees');
    expect(text).not.toContain('vs. prior');
    expect(text).not.toContain('New');
  });
});

describe('HeadlineCards trend color (flex scheme)', () => {
  it('colors an upward trend green (fg-success) under the flex scheme', () => {
    render(
      [
        {
          key: 'totalCostUsd',
          label: 'Observed usage',
          value: 110,
          previousValue: 100,
          unit: 'currency',
        },
      ],
      'flex',
    );
    expect(trendChipClass('totalCostUsd')).toContain('fg-success');
  });

  it('colors a downward trend red (fg-destructive) under the flex scheme', () => {
    render(
      [
        {
          key: 'totalCostUsd',
          label: 'Observed usage',
          value: 90,
          previousValue: 100,
          unit: 'currency',
        },
      ],
      'flex',
    );
    expect(trendChipClass('totalCostUsd')).toContain('fg-destructive');
  });
});

describe('HeadlineCards trend color (default cost scheme)', () => {
  it('colors an upward trend amber (fg-warning) by default', () => {
    render([
      {
        key: 'totalCostUsd',
        label: 'Observed usage',
        value: 110,
        previousValue: 100,
        unit: 'currency',
      },
    ]);
    const cls = trendChipClass('totalCostUsd');
    expect(cls).toContain('fg-warning');
    expect(cls).not.toContain('fg-success');
  });

  it('colors a downward trend green (fg-success) by default', () => {
    render([
      {
        key: 'totalCostUsd',
        label: 'Observed usage',
        value: 90,
        previousValue: 100,
        unit: 'currency',
      },
    ]);
    const cls = trendChipClass('totalCostUsd');
    expect(cls).toContain('fg-success');
    expect(cls).not.toContain('fg-destructive');
  });
});

describe('HeadlineCards info tooltip', () => {
  it('renders an info tooltip trigger for a known metric', () => {
    render([
      {
        key: 'billedCostUsd',
        label: 'Subscription cost (est.)',
        value: 6.72,
        previousValue: 6.72,
        unit: 'currency',
      },
    ]);
    const trigger = container.querySelector(
      '[data-testid="usage-card-billedCostUsd-info"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe(
      'What does Subscription cost (est.) mean?',
    );
  });

  it('omits the info trigger for an unknown metric key', () => {
    render([
      {
        key: 'mystery',
        label: 'Mystery',
        value: 1,
        previousValue: null,
        unit: 'count',
      },
    ]);
    expect(
      container.querySelector('[data-testid="usage-card-mystery-info"]'),
    ).toBeNull();
  });
});
