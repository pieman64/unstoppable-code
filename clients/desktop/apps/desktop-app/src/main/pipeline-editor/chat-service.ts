import { getChatQueueService } from '../services/chat-queue-service';
import { buildTrustedUserPromptEvent } from '../lib/chat-trusted-user-prompt';
import { getOrCreateRoutedSession } from '../agents/session-event-router';
import type { BrowserWindow } from 'electron';
import { mkdir } from 'node:fs/promises';
import {
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  getModelSource,
  getExecutionHarnessForModel,
  requireProviderForModel,
  resolveProviderModelConfig,
  type AgentProviderType,
  type AgentTranscriptInjectedPrompt,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
  PIPELINE_EDITOR_REQUIRED_SKILL_REF,
  PIPELINE_EDITOR_TOOL_REGISTRY,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { stableHash } from '@canopy/desktop-shared/lib/stable-hash';
import { codexServiceTierForModelConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import { applyAgentSessionCodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import { validateId } from '../lib/validation';
import { buildSubmittedMessageText } from '../lib/chat-submitted-message';
import {
  getPipelineEditorHomeDir,
  getWorktreeAttachmentsDir,
} from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { requireLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import { resolveLaneSubstitutedProviderType } from '../lib/lane-substituted-provider';
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import {
  destroySession,
  getSessionExecutionHarness,
  shouldRecreateSessionOnNextTurn,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
} from '../agents/session-manager';
import { sendToWindowDetailed } from '../lib/window-send';
import { getObservabilityService } from '../observability';
import {
  getChatTurnAuditStatus,
  isRecord,
  isTerminalChatEventData,
} from '../lib/chat-turn-audit';
import { describeChatEventData } from '../lib/chat-event-description';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import { getResourceMonitorService } from '../resource-monitor';
import {
  createPipelineEditorToolRuntime,
  type PipelineEditorToolRuntimeSurfaces,
} from './runtime';
import { getPipelineEditorSystemPrompt } from './system-prompt';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { getChatStateService } from '../services/chat-state-service';
import { logMainProcessError } from '../lib/main-process-logging';
import { clampToLiveApprovalMode } from '../approvals/live-approval-modes';
import {
  readPersistedChatDispatchMetadata,
  type PersistedChatDispatchMetadata,
} from '../lib/chat-tabs-reader';

function createEmptyPluginSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
}

function withRequiredPipelineSkill(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const base = selections ?? createEmptyPluginSelections();
  return {
    ...base,
    skillRefs: [
      ...(base.skillRefs ?? []).filter(
        (ref) => ref.skillName !== PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
      ),
      PIPELINE_EDITOR_REQUIRED_SKILL_REF,
    ],
  };
}

function sendPipelineEditorChatEvent(
  getMainWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
  context?: { providerType?: AgentProviderType; model?: ChatModel },
): void {
  const delivery = sendToWindowDetailed(
    getMainWindow(),
    IPC_CHANNELS.chatEvent,
    { projectId, worktreeId, chatId, data },
  );

  if (!delivery.delivered) {
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
      sendFailureReason: delivery.reason,
    });
  }
}

export async function resolvePipelineEditorCwd(): Promise<string> {
  const cwd = getPipelineEditorHomeDir();
  await mkdir(cwd, { recursive: true });
  return cwd;
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

export async function dispatchPipelineEditorChatMessage(
  request: ChatSendMessageRequest & { deferredToolsReloadRequestId?: string },
  options: {
    getMainWindow: () => BrowserWindow | null;
    toolSurfaces: PipelineEditorToolRuntimeSurfaces;
  },
): Promise<void> {
  if (
    request.projectId !== PIPELINE_EDITOR_PROJECT_ID ||
    request.worktreeId !== PIPELINE_EDITOR_WORKTREE_ID
  ) {
    throw new Error(
      'Pipeline Editor chat must use the pipeline-editor sentinel ids.',
    );
  }

  validateId(request.chatId, 'chatId');
  validateId(request.userMessageId, 'userMessageId');
  const resourceGuard =
    await getResourceMonitorService().reserveChatTurnStart();
  try {
    const deferredToolsReloadEnabledResources =
      request.deferredToolsReloadEnabledResources;
    const systemPromptAppend = getPipelineEditorSystemPrompt();
    const preferences = await readPreferencesFile();
    const defaultProviderSelection =
      request.model === undefined
        ? await requireLaneAwareDefaultSelection(
            preferences,
            'chat',
            // Same id the session spawn resolves its environment for, so a
            // Canopy Environments provider credential is judged against the
            // environment this turn will really run in.
            { workspaceId: request.projectId },
            request.providerType,
            // Forced to this tab's provider, so it answers "what should THIS
            // turn run?" rather than "what is the user's default model?" —
            // `stampProjection` must be false or it writes
            // `lastProjectedDefaultModel`, the sole source of `isDefault: true`
            // in the Portal catalog. Every other forced-provider caller passes
            // false; this one was the outlier.
            false,
          )
        : undefined;
    const selectedModel = request.model ?? defaultProviderSelection?.model;
    if (!selectedModel) {
      throw new Error('No dispatchable Pipeline Editor model is available.');
    }
    // Lane resolution can return a native model from a DIFFERENT lane than the
    // forced `providerType` — see `resolveLaneSubstitutedProviderType`. Pinning
    // the request's provider over that model pairs (say) a Claude model with
    // the Codex harness and trips the guard below, which is the same dead end
    // `worktree-chat-turn.ts` reconciles.
    const laneSubstitutedProviderType = resolveLaneSubstitutedProviderType({
      explicitModel: request.model,
      requestedProviderType: request.providerType,
      selectedModel,
    });
    // An explicitly supplied `providerType` is otherwise AUTHORITATIVE on BOTH
    // branches, mirroring `worktree-chat-turn.ts`. Discarding it on the
    // lane-resolved branch silently dispatched a Pipeline Editor chat that
    // asked for `codex` as `claude`, which then tripped the harness guard.
    const selectedProviderType =
      laneSubstitutedProviderType ??
      request.providerType ??
      requireProviderForModel(selectedModel);
    // Keyed on the SELECTED model's provider, never unconditionally on Claude —
    // the same rule `hook-chat.ts` and `automations/service.ts` state.
    //
    // `defaultProviderSelection` is `undefined` on the explicit-model branch
    // (it is only resolved when `request.model === undefined`), so falling
    // straight through to `defaultChatModelByProvider.claude` handed a
    // Codex-pinned tab with no per-tab level Claude's configured level: with
    // `codex: 'high'` and `claude: 'off'` the turn silently ran at `off`.
    const thinkingLevel =
      request.thinkingLevel ??
      defaultProviderSelection?.thinkingLevel ??
      preferences.defaultChatModelByProvider[selectedProviderType]
        ?.thinkingLevel ??
      preferences.defaultChatModelByProvider.claude.thinkingLevel;
    const selectedPluginSelections = withRequiredPipelineSkill(
      request.pluginSelections ?? preferences.pipelineEditorPluginSelections,
    );
    const persistedDispatchMetadata = await readPersistedChatDispatchMetadata(
      request.projectId,
      request.worktreeId,
      request.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    );
    const runtime = await resolveAgentModelRuntime({
      projectId: request.projectId,
      model: selectedModel,
      systemPromptAppend,
      pluginSelections: selectedPluginSelections,
      providerType: selectedProviderType,
    });
    const model = runtime.runtimeModel;
    const providerType = runtime.providerType;
    const executionHarness =
      // A cross-lane substitution invalidates every remembered harness: the
      // model that will actually run is the substituted one, so the harness
      // follows it rather than the lane this chat used to be on.
      (laneSubstitutedProviderType
        ? getExecutionHarnessForModel(selectedModel)
        : undefined) ??
      getSessionExecutionHarness(
        request.projectId,
        request.worktreeId,
        request.chatId,
      ) ??
      persistedDispatchMetadata.executionHarness ??
      (persistedDispatchMetadata.model
        ? getExecutionHarnessForModel(persistedDispatchMetadata.model)
        : undefined) ??
      runtime.executionHarness;
    if (
      executionHarness === 'cursor' ||
      runtime.executionHarness === 'cursor' ||
      providerType === 'cursor' ||
      request.executionHarness === 'cursor'
    ) {
      // Check restored models too, before persisting the prompt or settings.
      const { isCursorRuntimeAvailable } =
        await import('../cursor/runtime-availability');
      const { readCursorAccount } = await import('../cursor/connection');
      if (
        !(await isCursorRuntimeAvailable()) ||
        !(await readCursorAccount(AbortSignal.timeout(20_000)))
      )
        throw new Error(
          'Connect Cursor in Settings to use Pipeline Assistant.',
        );
    }
    if (
      request.executionHarness !== undefined &&
      request.executionHarness !== executionHarness &&
      // Callers forward the tab's persisted harness, so a substituted turn
      // arrives holding the OLD lane's harness. Throwing on that is the same
      // dead end the substitution removes.
      laneSubstitutedProviderType === undefined
    ) {
      throw new Error(
        'Pipeline Editor execution harness does not match host-owned routing',
      );
    }
    const pluginSelections =
      runtime.pluginSelections ?? selectedPluginSelections;
    const runtimeSystemPromptAppend =
      runtime.systemPromptAppend ?? systemPromptAppend;
    const cwd = await resolvePipelineEditorCwd();
    const visibleSubmittedText = buildSubmittedMessageText({
      text: request.text,
      fileReferences: request.fileReferences,
      attachmentPaths: request.attachmentPaths,
      attachmentPromptContexts: request.attachmentPromptContexts,
      attachmentBaseDir: getWorktreeAttachmentsDir(
        request.projectId,
        request.worktreeId,
      ),
      cwd,
      inputMode: request.inputMode,
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

    const pipelineEditorRuntime = createPipelineEditorToolRuntime(
      options.toolSurfaces,
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId: request.chatId,
        providerType,
        pluginSelections,
        deferredToolsAllowed:
          executionHarness !== 'cursor' &&
          request.deferredToolsAllowed !== false,
        ...(model ? { model } : {}),
      },
    );
    const toolProfileHash = stableHash({
      mode: 'pipeline-editor',
      providerType,
      model,
      thinkingLevel,
      pluginSelections,
      deferredToolsAllowed:
        executionHarness !== 'cursor' && request.deferredToolsAllowed !== false,
      tools: Object.values(PIPELINE_EDITOR_TOOL_REGISTRY).map((tool) => ({
        key: tool.canonicalKey,
        claude: tool.claudeToolName,
        codex: tool.codexToolName,
      })),
    });
    const modelConfig = resolveProviderModelConfig(
      executionHarness,
      { thinkingLevel, modelConfig: request.modelConfig },
      preferences.providerModelConfigDefaults,
    );
    const chatStateService = getChatStateService();
    await chatStateService.ensureChatForTrustedSend({
      ...request,
      providerType,
      model: selectedModel,
      modelConfig,
      pluginSelections,
    });
    if (deferredToolsReloadEnabledResources === undefined) {
      const promptCommitted = await chatStateService.ingestProviderEvent({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        data: buildTrustedUserPromptEvent({ ...request, providerType, model }),
        mutationId: `${request.chatId}:${request.userMessageId}:user-prompt`,
        providerType,
        turnUserMessageId: request.userMessageId,
      });
      if (!promptCommitted) {
        const accepted = await chatStateService.hasMutation(
          { projectId: request.projectId, worktreeId: request.worktreeId },
          `${request.chatId}:${request.userMessageId}:accepted`,
        );
        if (accepted) return;
      }
    }
    if (deferredToolsReloadEnabledResources === undefined) {
      scheduleChatSummary({
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
        cwd,
        getWindow: options.getMainWindow,
        // The sentinel project is not a real worktree, so the default
        // worktree-chat link target would render a dead "Inspect" button.
        // Point it at the Pipelines page where the editor chat lives.
        linkTarget: {
          page: 'pipelines',
          kind: 'pipeline-editor',
          chatId: request.chatId,
        },
      });
    }
    let executionUserMessageId = request.userMessageId;
    const deliverProviderEvent = (data: unknown): void => {
      getObservabilityService().observeChatEvent(
        request.projectId,
        request.worktreeId,
        request.chatId,
        data,
      );
      sendPipelineEditorChatEvent(
        options.getMainWindow,
        request.projectId,
        request.worktreeId,
        request.chatId,
        data,
        { providerType, ...(model ? { model } : {}) },
      );
      const eventData = isRecord(data) ? data : null;
      if (eventData && isTerminalChatEventData(eventData)) {
        if (
          deferredToolsReloadCoordinator.hasActiveReload({
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            chatId: request.chatId,
          })
        ) {
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
        getObservabilityService().completeChatTurn(
          request.projectId,
          request.worktreeId,
          request.chatId,
          status,
          error,
        );
      }
    };
    let providerEventCommitTail = Promise.resolve();
    let providerEventSequence = 0;
    const sessionApprovalMode = clampToLiveApprovalMode(
      request.projectId,
      request.worktreeId,
      request.chatId,
      request.approvalMode,
    );
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
        ...(laneSubstitutedProviderType
          ? {}
          : { sdkSessionId: request.sdkSessionId }),
        pluginSelections,
        deferredToolsAllowed:
          executionHarness !== 'cursor' &&
          request.deferredToolsAllowed !== false,
        systemPromptAppend: runtimeSystemPromptAppend,
        providerType,
        executionHarness,
        codexAppServerIdleTimeoutMinutes:
          preferences.codexAppServerIdleTimeoutMinutes,
        codexMultiAgentEnabled: false,
        rtkEnabled:
          executionHarness === 'claude' ? preferences.rtkEnabled : false,
        assistantMode: 'pipeline-editor',
        toolProfileHash,
        pipelineEditorRuntime,
      },
      (data: unknown, markPersistenceSettled?: () => void): Promise<void> => {
        const sequence = providerEventSequence;
        providerEventSequence += 1;
        providerEventCommitTail = providerEventCommitTail
          .then(async () => {
            const outcome =
              await chatStateService.ingestProviderEventWithOutcome({
                projectId: request.projectId,
                worktreeId: request.worktreeId,
                chatId: request.chatId,
                data,
                mutationId: request.deferredToolsReloadRequestId
                  ? `${request.chatId}:${request.userMessageId}:deferred-reload:${request.deferredToolsReloadRequestId}:provider:${sequence}`
                  : `${request.chatId}:${request.userMessageId}:provider:${sequence}`,
                providerType,
                turnUserMessageId: executionUserMessageId,
              });
            markPersistenceSettled?.();
            // Activity-only events carry no durable change but are live.
            if (outcome === 'not-applied') return;
            if (
              isRecord(data) &&
              data.type === 'canopy_input_delivery' &&
              data.phase === 'picked-up' &&
              data.startsTurn === true &&
              typeof data.userMessageId === 'string'
            ) {
              let pickupAccepted: boolean;
              if (data.turnRootAccepted === false) {
                pickupAccepted = false;
              } else if (data.turnRootAccepted === true) {
                getChatQueueService().confirmTurnRevived(
                  request,
                  data.userMessageId,
                );
                pickupAccepted = true;
              } else {
                pickupAccepted = getChatQueueService().onTurnRevived(
                  request,
                  data.userMessageId,
                );
              }
              if (pickupAccepted) {
                executionUserMessageId = data.userMessageId;
              }
            }
            deliverProviderEvent(data);
          })
          .catch((error: unknown) => {
            markPersistenceSettled?.();
            logMainProcessError(
              `Failed to durably commit Pipeline Editor chat event for ${request.chatId}`,
              error,
            );
          });
        return providerEventCommitTail;
      },
      options.getMainWindow,
      {
        turnUserMessageId: executionUserMessageId,
        acceptTurnRoot: async (turnUserMessageId): Promise<boolean> => {
          await providerEventCommitTail;
          return getChatQueueService().onTurnRevived(
            request,
            turnUserMessageId,
          );
        },
        drainEventsBeforeRemoval: () => providerEventCommitTail,
      },
    );

    deferredToolsReloadCoordinator.registerResumeHandler(
      {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        chatId: request.chatId,
      },
      async (reloadRequest) => {
        reloadRequest.signal.throwIfAborted();
        await dispatchPipelineEditorChatMessage(
          {
            ...request,
            userMessageId: reloadRequest.userMessageId,
            text: reloadRequest.continuationText,
            sdkSessionId:
              reloadRequest.sdkSessionId ??
              session.getProviderSessionId?.() ??
              request.sdkSessionId,
            providerType: reloadRequest.providerType ?? providerType,
            pluginSelections:
              reloadRequest.pluginSelections ?? pluginSelections,
            hiddenContext: undefined,
            fileReferences: undefined,
            attachmentPaths: undefined,
            attachmentPromptContexts: undefined,
            deferredToolsReloadEnabledResources: reloadRequest.enabledResources,
            deferredToolsReloadRequestId: reloadRequest.requestId,
          },
          options,
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
    // turn, provider send, acceptance). A session that cannot receive Ultra
    // fast rejects the send here instead of running at another speed; the
    // in-session admission runs again right before `turn/start`.
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
        systemPromptAppend,
        userMessageId: request.userMessageId,
        isStandalone: false,
        assistantMode: 'pipeline-editor',
        initiationSource: request.initiationSource ?? 'user',
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
    if (providerType === 'claude' && session.setRtkEnabled) {
      await session.setRtkEnabled(preferences.rtkEnabled);
    }
    if (session.setCodexAppServerIdleTimeoutMinutes) {
      await session.setCodexAppServerIdleTimeoutMinutes(
        preferences.codexAppServerIdleTimeoutMinutes,
      );
    }
    session.sendMessage(providerSubmittedText, {
      userMessageId: request.userMessageId,
    });
    if (deferredToolsReloadEnabledResources === undefined) {
      await chatStateService.ingestProviderEvent({
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
    }
  } finally {
    resourceGuard.release();
  }
}
