import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import type {
  AgentProviderType,
  ChatBillingFramework,
  ModelHarness,
} from '@canopy/desktop-shared/types';
import {
  getCurrentModelHarnessCatalog,
  getProviderForChatModel,
  hasGatewayModelRoutes,
  hasHydratedGatewayCatalog,
  hasHydratedModelRegistry,
  isOllamaModel,
} from '@canopy/desktop-shared/types';
import { isUnavailableModelSelection } from '@canopy/desktop-shared/lib/gateway-model-availability';
import { isModelBlockedTriState } from '@canopy/desktop-shared/lib/model-policy';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  chatAiCreditsScope,
  readNavigationScopeKey,
} from '@/lib/aiCreditsScope';
import {
  refreshModelLibraryAccess,
  refreshWorkModelLibraryAccess,
  useModelLibraryAccessStore,
} from '@/lib/modelLibraryAccess';
import {
  resolveModelRowGate,
  type ModelRowGate,
} from '@/lib/modelPickerRowGate';
import type { ProviderModelAvailability } from '@/hooks/useProviderAvailability';
import { useChatStore } from '@/stores/chatStore';
import { resolveBillingSeed } from '@/stores/chat/defaults';
import {
  billingSeedFields,
  isTabAiCreditsRouted,
} from '@/stores/chat/tab-utils';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  getRendererModelFactsVersion,
  getRendererModelGatewayEnforced,
  getRendererModelPolicy,
  isRendererModelPolicyHydrated,
} from '@/stores/modelPolicyRuntime';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { homeModelDisplayLabel } from './homeModelFailureCopy';
import { getHomeScope } from './homeScope';

/**
 * CAN-5021 — refuse a Home send before it creates anything when the client
 * already knows main will refuse its model.
 *
 * Conservative by construction: `{ ok: true }` means "no established
 * client-side blocker", never approval. Every fact is optional, and an absent
 * fact disables only the checks that depend on it; main stays authoritative.
 * The decision itself is the model picker's row gate, so Home cannot refuse a
 * row the picker offers as selectable or accept one it hides.
 */

export type HomeModelRefusalReason =
  | 'needs-account'
  | 'needs-purchase'
  | 'not-routable'
  | 'org-policy'
  | 'org-gateway'
  | 'unknown-model';

export type HomeModelPreflightResult =
  | { ok: true }
  | { ok: false; reason: HomeModelRefusalReason; modelLabel: string };

/** What the client knows about the selected work context. Absent = unknown. */
export interface HomeModelEligibilityFacts {
  /** The saved credential is a guest. Absent when the account was unreadable. */
  readonly isGuest?: boolean;
  /**
   * Model-library access for the owner of the selected work. Absent when the
   * read has not landed, failed, or describes another account.
   */
  readonly libraryAccess?: ModelLibraryAccess;
  /** Billing seed a Home-created chat starts with (`resolveBillingSeed`). */
  readonly billingSeed?: ChatBillingFramework;
  /**
   * Organization model policy for the selected work's owner. Absent until an
   * account read has produced a policy, or when the owner is not known.
   */
  readonly modelPolicy?: ReadonlySet<string>;
  /** That owner's organization makes its gateway the only route. */
  readonly modelGatewayEnforced?: boolean;
  /**
   * The model registries and the gateway catalog have both hydrated, so a
   * model missing from them is absent rather than not loaded yet.
   */
  readonly catalogLoaded?: boolean;
}

export interface HomeModelSelection {
  /** The effective, pinned model (`resolveHomeEffectiveModelSettings`). */
  model: string;
  executionHarness?: ModelHarness;
  /** The accepted destination route when retrying an existing chat. */
  aiCreditsRouted?: boolean;
}

const NO_POLICY: ReadonlySet<string> = new Set<string>();

/**
 * Billing-source availability is hook-only (`useProviderAvailability`), so the
 * gate receives it as still loading: the same optimistic treatment the picker
 * gives an in-flight probe. A missing subscription or balance is left to main.
 */
const UNKNOWN_AVAILABILITY: ProviderModelAvailability = {
  selectable: true,
  nativeAuth: true,
  creditsEligible: true,
  loading: true,
  creditsLoading: true,
};

function selectionProvider(selection: HomeModelSelection): AgentProviderType {
  const { model, executionHarness } = selection;
  if (
    executionHarness === 'cursor' ||
    executionHarness === 'copilot' ||
    executionHarness === 'opencode'
  )
    return executionHarness;
  return (
    getProviderForChatModel(model, executionHarness) ??
    (isOllamaModel(model) ? 'ollama' : (executionHarness ?? 'claude'))
  );
}

function refusalForGate(gate: ModelRowGate): HomeModelRefusalReason | null {
  switch (gate.kind) {
    case 'hidden':
      return gate.cause === 'org-gateway-only' ? 'org-gateway' : 'not-routable';
    case 'hard-disabled':
      if (gate.cause === 'org-policy' || gate.cause === 'org-gateway')
        return gate.cause;
      return gate.cause === 'stale-agent' ? 'unknown-model' : null;
    case 'recoverable':
      return gate.recovery.kind === 'needs-account' ||
        gate.recovery.kind === 'needs-purchase'
        ? gate.recovery.kind
        : null;
    case 'available':
      return null;
  }
}

function refusalReason(
  selection: HomeModelSelection,
  facts: HomeModelEligibilityFacts,
): HomeModelRefusalReason | null {
  const { model, executionHarness } = selection;
  // Judged before the gate with the tri-state readiness guard: a gateway id
  // the cold route catalog cannot translate yet is unknown, not blocked. No
  // account fact is consulted, so an unreadable account cannot bypass it.
  if (
    facts.modelPolicy !== undefined &&
    isModelBlockedTriState(
      model,
      facts.modelPolicy,
      facts.catalogLoaded === true,
    ) === true
  )
    return 'org-policy';
  const provider = selectionProvider(selection);
  // Main refuses an unresolved id only in its Claude and Codex sessions;
  // Cursor, Copilot, OpenCode, and local Ollama keep their own catalogs.
  const nativeOrGateway = provider === 'claude' || provider === 'codex';
  const catalog = getCurrentModelHarnessCatalog();
  const catalogHasModels =
    catalog.claudeModels.length > 0 ||
    catalog.codexModels.length > 0 ||
    catalog.aiGatewayModels.length > 0;
  const unknownModel =
    facts.catalogLoaded === true &&
    catalogHasModels &&
    nativeOrGateway &&
    isUnavailableModelSelection(model, provider);
  // The route a Home-created tab bills, as `resolveHomeAiCreditsRouted`
  // derives it. Without a seed only a gateway-only model is credits-routed.
  const aiCreditsRouted =
    selection.aiCreditsRouted ??
    isTabAiCreditsRouted({
      ...billingSeedFields(facts.billingSeed),
      model,
    });
  // The library lock folds guest-ness and access together
  // (`resolveModelLibraryLock`), so an unreadable account applies no lock.
  const library =
    facts.isGuest === undefined
      ? { isGuest: false }
      : { isGuest: facts.isGuest, libraryAccess: facts.libraryAccess };
  return refusalForGate(
    resolveModelRowGate({
      model,
      provider,
      ...(executionHarness ? { selectedHarness: executionHarness } : {}),
      currentModel: undefined,
      gatingEnabled: true,
      availability: UNKNOWN_AVAILABILITY,
      billingValue: aiCreditsRouted ? 'ai-credits' : 'subscription',
      // The picker's credits funding row: only Claude and Codex models bill
      // AI Credits; the gate keeps its own Ollama/Cursor/Copilot/OpenCode
      // carve-outs for routability.
      requireCredits: aiCreditsRouted && nativeOrGateway,
      lockedProvider: undefined,
      lockedProviderBehavior: 'disabled',
      lockedProviderReason: undefined,
      lockedHarness: undefined,
      canStartNewChat: false,
      modelPolicy: NO_POLICY,
      staleAgent: unknownModel,
      // A cold route table makes every model look like a non-org route, so
      // enforcement is applied only once routes exist (the gate's own guard).
      modelGatewayEnforced:
        facts.modelGatewayEnforced === true && hasGatewayModelRoutes(),
      ...library,
    }),
  );
}

/** Pure, synchronous. Unknown facts disable only the checks that need them. */
export function evaluateHomeModelEligibility(
  selection: HomeModelSelection,
  facts: HomeModelEligibilityFacts,
): HomeModelPreflightResult {
  const reason = refusalReason(selection, facts);
  return reason === null
    ? { ok: true }
    : {
        ok: false,
        reason,
        modelLabel: homeModelDisplayLabel(selection.model),
      };
}

/** Mirrors `useGuestCredentialState`: an unreadable account is unknown. */
async function readIsGuest(): Promise<boolean | undefined> {
  const loadAccount = window.api?.loadCanopyCloudAccount;
  if (typeof loadAccount !== 'function') return undefined;
  try {
    const account = await loadAccount();
    return account.read && account.read !== 'ok'
      ? undefined
      : isGuestAccount(account);
  } catch {
    return undefined;
  }
}

/**
 * Mirrors `useWorkModelLibraryAccess`: the selected work's own owner scope,
 * bound to the account the personal read describes.
 */
async function readLibraryAccess(
  workspaceId: string | null,
): Promise<ModelLibraryAccess | undefined> {
  try {
    const read = await refreshWorkModelLibraryAccess(
      chatAiCreditsScope(workspaceId),
    );
    if (!read) return undefined;
    if (useModelLibraryAccessStore.getState().accountKey === undefined) {
      await refreshModelLibraryAccess();
    }
    return read.accountKey === useModelLibraryAccessStore.getState().accountKey
      ? read.access
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Policy and gateway facts for the selected work's owner. Home only targets
 * work in the selected context, whose owner the catalog store already tracks
 * as the active owner; a target outside that scope, or a context that has not
 * hydrated, has no owner the client can name.
 */
function readOwnerPolicyFacts(
  workspaceId: string | null,
): Pick<HomeModelEligibilityFacts, 'modelPolicy' | 'modelGatewayEnforced'> {
  if (!isRendererModelPolicyHydrated()) return {};
  const orgProjects = useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key);
  if (orgProjects && !useWorkspaceContextStore.getState().hydrated) return {};
  if (workspaceId !== null && !getHomeScope().isInScope(workspaceId)) return {};
  return {
    modelPolicy: getRendererModelPolicy(),
    modelGatewayEnforced: getRendererModelGatewayEnforced(),
  };
}

interface LoadedHomeModelFacts {
  readonly workspaceId: string | null;
  readonly accountEpoch: number;
  readonly factsVersion: number;
  readonly scopeKey: ReturnType<typeof readNavigationScopeKey>;
  readonly librarySnapshot: ReturnType<
    typeof useModelLibraryAccessStore.getState
  >;
  readonly facts: HomeModelEligibilityFacts;
}

let lastLoaded: LoadedHomeModelFacts | null = null;
let loadSequence = 0;
let lastLoadedSequence = 0;

/** Never throws; a rejected read becomes an unknown fact. */
export async function loadHomeModelEligibilityFacts(
  workspaceId: string | null,
): Promise<HomeModelEligibilityFacts> {
  loadSequence += 1;
  const sequence = loadSequence;
  const accountEpoch = useWorkspaceContextStore.getState().accountEpoch;
  const [isGuest, libraryAccess] = await Promise.all([
    readIsGuest(),
    readLibraryAccess(workspaceId),
  ]);
  const modelDefaults = useChatStore.getState().modelDefaults;
  const billingSeed = modelDefaults
    ? resolveBillingSeed(modelDefaults, workspaceId ?? undefined)
    : undefined;
  const facts: HomeModelEligibilityFacts = {
    ...(isGuest === undefined ? {} : { isGuest }),
    ...(libraryAccess === undefined ? {} : { libraryAccess }),
    ...(billingSeed === undefined ? {} : { billingSeed }),
    ...readOwnerPolicyFacts(workspaceId),
    catalogLoaded: hasHydratedModelRegistry() && hasHydratedGatewayCatalog(),
  };
  // Keep only the newest load, and never one that straddled an account change.
  if (
    sequence > lastLoadedSequence &&
    useWorkspaceContextStore.getState().accountEpoch === accountEpoch
  ) {
    lastLoadedSequence = sequence;
    lastLoaded = {
      workspaceId,
      accountEpoch,
      factsVersion: getRendererModelFactsVersion(),
      scopeKey: readNavigationScopeKey(),
      librarySnapshot: useModelLibraryAccessStore.getState(),
      facts,
    };
  }
  return facts;
}

export async function preflightHomeModel(
  workspaceId: string | null,
  selection: HomeModelSelection,
): Promise<HomeModelPreflightResult> {
  return evaluateHomeModelEligibility(
    selection,
    await loadHomeModelEligibilityFacts(workspaceId),
  );
}

/**
 * The most recently loaded facts for this work context and account, evaluated
 * again. Lets a late refusal name a specific cause it can still establish;
 * otherwise `{ ok: true }` and the caller uses generic copy.
 */
export function cachedHomeModelRefusal(
  workspaceId: string | null,
  selection: HomeModelSelection,
): HomeModelPreflightResult {
  if (
    lastLoaded === null ||
    lastLoaded.workspaceId !== workspaceId ||
    lastLoaded.factsVersion !== getRendererModelFactsVersion() ||
    lastLoaded.scopeKey !== readNavigationScopeKey() ||
    lastLoaded.librarySnapshot !== useModelLibraryAccessStore.getState() ||
    lastLoaded.accountEpoch !== useWorkspaceContextStore.getState().accountEpoch
  )
    return { ok: true };
  return evaluateHomeModelEligibility(selection, lastLoaded.facts);
}

/** Test-only: forget cached facts between cases. */
export function resetHomeModelPreflightForTests(): void {
  lastLoaded = null;
  loadSequence = 0;
  lastLoadedSequence = 0;
}
