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
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import {
  resetAiCreditsArrivalForTests,
  useAiCreditsArrivalStore,
  type AiCreditsArrivalOrigin,
} from '@/lib/aiCreditsArrivalConfirmation';
import type {
  AgentUsageOverview,
  CanopyApi,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';

const mockRefreshProviderUsageSnapshot = jest.fn<
  Promise<AgentUsageOverview>,
  [string]
>();
const mockUsageListeners = new Set<
  (state: { usage: AgentUsageOverview | null }) => void
>();
jest.mock('@/stores/observabilityStore', () => ({
  useObservabilityStore: {
    subscribe: (
      listener: (state: { usage: AgentUsageOverview | null }) => void,
    ): (() => void) => {
      mockUsageListeners.add(listener);
      return (): void => {
        mockUsageListeners.delete(listener);
      };
    },
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
  balance: {
    email: 'alice@example.com',
    credits: 100,
    eligible: true,
    source: 'canopy',
  },
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
    source: 'canopy',
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
      '1,240 credits left',
    );
    expect(chip('chat-input-ai-credits-covered-by')).toBeNull();
    expect(banner()?.textContent).toContain(
      'Using AI Credits. 1,240 credits left.',
    );
  });

  it('pluralizes a single credit', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 1, eligible: true },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toBe(
      '1 credit left',
    );
  });

  it('never rounds a positive fractional wallet down to a 0 credits chip', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue({
      ...BALANCE_STATE,
      balance: { email: 'alice@example.com', credits: 0.4, eligible: true },
    });
    await renderLoaded();
    expect(chip('chat-input-ai-credits-balance')?.textContent).toBe(
      '<1 credit left',
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
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage(NOW + 3_600_000, 40),
    );
    const onSwitchToSubscription = jest.fn();
    await render({ onSwitchToSubscription });
    expect(button()?.textContent).toBe('Switch to subscription');
    // Staying on credits is the state the user chose; leaving it is an
    // alternative, so it never takes the accent.
    expect(button()?.className.split(/\s+/)).not.toContain('bg-accent');
    act(() => button()?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledTimes(1);
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'available',
      provider: 'claude',
    });

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
    expect(resetLine()).toMatch(/^Claude resets \S.*[^.]$/);
    expect(button()).not.toBeNull();
    // The reset time explains the switch, so it sits beside the button in
    // the trailing slot rather than stacking under the message.
    expect(
      element('chat-input-ai-credits-limit-resets')?.closest(
        '[data-notice-actions]',
      ),
    ).not.toBeNull();
    expect(
      element('chat-input-ai-credits-limit-resets')?.nextElementSibling,
    ).toBe(button());
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

describe('AiCreditsRoutingStatusBanner switch confirmation (CAN-4759)', () => {
  const NOW = new Date('2026-10-14T12:00:00').getTime();
  const RESET = NOW + 3_600_000;
  let container: HTMLDivElement;
  let root: Root;

  type Provider = 'claude' | 'codex';
  type Window = { usedPercent: number; resetsAt?: string | number };

  function usage(
    windows: Window[],
    provider: Provider = 'claude',
  ): AgentUsageOverview {
    return {
      updatedAt: new Date(NOW).toISOString(),
      providers: [
        {
          provider,
          authState: 'authenticated',
          hasRemainingLimits: windows.every((w) => w.usedPercent < 100),
          rateLimits: windows.map((primary) => ({ primary })),
        },
      ],
    };
  }

  const exhausted = (resetsAt: number): Window => ({
    usedPercent: 100,
    resetsAt: new Date(resetsAt).toISOString(),
  });

  function element(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }
  const switchButton = (): HTMLButtonElement | null =>
    container.querySelector(
      '[data-testid="chat-input-ai-credits-switch-to-subscription"]',
    );
  const confirmation = (): HTMLElement | null =>
    element('chat-input-ai-credits-switch-confirm');
  const acceptButton = (): HTMLButtonElement | null =>
    container.querySelector(
      '[data-testid="chat-input-ai-credits-switch-accept"]',
    );
  const cancelButton = (): HTMLButtonElement | null =>
    container.querySelector(
      '[data-testid="chat-input-ai-credits-switch-cancel"]',
    );

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  let onSwitchToSubscription: jest.Mock;

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
          onSwitchToSubscription={onSwitchToSubscription}
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
    onSwitchToSubscription = jest.fn();
    Object.assign(window, {
      api: {
        loadCanopyCloudAiCredits: jest.fn().mockResolvedValue(BALANCE_STATE),
      } as Partial<CanopyApi> as CanopyApi,
    });
    mockRefreshProviderUsageSnapshot
      .mockReset()
      .mockResolvedValue(usage([exhausted(RESET)]));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
  ] as const)(
    'asks before switching a limited %s subscription, then reports the shown reset once',
    async (provider, label) => {
      mockRefreshProviderUsageSnapshot.mockResolvedValue(
        usage([exhausted(RESET)], provider),
      );
      await render({ provider });
      expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledWith(provider);

      act(() => switchButton()?.click());
      expect(onSwitchToSubscription).not.toHaveBeenCalled();
      const resetLabel = formatUsageLimitTimeLabel(RESET);
      expect(confirmation()?.textContent).toContain(
        `${label} is limited until ${resetLabel}`,
      );
      expect(confirmation()?.textContent).toContain('Switch anyway?');
      expect(cancelButton()?.textContent).toBe('Keep using credits');
      expect(acceptButton()?.textContent).toBe('Switch anyway');
      // The balance chip and the normal card give way to the question.
      expect(element('chat-input-ai-credits-balance')).toBeNull();
      expect(element('chat-input-ai-credits-active')).toBeNull();
      // Focus moves to the recommended answer, inside a polite region.
      expect(document.activeElement).toBe(acceptButton());
      expect(confirmation()?.getAttribute('role')).toBe('status');

      act(() => acceptButton()?.click());
      act(() => acceptButton()?.click());
      expect(onSwitchToSubscription).toHaveBeenCalledTimes(1);
      expect(onSwitchToSubscription).toHaveBeenCalledWith({
        targetKey: 'project/worktree/chat',
        kind: 'limited',
        provider,
        resetAt: RESET,
      });
    },
  );

  it('confirms against the farthest exhausted window', async () => {
    const later = NOW + 5 * 3_600_000;
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage([exhausted(RESET), exhausted(later), { usedPercent: 20 }]),
    );
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()?.textContent).toContain(
      `limited until ${formatUsageLimitTimeLabel(later)}`,
    );
    act(() => acceptButton()?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'limited',
      provider: 'claude',
      resetAt: later,
    });
  });

  it('switches without a quota confirmation when only Extra usage is exhausted', async () => {
    const snapshot = usage([{ usedPercent: 0 }, { usedPercent: 0 }]);
    snapshot.providers[0].rateLimits?.push({
      limitId: 'extra_usage',
      primary: { usedPercent: 122 },
    });
    mockRefreshProviderUsageSnapshot.mockResolvedValue(snapshot);
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()).toBeNull();
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'available',
      provider: 'claude',
    });
  });

  it('does not warn a Sonnet chat about an Opus-only limit', async () => {
    const snapshot = usage([{ usedPercent: 0 }]);
    snapshot.providers[0].rateLimits?.push({
      limitId: 'seven_day_opus',
      scope: { model: { id: 'opus', displayName: 'Opus' } },
      primary: { usedPercent: 100, resetsAt: new Date(RESET).toISOString() },
    });
    mockRefreshProviderUsageSnapshot.mockResolvedValue(snapshot);
    await render({ model: 'sonnet' });
    act(() => switchButton()?.click());
    expect(confirmation()).toBeNull();
    expect(onSwitchToSubscription).toHaveBeenCalled();
  });

  it('switches immediately when the subscription is available', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage([{ usedPercent: 40, resetsAt: new Date(RESET).toISOString() }]),
    );
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()).toBeNull();
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'available',
      provider: 'claude',
    });
  });

  it.each([
    ['a missing reset', { usedPercent: 100 }],
    ['an invalid reset', { usedPercent: 100, resetsAt: 'not-a-date' }],
    ['an out-of-range numeric reset', { usedPercent: 100, resetsAt: 1e100 }],
  ])(
    'treats an exhausted window with %s as unconfirmed, never as limited-until',
    async (_label, window) => {
      mockRefreshProviderUsageSnapshot.mockResolvedValue(usage([window]));
      await render();
      expect(element('chat-input-ai-credits-limit-resets')).toBeNull();
      act(() => switchButton()?.click());
      expect(onSwitchToSubscription).not.toHaveBeenCalled();
      expect(confirmation()?.textContent).toContain(
        "Couldn't confirm your Claude limit",
      );
      expect(confirmation()?.textContent).not.toContain('limited until');
      act(() => acceptButton()?.click());
      expect(onSwitchToSubscription).toHaveBeenCalledWith({
        targetKey: 'project/worktree/chat',
        kind: 'unknown',
        provider: 'claude',
      });
    },
  );

  it('treats a past reset as available', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage([exhausted(NOW - 60_000)]),
    );
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()).toBeNull();
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'available',
      provider: 'claude',
    });
  });

  it('holds the switch while the first lookup is pending, then guards it', async () => {
    let resolveLookup: (value: AgentUsageOverview) => void = () => {};
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    await render();
    expect(switchButton()?.disabled).toBe(true);
    // The pending read shows in the button itself, not as a separate line
    // that shifts the banner when it settles.
    expect(switchButton()?.getAttribute('aria-busy')).toBe('true');
    expect(
      switchButton()?.querySelector(
        '[data-testid="chat-input-ai-credits-switch-checking"]',
      ),
    ).not.toBeNull();
    expect(switchButton()?.textContent).toBe('Switch to subscription');
    expect(element('chat-input-ai-credits-active')?.textContent).not.toContain(
      'Checking',
    );
    act(() => switchButton()?.click());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();

    resolveLookup(usage([exhausted(RESET)]));
    await flush();
    expect(switchButton()?.disabled).toBe(false);
    expect(switchButton()?.getAttribute('aria-busy')).toBe('false');
    expect(element('chat-input-ai-credits-switch-checking')).toBeNull();
    act(() => switchButton()?.click());
    expect(confirmation()).not.toBeNull();
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
  });

  it('gives up on a hung lookup and asks instead of implying availability', async () => {
    mockRefreshProviderUsageSnapshot.mockImplementation(
      () => new Promise<AgentUsageOverview>(() => {}),
    );
    await render();
    expect(switchButton()?.disabled).toBe(true);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(switchButton()?.disabled).toBe(false);
    act(() => switchButton()?.click());
    expect(confirmation()?.textContent).toContain(
      "Couldn't confirm your Claude limit",
    );
  });

  it('asks when the lookup fails', async () => {
    mockRefreshProviderUsageSnapshot.mockRejectedValue(new Error('offline'));
    await render();
    act(() => switchButton()?.click());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
    expect(confirmation()?.textContent).toContain('It may still be limited.');
  });

  it('keeps a known limit when a later refresh fails', async () => {
    await render();
    mockRefreshProviderUsageSnapshot.mockRejectedValue(new Error('offline'));
    await render({ active: false });
    await render({ active: true });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(2);
    act(() => switchButton()?.click());
    expect(confirmation()?.textContent).toContain('is limited until');
  });

  it('does not reuse an earlier available answer while a new lookup loads', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValueOnce(
      usage([{ usedPercent: 10 }]),
    );
    await render();
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () => new Promise<AgentUsageOverview>(() => {}),
    );
    await render({ active: false });
    await render({ active: true });
    expect(switchButton()?.disabled).toBe(true);
  });

  it.each([
    ['the cancel button', (): void => cancelButton()?.click()],
    [
      'Escape',
      (): void => {
        acceptButton()?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      },
    ],
  ])('cancels with %s and returns focus to the switch', async (_l, press) => {
    // A listener above React's root, like a dialog that closes on Escape.
    const parentKeyDown = jest.fn();
    document.body.addEventListener('keydown', parentKeyDown);
    await render();
    act(() => switchButton()?.click());
    act(() => press());
    expect(confirmation()).toBeNull();
    expect(element('chat-input-ai-credits-active')).not.toBeNull();
    expect(document.activeElement).toBe(switchButton());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
    // Escape stays with the prompt instead of dismissing a parent surface.
    expect(parentKeyDown).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', parentKeyDown);
  });

  it('ends the confirmation when the limit resets while it is open', async () => {
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(3_600_000);
    });
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(switchButton());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
  });

  it('reports the updated reset after a newer snapshot moves it', async () => {
    await render({ accountChangedAt: 1 });
    act(() => switchButton()?.click());
    const later = NOW + 2 * 3_600_000;
    mockRefreshProviderUsageSnapshot.mockResolvedValue(
      usage([exhausted(later)]),
    );
    // Same chat and provider, refreshed for a new account read: the prompt
    // closes, and the next one shows the newer reset.
    await render({ accountChangedAt: 2 });
    expect(confirmation()).toBeNull();
    act(() => switchButton()?.click());
    expect(confirmation()?.textContent).toContain(
      `limited until ${formatUsageLimitTimeLabel(later)}`,
    );
    act(() => acceptButton()?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'limited',
      provider: 'claude',
      resetAt: later,
    });
  });

  it.each([
    ['target', { target: { ...TARGET, chatId: 'other-chat' } }],
    ['provider', { provider: 'codex' as const }],
    ['visibility', { active: false }],
  ])('drops the confirmation when the %s changes', async (_label, change) => {
    await render();
    act(() => switchButton()?.click());
    expect(confirmation()).not.toBeNull();
    await render(change);
    expect(confirmation()).toBeNull();
    // Coming back does not reopen the stale prompt.
    await render();
    expect(confirmation()).toBeNull();
  });

  it('drops the confirmation when the switch action goes away', async () => {
    await render();
    act(() => switchButton()?.click());
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
    expect(confirmation()).toBeNull();
    expect(acceptButton()).toBeNull();
  });

  it('keeps a re-allocated but identical target confirming', async () => {
    await render();
    act(() => switchButton()?.click());
    await render({ target: { ...TARGET } });
    expect(confirmation()).not.toBeNull();
  });

  it('ignores a late lookup for the previous provider', async () => {
    let resolveClaude: (value: AgentUsageOverview) => void = () => {};
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClaude = resolve;
        }),
    );
    mockRefreshProviderUsageSnapshot.mockResolvedValueOnce(
      usage([{ usedPercent: 10 }], 'codex'),
    );
    await render();
    await render({ provider: 'codex' });
    resolveClaude(usage([exhausted(RESET)]));
    await flush();
    act(() => switchButton()?.click());
    expect(confirmation()).toBeNull();
    expect(onSwitchToSubscription).toHaveBeenCalledWith({
      targetKey: 'project/worktree/chat',
      kind: 'available',
      provider: 'codex',
    });
  });

  it('does not take focus on mount', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    await render();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('does not treat a fulfilled usage fetch error as availability', async () => {
    const snapshot = usage([{ usedPercent: 10 }]);
    snapshot.providers[0].error = 'Usage request failed';
    mockRefreshProviderUsageSnapshot.mockResolvedValue(snapshot);
    await render();
    act(() => switchButton()?.click());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
    expect(confirmation()?.textContent).toContain("Couldn't confirm");
  });

  it('does not treat missing usage windows as availability', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValue(usage([]));
    await render();
    act(() => switchButton()?.click());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
    expect(confirmation()?.textContent).toContain("Couldn't confirm");
  });

  it('checks a new target and ignores completion of the old target lookup', async () => {
    let finishOld: (snapshot: AgentUsageOverview) => void = () => {};
    let finishNew: (snapshot: AgentUsageOverview) => void = () => {};
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    mockRefreshProviderUsageSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
    await render();
    await render({ target: { ...TARGET, chatId: 'new-chat' } });
    expect(mockRefreshProviderUsageSnapshot).toHaveBeenCalledTimes(2);
    finishOld(usage([{ usedPercent: 10 }]));
    await flush();
    expect(switchButton()?.disabled).toBe(true);
    finishNew(usage([exhausted(RESET)]));
    await flush();
    act(() => switchButton()?.click());
    expect(confirmation()?.textContent).toContain('is limited until');
  });

  it('updates an open prompt from a newer snapshot and retains it through a fetch error', async () => {
    await render();
    act(() => switchButton()?.click());
    const later = RESET + 3_600_000;
    act(() =>
      mockUsageListeners.forEach((listener) =>
        listener({ usage: usage([exhausted(later)]) }),
      ),
    );
    expect(confirmation()?.textContent).toContain(
      formatUsageLimitTimeLabel(later),
    );
    const failed = usage([{ usedPercent: 10 }]);
    failed.providers[0].error = 'offline';
    act(() =>
      mockUsageListeners.forEach((listener) => listener({ usage: failed })),
    );
    expect(confirmation()?.textContent).toContain(
      formatUsageLimitTimeLabel(later),
    );
    act(() => acceptButton()?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKey: 'project/worktree/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: later,
      }),
    );
  });

  it('ends the open prompt when a newer snapshot reports availability', async () => {
    await render();
    act(() => switchButton()?.click());
    act(() =>
      mockUsageListeners.forEach((listener) =>
        listener({ usage: usage([{ usedPercent: 10 }]) }),
      ),
    );
    expect(confirmation()).toBeNull();
    expect(document.activeElement).toBe(switchButton());
    expect(onSwitchToSubscription).not.toHaveBeenCalled();
  });

  // Continue for an unanswered usage-limit interruption (CAN-4756).
  describe('continue the interrupted turn (CAN-4756)', () => {
    const continueButton = (): HTMLButtonElement | null =>
      container.querySelector('[data-testid="chat-input-ai-credits-continue"]');

    it('offers Continue beside the reset time instead of the switch, and sends on click', async () => {
      const onContinue = jest.fn();
      await render({
        continueInterruptedTurn: { onContinue, busy: false, error: null },
      });

      expect(continueButton()?.textContent).toBe('Continue');
      expect(continueButton()?.className).toMatch(/(^|\s)bg-accent(\s|$)/);
      expect(switchButton()).toBeNull();
      expect(element('chat-input-ai-credits-limit-resets')?.textContent).toBe(
        `Claude resets ${formatUsageLimitTimeLabel(RESET)}`,
      );
      expect(element('chat-input-ai-credits-continue-error')).toBeNull();

      act(() => continueButton()?.click());
      expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it('disables Continue while a send is in flight', async () => {
      await render({
        continueInterruptedTurn: {
          onContinue: jest.fn(),
          busy: true,
          error: null,
        },
      });
      expect(continueButton()?.disabled).toBe(true);
      expect(continueButton()?.getAttribute('aria-busy')).toBe('true');
    });

    it('shows a failed send under the message', async () => {
      await render({
        continueInterruptedTurn: {
          onContinue: jest.fn(),
          busy: false,
          error: 'Could not continue this chat. Try again.',
        },
      });
      expect(element('chat-input-ai-credits-continue-error')?.textContent).toBe(
        'Could not continue this chat. Try again.',
      );
      expect(continueButton()?.disabled).toBe(false);
    });

    it('brings the switch back once the interruption is answered', async () => {
      await render({
        continueInterruptedTurn: {
          onContinue: jest.fn(),
          busy: false,
          error: null,
        },
      });
      expect(switchButton()).toBeNull();

      await render();
      expect(continueButton()).toBeNull();
      expect(switchButton()).not.toBeNull();
    });

    it('never shows Continue in the switch confirmation', async () => {
      await render();
      act(() => switchButton()?.click());
      expect(confirmation()).not.toBeNull();

      await render({
        continueInterruptedTurn: {
          onContinue: jest.fn(),
          busy: false,
          error: null,
        },
      });
      expect(continueButton()).toBeNull();
    });
  });
});

describe('AiCreditsRoutingStatusBanner credits arrival (CAN-5159)', () => {
  const NOW = new Date('2026-10-14T12:00:00').getTime();
  const RESET = NOW + 3_600_000;
  const HANDOFF = 'handoff-1';
  let container: HTMLDivElement;
  let root: Root;
  let onSwitchToSubscription: jest.Mock;

  function element(testId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }
  const arrivalLine = (): HTMLElement | null =>
    element('chat-input-ai-credits-arrival');

  function seedArrival({
    routed = true,
    chatId = TARGET.chatId,
    origin = 'usage-limit',
  }: {
    routed?: boolean;
    chatId?: string;
    origin?: AiCreditsArrivalOrigin;
  } = {}): void {
    useAiCreditsArrivalStore.setState({
      accountReady: true,
      arrival: {
        handoffId: HANDOFF,
        accountId: 'account:acct_1',
        chatId,
        scope: {
          kind: 'work',
          projectId: TARGET.projectId,
          worktreeId: TARGET.worktreeId,
          chatId,
        },
        origin,
      },
      evidence: null,
      routed,
    });
  }
  function settleEvidence(): void {
    act(() =>
      useAiCreditsArrivalStore.setState({
        evidence: {
          handoffId: HANDOFF,
          final: true,
          addedCredits: 16,
          balanceCredits: 16,
        },
      }),
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
          onSwitchToSubscription={onSwitchToSubscription}
          {...props}
        />,
      ),
    );
    await flush();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    resetAiCreditsArrivalForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSwitchToSubscription = jest.fn();
    Object.assign(window, {
      api: {
        loadCanopyCloudAiCredits: jest.fn().mockResolvedValue(BALANCE_STATE),
      } as Partial<CanopyApi> as CanopyApi,
    });
    mockRefreshProviderUsageSnapshot.mockReset().mockResolvedValue({
      updatedAt: new Date(NOW).toISOString(),
      providers: [
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: false,
          rateLimits: [
            {
              primary: {
                usedPercent: 100,
                resetsAt: new Date(RESET).toISOString(),
              },
            },
          ],
        },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetAiCreditsArrivalForTests();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('leads with the routed credits on one line, generic until the balance settles', async () => {
    seedArrival();
    await render();
    expect(arrivalLine()?.textContent).toBe(
      'AI Credits are available for this chat.',
    );
    settleEvidence();
    expect(arrivalLine()?.textContent).toBe('16 AI Credits added.');
    const card = element('chat-input-ai-credits-active');
    // The arrival is the card's state, with a success glyph, and replaces the
    // generic title rather than stacking a detail line under it.
    expect(card?.getAttribute('data-notice-intent')).toBe('positive');
    expect(card?.textContent).not.toContain('Using AI Credits');
    expect(card?.textContent).toContain(
      '16 AI Credits added. Ready to use in this chat.',
    );
    // The arrival names the amount, so the balance would repeat it.
    expect(element('chat-input-ai-credits-balance')).toBeNull();
    // A limited subscription is still the user's to go back to.
    expect(
      element('chat-input-ai-credits-switch-to-subscription'),
    ).not.toBeNull();
    expect(
      element('chat-input-ai-credits-limit-resets')?.closest(
        '[data-notice-actions]',
      ),
    ).not.toBeNull();
  });

  it('confirms No billing source credits without offering a subscription the user lacks', async () => {
    seedArrival({ origin: 'no-billing-source' });
    await render();
    settleEvidence();
    const card = element('chat-input-ai-credits-active');
    expect(card?.getAttribute('data-notice-intent')).toBe('positive');
    expect(card?.textContent).toContain(
      '16 AI Credits added. Ready to use in this chat.',
    );
    // The user bought credits because nothing else could pay, so switching
    // back would return them to that dead end.
    expect(element('chat-input-ai-credits-switch-to-subscription')).toBeNull();
    expect(element('chat-input-ai-credits-limit-resets')).toBeNull();
    expect(card?.querySelector('[data-notice-actions]')).toBeNull();
  });

  it('offers the switch again once the No billing source confirmation clears', async () => {
    seedArrival({ origin: 'no-billing-source' });
    await render();
    settleEvidence();
    await render({ turnActive: true });
    expect(
      element('chat-input-ai-credits-switch-to-subscription'),
    ).not.toBeNull();
  });

  it('returns to the balance once the arrival clears', async () => {
    seedArrival();
    await render();
    settleEvidence();
    await render({ turnActive: true });
    const card = element('chat-input-ai-credits-active');
    expect(card?.getAttribute('data-notice-intent')).toBe('neutral');
    expect(card?.textContent).toContain('Using AI Credits.');
    expect(element('chat-input-ai-credits-balance')).not.toBeNull();
  });

  it('shows nothing for an unrouted record or another chat', async () => {
    seedArrival({ routed: false });
    await render();
    expect(arrivalLine()).toBeNull();

    seedArrival({ chatId: 'other-chat' });
    await render();
    expect(arrivalLine()).toBeNull();
  });

  it('keeps the record while the card is hidden', async () => {
    seedArrival();
    await render();
    await render({ active: false });
    expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
    await render();
    expect(arrivalLine()).not.toBeNull();
  });

  it('clears when the first credits turn starts, not on a mount mid-turn', async () => {
    seedArrival();
    await render({ turnActive: true });
    expect(arrivalLine()).not.toBeNull();
    await render({ turnActive: false });
    expect(arrivalLine()).not.toBeNull();
    await render({ turnActive: true });
    expect(arrivalLine()).toBeNull();
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });

  it('clears when a turn starts while the card is hidden', async () => {
    seedArrival();
    await render({ active: false });
    await render({ active: false, turnActive: true });
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    await render();
    expect(arrivalLine()).toBeNull();
  });

  it('clears when switching back to an available subscription', async () => {
    mockRefreshProviderUsageSnapshot.mockResolvedValue({
      updatedAt: new Date(NOW).toISOString(),
      providers: [
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          rateLimits: [{ primary: { usedPercent: 40 } }],
        },
      ],
    });
    seedArrival();
    await render();
    act(() => element('chat-input-ai-credits-switch-to-subscription')?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledTimes(1);
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });

  it('clears only once a limited switch is accepted', async () => {
    seedArrival();
    await render();
    act(() => element('chat-input-ai-credits-switch-to-subscription')?.click());
    act(() => element('chat-input-ai-credits-switch-cancel')?.click());
    expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();

    act(() => element('chat-input-ai-credits-switch-to-subscription')?.click());
    act(() => element('chat-input-ai-credits-switch-accept')?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'limited' }),
    );
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });

  it('clears when an unconfirmed switch is accepted', async () => {
    mockRefreshProviderUsageSnapshot.mockRejectedValue(new Error('offline'));
    seedArrival();
    await render();
    act(() => element('chat-input-ai-credits-switch-to-subscription')?.click());
    act(() => element('chat-input-ai-credits-switch-accept')?.click());
    expect(onSwitchToSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unknown' }),
    );
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });
});
