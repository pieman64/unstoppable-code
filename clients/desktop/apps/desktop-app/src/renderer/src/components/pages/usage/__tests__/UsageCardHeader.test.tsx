/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UsageCardHeader } from '../UsageCardHeader';

function render(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe('UsageCardHeader', () => {
  const onRefresh = jest.fn();

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  function renderHeader(
    props: Partial<Parameters<typeof UsageCardHeader>[0]> = {},
  ): { container: HTMLDivElement; root: Root } {
    return render(
      <UsageCardHeader
        icon={<span data-testid="header-icon" />}
        title="Claude"
        authState="authenticated"
        planActive
        refreshing={false}
        onRefresh={onRefresh}
        refreshLabel="Refresh Claude usage"
        planChipTestId="plan-chip"
        {...props}
      />,
    );
  }

  it('renders the icon and title together in the heading', () => {
    const { container, root } = renderHeader();

    const heading = container.querySelector('h2');
    expect(heading?.textContent).toContain('Claude');
    expect(
      heading?.querySelector('[data-testid="header-icon"]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('renders a green pill for an active plan', () => {
    const { container, root } = renderHeader({ planLabel: 'Pro' });

    const chip = container.querySelector('[data-testid="plan-chip"]');
    expect(chip?.textContent).toBe('Pro');
    expect(chip?.className).toContain('bg-success-subtle');

    act(() => {
      root.unmount();
    });
  });

  it('renders a grey pill for an inactive plan', () => {
    const { container, root } = renderHeader({
      planLabel: 'Free',
      planActive: false,
    });

    const chip = container.querySelector('[data-testid="plan-chip"]');
    expect(chip?.textContent).toBe('Free');
    expect(chip?.className).toContain('bg-fg-secondary/16');
    expect(chip?.className).not.toContain('fg-success-strong');

    act(() => {
      root.unmount();
    });
  });

  it('omits the pill and separator when no plan label is supplied', () => {
    const { container, root } = renderHeader({ planLabel: undefined });

    expect(container.querySelector('[data-testid="plan-chip"]')).toBeNull();
    expect(container.textContent).toContain('authenticated');
    expect(container.textContent).not.toContain('·');

    act(() => {
      root.unmount();
    });
  });

  it('keeps the auth word as plain text outside the pill', () => {
    const { container, root } = renderHeader({ planLabel: 'Pro' });

    const chip = container.querySelector('[data-testid="plan-chip"]');
    expect(chip?.textContent).not.toContain('authenticated');
    expect(container.textContent).toContain('authenticated');

    act(() => {
      root.unmount();
    });
  });

  it('shows the formatted timestamp when present and a fallback otherwise', () => {
    const { container, root } = renderHeader({ lastUpdatedAt: undefined });
    expect(container.textContent).toContain('No update');

    act(() => {
      root.unmount();
    });
  });

  // The two callers hold the timestamp in different shapes: the provider cards
  // pass `ProviderUsageSummary.lastUpdatedAt` (ISO string), while the AI
  // Credits card passes `useAiCreditsUsage().lastUpdatedAt` (epoch ms, nullable).
  it.each([
    ['an ISO string', '2026-06-05T12:00:00.000Z'],
    ['epoch milliseconds', Date.parse('2026-06-05T12:00:00.000Z')],
  ])('formats %s into the timestamp chip', (_label, lastUpdatedAt) => {
    const { container, root } = renderHeader({ lastUpdatedAt });

    const expected = new Date('2026-06-05T12:00:00.000Z').toLocaleTimeString();
    expect(container.textContent).toContain(expected);
    expect(container.textContent).not.toContain('No update');

    act(() => {
      root.unmount();
    });
  });

  it('falls back to "No update" for a null epoch timestamp', () => {
    const { container, root } = renderHeader({ lastUpdatedAt: null });
    expect(container.textContent).toContain('No update');

    act(() => {
      root.unmount();
    });
  });

  it('disables the refresh button while refreshing', () => {
    const { container, root } = renderHeader({ refreshing: true });

    const button = container.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Refresh Claude usage');
    expect(
      button?.querySelector('svg')?.classList.contains('animate-spin'),
    ).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const { container, root } = renderHeader();

    act(() => {
      container.querySelector('button')?.click();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
