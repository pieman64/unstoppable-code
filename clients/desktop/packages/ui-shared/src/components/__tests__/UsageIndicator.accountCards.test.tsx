/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  UsageIndicatorAccountSummary,
  UsageSectionHeader,
  UsageTextAction,
  type UsageIndicatorAccountSummaryProps,
} from '../UsageIndicator';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const LIMITS: UsageIndicatorAccountSummaryProps['limits'] = [
  { id: 'five-hour', label: '5-hour window', usedPercent: 15 },
  { id: 'seven-day', label: '7-day window', usedPercent: 69 },
  { id: 'seven-day-fable', label: '7-day Fable', usedPercent: 0 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: JSX.Element): void {
  act(() => root.render(node));
}

function FoldingCard(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <UsageIndicatorAccountSummary
      providerLabel="Claude"
      plan="Claude Max 20x"
      account="sam@example.com"
      limits={LIMITS}
      detail="65% of turns"
      icon={<svg data-testid="mark" />}
      disclosure={{
        expanded,
        onToggle: () => setExpanded((value) => !value),
        leadLimitId: 'seven-day',
      }}
    />
  );
}

function limitLabels(): string[] {
  return Array.from(
    container.querySelectorAll('[role="progressbar"]'),
    (bar) => bar.getAttribute('aria-label') ?? '',
  );
}

describe('UsageIndicatorAccountSummary as a card', () => {
  it('folds to the lead meter beside the plan and opens every limit, lead first', () => {
    render(<FoldingCard />);
    const card = container.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(card?.textContent).toContain('sam@example.com');
    expect(card?.textContent).toContain('Claude Max 20x');
    expect(card?.textContent).toContain('65% of turns');
    expect(card?.querySelector('[data-testid="mark"]')).toBeInstanceOf(Element);
    // Folded: only the lead meter, named and valued as its full row.
    expect(limitLabels()).toEqual(['7-day window used']);
    expect(card?.textContent).not.toContain('5-hour window');

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-account-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    // The mini meter hides; the rows show with the lead first.
    const mini = container.querySelector(
      '[data-testid="usage-indicator-account-mini"]',
    );
    expect(mini?.className).toContain('invisible');
    expect(limitLabels()).toEqual([
      '7-day window used',
      '7-day window used',
      '5-hour window used',
      '7-day Fable used',
    ]);
  });

  it('shows every limit and no toggle when the card does not fold', () => {
    render(
      <UsageIndicatorAccountSummary
        providerLabel="Claude"
        plan="Claude Max 20x"
        account="sam@example.com"
        limits={LIMITS}
        detail="100% of turns"
      />,
    );
    expect(
      container.querySelector('[data-testid="usage-indicator-account-toggle"]'),
    ).toBeNull();
    expect(limitLabels()).toEqual([
      '5-hour window used',
      '7-day window used',
      '7-day Fable used',
    ]);
  });

  it('keeps the classic header without a detail', () => {
    const onManage = jest.fn();
    render(
      <UsageIndicatorAccountSummary
        providerLabel="Claude"
        plan="Claude Max 20x"
        account="sam@example.com"
        limits={LIMITS}
        onManage={onManage}
      />,
    );
    expect(container.textContent).toContain('Claude Max 20x(sam@example.com)');
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Manage Claude"]')
      ?.click();
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});

describe('UsageSectionHeader', () => {
  it('toggles from the row while its action stays separate', () => {
    const onToggle = jest.fn();
    const onManage = jest.fn();
    render(
      <UsageSectionHeader
        label="Proxy accounts"
        expanded
        onToggle={onToggle}
        testId="section"
        action={
          <UsageTextAction
            label="Manage"
            ariaLabel="Manage proxy accounts"
            onClick={onManage}
          />
        }
      />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="section"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.textContent).toBe('Proxy accounts');
    act(() => toggle?.click());
    expect(onToggle).toHaveBeenCalledTimes(1);

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Manage proxy accounts"]',
        )
        ?.click(),
    );
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
