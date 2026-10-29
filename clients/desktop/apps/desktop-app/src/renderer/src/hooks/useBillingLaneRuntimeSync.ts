import { useEffect, useRef } from 'react';
import type {
  AgentProviderAuthStatus,
  AiCreditsScopeRequest,
} from '@canopy/desktop-shared/types';
import type { BillingLaneAvailability } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  setRendererBillingLaneAvailability,
  setRendererGuestPrincipal,
} from '@/stores/billingLaneRuntime';
import { useChatStore } from '@/stores/chatStore';
import { useClaudeAuthStatus } from './useClaudeAuthStatus';
import { useCodexAuthStatus } from './useCodexAuthStatus';
import { useAiCreditsAvailability } from './useAiCreditsAvailability';
import { useGuestCredentialState } from './useIsGuestCredential';
import { useWorkModelLibraryAccess } from './useModelLibraryAccess';
import { resolveModelLibraryLock } from '@/lib/modelLibraryAccess';
import { isAccountProxyReadyForHarness } from '@canopy/desktop-shared/lib/account-proxy';
import { useAccountProxyStatus } from '@/stores/accountProxyStore';

/**
 * Map one provider's auth-probe result onto the tri-state the lane resolver
 * needs.
 *
 * `null` is "probe still in flight" and `probeFailed` is "the probe answered
 * nothing" — both are UNKNOWN, never a confirmed logout. Only a settled,
 * non-failed read may assert `false`, because that negative is what diverts a
 * paying subscriber onto another (billable) lane.
 */
function nativeAuthTriState(
  status: AgentProviderAuthStatus | null,
): boolean | undefined {
  if (status === null) return undefined;
  if (status.authenticated === true) return true;
  // A credential injected through Canopy Environments is invisible to the probe
  // (it runs with the injector disabled) but perfectly real at spawn time. Main
  // ORs exactly this into its own lane availability
  // (`default-model-lane-resolver.ts` -> `withUserSuppliedCredential`); without
  // the same fold here, that user gets `claudeNativeAuth: false` in the renderer
  // and `true` in main — a false dead-end banner and a wrong composer seed on
  // every chat while their sends all succeed.
  //
  // KNOWN LIMITATION: `userSuppliedCredential` resolves the GLOBAL Environments
  // runtime slot only, because the auth status is one process-wide read. Main
  // additionally resolves per-WORKSPACE overrides (it passes the workspace id
  // the spawn will use), so a workspace-only credential still reads as a
  // confirmed logout here. Documented on the field in
  // `AgentProviderAuthStatus` too.
  if (status.userSuppliedCredential === true) return true;
  return status.probeFailed === true ? undefined : false;
}

/**
 * Same fold for the credits read: a positive is never ambiguous, an unsettled
 * or inconclusive read is UNKNOWN, and only a settled conclusive read may say
 * "cannot pay".
 */
function creditsTriState(
  eligible: boolean,
  loading: boolean,
  inconclusive: boolean,
): boolean | undefined {
  if (eligible) return true;
  return loading || inconclusive ? undefined : false;
}

/**
 * Push live billing-lane facts into `billingLaneRuntime` and re-stamp pristine
 * chat tabs once those facts settle.
 *
 * Mount exactly once, at the app root. Drafting stays available during probes;
 * a fresh Advisor default waits at its send boundary until eligibility is known.
 * Empty tabs are corrected here when the probe lands.
 *
 * Every fact is read from its OWN source rather than through
 * `useProviderAvailability`, whose per-provider `loading` is deliberately
 * `authLoading || probeFailed || credits.loading` — a single flag for "the
 * picker should stay optimistic". Feeding that into the lane runtime couples
 * three independent facts: an in-flight credits read would turn a CONFIRMED
 * native logout back into UNKNOWN (seeding a credits-only user with an
 * expensive native model), and an in-flight Claude auth probe would turn a
 * settled credits answer into UNKNOWN.
 *
 * Credits eligibility follows the live navigation context (CAN-3463), because
 * the seeded lane belongs to the next chat created there. The App Advisor
 * window passes its own Personal scope instead.
 */
export function useBillingLaneRuntimeSync(
  creditsScope?: AiCreditsScopeRequest,
): void {
  const claudeAuth = useClaudeAuthStatus();
  const codexAuth = useCodexAuthStatus();
  const credits = useAiCreditsAvailability(creditsScope);
  const isGuest = useGuestCredentialState();
  // CAN-4028: a signed-in account that has not purchased is held to the same
  // allowlist as a guest on the AI Credits lane, so its default is narrowed
  // the same way. Owner-scoped like the credits read beside it, and unknown
  // access narrows nothing.
  const libraryAccess = useWorkModelLibraryAccess(creditsScope);
  const allowlistOnly =
    isGuest === undefined
      ? undefined
      : isGuest ||
        (!credits.inconclusive &&
          resolveModelLibraryLock(false, libraryAccess) !== undefined);
  // A ready account proxy bills the harness's own models, as main's lane
  // resolver and `useProviderAvailability` count it (CAN-4020).
  const accountProxy = useAccountProxyStatus();
  const claudeProxyReady = isAccountProxyReadyForHarness(
    accountProxy,
    'claude',
  );
  const codexProxyReady = isAccountProxyReadyForHarness(accountProxy, 'codex');
  const lastSignatureRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const next: BillingLaneAvailability = {
      claudeNativeAuth: claudeProxyReady || nativeAuthTriState(claudeAuth),
      codexNativeAuth: codexProxyReady || nativeAuthTriState(codexAuth),
      creditsEligible: creditsTriState(
        credits.eligible,
        credits.loading,
        credits.inconclusive,
      ),
    };
    setRendererBillingLaneAvailability(next);
    setRendererGuestPrincipal(allowlistOnly);

    // Re-stamp only on an actual change in the facts, so an unrelated render
    // never rewrites a tab. `syncActiveEmptyTabToDefaults` applies its own
    // pristine guards before touching anything.
    const signature = `${String(next.claudeNativeAuth)}|${String(
      next.codexNativeAuth,
    )}|${String(next.creditsEligible)}|${String(allowlistOnly)}`;
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;
    void useChatStore.getState().syncActiveEmptyTabToDefaults();
  }, [
    claudeAuth,
    codexAuth,
    claudeProxyReady,
    codexProxyReady,
    credits.eligible,
    credits.loading,
    credits.inconclusive,
    allowlistOnly,
  ]);
}
