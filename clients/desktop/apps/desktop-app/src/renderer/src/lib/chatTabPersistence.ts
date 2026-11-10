import {
  getProviderForModel,
  inferLegacyExecutionHarness,
  normalizeAgentModelConfig,
  normalizePersistedThinkingLevel,
  resolveProviderModelConfig,
  normalizeThinkingForProvider,
  resolveKnownModel,
  type AgentModelConfig,
  type AgentProviderType,
  type ChatModel,
  type ChatTabPluginSelections,
  type LlmProviderUsageLimitBannerState,
  type PersistedChatTab,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import { readCodexSpeedRecord } from '@canopy/execution-engine/lib/codex-speed';
import { normalizePersistedUsage } from '@/lib/chatUsageNormalization';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import type { ChatTab } from '@/stores/chatStore';
import {
  codexSpeedFields,
  retainedCodexSpeedFields,
  withoutCodexSpeed,
} from '@/stores/chat/codex-speed';
import { readPersistedMemoryByMessageId } from '@/stores/chat/memory';
import { normalizePendingClaudeTerminalWatcherMessages } from '@/stores/chat/pendingClaudeTerminalWatchers';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLlmProviderUsageLimitBannerState(
  value: unknown,
): value is LlmProviderUsageLimitBannerState {
  return (
    isRecord(value) &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    typeof value.message === 'string' &&
    typeof value.detectedAt === 'number' &&
    typeof value.dismissKey === 'string'
  );
}

/**
 * Read-compat: extract the legacy `claudeUsageLimitBanner` /
 * `dismissedClaudeUsageLimitBannerKey` keys from a raw persisted tab object
 * written before the `LlmProvider*` rename, so tabs already on disk keep
 * showing their most recent usage-limit banner state. `raw` is treated as
 * `unknown` here (not the renamed `PersistedChatTab` type, which no longer
 * declares the legacy keys) so the lookup works regardless of the caller's
 * static type. Exported so other tab-hydration paths (e.g. `chatStore.ts`'s
 * `fromPersistedTab`) can apply the same compat mapping.
 */
export function readLegacyUsageLimitBannerFields(raw: unknown): {
  banner?: LlmProviderUsageLimitBannerState;
  dismissedKey?: string;
} {
  if (!isRecord(raw)) {
    return {};
  }
  const banner = isLlmProviderUsageLimitBannerState(raw.claudeUsageLimitBanner)
    ? raw.claudeUsageLimitBanner
    : undefined;
  const dismissedKey =
    typeof raw.dismissedClaudeUsageLimitBannerKey === 'string'
      ? raw.dismissedClaudeUsageLimitBannerKey
      : undefined;
  return { banner, dismissedKey };
}

/** Persisted extension fields only, never a spread of renderer runtime state.
 * Reference extensions use the Ref/Refs suffix and remain opaque here. Neither
 * projection changes blocks or their bodies, so the references remain coherent.
 */
export function persistedRowExtensionFields(
  row: object,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        key.endsWith('Ref') ||
        key.endsWith('Refs') ||
        [
          'delegationSequence',
          'delegationAuthor',
          'delegationDelivery',
          'delegationSegment',
          'itemRevision',
          'final',
          'truncated',
        ].includes(key),
    ),
  );
}

/**
 * Hydrate a single persisted tab into a live ChatTab.
 *
 * This is the per-tab mapping logic previously embedded inside
 * `fromPersistedTabs` in chatStore.ts, extracted so it can be reused by
 * standalone-chat resume/duplicate flows and anywhere else that needs to
 * materialise a ChatTab from persisted data.
 */
export function hydratePersistedChatTab(
  pt: PersistedChatTab,
  defaults?: {
    pluginSelections?: ChatTabPluginSelections;
    model?: ChatModel;
    thinkingLevel?: ThinkingLevel;
    modelConfig?: AgentModelConfig;
    /** @deprecated Use modelConfig.speed. Read after the default record. */
    codexFastModeEnabled?: boolean;
  },
): ChatTab {
  const persistedMessages = sanitizePersistedChatMessages(pt.messages);
  const pendingClaudeTerminalWatcherMessages =
    normalizePendingClaudeTerminalWatcherMessages(
      pt.pendingClaudeTerminalWatcherMessages,
    );
  const userMessageIds = new Set(
    persistedMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  );
  const persistedMemory = readPersistedMemoryByMessageId(pt, userMessageIds);
  const artifactCarry = normalizeAgentArtifactCarryByTurn(
    pt.agentArtifactCarryByTurn,
    userMessageIds,
  );
  // Resolve the persisted model against the registry, but preserve an
  // unresolved id as-is instead of rewriting it to the default: flag-gated
  // models (e.g. LaunchDarkly-gated entries) hydrate before the registry is
  // flag-initialized, and coercing here would permanently rewrite the tab on
  // every relaunch. Display falls back to the raw id and send-time
  // `resolveKnownModel` gating still protects the agent invocation.
  const validModel = pt.model
    ? (resolveKnownModel(pt.model) ?? pt.model)
    : defaults?.model;
  const aiCreditsRouted =
    pt.aiCreditsRouted ??
    (pt.aiCreditsRouting?.active === true ||
      (validModel !== undefined && isGatewayOnlyModel(validModel)));
  const usage = normalizePersistedUsage(
    pt.usage,
    validModel,
    aiCreditsRouted,
    pt.executionHarness ??
      (pt.providerType === 'opencode' ? 'opencode' : undefined),
  );

  // Restore providerType from persisted data; derive from model if absent
  const providerType: AgentProviderType | undefined =
    pt.providerType ??
    (validModel ? getProviderForModel(validModel) : undefined);
  const executionHarness =
    (pt.transcript?.messageCount ??
      pt.transcript?.committedMessageCount ??
      pt.messages.length) > 0 || pt.executionHarnessExplicitlyChosen === true
      ? (pt.executionHarness ??
        inferLegacyExecutionHarness({
          model: validModel,
          providerType,
          hasStarted: true,
        }))
      : undefined;

  // Migrate any legacy persisted thinking level uniformly across providers
  // (`auto -> high`); fall back to the provided default (or 'high') when the
  // persisted field is missing / unrecognized. After normalization, route the
  // level through `normalizeThinkingForProvider` so provider-specific clamping
  // (handled in the backend for wire values) is reflected in the hydrated UI
  // state too.
  const persistedModelConfig = normalizeAgentModelConfig(pt.modelConfig);
  // Records are read speed-first, the tab's own record (speed, its boolean,
  // then the legacy tab alias) before the default record (speed, its boolean,
  // then the deprecated default alias). A persisted Ultra fast therefore
  // hydrates as Ultra fast, and an explicit legacy choice on the tab still
  // beats an Ultra fast default. Any speed on the tab's record is explicit.
  const persistedSpeed = readCodexSpeedRecord(
    persistedModelConfig,
    pt.codexFastModeEnabled,
  );
  const requestedSpeed =
    persistedSpeed ??
    readCodexSpeedRecord(defaults?.modelConfig, defaults?.codexFastModeEnabled);
  const fastModeExplicit = persistedSpeed !== undefined;
  const compatibilityModelConfig: AgentModelConfig = {
    ...withoutCodexSpeed(defaults?.modelConfig),
    ...withoutCodexSpeed(persistedModelConfig),
    ...(requestedSpeed === undefined ? {} : codexSpeedFields(requestedSpeed)),
  };
  const thinkingFallback: ThinkingLevel =
    compatibilityModelConfig.thinkingLevel ?? defaults?.thinkingLevel ?? 'high';
  const normalizedPersistedThinking = normalizePersistedThinkingLevel(
    persistedModelConfig?.thinkingLevel ?? pt.thinkingLevel,
    thinkingFallback,
  );
  const legacyThinkingLevel: ThinkingLevel = providerType
    ? normalizeThinkingForProvider(normalizedPersistedThinking, providerType)
    : normalizedPersistedThinking;
  const modelConfig = resolveProviderModelConfig(
    providerType ?? 'claude',
    {
      thinkingLevel: legacyThinkingLevel,
      modelConfig: {
        ...compatibilityModelConfig,
        thinkingLevel:
          persistedModelConfig?.thinkingLevel ?? legacyThinkingLevel,
      },
    },
    undefined,
  );

  // Read-compat: prefer the new key, fall back to the legacy
  // `claudeUsageLimitBanner` / `dismissedClaudeUsageLimitBannerKey` keys for
  // tabs persisted before the `LlmProvider*` rename.
  const legacyUsageLimitBanner = readLegacyUsageLimitBannerFields(pt);
  const llmProviderUsageLimitBanner =
    pt.llmProviderUsageLimitBanner ?? legacyUsageLimitBanner.banner;
  const dismissedLlmProviderUsageLimitBannerKey =
    pt.dismissedLlmProviderUsageLimitBannerKey ??
    legacyUsageLimitBanner.dismissedKey;

  return {
    id: pt.id,
    title: pt.title,
    ...(pt.transcript ? { transcript: pt.transcript } : {}),
    ...(pt.transcriptLoaded !== undefined
      ? { transcriptLoaded: pt.transcriptLoaded }
      : {}),
    ...(pt.transcriptWindow ? { transcriptWindow: pt.transcriptWindow } : {}),
    ...(typeof pt.aiCreditsRouted === 'boolean' || aiCreditsRouted
      ? { aiCreditsRouted }
      : {}),
    ...(pt.kind === 'file' ? { kind: pt.kind } : {}),
    ...(pt.filePath ? { filePath: pt.filePath } : {}),
    ...(pt.fileViewMode ? { fileViewMode: pt.fileViewMode } : {}),
    ...(pt.description ? { description: pt.description } : {}),
    messages: persistedMessages.map((msg) => ({
      ...persistedRowExtensionFields(msg),
      id: msg.id,
      role: msg.role,
      ...(msg.hidden ? { hidden: true } : {}),
      blocks: msg.blocks,
      timestamp: msg.timestamp,
      ...(msg.parentToolUseId ? { parentToolUseId: msg.parentToolUseId } : {}),
      // Provider-neutral grouping link. Codex `codex_agent_call` subagent
      // messages stamp `parentBlockId` so the renderer can re-group them under
      // the owning `codex_agent` display block on rehydrate without relying on
      // tool-name heuristics.
      ...(msg.parentBlockId ? { parentBlockId: msg.parentBlockId } : {}),
      // Codex protocol thread/turn ids — preserved verbatim so the reducer's
      // grouping logic continues to work after a cold reload.
      ...(msg.codexThreadId ? { codexThreadId: msg.codexThreadId } : {}),
      ...(msg.codexTurnId ? { codexTurnId: msg.codexTurnId } : {}),
      ...(msg.attachmentPaths?.length
        ? { attachmentPaths: msg.attachmentPaths }
        : {}),
      ...(msg.attachmentPromptContexts?.length
        ? { attachmentPromptContexts: msg.attachmentPromptContexts }
        : {}),
      ...(msg.inputMode ? { inputMode: msg.inputMode } : {}),
      ...(msg.watcherFired ? { watcherFired: msg.watcherFired } : {}),
      ...(msg.agentSent ? { agentSent: msg.agentSent } : {}),
    })),
    status: 'idle',
    error: null,
    createdAt: pt.createdAt,
    queuedMessages: [],
    ...(persistedMemory ? { memoryByMessageId: persistedMemory } : {}),
    ...(artifactCarry ? { agentArtifactCarryByTurn: artifactCarry } : {}),
    ...(pt.inputDelivery ? { inputDelivery: pt.inputDelivery } : {}),
    planMode: pt.planMode ?? false,
    proposalMode: pt.proposalMode ?? 'optional',
    thinkingLevel: modelConfig.thinkingLevel,
    modelConfig,
    fastModeExplicit,
    ...(pt.kind !== 'file' && providerType === 'codex'
      ? { codexFastModeEnabled: modelConfig.fastMode }
      : {}),
    ...retainedCodexSpeedFields(pt.retainedCodexSpeed),
    ...(validModel ? { model: validModel } : {}),
    ...(providerType ? { providerType } : {}),
    ...(executionHarness ? { executionHarness } : {}),
    ...(pt.executionHarnessExplicitlyChosen === true
      ? { executionHarnessExplicitlyChosen: true }
      : {}),
    ...(pt.pendingPlanExit ? { pendingPlanExit: pt.pendingPlanExit } : {}),
    ...(pt.trackedPlanId ? { trackedPlanId: pt.trackedPlanId } : {}),
    ...(pt.trackedPlanSource
      ? { trackedPlanSource: pt.trackedPlanSource }
      : {}),
    ...(pt.trackedPlanReviewStatus
      ? { trackedPlanReviewStatus: pt.trackedPlanReviewStatus }
      : {}),
    ...(pt.pendingSystemInstructions?.length
      ? { pendingSystemInstructions: pt.pendingSystemInstructions }
      : {}),
    ...(pt.hasOutstandingProposal ? { hasOutstandingProposal: true } : {}),
    ...(pt.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: pt.latestRevisionNumber }
      : {}),
    ...(pt.sdkSessionId ? { sdkSessionId: pt.sdkSessionId } : {}),
    ...(pt.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: pt.globalInstructionsSnapshot }
      : {}),
    ...(pt.newChatStartedWatcherPending
      ? { newChatStartedWatcherPending: true }
      : {}),
    ...(pt.newChatStartedWatcherFiredAt
      ? { newChatStartedWatcherFiredAt: pt.newChatStartedWatcherFiredAt }
      : {}),
    ...(pt.pendingRevertAttachmentPath
      ? { pendingRevertAttachmentPath: pt.pendingRevertAttachmentPath }
      : {}),
    ...(pendingClaudeTerminalWatcherMessages?.length
      ? { pendingClaudeTerminalWatcherMessages }
      : {}),
    ...(typeof pt.scheduledSendDraft?.runAt === 'string'
      ? { scheduledSendDraft: { runAt: pt.scheduledSendDraft.runAt } }
      : {}),
    ...(pt.readOnly ? { readOnly: true } : {}),
    ...(pt.staleSessionDetected
      ? { staleSessionDetected: pt.staleSessionDetected }
      : {}),
    ...(llmProviderUsageLimitBanner ? { llmProviderUsageLimitBanner } : {}),
    ...(dismissedLlmProviderUsageLimitBannerKey
      ? {
          dismissedLlmProviderUsageLimitBannerKey,
        }
      : {}),
    ...(pt.aiCreditsNoBillingSource
      ? { aiCreditsNoBillingSource: pt.aiCreditsNoBillingSource }
      : {}),
    ...(pt.aiCreditsRouting ? { aiCreditsRouting: pt.aiCreditsRouting } : {}),
    ...(pt.pluginSelections
      ? { pluginSelections: normalizePluginSelections(pt.pluginSelections) }
      : defaults?.pluginSelections
        ? {
            pluginSelections: normalizePluginSelections(
              defaults.pluginSelections,
            ),
          }
        : {}),
    ...(typeof pt.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: pt.deferredToolsAllowed }
      : {}),
    ...(pt.discovery ? { discovery: pt.discovery } : {}),
    ...(usage ? { usage } : {}),
    ...(pt.agentUsage ? { agentUsage: pt.agentUsage } : {}),
    ...(pt.turnDiffs ? { turnDiffs: pt.turnDiffs } : {}),
    // Carry the chat-interface surface preference (Canopy-native vs. managed
    // Claude Code terminal) through the persistence round trip. Missing
    // values fall through and are treated as `'canopy'` by callers.
    ...(pt.interfaceMode ? { interfaceMode: pt.interfaceMode } : {}),
    ...(pt.claudeTerminal ? { claudeTerminal: pt.claudeTerminal } : {}),
  };
}

/**
 * Clone a persisted tab with a fresh ID, optionally clearing messages and/or
 * session state. Useful for "resume archived chat" and "duplicate chat" flows.
 */
export function clonePersistedChatTabForResume(
  pt: PersistedChatTab,
  overrides?: { clearMessages?: boolean; clearSession?: boolean },
): PersistedChatTab {
  const cloned: PersistedChatTab = {
    ...pt,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  if (overrides?.clearMessages) {
    cloned.messages = [];
    delete cloned.memoryByMessageId;
  }

  if (overrides?.clearSession) {
    delete cloned.sdkSessionId;
    delete cloned.globalInstructionsSnapshot;
    delete cloned.claudeForkSessionOnNextSend;
    delete cloned.staleSessionDetected;
    delete cloned.pendingPlanExit;
    delete cloned.pendingSystemInstructions;
    delete cloned.readOnly;
  }

  return cloned;
}
