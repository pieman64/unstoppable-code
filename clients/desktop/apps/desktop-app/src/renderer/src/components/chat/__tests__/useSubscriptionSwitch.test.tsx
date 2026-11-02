/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  NativeAccountProvider,
  NativeAiCreditsAvailability,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { AiCreditsUsageLimitBanner } from '../AiCreditsUsageLimitBanner';
import {
  SubscriptionAvailabilityNotice,
  type SubscriptionSwitchOutcome,
} from '../AiCreditsRoutingStatusBanner';
import { useSubscriptionSwitch } from '../useSubscriptionSwitch';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';

const TARGET: ChatBannerTarget = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};
const OTHER: ChatBannerTarget = { ...TARGET, chatId: 'other' };
const RESET = Date.now() + 3_600_000;

type Framework = 'subscription' | 'ai-credits';

interface HarnessApi {
  switchToSubscription: (outcome: SubscriptionSwitchOutcome) => void;
  setTarget: (target: ChatBannerTarget | null) => void;
  setFramework: (framework: Framework) => void;
  setTurnActive: (active: boolean) => void;
}

let api: HarnessApi;
let applySwitch = true;
const selectSubscription = jest.fn<void, [ChatBannerTarget]>();
const focusComposer = jest.fn();

/**
 * Mirrors ChatInput: the billing transition flips the effective framework, and
 * the usage-limit banner follows that framework rather than the live bit.
 */
function Harness({
  provider = 'claude',
}: {
  provider?: NativeAccountProvider;
}): JSX.Element {
  const [target, setTarget] = useState<ChatBannerTarget | null>(TARGET);
  const [framework, setFramework] = useState<Framework>('ai-credits');
  const [turnActive, setTurnActive] = useState(false);
  const result = useSubscriptionSwitch({
    target,
    provider,
    framework,
    turnActive,
    selectSubscription: (next): void => {
      selectSubscription(next);
      if (applySwitch) setFramework('subscription');
    },
    focusComposer,
  });
  api = {
    switchToSubscription: result.switchToSubscription,
    setTarget,
    setFramework,
    setTurnActive,
  };
  return (
    <>
      <AiCreditsUsageLimitBanner
        target={target}
        modelRoutability="routable"
        billsToAiCredits={framework === 'ai-credits'}
      />
      {result.availabilityNoticeProvider ? (
        <SubscriptionAvailabilityNotice
          provider={result.availabilityNoticeProvider}
          onDismiss={result.dismissAvailabilityNotice}
        />
      ) : null}
    </>
  );
}

describe('useSubscriptionSwitch (CAN-4759)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  const usageBanner = (): HTMLElement | null =>
    container.querySelector('[data-testid="chat-input-usage-limit-banner"]');
  const availabilityNotice = (): HTMLElement | null =>
    container.querySelector(
      '[data-testid="chat-input-subscription-availability-notice"]',
    );

  function runFrames(): void {
    const pending = frames;
    frames = [];
    act(() => pending.forEach((frame) => frame(0)));
  }

  async function mount(element: JSX.Element = <Harness />): Promise<void> {
    await act(async () => {
      root.render(element);
      await Promise.resolve();
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    applySwitch = true;
    frames = [];
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames[id - 1] = (): void => {};
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability: jest
          .fn<Promise<NativeAiCreditsAvailability>, []>()
          .mockResolvedValue({
            personalEligible: true,
            inOrg: false,
            orgCreditPoolCovered: false,
            orgSpendable: false,
            pricingUrl: 'https://cloud.example.com/pricing',
          }),
        loadPreferences: jest
          .fn<Promise<PreferencesData>, []>()
          .mockResolvedValue({
            aiCreditsRoutingMode: 'off',
          } as PreferencesData),
      },
    });
    const store = useAiCreditsBannerStore.getState();
    store.clearForChat(TARGET);
    store.clearForChat(OTHER);
    // A finished credits turn: the limit was dismissed by choosing credits and
    // the live routing bit is still true.
    store.setUsageLimit(TARGET, { provider: 'claude', resetsAt: RESET });
    store.dismissUsageLimit(TARGET, `claude:${RESET}`);
    store.setRoutingActive(TARGET, true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
    useAiCreditsBannerStore.getState().clearForChat(OTHER);
    jest.restoreAllMocks();
    selectSubscription.mockReset();
    focusComposer.mockReset();
  });

  it('restores the confirmed limit despite a stale live routing bit, then focuses the composer', async () => {
    await mount();
    expect(usageBanner()).toBeNull();

    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();

    expect(selectSubscription).toHaveBeenCalledWith(TARGET);
    expect(usageBanner()?.textContent).toContain('Claude usage limit reached');
    expect(
      useAiCreditsBannerStore.getState().routingActiveByChat['proj/wt/chat']
        ?.active,
    ).toBe(true);
    expect(focusComposer).not.toHaveBeenCalled();
    runFrames();
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing recovery actions and dismissal on the restored banner', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-always-on-quota"]',
      ),
    ).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-dismiss"]',
        )
        ?.click(),
    );
    expect(usageBanner()).toBeNull();
  });

  it('restores nothing for an available subscription', async () => {
    useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'available',
        provider: 'claude',
      }),
    );
    await settle();
    expect(selectSubscription).toHaveBeenCalledTimes(1);
    expect(usageBanner()).toBeNull();
    expect(availabilityNotice()).toBeNull();
    runFrames();
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('shows the availability notice for an unconfirmed limit until a turn starts', async () => {
    useAiCreditsBannerStore.getState().clearUsageLimitForChat(TARGET);
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'codex',
      }),
    );
    await settle();
    // The Harness bills Claude, so a Codex outcome is stale and ignored.
    expect(selectSubscription).not.toHaveBeenCalled();

    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'claude',
      }),
    );
    await settle();
    expect(usageBanner()).toBeNull();
    expect(availabilityNotice()?.textContent).toContain(
      "Couldn't confirm your Claude limit",
    );
    act(() => api.setTurnActive(true));
    expect(availabilityNotice()).toBeNull();
  });

  it('lets the availability notice be dismissed', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'claude',
      }),
    );
    await settle();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-subscription-availability-dismiss"]',
        )
        ?.click(),
    );
    expect(availabilityNotice()).toBeNull();
  });

  it('ignores a second acceptance in the same event', async () => {
    await mount();
    act(() => {
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      });
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      });
    });
    await settle();
    expect(selectSubscription).toHaveBeenCalledTimes(1);
  });

  it('restores nothing and keeps credits when the switch does not take effect', async () => {
    applySwitch = false;
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();
    runFrames();
    expect(usageBanner()).toBeNull();
    expect(focusComposer).not.toHaveBeenCalled();

    // A later, unrelated switch must not replay the stale outcome.
    act(() => api.setFramework('subscription'));
    await settle();
    expect(usageBanner()).toBeNull();
  });

  it('hides the restored banner again if billing rolls back to credits', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();
    expect(usageBanner()).not.toBeNull();
    act(() => api.setFramework('ai-credits'));
    expect(usageBanner()).toBeNull();
    runFrames();
    expect(focusComposer).not.toHaveBeenCalled();
  });

  it('ignores invalid or expired confirmed resets at the parent boundary', async () => {
    await mount();
    for (const resetAt of [Number.NaN, Infinity, 1e100, Date.now() - 1]) {
      act(() =>
        api.switchToSubscription({
          targetKey: 'proj/wt/chat',
          kind: 'limited',
          provider: 'claude',
          resetAt,
        }),
      );
    }
    expect(selectSubscription).not.toHaveBeenCalled();
    expect(usageBanner()).toBeNull();
  });

  it('leaves a rejected action retryable without restoring or focusing', async () => {
    selectSubscription.mockImplementationOnce(() => {
      throw new Error('rejected');
    });
    await mount();
    expect(() =>
      act(() =>
        api.switchToSubscription({
          targetKey: 'proj/wt/chat',
          kind: 'unknown',
          provider: 'claude',
        }),
      ),
    ).not.toThrow();
    await settle();
    runFrames();
    expect(availabilityNotice()).toBeNull();
    expect(focusComposer).not.toHaveBeenCalled();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'claude',
      }),
    );
    await settle();
    expect(selectSubscription).toHaveBeenCalledTimes(2);
    expect(availabilityNotice()).not.toBeNull();
  });

  it('does not focus a composer that moved to another chat before the frame', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();
    act(() => api.setTarget(OTHER));
    runFrames();
    expect(focusComposer).not.toHaveBeenCalled();
  });

  it('rejects an outcome captured from another target', async () => {
    await mount();
    const staleSwitch = api.switchToSubscription;
    act(() => api.setTarget(OTHER));
    act(() =>
      staleSwitch({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'claude',
      }),
    );
    expect(selectSubscription).not.toHaveBeenCalled();
  });

  it('does not focus or retain a notice after the provider changes', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'unknown',
        provider: 'claude',
      }),
    );
    await settle();
    await mount(<Harness provider="codex" />);
    runFrames();
    expect(focusComposer).not.toHaveBeenCalled();
    expect(availabilityNotice()).toBeNull();
  });

  it('cancels the scheduled focus on unmount', async () => {
    await mount();
    act(() =>
      api.switchToSubscription({
        targetKey: 'proj/wt/chat',
        kind: 'limited',
        provider: 'claude',
        resetAt: RESET,
      }),
    );
    await settle();
    act(() => root.unmount());
    runFrames();
    expect(focusComposer).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
