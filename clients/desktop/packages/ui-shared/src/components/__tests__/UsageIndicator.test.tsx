/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  UsageIndicator,
  formatCreditCount,
  UsageIndicatorAccountSummary,
  type UsageIndicatorUsage,
  getUsageRingTone,
} from '../UsageIndicator';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../../lib/row-chips';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const BASE_USAGE: UsageIndicatorUsage = {
  contextTokens: 64_000,
  contextWindow: 200_000,
  totalCostUsd: 0.5,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
  durationMs: 83_000,
  numTurns: 1,
  model: 'gpt-6-sol',
};

const SEEDED_USAGE: UsageIndicatorUsage = {
  contextTokens: 0,
  contextWindow: 200_000,
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  numTurns: 0,
  model: 'claude-sonnet-4-6',
};

describe('UsageIndicator', () => {
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

  async function renderAndOpen(
    usage: UsageIndicatorUsage | undefined,
    isCodex: boolean,
    seedUsage?: UsageIndicatorUsage,
  ): Promise<void> {
    act(() => {
      root.render(
        <UsageIndicator
          usage={usage}
          isCodex={isCodex}
          seedUsage={seedUsage}
        />,
      );
    });
    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected usage indicator button');
    }
    expect(button.getAttribute('aria-label')).toBe('Usage indicator');
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );

      await Promise.resolve();
    });
  }

  /** The session breakdown folds under the Context row. */
  function expandDetails(): void {
    const toggle = document.body.querySelector(
      '[data-testid="usage-indicator-context"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) return;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  }

  it('shows reported Codex context usage in the composer popover', async () => {
    await renderAndOpen(BASE_USAGE, true);

    expect(
      document.body.querySelector('[data-testid="usage-indicator-context"]')
        ?.textContent,
    ).toBe('Context64.0k / 200.0k (32%)');
    expect(
      document.body
        .querySelector('[aria-label="Context window used"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('32');
  });

  it('closes on Escape and returns focus to the ring', async () => {
    await renderAndOpen(BASE_USAGE, false);
    const trigger = container.querySelector('button');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-popover"]'),
    ).toBeNull();
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('offers Manage only when the host supplies a separate destination', () => {
    const summary = (onManage?: () => void): JSX.Element => (
      <UsageIndicatorAccountSummary
        providerLabel="Cursor"
        limits={[]}
        onManage={onManage}
      />
    );
    act(() => {
      root.render(summary());
    });
    expect(container.querySelector('[aria-label="Manage Cursor"]')).toBeNull();
    act(() => {
      root.render(summary((): void => {}));
    });
    expect(
      container.querySelector('[aria-label="Manage Cursor"]')?.textContent,
    ).toBe('Manage');
  });

  it('shows the signed-in account', () => {
    act(() => {
      root.render(
        <UsageIndicatorAccountSummary
          providerLabel="Claude"
          plan="Claude Max"
          account="alice@example.com"
          limits={[]}
        />,
      );
    });
    const account = container.querySelector(
      '[data-testid="usage-indicator-account-label"]',
    );
    expect(account?.textContent).toBe('(alice@example.com)');
    // Session replay blocks the email itself, not the label around it.
    expect(account?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    const blocks = container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.textContent).toBe('alice@example.com');
    // No attribute outside the block (a recorded tooltip title) repeats it.
    const recorded = Array.from(container.querySelectorAll('*')).filter(
      (element) =>
        element.closest(`.${REPLAY_BLOCK_CLASS}`) === null &&
        Array.from(element.attributes).some((attribute) =>
          attribute.value.includes('alice@example.com'),
        ),
    );
    expect(recorded).toEqual([]);
  });

  it('splits the context meter by category and lists them when expanded', async () => {
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex={false}
          contextBreakdown={{
            maxTokens: 200_000,
            categories: [
              { name: 'Messages', tokens: 50_000, kind: 'used' },
              { name: 'System prompt', tokens: 4_000, kind: 'used' },
              { name: 'Skills', tokens: 0, kind: 'used' },
              { name: 'Autocompact buffer', tokens: 6_000, kind: 'buffer' },
              { name: 'Free space', tokens: 140_000, kind: 'free' },
              { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
            ],
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });

    // One segment per in-window part with tokens; free space is the track.
    const meter = document.body.querySelector(
      '[aria-label="Context window by category"]',
    );
    expect(meter?.children).toHaveLength(3);

    expandDetails();
    const rows = Array.from(
      document.body.querySelectorAll(
        '[data-testid="usage-indicator-context-breakdown"] > div',
      ),
    ).map((row) => row.textContent);
    expect(rows).toEqual([
      'Messages50.0k25.0%',
      'System prompt4.0k2.0%',
      'Autocompact buffer6.0k3.0%',
      'Free space140.0k70.0%',
    ]);
    // Tools that load on demand take no room yet: one note, not rows.
    // Tools that load on demand take no room in the window: left out.
    expect(document.body.textContent).not.toContain('MCP tools (deferred)');
    expect(document.body.textContent).not.toContain('on demand');
    // Tabs show one list at a time: the split first, and the session's
    // cost, duration, turns, model and tokens behind Session. They are the
    // shared segmented picker, whose raised surface is the secondary
    // button's.
    const tabList = document.body.querySelector(
      '[data-testid="usage-indicator-details-switch"]',
    );
    expect(tabList?.getAttribute('role')).toBe('tablist');
    expect(tabList?.getAttribute('aria-label')).toBe('Usage details');
    const contextTab = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-details-context"]',
    );
    const sessionView = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="usage-indicator-details-session"]',
    );
    for (const tab of [contextTab, sessionView]) {
      expect(tab?.getAttribute('role')).toBe('tab');
    }
    expect(contextTab?.getAttribute('aria-selected')).toBe('true');
    expect(sessionView?.getAttribute('aria-selected')).toBe('false');
    expect(
      document.body.querySelector(
        '[data-testid="usage-indicator-details-switch-indicator"]',
      )?.className,
    ).toContain(SECONDARY_SURFACE_SHELL_CLASS);
    // Both lists share one cell so the popover keeps its height; the one
    // not shown is hidden from view and from assistive tech.
    const viewOf = (view: string): Element | null =>
      document.body.querySelector(`[data-usage-view="${view}"]`);
    for (const [view, tab] of [
      ['context', contextTab],
      ['session', sessionView],
    ] as const) {
      expect(viewOf(view)?.getAttribute('role')).toBe('tabpanel');
      expect(tab?.getAttribute('aria-controls')).toBe(viewOf(view)?.id);
      expect(viewOf(view)?.getAttribute('aria-labelledby')).toBe(tab?.id);
    }
    expect(viewOf('session')?.getAttribute('aria-hidden')).toBe('true');
    expect(viewOf('session')?.className).toContain('invisible');
    await act(async () => {
      sessionView?.click();

      await Promise.resolve();
    });
    expect(sessionView?.getAttribute('aria-selected')).toBe('true');
    expect(contextTab?.getAttribute('aria-selected')).toBe('false');
    expect(viewOf('context')?.getAttribute('aria-hidden')).toBe('true');
    expect(viewOf('session')?.getAttribute('aria-hidden')).toBe('false');
    expect(viewOf('session')?.parentElement).toBe(
      viewOf('context')?.parentElement,
    );
    const details = document.body.querySelector(
      '[data-testid="usage-indicator-details"]',
    );
    expect(details?.textContent).toContain('Cost$0.50');
    expect(details?.textContent).toContain('Duration1m 23s');
    expect(details?.textContent).toContain('Turns1');
    expect(details?.textContent).toContain('Modelgpt-6-sol');
    expect(details?.textContent).toContain('Input100');
    expect(details?.textContent).toContain('Cache write5');
    // Both are what the Context row expands.
    expect(
      document.body
        .querySelector('[data-testid="usage-indicator-context"]')
        ?.getAttribute('aria-controls'),
    ).toBe(
      document.body.querySelector('[data-testid="usage-indicator-expanded"]')
        ?.id,
    );
  });

  describe('AI Credits balance', () => {
    function renderBalance(
      props: Partial<Parameters<typeof UsageIndicator>[0]> = {},
    ): HTMLButtonElement {
      act(() => {
        root.render(
          <UsageIndicator
            usage={BASE_USAGE}
            isCodex={false}
            capsule
            {...props}
          />,
        );
      });
      const button = container.querySelector('[data-testid="usage-indicator"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error('no trigger');
      return button;
    }

    async function open(button: HTMLButtonElement): Promise<HTMLElement> {
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      const popover = document.body.querySelector(
        '[data-testid="usage-indicator-popover"]',
      );
      if (!(popover instanceof HTMLElement)) throw new Error('no popover');
      return popover;
    }

    it.each([
      [42, '42'],
      [0, '0'],
      [0.25, '0.25'],
      [12_500.5, '12,500.5'],
    ])(
      'shows a %s balance in the trigger, its name and the popover',
      async (credits, count) => {
        const text = `${count} AI Credits`;
        const button = renderBalance({ creditBalance: { credits } });
        // The context ring stays beside the balance.
        expect(button.textContent).toBe(text);
        expect(button.querySelector('svg')).not.toBeNull();
        expect(
          button.querySelector('[data-testid="usage-indicator-credit-balance"]')
            ?.textContent,
        ).toBe(text);
        expect(button.getAttribute('aria-label')).toBe(
          `Usage indicator, ${text}`,
        );
        const popover = await open(button);
        const account = popover.querySelector(
          '[data-testid="usage-indicator-account"]',
        );
        // One row: the label once, then the figure, never a second
        // "AI Credits" or a "left".
        expect(account?.textContent).toBe(`AI Credits${count}`);
        expect(
          account?.querySelector(
            '[data-testid="usage-indicator-account-credit-balance"]',
          )?.textContent,
        ).toBe(count);
      },
    );

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
      'shows nothing for an invalid balance (%s)',
      (credits) => {
        const button = renderBalance({ creditBalance: { credits } });
        expect(
          button.querySelector(
            '[data-testid="usage-indicator-credit-balance"]',
          ),
        ).toBeNull();
        expect(button.getAttribute('aria-label')).toBe('Usage indicator');
        expect(button.querySelector('svg')).not.toBeNull();
      },
    );

    it('replaces the subscription summary with the AI Credits balance', async () => {
      const button = renderBalance({
        creditBalance: { credits: 5 },
        accountUsage: <div data-testid="subscription-usage">Claude Max</div>,
      });
      const popover = await open(button);
      expect(
        popover.querySelector('[data-testid="subscription-usage"]'),
      ).toBeNull();
      expect(
        popover.querySelector('[data-testid="usage-indicator-account"]')
          ?.textContent,
      ).toBe('AI Credits5');
    });

    it('keeps the subscription summary without a balance', async () => {
      const button = renderBalance({
        accountUsage: <div data-testid="subscription-usage">Claude Max</div>,
      });
      const popover = await open(button);
      expect(
        popover.querySelector('[data-testid="subscription-usage"]'),
      ).not.toBeNull();
    });

    it('shows the balance in place of the Usage label for a response-usage chat', async () => {
      const button = renderBalance({
        creditBalance: { credits: 3 },
        responseUsage: {
          message: 'Tokens for the latest response.',
          note: 'Billed through AI Credits.',
          usage: { inputTokens: 12, outputTokens: 3 },
        },
      });
      expect(button.textContent).toBe('3 AI Credits');
      const popover = await open(button);
      expect(popover.textContent).toContain('Input12');
      expect(
        popover.querySelector('[data-testid="usage-indicator-account"]')
          ?.textContent,
      ).toBe('AI Credits3');
    });

    it('offers Manage only when the host supplies it', async () => {
      const onManage = jest.fn();
      const button = renderBalance({
        creditBalance: { credits: 3, onManage },
      });
      const popover = await open(button);
      const manage = popover.querySelector<HTMLButtonElement>(
        'button[aria-label="Manage AI Credits"]',
      );
      expect(manage).not.toBeNull();
      act(() => manage?.click());
      expect(onManage).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['needs_purchase', 'Free AI Credits'],
      ['needs_sign_in_then_purchase', 'Free AI Credits'],
      ['unlocked', 'AI Credits'],
      ['needs_sign_in', 'AI Credits'],
    ] as const)(
      'labels the balance for %s access',
      async (libraryAccess, label) => {
        const onManage = jest.fn();
        const button = renderBalance({
          creditBalance: { credits: 3.2, libraryAccess, onManage },
        });
        expect(
          button.querySelector('[data-testid="usage-indicator-credit-balance"]')
            ?.textContent,
        ).toBe(`3.2 ${label}`);
        expect(button.getAttribute('aria-label')).toBe(
          `Usage indicator, 3.2 ${label}`,
        );
        const popover = await open(button);
        const account = popover.querySelector(
          '[data-testid="usage-indicator-account"]',
        );
        expect(account?.getAttribute('aria-label')).toBe(`${label} balance`);
        expect(account?.querySelector('.fg-primary')?.textContent).toBe(label);
        expect(
          account?.querySelector(
            '[data-testid="usage-indicator-account-credit-balance"]',
          )?.textContent,
        ).toBe('3.2');
        // The management action keeps its plain product name.
        expect(
          popover.querySelector('button[aria-label="Manage AI Credits"]'),
        ).not.toBeNull();
      },
    );

    it('follows access from unknown to pre-purchase to unlocked', () => {
      const name = (
        libraryAccess?: 'needs_purchase' | 'unlocked',
      ): string | null =>
        renderBalance({
          creditBalance: {
            credits: 0,
            ...(libraryAccess ? { libraryAccess } : {}),
          },
        }).getAttribute('aria-label');
      expect(name()).toBe('Usage indicator, 0 AI Credits');
      expect(name('needs_purchase')).toBe('Usage indicator, 0 Free AI Credits');
      expect(name('unlocked')).toBe('Usage indicator, 0 AI Credits');
    });

    it('opens from the keyboard like the plain meter', async () => {
      const button = renderBalance({ creditBalance: { credits: 3 } });
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(button.getAttribute('aria-expanded')).toBe('false');
      await open(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    describe('a pending balance (CAN-5026)', () => {
      function slot(button: HTMLButtonElement): Element | null {
        return button.querySelector(
          '[data-testid="usage-indicator-credit-balance"]',
        );
      }

      function popoverFigure(): Element | null {
        return document.body.querySelector(
          '[data-testid="usage-indicator-account-credit-balance"]',
        );
      }

      it('holds the slot with a skeleton, busy and without a figure', () => {
        const button = renderBalance({ creditBalance: { credits: null } });
        const pending = slot(button);
        expect(pending).not.toBeNull();
        expect(pending?.getAttribute('data-pending')).toBe('true');
        expect(pending?.textContent).toBe('');
        expect(
          pending?.querySelector('.canopy-inline-skeleton'),
        ).not.toBeNull();
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Usage indicator');
        // The ring stays, and no loading prose is added.
        expect(button.querySelector('svg')).not.toBeNull();
        expect(button.textContent).toBe('');
      });

      it('moves numeric → pending → numeric with the popover open', async () => {
        const onManage = jest.fn();
        const button = renderBalance({
          creditBalance: { credits: 3.2, onManage },
        });
        const popover = await open(button);
        expect(popoverFigure()?.textContent).toBe('3.2');
        expect(button.hasAttribute('aria-busy')).toBe(false);

        renderBalance({ creditBalance: { credits: null, onManage } });
        expect(button.getAttribute('aria-busy')).toBe('true');
        expect(button.getAttribute('aria-label')).toBe('Usage indicator');
        expect(button.textContent).not.toContain('3.2');
        expect(popover.isConnected).toBe(true);
        expect(popover.textContent).not.toContain('3.2');
        const account = popover.querySelector(
          '[data-testid="usage-indicator-account"]',
        );
        expect(account?.getAttribute('aria-busy')).toBe('true');
        expect(account?.textContent).toBe('AI CreditsManage');
        expect(
          popoverFigure()?.querySelector('.canopy-inline-skeleton'),
        ).not.toBeNull();
        // Manage stays usable while the figure loads.
        const manage = popover.querySelector<HTMLButtonElement>(
          'button[aria-label="Manage AI Credits"]',
        );
        act(() => manage?.click());
        expect(onManage).toHaveBeenCalledTimes(1);

        renderBalance({ creditBalance: { credits: 1200, onManage } });
        expect(button.hasAttribute('aria-busy')).toBe(false);
        expect(button.getAttribute('aria-label')).toBe(
          'Usage indicator, 1,200 AI Credits',
        );
        expect(slot(button)?.textContent).toBe('1,200 AI Credits');
        expect(popoverFigure()?.textContent).toBe('1,200');
        expect(account?.hasAttribute('aria-busy')).toBe(false);
      });

      it('keeps the wide capsule while pending', () => {
        const button = renderBalance({ creditBalance: { credits: 3.2 } });
        const wide = button.className;
        renderBalance({ creditBalance: { credits: null } });
        expect(button.className).toBe(wide);
        renderBalance({});
        expect(button.className).not.toBe(wide);
      });

      it.each([3.2, 1200, 123456789])(
        'sizes both skeletons to the figures they replaced (%s)',
        async (credits) => {
          const width = jest
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockReturnValue(new DOMRect(0, 0, 87, 16));
          try {
            const button = renderBalance({ creditBalance: { credits } });
            await open(button);
            renderBalance({ creditBalance: { credits: null } });
            expect(
              slot(button)?.querySelector<HTMLElement>(
                '.canopy-inline-skeleton',
              )?.style.width,
            ).toBe('87px');
            expect(
              popoverFigure()?.querySelector<HTMLElement>(
                '.canopy-inline-skeleton',
              )?.style.width,
            ).toBe('87px');
            expect(
              slot(button)
                ?.querySelector('.canopy-inline-skeleton')
                ?.hasAttribute('data-active'),
            ).toBe(false);
            expect(
              popoverFigure()
                ?.querySelector('.canopy-inline-skeleton')
                ?.hasAttribute('data-active'),
            ).toBe(false);
          } finally {
            width.mockRestore();
          }
        },
      );

      it('offers no Manage while pending when the host supplies none', async () => {
        const button = renderBalance({ creditBalance: { credits: null } });
        const popover = await open(button);
        expect(
          popover.querySelector('button[aria-label="Manage AI Credits"]'),
        ).toBeNull();
        expect(
          popover.querySelector('[data-testid="usage-indicator-account"]')
            ?.textContent,
        ).toBe('AI Credits');
      });

      it('renders no slot when the balance is omitted', () => {
        const button = renderBalance({});
        expect(slot(button)).toBeNull();
        expect(button.hasAttribute('aria-busy')).toBe(false);
      });
    });
  });

  it('keeps the model on a response-tokens readout', async () => {
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex={false}
          modelLabel="Kimi K2 Thinking"
          responseUsage={{
            message: 'Tokens for the latest response.',
            note: 'Billed through AI Credits.',
            usage: { inputTokens: 12, outputTokens: 3 },
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    const popover = document.body.querySelector(
      '[data-testid="usage-indicator-popover"]',
    );
    expect(popover?.textContent).toContain('ModelKimi K2 Thinking');
    expect(popover?.textContent).toContain('Input12');
  });

  it('keeps reported context and estimates separate from turn counters and account spend', async () => {
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex={false}
          responseUsage={{
            title: 'Turn usage',
            message: 'Latest reported turn.',
            note: 'Account limits unavailable.',
            context: { usedTokens: 1234, maxTokens: 10000 },
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              reasoningTokens: 10,
              estimatedCostUsd: 0.75,
            },
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    const text = document.body.querySelector(
      '[data-testid="usage-indicator-popover"]',
    )?.textContent;
    expect(text).toContain('Turn usage');
    expect(text).toContain('Reasoning10');
    expect(text).toContain('Estimated cost$0.75');
    expect(text).toContain('1.2k / 10.0k');
    expect(text).not.toContain('Turns');
    expect(text).not.toContain('Cost$');
  });

  it('folds the session breakdown under the context row', async () => {
    await renderAndOpen(BASE_USAGE, false);

    expect(document.body.textContent).not.toContain('Cache read');
    expandDetails();
    expect(document.body.textContent).toContain('Cache read');
  });

  it('counts a credit balance instead of pricing it', async () => {
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex
          accountUsage={
            <UsageIndicatorAccountSummary
              providerLabel="Codex"
              plan="ChatGPT Pro"
              limits={[
                {
                  id: 'codex-primary',
                  label: '7-day window',
                  usedPercent: 63,
                  remainingCredits: 62_500,
                },
              ]}
            />
          }
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    const account = document.body.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(account?.textContent).toContain('62,500 credits left');
    expect(account?.textContent).not.toContain('$');
  });

  it('shows plan limits with a meter and a relative reset time', async () => {
    const now = Date.now();
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex={false}
          accountUsage={
            <UsageIndicatorAccountSummary
              providerLabel="Claude"
              plan="Claude Max 20x"
              limits={[
                {
                  id: 'five-hour',
                  label: '5-hour limit',
                  usedPercent: 5,
                  resetsAt: now + (2 * 60 + 45) * 60_000 - 1_000,
                },
              ]}
              onManage={(): void => {}}
            />
          }
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    const account = document.body.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(
      account?.querySelector('[data-testid="usage-indicator-plan"]')
        ?.textContent,
    ).toBe('Claude Max 20x');
    expect(account?.textContent).toContain('Resets in 2 hr 45 min');
    expect(account?.textContent).toContain('5%');
    expect(
      account
        ?.querySelector('[aria-label="5-hour limit used"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('5');
  });

  it('opens when the host window does not provide ResizeObserver', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      'ResizeObserver',
    );
    Reflect.deleteProperty(window, 'ResizeObserver');

    try {
      await expect(renderAndOpen(BASE_USAGE, true)).resolves.toBeUndefined();
      expect(
        document.body.querySelector('[data-testid="usage-indicator-popover"]'),
      ).not.toBeNull();
    } finally {
      if (descriptor) {
        Object.defineProperty(window, 'ResizeObserver', descriptor);
      }
    }
  });

  it('does not present the synthetic default as Codex context data', async () => {
    await renderAndOpen({ ...BASE_USAGE, contextTokens: 0 }, true);

    expect(document.body.textContent).not.toContain('Context');
    expect(document.body.textContent).toContain('Turns');
  });

  it('draws no empty context bar when nothing is counted in the window', async () => {
    await renderAndOpen({ ...BASE_USAGE, contextTokens: 0 }, false);

    // With nothing in the window and no split to show, the row would only
    // draw an empty bar; the session's figures show inline instead.
    expect(
      document.body.querySelector('[data-testid="usage-indicator-context"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain('Turns1');
  });

  it('renders cost, duration, model, and every token row for a Claude turn', async () => {
    await renderAndOpen(BASE_USAGE, false);
    expandDetails();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Cost');
    expect(text).toContain('$0.50');
    expect(text).toContain('Duration');
    expect(text).toContain('1m 23s');
    expect(text).toContain('gpt-6-sol');
    expect(text).toContain('Cache read');
    expect(text).toContain('Cache write');
  });

  it('hides cost, duration, and cache write for Codex', async () => {
    await renderAndOpen({ ...BASE_USAGE, totalCostUsd: 0 }, true);
    expandDetails();

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Cost');
    expect(text).not.toContain('Duration');
    expect(text).not.toContain('Cache write');
    expect(text).toContain('Cache read');
  });

  it('shows a Codex turn cost when the host priced it', async () => {
    // Cloud Core prices every turn through the gateway, Codex harness or not;
    // the app-server "never reports cost" rule only covers an unpriced zero.
    await renderAndOpen(BASE_USAGE, true);
    expandDetails();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Cost');
    expect(text).toContain('$0.50');
    expect(text).not.toContain('Duration');
    expect(text).not.toContain('Cache write');
  });

  it('hides the rows a runtime never reported instead of showing zeros', async () => {
    await renderAndOpen(
      {
        ...BASE_USAGE,
        totalCostUsd: undefined,
        durationMs: undefined,
        cacheCreationInputTokens: undefined,
      },
      false,
    );

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Cost');
    expect(text).not.toContain('Duration');
    expect(text).not.toContain('Cache write');
    expect(text).toContain('Context');
  });

  /** The Context row as it stands before the first reply. */
  function emptyContextRow(): Element | null {
    return document.body.querySelector(
      '[data-testid="usage-indicator-context-empty"]',
    );
  }

  // CAN-2799: after a model/session switch the tab can have no `usage` yet.
  // The meter must stay usable — not a dead 0% ring with a popover that
  // never opens.
  it('draws the context row with an empty bar before the first reply', async () => {
    await renderAndOpen(undefined, false, SEEDED_USAGE);

    // The same row and bar as after a reply, at zero, with nothing to expand.
    expect(emptyContextRow()?.textContent).toBe('Context0');
    expect(
      emptyContextRow()
        ?.querySelector('[aria-label="Context window used"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('0');
    expect(
      document.body.querySelector('[data-testid="usage-indicator-context"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
  });

  it('opens the popover without presenting a seeded window as Codex data', async () => {
    await renderAndOpen(undefined, true, {
      ...SEEDED_USAGE,
      model: 'gpt-6-sol',
    });

    // Zero is counted, so it shows; the seeded window is not Codex's report.
    expect(emptyContextRow()?.textContent).toBe('Context0');
    expect(document.body.textContent).not.toContain('200.0k');
    // Before the first reply every figure is 0, so none show.
    expect(document.body.textContent).not.toContain('Turns');
  });

  it('keeps only the category split before the first reply', async () => {
    act(() => {
      root.render(
        <UsageIndicator
          usage={undefined}
          seedUsage={SEEDED_USAGE}
          isCodex={false}
          contextBreakdown={{
            maxTokens: 200_000,
            categories: [
              { name: 'System prompt', tokens: 8_000, kind: 'used' },
              { name: 'Free space', tokens: 192_000, kind: 'free' },
            ],
          }}
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    expandDetails();
    expect(
      document.body.querySelector(
        '[data-testid="usage-indicator-context-breakdown"]',
      ),
    ).not.toBeNull();
    // Nothing to switch to: the zero figures stay hidden.
    expect(
      document.body.querySelector(
        '[data-testid="usage-indicator-details-switch"]',
      ),
    ).toBeNull();
    expect(document.body.textContent).not.toContain('Turns');
    // The live split already draws the row: no second, empty one.
    expect(emptyContextRow()).toBeNull();
    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
  });

  it('opens the popover even when neither usage nor a seed is known', async () => {
    await renderAndOpen(undefined, false);

    // No window to draw a bar against: the hint says what will fill it.
    expect(document.body.textContent).not.toContain('Context');
    expect(document.body.textContent).toContain(
      'Usage appears after the first reply.',
    );
  });

  it('does not show the empty-usage hint once a reply has been counted', async () => {
    await renderAndOpen(BASE_USAGE, false);

    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
    expect(emptyContextRow()).toBeNull();
  });

  it('stays closed when a hover is followed by a quick click open and close', async () => {
    jest.useFakeTimers();
    try {
      act(() => {
        root.render(<UsageIndicator usage={BASE_USAGE} isCodex={false} />);
      });
      const button = container.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Expected usage indicator button');
      }
      const click = async (): Promise<void> => {
        await act(async () => {
          button.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true }),
          );

          await Promise.resolve();
        });
      };
      const popover = (): Element | null =>
        document.body.querySelector('[data-testid="usage-indicator-popover"]');

      act(() => {
        button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      await click();
      expect(popover()).not.toBeNull();
      await click();
      expect(popover()).toBeNull();

      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(popover()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

test('a positive fractional wallet never formats as zero', () => {
  expect(formatCreditCount(0.004)).toBe('0.004');
  expect(formatCreditCount(0.000001)).toBe('0.000001');
});

test('the ring warns from 70% and turns destructive from 90%', () => {
  expect(getUsageRingTone(10)).toBe('neutral');
  expect(getUsageRingTone(69.9)).toBe('neutral');
  expect(getUsageRingTone(70)).toBe('warning');
  expect(getUsageRingTone(89.9)).toBe('warning');
  expect(getUsageRingTone(90)).toBe('destructive');
});
