import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import {
  resolveChatBillingFramework,
  type ResolveChatBillingInput,
} from '../chatBillingFramework';

// Mock the gateway capability helpers so the matrix is deterministic and does
// not depend on the live gateway registry contents. Tests drive model
// capability by the ids below.
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isGatewayRoutableModel: (model: string | undefined): boolean =>
    model === 'both-capable' ||
    model === 'gateway-only' ||
    model === 'org-gateway',
  isGatewayOnlyModel: (model: string | undefined): boolean =>
    model === 'gateway-only' || model === 'org-gateway',
  resolveGatewayModelEntry: (model: string | undefined): unknown =>
    model === 'org-gateway' ? { origin: 'org-gateway' } : undefined,
}));

const availability = (
  overrides: Partial<ProviderModelAvailability> = {},
): ProviderModelAvailability => ({
  selectable: true,
  nativeAuth: true,
  creditsEligible: true,
  loading: false,
  ...overrides,
});

const baseInput = (
  overrides: Partial<ResolveChatBillingInput> = {},
): ResolveChatBillingInput => ({
  model: 'both-capable',
  provider: 'claude',
  availability: availability(),
  aiCreditsRoutingActive: false,
  subscriptionBillingOverride: false,
  routingActiveForChat: false,
  ...overrides,
});

describe('resolveChatBillingFramework', () => {
  it('hides hosted billing choices when an organization gateway is enforced', () => {
    expect(
      resolveChatBillingFramework({
        model: 'sonnet',
        provider: 'claude',
        availability: availability({ nativeAuth: true, creditsEligible: true }),
        aiCreditsRoutingActive: false,
        subscriptionBillingOverride: false,
        routingActiveForChat: false,
        modelGatewayEnforced: true,
      }),
    ).toEqual({
      framework: null,
      toggleVisible: false,
      toggleDisabled: false,
      aiCreditsBannerVisible: false,
    });
  });

  describe('hidden cases (no billing concept)', () => {
    it('hides when there is no model', () => {
      const result = resolveChatBillingFramework(
        baseInput({ model: undefined }),
      );
      expect(result).toEqual({
        framework: null,
        toggleVisible: false,
        toggleDisabled: false,
        aiCreditsBannerVisible: false,
      });
    });

    it('hides for the ollama provider', () => {
      const result = resolveChatBillingFramework(
        baseInput({ provider: 'ollama' }),
      );
      expect(result.framework).toBeNull();
      expect(result.toggleVisible).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('hides when availability is missing', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: undefined }),
      );
      expect(result.toggleVisible).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('keeps an explicit subscription choice reachable while availability is loading', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({ loading: true, nativeAuth: false }),
          subscriptionBillingOverride: true,
          routingActiveForChat: true,
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('keeps native-only subscription selection visible without a confirmed login', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'native-only',
          availability: availability({
            nativeAuth: false,
            creditsEligible: false,
          }),
        }),
      );
      expect(result.toggleVisible).toBe(true);
      expect(result.framework).toBe('subscription');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockedReason).not.toContain('bills to your subscription');
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('does not drop a subscription choice when credits and auth are both unresolved', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({
            nativeAuth: false,
            creditsEligible: false,
            loading: true,
          }),
          subscriptionBillingOverride: true,
          routingActiveForChat: true,
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleVisible).toBe(true);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('does not silently select credits for an inconclusive auth probe', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({ loading: true, nativeAuth: false }),
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
    });

    it('hides hosted billing controls for an organization gateway model', () => {
      expect(
        resolveChatBillingFramework(
          baseInput({
            model: 'org-gateway',
            availability: availability({
              nativeAuth: true,
              creditsEligible: true,
            }),
            routingActiveForChat: true,
          }),
        ),
      ).toEqual({
        framework: null,
        toggleVisible: false,
        toggleDisabled: false,
        aiCreditsBannerVisible: false,
      });
    });
  });

  describe('locked ON (only AI Credits available)', () => {
    it('locks a gateway-only model ON with the gateway-only reason and lockKind', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'gateway-only',
          subscriptionBillingOverride: true,
        }),
      );
      expect(result).toEqual({
        framework: 'ai-credits',
        toggleVisible: true,
        toggleDisabled: true,
        lockKind: 'gateway-only-model',
        lockedReason: 'This model is only available with AI Credits',
        aiCreditsBannerVisible: true,
      });
    });

    it('hides the banner for a gateway-only model when there is no native login', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'gateway-only',
          availability: availability({ nativeAuth: false }),
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.lockKind).toBe('gateway-only-model');
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('does not create a native route for gateway-only models with conflicting stored choices', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'gateway-only',
          availability: availability({ creditsEligible: false }),
          aiCreditsRoutingActive: true,
          subscriptionBillingOverride: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.lockKind).toBe('gateway-only-model');
      expect(result.toggleDisabled).toBe(true);
    });

    it('allows a native subscription attempt despite a negative auth probe', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'both-capable',
          availability: availability({ nativeAuth: false }),
          subscriptionBillingOverride: true,
          routingActiveForChat: true,
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('keeps Codex subscription selectable while its auth probe is inconclusive', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'both-capable',
          provider: 'codex',
          availability: availability({
            nativeAuth: false,
            nativeAuthInconclusive: true,
          }),
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
    });
  });

  describe('confirmed sign-out with usable credits (CAN-5349)', () => {
    const signedOut = (
      overrides: Partial<ProviderModelAvailability> = {},
    ): ProviderModelAvailability =>
      availability({
        nativeAuth: false,
        nativeAuthInconclusive: false,
        ...overrides,
      });

    it('locks Claude to AI Credits with the provider sign-in remedy', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: signedOut() }),
      );
      expect(result).toEqual({
        framework: 'ai-credits',
        toggleVisible: true,
        toggleDisabled: true,
        lockKind: 'no-native-login',
        lockedReason:
          "You're not signed in to Claude, so this chat bills to your AI Credits. Sign in to bill your subscription.",
        aiCreditsBannerVisible: true,
      });
    });

    it('names Codex when the Codex probe confirms sign-out', () => {
      const result = resolveChatBillingFramework(
        baseInput({ provider: 'codex', availability: signedOut() }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-native-login');
      expect(result.lockedReason).toBe(
        "You're not signed in to Codex, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      );
    });

    it('locks an explicit credits preference instead of offering a switch', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: signedOut(), aiCreditsRoutingActive: true }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-native-login');
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('locks a chat routed by the live main-process bit', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: signedOut(), routingActiveForChat: true }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-native-login');
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('keeps the lock while only the credits balance is refreshing', () => {
      // Aggregate `loading` rises with the balance read; the settled auth
      // answer must still win over the legacy `loading` fallback.
      const result = resolveChatBillingFramework(
        baseInput({
          availability: signedOut({ loading: true, creditsLoading: true }),
          routingActiveForChat: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-native-login');
    });

    it('falls back to aggregate loading when availability predates the auth field', () => {
      const settled = resolveChatBillingFramework(
        baseInput({ availability: availability({ nativeAuth: false }) }),
      );
      expect(settled.lockKind).toBe('no-native-login');
      expect(settled.toggleDisabled).toBe(true);

      const unresolved = resolveChatBillingFramework(
        baseInput({
          availability: availability({ nativeAuth: false, loading: true }),
        }),
      );
      expect(unresolved.framework).toBe('subscription');
      expect(unresolved.toggleDisabled).toBe(false);
    });

    it('keeps existing credits routing selectable while auth is inconclusive', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({
            nativeAuth: false,
            nativeAuthInconclusive: true,
          }),
          aiCreditsRoutingActive: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(false);
      expect(result.lockKind).toBeUndefined();
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('honors an existing subscription override, then locks once the user picks credits', () => {
      const preserved = resolveChatBillingFramework(
        baseInput({
          availability: signedOut(),
          subscriptionBillingOverride: true,
        }),
      );
      expect(preserved.framework).toBe('subscription');
      expect(preserved.toggleDisabled).toBe(false);
      expect(preserved.aiCreditsBannerVisible).toBe(false);

      const afterChoosingCredits = resolveChatBillingFramework(
        baseInput({
          availability: signedOut(),
          subscriptionBillingOverride: false,
          aiCreditsRoutingActive: true,
        }),
      );
      expect(afterChoosingCredits.framework).toBe('ai-credits');
      expect(afterChoosingCredits.toggleDisabled).toBe(true);
      expect(afterChoosingCredits.lockKind).toBe('no-native-login');
    });

    it('follows auth from loading to signed out to signed in', () => {
      const resolve = (
        next: Partial<ProviderModelAvailability>,
      ): ReturnType<typeof resolveChatBillingFramework> =>
        resolveChatBillingFramework(
          baseInput({
            availability: availability(next),
            routingActiveForChat: true,
          }),
        );

      const loading = resolve({
        nativeAuth: false,
        loading: true,
        nativeAuthInconclusive: true,
      });
      expect(loading.toggleDisabled).toBe(false);

      const signedOutResult = resolve({
        nativeAuth: false,
        nativeAuthInconclusive: false,
      });
      expect(signedOutResult.lockKind).toBe('no-native-login');

      const signedIn = resolve({
        nativeAuth: true,
        nativeAuthInconclusive: false,
      });
      expect(signedIn.framework).toBe('ai-credits');
      expect(signedIn.toggleDisabled).toBe(false);
      expect(signedIn.lockKind).toBeUndefined();
    });

    it('does not carry sign-in from one provider to another', () => {
      // Callers pass the selected provider's own availability; switching from
      // a signed-in Claude chat to a signed-out Codex model locks Codex.
      const claude = resolveChatBillingFramework(
        baseInput({
          provider: 'claude',
          availability: availability({ nativeAuthInconclusive: false }),
        }),
      );
      expect(claude.toggleDisabled).toBe(false);

      const codex = resolveChatBillingFramework(
        baseInput({ provider: 'codex', availability: signedOut() }),
      );
      expect(codex.toggleDisabled).toBe(true);
      expect(codex.lockedReason).toContain('Codex');
    });

    it('leaves a gateway-only model on its own lock', () => {
      const result = resolveChatBillingFramework(
        baseInput({ model: 'gateway-only', availability: signedOut() }),
      );
      expect(result.lockKind).toBe('gateway-only-model');
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('leaves the no-credits subscription attempt unchanged', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: signedOut({ creditsEligible: false }) }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.lockKind).toBe('no-credits');
      expect(result.lockedReason).toBe(
        'No AI Credits available. This chat will try your subscription.',
      );
    });

    it('leaves a non-routable model on its native-only lock', () => {
      const result = resolveChatBillingFramework(
        baseInput({ model: 'native-only', availability: signedOut() }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.lockKind).toBe('model-not-routable');
    });
  });

  describe('locked OFF (only subscription available)', () => {
    it('locks a native-only model OFF with the non-routable reason', () => {
      const result = resolveChatBillingFramework(
        baseInput({ model: 'native-only' }),
      );
      expect(result).toEqual({
        framework: 'subscription',
        toggleVisible: true,
        toggleDisabled: true,
        lockKind: 'model-not-routable',
        lockedReason: "This model can't bill to AI Credits",
        aiCreditsBannerVisible: false,
      });
    });

    it('locks a both-capable model OFF when there are no credits', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'both-capable',
          availability: availability({ creditsEligible: false }),
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-credits');
      expect(result.lockedReason).toBe(
        'No AI Credits available, so this chat bills to your subscription',
      );
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('does not claim an unverified subscription will successfully bill', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({
            nativeAuth: false,
            creditsEligible: false,
          }),
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockedReason).toBe(
        'No AI Credits available. This chat will try your subscription.',
      );
    });
  });

  describe('interactive (both frameworks available)', () => {
    it('retains an active credits route even when its balance is exhausted', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({ creditsEligible: false }),
          aiCreditsRoutingActive: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('keeps the routing-card escape available while native auth is still loading', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({ nativeAuth: false, loading: true }),
          aiCreditsRoutingActive: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleVisible).toBe(true);
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('does not erase explicit credits routing during an inconclusive balance read', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          availability: availability({
            nativeAuth: false,
            creditsEligible: false,
            loading: true,
            creditsLoading: true,
          }),
          aiCreditsRoutingActive: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleVisible).toBe(true);
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('is interactive and defaults to subscription with no stored preference', () => {
      const result = resolveChatBillingFramework(baseInput());
      expect(result).toEqual({
        framework: 'subscription',
        toggleVisible: true,
        toggleDisabled: false,
        aiCreditsBannerVisible: false,
      });
      expect(result.lockedReason).toBeUndefined();
    });

    it('prefers the explicit AI Credits per-tab preference', () => {
      const result = resolveChatBillingFramework(
        baseInput({ aiCreditsRoutingActive: true }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('prefers an explicit subscription override over the live routing bit', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          subscriptionBillingOverride: true,
          routingActiveForChat: true,
        }),
      );
      expect(result.framework).toBe('subscription');
    });

    it('falls back to the live routing bit when there is no stored preference', () => {
      const result = resolveChatBillingFramework(
        baseInput({ routingActiveForChat: true }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(true);
    });

    it('lets an explicit subscription override win over stale credits routing', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          aiCreditsRoutingActive: true,
          subscriptionBillingOverride: true,
        }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('returns to subscription when stored session routing is no longer in effect', () => {
      // ChatInput passes `useEffectiveAiCreditsRouting`'s verdict, not the
      // stored `active` bit, so stale "just this time" routing hides the card
      // before the clear round-trips (CAN-4200).
      const result = resolveChatBillingFramework(
        baseInput({ aiCreditsRoutingActive: false }),
      );
      expect(result.framework).toBe('subscription');
      expect(result.aiCreditsBannerVisible).toBe(false);
    });
  });
});
