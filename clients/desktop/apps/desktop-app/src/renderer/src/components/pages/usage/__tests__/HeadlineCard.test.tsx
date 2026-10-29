/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HeadlineCard } from '../HeadlineCard';
import type { HeadlineCardSpec } from '../tab-specs';
import type { UsageTabSummaryCard } from '@canopy/desktop-shared/types';

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

const COUNT_SPEC: HeadlineCardSpec = {
  key: 'created',
  title: 'Created',
  display: 'count',
};

describe('HeadlineCard', () => {
  test('renders 7d value, trend, and all-time footnote for count card', () => {
    const card: UsageTabSummaryCard = {
      key: 'created',
      last7d: 24,
      prior7d: 16,
      allTime: 200,
    };
    const { container } = render(
      <HeadlineCard
        spec={COUNT_SPEC}
        card={card}
        earliestEventAt="2026-03-04T00:00:00.000Z"
      />,
    );
    expect(container.textContent).toContain('Created');
    expect(container.textContent).toContain('24');
    expect(container.textContent).toContain('50%');
    expect(container.textContent).toContain('200');
    expect(container.textContent).toMatch(/since.*2026/);
  });

  test('shows em-dash trend when prior is undefined', () => {
    const card: UsageTabSummaryCard = {
      key: 'created',
      last7d: 5,
      prior7d: undefined,
      allTime: 5,
    };
    const { container } = render(
      <HeadlineCard
        spec={COUNT_SPEC}
        card={card}
        earliestEventAt="2026-05-20T00:00:00.000Z"
      />,
    );
    expect(container.textContent).toContain('—');
  });

  test('renders distribution-avg using stats.avg', () => {
    const spec: HeadlineCardSpec = {
      key: 'avg_turn_duration_ms',
      title: 'Avg turn time',
      display: 'distribution-avg',
      unit: 'ms',
    };
    const card: UsageTabSummaryCard = {
      key: 'avg_turn_duration_ms',
      last7d: { total: 0, min: 0, max: 0, avg: 1500, p50: 0, p95: 0, p99: 0 },
      prior7d: { total: 0, min: 0, max: 0, avg: 1000, p50: 0, p95: 0, p99: 0 },
      allTime: { total: 0, min: 0, max: 0, avg: 1200, p50: 0, p95: 0, p99: 0 },
    };
    const { container } = render(
      <HeadlineCard
        spec={spec}
        card={card}
        earliestEventAt="2026-03-01T00:00:00.000Z"
      />,
    );
    expect(container.textContent).toContain('1,500');
    expect(container.textContent).toContain('ms');
  });

  test('renders currency cards as USD', () => {
    const spec: HeadlineCardSpec = {
      key: 'observed_cost',
      title: 'Observed cost',
      display: 'currency',
    };
    const card: UsageTabSummaryCard = {
      key: 'observed_cost',
      last7d: 1.2345,
      prior7d: 1,
      allTime: 12.5,
    };
    const { container } = render(
      <HeadlineCard
        spec={spec}
        card={card}
        earliestEventAt="2026-03-01T00:00:00.000Z"
      />,
    );
    expect(container.textContent).toContain('Observed cost');
    expect(container.textContent).toContain('$1.23');
    expect(container.textContent).toContain('All time: $12.50');
  });
});
