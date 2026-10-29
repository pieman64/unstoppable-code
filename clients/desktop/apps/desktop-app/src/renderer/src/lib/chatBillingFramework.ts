// Pure resolver for the per-chat billing framework (subscription vs AI Credits).
//
// Both the model picker's "Bill to AI Credits" toggle and the AI Credits status
// banner consume this single function so they can never disagree. It combines
// three inputs into one decision:
//
//   1. the selected model's capability (can it route through the gateway? is it
//      gateway-only?), via the browser-safe
//      `@canopy/desktop-shared/lib/gateway-model-availability` helpers,
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

import type {
  AgentProviderType,
  ChatBillingFramework,
  ChatModel,
} from '@canopy/desktop-shared/types';
import {
  isGatewayOnlyModel,
  isGatewayRoutableModel,
  resolveGatewayModelEntry,
} from '@canopy/desktop-shared/lib/gateway-model-availability';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import { getModelCatalogProviderLabel } from '@canopy/ui-shared';

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
   * model, non-billable provider, availability missing/loading, or neither
   * framework is possible). This is the billing truth; it is *not* on its own
   * the banner condition — see {@link ChatBillingResolution.aiCreditsBannerVisible}.
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
   * Whether the AI Credits session banner should render. True only when the
   * chat bills to AI Credits AND the account has a native login for the
   * provider — telling a user whose only option is credits that they are
   * spending credits is not actionable, it just reads as a warning about a
   * choice they never made. The picker's locked toggle still explains the
   * billing state for those users.
   *
   * Derivation is uniform at every return site because every non-`HIDDEN`
   * return runs through one local helper (`withBannerVisibility`):
   * `framework === 'ai-credits' && availability.nativeAuth`.
   *
   * Known limitation: this also hides the banner's balance readout
   * (`chat-input-ai-credits-balance`) and org-payer chip
   * (`chat-input-ai-credits-covered-by`), because both live inside the banner
   * and are gated on the same flag. A credits-only user therefore has no
   * running balance in the composer, and an org-funded credits-only member
   * loses the "Covered by {org}" disclosure. That is accepted here — the
   * sentence is what reads as an unactionable warning, and the picker's locked
   * toggle still explains the billing state — but splitting the copy from the
   * chip so credits-only users keep the balance is a reasonable follow-up.
   *
   * Known limitation: `useProviderAvailability` sets `nativeAuth` from
   * `status.authenticated` alone and does not fold in
   * `status.userSuppliedCredential` (unlike `nativeAuthTriState` in
   * `hooks/useBillingLaneRuntimeSync.ts`). A user whose only "native"
   * credential is an `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` supplied through
   * Canopy Environments therefore reads as `nativeAuth: false` and will not
   * see the banner. This is the same false-negative family
   * `NoBillingSourceBanner` already documents. Main-process routing softens it
   * but does not eliminate it: the `hasUserSuppliedProviderCredential` drop in
   * `agents/ai-credits-routing.ts` is scoped to
   * `attempt.reason === 'no-native-auth'`, so only the *implicit* fallback
   * falls through to native for those users. Explicit routing — an
   * `aiCreditsRoutingMode` of `on`/`on-quota`, a per-session override, or
   * selecting a gateway-only model, which all three call sites force-route via
   * `if (!attempt && !gatewayOnly) return null` regardless of the dropped
   * attempt — still spends credits, and now does so without a banner. The
   * gateway-only case is the most actionable of the three, since switching to
   * a native-capable model would use their own credential. Folding
   * `status.userSuppliedCredential` into this gate the way `nativeAuthTriState`
   * does is the complete fix, but it requires `useProviderAvailability` to
   * surface that field first (`ProviderModelAvailability` carries only
   * `nativeAuth` and `creditsEligible` today), so it is deliberately out of
   * scope here.
   */
  aiCreditsBannerVisible: boolean;
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
 * See the decision table in the plan: locked-ON for gateway-only capability or
 * a credits-only account, locked-OFF for a non-routable model or a native-only
 * account, and interactive only when both frameworks are genuinely available.
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
  if (!availability || availability.loading) {
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
      resolution.framework === 'ai-credits' && availability.nativeAuth,
  });

  const creditsAvailable =
    isGatewayRoutableModel(model) && availability.creditsEligible;
  const subscriptionAvailable =
    !isGatewayOnlyModel(model) && availability.nativeAuth;

  // Neither path is possible — nothing to bill, so hide the toggle entirely.
  if (!creditsAvailable && !subscriptionAvailable) {
    return HIDDEN;
  }

  // Only AI Credits can pay for this model+account: locked ON.
  if (creditsAvailable && !subscriptionAvailable) {
    const gatewayOnlyModel = isGatewayOnlyModel(model);
    return withBannerVisibility({
      framework: 'ai-credits',
      toggleVisible: true,
      toggleDisabled: true,
      lockKind: gatewayOnlyModel ? 'gateway-only-model' : 'no-native-login',
      lockedReason: gatewayOnlyModel
        ? 'This model is only available with AI Credits'
        : `You're not signed in to ${getModelCatalogProviderLabel(provider)}, so this chat bills to your AI Credits. Sign in to bill your subscription.`,
      // The derived flag reduces to `availability.nativeAuth` here, because
      // `framework` is always 'ai-credits' on this branch. Both sub-cases still
      // land correctly: `no-native-login` has `nativeAuth: false` and hides the
      // banner, while `gateway-only-model` hides it too unless the user has a
      // native login the gateway-only model simply cannot bill to. Note this
      // does not run the other way — a gateway-only model does NOT imply
      // `nativeAuth: true`; that combination reaches here and stays hidden.
    });
  }

  // Only the subscription can pay for this model+account: locked OFF.
  if (subscriptionAvailable && !creditsAvailable) {
    const notRoutable = !isGatewayRoutableModel(model);
    return withBannerVisibility({
      framework: 'subscription',
      toggleVisible: true,
      toggleDisabled: true,
      lockKind: notRoutable ? 'model-not-routable' : 'no-credits',
      lockedReason: notRoutable
        ? "This model can't bill to AI Credits"
        : 'No AI Credits available, so this chat bills to your subscription',
      // Framework is 'subscription' on this path, so the derived flag is false.
    });
  }

  // Both frameworks are available — interactive. Value follows the existing
  // precedence: explicit AI Credits pref, then explicit subscription pref, then
  // the live routing signal, defaulting to subscription.
  const framework: BillingFramework = aiCreditsRoutingActive
    ? 'ai-credits'
    : subscriptionBillingOverride
      ? 'subscription'
      : routingActiveForChat
        ? 'ai-credits'
        : 'subscription';

  // `availability.nativeAuth` is true by construction on this path
  // (`subscriptionAvailable` is required to reach it), so the derived flag
  // reduces to `framework === 'ai-credits'`.
  return withBannerVisibility({
    framework,
    toggleVisible: true,
    toggleDisabled: false,
  });
}
