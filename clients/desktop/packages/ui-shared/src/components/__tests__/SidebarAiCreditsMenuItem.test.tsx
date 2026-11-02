/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AI_CREDITS_LABEL,
  SidebarAiCreditsMenuItem,
  aiCreditsBalanceTone,
  formatAiCreditsBalance,
} from '../SidebarAiCreditsMenuItem';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact' });

describe('formatAiCreditsBalance', () => {
  it('rounds to a whole number below four digits', () => {
    expect(formatAiCreditsBalance(688.77)).toBe('689');
    expect(formatAiCreditsBalance(412.5)).toBe(WHOLE.format(412.5));
    expect(formatAiCreditsBalance(1.005)).toBe('1');
    expect(formatAiCreditsBalance(999.4)).toBe('999');
  });

  it('humanizes balances that round to four digits or more', () => {
    expect(formatAiCreditsBalance(999.5)).toBe(COMPACT.format(999.5));
    expect(formatAiCreditsBalance(1250)).toBe(COMPACT.format(1250));
    expect(formatAiCreditsBalance(1234567.891)).toBe(
      COMPACT.format(1234567.891),
    );
    expect(formatAiCreditsBalance(1250)).not.toBe(WHOLE.format(1250));
  });

  it('shows a real zero rather than hiding it', () => {
    expect(formatAiCreditsBalance(0)).toBe('0');
    expect(formatAiCreditsBalance(-0.001)).toBe('0');
    expect(formatAiCreditsBalance(-0.49)).toBe('0');
  });

  it('keeps the sign of a negative balance', () => {
    expect(formatAiCreditsBalance(-12.4)).toMatch(/^[-−]12$/);
    expect(formatAiCreditsBalance(-2500)).toBe(COMPACT.format(-2500));
  });

  it('treats unknown and non-finite balances as unknown, never zero', () => {
    expect(formatAiCreditsBalance(null)).toBeNull();
    expect(formatAiCreditsBalance(Number.NaN)).toBeNull();
    expect(formatAiCreditsBalance(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('aiCreditsBalanceTone', () => {
  it.each([
    [10.01, 'healthy'],
    [688.77, 'healthy'],
    [10, 'low'],
    [5.01, 'low'],
    [5, 'critical'],
    [0.01, 'critical'],
    [0, 'critical'],
    [-3, 'critical'],
  ] as const)('reads %s credits as %s', (balance, tone) => {
    expect(aiCreditsBalanceTone(balance)).toBe(tone);
  });
});

describe('SidebarAiCreditsMenuItem', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function item(): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-account-menu-item-ai-credits"]',
    );
    if (!element) throw new Error('AI Credits row did not render');
    return element;
  }

  function pill(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="sidebar-account-menu-item-ai-credits-balance"]',
    );
  }

  it('shows the label and balance and reports selection', () => {
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <SidebarAiCreditsMenuItem
          balanceCredits={688.77}
          onSelect={onSelect}
        />,
      ),
    );

    expect(item().getAttribute('role')).toBe('menuitem');
    expect(item().textContent).toContain(AI_CREDITS_LABEL);
    expect(pill()?.textContent).toBe('689');
    expect(pill()?.getAttribute('title')).toBeNull();
    expect(item().getAttribute('aria-label')).toBe('AI Credits, 689 available');

    act(() => item().click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows no number while the balance is unknown', () => {
    act(() =>
      root.render(
        <SidebarAiCreditsMenuItem balanceCredits={null} onSelect={jest.fn()} />,
      ),
    );

    expect(pill()).toBeNull();
    expect(item().getAttribute('aria-label')).toBe(AI_CREDITS_LABEL);
  });

  it.each([
    ['needs_purchase', 'Free AI Credits'],
    ['needs_sign_in_then_purchase', 'Free AI Credits'],
    ['unlocked', 'AI Credits'],
    [undefined, 'AI Credits'],
  ] as const)(
    'labels the row for %s access in its text and name',
    (libraryAccess, label) => {
      act(() =>
        root.render(
          <SidebarAiCreditsMenuItem
            balanceCredits={0}
            libraryAccess={libraryAccess}
            onSelect={jest.fn()}
          />,
        ),
      );

      expect(item().querySelector('.truncate')?.textContent).toBe(label);
      expect(item().getAttribute('aria-label')).toBe(`${label}, 0 available`);
      expect(pill()?.textContent).toBe('0');
      expect(pill()?.dataset.tone).toBe('critical');
    },
  );

  it('names the free label without a number while the balance is unknown', () => {
    act(() =>
      root.render(
        <SidebarAiCreditsMenuItem
          balanceCredits={null}
          libraryAccess="needs_purchase"
          onSelect={jest.fn()}
        />,
      ),
    );

    expect(pill()).toBeNull();
    expect(item().getAttribute('aria-label')).toBe('Free AI Credits');
  });

  it('drops the free label when access unlocks on rerender', () => {
    const render = (
      libraryAccess: 'needs_purchase' | 'unlocked' | undefined,
    ): void =>
      act(() =>
        root.render(
          <SidebarAiCreditsMenuItem
            balanceCredits={12.4}
            libraryAccess={libraryAccess}
            onSelect={jest.fn()}
          />,
        ),
      );

    render(undefined);
    expect(item().getAttribute('aria-label')).toBe('AI Credits, 12 available');
    render('needs_purchase');
    expect(item().getAttribute('aria-label')).toBe(
      'Free AI Credits, 12 available',
    );
    render('unlocked');
    expect(item().getAttribute('aria-label')).toBe('AI Credits, 12 available');
    expect(item().querySelector('.truncate')?.textContent).toBe('AI Credits');
    expect(pill()?.textContent).toBe('12');
  });

  it('shows a zero balance as critical', () => {
    act(() =>
      root.render(
        <SidebarAiCreditsMenuItem balanceCredits={0} onSelect={jest.fn()} />,
      ),
    );

    expect(pill()?.textContent).toBe('0');
    expect(pill()?.dataset.tone).toBe('critical');
  });

  it.each([
    [42, 'healthy', 'fg-success-strong'],
    [7.5, 'low', 'fg-warning-strong'],
    [3, 'critical', 'fg-destructive-strong'],
  ] as const)(
    'tints a %s credit balance as %s',
    (balanceCredits, tone, inkClass) => {
      act(() =>
        root.render(
          <SidebarAiCreditsMenuItem
            balanceCredits={balanceCredits}
            onSelect={jest.fn()}
          />,
        ),
      );

      expect(pill()?.dataset.tone).toBe(tone);
      expect(pill()?.className).toContain(inkClass);
      expect(pill()?.className).toContain('rounded-full');
    },
  );

  it('humanizes a large balance and keeps the full number accessible', () => {
    act(() =>
      root.render(
        <SidebarAiCreditsMenuItem
          balanceCredits={1234567.891}
          onSelect={jest.fn()}
        />,
      ),
    );

    expect(pill()?.textContent).toBe(COMPACT.format(1234567.891));
    expect(pill()?.getAttribute('title')).toBe(WHOLE.format(1234568));
    expect(item().getAttribute('aria-label')).toBe(
      `AI Credits, ${WHOLE.format(1234568)} available`,
    );
  });
});
