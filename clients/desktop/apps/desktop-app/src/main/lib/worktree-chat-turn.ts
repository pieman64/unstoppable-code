import {
  recordPresentationTurn,
  capturePresentationTurn,
  clearPresentationTurn,
  presentationChatKey,
} from '../canopy-tools/presentation-state';
import { browserHandoffs } from '../browser/browser-handoffs';
import { chatVisualsPromptEligible } from './chat-visuals-feature-flag';
import { assertOpenCodeModelAvailable } from '../opencode/connection';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isAgentDelegationTranscript } from '@canopy/protocol/delegation';
import { beginChatTurnPreparation } from './chat-turn-cancel';
import {
  getOrCreateRoutedSession,
  sessionEventRouterTestExports,
} from '../agents/session-event-router';
import {
  claimDelegationDelivery,
  releaseDelegationDelivery,
} from '../agents/delegation/lifecycle';
import { resolveManagedDelegationMode } from '../agents/delegation/gate';
import { logMainProcessError } from './main-process-logging';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import { CHAT_LABEL, type WorkOwner } from '@canopy/protocol';
import { MEMORY_SEARCH_CAPABILITY } from '@canopy/protocol/memory';
import { MAX_TELEMETRY_CLIENT_ID_LENGTH } from '@canopy/protocol/telemetry';
import { clampId } from '@canopy/desktop-shared/lib/telemetry-mapping';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  CODE_REVIEW_CHAT_PROJECT_ID,
  GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
  IPC_CHANNELS,
  ORG_MEMORY_USED_EVENT_TYPE,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SINGLE_REPO_USAGE_REPO_ID,
  STANDALONE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForModel,
  isSetAutoArchiveRequestedEventData,
  requireProviderForModel,
  normalizeAgentModelConfig,
  resolveModelAlias,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type AiCreditsRoutingState,
  type AgentAuditLinkTarget,
  type AgentProviderType,
  type ApprovalMode,
  type ApprovalRule,
  type ChatActiveSessionInfo,
  type ChatModel,
  type ChatSendMessageRequest,
  type ChatTabPluginSelections,
  type FileReference,
  type OrgMemoryUsedEventData,
  type PendingSystemInstruction,
  type PreferencesData,
  type UsageInitiationSource,
  type ThinkingLevel,
  type DeferredResourceSummary,
} from '@canopy/desktop-shared/types';
import { codexServiceTierForModelConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import { applyAgentSessionCodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { buildCodeReviewPrompt } from '@canopy/desktop-shared/lib/code-review-prompt';
import {
  appendUserOverallPreferencesBlock,
  buildUserOverallPreferencesBlock,
} from '@canopy/desktop-shared/lib/global-instructions';
import type { ObservabilityService } from '../observability/service';
import type { PipelinePackageCapabilityOverlay } from '@canopy/desktop-shared/types/pipeline';
import type {
  ChatQueueService,
  ChatQueueTerminalStatus,
} from '../services/chat-queue-service';
import type { PersistedChatDispatchMetadata } from './chat-tabs-reader';
import {
  beginSessionTurnPreparation,
  releaseSessionTurnPreparationOnActivation,
  buildSessionKey,
  getActiveSessionInfos,
  canReuseSession,
  canPreserveSessionCapabilitySnapshot,
  destroySession,
  shouldRecreateSessionOnNextTurn,
  isSessionAccountProxyRouted,
  isSessionAiCreditsRouted,
  getSessionCodeGraphToolsAdvertised,
  getSessionGlobalInstructionsSnapshot,
  getSessionProviderType,
} from '../agents/session-manager';
import {
  captureSessionWorkOwner,
  resolveSessionWorkOwner,
} from '../agents/work-owner';
import { generateAndRenameBranch } from './branch-namer';
import { readHelperUsage } from '@canopy/desktop-shared/lib/helper-usage';
import { normalizeOrganizationExternalId } from '@canopy/desktop-shared/lib/org-memory';
import { isCoworkWorkspace } from './workspace-registry';
import { pairPendingAuthFailuresWithTool } from './auth-failure-event';
import { stopTurnForAuthFailure } from './auth-failure-turn-stop';
import {
  getDiagnosticEventMetadata,
  getChatTurnAuditStatus,
  isAgentContinuationEvent,
  isCodexSubagentFollowupEvent,
  isRecord,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  readCodexRootThreadId,
} from './chat-turn-audit';
import {
  SessionEventCommitPipeline,
  isOverlappableProviderEvent,
} from './session-event-commit-pipeline';
import {
  doesBranchMatchWorktreeId,
  isBranchPromptSent,
  readPersistedWorktreeBranch,
  resolveWorktreeCwd,
  resolveWorktreeTargetIds,
} from './resolve-worktree';
import { recordWorktreeDiscovery } from './worktree-repair';
import { composeWorktreeRepoRules } from '../repo-rules/host';
import { selectSessionInstructions } from '../repo-rules/session';
import { readPreferencesFile } from '../lib/preferences-store';
import { requireLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import { resolveLaneSubstitutedProviderType } from './lane-substituted-provider';
import { claudeContinuationSession } from './claude-fork-continuation';
import { sendToWindow, sendToWindowDetailed } from './window-send';
import { scheduleSummaryGeneration } from './worktree-summary-scheduler';
import {
  noteCodeReviewTurnEnd,
  noteCodeReviewTurnStart,
  noteWorktreeActivityForCodeReview,
} from './code-review-scheduler';
import { captureTurnEndAndDiff, captureTurnStart } from './turn-diff-capture';
import { scheduleCodeGraphBuild } from './code-graph-scheduler';
import {
  buildSubmittedMessageText,
  prependPendingSystemInstructions,
} from './chat-submitted-message';
import {
  resolveActivePlanSystemInstruction,
  withActivePlanInstruction,
} from './active-plan-instruction';
import {
  readPersistedChatDispatchMetadata,
  readPersistedChatExecutionContext,
} from './chat-tabs-reader';
import { recordBackgroundProcessChatEvent } from '../portal/background-process-tracker';
import { getWorktreeAttachmentsDir } from './paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { buildWorktreeInjectedToolPrompt } from '../canopy-tools/prompting';
import { isCodeGraphAvailableForWorkspace } from './code-graph-availability';
import { buildCodeGraphAvailabilityPrompt } from './code-graph-availability-prompt';
import {
  buildCoworkDispatchSystemPromptAppend,
  buildLocalMemoryPromptNudge,
} from './cowork-chat-system-prompt';
import { describeChatEventData } from './chat-event-description';
import { buildPlanModeWorkspaceScopePrompt } from './plan-mode-workspace-scope';
import {
  getPlanFileSyncService,
  planChatTurnKey,
  resolvePlanTurnScope,
  type PlanTurnLease,
} from './plan-file-sync';
import {
  getResourceMonitorService,
  type ResourceGuardReservation,
} from '../resource-monitor';
import { resolveAgentModelRuntime } from '../agents/agent-model-runtime';
import {
  captureCanonicalChatProducerContext,
  notifyCanonicalChatStarted,
  notifyCanonicalChatTerminal,
} from '../services/active-chat-input';
import { readWorkspaceConfig } from './workspace-persistence';
import { generateChatSummaryForProject } from '../ipc/standalone-chat';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from './background-helper-queue';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';
import {
  fetchOrgMemoryAttempt,
  type OrgMemoryFetchAttempt,
  type OrgMemoryFetchResult,
} from '../memory/memory-client';
import { createOrgMemoryDeliveryTracker } from '../memory/delivery-tracker';
import { resolveOrgMemoryOwner } from '../memory/memory-owner';
import { isOrganizationTeamsLapsed } from './org-billing-state';
import { persistOrgMemoryUsedForChat } from './chat-tab-dispatch-utils';
import { assertChatScopeAcceptsTurns } from './retired-chat-scope-guard';
import { clampToLiveApprovalMode } from '../approvals/live-approval-modes';
import { getChatStateService } from '../services/chat-state-service';
import { getStoppedTurnResumeService } from '../services/stopped-turn-resume-service';
import {
  MEMORY_QUERY_MAX_CHARS,
  buildMemoryQuery,
  composeSubmittedText,
  getMemoryQueryBranchName,
  isTrivialMemoryInput,
  joinHiddenBlocks,
  raceWithTimeout,
  remainingMemoryBudgetMs,
  shouldFetchMemory,
  type MemoryQueryContext,
} from '../memory/memory-context';
import { collectMemoryQueryContext } from '../memory/query-context';
import { prepareLocalMemoryContext } from '../memory/local/prepare';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';

const activeTurnUserMessageIds = new Map<string, string>();

function isCodexAsyncQuestionEvent(eventData: unknown): boolean {
  if (!isRecord(eventData) || eventData.type !== 'codex') return false;
  const event = eventData.event;
  if (!isRecord(event) || event.type !== 'item.completed') return false;
  const item = event.item;
  return (
    isRecord(item) && item.type === 'agent_message' && item.delivery === 'async'
  );
}

async function getChatQueueServiceForTurnLifecycle(): Promise<ChatQueueService> {
  // Keep this local import lazy to break the queue-service/worktree-chat-turn
  // cycle: queue cancellation imports this module to clear its active turn.
  // electron-vite bundles this relative module into the compiled main output;
  // build:e2e plus the Electron tab-ordering suite verify that bundled path.
  const { getChatQueueService } =
    await import('../services/chat-queue-service');
  return getChatQueueService();
}
/**
 * Forget the active-turn marker for a chat whose turn was just cancelled on
 * behalf of a force-send. The cancelled turn's terminal event may not have
 * arrived yet; without this, the immediate follow-up dispatch would trip the
 * second-active-turn guard below. The stale terminal event is still filtered
 * by the userMessageId mismatch check in the terminal handler.
 */
export function clearActiveTurnUserMessageId(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const key = buildSessionKey(projectId, worktreeId, chatId);
  clearPresentationTurn(key, activeTurnUserMessageIds.get(key));
  activeTurnUserMessageIds.delete(key);
}
type ObservabilityServiceType = ObservabilityService;

function getEventTurnUserMessageId(
  data: Record<string, unknown>,
): string | null {
  return typeof data.canopy_turn_user_message_id === 'string'
    ? data.canopy_turn_user_message_id
    : null;
}

function resolveCodexPreferenceModelConfig(
  model: ChatModel | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  defaults: PreferencesData['providerModelConfigDefaults'] | undefined,
): AgentModelConfig | undefined {
  if (!model || getExecutionHarnessForModel(model) !== 'codex') {
    return undefined;
  }

  return resolveProviderModelConfig('codex', { thinkingLevel }, defaults);
}

function sendWorktreeChatEvent(
  getWindow: () => BrowserWindow | null,
  projectId: string,
  worktreeId: string,
  chatId: string,
  data: unknown,
  context?: {
    providerType?: AgentProviderType;
    model?: ChatModel;
  },
): void {
  try {
    recordBackgroundProcessChatEvent(
      {
        workspaceLocalId: projectId,
        worktreeLocalId: worktreeId,
        chatId,
      },
      data,
    );
  } catch (error: unknown) {
    // The tracker is a side channel; it must never block chat delivery.
    logMainProcessError('Background-process tracking failed', error);
  }
  const delivery = sendToWindowDetailed(getWindow(), IPC_CHANNELS.chatEvent, {
    projectId,
    worktreeId,
    chatId,
    data,
  });

  if (!delivery.delivered) {
    const matchingSession = getActiveSessionInfos(projectId, worktreeId).find(
      (session): boolean => session.chatId === chatId,
    );
    const eventType = describeChatEventData(data, {
      includePhaseEvents: true,
    });
    // eslint-disable-next-line no-console
    console.warn('[chat-ipc] Renderer unavailable for worktree chat event', {
      projectId,
      worktreeId,
      chatId,
      eventType: describeChatEventData(data),
      terminal: isTerminalChatEventData(data),
      sessions: getActiveSessionInfos(projectId, worktreeId),
    });
    recordUndeliveredWorktreeEvent({
      projectId,
      worktreeId,
      chatId,
      matchingSession,
      data,
      providerType: context?.providerType,
      model: context?.model,
      eventType,
      sendFailureReason: delivery.reason,
    });
  }
}

function recordUndeliveredWorktreeEvent(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  matchingSession?: ChatActiveSessionInfo;
  data: unknown;
  providerType?: AgentProviderType;
  model?: ChatModel;
  eventType: string;
  sendFailureReason:
    | 'no_window'
    | 'window_destroyed'
    | 'webcontents_destroyed'
    | 'webcontents_crashed'
    | 'frame_destroyed'
    | 'frame_detached'
    | 'render_frame_disposed';
}): void {
  const eventMetadata = getDiagnosticEventMetadata(options.data);
  const timestamp = new Date().toISOString();
  void Promise.all([
    loadObservabilityService(),
    readPersistedChatDispatchMetadata(
      options.projectId,
      options.worktreeId,
      options.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    ),
  ])
    .then(([observabilityService, persistedMetadata]) => {
      observabilityService.recordSessionDiagnostic({
        version: 1,
        timestamp,
        kind: 'chat_event_undelivered',
        sessionKey: buildSessionKey(
          options.projectId,
          options.worktreeId,
          options.chatId,
        ),
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        providerType:
          options.matchingSession?.providerType ??
          eventMetadata.providerType ??
          options.providerType ??
          persistedMetadata.providerType ??
          'unknown',
        ...(options.matchingSession?.model ||
        eventMetadata.model ||
        options.model ||
        persistedMetadata.model
          ? {
              model:
                options.matchingSession?.model ??
                eventMetadata.model ??
                options.model ??
                persistedMetadata.model,
            }
          : {}),
        ...(typeof options.matchingSession?.turnActive === 'boolean'
          ? { turnActive: options.matchingSession.turnActive }
          : {}),
        ...(typeof options.matchingSession?.turnCount === 'number'
          ? { turnCount: options.matchingSession.turnCount }
          : {}),
        ...(typeof options.matchingSession?.pendingMessageCount === 'number'
          ? { pendingMessageCount: options.matchingSession.pendingMessageCount }
          : {}),
        ...(options.matchingSession?.lastEventType
          ? { lastEventType: options.matchingSession.lastEventType }
          : {}),
        ...(typeof options.matchingSession?.lastActivityAt === 'number'
          ? { lastActivityAt: options.matchingSession.lastActivityAt }
          : {}),
        eventType: options.eventType,
        terminal: isTerminalChatEventData(options.data),
        sendFailureReason: options.sendFailureReason,
      });
    })
    .catch(() => {});
}

async function loadObservabilityService(): Promise<ObservabilityServiceType> {
  // Observability instruments this turn path, so eager loading would cycle.
  const { getObservabilityService } = await import('../observability');
  return getObservabilityService();
}

async function generateWorktreeChatSummary(
  userMessage: string,
  options: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    modelConfig?: AgentModelConfig;
    cwd: string;
    observabilityTaskKey: string;
    projectId?: string;
  },
): Promise<{
  text: string;
  fallback?: { reason: string; retryable?: boolean };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalCostUsd?: number;
    messageCount?: number;
    assistantMessageCount?: number;
  };
}> {
  return generateChatSummaryForProject(userMessage, options);
}

export interface ScheduleChatSummaryOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  getWindow: () => BrowserWindow | null;
  getAdditionalWindows?: () => Array<BrowserWindow | null>;
  linkTarget?: AgentAuditLinkTarget;
  /**
   * When set, the chat is a standalone chat under this chat-project id: the
   * generated description is also persisted to the chat's meta file and
   * broadcast over `standaloneChatMetaUpdated` so the history list updates.
   */
  standaloneChatProjectId?: string;
  /**
   * Optional main-side persistence hook for sends that have no renderer-owned
   * tab. It runs before broadcasts so derived sidebar metadata never depends
   * on the destination chat already being mounted.
   */
  persistDescription?: (description: string) => Promise<void>;
  /** Owner captured by the originating chat session before this task queues. */
  workOwner?: Promise<WorkOwner | undefined>;
}

const initialTitleRequests = new Set<string>();
/**
 * Thrown provider errors (offline, credentials, abort) leave naming pending so
 * a later turn retries; after this many in one process the fallback is saved,
 * bounding repeated helper spend.
 */
const MAX_RETRYABLE_INITIAL_TITLE_FAILURES = 3;
const retryableInitialTitleFailures = new Map<string, number>();
/**
 * Thrown canonical writes keep naming eligible; after this many in one process
 * the chat stops requesting titles until restart, so a persistently failing
 * store cannot trigger a model call on every turn.
 */
const MAX_FAILED_INITIAL_TITLE_COMMITS = 3;
const failedInitialTitleCommits = new Map<string, number>();

function settleInitialTitleAttempts(key: string): void {
  retryableInitialTitleFailures.delete(key);
  failedInitialTitleCommits.delete(key);
}

export function scheduleChatSummary(options: ScheduleChatSummaryOptions): void {
  const scope = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
  };
  const key = JSON.stringify([
    options.projectId,
    options.worktreeId,
    options.chatId,
  ]);
  if (initialTitleRequests.has(key)) return;
  if (
    (failedInitialTitleCommits.get(key) ?? 0) >=
    MAX_FAILED_INITIAL_TITLE_COMMITS
  )
    return;
  initialTitleRequests.add(key);
  void (async (): Promise<void> => {
    const service = getChatStateService();
    if (
      (await service.getInitialChatTitlePrompt(scope, options.chatId)) === null
    ) {
      settleInitialTitleAttempts(key);
      return;
    }
    await enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      task: async (): Promise<void> => {
        const firstPrompt = await service.getInitialChatTitlePrompt(
          scope,
          options.chatId,
        );
        if (firstPrompt === null) {
          settleInitialTitleAttempts(key);
          return;
        }
        const prefs = await readPreferencesFile();
        const summaryModel = prefs.summaryModel;
        const taskKey = `helper:chat-summary:${options.projectId}/${options.worktreeId}/${options.chatId}:${Date.now()}`;
        const summaryModelConfig = resolveCodexPreferenceModelConfig(
          summaryModel,
          prefs.summaryThinkingLevel,
          prefs.providerModelConfigDefaults,
        );
        const observabilityService = await loadObservabilityService();
        const hasBoundWorkOwner = Object.prototype.hasOwnProperty.call(
          options,
          'workOwner',
        );
        const workOwner = hasBoundWorkOwner
          ? ((await options.workOwner) ?? null)
          : undefined;
        observabilityService.startObservedTask(taskKey, {
          id: taskKey,
          eventType: 'chat_summary',
          status: 'running',
          provider: requireProviderForModel(summaryModel),
          label: `${CHAT_LABEL} Summary`,
          startedAt: new Date().toISOString(),
          model: summaryModel,
          serviceTier: summaryModelConfig
            ? codexServiceTierForModelConfig(summaryModelConfig)
            : undefined,
          tokens: {
            input: 0,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          messageCount: 0,
          assistantMessageCount: 0,
          toolUseCount: 0,
          subAgentCount: 0,
          hasTranscript: false,
          toolCounts: {
            thinking: 0,
            bash: 0,
            read: 0,
            readLines: 0,
            writeEdit: 0,
            plan: 0,
            fileEdit: 0,
            fileAdd: 0,
            fileDelete: 0,
            search: 0,
            grep: 0,
            web: 0,
            agent: 0,
            workflow: 0,
            tasks: 0,
            taskStop: 0,
            skills: 0,
            monitor: 0,
            claude: 0,
            scheduleWakeup: 0,
            askUser: 0,
            scriptOutput: 0,
            watcher: 0,
            canopy: 0,
            graph: 0,
            appAdvisor: 0,
            pipelineEditor: 0,
            mcp: 0,
            other: 0,
          },
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          linkTarget: options.linkTarget ?? {
            page: 'main',
            kind: 'worktree-chat',
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          },
        });
        await generateWorktreeChatSummary(firstPrompt, {
          model: summaryModel,
          thinkingLevel: prefs.summaryThinkingLevel,
          modelConfig: summaryModelConfig,
          cwd: options.cwd,
          observabilityTaskKey: taskKey,
          projectId: options.standaloneChatProjectId ?? options.projectId,
          ...(hasBoundWorkOwner ? { workOwner } : {}),
        })
          .then(async (result) => {
            if (result.fallback?.retryable === true) {
              const failures =
                (retryableInitialTitleFailures.get(key) ?? 0) + 1;
              if (failures < MAX_RETRYABLE_INITIAL_TITLE_FAILURES) {
                retryableInitialTitleFailures.set(key, failures);
                observabilityService.finalizeObservedTask(
                  taskKey,
                  'failure',
                  result.fallback.reason,
                  result.usage,
                );
                return;
              }
            }
            let settled = false;
            let committed = false;
            try {
              const applied = await service.commitInitialChatTitle(
                scope,
                options.chatId,
                result.text,
              );
              settled = true;
              settleInitialTitleAttempts(key);
              committed = applied;
              if (!applied) {
                observabilityService.finalizeObservedTask(
                  taskKey,
                  result.fallback ? 'failure' : 'cancelled',
                  result.fallback?.reason ??
                    'Initial chat title no longer eligible.',
                  result.usage,
                );
                return;
              }
              // Canonical state is already durable. Projection errors must never
              // reopen naming or hide the committed title; the observed
              // failure reports the inconsistency after the broadcasts.
              let projectionError: Error | undefined;
              try {
                await options.persistDescription?.(result.text);
              } catch (error) {
                projectionError =
                  error instanceof Error ? error : new Error(String(error));
              }
              const payload = {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
                description: result.text,
              };
              sendToWindow(
                options.getWindow(),
                IPC_CHANNELS.chatTabDescriptionUpdated,
                payload,
              );
              for (const additionalWindow of options.getAdditionalWindows?.() ??
                []) {
                sendToWindow(
                  additionalWindow,
                  IPC_CHANNELS.chatTabDescriptionUpdated,
                  payload,
                );
              }
              if (options.standaloneChatProjectId) {
                // Entry-list metadata derives from canonical tabs; this event
                // nudges the cowork list to refresh after commitment.
                sendToWindow(
                  options.getWindow(),
                  IPC_CHANNELS.standaloneChatMetaUpdated,
                  {
                    projectId: options.standaloneChatProjectId,
                    chatId: options.chatId,
                    description: result.text,
                  },
                );
              }
              if (projectionError !== undefined) throw projectionError;
              observabilityService.finalizeObservedTask(
                taskKey,
                result.fallback ? 'failure' : 'success',
                result.fallback?.reason,
                result.usage,
              );
            } catch (error) {
              if (!settled) {
                failedInitialTitleCommits.set(
                  key,
                  (failedInitialTitleCommits.get(key) ?? 0) + 1,
                );
              }
              observabilityService.finalizeObservedTask(
                taskKey,
                'failure',
                error instanceof Error ? error.message : String(error),
                result.usage,
              );
              // eslint-disable-next-line no-console
              console.warn(
                committed
                  ? '[chat-summary] Initial title committed but projection failed'
                  : '[chat-summary] Initial title failed to commit',
                error,
              );
            }
          })
          .catch((error: unknown) => {
            observabilityService.finalizeObservedTask(
              taskKey,
              'failure',
              error instanceof Error ? error.message : String(error),
            );
          });
      },
    });
  })()
    .catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[chat-summary] Initial naming failed', error);
    })
    .finally(() => {
      initialTitleRequests.delete(key);
    });
}

export interface ScheduleBranchNamingOptions {
  projectId: string;
  worktreeId: string;
  chatId?: string;
  text: string;
  cwd: string;
  /** Owner captured by the originating chat session before this task queues. */
  workOwner?: Promise<WorkOwner | undefined>;
  /** Window told about the recorded rename. */
  getWindow?: () => BrowserWindow | null;
}

export function scheduleBranchNaming(
  options: ScheduleBranchNamingOptions,
): void {
  const taskKeyScope = options.chatId ?? 'task-ready';
  const branchTaskKey = `helper:branch-naming:${options.projectId}/${options.worktreeId}/${taskKeyScope}:${Date.now()}`;
  const observabilityServicePromise = loadObservabilityService();
  void enqueueBackgroundHelperTask({
    priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
    task: async (): Promise<void> => {
      const prefs = await readPreferencesFile();
      const branchNamingModel = prefs.branchNamingModel;
      const branchNamingModelConfig = resolveCodexPreferenceModelConfig(
        branchNamingModel,
        prefs.branchNamingThinkingLevel,
        prefs.providerModelConfigDefaults,
      );
      const observabilityService = await observabilityServicePromise;
      const hasBoundWorkOwner = Object.prototype.hasOwnProperty.call(
        options,
        'workOwner',
      );
      const workOwner = hasBoundWorkOwner
        ? ((await options.workOwner) ?? null)
        : undefined;
      observabilityService.startObservedTask(branchTaskKey, {
        id: branchTaskKey,
        eventType: 'branch_naming',
        status: 'running',
        provider: requireProviderForModel(branchNamingModel),
        label: 'Branch Naming',
        startedAt: new Date().toISOString(),
        model: branchNamingModel,
        serviceTier: branchNamingModelConfig
          ? codexServiceTierForModelConfig(branchNamingModelConfig)
          : undefined,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        messageCount: 0,
        assistantMessageCount: 0,
        toolUseCount: 0,
        subAgentCount: 0,
        hasTranscript: false,
        toolCounts: {
          thinking: 0,
          bash: 0,
          read: 0,
          readLines: 0,
          writeEdit: 0,
          plan: 0,
          fileEdit: 0,
          fileAdd: 0,
          fileDelete: 0,
          search: 0,
          grep: 0,
          web: 0,
          agent: 0,
          workflow: 0,
          tasks: 0,
          taskStop: 0,
          skills: 0,
          monitor: 0,
          claude: 0,
          scheduleWakeup: 0,
          askUser: 0,
          scriptOutput: 0,
          watcher: 0,
          canopy: 0,
          graph: 0,
          appAdvisor: 0,
          pipelineEditor: 0,
          mcp: 0,
          other: 0,
        },
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: options.projectId,
          worktreeId: options.worktreeId,
        },
      });

      const branchResult = await doesBranchMatchWorktreeId(
        options.projectId,
        options.worktreeId,
        options.cwd,
      );
      if (!branchResult.matches) {
        observabilityService.finalizeObservedTask(branchTaskKey, 'success');
        return;
      }

      const alreadySent = await isBranchPromptSent(
        options.projectId,
        options.worktreeId,
      );
      if (!alreadySent) {
        await recordWorktreeDiscovery({
          kind: 'branch-prompt',
          workspaceId: options.projectId,
          worktreeId: options.worktreeId,
          sent: true,
        });
      }

      const branchUsage = await generateAndRenameBranch({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        cwd: options.cwd,
        userMessage: options.text,
        branchResult,
        observabilityTaskKey: branchTaskKey,
        modelConfig: branchNamingModelConfig,
        // ONE resolution, shared with the audit entry stamped above. Letting
        // the helper resolve its own could name a different model than the one
        // recorded, across a settling probe or credits read.
        resolvedModel: branchNamingModel,
        ...(hasBoundWorkOwner ? { workOwner } : {}),
        ...(options.getWindow ? { getWindow: options.getWindow } : {}),
      });
      observabilityService.finalizeObservedTask(
        branchTaskKey,
        'success',
        undefined,
        branchUsage,
      );
    },
  }).catch((error: unknown) => {
    void observabilityServicePromise.then((observabilityService) => {
      observabilityService.finalizeObservedTask(
        branchTaskKey,
        'failure',
        error instanceof Error ? error.message : String(error),
        readHelperUsage(error),
      );
    });
    void recordWorktreeDiscovery({
      kind: 'branch-prompt',
      workspaceId: options.projectId,
      worktreeId: options.worktreeId,
      sent: false,
    });
  });
}

export interface DispatchWorktreeChatTurnOptions {
  /** Trusted quota continuation: refuse any other billing connection. */
  requiredAccountProxyConnectionId?: string;
  countsTowardSkillUsage?: boolean;
  managedDelegationDeliveryId?: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  text: string;
  planMode: boolean;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  modelConfig?: AgentModelConfig;
  thinkingLevel?: ThinkingLevel;
  model?: ChatModel;
  providerType?: AgentProviderType;
  executionHarness?: ChatSendMessageRequest['executionHarness'];
  modelRouting?: ChatSendMessageRequest['modelRouting'];
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  deferredToolsAllowed?: boolean;
  sdkSessionId?: string;
  globalInstructionsSnapshot?: string;
  /** Retained native response items used to materialize an imported Codex thread. */
  codexReconstructionSeedId?: string;
  /** Fork the resumed Claude session instead of continuing it in place. */
  claudeForkSession?: boolean;
  /** Chain uuid the forked resume stops at (SDK `resumeSessionAt`). */
  claudeForkResumeAt?: string;
  /** Start fresh and persist the fork's lost-context disclosure on init. */
  claudeForkStartsFresh?: boolean;
  /** Answers for the calls a point-in-time fork anchor left open. */
  claudeForkToolResults?: ChatSendMessageRequest['claudeForkToolResults'];
  codexProposalMode?: 'optional' | 'required';
  /** @deprecated Use modelConfig.fastMode. */
  codexFastModeEnabled?: boolean;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatSendMessageRequest['attachmentPromptContexts'];
  inputMode?: 'typed' | 'voice';
  agentSent?: ChatSendMessageRequest['agentSent'];
  hiddenContext?: ChatSendMessageRequest['hiddenContext'];
  pendingSystemInstructions?: ChatSendMessageRequest['pendingSystemInstructions'];
  /**
   * The tracked plan the user had active when sending, validated by the
   * caller. Resolved into a one-turn plan-file instruction; never stored on
   * the tab and never used by hidden continuations.
   */
  activePlan?: ChatSendMessageRequest['activePlan'];
  /**
   * For multi-repo workspaces: the repo whose worktree checkout the agent
   * should run in. Resolves to a child repo path or the workspace root.
   */
  selectedRepoId?: string;
  initiationSource?: UsageInitiationSource;
  /**
   * Trusted background-run binding or the tab's persisted context, never a
   * renderer request. Org memory uses it for linked Personal projects;
   * absent means the live sidebar context, read once.
   */
  executionContext?: string;
  startsNewTrackedChat?: boolean;
  /**
   * Per-session AI Credits fallback routing decision (CAN-838). Threaded from
   * `ChatSendMessageRequest` into `AgentSessionOptions` so the provider session
   * injects gateway proxy env at spawn. Absent when the tab is not routing.
   */
  aiCreditsRouting?: AiCreditsRoutingState;
  /**
   * Per-chat billing-framework override forcing native subscription billing
   * for this turn, threaded from `ChatSendMessageRequest` into
   * `AgentSessionOptions`. Absent when the tab has no explicit override.
   */
  subscriptionBillingOverride?: boolean;
  getWindow: () => BrowserWindow | null;
  onChatEvent?: (event: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    data: unknown;
    /** Root-aware terminal classification for downstream lifecycle consumers. */
    isTerminalEvent: boolean;
  }) => void;
  /**
   * Persist a provider event before it becomes observable outside main.
   * Resolve false only for a duplicate or stale event that must stay hidden.
   */
  onBeforeChatEvent: (event: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    data: unknown;
    /** Distinguishes a resumed provider stream whose sequence restarts at 0. */
    sequenceNamespace: string;
    sequence: number;
    /** Undefined only for an untagged provider event that revives a settled turn. */
    turnUserMessageId?: string;
    /**
     * The provider whose session produced the event. Persistence prefers it
     * over the requested provider, so provider-scoped admission (such as
     * trusted visual promotion) sees the provider that actually ran.
     */
    providerType?: AgentProviderType;
    /**
     * Present while chat storage group-commits, for a streamed event whose
     * commit may overlap the next one. Call it once the commit holds its
     * place in the scope's commit order (the repository's `onQueued`); the
     * next event's commit then starts without waiting for this one to be
     * durable. A hook that never calls it keeps one commit at a time.
     */
    onCommitQueued?: () => void;
  }) => Promise<boolean | void>;
  /** Runs synchronously after the provider session accepts the user message. */
  onTurnAccepted?: () => void;
  /** Trusted host cancellation checked immediately before provider acceptance. */
  admissionSignal?: AbortSignal;
  skipBranchNaming?: boolean;
  hiddenDeferredContinuation?: boolean;
  /** Distinguishes hidden same-turn prompts for observability. */
  hiddenContinuationKind?: 'deferred_tools_reload' | 'stopped_turn_resume';
  deferredToolsReloadEnabledResources?: DeferredResourceSummary[];
  /** Internal durable-event namespace for a resumed provider stream. */
  providerEventSequenceNamespace?: string;
}

async function buildWorktreeSystemPromptAppend(options: {
  projectId: string;
  worktreeId: string;
  selectedRepoId?: string;
  providerPromptKind: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode';
  planMode: boolean;
  codeGraphToolsAdvertised: boolean;
  localMemoryEnabled: boolean;
  includeChatVisuals: boolean;
}): Promise<string> {
  // Compute the code-graph feature gate ONCE per turn and thread the boolean
  // into the prompt builders (avoids repeated flag-service reads on a hot
  // path). When off, no code-graph tool bullets and no availability nudge —
  // otherwise the prompt would reference tools the agent cannot call.
  const codeGraphEnabled =
    options.providerPromptKind !== 'cursor' &&
    options.providerPromptKind !== 'copilot' &&
    options.providerPromptKind !== 'opencode' &&
    options.codeGraphToolsAdvertised &&
    isCodeGraphAvailableForWorkspace(options.projectId);
  // The Cursor session appends its own injected-tool and local-memory
  // steering once it knows the app's MCP servers reached the CLI; emitting it
  // here would advertise tools that may not exist for that turn.
  const isCursor =
    options.providerPromptKind === 'cursor' ||
    options.providerPromptKind === 'copilot' ||
    options.providerPromptKind === 'opencode';
  const promptParts = isCursor
    ? []
    : [
        buildWorktreeInjectedToolPrompt(
          options.providerPromptKind,
          codeGraphEnabled,
          true,
          options.includeChatVisuals,
        ),
      ];
  const codeGraphAvailabilityPrompt = codeGraphEnabled
    ? buildCodeGraphAvailabilityPrompt(options.projectId, options.worktreeId, {
        liveAvailable: codeGraphEnabled,
        toolsAdvertised: options.codeGraphToolsAdvertised,
      })
    : undefined;
  if (codeGraphAvailabilityPrompt) {
    promptParts.push(codeGraphAvailabilityPrompt);
  }
  if (options.planMode) {
    const workspacePlanScopePrompt = await buildPlanModeWorkspaceScopePrompt(
      options.projectId,
      options.selectedRepoId,
    );
    if (workspacePlanScopePrompt) {
      promptParts.push(workspacePlanScopePrompt);
    }
  }
  const memoryPolicy = await resolveLocalMemoryPolicy(options);
  const localMemoryPrompt = buildLocalMemoryPromptNudge(
    !isCursor && options.localMemoryEnabled,
    memoryPolicy.kind === 'scoped' && memoryPolicy.privateMemory,
  );
  if (localMemoryPrompt) {
    promptParts.push(localMemoryPrompt);
  }
  return promptParts.join('\n\n');
}

async function resolveUsageChatScope(options: {
  projectId: string;
  isCoworkChat: boolean;
  selectedRepoId?: string;
}): Promise<{ repoId?: string; repoLabel?: string }> {
  if (options.isCoworkChat) {
    return {};
  }
  const config = await readWorkspaceConfig(options.projectId).catch(() => null);
  if (!config) {
    return {};
  }
  if (config.type === 'single-repo') {
    return {
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoLabel: config.repoPath ? basename(config.repoPath) : 'Repository',
    };
  }
  const selectedRepoId = options.selectedRepoId ?? WORKSPACE_ROOT_REPO_ID;
  if (selectedRepoId === WORKSPACE_ROOT_REPO_ID) {
    return config.sourceRepoPath
      ? {
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoLabel: WORKSPACE_ROOT_REPO_NAME,
        }
      : {};
  }
  const repo = config.repos.find((entry) => entry.id === selectedRepoId);
  return repo ? { repoId: repo.id, repoLabel: repo.name } : {};
}

interface PreparedOrgMemory {
  attempt: OrgMemoryFetchAttempt;
}

export async function prepareLocalMemory(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
}): Promise<{ renderedBlock: string } | null> {
  return prepareLocalMemoryContext(options);
}

/**
 * Whether a person started the turn: a desktop or Portal send. Hooks,
 * automations, App Advisor dispatches, and unknown sources are background
 * turns. Matches dispatch's own default of `user` for an unset source, so a
 * background dispatcher must set its source explicitly. Hook and automation
 * turns already skip memory in shouldFetchMemory.
 *
 * A Portal send drives this desktop, so a tab with no captured context runs
 * in the desktop's selected context, as the rest of that turn does. The
 * linked-org match still applies, so it can never reach an unlinked org.
 */
function isUserInitiatedTurn(
  initiationSource: UsageInitiationSource | undefined,
): boolean {
  const source = initiationSource ?? 'user';
  return source === 'user' || source === 'portal';
}

export async function prepareOrgMemory(options: {
  userText: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  selectedRepoId?: string;
  executionContext?: string;
  hiddenContextKind?: string;
  initiationSource?: UsageInitiationSource;
}): Promise<PreparedOrgMemory | null> {
  const preferences = await readPreferencesFile().catch(() => null);
  // Cheap pre-gate on preferences + input triviality avoids any I/O (credential
  // or workspace-config reads) for disabled or trivial turns.
  if (
    !preferences ||
    !preferences.orgMemoryInjectionEnabled ||
    isTrivialMemoryInput(options.userText)
  ) {
    return null;
  }

  // Resolve the real capability signal first, so accounts without memorySearch
  // or with no eligible organization bail out before the owner lookup's config,
  // chat-tab and workspace-context reads.
  const credentials = await getCanopyCloudCredentials().catch(() => null);
  if (
    !credentials?.capabilities.includes(MEMORY_SEARCH_CAPABILITY) ||
    credentials.memorySearchOrganizationExternalIds.length === 0
  ) {
    return null;
  }

  if (
    !shouldFetchMemory({
      userText: options.userText,
      memoryInjectionEnabled: preferences.orgMemoryInjectionEnabled,
      capabilityPresent: true,
      ...(options.hiddenContextKind !== undefined
        ? { hiddenContextKind: options.hiddenContextKind }
        : {}),
      ...(options.initiationSource !== undefined
        ? { initiationSource: options.initiationSource }
        : {}),
    })
  ) {
    return null;
  }

  // Org memory follows the owner of the work (CAN-3457), so Personal and App
  // Advisor turns make no request at all. A Cowork workspace follows its saved
  // owner (CAN-3477). Never a default or fallback org.
  const owner = await resolveOrgMemoryOwner({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    ...(options.executionContext !== undefined
      ? { executionContext: options.executionContext }
      : {}),
    readPersistedExecutionContext: () =>
      readPersistedChatExecutionContext(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ),
    // Dispatch treats an unset source as a user turn.
    userInitiated: isUserInitiatedTurn(options.initiationSource),
  });
  if (owner === null) return null;

  // The owning org must be one the account may search. When it is not, search
  // nothing: never try another eligible org. The lapse check repeats the
  // request gate's, but here it skips the query-context reads below.
  const eligibleOrganization = normalizeOrganizationExternalId(
    owner.organizationId,
  );
  if (
    eligibleOrganization === null ||
    !credentials.memorySearchOrganizationExternalIds.includes(
      eligibleOrganization,
    ) ||
    (await isOrganizationTeamsLapsed(eligibleOrganization))
  ) {
    return null;
  }
  // A Cowork entry id sits in the worktreeId slot, so the query-context read
  // works unchanged; Cowork has no repo label and no branch. Cowork-ness comes
  // from the same persisted read that chose the owner, not the sidebar
  // registry, which may not have observed a new workspace yet.
  const isCoworkChat = owner.isCowork;
  const [usageScope, queryContext, persistedBranch] = await Promise.all([
    resolveUsageChatScope({
      projectId: options.projectId,
      isCoworkChat,
      selectedRepoId: options.selectedRepoId,
    }).catch((): { repoId?: string; repoLabel?: string } => ({})),
    collectMemoryQueryContext({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      currentUserMessageId: options.userMessageId,
    }).catch(
      (): MemoryQueryContext => ({
        recentUserMessages: [],
        summaryDescription: null,
      }),
    ),
    isCoworkChat
      ? Promise.resolve(null)
      : readPersistedWorktreeBranch(
          options.projectId,
          options.worktreeId,
        ).catch(() => null),
  ]);

  const queryText = buildMemoryQuery(
    options.userText,
    getMemoryQueryBranchName(
      persistedBranch?.worktreeId ?? options.worktreeId,
      persistedBranch?.branchName ?? null,
    ),
    usageScope.repoLabel,
    queryContext,
  );
  // The raw human-typed message rides alongside the enriched query so the
  // server's lexical lanes can score against a short string instead of the
  // multi-line enriched text.
  const lexicalQuery = options.userText.trim().slice(0, MEMORY_QUERY_MAX_CHARS);
  return {
    attempt: await fetchOrgMemoryAttempt(
      eligibleOrganization,
      queryText,
      false,
      lexicalQuery,
    ),
  };
}

export async function dispatchWorktreeChatTurn(
  options: DispatchWorktreeChatTurnOptions,
): Promise<void> {
  if (!options.onBeforeChatEvent) {
    throw new Error(
      'A durable chat-event commit hook is required before dispatching a worktree chat turn.',
    );
  }
  // A legacy plan chat keeps its transcript but never starts a turn; refuse
  // it here, the funnel every dispatch path (including deferred-tools
  // continuations and direct callers) shares, before any turn state exists.
  assertChatScopeAcceptsTurns(options.projectId);
  const watcherAcceptedAt = new Date().toISOString();
  const watcherContext = captureCanonicalChatProducerContext(options);
  const presentationOrigin = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatTabId: options.chatId,
  };
  const handoffsAtSend = browserHandoffs.captureOrigin(presentationOrigin);
  const workOwnerSession = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    ...(options.executionContext === undefined
      ? {}
      : { executionContext: options.executionContext }),
  };
  // Begin the session binding before turn preparation can yield. Provider
  // creation repeats this idempotently; queued descendants share this promise.
  captureSessionWorkOwner(workOwnerSession);
  const workOwner = resolveSessionWorkOwner(workOwnerSession);
  // Every dispatch path (IPC send, queue drain, watcher, portal) funnels here,
  // so a newer turn retires a stopped turn's Resume offer (CAN-3137). A hidden
  // continuation of the stopped turn keeps its own user-message anchor.
  const stoppedTurnResumeService = getStoppedTurnResumeService();
  stoppedTurnResumeService.invalidateForNewTurn(options, options.userMessageId);
  if (!options.hiddenDeferredContinuation) {
    // Capability-package overlays are trusted, main-owned turn context but are
    // intentionally not persisted on the chat tab. Recreating a stopped
    // provider session without one would not continue the same turn, so that
    // exact root is ineligible for Resume.
    stoppedTurnResumeService.recordTurnContext(
      options,
      options.userMessageId,
      options.packageOverlay !== undefined,
    );
  }
  const dispatchStartedAt = Date.now();
  const memoryPromise: Promise<PreparedOrgMemory | null> =
    options.hiddenDeferredContinuation
      ? Promise.resolve(null)
      : prepareOrgMemory({
          userText: options.text,
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          userMessageId: options.userMessageId,
          selectedRepoId: options.selectedRepoId,
          ...(options.executionContext !== undefined
            ? { executionContext: options.executionContext }
            : {}),
          ...(options.hiddenContext?.kind !== undefined
            ? { hiddenContextKind: options.hiddenContext.kind }
            : {}),
          ...(options.initiationSource !== undefined
            ? { initiationSource: options.initiationSource }
            : {}),
        });
  // Created where the fetch starts so no dispatch exit — success, thrown
  // error, or early return — can leave a gate-passed search unattributed:
  // the finally below settles the tracker on every path.
  const memoryDeliveryTracker = createOrgMemoryDeliveryTracker({
    resultPromise: memoryPromise.then(
      (prepared): OrgMemoryFetchResult | null =>
        prepared?.attempt.result ?? null,
    ),
    dispatchStartedAt,
    clientChatId: clampId(options.chatId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
  });
  let resourceGuard: ResourceGuardReservation | undefined;
  let releaseSessionTurnPreparation: (() => void) | undefined;
  const preparation = beginChatTurnPreparation(options);
  // Resolve the active plan captured with this message beside memory
  // preparation; it is prepended only when the turn is composed. A hidden
  // continuation belongs to a turn that already carried it. Resolution never
  // blocks the send.
  const activePlanInstructionPromise: Promise<PendingSystemInstruction | null> =
    options.hiddenDeferredContinuation
      ? Promise.resolve(null)
      : resolveActivePlanSystemInstruction({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          activePlan: options.activePlan,
        }).catch((): null => null);

  try {
    resourceGuard = await getResourceMonitorService().reserveChatTurnStart();
    const observabilityServicePromise = loadObservabilityService();
    const isCoworkChat = isCoworkWorkspace(options.projectId);
    const isLegacyStandalone = options.projectId === STANDALONE_CHAT_PROJECT_ID;
    const standaloneProjectId = isLegacyStandalone
      ? options.worktreeId
      : isCoworkChat
        ? options.projectId
        : undefined;
    const isPlanExplore = options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID;
    const isCodeReview = options.projectId === CODE_REVIEW_CHAT_PROJECT_ID;
    // Plan-file turn ownership (D-B): a running turn exposes every plan file
    // in its real worktree, so the sync service defers applying agent edits
    // there until the lease ends. The plan-explore sentinel resolves to its
    // registered worktree; Cowork, Code Review, and scopes without tracked
    // plans take no lease. The lease is keyed by this chat, so a later
    // dispatch of the same chat (reload continuation, resume) supersedes an
    // un-ended one.
    const planTurnScope =
      isCoworkChat || isCodeReview
        ? null
        : resolvePlanTurnScope(options.projectId, options.worktreeId);
    let executionUserMessageId = options.userMessageId;
    let planTurnLease: PlanTurnLease | null = null;
    const openPlanTurn = (): void => {
      const captured = capturePresentationTurn(presentationOrigin);
      recordPresentationTurn(
        presentationChatKey(presentationOrigin),
        executionUserMessageId,
        captured !== undefined && captured.turnId === executionUserMessageId
          ? captured.source
          : executionUserMessageId === options.userMessageId
            ? (options.initiationSource ?? 'user')
            : undefined,
      );
      if (planTurnScope === null || planTurnLease !== null) return;
      planTurnLease = getPlanFileSyncService().beginTurn(
        planChatTurnKey(options.projectId, options.worktreeId, options.chatId),
        planTurnScope,
      );
    };
    const closePlanTurn = (): void => {
      clearPresentationTurn(
        presentationChatKey(presentationOrigin),
        executionUserMessageId,
      );
      const lease = planTurnLease;
      planTurnLease = null;
      lease?.end();
    };
    const cwd = resolveWorktreeCwd(
      options.projectId,
      options.worktreeId,
      options.selectedRepoId,
    );
    const sessionKey = buildSessionKey(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
    const attachmentBaseDir = isCoworkChat
      ? getCoworkManagedSubdir(cwd, 'attachments')
      : getWorktreeAttachmentsDir(options.projectId, options.worktreeId);
    // Built early so attachment validation fails before any session work.
    // Pending system instructions are prepended at compose time, once the
    // active-plan instruction has resolved.
    const visibleSubmittedText = options.hiddenDeferredContinuation
      ? options.text
      : buildSubmittedMessageText({
          text: options.text,
          fileReferences: options.fileReferences,
          attachmentPaths: options.attachmentPaths,
          attachmentPromptContexts: options.attachmentPromptContexts,
          // `cwd` already resolves to the cowork home dir for both the legacy
          // sentinel keying and real cowork workspace ids (see
          // `resolveWorktreeCwd`), so it is the correct attachment base for
          // either keying.
          attachmentBaseDir,
          cwd,
          inputMode: options.inputMode,
          agentSent: options.agentSent,
        });
    const existingCodeGraphToolsAdvertised = getSessionCodeGraphToolsAdvertised(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
    const currentCodeGraphToolsAvailable =
      !isCoworkChat &&
      !isPlanExplore &&
      !isCodeReview &&
      isCodeGraphAvailableForWorkspace(options.projectId);
    const persistedDispatchMetadata = await readPersistedChatDispatchMetadata(
      options.projectId,
      options.worktreeId,
      options.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    );
    const preferences = await readPreferencesFile().catch(() => null);
    const laneDefault =
      options.model === undefined && preferences
        ? await requireLaneAwareDefaultSelection(
            preferences,
            isCoworkChat ? 'chat' : 'worktree',
            // Same workspace the session spawn resolves its environment for
            // (`claude-session.ts` / `codex-session.ts` pass `opts.projectId`),
            // so a Canopy Environments credential is judged against the SAME
            // effective environment the turn will actually run in.
            { workspaceId: options.projectId },
            options.providerType,
            // Forced to this turn's provider, so it answers "what should THIS
            // turn run?" rather than "what is the user's default model?" and
            // must not stamp the Portal catalog projection.
            false,
          )
        : undefined;
    const selectedModel = options.model ?? laneDefault?.model;
    // See `resolveLaneSubstitutedProviderType`: lane resolution can hand back a
    // native model from a DIFFERENT lane than the forced `providerType`, and
    // pinning that provider over it trips the harness guard below.
    const laneSubstitutedProviderType = resolveLaneSubstitutedProviderType({
      explicitModel: options.model,
      requestedProviderType: options.providerType,
      selectedModel,
    });
    // An explicitly supplied `providerType` is otherwise AUTHORITATIVE on both
    // branches. It carries the chat's persisted provider lock for a resumed
    // session, and deriving the provider from the lane-resolved model instead
    // let a caller that asked for `'codex'` silently land on `'claude'` when
    // the Codex lane was not the one that resolved.
    const effectiveProviderType =
      laneSubstitutedProviderType ??
      options.providerType ??
      (options.model !== undefined
        ? requireProviderForModel(options.model)
        : selectedModel
          ? requireProviderForModel(selectedModel)
          : 'claude');
    const deferredToolsAllowed =
      options.deferredToolsAllowed ??
      persistedDispatchMetadata.deferredToolsAllowed ??
      true;
    const effectiveExecutionHarness =
      // A cross-lane substitution invalidates the persisted harness lock: the
      // model that will actually run is the substituted one, so the harness
      // must follow it rather than the lane the chat used to be on.
      (laneSubstitutedProviderType && selectedModel
        ? getExecutionHarnessForModel(selectedModel)
        : undefined) ??
      persistedDispatchMetadata.executionHarness ??
      (persistedDispatchMetadata.model
        ? getExecutionHarnessForModel(persistedDispatchMetadata.model)
        : undefined) ??
      (selectedModel
        ? getExecutionHarnessForModel(selectedModel)
        : undefined) ??
      (effectiveProviderType === 'codex' ? 'codex' : 'claude');
    if (
      options.executionHarness !== undefined &&
      options.executionHarness !== effectiveExecutionHarness &&
      // A cross-lane substitution invalidates the CALLER's harness too, not
      // just the persisted one. The renderer forwards the tab's persisted
      // harness verbatim (`stores/chat/slices/messaging.ts`,
      // `executionHarness: currentTab?.executionHarness`), and that field is
      // only persisted once a tab has real conversation content
      // (`chatTabHasConversationContent`, `persisted-tabs.ts`) — which is what
      // keeps this substitution path narrow. So a Codex-locked chat whose Codex
      // lane is down arrives here with `executionHarness: 'codex'` while
      // routing has already moved it to Claude, and throwing there is exactly
      // the dead end the substitution exists to remove, relocated one line down.
      laneSubstitutedProviderType === undefined
    ) {
      throw new Error(
        'Chat execution harness does not match host-owned routing',
      );
    }
    if (effectiveExecutionHarness === 'opencode')
      await assertOpenCodeModelAvailable(
        selectedModel ?? persistedDispatchMetadata.model,
      );
    if (effectiveExecutionHarness === 'copilot')
      await assertCopilotModelAvailable(
        selectedModel ?? persistedDispatchMetadata.model,
      );
    // `standaloneProjectId` already carries the real cowork workspace id for
    // both cowork keyings; sentinel-keyed plan-explore / code-review sessions
    // resolve to their real workspace inside `prepareLocalMemoryContext`.
    // Cursor gets this context too, even on a turn whose CLI ends up without
    // the app's MCP servers (and so without the memory tools): the context is
    // reference material the agent can read, and the session adds the memory
    // nudge only when the tools actually reached the CLI.
    const localMemory = options.hiddenDeferredContinuation
      ? null
      : await prepareLocalMemory({
          userText: options.text,
          projectId: standaloneProjectId ?? options.projectId,
          worktreeId: options.worktreeId,
        });
    const normalizedModelConfig = normalizeAgentModelConfig(
      options.modelConfig,
    );
    let repoRulesBlockPromise: Promise<string> | undefined;
    const resolveSessionConfiguration = async (
      advertised: boolean,
    ): Promise<{
      codeGraphToolsAdvertised: boolean;
      systemPromptAppend: string;
      sessionSystemPromptAppend: string;
      globalInstructionsBlock: string;
      runtime: Awaited<ReturnType<typeof resolveAgentModelRuntime>> | undefined;
      runtimeProviderType: AgentProviderType;
      runtimeModel: ChatModel | undefined;
      effectiveModelConfig: ReturnType<typeof resolveProviderModelConfig>;
      managedDelegationMode: PreferencesData['managedDelegationMode'];
      managedDelegationMaxConcurrent: PreferencesData['managedDelegationMaxConcurrent'];
      managedDelegationMaxDepth: PreferencesData['managedDelegationMaxDepth'];
      codexPreferences: PreferencesData | null;
      rtkEnabled: boolean;
    }> => {
      const providerPromptKind = effectiveExecutionHarness;
      const codeGraphToolsAdvertised =
        effectiveExecutionHarness !== 'cursor' && advertised;
      const coworkMemoryPolicy = isCoworkChat
        ? await resolveLocalMemoryPolicy(options)
        : null;
      const systemPromptAppend = isCoworkChat
        ? buildCoworkDispatchSystemPromptAppend(
            providerPromptKind,
            preferences?.localMemoryEnabled === true,
            coworkMemoryPolicy?.kind === 'scoped' &&
              coworkMemoryPolicy.privateMemory,
            chatVisualsPromptEligible(effectiveProviderType, 'cowork'),
          )
        : isCodeReview
          ? `${buildCodeReviewPrompt()}\n\n${buildWorktreeInjectedToolPrompt(
              providerPromptKind,
              false,
              true,
              chatVisualsPromptEligible(effectiveProviderType, 'worktree'),
            )}`
          : await buildWorktreeSystemPromptAppend({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              selectedRepoId: options.selectedRepoId,
              providerPromptKind,
              planMode: options.planMode,
              codeGraphToolsAdvertised,
              localMemoryEnabled: preferences?.localMemoryEnabled === true,
              includeChatVisuals: chatVisualsPromptEligible(
                effectiveProviderType,
                'worktree',
              ),
            });
      const runtime = selectedModel
        ? await resolveAgentModelRuntime({
            projectId: options.projectId,
            model: selectedModel,
            systemPromptAppend,
            pluginSelections: options.pluginSelections,
            providerType: effectiveProviderType,
          })
        : undefined;
      const runtimeProviderType =
        runtime?.providerType ?? effectiveProviderType;
      const runtimeModel = runtime?.runtimeModel ?? selectedModel;
      // Global Instructions (Instructions settings) resolve into a "User Overall
      // Preferences" block per session context. Composed here so it reaches
      // provider sessions only when a session is (re)created — live sessions
      // are unaffected until their next creation.
      const chatGlobalInstructions = preferences?.globalInstructions?.chats;
      const currentGlobalInstructionsBlock = chatGlobalInstructions
        ? buildUserOverallPreferencesBlock(chatGlobalInstructions, {
            harness: runtimeProviderType,
            model: resolveModelAlias(runtimeModel ?? ''),
            workspaceType: isCoworkChat ? 'cowork' : 'code',
          })
        : '';
      const resumingProviderSession =
        options.sdkSessionId !== undefined &&
        laneSubstitutedProviderType === undefined;
      const globalInstructionsBlock = await selectSessionInstructions({
        provider: runtimeProviderType,
        isInteractiveCode:
          !isCoworkChat &&
          !isLegacyStandalone &&
          !isPlanExplore &&
          !isCodeReview &&
          options.projectId !== APP_ADVISOR_PROJECT_ID &&
          !options.hiddenDeferredContinuation &&
          (options.initiationSource === undefined ||
            options.initiationSource === 'user'),
        resumed: resumingProviderSession,
        saved: options.globalInstructionsSnapshot,
        active:
          laneSubstitutedProviderType === undefined
            ? getSessionGlobalInstructionsSnapshot(
                options.projectId,
                options.worktreeId,
                options.chatId,
              )
            : undefined,
        activeProvider: getSessionProviderType(
          options.projectId,
          options.worktreeId,
          options.chatId,
        ),
        currentGlobal: currentGlobalInstructionsBlock,
        compose: () => {
          repoRulesBlockPromise ??= composeWorktreeRepoRules(
            options.projectId,
            options.worktreeId,
            cwd,
          );
          return repoRulesBlockPromise;
        },
      });
      const composedSystemPromptAppend =
        appendUserOverallPreferencesBlock(
          runtime?.systemPromptAppend ?? systemPromptAppend,
          globalInstructionsBlock,
        ) ?? systemPromptAppend;
      const effectiveModelConfig = resolveProviderModelConfig(
        effectiveExecutionHarness,
        {
          thinkingLevel: options.thinkingLevel ?? laneDefault?.thinkingLevel,
          modelConfig: {
            ...(normalizedModelConfig ?? {}),
            ...(normalizedModelConfig?.fastMode === undefined &&
            typeof options.codexFastModeEnabled === 'boolean'
              ? { fastMode: options.codexFastModeEnabled }
              : {}),
          },
        },
        preferences?.providerModelConfigDefaults,
      );
      return {
        codeGraphToolsAdvertised,
        systemPromptAppend: composedSystemPromptAppend,
        sessionSystemPromptAppend:
          runtime?.systemPromptAppend ?? systemPromptAppend,
        globalInstructionsBlock,
        runtime,
        runtimeProviderType,
        runtimeModel,
        effectiveModelConfig,
        managedDelegationMode: preferences?.managedDelegationMode,
        managedDelegationMaxConcurrent:
          preferences?.managedDelegationMaxConcurrent,
        managedDelegationMaxDepth: preferences?.managedDelegationMaxDepth,
        codexPreferences:
          effectiveExecutionHarness === 'codex' ? preferences : null,
        // Claude and Cursor both rewrite shell commands through the bundled
        // RTK hook; Codex has no rewrite seam.
        rtkEnabled:
          effectiveExecutionHarness === 'claude' ||
          effectiveExecutionHarness === 'copilot' ||
          effectiveExecutionHarness === 'opencode' ||
          effectiveExecutionHarness === 'cursor'
            ? preferences?.rtkEnabled !== false
            : false,
      };
    };

    let sessionConfiguration = await resolveSessionConfiguration(
      existingCodeGraphToolsAdvertised ?? currentCodeGraphToolsAvailable,
    );

    const buildSessionOptions = (): Parameters<
      typeof getOrCreateRoutedSession
    >[0] => ({
      cwd,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      ...(options.executionContext === undefined
        ? {}
        : { executionContext: options.executionContext }),
      planMode: options.planMode,
      approvalMode:
        persistedDispatchMetadata?.approvalMode ?? options.approvalMode,
      sessionApprovalRules: options.sessionApprovalRules,
      codexProposalMode: options.codexProposalMode,
      thinkingLevel: sessionConfiguration.effectiveModelConfig.thinkingLevel,
      modelConfig: sessionConfiguration.effectiveModelConfig,
      requiredAccountProxyConnectionId:
        options.requiredAccountProxyConnectionId,
      model: sessionConfiguration.runtimeModel,
      selectedModel,
      // A cross-lane substitution changes WHICH PROVIDER runs, and a provider's
      // session id is meaningless to the other one. `getOrCreateSession` has no
      // provider-change guard, so forwarding it verbatim handed a persisted
      // Codex thread id straight to a Claude session. Dropping it starts a
      // fresh session on the substituted provider instead.
      // `codexReconstructionSeedId` is likewise a Codex-only resume identifier.
      //
      // KNOWN LIMITATION (CAN-1929): the new provider session starts with NO
      // replay of the persisted conversation — `AgentSessionOptions` carries no
      // cross-provider reconstruction path — so on the one reachable
      // established-chat case the UI keeps showing history the agent cannot see.
      // That case is narrow: substitution requires `explicitModel === undefined`
      // (see `resolveLaneSubstitutedProviderType`), and a tab only becomes
      // model-less-with-a-session-id when its persisted model stops resolving
      // against the registry (`resolveKnownModel` → `undefined` during
      // hydration), e.g. a model retired between releases.
      //
      // Deliberately NOT resolved by refusing substitution for established
      // conversations: that reinstates the hard dead end this exists to remove,
      // and round-3 coverage
      // ("reconciles a substitution against the CALLER persisted harness")
      // pins the drop-the-session-id behavior. Proper cross-provider
      // reconstruction (replay + an atomic tab metadata swap) is the real fix
      // and is larger than this change.
      ...(laneSubstitutedProviderType
        ? {}
        : {
            sdkSessionId: options.sdkSessionId,
            codexReconstructionSeedId: options.codexReconstructionSeedId,
          }),
      ...(options.claudeForkSession ? { claudeForkSession: true } : {}),
      ...(options.claudeForkSession && options.claudeForkResumeAt
        ? { claudeForkResumeAt: options.claudeForkResumeAt }
        : {}),
      ...(options.claudeForkSession &&
      options.claudeForkResumeAt &&
      options.claudeForkToolResults?.length
        ? { claudeForkToolResults: options.claudeForkToolResults }
        : {}),
      ...(options.claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
      pluginSelections:
        sessionConfiguration.runtime?.pluginSelections ??
        options.pluginSelections,
      ...(options.packageOverlay
        ? { packageOverlay: options.packageOverlay }
        : {}),
      applyGlobalPluginDefaults: chatSurfaceUsesGlobalPluginDefaults(
        options.projectId,
      ),
      deferredToolsAllowed,
      // Already composed in resolveSessionConfiguration: runtime (Agent)
      // append plus the Global Instructions block.
      systemPromptAppend: sessionConfiguration.sessionSystemPromptAppend,
      globalInstructionsBlock: sessionConfiguration.globalInstructionsBlock,
      globalInstructionsSnapshot:
        options.sdkSessionId !== undefined &&
        laneSubstitutedProviderType === undefined
          ? sessionConfiguration.globalInstructionsBlock
          : undefined,
      managedDelegationSurface:
        !isCoworkChat && !isPlanExplore && !isCodeReview
          ? 'worktree-chat'
          : undefined,
      managedDelegationMaxConcurrent:
        sessionConfiguration.managedDelegationMaxConcurrent,
      managedDelegationMaxDepth: sessionConfiguration.managedDelegationMaxDepth,
      managedDelegationMode:
        !isCoworkChat && !isPlanExplore && !isCodeReview
          ? resolveManagedDelegationMode(
              sessionConfiguration.managedDelegationMode,
            )
          : undefined,
      providerType: sessionConfiguration.runtimeProviderType,
      executionHarness: effectiveExecutionHarness,
      codeGraphToolsAdvertised: sessionConfiguration.codeGraphToolsAdvertised,
      codexAppServerIdleTimeoutMinutes:
        sessionConfiguration.codexPreferences?.codexAppServerIdleTimeoutMinutes,
      codexMaxConcurrentSubagents:
        sessionConfiguration.codexPreferences?.codexMaxConcurrentSubagents,
      codexMultiAgentEnabled: isCoworkChat
        ? sessionConfiguration.codexPreferences
            ?.codexMultiAgentStandaloneChatsEnabled
        : sessionConfiguration.codexPreferences
            ?.codexMultiAgentWorktreeChatsEnabled,
      rtkEnabled: sessionConfiguration.rtkEnabled,
      ...(options.aiCreditsRouting
        ? { aiCreditsRouting: options.aiCreditsRouting }
        : {}),
      ...(options.subscriptionBillingOverride
        ? { subscriptionBillingOverride: true }
        : {}),
    });

    if (
      !options.hiddenDeferredContinuation &&
      !isCoworkChat &&
      !isPlanExplore &&
      !isCodeReview
    ) {
      if (!options.sdkSessionId && !options.skipBranchNaming) {
        scheduleBranchNaming({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          text: options.text,
          cwd,
          workOwner,
          getWindow: options.getWindow,
        });
      }

      scheduleChatSummary({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        cwd,
        getWindow: options.getWindow,
        workOwner,
      });
    }

    const recreateOnNextTurn = shouldRecreateSessionOnNextTurn(
      options.projectId,
      options.worktreeId,
      options.chatId,
    );
    if (existingCodeGraphToolsAdvertised !== undefined) {
      const requestedSessionOptions = buildSessionOptions();
      const canReuseRequestedSession =
        !recreateOnNextTurn && (await canReuseSession(requestedSessionOptions));
      if (
        !canReuseRequestedSession &&
        !(await canPreserveSessionCapabilitySnapshot(requestedSessionOptions))
      ) {
        sessionConfiguration = await resolveSessionConfiguration(
          currentCodeGraphToolsAvailable,
        );
      }
    }

    if (recreateOnNextTurn) {
      // A recycle: the chat's managed delegations keep running.
      await destroySession(
        options.projectId,
        options.worktreeId,
        options.chatId,
        { retainDelegations: true },
      );
    }

    const {
      runtime,
      runtimeProviderType,
      runtimeModel,
      effectiveModelConfig,
      codexPreferences,
      rtkEnabled,
      systemPromptAppend,
    } = sessionConfiguration;
    const observedSystemPromptAppend = systemPromptAppend;
    const resumesStoppedTurn =
      options.hiddenContinuationKind === 'stopped_turn_resume';
    // A stopped-turn resume starts a new dispatch closure for an already
    // settled canonical turn. Treat its first provider output as an explicit
    // same-turn revival so canonical state and the host queue both reopen the
    // original turn instead of dropping tagged Claude/Cursor events as late.
    let turnSettled = resumesStoppedTurn;
    let resumedTransportSettled = false;
    const resumeOwnsTerminalSettlement = (): boolean =>
      !resumesStoppedTurn &&
      getStoppedTurnResumeService().ownsTerminalSettlement(
        {
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
        },
        executionUserMessageId,
      );
    // A steering pickup the host queue accepted as a turn root before this
    // closure owned it. When canonical state does not apply that pickup, the
    // closure never owns the provider turn and drops its events, terminal
    // included, so the queue gate it took is released from here instead.
    let unownedTurnRootUserMessageId: string | undefined;
    const releaseUnownedTurnRoot = (status: ChatQueueTerminalStatus): void => {
      const turnUserMessageId = unownedTurnRootUserMessageId;
      if (turnUserMessageId === undefined) return;
      unownedTurnRootUserMessageId = undefined;
      void getChatQueueServiceForTurnLifecycle().then((queue) => {
        queue.onTurnTerminal(
          {
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            chatId: options.chatId,
          },
          status,
          turnUserMessageId,
        );
      });
    };
    let codexRootThreadId: string | undefined = options.sdkSessionId;
    let sessionEventCommitTail = Promise.resolve();
    // Deliveries of events whose commits overlapped (group commit only).
    const commitPipeline = new SessionEventCommitPipeline();
    let turnDiffCaptureTail = Promise.resolve();
    const evaluateSessionEvent = (
      data: unknown,
    ): {
      eventData: Record<string, unknown> | null;
      isTerminalEvent: boolean;
      activeTurnUserMessageId: string | undefined;
      eventTurnUserMessageId: string | null;
      revivesSettledTurn: boolean;
      ineligibleEvent: boolean;
    } => {
      codexRootThreadId = readCodexRootThreadId(data) ?? codexRootThreadId;
      const eventData = isRecord(data) ? data : null;
      const isTerminalEvent =
        eventData !== null &&
        isRootTerminalChatEventData(eventData, codexRootThreadId);
      const isInternalReloadTerminalEvent =
        isTerminalEvent &&
        deferredToolsReloadCoordinator.hasActiveReload({
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
        });
      const activeTurnUserMessageId = activeTurnUserMessageIds.get(sessionKey);
      const expectedTurnUserMessageId =
        activeTurnUserMessageId ?? executionUserMessageId;
      const eventTurnUserMessageId = eventData
        ? getEventTurnUserMessageId(eventData)
        : null;
      const ownedDelegation =
        eventData?.type === 'canopy_delegation' &&
        isAgentDelegationTranscript(eventData.delegation);
      const belongsToEarlierTurn =
        !ownedDelegation &&
        eventTurnUserMessageId !== null &&
        eventTurnUserMessageId !== expectedTurnUserMessageId;
      // A provider may flush the final assistant/tool event just after its
      // root terminal event. Offer only an explicitly tagged event for the
      // same turn to canonical state: ChatStateService accepts it when that
      // turn is in `empty_completion` recovery and rejects it for every other
      // settled runtime. This keeps the canonical verdict authoritative while
      // allowing genuinely late output to repair an empty turn.
      const canReconcileSettledTurn =
        turnSettled &&
        eventTurnUserMessageId === expectedTurnUserMessageId &&
        eventData?.canopy_turn_revival !== true &&
        isAgentContinuationEvent(data);
      const canFollowSettledTurn =
        ownedDelegation ||
        eventData?.type === 'canopy_input_delivery' ||
        eventData?.type === 'turn_diff' ||
        eventData?.type === 'claude_terminal_transcript_sync' ||
        eventData?.type === 'org_memory_used' ||
        eventData?.type === 'canopy_org_memory_used' ||
        isCodexAsyncQuestionEvent(eventData) ||
        isCodexSubagentFollowupEvent(eventData, codexRootThreadId) ||
        (eventData?.type === 'system' &&
          eventData.subtype === 'init' &&
          eventData.canopy_turn_revival === true) ||
        (eventData !== null && isSetAutoArchiveRequestedEventData(eventData)) ||
        canReconcileSettledTurn;
      // Codex clears its active message tag when a turn finishes. A late
      // background command result is therefore untagged, but is not a new
      // turn. Only a root turn start may revive without explicit retry
      // metadata; item events must not reopen the host queue's busy gate.
      const canReviveWithoutTurnTag =
        eventData?.type !== 'codex' ||
        (isRecord(eventData.event) &&
          eventData.event.type === 'turn.started' &&
          codexRootThreadId !== undefined &&
          eventData.event.thread_id === codexRootThreadId);
      const revivesSettledTurn =
        turnSettled &&
        !canFollowSettledTurn &&
        ((eventTurnUserMessageId === null && canReviveWithoutTurnTag) ||
          (eventTurnUserMessageId === expectedTurnUserMessageId &&
            eventData?.canopy_turn_revival === true)) &&
        (isAgentContinuationEvent(data) ||
          (resumesStoppedTurn &&
            eventData?.canopy_turn_revival === true &&
            isTerminalEvent));
      return {
        eventData,
        isTerminalEvent,
        activeTurnUserMessageId,
        eventTurnUserMessageId,
        revivesSettledTurn,
        ineligibleEvent:
          isInternalReloadTerminalEvent ||
          belongsToEarlierTurn ||
          (turnSettled && !canFollowSettledTurn && !revivesSettledTurn),
      };
    };
    const deliverSessionEvent = (
      data: unknown,
      evaluation: ReturnType<typeof evaluateSessionEvent>,
      occurredAt: string,
    ): void => {
      void observabilityServicePromise.then((observabilityService) => {
        observabilityService.observeChatEvent(
          options.projectId,
          options.worktreeId,
          options.chatId,
          data,
        );
      });
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        data,
        {
          providerType:
            runtimeProviderType ??
            (runtimeModel ? getProviderForModel(runtimeModel) : undefined),
          model: runtimeModel,
        },
      );
      const {
        eventData,
        isTerminalEvent,
        activeTurnUserMessageId,
        eventTurnUserMessageId,
      } = evaluation;
      options.onChatEvent?.({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        data,
        isTerminalEvent,
      });

      if (eventData && isTerminalEvent) {
        // Settle before scheduling terminal follow-up work so callbacks already
        // queued behind this event cannot append output to the completed turn.
        turnSettled = true;
        // The root turn ended (success, error, or cancellation): the sync
        // service may now apply plan-file edits it made.
        closePlanTurn();
        if (resumesStoppedTurn) {
          resumedTransportSettled = true;
          getStoppedTurnResumeService().settleTerminalOwnership(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            },
            executionUserMessageId,
          );
        }
        const status = getChatTurnAuditStatus(eventData);
        const error =
          eventData.type === 'error'
            ? typeof eventData.error === 'string'
              ? eventData.error
              : 'Unknown error'
            : eventData.is_error === true &&
                typeof eventData.result === 'string'
              ? eventData.result
              : undefined;
        void observabilityServicePromise.then((observabilityService) => {
          observabilityService.completeChatTurn(
            options.projectId,
            options.worktreeId,
            options.chatId,
            status,
            error,
          );
          void notifyCanonicalChatTerminal(
            options,
            eventTurnUserMessageId ?? executionUserMessageId,
            eventData,
            status,
            occurredAt,
            watcherContext,
            executionUserMessageId === options.userMessageId
              ? watcherAcceptedAt
              : undefined,
          ).catch(() => undefined);
        });
        const queueStatus =
          status === 'success'
            ? 'complete'
            : status === 'failure'
              ? 'error'
              : 'cancelled';
        void getChatQueueServiceForTurnLifecycle().then((queue) => {
          queue.onTurnTerminal(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            },
            queueStatus,
            eventTurnUserMessageId ?? activeTurnUserMessageId,
          );
        });
        if (isCoworkChat) {
          // Cowork workspaces get the same Summary card as Code worktrees;
          // the scheduler's cowork branch summarizes folder activity
          // instead of git diffs. Everything else worktree-flavored
          // (turn-diff capture, code-review activity) stays skipped.
          scheduleSummaryGeneration(
            options.projectId,
            options.worktreeId,
            options.getWindow,
          );
        } else {
          // The plan-explore and code-review scopes have no worktree summary
          // of their own (their summary/tracked-plan paths intentionally
          // throw), so skip summary generation while still capturing turn
          // diffs against the borrowed real worktree for "Reset to this
          // point". A plan-explore turn's plan-file lease already ended above.
          if (!isPlanExplore && !isCodeReview) {
            scheduleSummaryGeneration(
              options.projectId,
              options.worktreeId,
              options.getWindow,
            );
            noteWorktreeActivityForCodeReview(
              options.projectId,
              options.worktreeId,
              options.getWindow,
            );
          } else if (isCodeReview) {
            // Code-review turn completed: close the active-turn gate so any
            // review regeneration deferred while the sidecar chat was
            // editing files can now run. `options.worktreeId` is the
            // composite scope key for this sentinel scope; the hook resolves
            // the real ids via the code-review registry.
            noteCodeReviewTurnEnd(options.worktreeId, options.getWindow);
          }
          activeTurnUserMessageIds.delete(sessionKey);
          if (activeTurnUserMessageId) {
            turnDiffCaptureTail = captureTurnEndAndDiff(sessionKey)
              .then((turnDiff) => {
                // Emit the event regardless of whether files changed: the
                // captured `treeRefs` are needed for "Reset to this point" even
                // on read-only turns. The renderer hides the diff summary when
                // `files` is empty, so this doesn't add visual noise.
                if (!turnDiff) {
                  return;
                }
                if (turnDiff.files.length > 0) {
                  const target = resolveWorktreeTargetIds(
                    options.projectId,
                    options.worktreeId,
                  );
                  if (target) {
                    scheduleCodeGraphBuild({
                      ...target,
                      reason: 'refresh',
                      source: 'turn-diff',
                    });
                  }
                }

                // The capture barrier must not await this queued commit: a
                // late pickup can await capture from inside the same queue.
                // drainSessionEvents joins the derived commit separately.
                void handleSessionEvent({
                  type: 'turn_diff',
                  userMessageId: activeTurnUserMessageId,
                  ...turnDiff,
                });
              })
              .catch(() => undefined);
          }
        }
      }
    };
    let sessionEventSequence = 0;
    // The active session is authoritative after lane selection, as on the
    // Cowork path; persistence prefers it over the requested provider.
    const eventProviderType = (): AgentProviderType | undefined =>
      getSessionProviderType(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ) ?? runtimeProviderType;
    const sequenceNamespace =
      options.providerEventSequenceNamespace ?? 'initial';
    const handleSessionEvent = (
      data: unknown,
      markPersistenceSettled?: () => void,
    ): Promise<void> => {
      const attributedData =
        isRecord(data) &&
        (resumesStoppedTurn ||
          (data.type === 'canopy_user_prompt' &&
            options.initiationSource === 'hook'))
          ? {
              ...data,
              ...(resumesStoppedTurn ? { canopy_turn_revival: true } : {}),
              ...(data.type === 'canopy_user_prompt' &&
              options.initiationSource === 'hook'
                ? { canopy_user_message_source: 'hook' }
                : {}),
            }
          : data;
      const occurredAt = new Date().toISOString();
      const sequence = sessionEventSequence;
      sessionEventSequence += 1;
      const beforeChatEvent = options.onBeforeChatEvent;
      // Set when this event's commit overlaps later ones: its delivery then
      // completes after this link of the tail does.
      let overlappedCompletion: Promise<void> | undefined;
      sessionEventCommitTail = sessionEventCommitTail
        .then(async () => {
          // While chat storage group-commits, a streamed event of the active
          // turn may start its commit before the events ahead of it are
          // durable (`session-event-commit-pipeline.ts`). Any other event
          // runs alone, after every overlapped event has completed.
          const mayOverlap =
            !resumesStoppedTurn &&
            !turnSettled &&
            isOverlappableProviderEvent(attributedData);
          if (!mayOverlap && commitPipeline.pending)
            await commitPipeline.drained();
          // Once an explicit resume owns this same turn anchor, the stopped
          // transport is no longer an event source for the logical turn.
          if (resumeOwnsTerminalSettlement()) {
            markPersistenceSettled?.();
            return;
          }
          const evaluation = evaluateSessionEvent(attributedData);
          if (evaluation.ineligibleEvent) {
            if (
              evaluation.eventData &&
              evaluation.isTerminalEvent &&
              evaluation.eventTurnUserMessageId !== null &&
              evaluation.eventTurnUserMessageId === unownedTurnRootUserMessageId
            ) {
              const status = getChatTurnAuditStatus(evaluation.eventData);
              releaseUnownedTurnRoot(
                status === 'success'
                  ? 'complete'
                  : status === 'failure'
                    ? 'error'
                    : 'cancelled',
              );
            }
            markPersistenceSettled?.();
            return;
          }
          const overlaps =
            mayOverlap &&
            !evaluation.isTerminalEvent &&
            !evaluation.revivesSettledTurn;
          if (!overlaps && commitPipeline.pending)
            await commitPipeline.drained();
          let queueRearmed = false;
          if (evaluation.revivesSettledTurn && !isCoworkChat) {
            const queue = await getChatQueueServiceForTurnLifecycle();
            queueRearmed = queue.onTurnRevived(
              {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                chatId: options.chatId,
              },
              executionUserMessageId,
            );
            if (!queueRearmed) {
              markPersistenceSettled?.();
              return;
            }
            activeTurnUserMessageIds.set(sessionKey, executionUserMessageId);
            turnSettled = false;
            // The revived turn can edit plan files again.
            openPlanTurn();
          } else if (evaluation.revivesSettledTurn) {
            turnSettled = false;
          }
          const rollbackRevival = (): void => {
            if (!evaluation.revivesSettledTurn) return;
            turnSettled = true;
            closePlanTurn();
            if (!queueRearmed) return;
            activeTurnUserMessageIds.delete(sessionKey);
            void getChatQueueServiceForTurnLifecycle().then((queue) => {
              queue.onTurnTerminal(
                {
                  projectId: options.projectId,
                  worktreeId: options.worktreeId,
                  chatId: options.chatId,
                },
                'complete',
                executionUserMessageId,
              );
            });
          };
          const emitPairedAuthFailures = (): void => {
            // Guard against recursion: a `canopy_auth_failure` event we just
            // emitted below would never itself look like an errored tool
            // result, but skip it explicitly rather than relying on that.
            const isAuthFailureEvent =
              isRecord(data) && data.type === CANOPY_AUTH_FAILURE_EVENT_TYPE;
            if (!isAuthFailureEvent) {
              // One id for every pairing this provider event produced, so the
              // stop site merges them into ONE stopped-turn record and issues ONE
              // cancel instead of overwriting the first pairing's dependencies
              // and cancelling twice (CAN-1814 review).
              const authStopGroupId = randomUUID();
              for (const pairing of pairPendingAuthFailuresWithTool(
                data,
                sessionKey,
              )) {
                void handleSessionEvent(pairing.event);
                // Stop the turn only AFTER the card's own event is durably
                // committed and delivered. `handleSessionEvent` appends to
                // `sessionEventCommitTail` synchronously, so reading the tail
                // here captures that append; cancelling first would tear the
                // session down while the event explaining WHY was still in
                // flight, and the user would see a turn stop for no visible
                // reason.
                //
                // Gated inside `stopTurnForAuthFailure` on `recovery.kind`,
                // never on `failureClass` — a non-recoverable blocker leaves the
                // agent running to route around it (CAN-1814 PR 6).
                const committed = sessionEventCommitTail;
                void committed
                  .then(async () => {
                    const stop = await stopTurnForAuthFailure({
                      target: {
                        projectId: options.projectId,
                        worktreeId: options.worktreeId,
                        chatId: options.chatId,
                      },
                      event: pairing.event,
                      toolName: pairing.toolName,
                      batchHasUnresolvedToolCalls:
                        pairing.batchHasUnresolvedToolCalls,
                      stopGroupId: authStopGroupId,
                      ...(options.initiationSource !== undefined
                        ? { initiationSource: options.initiationSource }
                        : {}),
                      getWindow: options.getWindow,
                    });
                    if (!stop.stopped) return;
                    // Same pairing `chat-queue-service.defaultCancel` uses before
                    // it force-sends: the cancelled turn's terminal event can lag
                    // behind `cancel()` resolving, and a stale active-turn marker
                    // would make the resume dispatch trip the second-active-turn
                    // guard below.
                    clearActiveTurnUserMessageId(
                      options.projectId,
                      options.worktreeId,
                      options.chatId,
                    );
                  })
                  .catch((error: unknown) => {
                    logMainProcessError(
                      `Failed to stop the turn after an authentication failure for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
                      error,
                    );
                  });
              }
            }
          };
          const commitEvent = (
            onCommitQueued?: () => void,
          ): Promise<boolean | void> => {
            const providerType = eventProviderType();
            return beforeChatEvent({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
              data: attributedData,
              sequenceNamespace,
              sequence,
              ...(evaluation.revivesSettledTurn
                ? {}
                : { turnUserMessageId: executionUserMessageId }),
              ...(providerType ? { providerType } : {}),
              ...(onCommitQueued ? { onCommitQueued } : {}),
            });
          };
          if (overlaps) {
            // This link ends once the commit holds its place in the scope's
            // commit order, so the next event's commit can join its journal
            // sync. The event is delivered when its commit is durable, after
            // every event ahead of it.
            const { queued, completed } = commitPipeline.overlap(
              (markQueued) =>
                commitEvent(markQueued).finally(() =>
                  markPersistenceSettled?.(),
                ),
              (outcome): void => {
                if (outcome.status === 'rejected') throw outcome.reason;
                if (outcome.value === false) return;
                if (resumeOwnsTerminalSettlement()) return;
                deliverSessionEvent(attributedData, evaluation, occurredAt);
                emitPairedAuthFailures();
              },
            );
            overlappedCompletion = completed.catch((error: unknown) => {
              logMainProcessError(
                `Failed to durably commit chat event for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
                error,
              );
            });
            await queued;
            return;
          }
          let committed: boolean | void;
          try {
            committed = await commitEvent();
          } catch (error) {
            rollbackRevival();
            markPersistenceSettled?.();
            throw error;
          }
          // The canonical commit has settled. Keep the later presentation,
          // watcher, and recursively derived event work on its existing tail.
          markPersistenceSettled?.();
          if (committed === false) {
            rollbackRevival();
            return;
          }
          // Ownership can change while canonical persistence is in flight.
          // Once Resume has claimed this same anchor, retain the durable old
          // event but do not let its transport deliver or settle the new run.
          if (resumeOwnsTerminalSettlement()) return;
          if (
            isRecord(attributedData) &&
            attributedData.type === 'canopy_input_delivery' &&
            attributedData.phase === 'picked-up' &&
            attributedData.startsTurn === true &&
            typeof attributedData.userMessageId === 'string'
          ) {
            const queue = await getChatQueueServiceForTurnLifecycle();
            const target = {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            };
            let pickupAccepted: boolean;
            if (attributedData.turnRootAccepted === false) {
              pickupAccepted = false;
            } else if (attributedData.turnRootAccepted === true) {
              queue.confirmTurnRevived(target, attributedData.userMessageId);
              pickupAccepted = true;
            } else {
              pickupAccepted = queue.onTurnRevived(
                target,
                attributedData.userMessageId,
              );
            }
            // The pickup event is still durable evidence when the queue has
            // already advanced, but it must not steal event attribution from
            // the newer active turn.
            if (pickupAccepted) {
              if (unownedTurnRootUserMessageId === attributedData.userMessageId)
                unownedTurnRootUserMessageId = undefined;
              executionUserMessageId = attributedData.userMessageId;
              turnSettled = false;
              // The picked-up input starts a turn this closure now owns.
              openPlanTurn();
              if (!isCoworkChat) {
                activeTurnUserMessageIds.set(
                  sessionKey,
                  executionUserMessageId,
                );
                await turnDiffCaptureTail;
                await captureTurnStart(
                  sessionKey,
                  options.projectId,
                  options.worktreeId,
                );
              }
            }
          }
          deliverSessionEvent(attributedData, evaluation, occurredAt);
          emitPairedAuthFailures();
        })
        .catch((error: unknown) => {
          markPersistenceSettled?.();
          logMainProcessError(
            `Failed to durably commit chat event for ${options.projectId}/${options.worktreeId}/${options.chatId}`,
            error,
          );
        });
      // The caller releases the event's pressure charge when this settles:
      // for an overlapped event, that is after its commit and delivery.
      return sessionEventCommitTail.then(() => overlappedCompletion);
    };
    const drainSessionEvents = async (): Promise<void> => {
      // First drain provider events so a terminal event has a chance to start
      // its asynchronous turn-diff capture. Then await that derived work and
      // the durable event commit it appends.
      await sessionEventCommitTail;
      if (commitPipeline.pending) await commitPipeline.drained();
      await turnDiffCaptureTail;
      await sessionEventCommitTail;
      if (commitPipeline.pending) await commitPipeline.drained();
    };
    if (preparation.cancelled) return;
    // Until the provider accepts the prompt, the session reads as idle. Hold
    // it from before creation so a passive auth transition observed meanwhile
    // (startChatTurn warms the account cache) recycles it after this turn
    // instead of dropping the prompt.
    releaseSessionTurnPreparation = beginSessionTurnPreparation(sessionKey);
    const session = await getOrCreateRoutedSession(
      buildSessionOptions(),
      handleSessionEvent,
      options.getWindow,
      {
        turnUserMessageId: executionUserMessageId,
        acceptTurnRoot: async (turnUserMessageId): Promise<boolean> => {
          // Arbitrate in provider-event order. A preceding terminal event may
          // still be waiting for its durable commit; deciding before it lands
          // would reject an ordinary pickup against the turn it just ended.
          await sessionEventCommitTail;
          if (commitPipeline.pending) await commitPipeline.drained();
          const accepted = (
            await getChatQueueServiceForTurnLifecycle()
          ).onTurnRevived(
            {
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              chatId: options.chatId,
            },
            turnUserMessageId,
          );
          // The queue gate now waits on this root; the pickup's commit decides
          // whether this closure comes to own its turn.
          if (accepted) unownedTurnRootUserMessageId = turnUserMessageId;
          return accepted;
        },
        drainEventsBeforeRemoval: drainSessionEvents,
        onRemoved: (): void => {
          void drainSessionEvents().then(() => {
            // The session is gone, so an unowned root's terminal never arrives.
            releaseUnownedTurnRoot('cancelled');
            if (
              (turnSettled &&
                (!resumesStoppedTurn || resumedTransportSettled)) ||
              isCoworkChat
            ) {
              return;
            }
            if (deferredToolsReloadCoordinator.hasActiveReload(options)) {
              // A tool reload keeps the logical turn alive, so its plan-file
              // lease is held until the reload settles. After a hand-off the
              // continuation's lease has already superseded this one and the
              // release is a no-op; a reload that fails, is cancelled or
              // rejected, or times out starts no continuation, and this
              // release is the only thing that ends the lease.
              deferredToolsReloadCoordinator.whenActiveReloadSettles(
                options,
                closePlanTurn,
              );
              return;
            }
            // If no queued provider event settled this turn, release its queue
            // gate even when account teardown had no terminal event to deliver.
            turnSettled = true;
            closePlanTurn();
            if (resumesStoppedTurn) {
              getStoppedTurnResumeService().settleTerminalOwnership(
                {
                  projectId: options.projectId,
                  worktreeId: options.worktreeId,
                  chatId: options.chatId,
                },
                executionUserMessageId,
              );
            }
            if (
              activeTurnUserMessageIds.get(sessionKey) ===
              executionUserMessageId
            ) {
              activeTurnUserMessageIds.delete(sessionKey);
            }
            void getChatQueueServiceForTurnLifecycle().then((queue) => {
              // Session teardown can finish after the resumed dispatch has
              // reserved this same user-message anchor. The resume coordinator
              // distinguishes that ownership even though the queue id cannot.
              if (resumeOwnsTerminalSettlement()) return;
              queue.onTurnTerminal(
                {
                  projectId: options.projectId,
                  worktreeId: options.worktreeId,
                  chatId: options.chatId,
                },
                'cancelled',
                executionUserMessageId,
              );
            });
          });
        },
      },
    );
    if (preparation.cancelled) return;
    const authoritativeGlobalInstructionsSnapshot =
      getSessionGlobalInstructionsSnapshot(
        options.projectId,
        options.worktreeId,
        options.chatId,
      ) ?? sessionConfiguration.globalInstructionsBlock;
    if (
      options.globalInstructionsSnapshot !==
      authoritativeGlobalInstructionsSnapshot
    ) {
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        {
          type: GLOBAL_INSTRUCTIONS_SNAPSHOT_EVENT_TYPE,
          globalInstructionsSnapshot: authoritativeGlobalInstructionsSnapshot,
        },
      );
    }

    deferredToolsReloadCoordinator.registerResumeHandler(
      {
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
      },
      async (request) => {
        request.signal.throwIfAborted();
        await getChatStateService().runWithScopeActivity(
          {
            projectId: options.projectId,
            worktreeId: options.worktreeId,
          },
          () =>
            dispatchWorktreeChatTurn({
              ...options,
              userMessageId: request.userMessageId,
              text: request.continuationText,
              ...claudeContinuationSession(options, {
                requestedSessionId: request.sdkSessionId,
                providerSessionId: session.getProviderSessionId?.(),
              }),
              providerType: request.providerType ?? runtimeProviderType,
              pluginSelections:
                request.pluginSelections ??
                runtime?.pluginSelections ??
                options.pluginSelections,
              hiddenContext: undefined,
              fileReferences: undefined,
              attachmentPaths: undefined,
              attachmentPromptContexts: undefined,
              pendingSystemInstructions: undefined,
              activePlan: undefined,
              startsNewTrackedChat: false,
              skipBranchNaming: true,
              hiddenDeferredContinuation: true,
              deferredToolsReloadEnabledResources: request.enabledResources,
              providerEventSequenceNamespace: request.requestId,
            }),
        );
        if (request.signal.aborted) {
          await destroySession(
            options.projectId,
            options.worktreeId,
            options.chatId,
            { retainDelegations: true },
          );
          request.signal.throwIfAborted();
        }
      },
    );

    const observabilityService = await observabilityServicePromise;
    const usageScope = await resolveUsageChatScope({
      projectId: options.projectId,
      isCoworkChat,
      selectedRepoId: options.selectedRepoId,
    });
    // The memory block is only needed by the observability record below and by
    // `session.sendMessage`, so the race is settled here rather than right
    // after the visible text is built. Everything in between — dispatch
    // metadata and preference reads, model-runtime resolution, session
    // creation/resume — is work the turn does anyway, and the in-flight fetch
    // now overlaps it instead of blocking ahead of it. The budget stays
    // anchored at dispatch start, so that overlap is subtracted from the wait
    // rather than added to the turn: a fetch that finished during setup costs
    // nothing, and the total added delay can never exceed the budget.
    const preparedMemory = await raceWithTimeout(
      memoryPromise,
      remainingMemoryBudgetMs(dispatchStartedAt),
    );
    const memory = preparedMemory?.attempt.result ?? null;
    if (preparedMemory === null) {
      // Race loss: `memoryPromise` is still pending (or resolved to nothing).
      // The tracker attaches a continuation so a late result that would have
      // been injected — a searchId with at least one fact — is attributed as
      // a race_timeout drop instead of leaving the search's delivery outcome
      // null forever. Attached before the dispatch-exit continuation, so a
      // race loss on a turn that later aborts stays a race_timeout.
      memoryDeliveryTracker.noteRaceLoss();
    }
    const activePlanInstruction = await activePlanInstructionPromise;
    if (preparation.cancelled) return;
    // A hidden continuation never carries one-shot instructions; they belonged
    // to the turn it continues.
    const instructedSubmittedText = options.hiddenDeferredContinuation
      ? visibleSubmittedText
      : prependPendingSystemInstructions(
          visibleSubmittedText,
          withActivePlanInstruction(
            options.pendingSystemInstructions,
            activePlanInstruction,
          ),
        );
    const submittedText = composeSubmittedText(
      instructedSubmittedText,
      options.hiddenContext?.text,
      joinHiddenBlocks(memory?.renderedBlock, localMemory?.renderedBlock),
    );
    if (
      options.hiddenDeferredContinuation &&
      options.hiddenContinuationKind !== 'stopped_turn_resume'
    ) {
      observabilityService.recordInjectedPromptForOpenChatTurn(
        options.projectId,
        options.worktreeId,
        options.chatId,
        {
          kind: 'system_prompt_append',
          provider: runtimeProviderType,
          applicationCondition: 'deferred_tools_reload_continuation',
          text: options.text,
          deferredToolsReload: {
            enabledResources: options.deferredToolsReloadEnabledResources ?? [],
          },
        },
      );
    } else {
      observabilityService.startChatTurn({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        provider: runtimeProviderType,
        model: runtimeModel,
        modelSource: runtimeModel ? getModelSource(runtimeModel) : undefined,
        executionHarness: effectiveExecutionHarness,
        serviceTier:
          effectiveExecutionHarness === 'codex'
            ? codexServiceTierForModelConfig(effectiveModelConfig)
            : undefined,
        aiCreditsRouted: isSessionAiCreditsRouted(
          options.projectId,
          options.worktreeId,
          options.chatId,
        ),
        accountProxyRouted: isSessionAccountProxyRouted(
          options.projectId,
          options.worktreeId,
          options.chatId,
        ),
        ...(options.modelRouting ? { modelRouting: options.modelRouting } : {}),
        sdkSessionId: options.sdkSessionId,
        originalUserText: options.text,
        submittedText,
        fileReferences: options.fileReferences,
        planMode: options.planMode,
        systemPromptAppend: observedSystemPromptAppend,
        orgMemoryBlock: memory?.renderedBlock,
        userMessageId: options.userMessageId,
        isStandalone: isCoworkChat,
        standaloneProjectId,
        initiationSource: options.initiationSource ?? 'user',
        selectedRepoId: options.selectedRepoId,
        ...usageScope,
        // Same explicit-user eligibility as skill usage, minus hidden context.
        skillSuggestionEligible:
          options.countsTowardSkillUsage === true &&
          !options.hiddenDeferredContinuation &&
          !options.hiddenContext,
      });
    }

    await session.setPlanMode(options.planMode);
    const liveDispatchMetadata = await readPersistedChatDispatchMetadata(
      options.projectId,
      options.worktreeId,
      options.chatId,
    ).catch(
      (): PersistedChatDispatchMetadata =>
        ({}) satisfies PersistedChatDispatchMetadata,
    );
    const liveApprovalMode = clampToLiveApprovalMode(
      options.projectId,
      options.worktreeId,
      options.chatId,
      liveDispatchMetadata.approvalMode ?? options.approvalMode,
    );
    if (liveApprovalMode) {
      await session.setApprovalMode(liveApprovalMode);
    }
    if (
      (runtimeProviderType === 'claude' ||
        runtimeProviderType === 'cursor' ||
        runtimeProviderType === 'copilot' ||
        runtimeProviderType === 'opencode') &&
      session.setRtkEnabled
    ) {
      await session.setRtkEnabled(rtkEnabled);
    }
    if (options.codexProposalMode && session.setCodexProposalMode) {
      await session.setCodexProposalMode(options.codexProposalMode);
    }
    if (codexPreferences && session.setCodexAppServerIdleTimeoutMinutes) {
      await session.setCodexAppServerIdleTimeoutMinutes(
        codexPreferences.codexAppServerIdleTimeoutMinutes,
      );
    }
    await applyAgentSessionCodexSpeed(session, effectiveModelConfig.speed);

    if (!isCoworkChat && !options.hiddenDeferredContinuation) {
      await captureTurnStart(sessionKey, options.projectId, options.worktreeId);
    }
    if (preparation.cancelled) {
      if (!options.hiddenDeferredContinuation) {
        observabilityService.completeChatTurn(
          options.projectId,
          options.worktreeId,
          options.chatId,
          'interrupted',
        );
      }
      return;
    }
    if (!isCoworkChat && !options.hiddenDeferredContinuation) {
      // Serialization is owned by the chat queue service (a second dispatch
      // cannot start while it holds turnActive). A leftover marker here means
      // the previous turn died without its terminal event (destroyed session,
      // test double); overwrite rather than wedge the chat — the stale turn's
      // late terminal is filtered by the userMessageId mismatch check above.
      activeTurnUserMessageIds.set(sessionKey, options.userMessageId);
    }
    if (
      options.startsNewTrackedChat &&
      !options.hiddenDeferredContinuation &&
      options.projectId !== APP_ADVISOR_PROJECT_ID
    ) {
      await notifyCanonicalChatStarted(
        options,
        options.userMessageId,
        watcherAcceptedAt,
        watcherContext,
      ).catch(() => undefined);
    }
    if (isCodeReview) {
      // Open the active-turn gate so a review regeneration triggered by real
      // worktree activity defers until this turn settles. `options.worktreeId`
      // is the composite scope key for this sentinel scope; the hook resolves
      // the real ids via the code-review registry. The matching
      // `noteCodeReviewTurnEnd` runs in the terminal chat-event handler above.
      noteCodeReviewTurnStart(options.worktreeId);
    }
    // Take the plan-file turn lease with no await before the send, so a
    // cancelled preparation never takes one. Every exit below ends it: the
    // root terminal event, a rejected send, a session disposed at send, or
    // session removal without a terminal event.
    openPlanTurn();
    let delegationDeliveryClaimed = false;
    try {
      // Recheck after every asynchronous preparation step. A closed generation
      // must never start a paid continuation from an already-claimed queue row.
      if (
        options.managedDelegationDeliveryId &&
        (options.managedDelegationDeliveryId !== options.userMessageId ||
          !claimDelegationDelivery(
            options,
            options.managedDelegationDeliveryId,
          ))
      )
        throw new Error('Delegation completion owner is no longer active');
      delegationDeliveryClaimed = Boolean(options.managedDelegationDeliveryId);
      // No await between this fence and queue acceptance. Parent Stop after
      // acceptance must not cancel an independent child's lifetime.
      options.admissionSignal?.throwIfAborted();
      session.sendMessage(submittedText, {
        userMessageId: options.userMessageId,
        ...(effectiveExecutionHarness === 'opencode' &&
        !options.hiddenDeferredContinuation &&
        options.attachmentPaths?.length
          ? {
              attachments: {
                baseDir: attachmentBaseDir,
                paths: [...options.attachmentPaths],
              },
            }
          : {}),
        ...(options.countsTowardSkillUsage === true &&
        !options.hiddenDeferredContinuation
          ? { countsTowardSkillUsage: true }
          : {}),
      });
      // A waiting provider loop dequeues the prompt at once but may still
      // await work before marking the turn active; hold until it does.
      releaseSessionTurnPreparationOnActivation(
        sessionKey,
        releaseSessionTurnPreparation,
      );
      releaseSessionTurnPreparation = undefined;
    } catch (error) {
      closePlanTurn();
      if (delegationDeliveryClaimed && options.managedDelegationDeliveryId)
        releaseDelegationDelivery(options, options.managedDelegationDeliveryId);
      if (memory && memory.facts.length > 0 && memory.searchId) {
        // The block was prepared and composed but the provider rejected the
        // turn, so this search's injection verifiably did not reach the
        // model. Attribute it before rethrowing; the ack never throws.
        memoryDeliveryTracker.ackDropped(
          memory.organizationExternalId,
          memory.searchId,
          'send_failed',
        );
      }
      throw error;
    }
    if (
      !options.hiddenDeferredContinuation &&
      session.isDisposed?.() !== true &&
      (options.initiationSource === undefined ||
        options.initiationSource === 'user' ||
        options.initiationSource === 'portal')
    ) {
      for (const id of handoffsAtSend) browserHandoffs.release(id);
    }
    options.onTurnAccepted?.();
    // `sendMessage` enqueues without inspecting session state, so a session
    // destroyed between dispatch and send still accepts the composed turn into
    // a queue no provider will ever drain. No terminal event will end that
    // turn, and its removal may already have run.
    const sessionDisposedAtSend = session.isDisposed?.() === true;
    if (sessionDisposedAtSend) {
      closePlanTurn();
    }
    if (memory && memory.facts.length > 0) {
      // A turn sent into a disposed session is a drop, not a delivery — and a
      // dropped block must not be persisted or broadcast as a used memory
      // either, or the UI would show (and accept feedback on) an injection
      // that never reached the model.
      if (memory.searchId) {
        if (sessionDisposedAtSend) {
          memoryDeliveryTracker.ackDropped(
            memory.organizationExternalId,
            memory.searchId,
            'turn_aborted',
          );
        } else {
          // Fire-and-forget delivery ack: `session.sendMessage` above means
          // the composed turn was accepted into a live session's in-memory
          // queue. That is queue acceptance — the strongest signal available
          // at this seam — not verified model receipt. The ack never throws
          // and must not gate the turn.
          memoryDeliveryTracker.ackDelivered(
            memory.organizationExternalId,
            memory.searchId,
          );
        }
      }
      if (sessionDisposedAtSend) {
        return;
      }
      await persistOrgMemoryUsedForChat({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        organizationExternalId: memory.organizationExternalId,
        ...(memory.searchId ? { searchId: memory.searchId } : {}),
        facts: memory.facts,
      }).catch((error: unknown) => {
        // Keep the turn alive if durable disclosure persistence fails. A live
        // renderer can still apply the event below, while renderer-less paths
        // get a diagnostic instead of silently dropping the write.
        // eslint-disable-next-line no-console
        console.error('[org-memory] Failed to persist memory-used metadata', {
          projectId: options.projectId,
          worktreeId: options.worktreeId,
          chatId: options.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const memoryUsedEvent: OrgMemoryUsedEventData = {
        type: ORG_MEMORY_USED_EVENT_TYPE,
        localChatId: options.chatId,
        localMessageId: options.userMessageId,
        organizationExternalId: memory.organizationExternalId,
        ...(memory.searchId ? { searchId: memory.searchId } : {}),
        facts: memory.facts,
      };
      sendWorktreeChatEvent(
        options.getWindow,
        options.projectId,
        options.worktreeId,
        options.chatId,
        memoryUsedEvent,
      );
    }
  } finally {
    releaseSessionTurnPreparation?.();
    preparation.finish();
    resourceGuard?.release();
    // Every exit path settles the delivery tracker: if this dispatch ended
    // without a delivered ack, an injectable memory result — resolved or
    // still in flight — is attributed as a turn_aborted drop. No-op when the
    // outcome was already acked above.
    memoryDeliveryTracker.noteDispatchExit();
  }
}

export const worktreeChatTurnTestExports = {
  currentSessionEventHandlerCount:
    sessionEventRouterTestExports.currentRouteCount,
  resetCurrentSessionEventHandlers: sessionEventRouterTestExports.reset,
  /**
   * Read the active-turn marker. Test-only: production code either sets it
   * during dispatch or clears it through
   * {@link clearActiveTurnUserMessageId}, and a public getter would invite
   * reads that race the turn it describes.
   */
  activeTurnUserMessageId: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string | undefined =>
    activeTurnUserMessageIds.get(
      buildSessionKey(projectId, worktreeId, chatId),
    ),
};
