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
  AgentProviderType,
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { NoBillingSourceBanner } from '../NoBillingSourceBanner';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import {
  beginAiCreditsArrivalHandoff,
  resetAiCreditsArrivalForTests,
  useAiCreditsArrivalStore,
} from '@/lib/aiCreditsArrivalConfirmation';
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

// The login modal pulls the full settings auth stack; the banner only needs to
// know it mounts, so stub it.
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): JSX.Element => (
    <div data-testid="auth-login-modal-stub" />
  ),
}));

const mockTrackCreditsRecoveryView = jest.fn();
const mockTrackCreditsRecoveryClick = jest.fn();
jest.mock('@/lib/creditsRecoveryTelemetry', () => ({
  trackCreditsRecoveryView: (...args: unknown[]): void => {
    mockTrackCreditsRecoveryView(...args);
  },
  trackCreditsRecoveryClick: (...args: unknown[]): void => {
    mockTrackCreditsRecoveryClick(...args);
  },
}));

const PRICING_URL = 'https://cloud.example.com/pricing';
// Get AI Credits always opens the signed-in web top-up (CAN-5159).
const BANNER_TOP_UP_PATH =
  '/account/billing?topUp=1&reason=credits&source=banner';

function native(
  overrides: Partial<NativeAiCreditsAvailability> = {},
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

function cloudAccount(
  credentialSource: CanopyCloudAccountPublicState['credentialSource'],
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: credentialSource === 'guest' ? 'guest' : 'oauth',
    credentialSource,
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'acct_1',
      name: 'Test User',
      email: 'test@example.com',
      role: 'DEVELOPER',
    },
  };
}

/** Default state the banner exists for: no native login, no credits. */
function availability(
  overrides: Partial<ProviderModelAvailability> = {},
): ProviderModelAvailability {
  return {
    selectable: true,
    nativeAuth: false,
    creditsEligible: false,
    loading: false,
    ...overrides,
  };
}

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('NoBillingSourceBanner', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadNativeAiCreditsAvailability = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    []
  >();
  const loadCanopyCloudAccount = jest.fn<
    Promise<CanopyCloudAccountPublicState | null>,
    []
  >();
  const loadCanopyCloudAiCredits = jest.fn<
    Promise<CanopyCloudAiCreditsState>,
    []
  >();
  const openExternal = jest.fn<Promise<void>, [{ url: string }]>();
  const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The shared availability read retains its settled answer for the current
    // episode, so it must be reset between tests: this file mounts
    // `GetAiCreditsCta`, whose mount effect seeds one, and a retained answer
    // would otherwise satisfy the next test's assertions for the wrong reason.
    invalidateSharedAiCreditsRead();
    resetAiCreditsArrivalForTests();
    loadNativeAiCreditsAvailability.mockReset();
    loadCanopyCloudAiCredits.mockReset();
    loadCanopyCloudAccount.mockReset();
    mockTrackCreditsRecoveryView.mockReset();
    mockTrackCreditsRecoveryClick.mockReset();
    openExternal.mockReset();
    openAuthenticatedPortalPage.mockReset();
    mockHostedSettingsOpenable.mockReset().mockReturnValue(false);
    openAccountOrganizationSettings.mockReset();
    useNavigationStore.setState({ openAccountOrganizationSettings });

    loadNativeAiCreditsAvailability.mockResolvedValue(native());
    loadCanopyCloudAccount.mockResolvedValue(null);
    openExternal.mockResolvedValue(undefined);
    openAuthenticatedPortalPage.mockResolvedValue(true);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        loadCanopyCloudAccount,
        loadCanopyCloudAiCredits,
        openAuthenticatedPortalPage,
        browser: { openExternal },
      },
    });

    useCloudConnectGateStore.setState({ pending: null });
    useAiCreditsBannerStore.setState({
      routingActiveByChat: {},
      usageLimitByChat: {},
      noBillingSourceByChat: {},
      dismissedUsageLimitKeyByChat: {},
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetAiCreditsArrivalForTests();
    useNavigationStore.setState({
      openAccountOrganizationSettings: realOpenAccountOrganizationSettings,
    });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function render(
    provider: AgentProviderType,
    overrides: Partial<ProviderModelAvailability> = {},
    orgLapseVisible = false,
    options: {
      target?: ChatBannerTarget | null;
      queuedCreditHeld?: boolean;
      gatewayOnlyModel?: boolean;
      effectiveBillingFramework?: 'subscription' | 'ai-credits' | null;
      noDispatchableModel?: {
        missing: 'billing-lane' | 'policy-allowance' | 'both';
        lanesNeeded?: readonly (
          | 'claude-native'
          | 'codex-native'
          | 'ai-credits'
          | 'ollama'
        )[];
        policyRestricted?: boolean;
        hasPolicyAllowedLane?: boolean;
      } | null;
      turnActive?: boolean;
      aiCreditsCardVisible?: boolean;
      aiCreditsCardExpected?: boolean;
    } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <NoBillingSourceBanner
          provider={provider}
          availability={availability(overrides)}
          orgLapseVisible={orgLapseVisible}
          target={options.target ?? null}
          queuedCreditHeld={options.queuedCreditHeld}
          gatewayOnlyModel={options.gatewayOnlyModel ?? false}
          effectiveBillingFramework={options.effectiveBillingFramework ?? null}
          noDispatchableModel={options.noDispatchableModel ?? null}
          turnActive={options.turnActive ?? false}
          aiCreditsCardVisible={options.aiCreditsCardVisible ?? false}
          aiCreditsCardExpected={options.aiCreditsCardExpected ?? false}
        />,
      );
      await flushAsyncEffects();
    });
  }

  function signInButton(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="chat-input-no-billing-source-sign-in"]',
    );
  }

  function banner(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="chat-input-no-billing-source-banner"]',
    );
  }

  function getCreditsButton(): HTMLButtonElement | null {
    return container.querySelector(
      '[data-testid="chat-input-no-billing-source-get-credits"]',
    );
  }

  describe('no-dispatchable-model cause (CAN-1929)', () => {
    it('names the org policy — not a missing billing source — when only credit-routed models are allowed', async () => {
      // The user HAS a working native login. Saying "no billing source" would
      // send them to fix the one thing that is not broken.
      //
      // `lanesNeeded: ['ai-credits']` is what "only credit-routed models are
      // allowed" actually looks like: credits IS a way through, it is just not
      // available. See the pure-policy case below for the other shape.
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'policy-allowance',
            lanesNeeded: ['ai-credits'],
            policyRestricted: true,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).toContain(
        'Your organization only allows models',
      );
      expect(banner()?.textContent).not.toContain('Not signed in');
    });

    it('does not sell credits on a policy dead end that names no lane (round-2 finding 10)', async () => {
      // `missing: 'policy-allowance'` with an EMPTY `lanesNeeded` means no lane
      // — credits included — has a policy-allowed runnable model. Claiming the
      // org "only allows models that require AI Credits" and offering a Get AI
      // Credits CTA points the user at a purchase that cannot unblock them.
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'policy-allowance',
            policyRestricted: true,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).toContain(
        "Your organization's model policy doesn't allow any model you can run",
      );
      expect(banner()?.textContent).not.toContain(
        'Your organization only allows models',
      );
      expect(banner()?.textContent).toContain(
        'ask your organization admin to allow a model you can use.',
      );
      expect(getCreditsButton()).toBeNull();
      expect(signInButton()).toBeNull();
    });

    it('hides the sign-in CTA on a pure policy dead end', async () => {
      await render(
        'claude',
        { nativeAuth: false, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'policy-allowance',
            policyRestricted: true,
          },
        },
      );

      // Another login cannot unblock an allowlist, so offering one is a dead
      // end dressed up as a remedy.
      expect(signInButton()).toBeNull();
    });

    it('still offers sign-in when the missing half is the billing lane', async () => {
      await render(
        'claude',
        { nativeAuth: false, creditsEligible: false, loading: false },
        false,
        { noDispatchableModel: { missing: 'billing-lane' } },
      );

      expect(banner()).not.toBeNull();
      expect(signInButton()).not.toBeNull();
      expect(banner()?.textContent).not.toContain('your organization allows');
    });

    it('uses lanesNeeded to avoid offering an irrelevant native sign-in', async () => {
      await render(
        'claude',
        { nativeAuth: false, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'billing-lane',
            lanesNeeded: ['ai-credits'],
            policyRestricted: true,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(signInButton()).toBeNull();
      expect(banner()?.textContent).toContain(
        'Your organization only allows models that require',
      );
    });

    it('never invents an organization when no model policy is in force (CAN-2436)', async () => {
      // Identical lane shape to the case above — `lanesNeeded: ['ai-credits']`
      // — but reached WITHOUT an org allowlist: a gateway-only default model is
      // simply not runnable on either native lane, so those lanes drop out of
      // `lanesNeeded` on their own. Claiming an organization here is false, and
      // it displaced the copy that names the user's actual remedy.
      await render(
        'claude',
        { nativeAuth: false, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'billing-lane',
            lanesNeeded: ['ai-credits'],
            policyRestricted: false,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).not.toContain('Your organization');
      // The copy ECW-9091 shipped for every no-policy dispatch dead end (its
      // Electron flow asserts this sentence); the CTAs name the remedy.
      expect(banner()?.textContent).toContain(
        'No available model can be paid for right now.',
      );
    });

    it('does not suppress the credits CTA on a policy-shaped dead end with no policy (CAN-2436)', async () => {
      // `policyOnlyDeadEnd` sends the user to an org admin AND turns off every
      // credits affordance. Without a real allowlist behind it that strands a
      // user whose only route through is in fact buying credits.
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'policy-allowance',
            policyRestricted: false,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).not.toContain('Your organization');
      expect(banner()?.textContent).not.toContain(
        'ask your organization admin',
      );
      // The behavior in the name: with no allowlist behind the dead end the
      // credits CTA is the recovery action, so it must actually render.
      expect(getCreditsButton()).not.toBeNull();
    });

    it('routes a policy-backed `both` with no allowed lane to the org admin, not to billing (CAN-2436 review)', async () => {
      // The resolver reports `both` whenever nothing is confirmed available.
      // With an allowlist that leaves NO runnable candidate on any lane there
      // is no billing source that could help, so "your organization's allowed
      // models all need a billing source" is false and a credits CTA is a
      // spend prompt for nothing. `hasPolicyAllowedLane` is what tells this
      // state apart from the billing-shaped `both` below.
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'both',
            lanesNeeded: [],
            policyRestricted: true,
            hasPolicyAllowedLane: false,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).toContain(
        "Your organization's model policy doesn't allow any model you can run",
      );
      expect(banner()?.textContent).toContain('ask your organization admin');
      expect(banner()?.textContent).not.toContain('need a billing source');
      expect(getCreditsButton()).toBeNull();
    });

    it('keeps the billing copy for a policy-backed `both` when an allowed lane still exists (CAN-2436 review)', async () => {
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'both',
            lanesNeeded: [],
            policyRestricted: true,
            hasPolicyAllowedLane: true,
          },
        },
      );

      expect(banner()).not.toBeNull();
      expect(banner()?.textContent).toContain(
        'allowed models all need a billing source',
      );
      expect(banner()?.textContent).not.toContain(
        'ask your organization admin',
      );
    });

    it('renders even though the derived pre-flight condition is satisfied', async () => {
      // `derived` is false here (native auth is fine); the dead end comes
      // entirely from lane resolution, so it must not be gated on `derived`.
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: true, loading: false },
        false,
        { noDispatchableModel: { missing: 'both' } },
      );

      expect(banner()).not.toBeNull();
    });

    it('stays hidden when lane resolution found a dispatchable model', async () => {
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: true, loading: false },
        false,
        { noDispatchableModel: null },
      );

      expect(banner()).toBeNull();
    });
  });

  it('offers a purchase CTA and a sign-in action when nothing can pay', async () => {
    await render('claude');

    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain('Not signed in to Claude');
    expect(banner()?.textContent).toContain('no Canopy AI Credits');
    expect(getCreditsButton()?.textContent).toContain('Get AI Credits');
    expect(
      container.querySelector(
        '[data-testid="chat-input-no-billing-source-sign-in"]',
      )?.textContent,
    ).toContain('Sign in to Claude');
  });

  it('names the provider the tab is actually on', async () => {
    await render('codex');

    expect(banner()?.textContent).toContain('Not signed in to Codex');
    expect(banner()?.textContent).toContain('Sign in to Codex');
  });

  it('tells an org member with no headroom to contact their admin, with no purchase CTA', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: true }),
    );

    await render('claude');

    expect(
      container.querySelector(
        '[data-testid="chat-input-no-billing-source-contact-admin"]',
      )?.textContent,
    ).toContain('Contact your org admin');
    expect(getCreditsButton()).toBeNull();
  });

  it('hides when the provider has a native login', async () => {
    await render('claude', { nativeAuth: true });
    expect(banner()).toBeNull();
  });

  it('hides when AI Credits can pay', async () => {
    await render('claude', { creditsEligible: true });
    expect(banner()).toBeNull();
  });

  it('hides while availability is still resolving, so a slow probe never asserts a logout', async () => {
    await render('claude', { loading: true });
    expect(banner()).toBeNull();
    expect(loadNativeAiCreditsAvailability).not.toHaveBeenCalled();
  });

  it('hides for a local provider that is never billed', async () => {
    await render('ollama');
    expect(banner()).toBeNull();
  });

  // CAN-2311 review round 3. The exact stacking scenario: a member of ONE
  // lapsed org with no personal balance. The lapse zeroes the org credit pool
  // (`loadOrgAiCreditsSpendable` returns no coverage), so this banner's own
  // resolver reports `showPurchase` — and without the hand-off below the
  // composer would show "Get AI Credits" directly above "Contact your org admin
  // to restore your team", two different next actions for one dead end.
  it('stands down while the org-lapse banner is explaining the same dead end', async () => {
    // Availability as the main process reports it for a lapsed-org member:
    // in an org, but the pool is zeroed, so nothing here says "lapsed".
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: false }),
    );

    await render('claude', {}, true);

    // One coherent next action on screen: the lapse banner's "contact your org
    // admin", with no competing purchase CTA from this banner.
    expect(banner()).toBeNull();
    expect(getCreditsButton()).toBeNull();
  });

  it('takes over once the org-lapse banner is gone, so a dismissal is not a dead end', async () => {
    loadNativeAiCreditsAvailability.mockResolvedValue(
      native({ inOrg: true, orgCreditPoolCovered: false }),
    );

    await render('claude', {}, true);
    expect(banner()).toBeNull();

    // The user dismissed the explanation (or the org was restored). They still
    // cannot pay for the turn, so the self-serve remedies come back rather than
    // leaving the composer silent — the dead end ECW-9091 exists to remove.
    await render('claude', {}, false);

    expect(banner()).not.toBeNull();
    expect(getCreditsButton()).not.toBeNull();
  });

  // CAN-2413. The reported state: a user with a WORKING native Codex login on a
  // gateway-only model whose credits ran out mid-turn. The pre-flight condition
  // requires `!nativeAuth`, so it is false forever here — which is exactly why
  // the banner never appeared for the failure it exists to explain.
  describe('runtime no-billing-source signal', () => {
    const TARGET: ChatBannerTarget = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    };

    function flagRuntimeFailure(provider: AgentProviderType): void {
      useAiCreditsBannerStore.getState().setNoBillingSource(TARGET, {
        provider,
        detectedAt: 1,
      });
    }

    it('shows the banner for a chat whose turn already failed, even with a native login', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, { target: TARGET });

      expect(banner()).not.toBeNull();
      // Not "ran out": the hosted `billed === null` behind this 402 is equally
      // the state of a user who never had credits, and a brand-new user on a
      // gateway-only model is one of the likeliest to hit it.
      expect(banner()?.textContent).toContain("didn't cover that message");
      expect(banner()?.textContent).not.toContain('ran out');
      expect(getCreditsButton()).not.toBeNull();
    });

    it('names the queued Retry action after a credit refusal', async () => {
      flagRuntimeFailure('codex');
      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        queuedCreditHeld: true,
      });
      expect(banner()?.textContent).toContain('Add credits, then click Retry');
    });

    it('keeps an organization policy dead end ahead of queued credit copy', async () => {
      flagRuntimeFailure('codex');
      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        queuedCreditHeld: true,
        noDispatchableModel: {
          missing: 'policy-allowance',
          policyRestricted: true,
          hasPolicyAllowedLane: false,
        },
      });
      expect(banner()?.textContent).toContain('model policy');
      expect(banner()?.textContent).not.toContain(
        'Add credits, then click Retry',
      );
    });

    it('stays hidden with a native login when no runtime failure was recorded', async () => {
      await render('codex', { nativeAuth: true }, false, { target: TARGET });
      expect(banner()).toBeNull();
    });

    it('ignores a signal recorded against a different chat', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: { projectId: 'p2', worktreeId: 'w2', chatId: 'c2' },
      });

      expect(banner()).toBeNull();
    });

    it('hides the sign-in dead end for a gateway-only model', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      // A native Codex login cannot run a gateway-only model, so offering it
      // would send the user through auth and leave them exactly as stuck.
      expect(
        container.querySelector(
          '[data-testid="chat-input-no-billing-source-sign-in"]',
        ),
      ).toBeNull();
      expect(getCreditsButton()).not.toBeNull();
      expect(banner()?.textContent).not.toContain('Sign in to Codex');
    });

    it('keeps both remedies when the model has a native path the user has NOT used', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: false }, false, { target: TARGET });

      expect(signInButton()).not.toBeNull();
      expect(getCreditsButton()).not.toBeNull();
    });

    // The other half of the gateway-only rule (CAN-2413 review). "Sign in to
    // Codex" is a dead end for someone already signed in to Codex, for the same
    // reason it is a dead end on a model a native login cannot run.
    it('hides sign-in when the user is already authenticated natively', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, { target: TARGET });

      expect(signInButton()).toBeNull();
      expect(banner()?.textContent).not.toContain('Sign in to Codex');
      expect(getCreditsButton()).not.toBeNull();
    });

    // Regression: the banner must never render with zero recovery actions.
    // `resolveAiCreditsCoverage(null)` reports neither purchase nor
    // contact-admin, and `nativeAvailability` is null on the first render after
    // the banner appears AND permanently if the IPC rejects — which, combined
    // with a hidden sign-in button, used to leave the copy trailing off into an
    // empty string above an empty divider.
    it('always offers an action when the coverage read never resolves', async () => {
      loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      expect(banner()).not.toBeNull();
      expect(signInButton()).toBeNull();
      expect(getCreditsButton()).not.toBeNull();
      expect(banner()?.textContent).toContain("didn't cover that message");
    });

    // The fallback CTA must not be live during the in-flight coverage read.
    // `nativeAvailability` is null in that window, so an unguarded fallback let
    // an exhausted covered-org member click through to a billing flow they
    // cannot use, before the read that would have said "contact your admin"
    // came back — reintroducing the dead end through the fix for it.
    it('keeps the fallback CTA disabled until coverage resolves', async () => {
      let resolveRead: (value: NativeAiCreditsAvailability) => void = () => {};
      loadNativeAiCreditsAvailability.mockReturnValue(
        new Promise<NativeAiCreditsAvailability>((resolve) => {
          resolveRead = resolve;
        }),
      );
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      // Rendered (so the banner is never actionless) but not yet clickable.
      expect(getCreditsButton()).not.toBeNull();
      expect(getCreditsButton()?.disabled).toBe(true);

      await act(async () => {
        resolveRead(native({ inOrg: true, orgCreditPoolCovered: true }));
        await flushAsyncEffects();
      });

      // Coverage says contact-admin, so the purchase button is gone entirely.
      expect(getCreditsButton()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-no-billing-source-contact-admin"]',
        )?.textContent,
      ).toContain('Contact your org admin');
    });

    // Re-entry hole found in round 3: the settled flag latched true, so after a
    // FAILED first read the CTA was already enabled when a later visibility
    // cycle started a second read. If that read resolved to contact-admin, an
    // exhausted org member could click through to billing before it landed —
    // the same in-flight dead end, one cycle later.
    it('re-disables the fallback CTA when a later read starts', async () => {
      flagRuntimeFailure('codex');

      // First read fails, which legitimately enables the fallback.
      loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });
      expect(getCreditsButton()?.disabled).toBe(false);

      // Hide the banner (org-lapse takes over), then bring it back with a
      // second read still in flight.
      let resolveRead: (value: NativeAiCreditsAvailability) => void = () => {};
      loadNativeAiCreditsAvailability.mockReturnValue(
        new Promise<NativeAiCreditsAvailability>((resolve) => {
          resolveRead = resolve;
        }),
      );
      await render('codex', { nativeAuth: true }, true, {
        target: TARGET,
        gatewayOnlyModel: true,
      });
      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      // The stale "settled" state must not carry over into the new read.
      expect(getCreditsButton()?.disabled).toBe(true);

      await act(async () => {
        resolveRead(native({ inOrg: true, orgCreditPoolCovered: true }));
        await flushAsyncEffects();
      });

      expect(getCreditsButton()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-no-billing-source-contact-admin"]',
        )?.textContent,
      ).toContain('Contact your org admin');
    });

    // `canSpendCredits: true` carries `showPurchase: false` AND
    // `showContactAdmin: false` — the same flag shape as an inconclusive read.
    // Without an explicit check the fallback treats "you can pay now" as "we
    // could not tell" and sells credits to someone who just got them.
    it('does not offer a purchase once coverage is restored', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      expect(getCreditsButton()).toBeNull();
      expect(banner()?.textContent).toContain('Credits available again');
      expect(banner()?.textContent).not.toContain('Add credits');
    });

    it('does not offer a purchase when an org pool covers the user again', async () => {
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ inOrg: true, orgSpendable: true }),
      );
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      expect(getCreditsButton()).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="chat-input-no-billing-source-contact-admin"]',
        ),
      ).toBeNull();
    });

    it('enables the fallback CTA once an inconclusive read settles', async () => {
      loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      expect(getCreditsButton()).not.toBeNull();
      expect(getCreditsButton()?.disabled).toBe(false);
    });

    it('actually opens billing from the fallback CTA', async () => {
      // The fallback branch exists ONLY because the coverage read was
      // inconclusive, so a CTA that re-reads coverage and explains the failure
      // is guaranteed to dead-end here: the same IPC is still failing. This
      // branch exists so the banner is never actionless, which means the click
      // has to reach billing.
      loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      await act(async () => {
        getCreditsButton()?.click();
        await flushAsyncEffects();
      });

      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        BANNER_TOP_UP_PATH,
      );
    });

    it('re-reads its own coverage when the CTA finds the account covered', async () => {
      // The banner's read runs once per `visible` cycle. If the CTA's fresher
      // read concludes "covered" while this one said uncovered, the click is
      // otherwise fully silent: nothing opens, and the banner keeps showing
      // stale "no billing source" copy over an account that can now pay.
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: false }),
      );
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });

      expect(getCreditsButton()).not.toBeNull();

      // Credits appeared between the banner's read and the click.
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );

      await act(async () => {
        getCreditsButton()?.click();
        await flushAsyncEffects();
      });

      // Assert the banner's OWN state moved, not merely that the CTA issued a
      // read: the CTA always re-reads, so a call-count assertion would pass
      // even with a no-op `onCovered`.
      expect(banner()?.textContent).toContain('Credits available again');
      expect(getCreditsButton()).toBeNull();
    });

    // A user who reacts to this banner by switching the chat to Subscription
    // has already solved the problem: the next turn bills a native login.
    // `selectBillingFramework` does not clear the stored signal, so without
    // scoping, the banner kept demanding credits for a chat that no longer
    // needs them.
    it('stands down once the chat switches to subscription billing', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        effectiveBillingFramework: 'subscription',
      });

      expect(banner()).toBeNull();
    });

    it('still shows while the chat is on the AI Credits route', async () => {
      flagRuntimeFailure('codex');

      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        effectiveBillingFramework: 'ai-credits',
      });

      expect(banner()).not.toBeNull();
    });

    it('still stands down while the org-lapse banner is speaking', async () => {
      flagRuntimeFailure('claude');

      await render('claude', { nativeAuth: true }, true, { target: TARGET });

      expect(banner()).toBeNull();
    });
  });

  describe('browser hand-off (CAN-5162)', () => {
    const WAITING_COPY =
      'Finish checkout in your browser. Your credits show up here once the payment goes through.';
    const UNCOVERED_COPY =
      "No credits yet. If you've paid, they can take a minute to arrive.";
    const FAILED_COPY = "Couldn't check your balance. Try again in a moment.";
    const TARGET: ChatBannerTarget = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    };

    function flagRuntimeFailure(provider: AgentProviderType): void {
      useAiCreditsBannerStore.getState().setNoBillingSource(TARGET, {
        provider,
        detectedAt: 1,
      });
    }

    beforeEach(() => {
      jest.useFakeTimers({ now: Date.now() });
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    function query(testId: string): HTMLElement | null {
      return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    }
    function actionLabels(): Array<string | undefined> {
      return Array.from(
        banner()?.querySelectorAll<HTMLElement>(
          '[data-notice-actions] button',
        ) ?? [],
      ).map((button) => button.textContent?.trim());
    }
    async function press(testId: string, holdMs = 0): Promise<void> {
      const el = query(testId);
      if (!el) throw new Error(`${testId} not found`);
      await act(async () => {
        el.click();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(holdMs);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    }

    it('says the purchase is waiting in the browser, with every action a button', async () => {
      await render('claude');
      await press('chat-input-no-billing-source-get-credits');

      // The step replaces the dead end the user already acted on.
      expect(banner()?.textContent).toContain(WAITING_COPY);
      expect(banner()?.textContent).not.toContain('Not signed in to Claude');
      // Waiting on a purchase is not a warning.
      expect(banner()?.getAttribute('data-notice-intent')).toBe('neutral');
      // The buttons take their own row so the copy keeps the full width.
      expect(
        banner()?.querySelector('[data-notice-actions="below"]'),
      ).not.toBeNull();
      expect(actionLabels()).toEqual([
        'Sign in to Claude instead',
        'Reopen billing',
        'Check again',
      ]);
    });

    it('turns an uncovered check into the title, with Reopen billing', async () => {
      await render('claude');
      await press('chat-input-no-billing-source-get-credits');
      await press('chat-input-no-billing-source-get-credits-check-again', 500);

      expect(banner()?.textContent).toContain(UNCOVERED_COPY);
      expect(
        query('chat-input-no-billing-source-reopen-billing'),
      ).not.toBeNull();
      expect(signInButton()).not.toBeNull();
    });

    it('reopens billing and goes back to waiting', async () => {
      await render('claude');
      await press('chat-input-no-billing-source-get-credits');
      await press('chat-input-no-billing-source-get-credits-check-again', 500);
      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);

      await press('chat-input-no-billing-source-reopen-billing');

      expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(2);
      expect(banner()?.textContent).toContain(WAITING_COPY);
    });

    it('shows a failed check as a warning without Reopen billing', async () => {
      loadNativeAiCreditsAvailability.mockRejectedValue(new Error('offline'));
      flagRuntimeFailure('codex');
      await render('codex', { nativeAuth: true }, false, {
        target: TARGET,
        gatewayOnlyModel: true,
      });
      await press('chat-input-no-billing-source-get-credits');
      await press('chat-input-no-billing-source-get-credits-check-again', 500);

      expect(banner()?.textContent).toContain(FAILED_COPY);
      expect(banner()?.getAttribute('data-notice-intent')).toBe('attention');
      expect(query('chat-input-no-billing-source-reopen-billing')).toBeNull();
    });

    it('does not restore an old hand-off when the banner is hidden and shown again', async () => {
      await render('claude');
      await press('chat-input-no-billing-source-get-credits');
      await press('chat-input-no-billing-source-get-credits-check-again', 500);
      expect(banner()?.textContent).toContain(UNCOVERED_COPY);
      await render('claude', {}, true);
      expect(banner()).toBeNull();
      await render('claude');
      expect(banner()?.textContent).toContain('Not signed in to Claude');
      expect(banner()?.textContent).not.toContain(UNCOVERED_COPY);
      expect(getCreditsButton()).not.toBeNull();
    });

    it('ends the hand-off once coverage returns', async () => {
      await render('claude');
      await press('chat-input-no-billing-source-get-credits');
      await press('chat-input-no-billing-source-get-credits-check-again', 500);
      expect(banner()?.textContent).toContain(UNCOVERED_COPY);

      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await press('chat-input-no-billing-source-get-credits-check-again');

      expect(banner()?.textContent).not.toContain(UNCOVERED_COPY);
      expect(getCreditsButton()).toBeNull();
      expect(banner()?.textContent).toContain('Credits available again');
    });
  });

  describe('arrival confirmation (CAN-5160)', () => {
    const TARGET: ChatBannerTarget = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    };
    const ARRIVAL = 'chat-input-no-billing-source-arrival';

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
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));
      loadCanopyCloudAiCredits.mockResolvedValue(balance(0));
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
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
    async function press(testId: string, focus = false): Promise<void> {
      const el = query(testId);
      if (!el) throw new Error(`${testId} not found`);
      if (focus) el.focus();
      await act(async () => {
        el.click();
        for (let i = 0; i < 30; i += 1) await Promise.resolve();
      });
    }
    async function renderTarget(
      overrides: Partial<ProviderModelAvailability> = {},
      options: {
        orgLapseVisible?: boolean;
        turnActive?: boolean;
        effectiveBillingFramework?: 'subscription' | 'ai-credits' | null;
        aiCreditsCardVisible?: boolean;
        aiCreditsCardExpected?: boolean;
      } = {},
    ): Promise<void> {
      await render('claude', overrides, options.orgLapseVisible ?? false, {
        target: TARGET,
        ...(options.turnActive !== undefined
          ? { turnActive: options.turnActive }
          : {}),
        ...(options.aiCreditsCardVisible !== undefined
          ? { aiCreditsCardVisible: options.aiCreditsCardVisible }
          : {}),
        ...(options.aiCreditsCardExpected !== undefined
          ? { aiCreditsCardExpected: options.aiCreditsCardExpected }
          : {}),
        ...(options.effectiveBillingFramework !== undefined
          ? { effectiveBillingFramework: options.effectiveBillingFramework }
          : {}),
      });
    }

    /**
     * 0 credits at Get AI Credits, 16 once the user comes back covered. With
     * no native login and no credits the composer resolves to a locked
     * 'subscription', and still does when the record lands.
     */
    async function buyAndReturn({
      via = 'check-again',
      balanceFails = false,
      focusCheckAgain = false,
    }: {
      via?: 'check-again' | 'focus';
      balanceFails?: boolean;
      focusCheckAgain?: boolean;
    } = {}): Promise<void> {
      await renderTarget({}, { effectiveBillingFramework: 'subscription' });
      await settle();
      await press('chat-input-no-billing-source-get-credits');
      await settle();
      expect(
        query('chat-input-no-billing-source-get-credits-check-again'),
      ).not.toBeNull();
      if (balanceFails)
        loadCanopyCloudAiCredits.mockRejectedValue(
          new Error('balance unavailable'),
        );
      else loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      if (via === 'focus') {
        // Past the shared re-probe throttle that the click's read started.
        await settle(60_000);
        await act(async () => {
          window.dispatchEvent(new Event('focus'));
          for (let i = 0; i < 30; i += 1) await Promise.resolve();
        });
      } else {
        await press(
          'chat-input-no-billing-source-get-credits-check-again',
          focusCheckAgain,
        );
      }
      await settle();
    }

    it('confirms the credits in one positive status that outlives the banner', async () => {
      await buyAndReturn();

      const notice = query(ARRIVAL);
      expect(notice?.getAttribute('data-notice-intent')).toBe('positive');
      expect(notice?.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(notice?.textContent).toContain('16 AI Credits added.');
      expect(notice?.textContent).toContain('You can send it now.');
      expect(banner()).toBeNull();

      // The announcement flips eligibility and the dead end is over.
      await renderTarget({ creditsEligible: true });
      await settle();
      expect(query(ARRIVAL)?.textContent).toContain('16 AI Credits added.');
      expect(banner()).toBeNull();
    });

    it('hands the record to the Using AI Credits card instead of stacking a second notice', async () => {
      await buyAndReturn();
      expect(query(ARRIVAL)).not.toBeNull();

      // The card takes the slot once the chat bills to credits.
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'ai-credits', aiCreditsCardVisible: true },
      );
      expect(query(ARRIVAL)).toBeNull();
      expect(container.innerHTML).toBe('');
      const state = useAiCreditsArrivalStore.getState();
      expect(state.arrival?.origin).toBe('no-billing-source');
      expect(state.routed).toBe(true);

      // The card owns it from here: hiding the card does not revive the
      // notice.
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'ai-credits' },
      );
      expect(query(ARRIVAL)).toBeNull();
    });

    it('never shows the notice when the card is already up as the credits land', async () => {
      await renderTarget(
        {},
        {
          effectiveBillingFramework: 'subscription',
          aiCreditsCardVisible: true,
        },
      );
      await settle();
      await press('chat-input-no-billing-source-get-credits');
      await settle();
      loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await press('chat-input-no-billing-source-get-credits-check-again');
      await settle();
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().routed).toBe(true);
    });

    it('holds the record for an expected card instead of flashing the notice first', async () => {
      // The composer's eligibility read lags the CTA's: the card has not
      // taken the slot yet, but will once the chat can spend credits.
      await renderTarget(
        {},
        {
          effectiveBillingFramework: 'subscription',
          aiCreditsCardExpected: true,
        },
      );
      await settle();
      await press('chat-input-no-billing-source-get-credits');
      await settle();
      loadCanopyCloudAiCredits.mockResolvedValue(balance(16));
      loadNativeAiCreditsAvailability.mockResolvedValue(
        native({ personalEligible: true }),
      );
      await press('chat-input-no-billing-source-get-credits-check-again');
      await settle();
      expect(query(ARRIVAL)).toBeNull();
      // Nor the dead end the purchase just ended.
      expect(banner()).toBeNull();
      expect(useAiCreditsArrivalStore.getState().routed).toBe(false);

      await renderTarget(
        { creditsEligible: true },
        {
          effectiveBillingFramework: 'ai-credits',
          aiCreditsCardVisible: true,
          aiCreditsCardExpected: true,
        },
      );
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().routed).toBe(true);
    });

    it('moves focus from the pressed Check again to the notice once', async () => {
      await buyAndReturn({ focusCheckAgain: true });
      expect(document.activeElement).toBe(query(ARRIVAL));

      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      composer.focus();
      await renderTarget({ creditsEligible: true });
      await settle();
      expect(query(ARRIVAL)).not.toBeNull();
      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    it('records nothing while Check again still finds no coverage', async () => {
      await renderTarget();
      await settle();
      await press('chat-input-no-billing-source-get-credits');
      await settle();
      await press('chat-input-no-billing-source-get-credits-check-again');
      await settle(500);
      expect(query(ARRIVAL)).toBeNull();
      expect(banner()).not.toBeNull();
      expect(
        query('chat-input-no-billing-source-get-credits-check-again'),
      ).not.toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('confirms a covered return through window focus', async () => {
      await buyAndReturn({ via: 'focus' });
      expect(query(ARRIVAL)?.textContent).toContain('You can send it now.');
      expect(banner()).toBeNull();
    });

    it('falls back to the generic title when the balance cannot be read', async () => {
      await buyAndReturn({ balanceFails: true });
      await settle(5_000);
      const notice = query(ARRIVAL);
      expect(notice?.textContent).toContain(
        'AI Credits are available for this chat.',
      );
      expect(notice?.textContent).not.toContain('16');
      expect(notice?.textContent).toContain('You can send it now.');
    });

    it('clears the record on dismissal', async () => {
      await buyAndReturn();
      await press('chat-input-no-billing-source-arrival-dismiss');
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('clears when the next turn starts, not for a turn already running at mount', async () => {
      await buyAndReturn();
      expect(query(ARRIVAL)).not.toBeNull();
      await renderTarget({ creditsEligible: true }, { turnActive: true });
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('waits for the next turn when it mounts during one', async () => {
      await buyAndReturn();
      act(() => root.unmount());
      root = createRoot(container);
      await renderTarget({ creditsEligible: true }, { turnActive: true });
      await renderTarget({ creditsEligible: true }, { turnActive: true });
      expect(query(ARRIVAL)).not.toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
    });

    it('clears when the chat switches from credits to Subscription', async () => {
      await buyAndReturn();
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'ai-credits' },
      );
      expect(query(ARRIVAL)).not.toBeNull();
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'subscription' },
      );
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    });

    it('does not read a chat switch as a switch to Subscription', async () => {
      await buyAndReturn();
      // The composer keeps this banner mounted across chats: another chat
      // billed to credits, then back to this one, still on its own value.
      await render('claude', { creditsEligible: true }, false, {
        target: { ...TARGET, chatId: 'other' },
        effectiveBillingFramework: 'ai-credits',
      });
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'subscription' },
      );
      expect(query(ARRIVAL)).not.toBeNull();
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
    });

    it('never shows a usage-limit record for the same chat', async () => {
      await act(async () => {
        const handoff = beginAiCreditsArrivalHandoff(
          { kind: 'work', projectId: 'p', worktreeId: 'w', chatId: 'c' },
          'usage-limit',
        );
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        handoff?.markExternalOpen();
        handoff?.retain();
        expect(handoff?.recordCovered()).toBe(true);
      });
      await renderTarget({ creditsEligible: true });
      expect(query(ARRIVAL)).toBeNull();
      expect(container.innerHTML).toBe('');
    });

    it('confirms credits bought from the model picker, which has no notice of its own', async () => {
      async function recordFromPicker(): Promise<void> {
        await act(async () => {
          const handoff = beginAiCreditsArrivalHandoff(
            { kind: 'work', projectId: 'p', worktreeId: 'w', chatId: 'c' },
            'model-picker',
          );
          for (let i = 0; i < 10; i += 1) await Promise.resolve();
          handoff?.markExternalOpen();
          handoff?.retain();
          expect(handoff?.recordCovered()).toBe(true);
        });
      }
      // No card for this chat (a credits-only model): the notice confirms it.
      await recordFromPicker();
      await renderTarget({ creditsEligible: true });
      expect(query(ARRIVAL)?.textContent).toContain('You can send it now.');

      // With the card up, the card confirms it instead.
      resetAiCreditsArrivalForTests();
      await recordFromPicker();
      await renderTarget(
        { creditsEligible: true },
        { effectiveBillingFramework: 'ai-credits', aiCreditsCardVisible: true },
      );
      expect(query(ARRIVAL)).toBeNull();
      expect(useAiCreditsArrivalStore.getState().routed).toBe(true);
    });

    it('defers to the org-lapse banner without dropping the record', async () => {
      await buyAndReturn();
      await renderTarget({}, { orgLapseVisible: true });
      expect(container.innerHTML).toBe('');
      expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
      await renderTarget({ creditsEligible: true });
      expect(query(ARRIVAL)).not.toBeNull();
    });

    it('records no recovery view while the arrival shows', async () => {
      await buyAndReturn();
      const views = mockTrackCreditsRecoveryView.mock.calls.length;
      await renderTarget();
      await settle();
      expect(query(ARRIVAL)).not.toBeNull();
      expect(mockTrackCreditsRecoveryView).toHaveBeenCalledTimes(views);
    });
  });

  it('opens billing immediately for a connected non-guest account', async () => {
    loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
    expect(useCloudConnectGateStore.getState().pending).toBeNull();
  });

  it('opens the browser top-up, not Settings, even when hosted settings are openable (CAN-5159)', async () => {
    mockHostedSettingsOpenable.mockReturnValue(true);
    loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth_desktop'));

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    const [path] = openAuthenticatedPortalPage.mock.calls[0];
    const opened = new URL(path, 'https://billing.invalid');
    expect(opened.pathname).toBe('/account/billing');
    expect(opened.searchParams.get('topUp')).toBe('1');
    expect(opened.searchParams.get('reason')).toBe('credits');
    expect(opened.searchParams.get('source')).toBe('banner');
    expect(openAccountOrganizationSettings).not.toHaveBeenCalled();
    // The purchase stays tracked in the chat instead of being lost in
    // Settings.
    expect(
      container.querySelector(
        '[data-testid="chat-input-no-billing-source-get-credits-check-again"]',
      ),
    ).not.toBeNull();
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

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    expect(
      container.querySelector(
        '[data-testid="chat-input-no-billing-source-get-credits-spinner"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      resolveAccount?.(cloudAccount('oauth_desktop'));
      await flushAsyncEffects();
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
  });

  it('routes a guest account through the shared connect gate before billing', async () => {
    loadCanopyCloudAccount.mockResolvedValue(cloudAccount('guest'));

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    // Modal first — a guest is "technically connected" but cannot buy credits.
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    const pending = useCloudConnectGateStore.getState().pending;
    expect(pending).not.toBeNull();

    // ...and the deferred hand-off still runs once they connect.
    await act(async () => {
      pending?.proceed();
      await flushAsyncEffects();
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      BANNER_TOP_UP_PATH,
    );
  });

  it('routes a signed-out user through the connect gate too', async () => {
    loadCanopyCloudAccount.mockResolvedValue(null);

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(useCloudConnectGateStore.getState().pending).not.toBeNull();
  });

  it('opens the provider login modal from the sign-in action', async () => {
    await render('claude');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-no-billing-source-sign-in"]',
        )
        ?.click();
      await flushAsyncEffects();
    });

    expect(
      container.querySelector('[data-testid="auth-login-modal-stub"]'),
    ).not.toBeNull();
  });

  it('keeps the login modal mounted while the auth probe re-runs', async () => {
    // The modal's own mount force-refreshes the provider auth probe, which
    // flips `availability.loading` true. The banner hides during the probe,
    // but it must NOT unmount the modal it hosts — that produced an infinite
    // open → refresh → hide → remount blink loop.
    await render('claude');
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="chat-input-no-billing-source-sign-in"]',
        )
        ?.click();
      await flushAsyncEffects();
    });
    expect(
      container.querySelector('[data-testid="auth-login-modal-stub"]'),
    ).not.toBeNull();

    // Probe in flight: banner hides, modal survives.
    await render('claude', { loading: true });
    expect(banner()).toBeNull();
    expect(
      container.querySelector('[data-testid="auth-login-modal-stub"]'),
    ).not.toBeNull();

    // Probe settles still signed out: banner returns, modal still up.
    await render('claude', { loading: false });
    expect(banner()).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auth-login-modal-stub"]'),
    ).not.toBeNull();
  });
  describe('credits recovery telemetry (CAN-4633)', () => {
    const TARGET: ChatBannerTarget = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    };

    it('records a pre-flight view keyed to the chat', async () => {
      await render('claude', {}, false, { target: TARGET });

      expect(mockTrackCreditsRecoveryView).toHaveBeenCalledTimes(1);
      expect(mockTrackCreditsRecoveryView).toHaveBeenCalledWith({
        surface: 'chat_banner',
        trigger: 'preflight',
        dedupeKey: 'p/w/c',
      });
    });

    it('records a failed-turn view from the runtime signal', async () => {
      useAiCreditsBannerStore.getState().setNoBillingSource(TARGET, {
        provider: 'codex',
        detectedAt: 1,
      });

      await render('codex', { nativeAuth: true }, false, { target: TARGET });

      expect(mockTrackCreditsRecoveryView).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'failed_turn' }),
      );
    });

    it('records a no-dispatchable-model view', async () => {
      await render('claude', { nativeAuth: true }, false, {
        noDispatchableModel: { missing: 'billing-lane' },
      });

      expect(mockTrackCreditsRecoveryView).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: 'no_dispatchable_model' }),
      );
    });

    it('records nothing for a pure org-policy dead end or a hidden banner', async () => {
      await render(
        'claude',
        { nativeAuth: true, creditsEligible: false, loading: false },
        false,
        {
          noDispatchableModel: {
            missing: 'policy-allowance',
            policyRestricted: true,
          },
        },
      );
      await render('claude', { loading: true });

      expect(mockTrackCreditsRecoveryView).not.toHaveBeenCalled();
    });

    it('records the sign-in and Get AI Credits clicks', async () => {
      await render('claude');

      await act(async () => {
        signInButton()?.click();
        await flushAsyncEffects();
      });
      await act(async () => {
        getCreditsButton()?.click();
        await flushAsyncEffects();
      });

      expect(mockTrackCreditsRecoveryClick.mock.calls).toEqual([
        [{ surface: 'chat_banner', action: 'provider_sign_in' }],
        [{ surface: 'chat_banner', action: 'credits_purchase' }],
      ]);
    });
  });
});
