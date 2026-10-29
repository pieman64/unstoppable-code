import { useOpenCodeChatAvailable } from './useOpenCodeChatAvailable';
import { useCopilotChatAvailable } from './useCopilotChatAvailable';
import { useMemo } from 'react';
import type {
  AgentProviderType,
  AiCreditsScopeRequest,
} from '@canopy/desktop-shared/types';
import { useClaudeAuthStatus } from './useClaudeAuthStatus';
import { useCodexAuthStatus } from './useCodexAuthStatus';
import { useAiCreditsAvailability } from './useAiCreditsAvailability';
import { isAccountProxyReadyForHarness } from '@canopy/desktop-shared/lib/account-proxy';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';

/**
 * Whether a provider's models can be selected in the model picker, and why.
 *
 * `selectable` is optimistic while `loading` so a native subscriber is never
 * flash-disabled by a slow auth probe. Per-model gating (native login unlocks
 * the whole group; AI Credits unlock only gateway-routable models) is derived
 * from `nativeAuth` / `creditsEligible` at the row level in `ModelPicker`.
 */
export interface ProviderModelAvailability {
  /** True when the group should be treated as usable (native, credits, or loading). */
  selectable: boolean;
  /**
   * True when the user has a native login/API key for this provider, or a
   * connected account proxy has a ready account for it: the proxy bills the
   * provider's own models, as main's lane resolver counts it (CAN-4020).
   */
  nativeAuth: boolean;
  /** True when AI Credits can pay for this provider's gateway models. */
  creditsEligible: boolean;
  /** True while the underlying auth/credits reads are still resolving. */
  loading: boolean;
  /** True only while AI Credits eligibility is still resolving. */
  creditsLoading?: boolean;
}

export type ProviderAvailability = Record<
  AgentProviderType,
  ProviderModelAvailability
>;

/**
 * `creditsScope` is the owner of the work the picker is for (CAN-3463): AI
 * Credits spill only onto that owner's organization pool, so a chat owned by an
 * unfunded org must not read as covered because another org is funded. Omitted
 * means the live navigation context.
 */
export function useProviderAvailability(
  creditsScope?: AiCreditsScopeRequest,
): ProviderAvailability {
  const opencode = useOpenCodeChatAvailable(true);
  const copilot = useCopilotChatAvailable(true);
  const claudeAuth = useClaudeAuthStatus();
  const codexAuth = useCodexAuthStatus();
  const credits = useAiCreditsAvailability(creditsScope);
  const accountProxy = useAccountProxyStatus();
  const claudeProxyReady = isAccountProxyReadyForHarness(
    accountProxy,
    'claude',
  );
  const codexProxyReady = isAccountProxyReadyForHarness(accountProxy, 'codex');

  return useMemo<ProviderAvailability>(() => {
    const creditsEligible = credits.eligible;

    const gated = (
      authenticated: boolean,
      authLoading: boolean,
      probeFailed: boolean,
    ): ProviderModelAvailability => {
      // A failed auth probe is inconclusive, not a confirmed logout — treat it
      // as `loading` so the billing toggle hides (via the HIDDEN-on-loading path
      // in resolveChatBillingFramework) instead of asserting `nativeAuth: false`
      // and locking the user out of their subscription.
      const loading = authLoading || probeFailed || credits.loading;
      return {
        nativeAuth: authenticated,
        creditsEligible,
        loading,
        creditsLoading: credits.loading,
        selectable: authenticated || creditsEligible || loading,
      };
    };

    return {
      opencode: {
        nativeAuth: opencode,
        creditsEligible: false,
        loading: false,
        selectable: opencode,
      },
      copilot: {
        nativeAuth: copilot,
        creditsEligible: false,
        loading: false,
        selectable: copilot,
      },
      cursor: {
        nativeAuth: true,
        creditsEligible: false,
        loading: false,
        selectable: true,
      },
      claude: gated(
        claudeAuth?.authenticated === true || claudeProxyReady,
        claudeAuth === null,
        claudeAuth?.probeFailed === true,
      ),
      codex: gated(
        codexAuth?.authenticated === true || codexProxyReady,
        codexAuth === null,
        codexAuth?.probeFailed === true,
      ),
      // Ollama runs locally and is never gated on native auth or credits.
      ollama: {
        nativeAuth: true,
        // Local provider — never credit-routed, so this is false by definition
        // rather than reflecting the user's cloud account state.
        creditsEligible: false,
        loading: false,
        creditsLoading: false,
        selectable: true,
      },
    };
  }, [
    opencode,
    copilot,
    claudeAuth,
    codexAuth,
    claudeProxyReady,
    codexProxyReady,
    credits.eligible,
    credits.loading,
  ]);
}
