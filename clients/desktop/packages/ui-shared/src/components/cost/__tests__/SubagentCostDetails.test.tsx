/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CostAttributedItem } from '@canopy/protocol/cost-view';
import { SubagentCostDetails } from '../SubagentCostDetails';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BASE_ITEM: CostAttributedItem = {
  id: 'delegate-1',
  kind: 'delegation',
  label: 'Write the store tests',
  model: 'GPT 6 Sol',
  harness: 'Codex',
  billingBasis: 'ai_credits',
  tokens: {
    input: 182_000,
    output: 21_400,
    cacheReadInputTokens: 896_000,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
  },
  usd: 0.9,
  costStatus: 'estimated',
  inclusion: 'additional',
  runCount: 2,
  status: 'completed',
};

describe('SubagentCostDetails', () => {
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

  it('shows an estimated delegation, its tokens, AI Credits and run count', () => {
    act(() => root.render(<SubagentCostDetails item={BASE_ITEM} />));

    expect(container.textContent).toContain('$0.90');
    expect(container.textContent).toContain('observed');
    expect(container.textContent).toContain('182.0k');
    expect(container.textContent).toContain('21.4k');
    expect(container.textContent).toContain('896.0k');
    expect(container.textContent).toContain(
      'AI Credits, estimated at API prices',
    );
    expect(container.textContent).toContain('2 runs');
    expect(container.textContent).not.toContain(
      'Part of the cost of the chat turn that started it.',
    );
    expect(container.textContent).not.toContain('Organization');
  });

  it('shows total-only tokens instead of a misleading per-kind breakdown', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            totalTokens: 11_293_358,
            tokens: {
              input: 0,
              output: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              reasoningOutputTokens: 0,
            },
          }}
        />,
      ),
    );

    const labels = Array.from(container.querySelectorAll('dt')).map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(['Tokens', 'Paid by', 'Runs']);
    expect(container.textContent).toContain('11.3M');
    expect(container.textContent).not.toContain('Input');
    expect(container.textContent).not.toContain('Output');
    expect(container.textContent).not.toContain('Cache read');
  });

  it('notes that an included native subagent is part of its starting turn', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            id: 'native-1',
            kind: 'claude_task',
            billingBasis: 'subscription',
            costStatus: 'reported',
            inclusion: 'included',
          }}
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="subagent-cost-details-included"]')
        ?.textContent,
    ).toBe('Part of the cost of the chat turn that started it.');
  });

  it('uses Not priced and labels why no dollars were reported', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            billingBasis: 'org_gateway',
            usd: undefined,
            costStatus: 'not_priced',
            inclusion: 'included',
          }}
          testId="unpriced-item"
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="unpriced-item-total-amount"]')
        ?.textContent,
    ).toBe('Not priced');
    expect(container.textContent).toContain('Organization gateway, not priced');
  });

  it('reads as pending, not unpriced, while its turn is still running', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            kind: 'claude_task',
            billingBasis: 'subscription',
            usd: undefined,
            costStatus: 'not_priced',
            inclusion: 'included',
            status: 'running',
          }}
          testId="pending-item"
        />,
      ),
    );

    expect(
      container.querySelector('[data-testid="pending-item-total-amount"]')
        ?.textContent,
    ).toBe('Priced when the turn ends');
    expect(container.textContent).not.toContain('not priced');
  });

  it('offers Session breakdown only when a callback is supplied', () => {
    const onOpen = jest.fn();
    act(() =>
      root.render(
        <SubagentCostDetails
          item={BASE_ITEM}
          onOpenSessionBreakdown={onOpen}
        />,
      ),
    );
    const action = container.querySelector<HTMLButtonElement>(
      '[data-testid="subagent-cost-details-open-breakdown"]',
    );
    expect(action?.textContent).toBe('Session breakdown');
    act(() => action?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);

    act(() => root.render(<SubagentCostDetails item={BASE_ITEM} />));
    expect(
      container.querySelector(
        '[data-testid="subagent-cost-details-open-breakdown"]',
      ),
    ).toBeNull();
  });

  it('names the proxy account that served a subagent and blocks it from replay', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            kind: 'claude_task',
            billingBasis: 'account_proxy',
            costStatus: 'reported',
            inclusion: 'included',
            proxyAccounts: [
              {
                accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
                label: 'sam@example.com',
                provider: 'claude',
              },
            ],
          }}
        />,
      ),
    );

    expect(container.textContent).toContain(
      'Account proxy, estimated at API prices',
    );
    const account = container.querySelector(
      '[data-testid="subagent-cost-details-account"]',
    );
    expect(account?.textContent).toBe('sam@example.com via account proxy');
    expect(account?.querySelector('.ph-no-capture')?.textContent).toBe(
      'sam@example.com',
    );
  });

  it('counts the accounts when the proxy moved the work, with a fallback name', () => {
    act(() =>
      root.render(
        <SubagentCostDetails
          item={{
            ...BASE_ITEM,
            billingBasis: 'account_proxy',
            proxyAccounts: [
              { accountKey: 'proxy:conn-1:a', label: 'sam@example.com' },
              { accountKey: 'proxy:conn-1:b', label: '', provider: 'codex' },
            ],
          }}
        />,
      ),
    );

    const account = container.querySelector(
      '[data-testid="subagent-cost-details-account"]',
    );
    expect(account?.textContent).toBe(
      '2 accounts via account proxy · switched accounts',
    );
    expect(
      account?.querySelector('.ph-no-capture')?.getAttribute('title'),
    ).toBe('sam@example.com, Codex account');
  });

  it('shows no Account row without the proxy', () => {
    act(() => root.render(<SubagentCostDetails item={BASE_ITEM} />));
    expect(
      container.querySelector('[data-testid="subagent-cost-details-account"]'),
    ).toBeNull();
  });
});
