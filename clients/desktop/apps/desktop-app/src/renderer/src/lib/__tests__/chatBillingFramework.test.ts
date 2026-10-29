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

    it('hides while availability is loading', () => {
      const result = resolveChatBillingFramework(
        baseInput({ availability: availability({ loading: true }) }),
      );
      expect(result.toggleVisible).toBe(false);
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('hides when neither framework is available', () => {
      // Native-only model + no native login => nothing can bill it.
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'native-only',
          availability: availability({
            nativeAuth: false,
            creditsEligible: false,
          }),
        }),
      );
      expect(result.toggleVisible).toBe(false);
      expect(result.framework).toBeNull();
      expect(result.aiCreditsBannerVisible).toBe(false);
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
        baseInput({ model: 'gateway-only' }),
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

    it('locks a both-capable model ON with the no-native-login lockKind + CTA copy', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'both-capable',
          availability: availability({ nativeAuth: false }),
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.toggleDisabled).toBe(true);
      expect(result.lockKind).toBe('no-native-login');
      expect(result.lockedReason).toBe(
        "You're not signed in to Claude, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      );
      // Credits-only account: the banner is not actionable, so it stays hidden.
      expect(result.aiCreditsBannerVisible).toBe(false);
    });

    it('names the correct provider in the no-native-login copy for Codex', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          model: 'both-capable',
          provider: 'codex',
          availability: availability({ nativeAuth: false }),
        }),
      );
      expect(result.lockKind).toBe('no-native-login');
      expect(result.lockedReason).toBe(
        "You're not signed in to Codex, so this chat bills to your AI Credits. Sign in to bill your subscription.",
      );
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
  });

  describe('interactive (both frameworks available)', () => {
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

    it('lets the explicit AI Credits preference win over a subscription override', () => {
      const result = resolveChatBillingFramework(
        baseInput({
          aiCreditsRoutingActive: true,
          subscriptionBillingOverride: true,
        }),
      );
      expect(result.framework).toBe('ai-credits');
      expect(result.aiCreditsBannerVisible).toBe(true);
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
