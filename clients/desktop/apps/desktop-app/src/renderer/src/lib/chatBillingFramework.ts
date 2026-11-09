// Pure resolver for the per-chat billing framework (subscription vs AI Credits).
//
// Both the model picker's "Bill to AI Credits" toggle and the AI Credits status
// banner consume this single function so they can never disagree. It combines
// three inputs into one decision:
//
//   1. the selected model's capability (can it route through the gateway? is it
//      gateway-only?), via the browser-safe
//      `@canopy/execution-engine/lib/gateway-model-availability` helpers,
//   2. the account's availability (native login and/or an AI Credits balance),
//      via the `ProviderModelAvailability` shape, and
//   3. the stored per-tab preference plus the live main-process routing bit.
//
// The result tells the UI which framework is effectively in force, whether the
// toggle should render at all, and — when only one framework is possible —
// whether it is locked and why. It also reports whether the AI Credits session
// banner should render, which is deliberately narrower than
// `framework === 'ai-credits'`. This is a display/UX correctness concern only:
// session-spawn routing already force-routes gateway-only models regardless.

import {
  hasHydratedGatewayCatalog,
  type AgentProviderType,
  type ChatBillingFramework,
  type ChatModel,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import { getProviderLabel } from '@/lib/providerLabels';

/**
 * Renderer alias for the shared {@link ChatBillingFramework} wire union so the
 * picker/banner and the persisted `lastChatBillingFramework` preference speak
 * the exact same vocabulary.
 */
export type BillingFramework = ChatBillingFramework;

export interface ResolveChatBillingInput {
  /** Currently selected chat model id (already resolved to a concrete model). */
  model: ChatModel | undefined;
  /** Provider the selected model belongs to. */
  provider: AgentProviderType | undefined;
  /** Availability for `provider` (native login / credits eligibility / loading). */
  availability: ProviderModelAvailability | undefined;
  /** Explicit per-tab AI Credits routing preference (`tab.aiCreditsRouting?.active`). */
  aiCreditsRoutingActive: boolean;
  /** Explicit per-tab subscription-billing preference (`tab.subscriptionBillingOverride`). */
  subscriptionBillingOverride: boolean;
  /** Live main-process routing bit for the chat (`useAiCreditsRoutingActive`). */
  routingActiveForChat: boolean;
  /** Whether an organization gateway is the member's compliance boundary. */
  modelGatewayEnforced?: boolean;
}

export interface ChatBillingResolution {
  /**
   * Effective billing framework, or `null` when billing does not apply (no
   * model, non-billable provider, unavailable gateway-only model, or missing
   * availability). This is the billing truth; it is *not* on its own the banner
   * condition — see {@link ChatBillingResolution.aiCreditsBannerVisible}.
   */
  framework: BillingFramework | null;
  /** Whether the picker should render the billing toggle at all. */
  toggleVisible: boolean;
  /** Whether the toggle is locked (exactly one framework is available). */
  toggleDisabled: boolean;
  /** Short, user-facing reason shown when the toggle is locked. */
  lockedReason?: string;
  /**
   * When the toggle is locked, which sub-case caused it. Only
   * `'no-native-login'` is unlockable by the user (sign in to the provider),
   * so the picker renders a Sign-in CTA solely for that case.
   */
  lockKind?:
    | 'gateway-only-model'
    | 'no-native-login'
    | 'model-not-routable'
    | 'no-credits';
  /**
   * Whether the AI Credits session banner should render. A native-capable
   * model keeps the banner even when native auth is negative or inconclusive;
   * whether it offers a switch follows `toggleDisabled`. A gateway-only model
   * cannot offer that escape; its existing disclosure depends on a confirmed
   * native path.
   */
  aiCreditsBannerVisible: boolean;
}

/**
 * Whether a model can carry an AI Credits offer. `'unknown'` covers the cold
 * gateway catalog and a missing model; callers treat it as "offer nothing",
 * so saved routing never claims a route the catalog has not confirmed.
 */
export type CreditsModelRoutability = 'routable' | 'not-routable' | 'unknown';

/**
 * Resolve whether `model` can bill to AI Credits through the gateway. The
 * usage-limit banner, its click handlers, the model switch, and stale-routing
 * cleanup all consume this one answer.
 *
 * Reads module-level catalog state, so React callers must re-derive it when the
 * model facts version changes. Agent models resolve through their base model.
 */
export function resolveCreditsModelRoutability(
  model: ChatModel | undefined,
): CreditsModelRoutability {
  if (!model || !hasHydratedGatewayCatalog()) {
    return 'unknown';
  }
  return isGatewayRoutableModel(model) ? 'routable' : 'not-routable';
}

const HIDDEN: ChatBillingResolution = {
  framework: null,
  toggleVisible: false,
  toggleDisabled: false,
  aiCreditsBannerVisible: false,
};

/**
 * Resolve the effective billing framework and toggle state for a chat.
 *
 * Gateway-only capability is locked to credits. A native-capable model keeps
 * subscription selection reachable while an auth probe is inconclusive; main
 * owns the eventual attempt and its real recovery outcome. A confirmed
 * sign-out with available credits and no explicit subscription override locks
 * to credits until the user signs in (CAN-5349).
 */
export function resolveChatBillingFramework(
  input: ResolveChatBillingInput,
): ChatBillingResolution {
  const {
    model,
    provider,
    availability,
    aiCreditsRoutingActive,
    subscriptionBillingOverride,
    routingActiveForChat,
    modelGatewayEnforced = false,
  } = input;

  // An enforced organization gateway replaces both personal subscriptions and
  // hosted AI Credits. Do not leave a second route selectable while the
  // current persisted model is being reconciled onto the org catalog.
  if (modelGatewayEnforced) {
    return HIDDEN;
  }

  // Billing only applies to the cloud providers. Ollama is local/free and never
  // carries a billing concept.
  if (!model || (provider !== 'claude' && provider !== 'codex')) {
    return HIDDEN;
  }
  if (resolveGatewayModelEntry(model)?.origin === 'org-gateway') {
    return HIDDEN;
  }
  if (!availability) {
    return HIDDEN;
  }

  // Single derivation of the banner condition, applied at every return site so
  // the documented invariant cannot drift when a branch condition changes. The
  // per-branch comments below explain why each path's inputs land where they
  // do; they are explanatory, not load-bearing.
  const withBannerVisibility = (
    resolution: Omit<ChatBillingResolution, 'aiCreditsBannerVisible'>,
  ): ChatBillingResolution => ({
    ...resolution,
    aiCreditsBannerVisible:
      resolution.framework === 'ai-credits' &&
      (availability.nativeAuth || !isGatewayOnlyModel(model)),
  });

  // Preserve an active credits route even if the balance read is pending or
  // exhausted. Only confirmed eligibility offers credits as a *new* choice.
  // An explicit subscription override supersedes stale routing signals unless
  // the model is gateway-only, where no native route exists.
  const routedCreditsChoice =
    (!subscriptionBillingOverride || isGatewayOnlyModel(model)) &&
    (aiCreditsRoutingActive || routingActiveForChat);
  const creditsAvailable =
    isGatewayRoutableModel(model) &&
    (availability.creditsEligible || routedCreditsChoice);
  // A loading or failed auth probe is not a sign-out (CAN-4272). Availability
  // that predates the auth-only signal falls back to aggregate `loading`.
  const nativeAuthInconclusive =
    availability.nativeAuthInconclusive ?? availability.loading;
  const signedOutConfirmed =
    availability.nativeAuth === false && !nativeAuthInconclusive;
  // CAN-5349 narrows CAN-4272: a confirmed sign-out with available credits and
  // no explicit subscription override cannot newly select subscription. An
  // existing override stays honored until the user picks credits again.
  const subscriptionAvailable =
    !isGatewayOnlyModel(model) &&
    !(signedOutConfirmed && creditsAvailable && !subscriptionBillingOverride);

  // Neither path is possible — nothing to bill, so hide the toggle entirely.
  if (!creditsAvailable && !subscriptionAvailable) {
    return HIDDEN;
  }

  // Only AI Credits can pay for this model: locked ON.
  if (creditsAvailable && !subscriptionAvailable) {
    if (isGatewayOnlyModel(model)) {
      return withBannerVisibility({
        framework: 'ai-credits',
        toggleVisible: true,
        toggleDisabled: true,
        lockKind: 'gateway-only-model',
        lockedReason: 'This model is only available with AI Credits',
      });
    }
    // Confirmed sign-out: signing in to this provider is the only unlock, so
    // the picker offers that remedy and the credits card shows no switch.
    return withBannerVisibility({
      framework: 'ai-credits',
      toggleVisible: true,
      toggleDisabled: true,
      lockKind: 'no-native-login',
      lockedReason: `You're not signed in to ${getProviderLabel(provider)}, so this chat bills to your AI Credits. Sign in to bill your subscription.`,
    });
  }

  // Only a native attempt can pay for this model+account: locked OFF.
  if (subscriptionAvailable && !creditsAvailable) {
    const notRoutable = !isGatewayRoutableModel(model);
    return withBannerVisibility({
      framework: 'subscription',
      toggleVisible: true,
      toggleDisabled: true,
      lockKind: notRoutable ? 'model-not-routable' : 'no-credits',
      lockedReason: notRoutable
        ? "This model can't bill to AI Credits"
        : availability.nativeAuth
          ? 'No AI Credits available, so this chat bills to your subscription'
          : 'No AI Credits available. This chat will try your subscription.',
      // Framework is 'subscription' on this path, so the derived flag is false.
    });
  }

  // Both frameworks are selectable. A confirmed sign-out reaches this branch
  // only with an explicit subscription override, which it cannot override. An
  // inconclusive probe defaults to a native attempt, never an assumed
  // paid-credits fallback.
  const framework: BillingFramework = subscriptionBillingOverride
    ? 'subscription'
    : aiCreditsRoutingActive
      ? 'ai-credits'
      : routingActiveForChat
        ? 'ai-credits'
        : availability.nativeAuth || nativeAuthInconclusive
          ? 'subscription'
          : 'ai-credits';

  return withBannerVisibility({
    framework,
    toggleVisible: true,
    toggleDisabled: false,
  });
}
