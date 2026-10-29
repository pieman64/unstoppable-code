/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  NativeAiCreditsAvailability,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { AiCreditsUsageLimitBanner } from '../AiCreditsUsageLimitBanner';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';

const TARGET: ChatBannerTarget = {
  projectId: 'proj',
  worktreeId: 'wt',
  chatId: 'chat',
};

const PRICING_URL = 'https://cloud.example.com/pricing';

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
    <AiCreditsUsageLimitBanner target={TARGET} onUseJustThisTime={() => {}} />
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

    openExternal.mockResolvedValue(undefined);
    openAuthenticatedPortalPage.mockResolvedValue(true);
    savePreferences.mockResolvedValue(undefined);
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth',
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

  it('keeps the accent action last and drops three actions to their own row', async () => {
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
    // Alternatives first, the single accent action last (far right).
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Use credits now',
      'Resume at reset',
      'Always use credits',
    ]);
    // Text-only labels: the words name the resource and timing, so no
    // glyphs compete with them (design owner, 2026-09-17).
    expect(
      buttons.every((button) => button.querySelector('svg') === null),
    ).toBe(true);
    // Three actions move to their own row, aligned with the message.
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
      'This chat resumes automatically at Tue 9:00 AM, or continue on',
    );
    expect(container.textContent).not.toContain('Resume scheduled for');
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-input-usage-limit-ai-credits-offer"] button',
      ),
    );
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Use credits now',
      'Always use credits',
    ]);
    // Two actions stay on the message row.
    expect(container.querySelector('[data-notice-actions="below"]')).toBeNull();
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
    'ends the continue-or-wait notice with a primary Use AI Credits action when %s',
    async (_case, arrange) => {
      arrange();
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
          onUseJustThisTime={onUseJustThisTime}
        />,
      );

      expect(container.textContent).toContain('credits or wait for your quota');
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
        onUseJustThisTime={() => {}}
      />,
    );
    // The row must not draw the fallback and then swap it for the offer.
    expect(container.textContent).toContain('credits or wait for your quota');
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
      '/account/billing',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('names the plan upgrade in the purchase state without free access', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    await renderBanner();

    expect(container.textContent).toContain('Upgrade your');
    expect(container.textContent).toContain('plan to keep working');
  });

  it('offers credits instead of a plan upgrade under free access', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    Object.assign(window.api, {
      loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
        resolved: true,
        canDisableSharing: true,
        canRemoteControl: true,
        source: 'none',
        plan: null,
        trial: null,
        billingManageableOrg: null,
        displayPlan: null,
        billingPresentation: null,
        freeAccess: true,
      }),
    });
    await renderBanner();

    expect(container.textContent).toContain(
      'credits to keep working when you hit your provider limits.',
    );
    expect(container.textContent).not.toContain('plan');
    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans"]',
      ),
    ).not.toBeNull();
  });

  it('offers credits in the scheduled sentence under free access', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    Object.assign(window.api, {
      loadCanopyCloudEntitlements: jest.fn().mockResolvedValue({
        resolved: true,
        canDisableSharing: true,
        canRemoteControl: true,
        source: 'none',
        plan: null,
        trial: null,
        billingManageableOrg: null,
        displayPlan: null,
        billingPresentation: null,
        freeAccess: true,
      }),
    });
    await renderBanner(
      <HarnessWithSchedule disabled scheduledForLabel="6:00 PM" />,
    );

    expect(container.textContent).toContain(
      'This chat resumes automatically at 6:00 PM, or get',
    );
    expect(container.textContent).toContain('credits to keep working now.');
    expect(container.textContent).not.toContain('plan');
  });

  it('keeps the recovery actions when the entitlements read fails', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(native({}));
    Object.assign(window.api, {
      loadCanopyCloudEntitlements: jest
        .fn()
        .mockRejectedValue(new Error('offline')),
    });
    await renderBanner();

    expect(
      container.querySelector(
        '[data-testid="chat-input-usage-limit-view-plans"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain('Upgrade your');
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
        credentialSource: 'oauth',
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
      '/account/billing',
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
      '/account/billing',
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
        `wait for your quota to reset around ${label}.`,
      );
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-input-usage-limit-ai-credits-offer"] button',
        ),
      );
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        'Use credits now',
        `Resume at ${label}`,
        'Always use credits',
      ]);
      // No provider upsell reaches the banner.
      expect(container.textContent).not.toContain('chatgpt.com');
      expect(container.textContent).not.toContain('Upgrade to Pro');
    });

    it('falls back to Resume at reset without a reset time', async () => {
      seedCodexLimit();
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await renderBanner(<HarnessWithSchedule />);

      expect(container.textContent).toContain('Codex usage limit reached');
      expect(container.textContent).toContain(
        'credits or wait for your quota to reset.',
      );
      expect(
        container
          .querySelector(
            '[data-testid="chat-input-usage-limit-schedule-resume"]',
          )
          ?.textContent?.trim(),
      ).toBe('Resume at reset');
    });

    it('routes Use credits now and Always use credits like Claude', async () => {
      seedCodexLimit(Date.now() + 60 * 60_000);
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      const onUseJustThisTime = jest.fn();
      await renderBanner(
        <AiCreditsUsageLimitBanner
          target={TARGET}
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

    it('renders nothing without a limit', async () => {
      useAiCreditsBannerStore.getState().clearForChat(TARGET);
      await renderBanner(<CardHarness aiCreditsCardVisible={false} />);

      expect(container.querySelector(BANNER)).toBeNull();
      expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
    });
  });
});
