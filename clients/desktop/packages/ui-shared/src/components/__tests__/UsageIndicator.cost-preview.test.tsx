/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { UsageIndicator, type UsageIndicatorUsage } from '../UsageIndicator';
import {
  UsageCostPreviewRow,
  type UsageCostPreview,
} from '../cost/UsageCostPreviewRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const USAGE: UsageIndicatorUsage = {
  contextTokens: 64_000,
  contextWindow: 200_000,
  totalCostUsd: 0.5,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 10,
  numTurns: 1,
  model: 'gpt-6-sol',
};

const COST_PREVIEW: UsageCostPreview = {
  usd: 1.25,
  notPricedCount: 0,
  bySource: {
    chat: 0.5,
    pipeline: 0,
    subagents: 0.75,
    delegations: 0,
    background: 0,
  },
};

describe('UsageIndicator cost preview', () => {
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

  async function renderOpen(
    props: {
      readonly costPreview?: UsageCostPreview;
      readonly responseUsage?: {
        readonly message: string;
        readonly note: string;
        readonly usage?: {
          readonly inputTokens: number;
          readonly outputTokens: number;
        };
      };
      readonly usage?: UsageIndicatorUsage;
    } = {},
  ): Promise<void> {
    act(() => {
      root.render(
        <UsageIndicator
          usage={props.usage ?? USAGE}
          isCodex={false}
          costPreview={
            props.costPreview === undefined ? undefined : (
              <UsageCostPreviewRow preview={props.costPreview} />
            )
          }
          responseUsage={props.responseUsage}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });
  }

  it('keeps the Session cost row when no preview is provided', async () => {
    await renderOpen();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).toBeNull();

    const context = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-context"]',
    );
    await act(async () => {
      context?.click();
      await Promise.resolve();
    });

    expect(
      document.body.querySelector('[data-testid="usage-indicator-details"]')
        ?.textContent,
    ).toContain('Cost$0.50');
  });

  it('shows a closed source preview and opens its amount-and-share list independently', async () => {
    await renderOpen({ costPreview: COST_PREVIEW });

    const row = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-cost"]',
    );
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    expect(row?.textContent).toContain('$1.25');
    expect(row?.getAttribute('aria-controls')).toBeTruthy();
    const controlledId = row?.getAttribute('aria-controls');
    expect(controlledId).not.toBeNull();
    expect(document.getElementById(controlledId ?? '')).toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="usage-indicator-cost-breakdown"]',
      ),
    ).toBeNull();
    expect(
      document.body.querySelector(
        '[role="img"][aria-label="Cost by source: Chat turns $0.50, Subagents $0.75"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      row?.click();
      await Promise.resolve();
    });

    expect(row?.getAttribute('aria-expanded')).toBe('true');
    const list = document.body.querySelector<HTMLElement>(
      '[data-testid="usage-indicator-cost-breakdown"]',
    );
    const controlled = document.getElementById(controlledId ?? '');
    expect(controlled?.contains(list)).toBe(true);
    expect(list?.textContent).toContain('Chat turns$0.5040%');
    expect(list?.textContent).toContain('Subagents$0.7560%');

    const context = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-context"]',
    );
    await act(async () => {
      context?.click();
      await Promise.resolve();
    });
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.body.querySelector(
        '[data-testid="usage-indicator-cost-breakdown"]',
      ),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-details"]')
        ?.textContent,
    ).not.toContain('Cost');
  });

  it('keeps Context details attached to Context, with Cost after them', async () => {
    await renderOpen({ costPreview: COST_PREVIEW });
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-indicator-context"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const expanded = document.body.querySelector(
      '[data-testid="usage-indicator-expanded"]',
    );
    const costRow = document.body.querySelector(
      '[data-testid="usage-indicator-cost"]',
    );
    expect(expanded).not.toBeNull();
    expect(costRow).not.toBeNull();
    if (expanded === null || costRow === null) return;
    expect(
      expanded.compareDocumentPosition(costRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps Cost where Context would be when there is no context meter', async () => {
    await renderOpen({
      costPreview: COST_PREVIEW,
      usage: { ...USAGE, contextTokens: 0 },
    });

    expect(
      document.body.querySelector('[data-testid="usage-indicator-context"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).not.toBeNull();
    const popoverText =
      document.body.querySelector('[data-testid="usage-indicator-popover"]')
        ?.textContent ?? '';
    expect(popoverText.indexOf('Cost')).toBeLessThan(
      popoverText.indexOf('Turns'),
    );
  });

  it('shows Not priced when the preview has no dollars but has unpriced work', async () => {
    await renderOpen({
      costPreview: {
        usd: 0,
        notPricedCount: 2,
        bySource: {
          chat: 0,
          pipeline: 0,
          subagents: 0,
          delegations: 0,
          background: 0,
        },
      },
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]')
        ?.textContent,
    ).toContain('Not priced');
  });

  it('does not show the preview in response-usage mode', async () => {
    await renderOpen({
      costPreview: COST_PREVIEW,
      responseUsage: {
        message: 'Tokens for this response.',
        note: 'Billed elsewhere.',
      },
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).toBeNull();
  });
});
