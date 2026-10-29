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
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import { NoBillingSourceBanner } from '../NoBillingSourceBanner';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import {
  useAiCreditsBannerStore,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';

// The login modal pulls the full settings auth stack; the banner only needs to
// know it mounts, so stub it.
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): JSX.Element => (
    <div data-testid="auth-login-modal-stub" />
  ),
}));

const PRICING_URL = 'https://cloud.example.com/pricing';

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
    loadNativeAiCreditsAvailability.mockReset();
    loadCanopyCloudAccount.mockReset();
    openExternal.mockReset();
    openAuthenticatedPortalPage.mockReset();

    loadNativeAiCreditsAvailability.mockResolvedValue(native());
    loadCanopyCloudAccount.mockResolvedValue(null);
    openExternal.mockResolvedValue(undefined);
    openAuthenticatedPortalPage.mockResolvedValue(true);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadNativeAiCreditsAvailability,
        loadCanopyCloudAccount,
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
    } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <NoBillingSourceBanner
          provider={provider}
          availability={availability(overrides)}
          orgLapseVisible={orgLapseVisible}
          target={options.target ?? null}
          gatewayOnlyModel={options.gatewayOnlyModel ?? false}
          effectiveBillingFramework={options.effectiveBillingFramework ?? null}
          noDispatchableModel={options.noDispatchableModel ?? null}
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
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth'));
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
        '/account/billing',
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
      loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth'));
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

  it('opens billing immediately for a connected non-guest account', async () => {
    loadCanopyCloudAccount.mockResolvedValue(cloudAccount('oauth'));

    await render('claude');
    await act(async () => {
      getCreditsButton()?.click();
      await flushAsyncEffects();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
    );
    expect(useCloudConnectGateStore.getState().pending).toBeNull();
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
      resolveAccount?.(cloudAccount('oauth'));
      await flushAsyncEffects();
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
      '/account/billing',
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
      '/account/billing',
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
});
