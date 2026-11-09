import { isNativeOpenCodeSelection } from '@canopy/desktop-shared/lib/chat-model-selection';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  getEffectiveModelContextWindow,
  getListedModelContextWindow,
  type ChatModel,
  type ModelHarness,
  type ChatTabUsage,
} from '@canopy/desktop-shared/types';

/** A managed OpenCode choice uses its route capacity, independently of the model source. */
function effectiveContextWindow(
  model: ChatModel,
  aiCreditsRouted: boolean,
  executionHarness?: ModelHarness,
): number | undefined {
  if (executionHarness === 'opencode' && !isNativeOpenCodeSelection(model)) {
    return resolveGatewayModelEntry(model)?.contextWindow;
  }
  return getEffectiveModelContextWindow(model, aiCreditsRouted);
}

export function normalizePersistedUsage(
  usage: ChatTabUsage | undefined,
  model: ChatModel | undefined,
  aiCreditsRouted = false,
  executionHarness?: ModelHarness,
): ChatTabUsage | undefined {
  if (!usage || !model) {
    return usage;
  }

  const configuredContextWindow = effectiveContextWindow(
    model,
    aiCreditsRouted,
    executionHarness,
  );
  if (
    typeof configuredContextWindow !== 'number' ||
    usage.contextWindow === configuredContextWindow
  ) {
    return usage;
  }

  return {
    ...usage,
    contextWindow: configuredContextWindow,
  };
}

/**
 * The window a new or re-modelled tab starts with. A Codex model has only its
 * listed window, which stands in until Codex reports its effective one (95% of
 * it); persisted usage is never normalized to it.
 */
function startingContextWindow(
  model: ChatModel,
  aiCreditsRouted: boolean,
  executionHarness?: ModelHarness,
): number | undefined {
  const configured = effectiveContextWindow(
    model,
    aiCreditsRouted,
    executionHarness,
  );
  if (executionHarness === 'opencode' && !isNativeOpenCodeSelection(model))
    return configured;
  return configured ?? getListedModelContextWindow(model);
}

/**
 * A fresh `ChatTabUsage` for a chat whose provider session has not produced a
 * turn yet: every counter at zero, sized to the model's configured context
 * window so the composer meter stays alive instead of going dead until the
 * first result event (CAN-2799).
 *
 * `undefined` when the model is unknown or has no configured context window:
 * a synthetic window of 0 would render as a broken meter, and the indicator
 * already handles a missing usage.
 */
export function createSeededTabUsage(
  model: ChatModel | undefined,
  aiCreditsRouted = false,
  executionHarness?: ModelHarness,
): ChatTabUsage | undefined {
  if (!model) {
    return undefined;
  }
  const contextWindow = startingContextWindow(
    model,
    aiCreditsRouted,
    executionHarness,
  );
  if (typeof contextWindow !== 'number' || contextWindow <= 0) {
    return undefined;
  }
  return {
    contextTokens: 0,
    contextWindow,
    maxOutputTokens: 0,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 0,
    model,
  };
}

/**
 * The tab usage after an in-place model change. Token counts and cost are the
 * chat's own running total and carry unchanged; only the context window (and
 * the model the popover names) follow the new model, so the percentage is
 * right in the interim before the next result event. A model with no
 * configured window gets none (0) rather than the previous model's: the meter
 * hides until the provider reports the real window. A tab with no usage yet
 * is seeded like a fresh session.
 */
export function resolveTabUsageForModel(
  usage: ChatTabUsage | undefined,
  model: ChatModel,
  aiCreditsRouted = false,
  executionHarness?: ModelHarness,
): ChatTabUsage | undefined {
  if (!usage) {
    return createSeededTabUsage(model, aiCreditsRouted, executionHarness);
  }
  const configuredContextWindow = startingContextWindow(
    model,
    aiCreditsRouted,
    executionHarness,
  );
  const contextWindow =
    typeof configuredContextWindow === 'number' && configuredContextWindow > 0
      ? configuredContextWindow
      : 0;
  if (usage.contextWindow === contextWindow && usage.model === model) {
    return usage;
  }
  return { ...usage, contextWindow, model };
}
