/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, useState, type JSX } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
  NativeAiCreditsAvailability,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  beginAiCreditsArrivalHandoff,
  reconcileAiCreditsArrivalAccount,
  resetAiCreditsArrivalForTests,
  selectAiCreditsArrivalForChat,
  selectRoutedAiCreditsArrivalForChat,
  suspendAiCreditsArrivalAccount,
  useAiCreditsArrivalStore,
} from '@/lib/aiCreditsArrivalConfirmation';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { AiCreditsUsageLimitBanner } from '../AiCreditsUsageLimitBanner';
import type { CreditsModelRoutability } from '@/lib/chatBillingFramework';
import type { CreditsModelSwitchResult } from '@/lib/creditsModelSwitch';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';
import type { SettingsRoute } from '@canopy/protocol/settings';
import { useNavigationStore } from '@/stores/navigationStore';

const mockHostedSettingsOpenable = jest.fn<boolean, []>();
jest.mock('@/components/settings/hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
    '@/components/settings/hosted/hosted-settings-availability',
  ),
  hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsOpenable(),
}));

const realOpenAccountOrganizationSettings =
  useNavigationStore.getState().openAccountOrganizationSettings;
const openAccountOrganizationSettings = jest.fn<
  void,
  [SettingsRoute, unknown?]
>();

const TARGET: ChatBannerTarget = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};

const PRICING_URL = 'https://cloud.example.com/pricing';
// Get AI Credits always opens the signed-in web top-up (CAN-5159).
const BANNER_TOP_UP_PATH =
  '/account/billing?topUp=1&reason=credits&source=banner';

function native(
  overrides: Partial<NativeAiCreditsAvailability>,
): NativeAiCreditsAvailability {
  return {
    personalEligible: false,
    inOrg: false,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl: PRICING_URL,
    ...overrides,
  };
}

function Harness(): JSX.Element {
  return (
    <AiCreditsUsageLimitBanner
      modelRoutability="routable"
      target={TARGET}
      onUseJustThisTime={() => {}}
    />
  );
}

function HarnessWithSchedule({
  disabled = false,
  scheduledForLabel = null,
}: {
  disabled?: boolean;
  scheduledForLabel?: string | null;
}): JSX.Element {
  return (
    <AiCreditsUsageLimitBanner
      target={TARGET}
      modelRoutability="routable"
      onUseJustThisTime={() => {}}
      scheduleResume={{
        onSchedule: () => {},
        inFlight: false,
        disabled,
        error: null,
        scheduledForLabel,
      }}
    />
  );
}

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('AiCreditsUsageLimitBanner (native coverage branches)', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadNativeAiCreditsAvailability = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    []
  >();
  const loadPreferences = jest.fn<Promise<PreferencesData>, []>();
  const openExternal = jest.fn<Promise<void>, [{ url: string }]>();
  const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();
  const savePreferences = jest.fn<Promise<void>, [Partial<PreferencesData>]>();
  const loadCanopyCloudAccount = jest.fn<
    Promise<CanopyCloudAccountPublicState | null>,
    []
  >();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The shared availability read retains its settled answer for the current
    // episode, so it must be reset between tests: this file mounts
    // `GetAiCreditsCta`, whose mount effect seeds one, and a retained answer
    // would otherwise satisfy the next test's assertions for the wrong reason.
    invalidateSharedAiCreditsRead();
    loadNativeAiCreditsAvailability.mockReset();
    loadPreferences.mockReset();
    openExternal.mockReset();
    openAuthenticatedPortalPage.mockReset();
    savePreferences.mockReset();
    loadCanopyCloudAccount.mockReset();
    mockHostedSettingsOpenable.mockReset().mockReturnValue(false);
    openAccountOrganizationSettings.mockReset();
    useNavigationStore.setState({ openAccountOrganizationSettings });

    openExternal.mockResolvedValue(undefined);
    openAuthenticatedPortalPage.mockResolvedValue(true);
    savePreferences.mockResolvedValue(undefined);
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: [],
      storageAvailable: true,
      account: {
        id: 'acct_1',
        name: 'Test User',
        email: 'test@example.com',
        role: 'DEVELOPER',
      },
    });
    loadPreferences.mockResolvedValue({
      aiCreditsRoutingMode: 'off',
    } as PreferencesData);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        loadPreferences,
        loadCanopyCloudAccount,
        savePreferences,
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });

    // Seed a reached usage limit for the target chat.
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
    useAiCreditsBannerStore
      .getState()
      .setUsageLimit(TARGET, { provider: 'claude' });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useAiCreditsBannerStore.getState().clearForChat(TARGET);
    useNavigationStore.setState({
      openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
    });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function renderBanner(
    element: JSX.Element = <Harness />,
  ): Promise<void> {
    await act(async () => {
      root.render(element);
      await flushAsyncEffects();
    });
  }

  it('shows switch-and-resume affordance when personally eligible', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ personalEligible: true }),
    );
    await renderBanner();

    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-always-on-quota"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans"]',
      ),
    ).toBeNull();
    // Dismiss is always present.
    expect(
      container.querySelector('[data-testid="chat-input-usage-limit-dismiss"]'),
    ).not.toBeNull();
  });

  // CAN-4759: the live routing bit can stay true after a finished credits
  // turn, so the effective framework from the billing resolver decides.
  describe('effective billing (CAN-4759)', () => {
    const banner = (): Element | null =>
      container.querySelector('[data-testid="chat-input-usage-limit-banner"]');
    const offer = (): Element | null =>
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
      );

    // Without the credits card, a chat that bills to credits before any turn
    // routed keeps the notice (CAN-4757) but withholds the credits offer.
    it.each([
      { billsToAiCredits: false, live: true, visible: true, offered: true },
      { billsToAiCredits: false, live: false, visible: true, offered: true },
      { billsToAiCredits: true, live: true, visible: false, offered: false },
      { billsToAiCredits: true, live: false, visible: true, offered: false },
      {
        billsToAiCredits: undefined,
        live: true,
        visible: false,
        offered: false,
      },
      {
        billsToAiCredits: undefined,
        live: false,
        visible: true,
        offered: true,
      },
    ])(
      'billsToAiCredits=$billsToAiCredits with live routing=$live shows: $visible, offers: $offered',
      async ({ billsToAiCredits, live, visible, offered }) => {
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ personalEligible: true }),
        );
        useAiCreditsBannerStore.getState().setRoutingActive(TARGET, live);
        await renderBanner(
          <AiCreditsUsageLimitBanner
            target={TARGET}
            modelRoutability="routable"
            onUseJustThisTime={() => {}}
            {...(billsToAiCredits !== undefined ? { billsToAiCredits } : {})}
          />,
        );
        expect(banner() !== null).toBe(visible);
        // The credits offer follows the effective billing answer.
        expect(offer() !== null).toBe(offered);
      },
    );

    it('keeps the coverage gate on the credits offer', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={() => {}}
          billsToAiCredits={false}
        />,
      );
      expect(banner()).not.toBeNull();
      expect(offer()).toBeNull();
    });
  });

  it('asks whether to use credits and answers with the accent action last on its own row', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ personalEligible: true }),
    );
    await renderBanner(<HarnessWithSchedule />);

    const actionRow = container.querySelector(
      '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
    );
    const buttons = Array.from(
      actionRow?.querySelectorAll<HTMLButtonElement>('button') ?? [],
    );
    // The message asks the question the buttons answer (CAN-5159).
    expect(container.textContent).toContain(
      'Do you want to use AI Credits until your quota resets?',
    );
    // Alternatives first, the single accent action last (far right).
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'No, resume at reset',
      'Always',
      'Just this chat',
    ]);
    // The per-chat action is the only accent; the global opt-in never is
    // (CAN-5159).
    expect(
      buttons
        .filter((button) => /(^|\s)bg-accent(\s|$)/.test(button.className))
        .map((button) => button.textContent?.trim()),
    ).toEqual(['Just this chat']);
    // Text-only labels: the words name the resource and timing, so no
    // glyphs compete with them (design owner, 2026-09-17).
    expect(
      buttons.every((button) => button.querySelector('svg') === null),
    ).toBe(true);
    // The answers sit on their own row, aligned with the message.
    expect(
      container.querySelector('[data-notice-actions="below"]'),
    ).not.toBeNull();
  });

  it('says what happens next once a resume is scheduled', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ personalEligible: true }),
    );
    await renderBanner(
      <HarnessWithSchedule disabled scheduledForLabel="Tue 9:00 AM" />,
    );

    // The sentence now states the outcome instead of re-asking the question,
    // and the schedule button (already used) is gone; only the actions that
    // would change the outcome remain, with the accent action still last.
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-schedule-resume"]',
      ),
    ).toBeNull();
    expect(container.textContent).toContain('Claude usage limit reached');
    expect(container.textContent).toContain(
      'This chat resumes automatically at Tue 9:00 AM. Do you want to use AI Credits to keep going now?',
    );
    expect(container.textContent).not.toContain('Resume scheduled for');
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"] button',
      ),
    );
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Always',
      'Just this chat',
    ]);
    // The answers keep their own row under the question.
    expect(
      container.querySelector('[data-notice-actions="below"]'),
    ).not.toBeNull();
  });

  it('closes the scheduled sentence when no credit action applies', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: true, orgSpendable: false }),
    );
    await renderBanner(
      <HarnessWithSchedule disabled scheduledForLabel="6:00 PM" />,
    );
    expect(container.textContent).toContain(
      'This chat resumes automatically at 6:00 PM.',
    );
    expect(container.querySelector('button:not([aria-label])')).toBeNull();
  });

  it.each([
    [
      'coverage could not be read',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ inconclusive: true }),
        );
      },
    ],
    [
      'routing is already set to something other than off',
      (): void => {
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ personalEligible: true }),
        );
        loadPreferences.mockResolvedValue({
          aiCreditsRoutingMode: 'on-quota',
        } as PreferencesData);
      },
    ],
  ])(
    'answers the credits question with a primary Use AI Credits action when %s',
    async (_case, arrange) => {
      arrange();
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={onUseJustThisTime}
        />,
      );

      expect(container.textContent).toContain(
        'Do you want to use AI Credits until your quota resets?',
      );
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          'button:not([aria-label])',
        ),
      );
      const useCredits = buttons.at(-1);
      expect(useCredits?.textContent?.trim()).toBe('Use AI Credits');
      expect(useCredits?.getAttribute('data-testid')).toBe(
        'chat-input-usage-limit-use-ai-credits',
      );
      expect(useCredits?.className).toContain('bg-accent');

      await act(async () => {
        useCredits?.click();
        await flushAsyncEffects();
      });
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
    },
  );

  it('withholds the Use AI Credits action until the coverage read settles', async () => {
    const pendingReads: Array<(value: NativeAiCreditsAvailability) => void> =
      [];
    loadNativeAiCreditsAvailability.mockImplementation(
      () =>
        new Promise<NativeAiCreditsAvailability>((resolve) => {
          pendingReads.push(resolve);
        }),
    );
    await renderBanner(
      <AiCreditsUsageLimitBanner
        target={TARGET}
        modelRoutability="routable"
        onUseJustThisTime={() => {}}
      />,
    );
    // The row must not draw the fallback and then swap it for the offer.
    expect(container.textContent).toContain(
      'AI Credits or wait for your quota',
    );
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-use-ai-credits"]',
      ),
    ).toBeNull();

    await act(async () => {
      for (const resolve of pendingReads)
        resolve(native({ inconclusive: true }));
      await flushAsyncEffects();
    });
    expect(
      container
        .querySelector('[data-testid="chat-input-usage-limit-use-ai-credits"]')
        ?.textContent?.trim(),
    ).toBe('Use AI Credits');
  });

  it('shows switch-and-resume affordance when org has spendable headroom', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: true, orgSpendable: true }),
    );
    await renderBanner();

    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-contact-admin"]',
      ),
    ).toBeNull();
  });

  it('shows contact-admin copy for a covered org with no headroom', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: true, orgSpendable: false }),
    );
    await renderBanner();

    const contactAdmin = container.querySelector(
      '[data-testid="chat-input-usage-limit-contact-admin"]',
    );
    expect(contactAdmin).not.toBeNull();
    expect(contactAdmin?.textContent).toContain('org admin');
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
      ),
    ).toBeNull();
  });

  it('opens the browser top-up, not Settings, even when hosted settings are openable (CAN-5159)', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-view-plans"]',
        )
        ?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    // The chat keeps waiting for the purchase instead of forgetting it.
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans-check-again"]',
      ),
    ).not.toBeNull();
  });

  describe('offer scope (CAN-5159)', () => {
    const USE_NOW_SCOPE =
      "Spends AI Credits in this chat only. Other chats aren't affected.";
    const ALWAYS_SCOPE =
      'Spends AI Credits automatically in every chat whenever a usage limit is hit.';

    function button(testId: string): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
    }
    function describedBy(element: HTMLElement | null): string | null {
      const id = element?.getAttribute('aria-describedby');
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    }

    it('describes each action with its scope for assistive technology only', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner();

      const useNow = button('chat-input-usage-limit-ai-credits-once');
      const always = button(
        'chat-input-usage-limit-ai-credits-always-on-quota',
      );
      expect(describedBy(useNow)).toBe(USE_NOW_SCOPE);
      expect(describedBy(always)).toBe(ALWAYS_SCOPE);
      // No tooltip repeats the scope on screen.
      expect(useNow?.hasAttribute('title')).toBe(false);
      expect(always?.hasAttribute('title')).toBe(false);
      // The scope never joins the accessible name.
      expect(useNow?.textContent).toBe('Just this chat');
      expect(always?.textContent).toBe('Always');
    });

    it('renders the per-chat billing choice as the primary without session routing', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      const onUseCreditsForThisChat = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseCreditsForThisChat={onUseCreditsForThisChat}
        />,
      );

      const useNow = button('chat-input-usage-limit-ai-credits-once');
      expect(useNow?.className).toMatch(/(^|\s)bg-accent(\s|$)/);
      await act(async () => {
        useNow?.click();
        await flushAsyncEffects();
      });
      expect(onUseCreditsForThisChat).toHaveBeenCalledTimes(1);
      expect(savePreferences).not.toHaveBeenCalled();
    });

    it('only the secondary global action turns on automatic credits', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={onUseJustThisTime}
        />,
      );

      await act(async () => {
        button('chat-input-usage-limit-ai-credits-once')?.click();
        await flushAsyncEffects();
      });
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      expect(savePreferences).not.toHaveBeenCalled();

      const always = button(
        'chat-input-usage-limit-ai-credits-always-on-quota',
      );
      expect(always?.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
      await act(async () => {
        always?.click();
        await flushAsyncEffects();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        aiCreditsRoutingMode: 'on-quota',
      });
    });
  });

  // Saying yes to credits continues the interrupted turn, after routing.
  describe('continues the interrupted turn (CAN-4756)', () => {
    function button(testId: string): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
    }
    async function click(testId: string): Promise<void> {
      await act(async () => {
        button(testId)?.click();
        await flushAsyncEffects();
      });
    }

    it.each([
      ['session routing', 'onUseJustThisTime'],
      ['the per-chat billing choice', 'onUseCreditsForThisChat'],
    ] as const)(
      'Just this chat routes through %s, then continues',
      async (_label, routingProp) => {
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ personalEligible: true }),
        );
        const route = jest.fn();
        const onContinue = jest.fn();
        await renderBanner(
          <AiCreditsUsageLimitBanner
            modelRoutability="routable"
            target={TARGET}
            {...{ [routingProp]: route }}
            onContinueAfterUsingCredits={onContinue}
          />,
        );

        await click('chat-input-usage-limit-ai-credits-once');
        expect(route).toHaveBeenCalledTimes(1);
        expect(onContinue).toHaveBeenCalledTimes(1);
        expect(route.mock.invocationCallOrder[0]).toBeLessThan(
          onContinue.mock.invocationCallOrder[0],
        );
      },
    );

    it('Use AI Credits routes, then continues', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ inconclusive: true }),
      );
      const route = jest.fn();
      const onContinue = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          onUseJustThisTime={route}
          onContinueAfterUsingCredits={onContinue}
        />,
      );

      await click('chat-input-usage-limit-use-ai-credits');
      expect(route).toHaveBeenCalledTimes(1);
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(route.mock.invocationCallOrder[0]).toBeLessThan(
        onContinue.mock.invocationCallOrder[0],
      );
    });

    it('Always routes this chat and continues only after its preference saves', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      let resolveSave: () => void = () => {};
      savePreferences.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );
      const route = jest.fn();
      const onContinue = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          onUseJustThisTime={route}
          onContinueAfterUsingCredits={onContinue}
        />,
      );

      await click('chat-input-usage-limit-ai-credits-always-on-quota');
      expect(route).not.toHaveBeenCalled();
      expect(onContinue).not.toHaveBeenCalled();
      expect(
        button('chat-input-usage-limit-ai-credits-always-on-quota')?.disabled,
      ).toBe(true);

      await act(async () => {
        resolveSave();
        await flushAsyncEffects();
      });
      // Main routes on-quota only after it saw the limit live, so the
      // resend routes this chat itself.
      expect(route).toHaveBeenCalledTimes(1);
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(route.mock.invocationCallOrder[0]).toBeLessThan(
        onContinue.mock.invocationCallOrder[0],
      );
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-banner"]',
        ),
      ).toBeNull();
    });

    it('Always routes the chat it was clicked in when the banner re-renders during the save', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      let resolveSave: () => void = () => {};
      savePreferences.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );
      const clickedRoute = jest.fn();
      const laterRoute = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          onUseJustThisTime={clickedRoute}
          onContinueAfterUsingCredits={() => {}}
        />,
      );

      await click('chat-input-usage-limit-ai-credits-always-on-quota');
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          onUseJustThisTime={laterRoute}
          onContinueAfterUsingCredits={() => {}}
        />,
      );
      await act(async () => {
        resolveSave();
        await flushAsyncEffects();
      });

      expect(clickedRoute).toHaveBeenCalledTimes(1);
      expect(laterRoute).not.toHaveBeenCalled();
    });

    it('Always does not continue when its preference save fails', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      savePreferences.mockRejectedValue(new Error('save failed'));
      const route = jest.fn();
      const onContinue = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          onUseJustThisTime={route}
          onContinueAfterUsingCredits={onContinue}
        />,
      );

      await click('chat-input-usage-limit-ai-credits-always-on-quota');
      expect(route).not.toHaveBeenCalled();
      expect(onContinue).not.toHaveBeenCalled();
      // Dismissed either way, as before.
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-banner"]',
        ),
      ).toBeNull();
    });
  });

  it('shows the pricing CTA and opens the authenticated billing page when uncovered', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    const viewPlans = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-usage-limit-view-plans"]',
    );
    expect(viewPlans).not.toBeNull();

    await act(async () => {
      viewPlans?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('offers AI Credits in the purchase state, never a plan upgrade (CAN-5160)', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    expect(container.textContent).toContain(
      'Get AI Credits to keep going now, or wait for your quota to reset',
    );
    expect(container.textContent).not.toContain('Upgrade');
    expect(container.textContent).not.toContain('plan');
    expect(
      container
        .querySelector('[data-testid="chat-input-usage-limit-view-plans"]')
        ?.textContent?.trim(),
    ).toBe('Get AI Credits');
  });

  it('offers AI Credits in the scheduled sentence', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner(
      <HarnessWithSchedule disabled scheduledForLabel="6:00 PM" />,
    );

    expect(container.textContent).toContain(
      'This chat resumes automatically at 6:00 PM, or get AI Credits to keep going now.',
    );
    expect(container.textContent).not.toContain('plan');
  });

  it('uses the shared credits CTA busy state while deciding the cloud handoff', async () => {
    let resolveAccount:
      | ((account: CanopyCloudAccountPublicState | null) => void)
      | undefined;
    loadCanopyCloudAccount.mockImplementation(
      () =>
        new Promise<CanopyCloudAccountPublicState | null>((resolve) => {
          resolveAccount = resolve;
        }),
    );
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-view-plans"]',
        )
        ?.click();
      await flushAsyncEffects();
    });

    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans-spinner"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      resolveAccount?.({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: [],
        storageAvailable: true,
        account: {
          id: 'acct_1',
          name: 'Test User',
          email: 'test@example.com',
          role: 'DEVELOPER',
        },
      });
      await flushAsyncEffects();
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
  });

  it('falls back to the unauthenticated pricing URL when the handoff fails', async () => {
    openAuthenticatedPortalPage.mockRejectedValue(new Error('unavailable'));
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    const viewPlans = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-usage-limit-view-plans"]',
    );
    expect(viewPlans).not.toBeNull();

    await act(async () => {
      viewPlans?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
    expect(openExternal).toHaveBeenCalledWith({ url: PRICING_URL });
  });

  describe('Codex usage limit (CAN-4564)', () => {
    function seedCodexLimit(resetsAt?: number): void {
      useAiCreditsBannerStore.getState().clearForChat(TARGET);
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex', resetsAt });
    }

    it('shows the Claude-equivalent banner with the reset time', async () => {
      const resetsAt = Date.now() + 60 * 60_000;
      seedCodexLimit(resetsAt);
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<HarnessWithSchedule />);

      const label = formatUsageLimitTimeLabel(resetsAt);
      expect(label).not.toBeNull();
      expect(container.textContent).toContain('Codex usage limit reached');
      expect(container.textContent).not.toContain('Claude');
      expect(container.textContent).toContain(
        `Your quota resets around ${label}. Do you want to use AI Credits to keep going?`,
      );
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-ai-credits-offer"] button',
        ),
      );
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        `No, resume at ${label}`,
        'Always',
        'Just this chat',
      ]);
      // No provider upsell reaches the banner.
      expect(container.textContent).not.toContain('chatgpt.com');
      expect(container.textContent).not.toContain('Upgrade to Pro');
    });

    it('falls back to No, resume at reset without a reset time', async () => {
      seedCodexLimit();
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<HarnessWithSchedule />);

      expect(container.textContent).toContain('Codex usage limit reached');
      expect(container.textContent).toContain(
        'Do you want to use AI Credits until your quota resets?',
      );
      expect(
        container
          .querySelector(
            '[data-testid="chat-input-usage-limit-schedule-resume"]',
          )
          ?.textContent?.trim(),
      ).toBe('No, resume at reset');
    });

    it('routes Just this chat and Always like Claude', async () => {
      seedCodexLimit(Date.now() + 60 * 60_000);
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={onUseJustThisTime}
        />,
      );

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-input-usage-limit-ai-credits-once"]',
          )
          ?.click();
        await flushAsyncEffects();
      });
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-input-usage-limit-ai-credits-always-on-quota"]',
          )
          ?.click();
        await flushAsyncEffects();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        aiCreditsRoutingMode: 'on-quota',
      });
    });
  });

  it('does not enable on-quota routing just because credits were purchased', async () => {
    // `aiCreditsRoutingMode: 'on-quota'` is a spend-affecting GLOBAL
    // preference. It may only be written when the user presses "Whenever my
    // quota runs out" themselves. Detecting coverage after the billing
    // hand-off must re-read state and surface that choice — never make it.
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    const viewPlans = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-input-usage-limit-view-plans"]',
    );
    await act(async () => {
      viewPlans?.click();
      await flushAsyncEffects();
    });

    // Credits landed while the user was in the browser.
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ personalEligible: true }),
    );
    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + 10 * 60_000);
    try {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await flushAsyncEffects();
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(savePreferences).not.toHaveBeenCalledWith(
      expect.objectContaining({ aiCreditsRoutingMode: 'on-quota' }),
    );
    // The explicit consent button is what appears instead.
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-ai-credits-always-on-quota"]',
      ),
    ).not.toBeNull();
  });

  describe('Check again feedback (CAN-5162)', () => {
    const WAITING_COPY =
      'Finish checkout in your browser. Your credits show up here once the payment goes through.';
    const UNCOVERED_COPY =
      "No credits yet. If you've paid, they can take a minute to arrive.";
    const FAILED_COPY = "Couldn't check your balance. Try again in a moment.";

    beforeEach(() => {
      jest.useFakeTimers({ now: Date.now() });
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    function query(testId: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    }
    function feedback(): HTMLElement | null {
      return query('chat-input-usage-limit-handoff');
    }
    async function settle(ms = 0): Promise<void> {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    }
    async function press(testId: string): Promise<void> {
      const el = query(testId);
      if (!el) throw new Error(`${testId} not found`);
      await act(async () => {
        el.click();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    }
    async function handOffAndCheck(
      element: JSX.Element = <Harness />,
    ): Promise<void> {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(element);
      await press('chat-input-usage-limit-view-plans');
      await press('chat-input-usage-limit-view-plans-check-again');
      await settle(500);
    }

    it('switches to the neutral checkout notice, like every purchase path (CAN-5160)', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<Harness />);
      await press('chat-input-usage-limit-view-plans');

      const banner = query('chat-input-usage-limit-banner');
      expect(banner?.getAttribute('data-notice-intent')).toBe('neutral');
      expect(banner?.textContent).not.toContain('usage limit reached');
      expect(banner?.textContent).toContain(WAITING_COPY);
      // Dismissing still works mid-purchase.
      expect(query('chat-input-usage-limit-dismiss')).not.toBeNull();
    });

    it('says the purchase is waiting in the browser, with Reopen billing as a button', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<Harness />);
      await press('chat-input-usage-limit-view-plans');

      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        WAITING_COPY,
      );
      const buttons = Array.from(
        query('chat-input-usage-limit-banner')?.querySelectorAll<HTMLElement>(
          '[data-notice-actions="below"] button',
        ) ?? [],
      );
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        'Reopen billing',
        'Check again',
      ]);
      // The copy explains the hand-off, so the button carries no tooltip.
      expect(
        query('chat-input-usage-limit-view-plans-check-again')?.hasAttribute(
          'title',
        ),
      ).toBe(false);
    });

    it('shows uncovered feedback in the message with Reopen billing', async () => {
      await handOffAndCheck();

      const line = feedback();
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        UNCOVERED_COPY,
      );
      // Inherits the Notice's own polite region; never nests another one.
      expect(line?.closest('[role="status"]')).toBe(
        query('chat-input-usage-limit-banner'),
      );
      expect(line?.querySelector('[role="status"], [aria-live]')).toBeNull();
      // The action bar keeps its single Check again button.
      expect(
        query('chat-input-usage-limit-view-plans-check-again'),
      ).not.toBeNull();
      expect(query('chat-input-usage-limit-reopen-billing')).not.toBeNull();
    });

    it('reopens billing through the existing hand-off', async () => {
      await handOffAndCheck();
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);

      await press('chat-input-usage-limit-reopen-billing');

      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(2);
      expect(openAuthenticatedPortalPage).toHaveBeenLastCalledWith(
        BANNER_TOP_UP_PATH,
      );
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        WAITING_COPY,
      );
      expect(
        query('chat-input-usage-limit-view-plans-check-again'),
      ).not.toBeNull();
    });

    it('shows the failed-check message without Reopen billing', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner();
      await press('chat-input-usage-limit-view-plans');
      loadNativeAiCreditsAvailability.mockRejectedValueOnce(new Error('down'));
      await press('chat-input-usage-limit-view-plans-check-again');
      await settle(500);

      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        FAILED_COPY,
      );
      expect(query('chat-input-usage-limit-reopen-billing')).toBeNull();
    });

    it('keeps a schedule-resume error alongside the check feedback', async () => {
      await handOffAndCheck(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          scheduleResume={{
            onSchedule: () => {},
            inFlight: false,
            disabled: false,
            error: "Couldn't schedule the resume.",
            scheduledForLabel: null,
          }}
        />,
      );

      const banner = query('chat-input-usage-limit-banner');
      expect(banner?.textContent).toContain("Couldn't schedule the resume.");
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        UNCOVERED_COPY,
      );
    });

    it('drops the feedback with its CTA when credits arrive', async () => {
      await handOffAndCheck();
      expect(feedback()).not.toBeNull();

      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await press('chat-input-usage-limit-view-plans-check-again');
      await settle();

      expect(feedback()).toBeNull();
      expect(query('chat-input-usage-limit-view-plans')).toBeNull();
      expect(
        query('chat-input-usage-limit-ai-credits-always-on-quota'),
      ).not.toBeNull();
    });

    it('does not restore old feedback when its CTA disappears and returns', async () => {
      await handOffAndCheck();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          modelRoutability="routable"
          target={TARGET}
          aiCreditsCardVisible
        />,
      );
      expect(feedback()).toBeNull();
      await renderBanner(<Harness />);
      await settle();
      expect(feedback()).toBeNull();
      expect(query('chat-input-usage-limit-view-plans')).not.toBeNull();
    });

    it('drops the feedback when the chat owner changes', async () => {
      await handOffAndCheck();
      expect(feedback()).not.toBeNull();

      const other: ChatBannerTarget = { ...TARGET, chatId: 'other-chat' };
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(other, { provider: 'claude' });
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={other}
          modelRoutability="routable"
          onUseJustThisTime={() => {}}
        />,
      );
      await settle();

      expect(feedback()).toBeNull();
      useAiCreditsBannerStore.getState().clearForChat(other);
    });
  });

  describe('credits arrival (CAN-5160)', () => {
    const loadCanopyCloudAiCredits = jest.fn<
      Promise<CanopyCloudAiCreditsState>,
      unknown[]
    >();
    const onUseJustThisTime = jest.fn();
    const onUseCreditsForThisChat = jest.fn();
    const onContinueAfterUsingCredits = jest.fn();
    // Which routing action the harness passes. `none` is the fallback for a
    // chat with no per-chat billing choice (CAN-5159).
    let routeWith: 'none' | 'session' | 'chat' = 'none';
    // Stand in for ChatInput: a routing action shows the credits card.
    let routeShowsCard = false;
    // The chat's model routability, and the switch a worktree chat on a
    // model that can't run on credits gets (CAN-4900).
    let routability: CreditsModelRoutability = 'routable';
    let onContinue: (() => Promise<CreditsModelSwitchResult>) | undefined;

    function hasAccentButton(element: Element | null | undefined): boolean {
      return Array.from(element?.querySelectorAll('button') ?? []).some(
        (button) => button.className.split(/\s+/).includes('bg-accent'),
      );
    }

    function balance(credits: number): CanopyCloudAiCreditsState {
      return {
        connected: true,
        email: 'test@example.com',
        subscription: null,
        balance: {
          email: 'test@example.com',
          credits,
          eligible: credits > 0,
          source: 'canopy',
        },
        noUdAccount: false,
        error: null,
      };
    }

    beforeEach(() => {
      jest.useFakeTimers({ now: Date.now() });
      resetAiCreditsArrivalForTests();
      onUseJustThisTime.mockReset();
      onUseCreditsForThisChat.mockReset();
      onContinueAfterUsingCredits.mockReset();
      routeWith = 'none';
      routeShowsCard = false;
      routability = 'routable';
      onContinue = undefined;
      loadCanopyCloudAiCredits.mockReset();
      loadCanopyCloudAiCredits.mockResolvedValue(balance(0));
      Object.assign(window.api, { loadCanopyCloudAiCredits });
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
      resetAiCreditsArrivalForTests();
    });

    function query(testId: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    }
    async function settle(ms = 0): Promise<void> {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
    }
    async function press(testId: string): Promise<void> {
      const el = query(testId);
      if (!el) throw new Error(`${testId} not found`);
      await act(async () => {
        el.click();
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
    }
    function ArrivalHarness({
      target = TARGET,
      cardVisible = false,
      billsCredits,
    }: {
      target?: ChatBannerTarget;
      cardVisible?: boolean;
      billsCredits?: boolean;
    }): JSX.Element {
      const [routedCard, setRoutedCard] = useState(false);
      // A new function each render, like ChatInput's inline props.
      const route =
        (action: jest.Mock): (() => void) =>
        (): void => {
          action();
          if (routeShowsCard) setRoutedCard(true);
        };
      return (
        <AiCreditsUsageLimitBanner
          target={target}
          modelRoutability={routability}
          {...(onContinue
            ? {
                modelLabel: 'GPT 6 Sol',
                creditsModelLabel: 'GPT 6 Luna',
                onContinueOnCreditsModel: onContinue,
              }
            : {})}
          aiCreditsCardVisible={cardVisible || routedCard}
          {...(billsCredits !== undefined
            ? { billsToAiCredits: billsCredits }
            : {})}
          {...(routeWith === 'session'
            ? { onUseJustThisTime: route(onUseJustThisTime) }
            : {})}
          {...(routeWith === 'chat'
            ? { onUseCreditsForThisChat: route(onUseCreditsForThisChat) }
            : {})}
          onContinueAfterUsingCredits={onContinueAfterUsingCredits}
        />
      );
    }
    /** 0 credits at Get AI Credits, 16 when Check again finds coverage. */
    async function buyAndReturn(
      focusBeforeReturn = false,
      balanceFails = false,
      beforeCovered?: () => void,
    ): Promise<void> {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<ArrivalHarness />);
      await press('chat-input-usage-limit-view-plans');
      await settle();
      expect(
        query('chat-input-usage-limit-view-plans-check-again'),
      ).not.toBeNull();
      if (balanceFails)
        loadCanopyCloudAiCredits.mockRejectedValue(
          new Error('balance unavailable'),
        );
      else loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      if (focusBeforeReturn) query('chat-input-usage-limit-dismiss')?.focus();
      if (beforeCovered) {
        await act(async () => {
          beforeCovered();
          await Promise.resolve();
        });
      }
      await press('chat-input-usage-limit-view-plans-check-again');
      await settle();
    }

    it('confirms the increase in a positive notice with only a secondary global action', async () => {
      await buyAndReturn();

      const banner = query('chat-input-usage-limit-banner');
      expect(banner?.getAttribute('data-notice-intent')).toBe('positive');
      expect(banner?.querySelector('[role="status"]')).not.toBeNull();
      expect(banner?.getAttribute('tabindex')).toBe('-1');
      expect(banner?.textContent).toContain('16 AI Credits added.');
      expect(banner?.textContent).not.toContain('usage limit reached');
      // The same question, now about the credits that just arrived.
      expect(banner?.textContent).toContain(
        'Do you want to use your credits until your quota resets?',
      );
      expect(query('chat-input-usage-limit-ai-credits-once')).toBeNull();
      expect(
        query('chat-input-usage-limit-ai-credits-always-on-quota')?.textContent,
      ).toBe('Always');
      expect(
        banner?.querySelector('[data-notice-actions="below"]'),
      ).not.toBeNull();
      // A purchase never puts a global action on the accent.
      expect(hasAccentButton(banner)).toBe(false);
      expect(
        query('chat-input-usage-limit-dismiss')?.getAttribute('aria-label'),
      ).toBe('Dismiss AI Credits notice');
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    });

    it('never routes a chat on a model that cannot run on credits (CAN-4900)', async () => {
      routeWith = 'session';
      routability = 'not-routable';
      onContinue = jest.fn(
        (): Promise<CreditsModelSwitchResult> => Promise.resolve('switched'),
      );
      await buyAndReturn();

      expect(onUseJustThisTime).not.toHaveBeenCalled();
      const banner = query('chat-input-usage-limit-banner');
      expect(banner?.getAttribute('data-notice-intent')).toBe('positive');
      expect(banner?.textContent).toContain(
        "GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits",
      );
      expect(
        query('chat-input-usage-limit-continue-on-credits-model'),
      ).not.toBeNull();
      expect(query('chat-input-usage-limit-ai-credits-once')).toBeNull();
      expect(
        query('chat-input-usage-limit-ai-credits-always-on-quota'),
      ).toBeNull();
    });

    it('keeps the hand-off through an account re-read on return and routes the chat (CAN-5159)', async () => {
      routeWith = 'session';
      routeShowsCard = true;
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<ArrivalHarness />);
      await press('chat-input-usage-limit-view-plans');
      await settle();
      loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      // Past the automatic re-check's throttle, which earlier checks share.
      await settle(61_000);
      // Returning from the browser re-reads the account as well as the
      // CTA's own check; the re-read must not drop the hand-off.
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        await Promise.resolve();
      });
      await settle();

      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      // The card confirms the purchase; the offer never asks.
      expect(query('chat-input-usage-limit-banner')).toBeNull();
      expect(useAiCreditsArrivalStore.getState()).toMatchObject({
        arrival: { chatId: TARGET.chatId, origin: 'usage-limit' },
        routed: true,
      });
    });

    it('asks again once a return check still running settles', async () => {
      routeWith = 'session';
      routeShowsCard = true;
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<ArrivalHarness />);
      await press('chat-input-usage-limit-view-plans');
      await settle(61_000);
      loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      // The CTA's return check is still running when the banner's re-read
      // finds the credits; the account change has already superseded it.
      let finishReturnCheck: (
        value: NativeAiCreditsAvailability,
      ) => void = () => undefined;
      loadNativeAiCreditsAvailability
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishReturnCheck = resolve;
            }),
        )
        .mockResolvedValue(native({ personalEligible: true }));
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        await Promise.resolve();
      });
      await settle();
      expect(onUseJustThisTime).not.toHaveBeenCalled();

      await act(async () => {
        finishReturnCheck(native({ personalEligible: true }));
        await Promise.resolve();
      });
      await settle();

      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      expect(query('chat-input-usage-limit-banner')).toBeNull();
    });

    it('reports nothing when the check it asks for on return cannot conclude', async () => {
      routeWith = 'session';
      routeShowsCard = true;
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(<ArrivalHarness />);
      await press('chat-input-usage-limit-view-plans');
      await settle(61_000);
      // The CTA's own return check, the banner's re-read that finds the
      // credits, then the requested check, which fails.
      loadNativeAiCreditsAvailability
        .mockResolvedValueOnce(native({}))
        .mockResolvedValueOnce(native({ personalEligible: true }))
        .mockRejectedValueOnce(new Error('down'));
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        await Promise.resolve();
      });
      await settle(1_000);

      expect(onUseJustThisTime).not.toHaveBeenCalled();
      const text = query('chat-input-usage-limit-banner')?.textContent ?? '';
      expect(text).toContain('Finish checkout in your browser');
      expect(text).not.toContain("Couldn't check your balance");
      expect(
        query('chat-input-usage-limit-view-plans-check-again'),
      ).not.toBeNull();
    });

    it('shows only in the chat the purchase started in', async () => {
      await buyAndReturn();
      const other: ChatBannerTarget = { ...TARGET, chatId: 'other-chat' };
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(other, { provider: 'claude' });
      await renderBanner(<ArrivalHarness target={other} />);
      await settle();
      expect(
        query('chat-input-usage-limit-banner')?.getAttribute(
          'data-notice-intent',
        ),
      ).toBe('attention');

      await renderBanner(<ArrivalHarness />);
      await settle();
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        '16 AI Credits added.',
      );
      useAiCreditsBannerStore.getState().clearForChat(other);
    });

    it('clears the record when dismissed', async () => {
      await buyAndReturn();
      await press('chat-input-usage-limit-dismiss');
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      expect(query('chat-input-usage-limit-banner')).toBeNull();
    });

    it('keeps focus in the notice when the positive presentation replaces it', async () => {
      await buyAndReturn(true);
      expect(document.activeElement).toBe(
        query('chat-input-usage-limit-banner'),
      );
    });

    it('keeps a generic positive notice and working actions when coverage succeeds but the balance fails', async () => {
      await buyAndReturn(false, true);
      await settle(4_000);
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        'AI Credits are available for this chat.',
      );
      expect(query('chat-input-usage-limit-banner')?.textContent).not.toContain(
        'AI Credits added.',
      );
      await press('chat-input-usage-limit-ai-credits-always-on-quota');
      expect(savePreferences).toHaveBeenCalledWith({
        aiCreditsRoutingMode: 'on-quota',
      });
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('hides during coverage revalidation and restores only after coverage settles', async () => {
      await buyAndReturn();
      let resolveCoverage: (
        value: NativeAiCreditsAvailability,
      ) => void = () => {};
      loadNativeAiCreditsAvailability.mockReturnValue(
        new Promise((resolve) => {
          resolveCoverage = resolve;
        }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      expect(
        query('chat-input-usage-limit-banner')?.getAttribute(
          'data-notice-intent',
        ),
      ).toBe('attention');
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
      resolveCoverage(native({ personalEligible: true }));
      await settle();
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        '16 AI Credits added.',
      );
    });

    it('clears before Always use credits even if saving fails', async () => {
      await buyAndReturn();
      savePreferences.mockImplementation(() => {
        expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
        return Promise.reject(new Error('save failed'));
      });
      await press('chat-input-usage-limit-ai-credits-always-on-quota');
      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      // Preserve the existing preference action's dismissal on failure.
      expect(query('chat-input-usage-limit-banner')).toBeNull();
    });

    it('clears before the Use AI Credits action', async () => {
      await buyAndReturn();
      routeWith = 'session';
      await renderBanner(<ArrivalHarness billsCredits />);
      await press('chat-input-usage-limit-use-ai-credits');
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('clears a hidden arrival before using credits during inconclusive coverage', async () => {
      await buyAndReturn();
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true, inconclusive: true }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await settle();
      expect(
        query('chat-input-usage-limit-banner')?.getAttribute(
          'data-notice-intent',
        ),
      ).toBe('attention');
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
      routeWith = 'session';
      await renderBanner(<ArrivalHarness />);
      expect(onUseJustThisTime).not.toHaveBeenCalled();
      let clearedBeforeDispatch = false;
      onUseJustThisTime.mockImplementation(() => {
        clearedBeforeDispatch =
          useAiCreditsArrivalStore.getState().arrival === null;
      });

      await press('chat-input-usage-limit-use-ai-credits');
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      expect(clearedBeforeDispatch).toBe(true);
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();

      // The action has not changed routing or hidden the banner. A later
      // successful coverage read must not restore the spent confirmation.
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await settle();
      expect(query('chat-input-usage-limit-banner')?.textContent).not.toContain(
        '16 AI Credits added.',
      );
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('clears before dispatch while same-account reconciliation is pending', async () => {
      await buyAndReturn();
      const accountId = useAiCreditsArrivalStore.getState().arrival?.accountId;
      expect(accountId).toBeDefined();
      await act(async () => {
        suspendAiCreditsArrivalAccount();
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await settle();
      expect(useAiCreditsArrivalStore.getState().accountReady).toBe(false);
      expect(
        query('chat-input-usage-limit-banner')?.getAttribute(
          'data-notice-intent',
        ),
      ).toBe('attention');
      routeWith = 'session';
      await renderBanner(<ArrivalHarness />);
      expect(onUseJustThisTime).not.toHaveBeenCalled();
      let clearedBeforeDispatch = false;
      onUseJustThisTime.mockImplementation(() => {
        clearedBeforeDispatch =
          useAiCreditsArrivalStore.getState().arrival === null;
      });
      await press('chat-input-usage-limit-ai-credits-once');
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      expect(clearedBeforeDispatch).toBe(true);
      await act(async () => {
        reconcileAiCreditsArrivalAccount(accountId ?? null);
        await Promise.resolve();
      });
      await settle();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      expect(query('chat-input-usage-limit-banner')?.textContent).not.toContain(
        '16 AI Credits added.',
      );
    });

    it('clears an arrival queued during account revalidation before using credits', async () => {
      routeWith = 'session';
      await buyAndReturn(false, false, suspendAiCreditsArrivalAccount);
      expect(useAiCreditsArrivalStore.getState().accountReady).toBe(false);
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      await press('chat-input-usage-limit-ai-credits-once');
      expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      await act(async () => {
        reconcileAiCreditsArrivalAccount('account:acct_1');
        await Promise.resolve();
      });
      await settle();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      expect(query('chat-input-usage-limit-banner')?.textContent).not.toContain(
        '16 AI Credits added.',
      );
    });

    it('preserves a newer arrival when an earlier preference save completes', async () => {
      await buyAndReturn();
      let resolveSave: () => void = () => {};
      savePreferences.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );
      await press('chat-input-usage-limit-ai-credits-always-on-quota');
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await act(async () => {
        invalidateSharedAiCreditsRead();
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await settle();
      await buyAndReturn();
      const newer = useAiCreditsArrivalStore.getState().arrival;
      expect(newer).not.toBeNull();
      resolveSave();
      await settle();
      expect(useAiCreditsArrivalStore.getState().arrival).toBe(newer);
      expect(query('chat-input-usage-limit-banner')).toBeNull();
    });

    it('hides for the credits card without consuming the record', async () => {
      await buyAndReturn();
      await renderBanner(<ArrivalHarness cardVisible />);
      expect(query('chat-input-usage-limit-banner')).toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
      await renderBanner(<ArrivalHarness />);
      await settle();
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        '16 AI Credits added.',
      );
    });

    it('does not reclaim focus after the notice was hidden for the credits card', async () => {
      await buyAndReturn();
      query('chat-input-usage-limit-banner')?.focus();
      await renderBanner(<ArrivalHarness cardVisible />);
      await settle();
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      await renderBanner(<ArrivalHarness />);
      await settle();
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });

    it('preserves the arrival when scheduling Resume at reset', async () => {
      await buyAndReturn();
      const arrival = useAiCreditsArrivalStore.getState().arrival;
      const onSchedule = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          scheduleResume={{
            onSchedule,
            inFlight: false,
            disabled: false,
            error: null,
            scheduledForLabel: null,
          }}
        />,
      );
      await settle();
      await press('chat-input-usage-limit-schedule-resume');
      expect(onSchedule).toHaveBeenCalledTimes(1);
      expect(useAiCreditsArrivalStore.getState().arrival).toBe(arrival);
    });

    it('hides for uncovered or inconclusive coverage without consuming the record', async () => {
      await buyAndReturn();
      for (const next of [
        native({}),
        native({ personalEligible: true, inconclusive: true }),
      ]) {
        loadNativeAiCreditsAvailability.mockResolvedValue(next);
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          await Promise.resolve();
        });
        await settle();
        expect(
          query('chat-input-usage-limit-banner')?.getAttribute(
            'data-notice-intent',
          ),
        ).toBe('attention');
        expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
      }
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      await settle();
      expect(query('chat-input-usage-limit-banner')?.textContent).toContain(
        '16 AI Credits added.',
      );
    });

    describe('routes the chat once credits arrive (CAN-5159)', () => {
      function routedRecord(): ReturnType<
        typeof selectRoutedAiCreditsArrivalForChat
      > {
        return selectRoutedAiCreditsArrivalForChat(
          useAiCreditsArrivalStore.getState(),
          TARGET,
        );
      }
      function unroutedRecord(): ReturnType<
        typeof selectAiCreditsArrivalForChat
      > {
        return selectAiCreditsArrivalForChat(
          useAiCreditsArrivalStore.getState(),
          TARGET,
          'usage-limit',
        );
      }

      it('neither shows nor routes a No billing source record for its chat', async () => {
        routeWith = 'session';
        routeShowsCard = true;
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ personalEligible: true }),
        );
        await act(async () => {
          const handoff = beginAiCreditsArrivalHandoff(
            {
              kind: 'work',
              projectId: TARGET.projectId,
              worktreeId: TARGET.worktreeId,
              chatId: TARGET.chatId,
            },
            'no-billing-source',
          );
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
          handoff?.markExternalOpen();
          handoff?.retain();
          expect(handoff?.recordCovered()).toBe(true);
        });
        await renderBanner(<ArrivalHarness />);
        await settle(4_000);

        expect(useAiCreditsArrivalStore.getState().arrival?.origin).toBe(
          'no-billing-source',
        );
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(useAiCreditsArrivalStore.getState().routed).toBe(false);
        expect(
          query('chat-input-usage-limit-banner')?.getAttribute(
            'data-notice-intent',
          ),
        ).toBe('attention');
        expect(
          query('chat-input-usage-limit-banner')?.textContent,
        ).not.toContain('AI Credits added.');
      });

      it('routes a worktree chat once without ever painting the choice notice', async () => {
        routeWith = 'session';
        routeShowsCard = true;
        const painted: { intent: string | null; text: string }[] = [];
        const observer = new MutationObserver(() => {
          const banner = query('chat-input-usage-limit-banner');
          if (banner === null) return;
          painted.push({
            intent: banner.getAttribute('data-notice-intent'),
            text: banner.textContent ?? '',
          });
        });
        await buyAndReturn(false, false, () => {
          observer.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
          });
        });
        await settle(4_000);
        observer.disconnect();

        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        // An arrival only routes; the card's Continue sends (CAN-4756).
        expect(onContinueAfterUsingCredits).not.toHaveBeenCalled();
        expect(query('chat-input-usage-limit-banner')).toBeNull();
        // The positive choice notice never painted, even for one commit.
        expect(painted.some(({ intent }) => intent === 'positive')).toBe(false);
        expect(
          painted.some(({ text }) => text.includes('AI Credits added.')),
        ).toBe(false);
        // The card owns the record now, with its evidence intact.
        const routed = routedRecord();
        expect(routed).not.toBeNull();
        expect(unroutedRecord()).toBeNull();
        expect(useAiCreditsArrivalStore.getState().evidence).toMatchObject({
          handoffId: routed?.handoffId,
          addedCredits: 16,
        });
        expect(savePreferences).not.toHaveBeenCalledWith(
          expect.objectContaining({ aiCreditsRoutingMode: 'on-quota' }),
        );
      });

      it('routes without a second click when hosted settings are openable', async () => {
        // The rollout default: Get AI Credits still goes to the browser, so the
        // hand-off survives and the purchase is consent for this chat.
        mockHostedSettingsOpenable.mockReturnValue(true);
        routeWith = 'session';
        routeShowsCard = true;
        await buyAndReturn();
        await settle(4_000);

        expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        expect(query('chat-input-usage-limit-banner')).toBeNull();
        expect(query('chat-input-usage-limit-ai-credits-once')).toBeNull();
        expect(
          query('chat-input-usage-limit-ai-credits-always-on-quota'),
        ).toBeNull();
        expect(savePreferences).not.toHaveBeenCalled();
      });

      it('routes through the per-chat billing choice without session routing', async () => {
        routeWith = 'chat';
        routeShowsCard = true;
        await buyAndReturn();
        expect(onUseCreditsForThisChat).toHaveBeenCalledTimes(1);
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(query('chat-input-usage-limit-banner')).toBeNull();
        expect(routedRecord()).not.toBeNull();
        expect(savePreferences).not.toHaveBeenCalled();
      });

      it('falls back to the ordinary offer when routing shows no card', async () => {
        routeWith = 'session';
        await buyAndReturn();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        // The arrival cannot come back, and the user keeps the usual offer.
        expect(routedRecord()).not.toBeNull();
        expect(
          query('chat-input-usage-limit-banner')?.getAttribute(
            'data-notice-intent',
          ),
        ).toBe('attention');
        expect(
          query('chat-input-usage-limit-ai-credits-always-on-quota')
            ?.textContent,
        ).toBe('Always');
        await settle(4_000);
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
      });

      it('waits for coverage to settle before routing', async () => {
        await buyAndReturn();
        let resolveCoverage: (
          value: NativeAiCreditsAvailability,
        ) => void = () => {};
        loadNativeAiCreditsAvailability.mockReturnValue(
          new Promise((resolve) => {
            resolveCoverage = resolve;
          }),
        );
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          await Promise.resolve();
        });
        routeWith = 'session';
        await renderBanner(<ArrivalHarness />);
        await settle();
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(unroutedRecord()).not.toBeNull();

        resolveCoverage(native({ personalEligible: true }));
        await settle();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        expect(routedRecord()).not.toBeNull();
      });

      it('does not route for coverage this chat cannot spend', async () => {
        await buyAndReturn();
        routeWith = 'session';
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({
            inOrg: true,
            orgCreditPoolCovered: true,
            orgSpendable: false,
          }),
        );
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          await Promise.resolve();
        });
        await renderBanner(<ArrivalHarness />);
        await settle();
        expect(query('chat-input-usage-limit-contact-admin')).not.toBeNull();
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(unroutedRecord()).not.toBeNull();
      });

      it('does not route another chat', async () => {
        await buyAndReturn();
        const other: ChatBannerTarget = { ...TARGET, chatId: 'other-chat' };
        useAiCreditsBannerStore
          .getState()
          .setUsageLimit(other, { provider: 'claude' });
        routeWith = 'session';
        await renderBanner(<ArrivalHarness target={other} />);
        await settle();
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(unroutedRecord()).not.toBeNull();
        useAiCreditsBannerStore.getState().clearForChat(other);
      });

      it('only marks the record routed when the chat already bills to credits', async () => {
        await buyAndReturn();
        routeWith = 'session';
        await renderBanner(<ArrivalHarness billsCredits />);
        await settle();
        expect(onUseJustThisTime).not.toHaveBeenCalled();
        expect(unroutedRecord()).toBeNull();
        expect(routedRecord()).not.toBeNull();
      });

      it('routes once across re-renders and a remount', async () => {
        routeWith = 'session';
        await buyAndReturn();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        // A new inline action on every render must not route again.
        await renderBanner(<ArrivalHarness />);
        await settle();
        act(() => {
          root.unmount();
        });
        root = createRoot(container);
        await renderBanner(<ArrivalHarness />);
        await settle();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        expect(routedRecord()).not.toBeNull();
      });

      it('routes with a resume scheduled or automatic routing already on', async () => {
        loadPreferences.mockResolvedValue({
          aiCreditsRoutingMode: 'on-quota',
        } as PreferencesData);
        await buyAndReturn();
        await renderBanner(
          <AiCreditsUsageLimitBanner
            target={TARGET}
            modelRoutability="routable"
            onUseJustThisTime={onUseJustThisTime}
            scheduleResume={{
              onSchedule: () => {},
              inFlight: false,
              disabled: true,
              error: null,
              scheduledForLabel: '6:00 PM',
            }}
          />,
        );
        await settle();
        expect(onUseJustThisTime).toHaveBeenCalledTimes(1);
        expect(routedRecord()).not.toBeNull();
      });
    });

    it('keeps the warning for coverage that did not follow a hand-off', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<ArrivalHarness />);
      await settle();
      expect(
        query('chat-input-usage-limit-banner')?.getAttribute(
          'data-notice-intent',
        ),
      ).toBe('attention');
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });
  });

  describe('yields to the AI Credits card before a turn routes (CAN-4757)', () => {
    const BANNER = '[data-testid="chat-input-usage-limit-banner"]';
    const CONTROLS = [
      '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
      '[data-testid="chat-input-usage-limit-ai-credits-once"]',
      '[data-testid="chat-input-usage-limit-ai-credits-always-on-quota"]',
      '[data-testid="chat-input-usage-limit-schedule-resume"]',
    ];

    function CardHarness({
      aiCreditsCardVisible,
    }: {
      aiCreditsCardVisible?: boolean;
    }): JSX.Element {
      return (
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={() => {}}
          scheduleResume={{
            onSchedule: () => {},
            inFlight: false,
            disabled: false,
            error: null,
            scheduledForLabel: null,
          }}
          {...(aiCreditsCardVisible === undefined
            ? {}
            : { aiCreditsCardVisible })}
        />
      );
    }

    function expectHidden(): void {
      expect(container.querySelector(BANNER)).toBeNull();
      for (const selector of CONTROLS) {
        expect(container.querySelector(selector)).toBeNull();
      }
    }

    it.each(['claude', 'codex'] as const)(
      'hides a retained %s limit and its controls while the card shows, and restores it on switch back',
      async (provider) => {
        useAiCreditsBannerStore.getState().clearForChat(TARGET);
        useAiCreditsBannerStore.getState().setUsageLimit(TARGET, {
          provider,
          resetsAt: Date.now() + 60 * 60_000,
        });
        loadNativeAiCreditsAvailability.mockResolvedValue(
          native({ personalEligible: true }),
        );

        await renderBanner(<CardHarness />);
        expect(container.querySelector(BANNER)).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="chat-input-usage-limit-ai-credits-once"]',
          ),
        ).not.toBeNull();

        await renderBanner(<CardHarness aiCreditsCardVisible />);
        expectHidden();

        // Switching back before any send restores the retained offer without
        // reseeding: the store entry was never dismissed.
        await renderBanner(<CardHarness aiCreditsCardVisible={false} />);
        expect(container.querySelector(BANNER)).not.toBeNull();
        expect(
          container.querySelector(
            '[data-testid="chat-input-usage-limit-ai-credits-once"]',
          ),
        ).not.toBeNull();
      },
    );

    it('does not start an availability read while hidden by the card', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<CardHarness aiCreditsCardVisible />);

      expectHidden();
      expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
    });

    it('stays hidden when a pending availability read resolves after the card shows', async () => {
      let resolveAvailability: (
        value: NativeAiCreditsAvailability,
      ) => void = () => {};
      loadNativeAiCreditsAvailability.mockReturnValue(
        new Promise<NativeAiCreditsAvailability>((resolve) => {
          resolveAvailability = resolve;
        }),
      );
      await renderBanner(<CardHarness />);
      expect(container.querySelector(BANNER)).not.toBeNull();
      expect(loadNativeAiCreditsAvailability).toHaveBeenCalledTimes(1);

      await renderBanner(<CardHarness aiCreditsCardVisible />);
      expectHidden();

      await act(async () => {
        resolveAvailability(native({ personalEligible: true }));
        await flushAsyncEffects();
      });
      expectHidden();
    });

    it('keeps the existing behavior when the prop is omitted', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<CardHarness />);

      expect(container.querySelector(BANNER)).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
        ),
      ).not.toBeNull();
    });

    it('still hides on the routing event when the card is not visible', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      act(() => {
        useAiCreditsBannerStore.getState().setRoutingActive(TARGET, true);
      });
      await renderBanner(<CardHarness aiCreditsCardVisible={false} />);

      expectHidden();
    });

    // A credits-only account (no native login) bills to credits, but the
    // card needs a native login, so the notice is the only limit signal left.
    it('keeps the notice for a chat that bills to credits while the card cannot show', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          onUseJustThisTime={() => {}}
          billsToAiCredits
          aiCreditsCardVisible={false}
        />,
      );
      expect(container.querySelector(BANNER)).not.toBeNull();
      // The chat already bills to credits, so the switch offer is withheld.
      // The sentence's "continue on credits" half keeps its single action.
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-ai-credits-offer"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-usage-limit-use-ai-credits"]',
        ),
      ).not.toBeNull();

      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability="routable"
          billsToAiCredits
          aiCreditsCardVisible
        />,
      );
      expectHidden();
    });

    it('renders nothing without a limit', async () => {
      useAiCreditsBannerStore.getState().clearForChat(TARGET);
      await renderBanner(<CardHarness aiCreditsCardVisible={false} />);

      expect(container.querySelector(BANNER)).toBeNull();
      expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
    });
  });

  describe('model that cannot run on AI Credits (CAN-4900)', () => {
    const OFFER_IDS = [
      'chat-input-usage-limit-ai-credits-once',
      'chat-input-usage-limit-ai-credits-always-on-quota',
      'chat-input-usage-limit-use-ai-credits',
    ];
    const SWITCH = 'chat-input-usage-limit-continue-on-credits-model';
    let resetsAt: number;
    let label: string;

    beforeEach(() => {
      resetsAt = Date.now() + 60 * 60_000;
      label = formatUsageLimitTimeLabel(resetsAt) ?? '';
      useAiCreditsBannerStore.getState().clearForChat(TARGET);
      useAiCreditsBannerStore
        .getState()
        .setUsageLimit(TARGET, { provider: 'codex', resetsAt });
    });

    function query(testId: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    }
    async function press(testId: string): Promise<void> {
      const el = query(testId);
      if (!el) throw new Error(`${testId} not found`);
      await act(async () => {
        el.click();
        await flushAsyncEffects();
      });
    }

    function GatedHarness({
      routability = 'not-routable',
      onContinue,
      creditsModelLabel = 'GPT 6 Luna',
      onUseJustThisTime = (): void => {},
    }: {
      routability?: CreditsModelRoutability;
      onContinue?: () => Promise<CreditsModelSwitchResult>;
      creditsModelLabel?: string | null;
      onUseJustThisTime?: () => void;
    }): JSX.Element {
      return (
        <AiCreditsUsageLimitBanner
          target={TARGET}
          modelRoutability={routability}
          modelLabel="GPT 6 Sol"
          onUseJustThisTime={onUseJustThisTime}
          {...(creditsModelLabel !== null ? { creditsModelLabel } : {})}
          {...(onContinue ? { onContinueOnCreditsModel: onContinue } : {})}
          scheduleResume={{
            onSchedule: () => {},
            inFlight: false,
            disabled: false,
            error: null,
            scheduledForLabel: null,
          }}
        />
      );
    }

    it('names the model and offers the credits model instead of credits', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <GatedHarness
          onContinue={() => Promise.resolve('switched')}
          onUseJustThisTime={onUseJustThisTime}
        />,
      );

      const banner = query('chat-input-usage-limit-banner');
      expect(banner?.textContent).toContain(
        `GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits, or wait until ${label}.`,
      );
      for (const id of OFFER_IDS) expect(query(id)).toBeNull();
      const buttons = Array.from(
        banner?.querySelectorAll<HTMLButtonElement>(
          '[data-notice-actions] button',
        ) ?? [],
      );
      // The switch is the single accent action, last on its own row, and
      // the resume label answers no question.
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        `Resume at ${label}`,
        'Continue on GPT 6 Luna',
      ]);
      expect(
        buttons
          .filter((button) => /(^|\s)bg-accent(\s|$)/.test(button.className))
          .map((button) => button.textContent?.trim()),
      ).toEqual(['Continue on GPT 6 Luna']);
      expect(
        banner?.querySelector('[data-notice-actions="below"]'),
      ).not.toBeNull();
      expect(onUseJustThisTime).not.toHaveBeenCalled();
    });

    it('shows the gate without the switch where the surface cannot switch', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<GatedHarness />);

      expect(container.textContent).toContain(
        `GPT 6 Sol can't run on AI Credits. Choose a model that can, or wait until ${label}.`,
      );
      expect(query(SWITCH)).toBeNull();
      for (const id of OFFER_IDS) expect(query(id)).toBeNull();
    });

    it('asks for another model when the credits model cannot run on credits', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <GatedHarness
          creditsModelLabel={null}
          onContinue={() => Promise.resolve('switched')}
        />,
      );

      expect(container.textContent).toContain(
        `GPT 6 Sol can't run on AI Credits. Choose a model that can, or wait until ${label}.`,
      );
      expect(query(SWITCH)).toBeNull();
    });

    it('shows a failed switch inside the single status and keeps the button', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      let finish: (result: CreditsModelSwitchResult) => void = () => {};
      const onContinue = jest.fn(
        () =>
          new Promise<CreditsModelSwitchResult>((resolve) => {
            finish = resolve;
          }),
      );
      await renderBanner(<GatedHarness onContinue={onContinue} />);

      await press(SWITCH);
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(query(SWITCH)?.hasAttribute('disabled')).toBe(true);

      await act(async () => {
        finish('switch-failed');
        await flushAsyncEffects();
      });
      // The notice's own status is the only live region; the failure is read
      // inside it.
      const statuses = container.querySelectorAll('[role="status"]');
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.textContent).toContain(
        `Couldn't switch to GPT 6 Luna. Try again or wait until ${label}.`,
      );
      expect(query(SWITCH)?.hasAttribute('disabled')).toBe(false);
    });

    it('treats a rejected switch as a failed one', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <GatedHarness onContinue={() => Promise.reject(new Error('ipc'))} />,
      );

      await press(SWITCH);
      expect(
        query('chat-input-usage-limit-switch-error')?.textContent,
      ).toContain("Couldn't switch to GPT 6 Luna.");
      expect(query(SWITCH)).not.toBeNull();
    });

    it('shows no error after a switch', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <GatedHarness onContinue={() => Promise.resolve('switched')} />,
      );

      await press(SWITCH);
      expect(query('chat-input-usage-limit-switch-error')).toBeNull();
    });

    it('drops the failure when a new limit replaces the one it was for', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <GatedHarness onContinue={() => Promise.resolve('switch-failed')} />,
      );
      await press(SWITCH);
      expect(query('chat-input-usage-limit-switch-error')).not.toBeNull();

      await act(async () => {
        useAiCreditsBannerStore
          .getState()
          .setUsageLimit(TARGET, { provider: 'codex', resetsAt: resetsAt + 1 });
        await flushAsyncEffects();
      });
      expect(query('chat-input-usage-limit-banner')).not.toBeNull();
      expect(query('chat-input-usage-limit-switch-error')).toBeNull();
    });

    it('offers no credits and no gate before the catalog answers', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(
        <GatedHarness
          routability="unknown"
          onContinue={() => Promise.resolve('switched')}
        />,
      );

      for (const id of [...OFFER_IDS, SWITCH]) expect(query(id)).toBeNull();
      expect(container.textContent).not.toContain("can't run on AI Credits");
      // No action can take credits here, so the message doesn't invite them.
      expect(container.textContent).not.toContain('Continue on AI Credits');
      expect(container.textContent).toContain(
        `Wait for your quota to reset around ${label}.`,
      );
      expect(
        query('chat-input-usage-limit-schedule-resume')?.textContent?.trim(),
      ).toBe(`Resume at ${label}`);
    });

    it('points the purchase at the credits model without a switch', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
      await renderBanner(
        <GatedHarness onContinue={() => Promise.resolve('switched')} />,
      );

      expect(container.textContent).toContain(
        `GPT 6 Sol can't run on AI Credits. Get AI Credits to continue on GPT 6 Luna, or wait for your quota to reset around ${label}.`,
      );
      expect(
        query('chat-input-usage-limit-view-plans')?.textContent?.trim(),
      ).toBe('Get AI Credits');
      expect(query(SWITCH)).toBeNull();
    });
  });
});
