/**
 * @jest-environment jsdom
 */
const reactActGlobal: typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} = globalThis;
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LimitSubCardView } from '../LimitSubCardView';
import type { LimitSubCard } from '../usage-sub-cards';

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);
const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeCard(overrides: Partial<LimitSubCard> = {}): LimitSubCard {
  return {
    key: 'five_hour',
    title: '5-hour window',
    usedPercent: 100,
    resetsAt: new Date(NOW + 3_600_000).toISOString(),
    windowDurationMs: 5 * 60 * 60 * 1000,
    ...overrides,
  };
}

function renderInto(node: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  act(() => {
    root.render(node);
  });
  return container;
}

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

it('does not overlay a card whose reset time is still in the future', () => {
  const container = renderInto(
    <LimitSubCardView card={makeCard()} nowMs={NOW} />,
  );
  expect(container.textContent).not.toContain('Reset time has passed');
});

it('overlays a card whose reset time has already passed', () => {
  const container = renderInto(
    <LimitSubCardView
      card={makeCard({ resetsAt: new Date(NOW - 1000).toISOString() })}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Reset time has passed');
  // The underlying details remain in the DOM (semi-transparent overlay, not a replacement).
  expect(container.textContent).toContain('5-hour window');
});

it('overlays when the reset time equals now', () => {
  const container = renderInto(
    <LimitSubCardView
      card={makeCard({ resetsAt: new Date(NOW).toISOString() })}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Reset time has passed');
});

it('does not overlay a card that has no reset time', () => {
  const container = renderInto(
    <LimitSubCardView card={makeCard({ resetsAt: undefined })} nowMs={NOW} />,
  );
  expect(container.textContent).not.toContain('Reset time has passed');
});

it('shows reported on-demand spend without inventing a remaining balance', () => {
  const container = renderInto(
    <LimitSubCardView
      card={makeCard({
        title: 'On-demand usage (no spending limit)',
        usedPercent: undefined,
        credits: { usedUsd: 12.5 },
      })}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Spent: $12.50');
  expect(container.textContent).not.toContain('Remaining credits');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

it('counts a Codex balance in credits, not dollars', () => {
  const container = renderInto(
    <LimitSubCardView
      card={makeCard({
        credits: { remainingUsd: 62_500 },
        creditsAreCount: true,
      })}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Remaining credits: 62,500');
  expect(container.textContent).not.toContain('$');
});

it('shows an unlimited entitlement without a fabricated usage percentage', () => {
  const container = renderInto(
    <LimitSubCardView
      card={makeCard({
        unlimited: true,
        usedPercent: 0,
        resetsAt: new Date(NOW - 1000).toISOString(),
      })}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Unlimited');
  expect(container.textContent).not.toContain('Reset time has passed');
  expect(container.textContent).not.toContain('Usage:');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

it('distinguishes an unavailable quota from a reported zero', () => {
  const missing = renderInto(
    <LimitSubCardView
      card={makeCard({ usedPercent: undefined })}
      nowMs={NOW}
    />,
  );
  expect(missing.textContent).toContain('Usage unavailable');
  expect(missing.textContent).not.toContain('0.0%');
  const zero = renderInto(
    <LimitSubCardView card={makeCard({ usedPercent: 0 })} nowMs={NOW} />,
  );
  expect(zero.textContent).toContain('0.0%');
  expect(zero.textContent).not.toContain('Usage unavailable');
});
