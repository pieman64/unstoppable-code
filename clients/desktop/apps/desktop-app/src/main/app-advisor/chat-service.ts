import {
  recordPresentationTurn,
  resolvePresentationSource,
  clearPresentationTurn,
  capturePresentationTurn,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
import { browserHandoffs } from '../browser/browser-handoffs';
import { assertOpenCodeModelAvailable } from '../opencode/connection';
import { chatAgentSent } from '@canopy/protocol/portal/external-agent-sender';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { getChatQueueService } from '../services/chat-queue-service';
import { getOrCreateRoutedSession } from '../agents/session-event-router';
import type { BrowserWindow } from 'electron';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  IPC_CHANNELS,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  resolveModelAlias,
  resolveProviderModelConfig,
  type AgentProviderType,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatSendMessageDisposition,
  type DeferredToolsReloadEvent,
  type AgentTranscriptInjectedPrompt,
  type PersistedChatMessage,
  type PortalChatMessage,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import { applyAgentSessionCodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import {
  appendUserOverallPreferencesBlock,
  buildUserOverallPreferencesBlock,
} from '@canopy/desktop-shared/lib/global-instructions';
import { validateId } from '../lib/validation';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import { getAppAdvisorHomeDir } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { resolveLaneSubstitutedProviderType } from '../lib/lane-substituted-provider';
import { claudeContinuationSession } from '../lib/claude-fork-continuation';
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import {
  destroySession,
  getActiveSessionInfos,
  getSessionGlobalInstructionsSnapshot,
  shouldRecreateSessionOnNextTurn,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
} from '../agents/session-manager';
import { sendToWindowDetailed } from '../lib/window-send';
import { getObservabilityService } from '../observability';
import {
  getChatTurnAuditStatus,
  isRootTerminalChatEventData,
  isRecord,
  isTerminalChatEventData,
  readCodexRootThreadId,
} from '../lib/chat-turn-audit';
import { describeChatEventData } from '../lib/chat-event-description';
import { getResourceMonitorService } from '../resource-monitor';
import { createAppAdvisorToolRuntime } from './runtime';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';
import { APP_ADVISOR_SYSTEM_PROMPT } from './system-prompt';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { stableHash } from '@canopy/desktop-shared/lib/stable-hash';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  listWorkEntryIds,
  resolveWorkEntryForChat,
} from '../lib/cowork-work-entries';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import {
  createPortalTurnTimer,
  isTerminalRuntimeChatEvent,
  runtimeChatEventToPortalMessage,
  type PortalTurnTimer,
} from '../services/chat-transcript-projector';
import { resolveAgentAttachmentsDir } from '../lib/agent-attachments';
import { ensureAppAdvisorHomeScaffold } from '../lib/app-advisor-workspace';
import { getChatStateService } from '../services/chat-state-service';
import type {
  CanonicalChatAddress,
  ChatWatcherEvidence,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  captureChatWatcherEvidence,
  getCanonicalChatTerminalDisposition,
  getCanonicalInputAcceptedAt,
  hasCanonicalTurnVisibleOutput,
  resolveCanonicalChatAddress,
} from '../services/active-chat-input';
import { getAppAdvisorWatcherService } from './watchers';
import {
  claudeForkSessionIdFromInit,
  consumePersistedClaudeForkSessionMarker,
} from '../lib/claude-fork-session-marker';
import { logMainProcessError } from '../lib/main-process-logging';
import { clampToLiveApprovalMode } from '../approvals/live-approval-modes';
import {
  readPersistedChatDispatchMetadata,
  type PersistedChatDispatchMetadata,
} from '../lib/chat-tabs-reader';

/**
 * Last assistant frame the portal seam emitted per chat (CAN-2565), keyed by
 * chatId. Entries are cleared on every terminal runtime event; a surviving
 * entry therefore always describes the still-open turn a cancel needs to
 * close on the portal side.
 */
const lastAssistantPortalMessages = new Map<string, PortalChatMessage>();

/**
 * Live portal turn timer per chat, keyed by chatId. App Advisor has no desktop
 * renderer persisting a timer row for portal consumption, so this path owns the
 * synthetic `${userMessageId}:turn-timer` system frames the browser's store
 * uses as its turn lifecycle signal (the worktree portal path's
 * `createPortalTurnTimer` pattern) — without them a live App Advisor turn never
 * terminates browser-side even though the desktop is idle.
 *
 * Created at dispatch, superseded by a new visible user turn, and normally
 * cleared on terminal runtime events. A deferred-tools intermediate terminal
 * event retains it until the continuation finishes or the reload fails.
 */
const portalTurnTimers = new Map<string, PortalTurnTimer>();

type AdvisorChatObservation = {
  address: CanonicalChatAddress;
  evidence: ChatWatcherEvidence;
  sourceInputId: string;
  sourceInputAcceptedAt: string;
};

// A deferred reload shares the accepted input's evidence, not the account
// state at continuation dispatch. This is runtime correlation, not start state;
// the durable Pending/FiredAt metadata remains the sole first-start authority.
const advisorChatObservations = new Map<string, AdvisorChatObservation>();

async function captureAdvisorChatObservation(
  request: ChatSendMessageRequest,
  sourceInputId: string,
  originalAcceptedAt?: string,
): Promise<AdvisorChatObservation | undefined> {
  try {
    const address = await resolveCanonicalChatAddress(request);
    if (!address) return undefined;
    const evidence = await captureChatWatcherEvidence(address);
    const sourceInputAcceptedAt =
      (await getCanonicalInputAcceptedAt(request, sourceInputId)) ??
      originalAcceptedAt;
    if (!sourceInputAcceptedAt) return undefined;
    return {
      address,
      evidence,
      sourceInputId,
      sourceInputAcceptedAt,
    };
  } catch (error) {
    logMainProcessError(
      'Failed to capture App Advisor lifecycle evidence',
      error,
    );
    return undefined;
  }
}

function completePortalTimerForReloadOutcome(
  event: DeferredToolsReloadEvent,
): void {
  if (
    event.scope.projectId !== APP_ADVISOR_PROJECT_ID ||
    event.lifecycle.kind !== 'outcome'
  ) {
    return;
  }
  const { chatId } = event.scope;
  const turnTimer = portalTurnTimers.get(chatId);
  if (turnTimer && isCanopyPortalActive()) {
    const completedTimer = turnTimer.completeForEvent({
      type: 'result',
      is_error: true,
      result: event.error?.message ?? 'Deferred-tools reload failed.',
    });
    if (completedTimer) {
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', {
          chatId,
          message: completedTimer,
        }),
      );
    }
  }
  lastAssistantPortalMessages.delete(chatId);
  portalTurnTimers.delete(chatId);
}

deferredToolsReloadCoordinator.subscribe(completePortalTimerForReloadOutcome);

type AppAdvisorChatDispatchRequest = ChatSendMessageRequest & {
  /**
   * Host-owned namespace for the provider events emitted by a deferred-tools
   * continuation. The continuation intentionally reuses the visible turn's
   * user-message id, so its provider events need another idempotency segment.
   */
  deferredToolsReloadRequestId?: string;
};

/**
 * A projected assistant frame that would render as an empty transcript row: no
 * text and no parts. Some providers close a turn with a content-less assistant
 * record (own UUID, status `complete`); mirroring it left a stray dots bubble
 * at the end of the portal transcript. Guarded here in the App Advisor seam —
 * the narrowest placement — rather than in the shared
 * `runtimeChatEventToPortalMessage`, whose other consumer (the worktree portal
 * path) also persists projected frames and is out of scope for this fix.
 * Restricted to `complete` frames so a failed/cancelled status transition can
 * never be swallowed on text-less frames.
 */
function isEmptyCompleteAssistantFrame(message: PortalChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.status === 'complete' &&
    message.text.trim().length === 0 &&
    (message.parts === undefined || message.parts.length === 0)
  );
}

function sendAppAdvisorChatEvent(
  getMainWindow: () => BrowserWindow | null,
  getAppAdvisorWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
  context?: {
    providerType?: AgentProviderType;
    model?: ChatModel;
    fallbackMessageId?: string;
    preservePortalTimerForDeferredReload?: boolean;
  },
): void {
  const payload = {
    projectId,
    worktreeId,
    chatId,
    data,
  };
  const mainDelivery = sendToWindowDetailed(
    getMainWindow(),
    IPC_CHANNELS.chatEvent,
    payload,
  );
  const appAdvisorDelivery = sendToWindowDetailed(
    getAppAdvisorWindow(),
    IPC_CHANNELS.chatEvent,
    payload,
  );
  const isTerminalEvent = isTerminalRuntimeChatEvent(data);
  const preservePortalTimerForDeferredReload =
    isTerminalEvent &&
    (context?.preservePortalTimerForDeferredReload ??
      deferredToolsReloadCoordinator.hasActiveReload({
        projectId,
        worktreeId,
        chatId,
      }));

  // Mirror the turn onto a connected portal session (CAN-2565). The payload
  // deliberately carries no scope/workspace routing — the server pins the
  // `app_advisor` scope from the event type, so a desktop cannot mislabel it.
  if (isCanopyPortalActive()) {
    const turnTimer = portalTurnTimers.get(chatId);
    const emitPortalMessage = (message: PortalChatMessage): void => {
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', { chatId, message }),
      );
    };
    // Same update order as the worktree portal path's onChatEvent: raw-event
    // timer updates (Codex ask-user pause/resume), then the projected message
    // and its part-driven timer updates, then the terminal completion frame.
    const eventTimerUpdate = turnTimer?.updateForEvent(data) ?? null;
    if (eventTimerUpdate) {
      emitPortalMessage(eventTimerUpdate);
    }
    const message = runtimeChatEventToPortalMessage({
      scope: 'app_advisor',
      chatId,
      data,
      fallbackMessageId: context?.fallbackMessageId,
    });
    // Content-less complete assistant frames are dropped entirely: not
    // mirrored (they render as an empty trailing bubble) and not remembered —
    // a cancel must never re-key 'cancelled' onto an empty frame either.
    if (message && !isEmptyCompleteAssistantFrame(message)) {
      if (message.role === 'assistant') {
        // Remember the last assistant frame per chat: a successful terminal
        // `result` maps to NO portal message, so a later cancel must re-key
        // its 'cancelled' status onto this frame or the portal transcript's
        // last message stays 'streaming' forever.
        lastAssistantPortalMessages.set(chatId, message);
      }
      emitPortalMessage(message);
      const messageTimerUpdate = turnTimer?.updateForMessage(message) ?? null;
      if (messageTimerUpdate) {
        emitPortalMessage(messageTimerUpdate);
      }
    }
    // Terminal runtime events — including the synthetic cancel `result` from
    // emitAppAdvisorSyntheticResultEvent — finalize the live timer; the
    // browser's store ends its turn lifecycle on this terminal frame.
    const completedTimer = preservePortalTimerForDeferredReload
      ? null
      : (turnTimer?.completeForEvent(data) ?? null);
    if (completedTimer) {
      emitPortalMessage(completedTimer);
    }
  }
  if (isTerminalEvent) {
    // The turn is over; a cancel arriving later must not resurrect this
    // frame with a bogus 'cancelled' status. Cleared unconditionally — a
    // portal that disconnects mid-turn and reconnects later must not see a
    // prior turn's frame re-emitted, and cancelling while disconnected must
    // not strand the entry.
    lastAssistantPortalMessages.delete(chatId);
    // A deferred-tools reload emits an intermediate terminal event before its
    // hidden continuation starts. Keep the same live timer across that seam
    // so Portal retains its working indicator and Stop control. The resumed
    // request's real terminal event consumes it after the coordinator leaves
    // the active-reload state.
    if (!preservePortalTimerForDeferredReload) {
      portalTurnTimers.delete(chatId);
    }
  }

  if (!mainDelivery.delivered && !appAdvisorDelivery.delivered) {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'chat_event_undelivered',
      sessionKey: `${projectId}/${worktreeId}/${chatId}`,
      projectId,
      worktreeId,
      chatId,
      providerType: context?.providerType ?? 'unknown',
      ...(context?.model ? { model: context.model } : {}),
      eventType: describeChatEventData(data, { includePhaseEvents: true }),
      terminal: isTerminalChatEventData(data),
      sendFailureReason: mainDelivery.reason,
    });
  }
}

async function resolveAppAdvisorCwd(): Promise<string> {
  // App Advisor is a global assistant that operates the app through tools and
  // actions (each scoped by explicit projectId/worktreeId), not through its
  // process cwd. Pointing the agent's cwd at whatever worktree happens to be
  // selected in the main window leaked that worktree's files/CLAUDE.md/git
  // context into every global session and made sessions non-deterministic.
  // Always run from the dedicated App Advisor home directory.
  await ensureAppAdvisorHomeScaffold();
  return getAppAdvisorHomeDir();
}

type DeferredToolsReloadMetadata = NonNullable<
  AgentTranscriptInjectedPrompt['deferredToolsReload']
>;

function buildDeferredToolsReloadMetadata(
  enabledResources: NonNullable<
    ChatSendMessageRequest['deferredToolsReloadEnabledResources']
  >,
): DeferredToolsReloadMetadata {
  return {
    enabledResources: enabledResources.map((resource) => ({
      ref: resource.ref,
      kind: resource.kind,
      name: resource.name,
      ...(resource.sourceLabel ? { sourceLabel: resource.sourceLabel } : {}),
    })),
  };
}

function buildPersistedAppAdvisorUserMessage(
  request: ChatSendMessageRequest,
  timestamp: number,
): PersistedChatMessage {
  return {
    id: request.userMessageId,
    role: 'user',
    timestamp,
    blocks: [
      ...(request.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: request.fileReferences,
            },
          ]
        : []),
      { type: 'text', text: request.text },
    ],
    ...(request.attachmentPaths?.length
      ? { attachmentPaths: request.attachmentPaths }
      : {}),
    ...(request.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: request.attachmentPromptContexts }
      : {}),
    ...(request.inputMode ? { inputMode: request.inputMode } : {}),
    ...(request.watcherFired ? { watcherFired: request.watcherFired } : {}),
    // A message an external MCP agent sent stays the person's own.
    ...(chatAgentSent(request.agentSent)
      ? { userMessageSource: 'agent' as const }
      : {}),
    ...(request.agentSent ? { agentSent: request.agentSent } : {}),
  };
}

export async function dispatchAppAdvisorChatMessage(
  request: AppAdvisorChatDispatchRequest,
  options: {
    getMainWindow: () => BrowserWindow | null;
    getAppAdvisorWindow: () => BrowserWindow | null;
    toolSurfaces: AppAdvisorToolRuntimeSurfaces;
    /** Trusted host signal; never part of the portable request. */
    onTurnAccepted?: () => void;
    admissionSignal?: AbortSignal;
  },
): Promise<ChatSendMessageDisposition> {
  if (request.projectId !== APP_ADVISOR_PROJECT_ID) {
    throw new Error('App Advisor chat must use the App Advisor project id.');
  }
  if (request.worktreeId === APP_ADVISOR_WORKTREE_ID) {
    throw new Error('App Advisor legacy global chats are read-only.');
  }

  validateId(request.worktreeId, 'worktreeId');
  validateId(request.chatId, 'chatId');
  validateId(request.userMessageId, 'userMessageId');

  const presentationOrigin = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatTabId: request.chatId,
  };
  const handoffsAtSend = browserHandoffs.captureOrigin(presentationOrigin);
  const continuingTurn = capturePresentationTurn(presentationOrigin);
  const presentationSource = request.deferredToolsReloadRequestId
    ? continuingTurn?.turnId === request.userMessageId
      ? continuingTurn.source
      : undefined
    : resolvePresentationSource(request, 'user');
  const entryIds = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
  if (!entryIds.includes(request.worktreeId)) {
    throw new Error(`Unknown App Advisor Work Entry ${request.worktreeId}.`);
  }
  const resourceGuard =
    await getResourceMonitorService().reserveChatTurnStart();
  try {
    const deferredToolsReloadEnabledResources =
      request.deferredToolsReloadEnabledResources;
    const preferences = await readPreferencesFile();
    const persistedDispatchMetadata = await readPersistedChatDispatchMetadata(
      request.projectId,
      request.worktreeId,
      request.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    );
    const persistedModel =
      request.model === undefined &&
      request.providerType === undefined &&
      persistedDispatchMetadata.model !== undefined
        ? persistedDispatchMetadata.model
        : undefined;
    const selectedModel =
      request.model ?? persistedModel ?? preferences.appAdvisorModel;
    const laneSubstitutedProviderType = resolveLaneSubstitutedProviderType({
      explicitModel: request.model ?? persistedModel,
      requestedProviderType: request.providerType,
      selectedModel,
    });
    const selectedProviderType =
      laneSubstitutedProviderType ??
      (persistedModel !== undefined
        ? (persistedDispatchMetadata.providerType ??
          getProviderForModel(persistedModel))
        : undefined) ??
      request.providerType ??
      getProviderForModel(selectedModel);

    const thinkingLevel =
      request.thinkingLevel ??
      (persistedModel !== undefined
        ? persistedDispatchMetadata.thinkingLevel
        : undefined) ??
      preferences.appAdvisorThinkingLevel;
    const selectedPluginSelections =
      request.pluginSelections ?? preferences.appAdvisorPluginSelections;
    let activeSession = getActiveSessionInfos(
      request.projectId,
      request.worktreeId,
    ).find(({ chatId }) => chatId === request.chatId);
    const switchesActiveSessionProvider =
      activeSession !== undefined &&
      selectedProviderType !== undefined &&
      activeSession.providerType !== selectedProviderType;
    // A Cursor turn runs on the managed runtime; fail before any chat state
    // is written or a live session of another provider is torn down,
    // matching the worktree chat IPC and Home composer guards.
    if (
      selectedProviderType === 'cursor' &&
      !(await isCursorRuntimeAvailable())
    ) {
      throw new Error(
        'Connect Cursor in Settings to send with Cursor, or choose another model.',
      );
    }
    if (
      selectedProviderType === 'copilot' &&
      !(await isCopilotRuntimeAvailable())
    )
      throw new Error('Connect Copilot in Settings > Labs.');
    if (selectedProviderType === 'opencode')
      await assertOpenCodeModelAvailable(selectedModel);
    if (selectedProviderType === 'copilot')
      await assertCopilotModelAvailable(selectedModel);
    if (switchesActiveSessionProvider) {
      await destroySession(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
      activeSession = undefined;
    }
    // Hydration may replace a cold default before the first turn. Its old
    // persisted harness is not a conversation lock or an explicit user choice.
    const freshModelHarness =
      request.model !== undefined &&
      !activeSession &&
      persistedDispatchMetadata.hasConversation === false &&
      persistedDispatchMetadata.executionHarnessExplicitlyChosen !== true
        ? getExecutionHarnessForModel(selectedModel)
        : undefined;
    const authoritativeExecutionHarness =
      freshModelHarness ??
      // A cross-lane substitution invalidates every remembered harness: the
      // model that will actually run is the substituted one.
      (laneSubstitutedProviderType
        ? getExecutionHarnessForModel(selectedModel)
        : undefined) ??
      (persistedModel !== undefined
        ? (persistedDispatchMetadata.executionHarness ??
          getExecutionHarnessForModel(persistedModel))
        : undefined) ??
      activeSession?.executionHarness ??
      persistedDispatchMetadata.executionHarness ??
      (persistedDispatchMetadata.model
        ? getExecutionHarnessForModel(persistedDispatchMetadata.model)
        : undefined) ??
      getExecutionHarnessForModel(selectedModel) ??
      (selectedProviderType === 'codex' ? 'codex' : 'claude');
    if (
      request.executionHarness !== undefined &&
      request.executionHarness !== authoritativeExecutionHarness &&
      // Callers forward the tab's persisted harness, so a substituted turn
      // arrives holding the OLD lane's harness.
      laneSubstitutedProviderType === undefined
    ) {
      throw new Error(
        'App Advisor execution harness does not match host-owned routing',
      );
    }
    const runtime = await resolveAgentModelRuntime({
      projectId: APP_ADVISOR_PROJECT_ID,
      model: selectedModel,
      systemPromptAppend: APP_ADVISOR_SYSTEM_PROMPT,
      pluginSelections: selectedPluginSelections,
      providerType: selectedProviderType,
    });
    const model = runtime.runtimeModel;
    const providerType = runtime.providerType;
    const executionHarness = authoritativeExecutionHarness;
    // Copilot and OpenCode reload after a native tool-result receipt.
    // Cursor does not yet provide that boundary.
    const deferredToolsAllowed =
      executionHarness !== 'cursor' &&
      (request.deferredToolsAllowed ??
        persistedDispatchMetadata.deferredToolsAllowed) !== false;
    const pluginSelections =
      runtime.pluginSelections ?? selectedPluginSelections;
    // Global Instructions (Instructions settings) — resolved per session context
    // into a "User Overall Preferences" block appended after the App Advisor
    // system prompt (and any Agent instructions). Reaches the provider only
    // when a session is created, never an already-live one.
    const chatGlobalInstructions = preferences.globalInstructions?.chats;
    const currentGlobalInstructionsBlock = chatGlobalInstructions
      ? buildUserOverallPreferencesBlock(chatGlobalInstructions, {
          harness: providerType,
          model: resolveModelAlias(model ?? ''),
          workspaceType: 'app-advisor',
        })
      : '';
    const resumingProviderSession =
      request.sdkSessionId !== undefined &&
      laneSubstitutedProviderType === undefined &&
      !switchesActiveSessionProvider;
    const globalInstructionsBlock = resumingProviderSession
      ? (request.globalInstructionsSnapshot ??
        getSessionGlobalInstructionsSnapshot(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ) ??
        '')
      : currentGlobalInstructionsBlock;
    const systemPromptAppend =
      appendUserOverallPreferencesBlock(
        runtime.systemPromptAppend ?? APP_ADVISOR_SYSTEM_PROMPT,
        globalInstructionsBlock,
      ) ?? APP_ADVISOR_SYSTEM_PROMPT;
    const observedSystemPromptAppend = systemPromptAppend;
    const cwd = await resolveAppAdvisorCwd();
    const attachmentBaseDir = resolveAgentAttachmentsDir(
      request.projectId,
      request.worktreeId,
    );
    const visibleSubmittedText = buildSubmittedMessageText({
      text: request.text,
      fileReferences: request.fileReferences,
      attachmentPaths: request.attachmentPaths,
      attachmentPromptContexts: request.attachmentPromptContexts,
      attachmentBaseDir,
      cwd,
      inputMode: request.inputMode,
      pendingSystemInstructions: request.pendingSystemInstructions,
    });
    const providerSubmittedText = request.hiddenContext?.text
      ? [request.hiddenContext.text, '', visibleSubmittedText].join('\n')
      : visibleSubmittedText;

    if (
      shouldRecreateSessionOnNextTurn(
        request.projectId,
        request.worktreeId,
        request.chatId,
      )
    ) {
      await destroySession(
        request.projectId,
        request.worktreeId,
        request.chatId,
      );
    }

    const sessionApprovalMode = clampToLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      request.chatId,
      request.approvalMode,
    );
    const appAdvisorRuntime = createAppAdvisorToolRuntime(
      options.toolSurfaces,
      {
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      {
        providerType,
        approvalMode: sessionApprovalMode,
        sessionApprovalRules: request.sessionApprovalRules,
        pluginSelections,
        deferredToolsAllowed,
      },
    );
    const toolProfileHash = stableHash({
      mode: 'app-advisor',
      providerType,
      model,
      thinkingLevel,
      pluginSelections,
      deferredToolsAllowed,
      codexMultiAgentEnabled: preferences.codexMultiAgentAppAdvisorEnabled,
      codexMaxConcurrentSubagents: preferences.codexMaxConcurrentSubagents,
      tools: Object.values(APP_ADVISOR_TOOL_REGISTRY).map((tool) => ({
        key: tool.canonicalKey,
        claude: tool.claudeToolName,
        codex: tool.codexToolName,
      })),
    });
    const modelConfig = resolveProviderModelConfig(
      executionHarness,
      {
        thinkingLevel,
        modelConfig:
          request.modelConfig ??
          (persistedModel !== undefined
            ? persistedDispatchMetadata.modelConfig
            : undefined),
      },
      preferences.providerModelConfigDefaults,
    );
    const chatStateService = getChatStateService();
    // Trusted send's atomic compare-and-create has no chat command equivalent in Phase 0A.
    await chatStateService.ensureChatForTrustedSend({
      ...request,
      providerType,
      model: selectedModel,
      executionHarness,
      modelConfig,
      pluginSelections,
      deferredToolsAllowed,
    });
    const isDeferredToolsReloadContinuation =
      request.deferredToolsReloadEnabledResources !== undefined;
    if (!isDeferredToolsReloadContinuation) {
      const promptTimestamp = Date.now();
      const promptCommitted = await chatStateService.ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: {
          type: 'canopy_user_prompt',
          original_text: request.text,
          canopy_turn_user_message_id: request.userMessageId,
          provider: providerType,
          canopy_persisted_messages: [
            buildPersistedAppAdvisorUserMessage(request, promptTimestamp),
          ],
        },
        mutationId: `${request.chatId}:${request.userMessageId}:user-prompt`,
        providerType,
        turnUserMessageId: request.userMessageId,
      });
      if (!promptCommitted) {
        const accepted = await chatStateService.hasMutation(
          { projectId: request.projectId, worktreeId: request.worktreeId },
          `${request.chatId}:${request.userMessageId}:accepted`,
        );
        if (accepted) {
          options.onTurnAccepted?.();
          return 'already_accepted';
        }
      }
    }
    if (!isDeferredToolsReloadContinuation) {
      scheduleChatSummary({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        cwd,
        getWindow: options.getMainWindow,
        getAdditionalWindows: () => [options.getAppAdvisorWindow()],
        linkTarget: {
          page: 'main',
          kind: 'app-advisor',
          chatId: request.chatId,
        },
      });
    }
    let executionUserMessageId = request.userMessageId;
    let codexRootThreadId = request.sdkSessionId;
    let eventCommitTail = Promise.resolve();
    const retainedObservation = advisorChatObservations.get(request.chatId);
    let observation =
      isDeferredToolsReloadContinuation &&
      retainedObservation?.sourceInputId === request.userMessageId
        ? retainedObservation
        : undefined;
    const settledInputs = new Set<string>();
    const inputObservations = new Map<
      string,
      Promise<AdvisorChatObservation | undefined>
    >();
    if (observation) {
      inputObservations.set(
        observation.sourceInputId,
        Promise.resolve(observation),
      );
    }
    // A continuation revives the settled turn only until it settles again;
    // later frames (such as Claude's command lifecycle) must not reopen it.
    let continuationSettled = false;
    let eventSequence = 0;
    const session = await getOrCreateRoutedSession(
      {
        cwd,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        planMode: false,
        approvalMode: sessionApprovalMode,
        sessionApprovalRules: request.sessionApprovalRules,
        thinkingLevel: modelConfig.thinkingLevel,
        modelConfig,
        model,
        selectedModel,
        // A provider's session id is meaningless to the other one, and
        // `getOrCreateSession` has no provider-change guard — see
        // `worktree-chat-turn.ts`.
        ...(laneSubstitutedProviderType || switchesActiveSessionProvider
          ? {}
          : {
              sdkSessionId: request.sdkSessionId,
              // An independent fork (StartForkedAgent) must branch the source
              // Claude session rather than resume it, as on the worktree path.
              ...(request.claudeForkSession ? { claudeForkSession: true } : {}),
              ...(request.claudeForkSession && request.claudeForkResumeAt
                ? { claudeForkResumeAt: request.claudeForkResumeAt }
                : {}),
              ...(request.claudeForkSession &&
              request.claudeForkResumeAt &&
              request.claudeForkToolResults?.length
                ? { claudeForkToolResults: request.claudeForkToolResults }
                : {}),
            }),
        ...(request.claudeForkStartsFresh
          ? { claudeForkStartsFresh: true }
          : {}),
        pluginSelections,
        deferredToolsAllowed,
        systemPromptAppend:
          runtime.systemPromptAppend ?? APP_ADVISOR_SYSTEM_PROMPT,
        globalInstructionsBlock,
        globalInstructionsSnapshot: resumingProviderSession
          ? globalInstructionsBlock
          : undefined,
        providerType,
        executionHarness,
        codexAppServerIdleTimeoutMinutes:
          preferences.codexAppServerIdleTimeoutMinutes,
        codexMultiAgentEnabled: preferences.codexMultiAgentAppAdvisorEnabled,
        codexMaxConcurrentSubagents: preferences.codexMaxConcurrentSubagents,
        // Claude and Cursor both rewrite shell commands through the bundled
        // RTK hook; Codex has no rewrite seam.
        rtkEnabled:
          executionHarness === 'claude' ||
          executionHarness === 'cursor' ||
          executionHarness === 'copilot' ||
          executionHarness === 'opencode'
            ? preferences.rtkEnabled
            : false,
        assistantMode: 'app-advisor',
        toolProfileHash,
        appAdvisorRuntime,
      },
      (data: unknown, markPersistenceSettled?: () => void): Promise<void> => {
        codexRootThreadId = readCodexRootThreadId(data) ?? codexRootThreadId;
        const occurredAt = new Date(Date.now()).toISOString();
        const isRootTerminal = isRootTerminalChatEventData(
          data,
          codexRootThreadId,
        );
        let pickupObservation:
          | Promise<AdvisorChatObservation | undefined>
          | undefined;
        if (
          isRecord(data) &&
          data.type === 'canopy_input_delivery' &&
          data.phase === 'picked-up' &&
          data.startsTurn === true &&
          data.turnRootAccepted !== false &&
          typeof data.userMessageId === 'string'
        ) {
          pickupObservation =
            inputObservations.get(data.userMessageId) ??
            captureAdvisorChatObservation(request, data.userMessageId);
          inputObservations.set(data.userMessageId, pickupObservation);
        }
        const forkSessionId = request.claudeForkSession
          ? claudeForkSessionIdFromInit(data)
          : null;
        if (forkSessionId) {
          void consumePersistedClaudeForkSessionMarker({
            workspaceId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: request.chatId,
            sessionId: forkSessionId,
          }).catch(() => undefined);
        }
        // Capture the terminal's role before queued persistence. The reload
        // coordinator can finish starting the continuation while this event
        // waits for disk, but the old terminal must still keep its timer open.
        const preservePortalTimerForDeferredReload =
          isTerminalRuntimeChatEvent(data) &&
          deferredToolsReloadCoordinator.hasActiveReload({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: request.chatId,
          });
        const providerEvent =
          isDeferredToolsReloadContinuation &&
          !continuationSettled &&
          isRecord(data)
            ? { ...data, canopy_turn_revival: true }
            : data;
        if (
          isDeferredToolsReloadContinuation &&
          isRootTerminalChatEventData(data, codexRootThreadId)
        ) {
          continuationSettled = true;
        }
        const sequence = eventSequence;
        eventSequence += 1;
        eventCommitTail = eventCommitTail
          .then(() =>
            chatStateService.ingestProviderEventWithOutcome({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              data: providerEvent,
              mutationId: request.deferredToolsReloadRequestId
                ? `${request.chatId}:${request.userMessageId}:deferred-reload:${request.deferredToolsReloadRequestId}:provider:${sequence}`
                : `${request.chatId}:${request.userMessageId}:provider:${sequence}`,
              providerType,
              turnUserMessageId: executionUserMessageId,
            }),
          )
          .then(async (outcome) => {
            markPersistenceSettled?.();
            // Activity-only events carry no durable change but are live.
            if (outcome === 'not-applied') return;
            if (
              isRecord(providerEvent) &&
              providerEvent.type === 'canopy_input_delivery' &&
              providerEvent.phase === 'picked-up' &&
              providerEvent.startsTurn === true &&
              typeof providerEvent.userMessageId === 'string'
            ) {
              let pickupAccepted: boolean;
              if (providerEvent.turnRootAccepted === false) {
                pickupAccepted = false;
              } else if (providerEvent.turnRootAccepted === true) {
                getChatQueueService().confirmTurnRevived(
                  request,
                  providerEvent.userMessageId,
                );
                pickupAccepted = true;
              } else {
                pickupAccepted = getChatQueueService().onTurnRevived(
                  request,
                  providerEvent.userMessageId,
                );
              }
              if (pickupAccepted) {
                executionUserMessageId = providerEvent.userMessageId;
                observation = await pickupObservation;
                if (observation)
                  advisorChatObservations.set(request.chatId, observation);
                // The input-delivery coordinator installed this root's trusted
                // source; never inherit it from this older dispatch closure.
              }
              if (pickupAccepted && isCanopyPortalActive()) {
                const turnTimer = createPortalTurnTimer({
                  chatId: request.chatId,
                  userMessageId: executionUserMessageId,
                });
                portalTurnTimers.set(request.chatId, turnTimer);
                enqueuePortalEvent(
                  createPortalEvent('portal.app_advisor.event', {
                    chatId: request.chatId,
                    message: turnTimer.startMessage,
                  }),
                );
              }
            }
            getObservabilityService().observeChatEvent(
              request.projectId,
              request.worktreeId,
              request.chatId,
              providerEvent,
            );
            sendAppAdvisorChatEvent(
              options.getMainWindow,
              options.getAppAdvisorWindow,
              request.projectId,
              request.worktreeId,
              request.chatId,
              providerEvent,
              {
                providerType,
                model,
                preservePortalTimerForDeferredReload,
                // Same synthetic-id convention as the worktree portal path
                // so provider events without their own message id still land
                // on a stable per-turn assistant row.
                fallbackMessageId: `${executionUserMessageId}:assistant`,
              },
            );
            const eventData = isRecord(providerEvent) ? providerEvent : null;
            if (eventData && isRootTerminal) {
              if (preservePortalTimerForDeferredReload) {
                return;
              }
              const status = getChatTurnAuditStatus(eventData);
              getChatQueueService().onTurnTerminal(
                request,
                status === 'success'
                  ? 'complete'
                  : status === 'failure'
                    ? 'error'
                    : 'cancelled',
                executionUserMessageId,
              );
              const error =
                eventData.type === 'error'
                  ? typeof eventData.error === 'string'
                    ? eventData.error
                    : 'Unknown error'
                  : eventData.is_error === true &&
                      typeof eventData.result === 'string'
                    ? eventData.result
                    : undefined;
              clearPresentationTurn(
                presentationChatKey(presentationOrigin),
                executionUserMessageId,
              );
              getObservabilityService().completeChatTurn(
                request.projectId,
                request.worktreeId,
                request.chatId,
                status,
                error,
              );
              // Resolve the root here, inside the ordered commit stream. A
              // pickup queued before this terminal must win, but a later
              // pickup must not steal this terminal while disk is blocked.
              const terminalObservation = observation;
              if (
                outcome === 'applied' &&
                terminalObservation &&
                terminalObservation.sourceInputId === executionUserMessageId &&
                !settledInputs.has(executionUserMessageId)
              ) {
                settledInputs.add(executionUserMessageId);
                const hasVisibleOutput = await hasCanonicalTurnVisibleOutput(
                  request,
                  executionUserMessageId,
                );
                await getAppAdvisorWatcherService().handleCanonicalChatTerminalEvent(
                  {
                    kind: 'terminal',
                    eventId: `canonical-chat:${stableHash(terminalObservation.address)}:${executionUserMessageId}:terminal`,
                    ...terminalObservation,
                    occurredAt,
                    observedAt: new Date(Date.now()).toISOString(),
                    disposition: getCanonicalChatTerminalDisposition(
                      eventData,
                      status,
                      hasVisibleOutput,
                    ),
                  },
                );
                if (
                  advisorChatObservations.get(request.chatId) ===
                  terminalObservation
                ) {
                  advisorChatObservations.delete(request.chatId);
                }
              }
            }
          })
          .catch((error: unknown) => {
            markPersistenceSettled?.();
            logMainProcessError(
              `Failed to durably commit App Advisor event for ${request.worktreeId}/${request.chatId}`,
              error,
            );
          });
        return eventCommitTail;
      },
      () => options.getAppAdvisorWindow() ?? options.getMainWindow(),
      {
        turnUserMessageId: executionUserMessageId,
        acceptTurnRoot: async (turnUserMessageId): Promise<boolean> => {
          await eventCommitTail;
          return getChatQueueService().onTurnRevived(
            request,
            turnUserMessageId,
          );
        },
        drainEventsBeforeRemoval: () => eventCommitTail,
      },
    );
    const authoritativeGlobalInstructionsSnapshot =
      getSessionGlobalInstructionsSnapshot(
        request.projectId,
        request.worktreeId,
        request.chatId,
      ) ?? globalInstructionsBlock;
    if (
      request.globalInstructionsSnapshot !==
      authoritativeGlobalInstructionsSnapshot
    ) {
      sendAppAdvisorChatEvent(
        options.getMainWindow,
        options.getAppAdvisorWindow,
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          type: GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
          globalInstructionsSnapshot: authoritativeGlobalInstructionsSnapshot,
        },
      );
    }

    deferredToolsReloadCoordinator.registerResumeHandler(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      async (reloadRequest) => {
        reloadRequest.signal.throwIfAborted();
        const continuationOrigin = capturePresentationTurn(presentationOrigin);
        await getChatStateService().runWithScopeActivity(
          {
            projectId: request.projectId,
            worktreeId: request.worktreeId,
          },
          () =>
            dispatchAppAdvisorChatMessage(
              {
                ...request,
                userMessageId: reloadRequest.userMessageId,
                text: reloadRequest.continuationText,
                ...claudeContinuationSession(request, {
                  requestedSessionId: reloadRequest.sdkSessionId,
                  providerSessionId: session.getProviderSessionId?.(),
                }),
                providerType: reloadRequest.providerType ?? providerType,
                pluginSelections:
                  reloadRequest.pluginSelections ?? pluginSelections,
                hiddenContext: undefined,
                agentSent: undefined,
                agentSenderProvenance: undefined,
                fileReferences: undefined,
                attachmentPaths: undefined,
                attachmentPromptContexts: undefined,
                deferredToolsReloadEnabledResources:
                  reloadRequest.enabledResources,
                deferredToolsReloadRequestId: reloadRequest.requestId,
                initiationSource:
                  continuationOrigin?.turnId === reloadRequest.userMessageId
                    ? continuationOrigin.source
                    : undefined,
              },
              options,
            ),
        );
        if (reloadRequest.signal.aborted) {
          await destroySession(
            request.projectId,
            request.worktreeId,
            request.chatId,
          );
          reloadRequest.signal.throwIfAborted();
        }
      },
    );

    // Apply the exact requested Codex speed before any turn effect (audit
    // turn, portal frames, acceptance, provider send). A session that cannot
    // receive Ultra fast rejects the send here instead of running at another
    // speed; the in-session admission runs again right before `turn/start`.
    await applyAgentSessionCodexSpeed(session, modelConfig.speed);

    if (deferredToolsReloadEnabledResources) {
      getObservabilityService().recordInjectedPromptForOpenChatTurn(
        request.projectId,
        request.worktreeId,
        request.chatId,
        {
          kind: 'system_prompt_append',
          provider: providerType,
          applicationCondition: 'deferred_tools_reload_continuation',
          text: request.text,
          deferredToolsReload: buildDeferredToolsReloadMetadata(
            deferredToolsReloadEnabledResources,
          ),
        },
      );
    } else {
      getObservabilityService().startChatTurn({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        provider: providerType,
        model,
        modelSource: getModelSource(model),
        executionHarness,
        serviceTier:
          executionHarness === 'codex'
            ? codexServiceTierForModelConfig(modelConfig)
            : undefined,
        aiCreditsRouted: isSessionAiCreditsRouted(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        accountProxyRouted: isSessionAccountProxyRouted(
          request.projectId,
          request.worktreeId,
          request.chatId,
        ),
        originalUserText: request.text,
        submittedText: visibleSubmittedText,
        fileReferences: request.fileReferences,
        planMode: false,
        systemPromptAppend: observedSystemPromptAppend,
        userMessageId: request.userMessageId,
        isStandalone: false,
        assistantMode: 'app-advisor',
        initiationSource: request.initiationSource ?? 'app_advisor',
      });
    }

    await session.setPlanMode(false);
    const liveApprovalMode = clampToLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      request.chatId,
      sessionApprovalMode,
    );
    if (liveApprovalMode) {
      await session.setApprovalMode(liveApprovalMode);
    }
    if (
      (providerType === 'claude' ||
        providerType === 'cursor' ||
        providerType === 'copilot' ||
        providerType === 'opencode') &&
      session.setRtkEnabled
    ) {
      await session.setRtkEnabled(preferences.rtkEnabled);
    }
    if (session.setCodexAppServerIdleTimeoutMinutes) {
      await session.setCodexAppServerIdleTimeoutMinutes(
        preferences.codexAppServerIdleTimeoutMinutes,
      );
    }
    // Single choke point for renderer- and portal-originated sends, so the
    // user message reaches a connected portal exactly once regardless of
    // origin (CAN-2565). Emitted only once every validation/session step has
    // succeeded — the same optimistic point the worktree path uses — so a
    // failed dispatch cannot leave a completed-looking user message with no
    // failure transition. Deferred-tools reload continuations are excluded:
    // their continuation text is an injected prompt the desktop transcript
    // never renders as a user bubble, so the portal must not either.
    // A new visible turn supersedes any prior turn's live timer — a stale
    // still-open timer must not be terminalized by the wrong turn's events.
    // A deferred-tools continuation instead reuses the original visible
    // turn's timer so Portal stays active without another user message.
    if (!isDeferredToolsReloadContinuation) {
      portalTurnTimers.delete(request.chatId);
    }
    if (isCanopyPortalActive() && !isDeferredToolsReloadContinuation) {
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', {
          chatId: request.chatId,
          message: {
            messageId: request.userMessageId,
            chatId: request.chatId,
            role: 'user',
            status: 'complete',
            text: request.text,
            createdAtMs: Date.now(),
            ...(request.agentSent ? { agentSent: request.agentSent } : {}),
          },
        }),
      );
      // App Advisor has no desktop renderer creating the turn-timer row a
      // portal transcript needs, so this path owns it (the worktree portal
      // pattern): a streaming start frame now — the browser's authoritative
      // "agent is working" signal — finalized from the seam on the terminal
      // runtime event. Without the terminal frame the browser kept the
      // spinner and Stop button forever after the turn completed.
      const turnTimer = createPortalTurnTimer({
        chatId: request.chatId,
        userMessageId: request.userMessageId,
      });
      portalTurnTimers.set(request.chatId, turnTimer);
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', {
          chatId: request.chatId,
          message: turnTimer.startMessage,
        }),
      );
    } else if (
      isCanopyPortalActive() &&
      !portalTurnTimers.has(request.chatId)
    ) {
      // Defensive recovery for a continuation whose intermediate terminal
      // event raced ahead of the active-reload marker. Reopen the same stable
      // timer id, but never duplicate the original user frame.
      const turnTimer = createPortalTurnTimer({
        chatId: request.chatId,
        userMessageId: request.userMessageId,
      });
      portalTurnTimers.set(request.chatId, turnTimer);
      enqueuePortalEvent(
        createPortalEvent('portal.app_advisor.event', {
          chatId: request.chatId,
          message: turnTimer.startMessage,
        }),
      );
    }
    // A new visible turn supersedes any prior turn's remembered assistant
    // frame — a cancel racing this dispatch must not re-key 'cancelled' onto
    // the previous turn's content.
    lastAssistantPortalMessages.delete(request.chatId);
    if (!isDeferredToolsReloadContinuation) {
      const occurredAt = new Date(Date.now()).toISOString();
      observation = await captureAdvisorChatObservation(
        request,
        request.userMessageId,
        occurredAt,
      );
      const accepted = await chatStateService.ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: {
          type: 'canopy_user_prompt_accepted',
          canopy_turn_user_message_id: request.userMessageId,
        },
        mutationId: `${request.chatId}:${request.userMessageId}:accepted`,
        providerType,
        turnUserMessageId: request.userMessageId,
      });
      if (accepted && observation) {
        inputObservations.set(
          observation.sourceInputId,
          Promise.resolve(observation),
        );
        advisorChatObservations.set(request.chatId, observation);
        try {
          if (
            await chatStateService.claimNewChatStarted({
              projectId: request.projectId,
              worktreeId: request.worktreeId,
              chatId: request.chatId,
              sourceInputId: request.userMessageId,
              occurredAt: observation.sourceInputAcceptedAt,
            })
          ) {
            await getAppAdvisorWatcherService().handleCanonicalChatStartedEvent(
              {
                kind: 'started',
                eventId: `canonical-chat:${stableHash(observation.address)}:${request.userMessageId}:started`,
                address: observation.address,
                evidence: observation.evidence,
                sourceInputId: observation.sourceInputId,
                occurredAt: observation.sourceInputAcceptedAt,
                observedAt: new Date(Date.now()).toISOString(),
              },
            );
          }
        } catch (error) {
          logMainProcessError(
            'Failed to publish App Advisor chat start',
            error,
          );
        }
      }
    }
    options.admissionSignal?.throwIfAborted();
    recordPresentationTurn(
      presentationChatKey(presentationOrigin),
      request.userMessageId,
      presentationSource,
    );
    try {
      session.sendMessage(providerSubmittedText, {
        userMessageId: request.userMessageId,
        ...(executionHarness === 'opencode' && request.attachmentPaths?.length
          ? {
              attachments: {
                baseDir: attachmentBaseDir,
                paths: [...request.attachmentPaths],
              },
            }
          : {}),
      });
    } catch (error) {
      clearPresentationTurn(
        presentationChatKey(presentationOrigin),
        request.userMessageId,
      );
      throw error;
    }
    if (
      !isDeferredToolsReloadContinuation &&
      session.isDisposed?.() !== true &&
      (presentationSource === 'user' || presentationSource === 'portal')
    ) {
      for (const id of handoffsAtSend) browserHandoffs.release(id);
    }
    options.onTurnAccepted?.();
    return 'dispatched';
  } finally {
    resourceGuard.release();
  }
}

/**
 * Fan out the synthetic un-stream event a cancel needs (CAN-2565). Provider
 * cancellation is authoritative in the session manager, but the renderer's
 * visible turn only closes on a terminal chat event — the same ordered
 * `result` record `emitHostQueueForcedCancellation` sends for worktree chats.
 * Routed through {@link sendAppAdvisorChatEvent} so both desktop windows
 * observe it on the same path as live provider events.
 *
 * The portal needs its own closing frame: a non-error terminal `result`
 * deliberately projects to NO portal message, so the seam alone would leave
 * the portal transcript's last assistant message 'streaming' forever. Re-emit
 * the last streamed assistant frame with status 'cancelled' — same messageId
 * and content, so the server's merge cannot clobber streamed text — then
 * re-project the entry's summaries so `turnActive` clears immediately. A chat
 * that never streamed an assistant frame just gets the summary re-projection.
 *
 * The live portal turn timer is terminalized on this same path: the synthetic
 * `result` is a terminal runtime event, so {@link sendAppAdvisorChatEvent}
 * emits the timer's completion frame and clears its map entry while fanning
 * the cancel out — the browser's turn lifecycle ends alongside the
 * 'cancelled' re-key below.
 */
export async function emitAppAdvisorSyntheticResultEvent(
  chatId: string,
  surfaces: AppAdvisorToolRuntimeSurfaces,
): Promise<void> {
  const { entryId } = await resolveWorkEntryForChat(
    APP_ADVISOR_PROJECT_ID,
    chatId,
  );
  if (!entryId) {
    return;
  }
  // Captured BEFORE the fan-out: the synthetic result is a terminal event,
  // so the seam clears this chat's frame while delivering it.
  const lastAssistantFrame = lastAssistantPortalMessages.get(chatId);
  sendAppAdvisorChatEvent(
    surfaces.getMainWindow,
    surfaces.getAppAdvisorWindow,
    APP_ADVISOR_PROJECT_ID,
    entryId,
    chatId,
    { type: 'result', is_error: false, result: 'Cancelled' },
  );
  if (!isCanopyPortalActive()) {
    return;
  }
  if (lastAssistantFrame) {
    enqueuePortalEvent(
      createPortalEvent('portal.app_advisor.event', {
        chatId,
        message: {
          ...lastAssistantFrame,
          status: 'cancelled',
          updatedAtMs: Date.now(),
        },
      }),
    );
  }
  const { projectAppAdvisorChatSummaries } =
    await import('../services/chat-service');
  await projectAppAdvisorChatSummaries(entryId).catch(() => undefined);
}
