// Availability view for one desktop Codex speed selector.
//
// The main-owned catalog, its expiry refresh, and consumer registration stay
// in `useCodexSpeedCapabilities`; this hook only resolves the ACTUAL route of
// the surface (model, Auto, source, harness, billing lane), derives each
// speed's availability with the shared pure helper, and turns it into the
// selectable/short-reason view the shared `@canopy/ui-shared` selectors
// render. It never selects a speed. Availability is an advertised hint:
// dispatch admission in main re-verifies the trusted route before any effect.

import { useMemo, useSyncExternalStore } from 'react';
import type { CodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import {
  deriveCodexSpeedOptions,
  describeCodexSpeedAvailability,
  isCodexSpeedCatalogRouteProfile,
  type CodexSpeedAvailability,
  type CodexSpeedRouteFacts,
  type CodexSpeedRouteProfile,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import type { CodexSpeedCatalog } from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  getExecutionHarnessForModel,
  getModelSource,
  resolveModelAlias,
  type ChatModel,
  type ModelHarness,
  type ModelHarnessSource,
} from '@canopy/desktop-shared/types';
import type {
  CodexSpeedChoiceState,
  CodexSpeedChoiceStates,
} from '@canopy/ui-shared';
import { useModelCatalogStore } from '../stores/modelCatalogStore';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '../stores/modelPolicyRuntime';
import {
  useCodexSpeedCapabilities,
  type CodexSpeedCapabilities,
} from './useCodexSpeedCapabilities';

/** The surface facts a speed selector evaluates availability against. */
export interface CodexSpeedRouteInput {
  model: ChatModel | null | undefined;
  /** `auto` when Auto routing will choose the model. */
  modelSelection: 'explicit' | 'auto';
  /** Catalog source of the model (see {@link codexSpeedModelFacts}). */
  modelSource: ModelHarnessSource | null | undefined;
  /** Captured or effective execution harness. */
  harness: ModelHarness | null | undefined;
  /** The chat, or the chat a draft creates, bills through AI Credits. */
  aiCreditsRouted: boolean;
  /**
   * Trusted, context-scoped host projection of this surface's route. Without
   * it a native-shaped route (Codex-managed model on the Codex harness, not
   * credits-routed) stays `unknown`: a global catalog cannot vouch for the
   * environment, provider overrides, or credentials of a particular chat.
   */
  routeProfile?: CodexSpeedRouteProfile;
}

/**
 * Source and harness of a model from the hydrated registry. `undefined` while
 * the registry has not resolved the model; selectors then stay in the
 * checking state instead of reporting Ultra fast as unavailable.
 */
export function codexSpeedModelFacts(
  model: ChatModel | null | undefined,
  capturedHarness?: ModelHarness,
): Pick<CodexSpeedRouteInput, 'modelSource' | 'harness'> {
  if (!model) return { modelSource: undefined, harness: capturedHarness };
  return {
    modelSource: getModelSource(model),
    harness: getExecutionHarnessForModel(model, capturedHarness),
  };
}

/** What a composer knows about its route: model, Auto, harness, and lane. */
export interface CodexSpeedRouteRequest {
  model: ChatModel | null | undefined;
  auto: boolean;
  capturedHarness?: ModelHarness;
  aiCreditsRouted: boolean;
  /**
   * SEAM: the trusted, context-scoped host projection for this surface (see
   * {@link CodexSpeedRouteInput.routeProfile}), supplied by
   * `useContextualCodexSpeedControl` from `useCodexSpeedRoute`. Absent means
   * native-shaped routes stay `unknown`; never derive it from the global
   * catalog.
   */
  routeProfile?: CodexSpeedRouteProfile;
}

/** Resolve a composer's route request against the hydrated model registry. */
export function codexSpeedRouteInput({
  model,
  auto,
  capturedHarness,
  aiCreditsRouted,
  routeProfile,
}: CodexSpeedRouteRequest): CodexSpeedRouteInput {
  return {
    model,
    modelSelection: auto ? 'auto' : 'explicit',
    ...codexSpeedModelFacts(model, capturedHarness),
    aiCreditsRouted,
    ...(routeProfile ? { routeProfile } : {}),
  };
}

/**
 * Renderer-known facts can only rule the native route OUT. Whether a
 * native-shaped route really runs on the native Codex profile comes solely
 * from the host's context-scoped projection.
 */
function resolveRouteProfile(
  input: CodexSpeedRouteInput,
): CodexSpeedRouteProfile {
  if (input.aiCreditsRouted) return 'ai-credits';
  switch (input.modelSource) {
    case 'ai-gateway':
      return 'ai-credits';
    case 'ollama':
      return 'ollama';
    case 'cursor-managed':
      return 'cursor';
    case 'claude-managed':
      return 'foreign';
    case 'codex-managed':
      break;
    default:
      return 'unknown';
  }
  if (input.harness === 'cursor') return 'cursor';
  if (input.harness !== 'codex') return input.harness ? 'foreign' : 'unknown';
  return input.routeProfile ?? 'unknown';
}

/** The actual route facts of a selector, for the shared availability helper. */
export function resolveCodexSpeedRouteFacts(
  input: CodexSpeedRouteInput,
): CodexSpeedRouteFacts {
  const model = input.model ?? null;
  const runtimeModel = model ? resolveModelAlias(model) : null;
  return {
    modelSelection: input.modelSelection,
    runtimeModel,
    ...(model && runtimeModel !== model ? { equivalentModels: [model] } : {}),
    modelSource: input.modelSource ?? null,
    harness: input.harness ?? null,
    routeProfile: resolveRouteProfile(input),
  };
}

const CHECKING_REASON = 'Checking whether Ultra fast can run for this model.';
const CHECKING: CodexSpeedChoiceState = {
  selectable: false,
  shortReason: 'Checking availability',
  reason: CHECKING_REASON,
};

/** Reasons that answer the question, rather than failing to. */
function isDefinite(availability: CodexSpeedAvailability): boolean {
  switch (availability.reason) {
    case 'auto-model':
    case 'no-model':
    case 'route-not-native':
    case 'model-unlisted':
    case 'not-advertised':
    case 'denied':
      return true;
    case 'route-unknown':
    case 'catalog-unknown':
    case 'catalog-truncated':
    case 'model-ambiguous':
    case 'tiers-unknown':
    case 'not-gated':
    case 'advertised':
      return false;
  }
}

function shortReason(availability: CodexSpeedAvailability): string {
  switch (availability.reason) {
    case 'auto-model':
    case 'no-model':
      return 'Choose a specific model';
    case 'route-not-native':
      return 'Not available on this connection';
    case 'model-unlisted':
    case 'not-advertised':
      return 'Not offered for this model';
    case 'denied':
      return 'Recently declined';
    case 'route-unknown':
    case 'catalog-unknown':
    case 'catalog-truncated':
    case 'model-ambiguous':
    case 'tiers-unknown':
    case 'not-gated':
    case 'advertised':
      return "Couldn't confirm availability";
  }
}

function toChoiceState(
  availability: CodexSpeedAvailability,
): CodexSpeedChoiceState {
  if (availability.status === 'available') return { selectable: true };
  return {
    selectable: false,
    shortReason: shortReason(availability),
    reason:
      describeCodexSpeedAvailability(availability) ??
      "Couldn't confirm Ultra fast for this model. Try again, or choose Regular or Fast.",
    ...(isDefinite(availability) ? { definite: true } : {}),
  };
}

const ALWAYS: CodexSpeedChoiceState = { selectable: true };

/**
 * Per-speed selector view. Regular and Fast are never gated. Ultra fast is
 * selectable only when the shared helper reports it available; loading and
 * an unresolved model stay "checking", distinct from a definite answer.
 */
export function codexSpeedChoiceStates({
  route,
  status,
  options,
}: {
  route: CodexSpeedRouteFacts;
  status: CodexSpeedCapabilities['status'];
  options: Record<CodexSpeed, CodexSpeedAvailability>;
}): CodexSpeedChoiceStates {
  const ultrafast = options.ultrafast;
  const unresolvedModel = route.modelSource === null || route.harness === null;
  const checking =
    ultrafast.status === 'unknown' && status === 'loading'
      ? true
      : unresolvedModel && ultrafast.status !== 'available';
  return {
    standard: ALWAYS,
    fast: ALWAYS,
    ultrafast: checking ? CHECKING : toChoiceState(ultrafast),
  };
}

/**
 * Why the requested speed cannot run for the next request, or `null`. Only
 * Ultra fast is ever blocked, and never while the first catalog read is in
 * flight, so reopening a saved Ultra fast chat does not flash a warning.
 */
export function codexSpeedBlockedReason(
  speed: CodexSpeed,
  states: CodexSpeedChoiceStates,
  status: CodexSpeedCapabilities['status'],
): string | null {
  if (speed !== 'ultrafast' || status === 'loading') return null;
  const state = states.ultrafast;
  if (state.selectable || state === CHECKING) return null;
  return state.reason ?? null;
}

/**
 * The speed a composer steps a requested speed down to, or `null` to keep
 * it. Only an Ultra fast that definitely cannot run on this route moves: to
 * Fast, or to Regular when Fast cannot be chosen either. A check in flight or
 * one that could not be confirmed keeps the selection, so a failed read never
 * rewrites a saved choice.
 */
export function codexSpeedDowngrade(
  speed: CodexSpeed,
  states: CodexSpeedChoiceStates,
  status: CodexSpeedCapabilities['status'],
): CodexSpeed | null {
  if (codexSpeedBlockedReason(speed, states, status) === null) return null;
  if (states[speed].definite !== true) return null;
  return states.fast.selectable ? 'fast' : 'standard';
}

/**
 * Availability for a Codex DEFAULT, which applies to chats on any model. Ultra
 * fast can be chosen only when the scoped `defaults` route projection says the
 * default route is native or the account proxy AND some model on that
 * connection advertises it;
 * without the projection it stays unconfirmed. Each chat still resolves its
 * own model and route before it runs.
 */
export function codexSpeedConnectionStates(
  catalog: CodexSpeedCatalog | null,
  status: CodexSpeedCapabilities['status'],
  routeProfile?: CodexSpeedRouteProfile,
): CodexSpeedChoiceStates {
  // The account proxy route needs a model both its own list and the runtime
  // catalog offer Ultra fast for; a list it never read stays unconfirmed.
  const proxyCatalog =
    routeProfile === 'account-proxy'
      ? catalog?.routes?.['account-proxy']
      : null;
  const proxyAdvertises = (model: string): boolean =>
    routeProfile !== 'account-proxy' ||
    (proxyCatalog?.models.some(
      (entry) =>
        (entry.model === model || entry.id === model) &&
        entry.tiers?.includes('ultrafast') === true,
    ) ??
      false);
  const proxyUnconfirmed =
    routeProfile === 'account-proxy' &&
    (!proxyCatalog ||
      proxyCatalog.status !== 'ready' ||
      proxyCatalog.truncated ||
      proxyCatalog.models.some((entry) => entry.tiers === null));
  const unconfirmed: CodexSpeedChoiceState = {
    selectable: false,
    shortReason: "Couldn't confirm availability",
    reason:
      "Couldn't confirm Ultra fast for this Codex connection. Try again, or choose Regular or Fast.",
  };
  let ultrafast: CodexSpeedChoiceState;
  if (!catalog || status === 'loading') {
    ultrafast = {
      ...CHECKING,
      reason: 'Checking whether this Codex connection offers Ultra fast.',
    };
  } else if (routeProfile === undefined || routeProfile === 'unknown') {
    ultrafast = unconfirmed;
  } else if (!isCodexSpeedCatalogRouteProfile(routeProfile)) {
    ultrafast = {
      selectable: false,
      shortReason: 'Not available on this connection',
      reason:
        'Ultra fast runs only on a Codex sign-in. Choose Regular or Fast for this connection.',
    };
  } else if (catalog.status !== 'ready') {
    ultrafast = unconfirmed;
  } else if (
    catalog.models.some(
      (model) =>
        model.tiers?.includes('ultrafast') === true &&
        proxyAdvertises(model.model),
    )
  ) {
    ultrafast = ALWAYS;
  } else if (
    catalog.truncated ||
    catalog.models.some((model) => model.tiers === null) ||
    proxyUnconfirmed
  ) {
    ultrafast = unconfirmed;
  } else {
    ultrafast = {
      selectable: false,
      shortReason: 'Not offered on this Codex connection',
      reason:
        "This Codex connection doesn't offer Ultra fast. Choose Regular or Fast.",
    };
  }
  return { standard: ALWAYS, fast: ALWAYS, ultrafast };
}

export interface CodexSpeedControl {
  states: CodexSpeedChoiceStates;
  status: CodexSpeedCapabilities['status'];
  refreshing: boolean;
  /** Offer "Check again" in full pickers: availability is unknown or failed. */
  canRefresh: boolean;
  /** Forced, deduplicated revalidation of the shared catalog. */
  refresh: () => void;
  /** See {@link codexSpeedBlockedReason}. */
  blockedReason: (speed: CodexSpeed) => string | null;
  /** See {@link codexSpeedDowngrade}. */
  downgrade: (speed: CodexSpeed) => CodexSpeed | null;
}

/**
 * Availability view for a mounted Codex speed selector. `enabled` is false
 * for surfaces that show no Codex speed (other providers), which keeps them
 * out of the active-consumer set and away from the catalog entirely.
 *
 * Composers re-render on every keystroke, so the registry lookups behind the
 * route run only when a route fact changes or the model catalog, policy, or
 * harness assignments hydrate; callers may pass a new request each render.
 */
export function useCodexSpeedControl({
  enabled,
  route,
}: {
  enabled: boolean;
  route: CodexSpeedRouteRequest;
}): CodexSpeedControl {
  const {
    model = null,
    auto,
    capturedHarness,
    aiCreditsRouted,
    routeProfile,
  } = route;
  const capabilities = useCodexSpeedCapabilities({
    enabled,
    model,
    routeProfile,
  });
  const { catalog, status, refreshing, error, refresh } = capabilities;
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const harnessRevision = useModelCatalogStore(
    (state) => state.harnessAssignments?.revision ?? -1,
  );
  const input = useMemo(
    () =>
      codexSpeedRouteInput({
        model,
        auto,
        capturedHarness,
        aiCreditsRouted,
        routeProfile,
      }),
    // The registry versions invalidate the lookups without being read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      model,
      auto,
      capturedHarness,
      aiCreditsRouted,
      routeProfile,
      modelFactsVersion,
      harnessRevision,
    ],
  );
  const states = useMemo(() => {
    const facts = resolveCodexSpeedRouteFacts(input);
    return codexSpeedChoiceStates({
      route: facts,
      status,
      options: deriveCodexSpeedOptions({
        catalog,
        route: facts,
        now: Date.now(),
      }),
    });
  }, [catalog, status, input]);

  return useMemo<CodexSpeedControl>(
    () => ({
      states,
      status,
      refreshing,
      canRefresh:
        status !== 'loading' &&
        (status === 'unknown' ||
          error !== null ||
          states.ultrafast.shortReason === "Couldn't confirm availability"),
      refresh: (): void => {
        void refresh();
      },
      blockedReason: (speed) => codexSpeedBlockedReason(speed, states, status),
      downgrade: (speed) => codexSpeedDowngrade(speed, states, status),
    }),
    [states, status, refreshing, error, refresh],
  );
}
