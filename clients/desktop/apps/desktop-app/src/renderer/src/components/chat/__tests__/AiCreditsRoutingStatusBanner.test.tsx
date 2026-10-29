/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AiCreditsRoutingStatusBanner } from '../AiCreditsRoutingStatusBanner';
import type {
  AgentUsageOverview,
  CanopyApi,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';

const mockRefreshProviderUsageSnapshot = jest.fn<
  Promise<AgentUsageOverview>,
  [string]
>();
jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: {
    getState: (): {
      refreshProviderUsageSnapshot: typeof mockRefreshProviderUsageSnapshot;
    } => ({
      refreshProviderUsageSnapshot: mockRefreshProviderUsageSnapshot,
    }),
  },
}));

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

const BALANCE_STATE: CanopyCloudAiCreditsState = {
  connected: true,
  email: 'alice@example.com',
  subscription: null,
  balance: { email: 'alice@example.com', credits: 100, eligible: true },
  noUdAccount: false,
  error: null,
};

/** Personal wallet empty, org pool covering — the "0 credits" bug's user. */
const ORG_FUNDED_STATE: CanopyCloudAiCreditsState = {
  ...BALANCE_STATE,
  balance: {
    email: 'alice@example.com',
    credits: 0,
    eligible: false,
    orgPool: { orgId: 'org_1', orgName: 'Acme' },
  },
};

describe('AiCreditsRoutingStatusBanner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const loadCanopyCloudAiCredits = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadCanopyCloudAiCredits.mockResolvedValue(BALANCE_STATE);
    Object.assign(window, {
      api: { loadCanopyCloudAiCredits } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  function banner(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="chat-input-ai-credits-active"]',
    );
  }

  it('is visible while idle when the chat is effectively billing to AI Credits', () => {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={false}
        />,
      ),
    );
    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('Using AI Credits');
  });

  it('is visible while a turn streams', () => {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={true}
        />,
      ),
    );
    expect(banner()).not.toBeNull();
  });

  it('is hidden when the chat is not billing to AI Credits', () => {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={false}
          turnActive={true}
        />,
      ),
    );
    expect(banner()).toBeNull();
  });

  it('is hidden when there is no target', () => {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={null}
          active={true}
          turnActive={false}
        />,
      ),
    );
    expect(banner()).toBeNull();
  });

  // Renders and flushes the balance read so the chip reflects the loaded state.
  async function renderLoaded(): Promise<void> {
    act(() => {
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={false}
        />,
      );
    });
    // Flush the balance read (and the state update it schedules) so the chip
    // reflects the loaded funding source rather than the pre-fetch null.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function chip(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('shows the personal balance when the wallet is funding the session', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 1240, eligible: true },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toBe(
      '1,240 credits',
    );
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
  });

  it('pluralizes a single credit', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 1, eligible: true },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toBe('1 credit');
  });

  it('never rounds a positive fractional wallet down to a 0 credits chip', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 0.4, eligible: true },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toBe(
      '<1 credit',
    );
    expect(banner()?.textContent).not.toMatch(/0 credits/);
  });

  it('stays payer-agnostic when the balance read has nothing trustworthy to say', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: null,
      error: 'network',
    });
    await renderLoaded();
    expect(banner()?.textContent).toContain(
      'This session is paid with AI Credits.',
    );
    expect(banner()?.textContent).not.toContain('from your credits');
    expect(banner()?.textContent).not.toContain('shared credit pool');
  });

  it('names the covering organization instead of the empty personal wallet', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ORG_FUNDED_STATE);
    await renderLoaded();
    expect(chip('chat-input-ai-credits-covered-by')?.textContent).toBe(
      'Covered by Acme',
    );
    expect(chip('chat-input-ai-credits-balance')).toBeNull();
    // The regression this whole change exists to prevent.
    expect(banner()?.textContent).not.toMatch(/0 credits/);
    // The message names the payer the value names, never personal credits.
    expect(banner()?.textContent).toContain(
      "Acme's shared credit pool is covering this session.",
    );
    expect(banner()?.textContent).not.toContain('from your credits');
  });

  it('reads the balance for the chat it belongs to (CAN-3463)', async () => {
    await renderLoaded();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
  });

  it("drops the previous chat's payer when the target changes (CAN-3463)", async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ORG_FUNDED_STATE);
    await renderLoaded();
    expect(chip('chat-input-ai-credits-covered-by')).not.toBeNull();

    // The next chat's read is still in flight: Acme must not stand in for it.
    let resolveNext: (state: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockImplementationOnce(
      () =>
        new Promise<CanopyCloudAiCreditsState>((resolve) => {
          resolveNext = resolve;
        }),
    );
    await act(async () => {
      root.render(
        <AiCreditsRoutingStatusBanner
          target={{ ...TARGET, chatId: 'other-chat' }}
          active={true}
          turnActive={false}
        />,
      );
      await Promise.resolve();
    });
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();

    await act(async () => {
      resolveNext(BALANCE_STATE);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toContain('100');
  });

  it('does not paint the previous owner while a new chat scope is committing', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(ORG_FUNDED_STATE);
    await renderLoaded();
    expect(chip('chat-input-ai-credits-covered-by')).not.toBeNull();

    loadCanopyCloudAiCredits.mockImplementationOnce(
      () => new Promise<CanopyCloudAiCreditsState>(() => {}),
    );
    act(() => {
      flushSync(() => {
        root.render(
          <AiCreditsRoutingStatusBanner
            target={{ ...TARGET, chatId: 'other-chat' }}
            active={true}
            turnActive={false}
          />,
        );
      });

      expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
      expect(chip('chat-input-ai-credits-balance')).toBeNull();
    });
  });

  it('shows no chip at all when the payer cannot be determined', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 0, eligible: false },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')).toBeNull();
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
    expect(banner()?.textContent).not.toMatch(/0 credits/);
  });

  // `loadCanopyCloudAiCredits` signals a transient failure by RETURNING
  // `{ error, balance: null }` rather than throwing, so the `catch` in the hook
  // is not the path a blip takes. Committing that state resolves the funding
  // source to `unknown` and the chip disappears mid-session — and because the
  // balance is re-read twice after every turn, one blip is likely.
  // Re-runs the "became visible" effect on the SAME mounted component, so the
  // hook re-reads while keeping the state it already resolved. Re-rendering with
  // unchanged props would not re-fire the effect, which would make these two
  // tests pass without ever exercising the second read.
  async function refetch(): Promise<void> {
    act(() => {
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={false}
          turnActive={false}
        />,
      );
    });
    const readsBefore = loadCanopyCloudAiCredits.mock.calls.length;
    await renderLoaded();
    expect(loadCanopyCloudAiCredits.mock.calls.length).toBeGreaterThan(
      readsBefore,
    );
  }

  it('keeps the last resolved chip when a re-read fails transiently', async () => {
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toMatch(
      /100 credits/,
    );

    loadCanopyCloudAiCredits.mockResolvedValue({
      connected: true,
      email: 'alice@example.com',
      subscription: null,
      balance: null,
      noUdAccount: false,
      error: 'network unreachable',
    });
    await refetch();

    expect(chip('chat-input-ai-credits-balance')?.textContent).toMatch(
      /100 credits/,
    );
  });

  // A blip holds the last value; an authoritative answer must still land, or the
  // chip would show a stale balance for an account that is no longer linked.
  it('still commits an authoritative no-UD-account result', async () => {
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')).not.toBeNull();

    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: null,
      noUdAccount: true,
      error: null,
    });
    await refetch();

    expect(chip('chat-input-ai-credits-balance')).toBeNull();
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
  });

  it('re-reads the balance shortly after a turn ends', () => {
    jest.useFakeTimers();
    try {
      // Turn is streaming and visible: one read on becoming visible.
      act(() =>
        root.render(
          <AiCreditsRoutingStatusBanner
            target={TARGET}
            active={true}
            turnActive={true}
          />,
        ),
      );
      const readsWhileStreaming = loadCanopyCloudAiCredits.mock.calls.length;

      // Turn ends while still visible: schedules the two delayed re-reads.
      act(() =>
        root.render(
          <AiCreditsRoutingStatusBanner
            target={TARGET}
            active={true}
            turnActive={false}
          />,
        ),
      );
      act(() => {
        jest.advanceTimersByTime(5_000);
      });
      expect(loadCanopyCloudAiCredits.mock.calls.length).toBeGreaterThan(
        readsWhileStreaming,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('AiCreditsRoutingStatusBanner switch to subscription (CAN-4200)', () => {
  const NOW = new Date('2026-10-14T12:00:00').getTime();
  let container: HTMLDivElement;
  let root: Root;

  function usage(resetsAt: number, usedPercent = 100): AgentUsageOverview {
    return {
      updatedAt: new Date(NOW).toISOString(),
      providers: [
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: usedPercent < 100,
          rateLimits: [
            {
              primary: {
                usedPercent,
                resetsAt: new Date(resetsAt).toISOString(),
              },
            },
          ],
        },
      ],
    };
  }

  function element(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  function resetLine(): string | null {
    return element('chat-input-ai-credits-limit-resets')?.textContent ?? null;
  }

  function button(): HTMLButtonElement | null {
    return container.querySelector(
      '[data-testid="chat-input-ai-credits-switch-to-subscription"]',
    );
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  async function render(
    props: Partial<Parameters<typeof AiCreditsRoutingStatusBanner>[0]> = {},
  ): Promise<void> {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={false}
          provider="claude"
          onSwitchToSubscription={jest.fn()}
          {...props}
        />,
      ),
    );
    await flush();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        loadCanopyCloudAiCredits: jest.fn().mockResolvedValue(BALANCE_STATE),
      } as Partial<CanopyApi> as CanopyApi,
    });
    mockRefreshProviderUsageSnapshot.mockResolvedValue(usage(NOW + 3_600_000));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('renders the button only with a handler, and clicking it switches', async () => {
    const onSwitchToSubscription = jest.fn();
    await render({ onSwitchToSubscription });
    expect(button()?.textContent).toBe('Switch to subscription');
    act(() => button()?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={false}
          provider="claude"
        />,
      ),
    );
    expect(button()).toBeNull();
  });

  it('shows when the current account’s limit resets', async () => {
    await render();
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledWith('claude');
    expect(resetLine()).toMatch(/^Your Claude limit resets at .+\.$/);
    expect(button()).not.toBeNull();
  });

  it('does not fetch or show a reset line without the button', async () => {
    act(() =>
      root.render(
        <AiCreditsRoutingStatusBanner
          target={TARGET}
          active={true}
          turnActive={false}
          provider="claude"
        />,
      ),
    );
    await flush();
    expect(mockRefreshProviderUsageSnapshot).not.toHaveBeenCalled();
    expect(resetLine()).toBeNull();
  });

  it('hides the reset line when no window is exhausted', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage(NOW + 3_600_000, 40),
    );
    await render();
    expect(resetLine()).toBeNull();
    expect(button()).not.toBeNull();
  });

  it('hides the reset line when the snapshot fetch fails', async () => {
    mockRefreshProviderUsageSnapshot.mockRejectedValue(new Error('offline'));
    await render();
    expect(resetLine()).toBeNull();
    expect(button()).not.toBeNull();
  });

  it('drops the reset line once the reset passes', async () => {
    await render();
    expect(resetLine()).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(3_600_000);
    });
    expect(resetLine()).toBeNull();
    expect(button()).not.toBeNull();
  });

  it('discards a snapshot requested before the latest account change', async () => {
    let resolveFirst: (value: AgentUsageOverview) => void = () => {};
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mockRefreshProviderUsageSnapshot.mockResolvedValueOnce(
      usage(NOW + 3_600_000, 0),
    );
    await render({ accountChangedAt: 1 });
    await render({ accountChangedAt: 2 });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(2);

    // The old account's exhausted window arrives late and must not show.
    resolveFirst(usage(NOW + 3_600_000));
    await flush();
    expect(resetLine()).toBeNull();
    expect(button()).not.toBeNull();
  });

  it('fetches once on visibility and again only when the account changes', async () => {
    await render({ accountChangedAt: 1 });
    await render({ accountChangedAt: 1, turnActive: true });
    await render({ accountChangedAt: 1, turnActive: false });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(1);

    await render({ accountChangedAt: 2 });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(2);

    await render({ accountChangedAt: 2, active: false });
    await render({ accountChangedAt: 2, active: true });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(3);
  });
});
