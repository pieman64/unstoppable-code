import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  isModelRoutingContextWarm,
  MODEL_ROUTING_MAX_CONTEXT_TOKENS,
  type AutoModelRoutingRequestV1,
  type AutoModelRoutingResponseV1,
  type ModelExecutionLane,
  type ModelRoutingAttributionV1,
  type ModelRoutingCurrentContext,
  type ModelRoutingHarness,
} from '@canopy/protocol/model-routing';
import {
  AI_GATEWAY_MODELS,
  CLAUDE_MODELS,
  CODEX_MODELS,
  getEffectiveSupportedThinkingLevelsForModel,
  getExecutionHarnessForModel,
  getModelDescription,
  getModelDisplayName,
  getModelSource,
  type ChatModel,
  type ChatSendMessageRequest,
  type PersistedChatTab,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  isGatewayRoutableModel,
  resolveGatewayModelEntry,
} from '@canopy/execution-engine/lib/gateway-model-availability';
import { isCodexModelAvailableToAccount } from '@canopy/desktop-shared/lib/default-model-lane';
import { isOpenCodeGatewayRouteSupported } from '@canopy/desktop-shared/lib/opencode-gateway-models';
import { isProviderNativelyAuthenticatedForRouting } from '../auth/provider-auth-state';
import { isModelBlockedByStoredPolicy } from '../lib/model-policy-state';
import { buildDesktopRoutingCandidateSet } from './candidates';
import { readCodexAccountModelIds } from './codex-account-models';
import { buildDesktopAutoRoutingState } from './context';
import { resolveDesktopAutoModel } from './client';

export interface DesktopAutoTurnResolution {
  modelId: ChatModel;
  harness: ModelRoutingHarness;
  durableLoss: boolean;
  attribution: ModelRoutingAttributionV1;
}

function uniqueModels(): ChatModel[] {
  return Array.from(
    new Set([...CLAUDE_MODELS, ...CODEX_MODELS, ...AI_GATEWAY_MODELS]),
  );
}

function defaultsForSurface(
  preferences: PreferencesData,
  standalone: boolean,
): Partial<Record<ModelRoutingHarness, string>> {
  const defaults = standalone
    ? preferences.defaultChatModelByProvider
    : preferences.defaultWorktreeModelByProvider;
  return {
    claude: defaults.claude.model,
    codex: defaults.codex.model,
    opencode: defaults.opencode?.model,
  };
}

function hasPriorConversation(
  tab: PersistedChatTab,
  userMessageId: string,
): boolean {
  if ((tab.transcript?.messageCount ?? 0) > 1) return true;
  return tab.messages.some(
    (message) =>
      message.id !== userMessageId &&
      (message.role === 'user' || message.role === 'assistant'),
  );
}

/**
 * The current model's conversation as its prompt cache sees it: the latest
 * context fill and how long ago the chat was last active. Absent for a first
 * turn or when usage hasn't been reported yet.
 */
function currentContextFor(
  tab: PersistedChatTab,
  userMessageId: string,
): ModelRoutingCurrentContext | undefined {
  const tokens = Math.round(tab.usage?.contextTokens ?? 0);
  if (tokens <= 0) return undefined;
  let lastActivityAt = 0;
  for (const message of tab.messages) {
    if (message.id === userMessageId) continue;
    lastActivityAt = Math.max(lastActivityAt, message.timestamp);
    for (const block of message.blocks) {
      if (
        block.type === 'turn_timer' &&
        typeof block.completedAt === 'number'
      ) {
        lastActivityAt = Math.max(lastActivityAt, block.completedAt);
      }
    }
  }
  if (lastActivityAt === 0) return undefined;
  return {
    tokens: Math.min(tokens, MODEL_ROUTING_MAX_CONTEXT_TOKENS),
    idleMs: Math.max(0, Date.now() - lastActivityAt),
  };
}

export async function routeDesktopAutoTurn(input: {
  request: ChatSendMessageRequest;
  tab: PersistedChatTab;
  preferences: PreferencesData;
  standalone: boolean;
  workspace: 'single-repo' | 'multi-repo' | 'cowork';
  signal?: AbortSignal;
  /** Owner bound to the chat session; sent with the resolve call (CAN-3462). */
  workOwner?: WorkOwner;
}): Promise<DesktopAutoTurnResolution | null> {
  const openCode =
    input.tab.executionHarness === 'opencode' ||
    input.tab.providerType === 'opencode' ||
    input.request.executionHarness === 'opencode';
  const currentRoute = input.request.model
    ? resolveGatewayModelEntry(input.request.model)
    : undefined;
  // Native accounts and customer gateways never enter the hosted credits lane.
  if (openCode && (!currentRoute || currentRoute.origin === 'org-gateway'))
    return null;
  const lane: ModelExecutionLane =
    openCode || input.request.aiCreditsRouting
      ? 'ai_credits'
      : 'provider_subscription';
  const priorConversation = hasPriorConversation(
    input.tab,
    input.request.userMessageId,
  );
  const currentContext = priorConversation
    ? currentContextFor(input.tab, input.request.userMessageId)
    : undefined;
  const captured = priorConversation
    ? (input.tab.executionHarness ??
      (input.tab.model
        ? getExecutionHarnessForModel(input.tab.model)
        : undefined))
    : undefined;
  const capturedHarness = openCode
    ? 'opencode'
    : captured === 'claude' || captured === 'codex'
      ? captured
      : undefined;
  const harnesses: ModelRoutingHarness[] = capturedHarness
    ? [capturedHarness]
    : ['claude', 'codex'];
  const authenticatedHarnesses = new Set<ModelRoutingHarness>();
  if (lane === 'provider_subscription') {
    await Promise.all(
      harnesses.map(async (harness) => {
        if (harness === 'opencode') return;
        if (
          await isProviderNativelyAuthenticatedForRouting(
            harness,
            'auto-model-routing',
          )
        ) {
          authenticatedHarnesses.add(harness);
        }
      }),
    );
  }

  // A Codex sign-in may run only some of the catalog's Codex models (a
  // ChatGPT account rejects several an API key accepts). The account's own
  // list decides; an unknown list keeps every native model, as before.
  const codexAccountModels = authenticatedHarnesses.has('codex')
    ? await readCodexAccountModelIds()
    : null;

  const thinkingLevel =
    input.request.modelConfig?.thinkingLevel ??
    input.request.thinkingLevel ??
    'high';
  const state = buildDesktopAutoRoutingState({
    request: input.request,
    tab: input.tab,
    workspace: input.workspace,
  });
  if (openCode) {
    // Managed OpenCode does not advertise a native effort or speed setting.
    delete state.mode.thinkingLevel;
    state.mode.fast = false;
  }
  const models = await Promise.all(
    uniqueModels().map(async (id) => {
      const route = resolveGatewayModelEntry(id);
      const harness = openCode ? 'opencode' : getExecutionHarnessForModel(id);
      if (harness !== 'claude' && harness !== 'codex' && harness !== 'opencode')
        return null;
      // Outside OpenCode, Auto negotiates only Claude/Codex routes. A gateway
      // model assigned the OpenCode harness must not join that candidate set.
      if (!openCode && harness === 'opencode') return null;
      // The picker's managed Auto check cannot see attachments, so it may offer
      // Auto with fewer eligible routes here. Too few keeps the current model.
      if (
        openCode &&
        (!route ||
          route.origin === 'org-gateway' ||
          !isOpenCodeGatewayRouteSupported(route) ||
          (state.attachmentCounts.images > 0 && route.supportsImages !== true))
      )
        return null;
      const source = getModelSource(id);
      return {
        id,
        // The server resolves candidates against the AI Gateway catalog, which
        // is keyed by catalog id and `gatewayId` — never by Canopy's local
        // picker id. Native-only models have no gateway route and are carried
        // by their package id, which is the identity the server's native list
        // uses.
        wireModelId: resolveGatewayModelEntry(id)?.gatewayId ?? id,
        label: getModelDisplayName(id),
        description: getModelDescription(id),
        harness,
        native:
          !openCode &&
          source === `${harness}-managed` &&
          (harness !== 'codex' ||
            isCodexModelAvailableToAccount(id, codexAccountModels)),
        gateway: isGatewayRoutableModel(id),
        supportsThinking:
          openCode ||
          getEffectiveSupportedThinkingLevelsForModel(
            id,
            lane === 'ai_credits',
            harness,
            harness,
          ).includes(thinkingLevel),
        blocked: await isModelBlockedByStoredPolicy(id, input.workOwner),
      };
    }),
  );
  const candidateSet = buildDesktopRoutingCandidateSet({
    models: models.filter((model) => model !== null),
    lane,
    ...(capturedHarness ? { capturedHarness } : {}),
    authenticatedHarnesses,
    defaultModelByHarness: defaultsForSurface(
      input.preferences,
      input.standalone,
    ),
    ...(input.request.model ? { currentModelId: input.request.model } : {}),
  });
  if (candidateSet.fallbackModelId === null) return null;

  const resolutionFromResponse = (
    response: AutoModelRoutingResponseV1,
    durableLoss: boolean,
  ): DesktopAutoTurnResolution | null => {
    const selected = candidateSet.candidates.find(
      (candidate) => candidate.modelId === response.modelId,
    );
    if (!selected) return null;
    const selectedLocalId = candidateSet.localModelIdByWireId.get(
      selected.modelId,
    );
    if (selectedLocalId === undefined) return null;
    const benchmark = candidateSet.candidates.find(
      (candidate) =>
        candidate.harness === selected.harness && candidate.isDefault === true,
    );
    const benchmarkLocalId =
      benchmark === undefined
        ? undefined
        : candidateSet.localModelIdByWireId.get(benchmark.modelId);
    return {
      modelId: selectedLocalId,
      harness: selected.harness,
      durableLoss,
      attribution: {
        schemaVersion: 1,
        selectionMode: 'auto',
        outcome: response.outcome,
        executionLane: lane,
        ...(benchmarkLocalId ? { benchmarkModelId: benchmarkLocalId } : {}),
        selectedModelId: selectedLocalId,
        // Switching away from a warm model makes the new one re-read the
        // conversation uncached; the savings benchmark prices it as cached.
        ...(selectedLocalId !== input.request.model &&
        isModelRoutingContextWarm(currentContext)
          ? { cacheMissContextTokens: currentContext.tokens }
          : {}),
        ...(response.routingCostUsd !== undefined
          ? { routingCostUsd: response.routingCostUsd }
          : {}),
        ...(response.routingCredits !== undefined
          ? { routingCredits: response.routingCredits }
          : {}),
        savings: {
          status: benchmarkLocalId ? 'incomplete_usage' : 'default_unavailable',
        },
      },
    };
  };

  // Wire identity, like every other model id in this payload.
  const currentWireModelId = input.request.model
    ? (resolveGatewayModelEntry(input.request.model)?.gatewayId ??
      input.request.model)
    : undefined;
  const routingRequest: AutoModelRoutingRequestV1 = {
    schemaVersion: 1,
    requestId: input.request.userMessageId,
    surface: 'desktop',
    ...(currentWireModelId ? { currentModelId: currentWireModelId } : {}),
    ...(currentContext ? { currentContext } : {}),
    fallbackModelId: candidateSet.fallbackModelId,
    ...(capturedHarness ? { capturedHarness } : {}),
    executionLane: lane,
    candidates: candidateSet.candidates,
    state,
  };
  const resolved = await resolveDesktopAutoModel(routingRequest, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.workOwner ? { workOwner: input.workOwner } : {}),
  });
  // Everything past this point is local identity again: dispatch, the model
  // change, pricing, and the audit attribution all speak Canopy model ids.
  return resolutionFromResponse(resolved.response, resolved.durableLoss);
}
