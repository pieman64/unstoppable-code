/**
 * @jest-environment jsdom
 */
const reactActGlobal: typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
} = globalThis;
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { RetainedAccountUsageSnapshot } from '@canopy/desktop-shared/types';
import { normalizeRetainedAccountSnapshot } from '@canopy/desktop-shared/lib/account-usage-snapshots';
import {
  OtherAccountSnapshots,
  OtherAccountSnapshotsPanel,
} from '../OtherAccountSnapshots';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';

const NOW = Date.UTC(2026, 6, 8, 12, 0, 0);

function futureSnapshot(
  overrides: Partial<RetainedAccountUsageSnapshot> = {},
): RetainedAccountUsageSnapshot {
  return {
    provider: 'claude',
    accountKey: 'claude:other@x.com:max',
    accountEmail: 'other@x.com',
    subscriptionLabel: 'max',
    rateLimits: [
      {
        limitId: 'five_hour',
        primary: {
          usedPercent: 42,
          resetsAt: new Date(NOW + 3_600_000).toISOString(),
        },
      },
    ],
    capturedAt: new Date(NOW - 1000).toISOString(),
    ...overrides,
  };
}

function renderInto(node: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return container;
}

afterEach(() => {
  document.body.innerHTML = '';
});

it('shows retained Claude spend and cap after a JSON hydrate', () => {
  const saved: unknown = JSON.parse(
    JSON.stringify(
      futureSnapshot({
        rateLimits: [
          {
            limitId: 'extra_usage',
            limitName: 'Extra usage',
            spend: { currency: 'USD', used: 61, limit: 50, isEnabled: true },
          },
        ],
      }),
    ),
  );
  const restored = normalizeRetainedAccountSnapshot(saved);
  if (!restored) throw new Error('Expected a retained account snapshot');
  const container = renderInto(
    <OtherAccountSnapshotsPanel
      provider="claude"
      snapshots={[restored]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Monthly spend: $61.00');
  expect(container.textContent).toContain('Monthly spending cap: $50.00');
  expect(container.textContent).not.toContain('Spent:');
});

it('does not show ambiguous legacy Claude minor units as spend after hydrate', () => {
  const restored = normalizeRetainedAccountSnapshot(
    futureSnapshot({
      rateLimits: [
        {
          limitId: 'extra_usage',
          limitName: 'Extra usage',
          credits: { usedUsd: 6100, totalUsd: 5000 },
        },
      ],
    }),
  );
  if (!restored) throw new Error('Expected a retained account snapshot');
  const container = renderInto(
    <OtherAccountSnapshotsPanel
      provider="claude"
      snapshots={[restored]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Extra usage');
  expect(container.textContent).not.toContain('Spent:');
  expect(container.textContent).not.toContain('$6100');
});

it('renders nothing when there are no other still-relevant accounts', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toBe('');
});

it('excludes the active account (case-insensitive email)', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="OTHER@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toBe('');
});

it('renders nothing when the active account cannot be identified', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail={undefined}
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toBe('');
});

it('keeps same-email snapshots when the subscription differs from the active account', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="other@x.com"
      activeSubscriptionLabel="pro"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toContain('Other account snapshots');
});

it('excludes accounts whose windows are all in the past', () => {
  const expired = futureSnapshot({
    accountKey: 'claude:expired@x.com:max',
    accountEmail: 'expired@x.com',
    rateLimits: [
      {
        limitId: 'five_hour',
        primary: { resetsAt: new Date(NOW - 1000).toISOString() },
      },
    ],
  });
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[expired]}
      nowMs={NOW}
    />,
  );
  expect(container.textContent).toBe('');
});

function expandToggle(container: HTMLDivElement): void {
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="other-account-snapshots-toggle-claude"]',
      )
      ?.click(),
  );
}

// Drives a controlled <select> the way React expects: set the value through the
// native prototype setter, then dispatch a bubbling change event.
function selectAccount(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  );
  act(() => {
    descriptor?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('shows a collapsed header and expands to a single-account label (no dropdown)', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="other-account-snapshots-toggle-claude"]',
  );
  expect(toggle).not.toBeNull();
  act(() => toggle?.click());
  expect(container.textContent).toContain(
    'Usage snapshots collected from recently used accounts where reset windows are still relevant.',
  );
  // A single account needs no picker — just a static label, no dropdown.
  expect(
    container.querySelector('[data-testid="other-account-select-claude"]'),
  ).toBeNull();
  const single = container.querySelector(
    '[data-testid="other-account-single-claude"]',
  );
  expect(single).not.toBeNull();
  expect(single?.textContent).toContain('Max');
  expect(single?.textContent).toContain('other@x.com');
});

it('renders the single-account label as two lines: account type over truncated email', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  expandToggle(container);
  const single = container.querySelector(
    '[data-testid="other-account-single-claude"]',
  );
  const lines = single?.querySelectorAll('div');
  expect(lines?.length).toBe(2);
  // Account type on top, email (with truncate) underneath.
  expect(lines?.[0]?.textContent).toBe('Max');
  expect(lines?.[1]?.textContent).toBe('other@x.com');
  expect(lines?.[1]?.className).toContain('truncate');
});

it('blocks only the single account email from session replay', () => {
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot()]}
      nowMs={NOW}
    />,
  );
  expandToggle(container);
  const single = container.querySelector(
    '[data-testid="other-account-single-claude"]',
  );
  expect(single).not.toBeNull();
  expectReplayBlocksOnlyValue(container, 'other@x.com');
  // The account type and the disclosure toggle stay recorded.
  expect(outermostReplayBlock(single)).toBeNull();
  expect(
    outermostReplayBlock(
      container.querySelector(
        '[data-testid="other-account-snapshots-toggle-claude"]',
      ),
    ),
  ).toBeNull();
});

it('renders a dropdown instead of stacked tabs when there are multiple accounts', () => {
  const second = futureSnapshot({
    accountKey: 'claude:second@x.com:pro',
    accountEmail: 'second@x.com',
    subscriptionLabel: 'pro',
  });
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot(), second]}
      nowMs={NOW}
    />,
  );
  expandToggle(container);

  // No single-account label; a dropdown with one option per account instead.
  expect(
    container.querySelector('[data-testid="other-account-single-claude"]'),
  ).toBeNull();
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="other-account-select-claude"]',
  );
  expect(select).not.toBeNull();
  const options = select?.querySelectorAll('option');
  expect(options?.length).toBe(2);
  expect(options?.[0]?.value).toBe('claude:other@x.com:max');
  expect(options?.[0]?.textContent).toBe('max · other@x.com');
  expect(options?.[1]?.textContent).toBe('pro · second@x.com');
  expect(select?.value).toBe('claude:other@x.com:max');
});

it('switches the selected account when the dropdown changes', () => {
  const second = futureSnapshot({
    accountKey: 'claude:second@x.com:pro',
    accountEmail: 'second@x.com',
    subscriptionLabel: 'pro',
  });
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot(), second]}
      nowMs={NOW}
    />,
  );
  expandToggle(container);
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="other-account-select-claude"]',
  );
  expect(select).not.toBeNull();
  if (select) {
    selectAccount(select, 'claude:second@x.com:pro');
    expect(select.value).toBe('claude:second@x.com:pro');
  }
});

it('keeps the selected account stable when snapshots reorder', () => {
  const first = futureSnapshot();
  const second = futureSnapshot({
    accountKey: 'claude:second@x.com:pro',
    accountEmail: 'second@x.com',
    subscriptionLabel: 'pro',
    rateLimits: [
      {
        limitId: 'five_hour',
        primary: {
          usedPercent: 77,
          resetsAt: new Date(NOW + 3_600_000).toISOString(),
        },
      },
    ],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <OtherAccountSnapshotsPanel
        provider="claude"
        snapshots={[first, second]}
        nowMs={NOW}
      />,
    );
  });
  const select = container.querySelector<HTMLSelectElement>(
    '[data-testid="other-account-select-claude"]',
  );
  expect(select).not.toBeNull();
  if (!select) return;

  selectAccount(select, second.accountKey);
  expect(select.value).toBe(second.accountKey);
  expect(container.textContent).toContain('77');

  act(() => {
    root.render(
      <OtherAccountSnapshotsPanel
        provider="claude"
        snapshots={[second, first]}
        nowMs={NOW}
      />,
    );
  });
  expect(select.value).toBe(second.accountKey);
  expect(container.textContent).toContain('77');
});

it('blocks each account option of the dropdown from session replay', () => {
  const second = futureSnapshot({
    accountKey: 'claude:second@x.com:pro',
    accountEmail: 'second@x.com',
    subscriptionLabel: 'pro',
  });
  const container = renderInto(
    <OtherAccountSnapshots
      provider="claude"
      activeEmail="active@x.com"
      activeSubscriptionLabel="max"
      snapshots={[futureSnapshot(), second]}
      nowMs={NOW}
    />,
  );
  expandToggle(container);
  const select = container.querySelector(
    '[data-testid="other-account-select-claude"]',
  );
  // A native option cannot hold a span, so the option itself is blocked; the
  // select, which the user interacts with, stays recorded.
  expect(outermostReplayBlock(select)).toBeNull();
  const options = Array.from(select?.querySelectorAll('option') ?? []);
  expect(options).toHaveLength(2);
  for (const option of options) {
    expect(outermostReplayBlock(option)).toBe(option);
  }
});
