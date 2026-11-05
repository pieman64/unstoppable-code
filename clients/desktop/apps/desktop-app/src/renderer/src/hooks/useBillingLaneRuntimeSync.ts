import { useEffect, useRef, useState } from 'react';
import {
  clearCodexAccountModels,
  setCodexAccountModels,
  type AgentProviderAuthStatus,
  type AiCreditsScopeRequest,
} from '@canopy/desktop-shared/types';
import type { BillingLaneAvailability } from '@canopy/desktop-shared/lib/default-model-lane';
import type { CodexSpeedCatalog } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  setRendererBillingLaneAvailability,
  getRendererCodexAccountModelsKey,
  setRendererCodexAccountModels,
  setRendererGuestPrincipal,
} from '@/stores/billingLaneRuntime';
import { useChatStore } from '@/stores/chatStore';
import {
  retainCodexSpeedSubscription,
  useCodexSpeedStore,
} from '@/stores/codexSpeedStore';
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
 * The ids of the signed-in ChatGPT account's non-hidden Codex models (`id` and
 * `model` of each entry), or `null` when the list is unknown, truncated, or
 * lists nothing usable. Hidden models never count toward default eligibility (CAN-4716).
 */
export function codexAccountModelIdsFromCatalog(
  catalog: CodexSpeedCatalog | null,
): ReadonlySet<string> | null {
  if (catalog?.status !== 'ready' || catalog.truncated) return null;
  const ids = new Set<string>();
  for (const entry of catalog.models) {
    if (entry.hidden === true) continue;
    if (entry.id) ids.add(entry.id);
    if (entry.model) ids.add(entry.model);
  }
  return ids.size > 0 ? ids : null;
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
  const codexNativeAuth = codexProxyReady || nativeAuthTriState(codexAuth);
  const codexSignedIn = codexNativeAuth === true;
  // CAN-4716: the account's own Codex model list narrows the Codex default to
  // models it can run. Fetch it once per confirmed sign-in (again after a
  // sign-out/sign-in cycle) and follow main's pushes while signed in. Never
  // read while the Codex lane is unknown or signed out.
  const codexCatalog = useCodexSpeedStore((state) => state.catalog);
  // A catalog mirrored before this sign-in may be another account's (its
  // invalidation can arrive while unsubscribed), so the mirror counts only
  // once this sign-in's own read has settled.
  const [codexSignInReadSettled, setCodexSignInReadSettled] = useState(false);
  useEffect(() => {
    if (!codexSignedIn) return undefined;
    const release = retainCodexSpeedSubscription();
    let current = true;
    void useCodexSpeedStore
      .getState()
      .read()
      .finally(() => {
        if (current) setCodexSignInReadSettled(true);
      });
    return (): void => {
      current = false;
      setCodexSignInReadSettled(false);
      release();
    };
  }, [codexSignedIn]);
  // Main invalidates its catalog in session (account updated, runtime
  // replaced) and only refetches while a speed surface is open, so read once
  // more for each newer generation that arrives `unknown`.
  const lastSeenCatalogGenerationRef = useRef<number | null>(null);
  useEffect(() => {
    if (!codexSignedIn) {
      lastSeenCatalogGenerationRef.current = null;
      return;
    }
    if (!codexCatalog) return;
    const seen = lastSeenCatalogGenerationRef.current;
    lastSeenCatalogGenerationRef.current = codexCatalog.generation;
    if (
      seen !== null &&
      codexCatalog.generation > seen &&
      codexCatalog.status === 'unknown'
    ) {
      void useCodexSpeedStore.getState().read();
    }
  }, [codexSignedIn, codexCatalog]);
  const lastRegisteredCatalogRef = useRef<CodexSpeedCatalog | null>(null);

  useEffect(() => {
    const accountCatalog =
      codexSignedIn && codexSignInReadSettled ? codexCatalog : null;
    // Register the account-only models before the eligibility set below, so
    // the re-stamp sees them; the same mapping main applies to its registry.
    if (lastRegisteredCatalogRef.current !== accountCatalog) {
      lastRegisteredCatalogRef.current = accountCatalog;
      if (accountCatalog?.status === 'ready' && !accountCatalog.truncated) {
        setCodexAccountModels(accountCatalog.models);
      } else {
        clearCodexAccountModels();
      }
    }
    setRendererCodexAccountModels(
      codexAccountModelIdsFromCatalog(accountCatalog),
    );

    // The Claude probe settled without an answer and nothing confirms a
    // sign-in, so the resolver may rank confirmed AI Credits ahead of Claude.
    // Main's `resolveDefaultModelLaneForPreferences` pairs this: its fold of an
    // Environments credential and a ready account proxy to `true` is the
    // counterpart of the `claudeProxyReady` and `userSuppliedCredential`
    // exclusions here.
    const claudeInconclusive =
      !claudeProxyReady &&
      claudeAuth !== null &&
      claudeAuth.probeFailed === true &&
      claudeAuth.authenticated !== true &&
      claudeAuth.userSuppliedCredential !== true;
    const next: BillingLaneAvailability = {
      claudeNativeAuth: claudeProxyReady || nativeAuthTriState(claudeAuth),
      // Emitted only when true, so an unaffected availability keeps its shape.
      ...(claudeInconclusive ? { claudeNativeAuthInconclusive: true } : {}),
      codexNativeAuth,
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
      claudeInconclusive,
    )}|${String(next.codexNativeAuth)}|${String(next.creditsEligible)}|${String(
      allowlistOnly,
    )}|${getRendererCodexAccountModelsKey()}`;
    if (lastSignatureRef.current === signature) return;
    lastSignatureRef.current = signature;
    void useChatStore.getState().syncActiveEmptyTabToDefaults();
  }, [
    claudeAuth,
    codexNativeAuth,
    codexSignedIn,
    codexSignInReadSettled,
    codexCatalog,
    claudeProxyReady,
    credits.eligible,
    credits.loading,
    credits.inconclusive,
    allowlistOnly,
  ]);
}
