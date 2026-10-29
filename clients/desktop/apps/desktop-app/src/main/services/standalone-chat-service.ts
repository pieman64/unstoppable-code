import type { AgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';
import { resolvePresentationSource } from '../canopy-tools/presentation-state';
import { chatLastMessageRole } from '../lib/chat-last-message-role';
import { assertOpenCodeModelAvailable } from '../opencode/connection';
import { isOpenCodeRuntimeAvailable } from '../opencode/runtime-availability';
import { assertCopilotModelAvailable } from '../copilot/connection';
import { isCopilotRuntimeAvailable } from '../copilot/runtime-availability';
import { randomUUID } from 'node:crypto';
import { inputDeliveryViews } from '@canopy/desktop-shared/chat-input-delivery';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { getChatQueueService } from './chat-queue-service';
import type { BrowserWindow } from 'electron';
import {
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  getExecutionHarnessForModel,
  getModelDisplayName,
  getProviderForModel,
  resolvePersistedChatExecutionHarness,
  resolveKnownModel,
  COWORK_HOME_WORKTREE_ID,
  DEFAULT_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  type ChatProjectData,
  type CoworkWorkEntryChatSummary,
  type AgentModelConfig,
  type AgentProviderType,
  type AiCreditsScopeRequest,
  type ModelHarness,
  type PersistedChatMessage,
  type PersistedChatTab,
  type PersistedPendingQuestion,
  type PortalChatMessage,
  type PortalStandaloneChatCancelPayload,
  type PortalStandaloneChatSendPayload,
  type PortalStandaloneChatSetModelPayload,
  type PortalStandaloneChatSummary,
  type PortalStandaloneWorkEntryFields,
  type PortalSessionShellState,
  type ChatTabPluginSelections,
  type UsageInitiationSource,
  type ThinkingLevel,
  type ApprovalMode,
  type ApprovalRule,
  type FileReference,
  type ChatCommand,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatCommandExecutionOptions,
} from '@canopy/desktop-shared/types';
import type {
  PortalStandaloneChatCreatePayload,
  PortalStandaloneChatCreateResult,
} from '@canopy/protocol/portal';
import { mergeAgentModelConfig } from '@canopy/desktop-shared/lib/codex-speed';
import { validateId } from '../lib/validation';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../lib/model-policy-state';
import { checkModelGatewayRoute } from '../lib/model-gateway-state';
import { listCoworkWorkspacesAsChatProjects } from '../lib/cowork-workspace-crud';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  createWorkEntry,
  listWorkEntryChatSummaries,
  listWorkEntryIds,
  resolveWorkEntryForChat,
  type WorkEntryChatSummaryListItem,
} from '../lib/cowork-work-entries';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { buildProjectedModelCatalog } from '../portal/model-catalog-projection';
import { peekPortalProviderAvailability } from '../auth/provider-auth-state';
import { isCursorRuntimeAvailable } from '../cursor/runtime-availability';
import { isCanopyPortalActive } from '../portal/portal-event-bus';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import {
  GLOBAL_LANE_CREDENTIAL_SCOPE,
  resolveConcreteModelDispatchability,
  resolveLaneAwareDefaultSelection,
  type LaneCredentialScope,
} from '../lib/default-model-lane-resolver';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  getActiveChatIds,
  getActiveSessionInfos,
  getSession,
  getSessionProviderType,
  getSessionSelectedModel,
} from '../agents/session-manager';
import { projectPortalQuestionStates } from '../lib/portal-question-states';
import { projectPortalLastTurnEnd } from '../lib/portal-turn-end';
import {
  createAiCreditsScopeOwnerResolver,
  resolveAiCreditsScopeOwner,
} from '../agents/work-owner';
import {
  pinInheritingAgentToDestination,
  resolveCatalogAgentDefaultModel,
  resolveSendModelPin,
} from '../agents/agent-default-model';
import { sendToWindow } from '../lib/window-send';
import {
  createPortalEvent,
  enqueuePortalEvent,
} from '../portal/portal-event-bus';
import { scheduleDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';
import {
  createPortalTurnTimer,
  limitPortalChatTranscriptForSeedWithMetadata,
  type PortalChatTranscriptSeed,
  projectPersistedChatTranscript,
  runtimeChatEventToPortalMessage,
} from './chat-transcript-projector';
import { buildAutomationInfoMessage } from './automation-info-message';
import { notifyCanonicalChatStarted } from '../services/active-chat-input';
import { readPreferencesFile } from '../lib/preferences-store';
import { readChatArchivesFile } from '../lib/chat-archives';
import { listHistoryChatIds } from '../lib/standalone-history-index';
import { getCoworkWorkspaceRootDir } from '../lib/paths';
import { scheduleChatSummary } from '../lib/worktree-chat-turn';
import {
  cancelTransientRetriesForChatId,
  cancelTransientRetriesForWorkspaceChat,
  cancelTransientRetryForChat,
} from '../lib/transient-error-retry-service';
import { resolvePersistedApprovalMode } from '../lib/approval-mode-resolution';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { clampToLiveApprovalMode } from '../approvals/live-approval-modes';
import {
  capturePersistedUsageLimitBannerSnapshot,
  clearPersistedUsageLimitBanner,
} from '../lib/chat-usage-limit-cleanup';
import { clearUsageLimitedChat } from '../lib/usage-limited-chats-registry';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { notificationSpaceIdFor } from '../lib/space-notification-gate';
import { getChatStateService } from './chat-state-service';
import { PortalServiceError } from './portal-service-error';
import type { PipelinePackageCapabilityOverlay } from '@canopy/desktop-shared/types/pipeline';

const CURSOR_CONNECT_MESSAGE =
  'Connect Cursor in Settings to send with Cursor, or choose another model.';

/**
 * Cowork runs Cursor on the managed runtime like a worktree chat. Every entry
 * that would persist a Cursor routing decision checks the runtime first so a
 * disconnected runtime never leaves a dead Work Entry or message behind.
 */
async function assertCursorRuntimeForCowork(): Promise<void> {
  if (!(await isCursorRuntimeAvailable())) {
    throw new Error(CURSOR_CONNECT_MESSAGE);
  }
}

export interface StandaloneChatServiceOptions {
  executionContext?: string;
  getWindow?: () => BrowserWindow | null;
}

type StandaloneChatSendRequest = Omit<
  PortalStandaloneChatSendPayload,
  'fileReferences'
> & {
  fileReferences?: FileReference[];
  planMode?: boolean;
  modelConfig?: AgentModelConfig;
  thinkingLevel?: ThinkingLevel;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  pluginSelections?: ChatTabPluginSelections;
  packageOverlay?: PipelinePackageCapabilityOverlay;
  deferredToolsAllowed?: boolean;
  initiationSource?: UsageInitiationSource;
  automationName?: string;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  /**
   * Existing Work Entry that receives a brand-new chat, instead of a Work
   * Entry created for it. Local callers only (automations); not part of the
   * Portal payload.
   */
  workEntryId?: string;
  /**
   * Trusted marker from a validated Portal command origin: an external MCP
   * agent sent this message for the person. Never read from the payload.
   */
  agentSent?: AgentSentInfo;
};

function getNullWindow(): BrowserWindow | null {
  return null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function upsertMessage(
  messages: PersistedChatMessage[],
  message: PersistedChatMessage,
): PersistedChatMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  if (index === -1) return [...messages, message];
  return messages.map((candidate, candidateIndex) =>
    candidateIndex === index ? message : candidate,
  );
}

function upsertMessages(
  messages: PersistedChatMessage[],
  nextMessages: PersistedChatMessage[],
): PersistedChatMessage[] {
  return nextMessages.reduce(upsertMessage, messages);
}

function firstLineTitle(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 60) : `${REMOTE_CONTROL_LABEL} Chat`;
}

function capturedExecutionHarnessForStandaloneTab(
  tab: PersistedChatTab | undefined,
  workspaceId: string,
  entryId: string,
): ModelHarness | undefined {
  if (!tab) return undefined;
  const hasCapturedHarness =
    tab.executionHarness !== undefined ||
    (tab.transcript?.messageCount ??
      tab.transcript?.committedMessageCount ??
      tab.messages.length) > 0 ||
    Boolean(tab.sdkSessionId) ||
    getActiveChatIds(workspaceId, entryId).includes(tab.id);
  return hasCapturedHarness
    ? resolvePersistedChatExecutionHarness(tab)
    : undefined;
}

async function upsertStandaloneMessages(input: {
  executionContext?: string;
  workspaceId: string;
  entryId: string;
  chatId: string;
  messages: PersistedChatMessage[];
  model?: string;
  providerType?: AgentProviderType;
  executionHarness?: ModelHarness;
  modelConfig?: AgentModelConfig;
  thinkingLevel?: ThinkingLevel;
  planMode?: boolean;
  pluginSelections?: ChatTabPluginSelections;
  deferredToolsAllowed?: boolean;
  newChatStartedWatcherFiredAt?: string;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
}): Promise<PersistedChatTab> {
  return enqueueChatTabMutation(input.workspaceId, input.entryId, async () => {
    const tabsFile = await readChatTabsFile(input.workspaceId, input.entryId, {
      chatIds: [input.chatId],
    });
    const existing = tabsFile.tabs.find((tab) => tab.id === input.chatId);
    const selectedModel = input.model ?? existing?.model;
    const modelHarness = selectedModel
      ? getExecutionHarnessForModel(selectedModel)
      : undefined;
    const capturedHarness = capturedExecutionHarnessForStandaloneTab(
      existing,
      input.workspaceId,
      input.entryId,
    );
    if (
      input.model !== undefined &&
      existing?.model !== input.model &&
      capturedHarness !== undefined &&
      modelHarness !== undefined &&
      capturedHarness !== modelHarness
    ) {
      throw new Error(
        `Cannot send a started standalone chat through the "${modelHarness}" execution harness because it was captured on "${capturedHarness}".`,
      );
    }
    const executionHarness = capturedHarness ?? modelHarness;
    const firstMessage = input.messages[0];
    const nowIso = new Date(
      firstMessage?.timestamp ?? Date.now(),
    ).toISOString();
    const tab: PersistedChatTab = existing
      ? {
          ...existing,
          messages: upsertMessages(existing.messages, input.messages),
          ...(input.model == null ? {} : { model: input.model }),
          ...(input.providerType == null
            ? {}
            : { providerType: input.providerType }),
          ...(executionHarness ? { executionHarness } : {}),
          ...(input.modelConfig == null
            ? {}
            : {
                modelConfig: mergeAgentModelConfig(
                  existing.modelConfig,
                  input.modelConfig,
                ),
              }),
          ...(input.thinkingLevel == null
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
          ...(typeof input.planMode === 'boolean'
            ? { planMode: input.planMode }
            : {}),
          ...(input.pluginSelections == null
            ? {}
            : { pluginSelections: input.pluginSelections }),
          ...(input.approvalMode == null
            ? {}
            : { approvalMode: input.approvalMode }),
          ...(input.sessionApprovalRules == null
            ? {}
            : { sessionApprovalRules: input.sessionApprovalRules }),
          ...(typeof input.deferredToolsAllowed === 'boolean'
            ? { deferredToolsAllowed: input.deferredToolsAllowed }
            : {}),
        }
      : {
          id: input.chatId,
          automaticTitleState: 'pending',
          title: firstLineTitle(
            input.messages
              .flatMap((message) => message.blocks)
              .filter(
                (block): block is { type: 'text'; text: string } =>
                  block.type === 'text',
              )
              .map((block) => block.text)
              .join('\n'),
          ),
          createdAt: nowIso,
          messages: input.messages,
          kind: 'chat',
          ...newChatPluginDefaultsStamp(input.workspaceId),
          ...(input.model == null ? {} : { model: input.model }),
          ...(input.providerType == null
            ? {}
            : { providerType: input.providerType }),
          ...(executionHarness ? { executionHarness } : {}),
          ...(input.modelConfig == null
            ? {}
            : { modelConfig: input.modelConfig }),
          ...(input.thinkingLevel == null
            ? {}
            : { thinkingLevel: input.thinkingLevel }),
          ...(typeof input.planMode === 'boolean'
            ? { planMode: input.planMode }
            : {}),
          ...(input.pluginSelections == null
            ? {}
            : { pluginSelections: input.pluginSelections }),
          ...(input.approvalMode == null
            ? {}
            : { approvalMode: input.approvalMode }),
          ...(input.sessionApprovalRules == null
            ? {}
            : { sessionApprovalRules: input.sessionApprovalRules }),
          ...(typeof input.deferredToolsAllowed === 'boolean'
            ? { deferredToolsAllowed: input.deferredToolsAllowed }
            : {}),
        };
    if (input.executionContext !== undefined)
      tab.executionContext = input.executionContext;
    if (input.newChatStartedWatcherFiredAt) {
      delete tab.newChatStartedWatcherPending;
      tab.newChatStartedWatcherFiredAt = input.newChatStartedWatcherFiredAt;
    }
    await writeChatTabsFile(input.workspaceId, input.entryId, {
      ...tabsFile,
      tabs: existing
        ? tabsFile.tabs.map((candidate) =>
            candidate.id === input.chatId ? tab : candidate,
          )
        : [...tabsFile.tabs, tab],
      activeTabId: input.chatId,
    });
    return tab;
  });
}

async function persistStandaloneChatDescription(input: {
  workspaceId: string;
  entryId: string;
  chatId: string;
  description: string;
}): Promise<void> {
  await enqueueChatTabMutation(input.workspaceId, input.entryId, async () => {
    const tabsFile = await readChatTabsFile(input.workspaceId, input.entryId);
    const existing = tabsFile.tabs.find((tab) => tab.id === input.chatId);
    if (!existing) return;
    await writeChatTabsFile(input.workspaceId, input.entryId, {
      ...tabsFile,
      tabs: tabsFile.tabs.map((tab) =>
        tab.id === input.chatId
          ? { ...tab, description: input.description }
          : tab,
      ),
    });
  });
}

function validateStandaloneProjectId(value: string): string {
  validateId(value, 'projectId');
  return value;
}

async function readStandaloneProjects(
  strict = false,
): Promise<ChatProjectData[]> {
  try {
    return await listCoworkWorkspacesAsChatProjects();
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export async function createStandaloneChatTab(
  request: PortalStandaloneChatCreatePayload,
  options: {
    commandId: string;
    dispatchCommand: (
      request: ChatCommandRequest,
      options?: ChatCommandExecutionOptions,
    ) => Promise<ChatCommandResult>;
    seed: Omit<
      Extract<ChatCommand, { type: 'chat.create_tab' }>,
      'type' | 'tabId'
    >;
    canCreate: () => boolean;
  },
): Promise<PortalStandaloneChatCreateResult> {
  validateStandaloneProjectId(request.projectLocalId);
  validateId(request.chatId, 'chatId');
  const assertAuthorized = (): void => {
    if (!options.canCreate()) {
      throw new PortalServiceError(
        'invalid_target',
        'The paired session is no longer authorized.',
      );
    }
  };
  assertAuthorized();
  const resolved = await resolveStandaloneChatTarget(request);
  if (resolved.isArchived) {
    throw new PortalServiceError(
      'invalid_target',
      'Archived chats must be restored before they can be used.',
    );
  }
  const workspaceId = resolved.workspaceId;
  const entryId = resolved.entryId ?? request.chatId;
  return getChatStateService().runWithScopeActivity(
    { projectId: workspaceId, worktreeId: entryId },
    async () => {
      assertAuthorized();
      const projects = await readStandaloneProjects();
      if (!projects.some((project) => project.id === workspaceId)) {
        throw new PortalServiceError(
          'not_found',
          'The selected project is no longer available.',
        );
      }
      const current = await resolveWorkEntryForChat(
        workspaceId,
        request.chatId,
      );
      if (
        current.archivedInEntryId !== null ||
        (current.entryId !== null && current.entryId !== entryId)
      ) {
        throw new PortalServiceError(
          'invalid_target',
          'The selected chat target changed.',
        );
      }
      const registered = (await listWorkEntryIds(workspaceId)).includes(
        entryId,
      );
      if (registered && current.entryId === null) {
        const file = await readChatTabsFile(workspaceId, entryId);
        if (file.tabs.length > 0) {
          throw new PortalServiceError(
            'invalid_target',
            'This chat identifier belongs to another work entry.',
          );
        }
      }
      assertAuthorized();
      if (!registered) {
        await createWorkEntry(workspaceId, {
          id: entryId,
          ...(request.sidebarItemGroupId
            ? { sidebarItemGroupId: request.sidebarItemGroupId }
            : {}),
          assertCanCommit: assertAuthorized,
        });
      }
      assertAuthorized();
      const result = await options.dispatchCommand(
        {
          schemaVersion: 1,
          commandId: options.commandId,
          projectId: workspaceId,
          worktreeId: entryId,
          origin: 'portal',
          command: {
            ...options.seed,
            type: 'chat.create_tab',
            tabId: request.chatId,
          },
        },
        { canCommitCreate: options.canCreate },
      );
      if (
        result.outcome !== 'applied' &&
        result.outcome !== 'already_applied'
      ) {
        throw new PortalServiceError(
          result.outcome === 'not_found' ? 'not_found' : 'execution_failed',
          result.reason ?? 'The new chat could not be created.',
        );
      }
      await emitStandaloneChatSummary(workspaceId, entryId, request.chatId);
      assertAuthorized();
      return {
        ok: true,
        chatId: request.chatId,
        projectLocalId: workspaceId,
        projectId: workspaceId,
        worktreeId: entryId,
        workEntryId: entryId,
      };
    },
  );
}

interface ResolvedStandaloneChatTarget {
  workspaceId: string;
  /** Work entry whose live tabs contain the chat; null when the chat is new. */
  entryId: string | null;
  /** Work entry whose archive contains the chat; null for live/new chats. */
  archivedInEntryId: string | null;
  /** Includes retained pre-entry archives that have no owning Work Entry. */
  isArchived: boolean;
}

async function isLegacyArchivedChat(
  workspaceId: string,
  chatId: string,
): Promise<boolean> {
  const [historyChatIds, unifiedArchives] = await Promise.all([
    listHistoryChatIds(workspaceId),
    readChatArchivesFile(workspaceId, COWORK_HOME_WORKTREE_ID),
  ]);
  return (
    historyChatIds.includes(chatId) ||
    unifiedArchives.archived.some((entry) => entry.tab.id === chatId)
  );
}

/**
 * Resolves a portal standalone-chat reference — `(projectId?, chatId)`, no
 * entry dimension on the wire — to its cowork workspace + work entry. An
 * explicit workspace id wins; otherwise every cowork workspace is scanned
 * for the chat; a brand-new chat falls back to the default workspace with
 * `entryId: null` (senders create an entry for it).
 */
export async function resolveStandaloneChatTarget(input?: {
  projectId?: string;
  projectLocalId?: string;
  chatId?: string;
}): Promise<ResolvedStandaloneChatTarget> {
  const explicitProjectId = input?.projectLocalId ?? input?.projectId;
  if (explicitProjectId) {
    const workspaceId = resolveCoworkWorkspaceId(
      validateStandaloneProjectId(explicitProjectId),
    );
    const resolution = input?.chatId
      ? await resolveWorkEntryForChat(workspaceId, input.chatId)
      : { entryId: null, archivedInEntryId: null };
    const isArchived =
      resolution.archivedInEntryId !== null ||
      (input?.chatId !== undefined &&
        resolution.entryId === null &&
        (await isLegacyArchivedChat(workspaceId, input.chatId)));
    return { workspaceId, ...resolution, isArchived };
  }

  if (input?.chatId) {
    const projects = await readStandaloneProjects();
    for (const project of projects) {
      const resolution = await resolveWorkEntryForChat(
        project.id,
        input.chatId,
      );
      if (resolution.entryId || resolution.archivedInEntryId) {
        return {
          workspaceId: project.id,
          ...resolution,
          isArchived: resolution.archivedInEntryId !== null,
        };
      }
      if (await isLegacyArchivedChat(project.id, input.chatId)) {
        return { workspaceId: project.id, ...resolution, isArchived: true };
      }
    }
  }

  return {
    workspaceId: resolveCoworkWorkspaceId(DEFAULT_CHAT_PROJECT_ID),
    entryId: null,
    archivedInEntryId: null,
    isArchived: false,
  };
}

/**
 * The single projection of a Work Entry's grouping facts onto its chats. Every
 * snapshot and delta builder routes through here so a chat's container order,
 * pin and status can never drift between the two paths.
 */
function projectWorkEntryFields(
  entry: WorkEntryChatSummaryListItem,
  projectId: string,
): PortalStandaloneWorkEntryFields {
  const notificationSpaceId = notificationSpaceIdFor({
    projectId,
    worktreeId: entry.entryId,
  });
  return {
    workEntryId: entry.entryId,
    workEntryTitle: entry.title,
    workEntryCreatedAt: entry.createdAt,
    ...(entry.lastMessageAt
      ? { workEntryLastMessageAt: entry.lastMessageAt }
      : {}),
    ...(entry.lastTouchedAt
      ? { workEntryLastTouchedAt: entry.lastTouchedAt }
      : {}),
    workEntryOrder: entry.order,
    ...(entry.pinned === true ? { workEntryPinned: true } : {}),
    ...(entry.status === 'done' ? { workEntryStatus: 'done' } : {}),
    ...(notificationSpaceId
      ? { workEntryNotificationSpaceId: notificationSpaceId }
      : {}),
  };
}

async function resolveStandaloneDeferredToolsAllowed(
  persisted: boolean | undefined,
): Promise<boolean> {
  if (persisted !== undefined) return persisted;
  const preferences = await readPreferencesFile().catch(() => null);
  return preferences?.deferredToolsStandaloneChatsEnabled ?? true;
}

/**
 * Build the portal summary for a single standalone/cowork chat tab. Shared by
 * the snapshot list and the live re-projection after a composer flip so the two
 * paths never drift. The projected model catalog (CAN-1219) is only derived when
 * a portal session is connected — the common desktop-only case pays nothing —
 * because deriving it walks the full model + custom-Agent registry.
 */
function buildStandaloneChatSummary(
  projectId: string,
  projectName: string,
  tab: PersistedChatTab,
  options?: {
    hasActiveChat?: boolean;
    deferredToolsAllowed?: boolean;
    includeDelivery?: boolean;
    lastMessageAt?: string;
    workEntry?: WorkEntryChatSummaryListItem;
    owner?: WorkOwner;
    /** See `resolveCatalogAgentDefaultModel`. */
    agentDefaultModel?: string;
    /** The Work Entry's file-backed questions; omit for streaming updates. */
    pendingQuestions?: readonly PersistedPendingQuestion[];
  },
): PortalStandaloneChatSummary {
  const workEntryId = options?.workEntry?.entryId;
  const lastTurnEnd = projectPortalLastTurnEnd(tab);
  const lastMessageAt = tab.transcript
    ? tab.transcript.lastMessageAt
    : tab.messages[tab.messages.length - 1]?.timestamp;
  const providerType =
    tab.providerType === 'claude' ||
    tab.providerType === 'codex' ||
    tab.providerType === 'opencode'
      ? tab.providerType
      : undefined;
  const capabilities = workEntryId
    ? getSession(projectId, workEntryId, tab.id)?.getSteeringCapabilities?.()
    : undefined;
  const queuedMessages = workEntryId
    ? (getChatQueueService()
        .getWorktreeSnapshots(projectId, workEntryId)
        .find((snapshot) => snapshot.chatId === tab.id)
        ?.queue.map((message) => ({
          id: message.id,
          text: message.text,
          origin: message.origin,
          promptSource: message.promptSource,
          supersedesUserMessageId: message.supersedesUserMessageId,
          enqueuedAtMs: message.enqueuedAtMs,
          attachmentEditsPreservePayload: true,
          ...(message.editLocked ? { editLocked: true } : {}),
          ...(message.canSteer === true ? { canSteer: true } : {}),
          ...(message.agentSent ? { agentSent: message.agentSent } : {}),
          ...(message.steerBlockedByCapabilityChange === true
            ? { steerBlockedByCapabilityChange: true }
            : {}),
          ...(message.attachmentPaths?.length ||
          message.fileReferences?.length ||
          message.attachmentPromptContexts?.length
            ? { hasAttachments: true }
            : {}),
        })) ?? [])
    : [];
  return {
    ...(options?.includeDelivery === false
      ? {}
      : {
          queuedMessages,
          inputDelivery: inputDeliveryViews(tab.inputDelivery, capabilities),
          steeringCapabilities: capabilities,
        }),
    projectLocalId: projectId,
    projectId,
    chatId: tab.id,
    title: tab.title || projectName,
    ...(tab.customTitle !== undefined ? { customTitle: tab.customTitle } : {}),
    description: tab.description,
    ...(options?.workEntry
      ? projectWorkEntryFields(options.workEntry, projectId)
      : {}),
    modelLabel: tab.model ? getModelDisplayName(tab.model) : undefined,
    lastMessageAt:
      options?.lastMessageAt ??
      (lastMessageAt !== undefined
        ? new Date(lastMessageAt).toISOString()
        : tab.createdAt),
    lastMessageRole: chatLastMessageRole(tab),
    createdAt: tab.createdAt,
    // Live tabs in `chat-tabs.json` are never archived; archived
    // chats live in a separate `standalone-chat/{projectId}/history/`
    // tree projected through a different service. Surface `false`
    // here so the wire shape stays deterministic.
    archived: false,
    ...(options?.hasActiveChat !== undefined
      ? {
          hasActiveChat:
            options.hasActiveChat ||
            (workEntryId !== undefined &&
              getChatQueueService().isTurnActive({
                projectId,
                worktreeId: workEntryId,
                chatId: tab.id,
              })),
        }
      : {}),
    hasUnread: tab.unread === true,
    providerType,
    ...(options?.includeDelivery !== false &&
    (tab.providerType === 'opencode' || tab.model?.startsWith('opencode:'))
      ? {
          usage: {
            model: tab.model,
            opencodeReportedUsage: tab.usage?.opencodeReportedUsage ?? null,
          },
        }
      : {}),
    executionHarness: tab.executionHarness,
    // Projected composer state (CAN-1219) so the portal's standalone model
    // picker seeds from and reconciles against the desktop.
    model: tab.model,
    availableModels: isCanopyPortalActive()
      ? buildProjectedModelCatalog(undefined, {
          cursor: true,
          copilot: true,
          opencode: true,
          owner: options?.owner,
          agentDefaultModel: options?.agentDefaultModel,
        })
      : undefined,
    providerAvailability: peekPortalProviderAvailability(),
    pluginSelectionsDetail: normalizePluginSelections(tab.pluginSelections),
    deferredToolsAllowed:
      options?.deferredToolsAllowed ?? tab.deferredToolsAllowed,
    ...(workEntryId !== undefined
      ? {
          turnActive: getActiveSessionInfos(projectId, workEntryId).some(
            (session) => session.chatId === tab.id && session.turnActive,
          ),
        }
      : {}),
    ...(lastTurnEnd ? { lastTurnEnd } : {}),
    ...(options?.pendingQuestions !== undefined
      ? {
          pendingQuestions: projectPortalQuestionStates(
            tab.id,
            options.pendingQuestions,
          ),
        }
      : {}),
  };
}

function buildCompactStandaloneChatSummary(
  projectId: string,
  projectName: string,
  entry: WorkEntryChatSummaryListItem,
  chat: CoworkWorkEntryChatSummary,
  owner: WorkOwner | undefined,
  agentDefaultModel: string | undefined,
): PortalStandaloneChatSummary {
  const { pluginSelectionsDetail, ...summary } = buildStandaloneChatSummary(
    projectId,
    projectName,
    {
      id: chat.id,
      title: chat.title,
      customTitle: chat.customTitle,
      description: chat.description,
      createdAt: chat.createdAt,
      kind: 'chat',
      messages: [],
      providerType: chat.providerType,
      executionHarness: chat.executionHarness,
      model: chat.model,
      unread: chat.unread,
      pluginSelections: chat.pluginSelections,
    },
    {
      hasActiveChat: getActiveChatIds(projectId, entry.entryId).includes(
        chat.id,
      ),
      lastMessageAt: chat.lastMessageAt,
      workEntry: entry,
      includeDelivery: false,
      owner,
      agentDefaultModel,
    },
  );
  // Compact entries do not retain this policy. Omit the unknown value so a
  // Work Entry refresh cannot overwrite a policy verified from the full tab.
  delete summary.deferredToolsAllowed;
  // An unopened version 1 scope's summary can lack selections. They stay
  // unknown, never a verified empty set; opening the chat projects its tab.
  return chat.pluginSelections
    ? {
        ...summary,
        lastMessageRole: chat.lastMessageRole,
        pluginSelectionsDetail,
      }
    : { ...summary, lastMessageRole: chat.lastMessageRole };
}

/** The catalog Agent default for projected summaries; skipped with no Portal. */
function catalogAgentDefaultModel(
  projectId: string,
): Promise<string | undefined> {
  return isCanopyPortalActive()
    ? resolveCatalogAgentDefaultModel(projectId)
    : Promise.resolve(undefined);
}

function standaloneSummaryOwnerScope(
  projectId: string,
  entryId: string,
  chatId: string,
): AiCreditsScopeRequest {
  return { kind: 'work', projectId, worktreeId: entryId, chatId };
}

function resolveStandaloneSummaryOwner(
  projectId: string,
  entryId: string,
  chatId: string,
): Promise<WorkOwner | undefined> {
  return resolveAiCreditsScopeOwner(
    standaloneSummaryOwnerScope(projectId, entryId, chatId),
  );
}

export async function listStandaloneChats(options?: {
  strict?: boolean;
  /** Authorized visible parents for a complete Activity inventory. */
  projectIds?: readonly string[];
}): Promise<PortalStandaloneChatSummary[]> {
  const projects = await readStandaloneProjects(options?.strict);
  const summaries: PortalStandaloneChatSummary[] = [];
  const resolveOwner = createAiCreditsScopeOwnerResolver();
  // The desktop shell needs chat metadata, not transcript bodies. The Work
  // Entry registry's write-through summaries keep this startup projection
  // proportional to chat count rather than transcript bytes.
  for (const project of projects) {
    if (options?.projectIds && !options.projectIds.includes(project.id))
      continue;
    const entries = options?.strict
      ? await listWorkEntryChatSummaries(project.id, { strict: true })
      : await listWorkEntryChatSummaries(project.id);
    const agentDefaultModel = await catalogAgentDefaultModel(project.id);
    for (const entry of entries) {
      for (const chat of entry.chats) {
        const owner = await resolveOwner(
          standaloneSummaryOwnerScope(project.id, entry.entryId, chat.id),
        );
        summaries.push(
          await withLiveSessionQuestions(
            buildCompactStandaloneChatSummary(
              project.id,
              project.name,
              entry,
              chat,
              owner,
              agentDefaultModel,
            ),
          ),
        );
      }
    }
  }
  return summaries.sort((left, right) =>
    (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? ''),
  );
}

export function projectStandaloneChatSnapshot(
  chat: PortalStandaloneChatSummary,
): PortalSessionShellState['standaloneChats'][number] {
  return {
    localId: chat.chatId,
    queuedMessages: chat.queuedMessages,
    inputDelivery: chat.inputDelivery,
    steeringCapabilities: chat.steeringCapabilities,
    projectLocalId: chat.projectLocalId,
    title: chat.title,
    ...(chat.customTitle !== undefined
      ? { customTitle: chat.customTitle }
      : {}),
    modelLabel: chat.modelLabel,
    description: chat.description,
    workEntryId: chat.workEntryId,
    workEntryTitle: chat.workEntryTitle,
    workEntryCreatedAt: chat.workEntryCreatedAt,
    workEntryLastMessageAt: chat.workEntryLastMessageAt,
    workEntryLastTouchedAt: chat.workEntryLastTouchedAt,
    workEntryOrder: chat.workEntryOrder,
    workEntryPinned: chat.workEntryPinned,
    workEntryStatus: chat.workEntryStatus,
    workEntryNotificationSpaceId: chat.workEntryNotificationSpaceId,
    lastMessageAt: chat.lastMessageAt,
    lastMessageRole: chat.lastMessageRole,
    createdAt: chat.createdAt,
    archived: chat.archived,
    hasActiveChat: chat.hasActiveChat,
    hasUnread: chat.hasUnread,
    providerType: chat.providerType,
    executionHarness: chat.executionHarness,
    model: chat.model,
    ...(chat.usage !== undefined ? { usage: chat.usage } : {}),
    availableModels: chat.availableModels,
    providerAvailability: chat.providerAvailability,
    pluginSelectionsDetail: chat.pluginSelectionsDetail,
    deferredToolsAllowed: chat.deferredToolsAllowed,
    turnActive: chat.turnActive,
    ...(chat.lastTurnEnd !== undefined
      ? { lastTurnEnd: chat.lastTurnEnd }
      : {}),
    ...(chat.pendingQuestions !== undefined
      ? { pendingQuestions: chat.pendingQuestions }
      : {}),
  };
}

/**
 * Add one chat's AskUserQuestion state and latest turn end, read from its Work
 * Entry's tabs file. Registry summaries lack both, so only chats with a live session and a
 * snapshot that targets one chat pay for the read. A failed read throws:
 * cached payloads are replaced whole, so publishing without the questions
 * would erase one that is still awaited. Delta publishers skip that update,
 * and a snapshot fails so it can be retried.
 */
export async function withStandalonePendingQuestions(
  chat: PortalStandaloneChatSummary,
): Promise<PortalStandaloneChatSummary> {
  if (chat.workEntryId === undefined || chat.pendingQuestions !== undefined)
    return chat;
  const tabsFile = await readChatTabsFile(
    chat.projectLocalId,
    chat.workEntryId,
    { chatIds: [chat.chatId], pageOnly: true },
  );
  const tab = tabsFile.tabs.find((candidate) => candidate.id === chat.chatId);
  const lastTurnEnd = tab ? projectPortalLastTurnEnd(tab) : undefined;
  return {
    ...chat,
    ...(lastTurnEnd ? { lastTurnEnd } : {}),
    pendingQuestions: projectPortalQuestionStates(
      chat.chatId,
      tabsFile.pendingQuestions ?? [],
    ),
  };
}

/**
 * An awaited question lives in its chat's session, which pauses its turn
 * (`turnActive: false`) while it waits. So every summary of a chat with a
 * live session carries its questions: payloads replace cached ones whole, and
 * one without them would drop a question that is still awaited.
 */
async function withLiveSessionQuestions(
  chat: PortalStandaloneChatSummary,
): Promise<PortalStandaloneChatSummary> {
  const hasLiveSession =
    chat.workEntryId !== undefined &&
    getActiveSessionInfos(chat.projectLocalId, chat.workEntryId).some(
      (session) => session.chatId === chat.chatId,
    );
  return hasLiveSession ? withStandalonePendingQuestions(chat) : chat;
}

/**
 * Emit a `standalone_chat` entity delta for one chat so a connected portal
 * reconciles a composer flip (e.g. model change) live, mirroring the worktree
 * `projectWorktreeChatSummaries` path. No-op — and never touches disk — when no
 * portal session is connected. Best-effort: a read failure is swallowed so it
 * can never break the originating tab write. The entity shape matches the
 * snapshot builder's `standalone_chat` payload.
 */
export async function emitStandaloneChatSummary(
  workspaceId: string,
  entryId: string,
  chatId: string,
  resolvedOwner?: { value: WorkOwner | undefined },
): Promise<void> {
  if (!isCanopyPortalActive()) {
    return;
  }
  try {
    const projects = await readStandaloneProjects();
    const project = projects.find((entry) => entry.id === workspaceId);
    const tabsFile = await readChatTabsFile(workspaceId, entryId);
    const tab = tabsFile.tabs.find((candidate) => candidate.id === chatId);
    if (!tab) {
      return;
    }
    const entry = (await listWorkEntryChatSummaries(workspaceId)).find(
      (candidate) => candidate.entryId === entryId,
    );
    if (!entry) return;
    const owner = resolvedOwner
      ? resolvedOwner.value
      : await resolveStandaloneSummaryOwner(workspaceId, entryId, chatId);
    const agentDefaultModel = await catalogAgentDefaultModel(workspaceId);
    const deferredToolsAllowed = await resolveStandaloneDeferredToolsAllowed(
      tab.deferredToolsAllowed,
    );
    const summary = buildStandaloneChatSummary(
      workspaceId,
      project?.name ?? tab.title,
      tab,
      {
        hasActiveChat: getActiveChatIds(workspaceId, entryId).includes(chatId),
        deferredToolsAllowed,
        workEntry: entry,
        owner,
        agentDefaultModel,
        pendingQuestions: tabsFile.pendingQuestions ?? [],
      },
    );
    await emitStandaloneChatSummaryEntity(summary);
  } catch {
    // Projection is a best-effort mirror; the persisted tab write is durable.
  }
}

export async function emitStandaloneChatSummaryForTab(
  workspaceId: string,
  entryId: string,
  tab: PersistedChatTab,
  hasActiveChat: boolean,
  resolvedOwner?: { value: WorkOwner | undefined },
): Promise<void> {
  scheduleDesktopSessionSnapshotInvalidation();
  if (!isCanopyPortalActive()) return;
  try {
    const entry = (await listWorkEntryChatSummaries(workspaceId)).find(
      (candidate) => candidate.entryId === entryId,
    );
    if (!entry) return;
    const owner = resolvedOwner
      ? resolvedOwner.value
      : await resolveStandaloneSummaryOwner(workspaceId, entryId, tab.id);
    const agentDefaultModel = await catalogAgentDefaultModel(workspaceId);
    const deferredToolsAllowed = await resolveStandaloneDeferredToolsAllowed(
      tab.deferredToolsAllowed,
    );
    const active =
      hasActiveChat || getActiveChatIds(workspaceId, entryId).includes(tab.id);
    await emitStandaloneChatSummaryEntity(
      buildStandaloneChatSummary(workspaceId, tab.title, tab, {
        hasActiveChat: active,
        deferredToolsAllowed,
        workEntry: entry,
        owner,
        agentDefaultModel,
      }),
    );
  } catch {
    // A remote mirror must never fail the local chat mutation.
  }
}

/** Refresh all siblings together when the container title or primary chat changes. */
export async function emitStandaloneWorkEntrySummary(
  workspaceId: string,
  entryId: string,
  materialized?: {
    tabs: readonly PersistedChatTab[];
    pendingQuestions?: readonly PersistedPendingQuestion[];
  },
): Promise<void> {
  scheduleDesktopSessionSnapshotInvalidation();
  if (!isCanopyPortalActive()) return;
  try {
    const entry = (await listWorkEntryChatSummaries(workspaceId)).find(
      (candidate) => candidate.entryId === entryId,
    );
    if (!entry) return;
    const resolveOwner = createAiCreditsScopeOwnerResolver();
    const agentDefaultModel = await catalogAgentDefaultModel(workspaceId);
    for (const chat of entry.chats) {
      const owner = await resolveOwner(
        standaloneSummaryOwnerScope(workspaceId, entryId, chat.id),
      );
      const tab = materialized?.tabs.find(
        (candidate) => candidate.id === chat.id,
      );
      const deferredToolsAllowed = tab
        ? await resolveStandaloneDeferredToolsAllowed(tab.deferredToolsAllowed)
        : undefined;
      await emitStandaloneChatSummaryEntity(
        tab
          ? buildStandaloneChatSummary(workspaceId, entry.title, tab, {
              hasActiveChat: getActiveChatIds(workspaceId, entryId).includes(
                tab.id,
              ),
              deferredToolsAllowed,
              workEntry: entry,
              owner,
              agentDefaultModel,
              pendingQuestions: materialized?.pendingQuestions ?? [],
            })
          : buildCompactStandaloneChatSummary(
              workspaceId,
              entry.title,
              entry,
              chat,
              owner,
              agentDefaultModel,
            ),
      );
    }
  } catch {
    // The registry remains authoritative if remote projection fails.
  }
}

/**
 * Refresh every chat in a cowork workspace. A reorder rewrites every Work
 * Entry's registry index at once, so a single-entry refresh would leave the
 * siblings' `workEntryOrder` stale in the portal.
 */
export async function emitStandaloneWorkspaceWorkEntrySummaries(
  workspaceId: string,
): Promise<void> {
  scheduleDesktopSessionSnapshotInvalidation();
  if (!isCanopyPortalActive()) return;
  try {
    const resolveOwner = createAiCreditsScopeOwnerResolver();
    const agentDefaultModel = await catalogAgentDefaultModel(workspaceId);
    for (const entry of await listWorkEntryChatSummaries(workspaceId)) {
      for (const chat of entry.chats) {
        const owner = await resolveOwner(
          standaloneSummaryOwnerScope(workspaceId, entry.entryId, chat.id),
        );
        await emitStandaloneChatSummaryEntity(
          buildCompactStandaloneChatSummary(
            workspaceId,
            entry.title,
            entry,
            chat,
            owner,
            agentDefaultModel,
          ),
        );
      }
    }
  } catch {
    // The registry remains authoritative if remote projection fails.
  }
}

/** Explicit removals are necessary because remote delta projection is upsert-only. */
export function emitStandaloneChatRemovals(
  workspaceId: string,
  chatIds: readonly string[],
): void {
  scheduleDesktopSessionSnapshotInvalidation();
  if (!isCanopyPortalActive() || chatIds.length === 0) return;
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'standalone_chat',
      removed: chatIds.map((localId) => ({
        entityType: 'standalone_chat',
        localId,
        parentLocalId: workspaceId,
      })),
      generatedAt: new Date().toISOString(),
    }),
  );
}

async function emitStandaloneChatSummaryEntity(
  chat: PortalStandaloneChatSummary,
): Promise<void> {
  const summary = await withLiveSessionQuestions(chat);
  scheduleDesktopSessionSnapshotInvalidation();
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'standalone_chat',
      target: { standaloneChatLocalId: summary.chatId },
      entities: [
        {
          entityType: 'standalone_chat',
          localId: summary.chatId,
          parentLocalId: summary.projectLocalId,
          payload: {
            ...projectStandaloneChatSnapshot(summary),
            projectId: summary.projectId,
            chatId: summary.chatId,
          },
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
}

/**
 * Persist a model on a standalone/cowork chat tab WITHOUT sending a message
 * (`portal.standalone_chat.set_model`, CAN-1219), then re-project the summary so
 * the portal's standalone model picker reconciles. Rejects unknown model ids so
 * the ack never claims success for a model that never persists.
 */
export async function setStandaloneChatModel(
  payload: PortalStandaloneChatSetModelPayload,
  options: StandaloneChatServiceOptions = {},
): Promise<{ ok: true }> {
  validateId(payload.chatId, 'chatId');
  const knownModel = resolveKnownModel(payload.model);
  if (!knownModel) {
    throw new Error('model must be a known model id.');
  }
  const model = await pinInheritingAgentToDestination(
    knownModel,
    (await resolveStandaloneChatTarget(payload)).workspaceId,
  );
  if (
    getExecutionHarnessForModel(model) === 'copilot' &&
    !(await isCopilotRuntimeAvailable())
  )
    throw new Error('Connect Copilot in Settings > Labs.');
  if (getExecutionHarnessForModel(model) === 'opencode')
    await assertOpenCodeModelAvailable(model);
  if (getExecutionHarnessForModel(model) === 'cursor') {
    await assertCursorRuntimeForCowork();
  }
  const { workspaceId, entryId } = await resolveStandaloneChatTarget(payload);
  if (!entryId) {
    throw new Error('standalone chat not found.');
  }
  const workOwner = await resolveAiCreditsScopeOwner({
    kind: 'work',
    projectId: workspaceId,
    worktreeId: entryId,
    chatId: payload.chatId,
  });
  if (await isModelBlockedByStoredPolicy(model, workOwner)) {
    throw new Error('This model is blocked by your organization policy.');
  }
  const gatewayCheck = await checkModelGatewayRoute(model, workOwner);
  if (!gatewayCheck.ok) {
    throw new Error(gatewayCheck.message);
  }
  await enqueueChatTabMutation(workspaceId, entryId, async () => {
    const tabsFile = await readChatTabsFile(workspaceId, entryId);
    const existing = tabsFile.tabs.find((tab) => tab.id === payload.chatId);
    if (!existing) {
      throw new Error('standalone chat not found.');
    }
    const targetHarness = getExecutionHarnessForModel(model);
    if (!targetHarness) {
      throw new Error(
        `No execution harness is available for model "${model}".`,
      );
    }
    const capturedHarness = capturedExecutionHarnessForStandaloneTab(
      existing,
      workspaceId,
      entryId,
    );
    if (
      existing.model !== model &&
      capturedHarness !== undefined &&
      capturedHarness !== targetHarness
    ) {
      throw new Error(
        `Cannot change a started standalone chat from the "${capturedHarness}" execution harness to "${targetHarness}".`,
      );
    }
    // Keep the model/provider pair consistent: runtime resolution gives an
    // explicit provider precedence over the model's own provider. The same
    // canonical command as desktop model changes owns retaining and restoring
    // Codex speed, clearing foreign continuation state, and durable publication.
    const providerType =
      existing.model === model && existing.providerType
        ? existing.providerType
        : getProviderForModel(model);
    if (providerType === undefined) {
      throw new Error(`No provider is available for model "${model}".`);
    }
    const executionHarness = capturedHarness ?? targetHarness;
    const result = await getChatStateService().command({
      schemaVersion: 1,
      commandId: `standalone-model-${randomUUID()}`,
      projectId: workspaceId,
      worktreeId: entryId,
      command: {
        type: 'chat.set_model',
        tabId: payload.chatId,
        model,
        providerType,
        executionHarness,
      },
    });
    if (result.outcome !== 'applied' && result.outcome !== 'already_applied') {
      throw new Error(
        `Canonical model change was ${result.outcome}: ${result.reason ?? 'unknown reason'}`,
      );
    }
  });
  sendToWindow(
    options.getWindow?.() ?? null,
    IPC_CHANNELS.standaloneChatMetaUpdated,
    { projectId: workspaceId, chatId: payload.chatId },
  );
  await emitStandaloneChatSummary(workspaceId, entryId, payload.chatId);
  return { ok: true };
}

/**
 * Narrow a provider to the three `defaultChatModelByProvider` keys, defaulting
 * to `'claude'` — which is also what `dispatchWorktreeChatTurn` falls back to
 * when no provider and no model are supplied.
 */
/**
 * The model a cowork send would dispatch, plus whether it could be resolved at
 * all. Consumed by the Portal adapter's pre-send policy check
 * (`portal.standalone_chat.send`).
 *
 * This mirrors {@link sendStandaloneChatMessage}'s dispatch precedence exactly,
 * because judging anything else is a defect in one direction or the other:
 *
 *  1. `input.model` — an explicit pick; the tab is overwritten with it and it
 *     is what runs, so nothing else can execute.
 *  2. otherwise the model persisted on the chat tab — what the composer shows,
 *     and (since dispatch now passes `request.model ?? sentTab.model`) what
 *     actually runs. Mobile relies on this: it persists its pick through
 *     `set_model` and then sends neither `model` nor `providerType`.
 *  3. otherwise `defaultChatModelByProvider[provider]`, where the provider is
 *     `input.providerType` when the caller supplies one (the Portal adapter
 *     forwards the payload's field) and `'claude'` otherwise — the same
 *     fallback `dispatchWorktreeChatTurn` applies.
 *
 * A union of all three was tried and is wrong: it refuses a send that would
 * have run a PERMITTED model merely because some model the turn will never
 * reach is blocked. For a chat pinned to a permitted pick under an org that
 * blocks the default, that is a permanent outage with no client-side remedy.
 * "Refuse over substitute" is satisfied by the precedence itself — a chat
 * pinned to a now-blocked model is refused at step 2 rather than quietly
 * falling through to a different default.
 *
 * `readable: false` means the dispatched model is genuinely unknown — either
 * preferences could not be read, or they carried no concrete default for a
 * policed provider. Callers must not treat that as "no model":
 * `isModelBlockedByStoredPolicy(undefined)` answers `false`, so an unknown
 * model would otherwise run with no policy evaluation anywhere in the stack.
 *
 * Read-only and never throws. An unresolvable target contributes no PERSISTED
 * candidate — the provider default at step 3 is still judged, because that is
 * what the send would dispatch if it got that far.
 */
/** Account harnesses require an explicit model and never use a default lane. */
function accountHarnessFor(
  providerType: string | undefined,
  executionHarness: string | undefined,
): 'cursor' | 'copilot' | 'opencode' | undefined {
  if (
    executionHarness === 'cursor' ||
    executionHarness === 'copilot' ||
    executionHarness === 'opencode'
  )
    return executionHarness;
  if (
    providerType === 'cursor' ||
    providerType === 'copilot' ||
    providerType === 'opencode'
  )
    return providerType;
  return undefined;
}

/**
 * The model the live session for this chat holds, if that session is itself a
 * Cursor session. It is the model a model-less Cowork Cursor send runs on, so
 * it is what the policy preflight judges and what dispatch is handed. A live
 * Claude or Codex session's model is ignored here: pairing it with the Cursor
 * provider would start a Cursor session for another provider's model id.
 */
function resolveLiveAccountSessionModel(
  workspaceId: string,
  entryId: string,
  chatId: string,
  harness: 'cursor' | 'copilot' | 'opencode',
): ReturnType<typeof getSessionSelectedModel> {
  if (getSessionProviderType(workspaceId, entryId, chatId) !== harness)
    return undefined;
  return getSessionSelectedModel(workspaceId, entryId, chatId);
}

export async function resolveStandaloneChatPolicyModels(input: {
  projectId?: string;
  projectLocalId?: string;
  chatId: string;
  model?: string;
  providerType?: AgentProviderType;
}): Promise<{
  readable: boolean;
  models: string[];
  /**
   * Set when lane resolution found NO dispatchable model at all.
   *
   * Distinct from `readable: false`, which means "we could not read what would
   * dispatch". This one is a definite answer — nothing can run — and the send
   * must be refused for it REGARDLESS of whether an org policy is active. It
   * previously collapsed into `readable: false`: without a policy the send
   * proceeded, minted a durable Work Entry, persisted the user message and then
   * threw in dispatch (exactly the partial state this preflight exists to
   * prevent); with a policy it was refused as a policy read failure, which is
   * the wrong diagnosis.
   */
  noDispatchableModel?: {
    missing: 'billing-lane' | 'policy-allowance' | 'both';
  };
  /**
   * Set when the dispatched provider is Cursor and no concrete model exists.
   * Cursor bills to its own account and has no default lane, so there is
   * nothing the lane resolver could judge or run; asking it would substitute
   * a Claude default the send would never use. Every caller refuses with the
   * choose-a-Cursor-model message before writing anything.
   */
  cursorModelRequired?: true;
  copilotModelRequired?: true;
  opencodeModelRequired?: true;
}> {
  const models = new Set<string>();
  // Step 1. The tab is overwritten with this and dispatch runs it, so
  // neither the previous tab model nor any default can execute.
  let concreteModel: string | undefined = input.model;
  let persistedProvider: AgentProviderType | undefined;
  let persistedHarness: string | undefined;
  let liveTarget: { workspaceId: string; entryId: string } | undefined;
  let credentialWorkspaceId: string | undefined;
  try {
    const { workspaceId, entryId } = await resolveStandaloneChatTarget(input);
    credentialWorkspaceId = workspaceId;
    if (entryId) {
      liveTarget = { workspaceId, entryId };
      const tabsFile = await readChatTabsFile(workspaceId, entryId);
      const tab = tabsFile.tabs.find((entry) => entry.id === input.chatId);
      persistedHarness = tab?.executionHarness;
      // Step 2. Dispatch passes `request.model ?? sentTab.model`, so this is
      // the model that runs — judging it is judging the dispatched model,
      // and a chat pinned to a now-blocked model is refused here rather
      // than silently running a different default.
      concreteModel ??= tab?.model;
      // When no model is persisted a default runs. Dispatch passes
      // `request.providerType ?? sentTab.providerType`, so the tab's provider
      // selects that default when the caller named none.
      persistedProvider = tab?.providerType;
    }
  } catch {
    // An unresolvable target contributes no persisted candidate; the send
    // itself will fail on the same lookup with a real error message.
  }
  const credentialScope: LaneCredentialScope =
    credentialWorkspaceId === undefined
      ? GLOBAL_LANE_CREDENTIAL_SCOPE
      : // Mirrors the eventual session spawn, which resolves its Canopy
        // Environments credentials for this workspace.
        {
          workspaceId: credentialWorkspaceId,
          workOwnerSession: {
            projectId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: credentialWorkspaceId,
            chatId: input.chatId,
          },
        };
  // The same rule the send path applies: Cursor is the dispatched harness when
  // the caller's or the tab's provider is Cursor, or the tab's harness is.
  const accountHarness = accountHarnessFor(
    input.providerType ?? persistedProvider,
    persistedHarness,
  );
  if (concreteModel === undefined && accountHarness && liveTarget) {
    // A live Cursor session can hold a model the tab never persisted; it is
    // the model dispatch runs, so it is the model judged here.
    concreteModel = resolveLiveAccountSessionModel(
      liveTarget.workspaceId,
      liveTarget.entryId,
      input.chatId,
      accountHarness,
    );
  }
  if (concreteModel !== undefined) {
    models.add(concreteModel);
    // A concrete model is judged by ITS OWN lanes, never by the user's DEFAULT
    // lane. Running `resolveLaneAwareDefaultSelection` here answered the wrong
    // question in both directions — see
    // `resolveConcreteModelDispatchability`'s doc for the Ollama false refusal
    // and the cross-lane false pass. It is also the expensive question: the
    // default resolution probes both native providers, the credits context and
    // the whole policy surface, on every interactive cowork send.
    //
    // `readable` asks "do we know what would dispatch?". With a concrete model
    // we DO, so preferences are not consulted at all here — that file only
    // decides a default this send will not use. The model itself is still
    // judged by the caller's policy loop.
    const dispatchability = await resolveConcreteModelDispatchability(
      concreteModel,
      credentialScope,
    );
    if (dispatchability === 'no-billing-lane') {
      return {
        readable: false,
        models: Array.from(models),
        noDispatchableModel: { missing: 'billing-lane' },
      };
    }
    return { readable: true, models: Array.from(models) };
  }
  if (accountHarness) {
    return {
      readable: true,
      models: Array.from(models),
      ...(accountHarness === 'opencode'
        ? { opencodeModelRequired: true as const }
        : accountHarness === 'copilot'
          ? { copilotModelRequired: true as const }
          : { cursorModelRequired: true as const }),
    };
  }
  const preferences = await readPreferencesFile().catch(() => null);
  if (!preferences) {
    // No concrete model AND no preferences: the dispatched model is genuinely
    // unknown, which is exactly what `readable: false` means.
    return { readable: false, models: Array.from(models) };
  }
  // Step 3. Which default runs is decided by `dispatchWorktreeChatTurn` as
  // `options.providerType ?? (options.model ? getProviderForModel(...) :
  // 'claude')`, and `sendStandaloneChatMessage` now passes
  // `request.providerType ?? sentTab.providerType`. So the dispatched provider
  // is the caller's when supplied (the Portal adapter forwards the payload's
  // field; web sends it on cowork sends), else the tab's, else 'claude' —
  // and this mirrors that same chain.
  //
  // Exactly ONE provider is judged, the one that dispatches. Judging the tab's
  // provider default *in addition to* the caller's was tried and is wrong:
  // `ModelDefaultsByProvider.codex` is a required field, so a Codex default
  // always exists, and an org permitting only Claude blocks it — which
  // refused every send from any chat that had ever persisted
  // `providerType: 'codex'`, over a default that send would not run.
  //
  // Reached ONLY when no concrete model exists, so the default lane really is
  // what dispatch runs and asking about it is the right question. The
  // concrete-model branch above answers a different one — see there.
  const resolution = await resolveLaneAwareDefaultSelection(
    preferences,
    'chat',
    credentialScope,
    input.providerType ?? persistedProvider,
    undefined,
    // Forced to this chat's provider, so it answers a narrower question than
    // "what is the user's default model?" and must not stamp the projection.
    false,
  );
  if (resolution.outcome === 'no-dispatchable-model') {
    return {
      readable: false,
      models: Array.from(models),
      noDispatchableModel: { missing: resolution.missing },
    };
  }
  models.add(resolution.selection.model);
  return { readable: true, models: Array.from(models) };
}

export async function sendStandaloneChatMessage(
  request: StandaloneChatSendRequest,
  options: StandaloneChatServiceOptions = {},
): Promise<{
  ok: true;
  chatId: string;
  userMessageId: string;
  workEntryId?: string;
  /** Whether the message started its turn or waits behind the running one. */
  delivery: 'accepted' | 'queued';
}> {
  validateId(request.chatId, 'chatId');
  if (request.workEntryId !== undefined) {
    validateId(request.workEntryId, 'workEntryId');
  }
  if (
    request.providerType === 'cursor' ||
    request.executionHarness === 'cursor' ||
    (request.model && getExecutionHarnessForModel(request.model) === 'cursor')
  ) {
    await assertCursorRuntimeForCowork();
  }

  if (
    (request.providerType === 'copilot' ||
      request.executionHarness === 'copilot' ||
      (request.model &&
        getExecutionHarnessForModel(request.model) === 'copilot')) &&
    !(await isCopilotRuntimeAvailable())
  )
    throw new Error('Connect Copilot in Settings > Labs.');
  if (
    (request.providerType === 'opencode' ||
      request.executionHarness === 'opencode' ||
      (request.model &&
        getExecutionHarnessForModel(request.model) === 'opencode')) &&
    !(await isOpenCodeRuntimeAvailable())
  )
    throw new Error('Connect OpenCode in Settings > Labs.');
  const explicitProjectId = request.projectLocalId ?? request.projectId;
  if (explicitProjectId) {
    const explicitWorkspaceId = resolveCoworkWorkspaceId(
      validateStandaloneProjectId(explicitProjectId),
    );
    cancelTransientRetriesForWorkspaceChat(
      explicitWorkspaceId,
      request.chatId,
      'manual-send',
    );
    cancelTransientRetryForChat(
      {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: explicitWorkspaceId,
        chatId: request.chatId,
      },
      'manual-send',
    );
  } else {
    cancelTransientRetriesForChatId(request.chatId, 'manual-send');
  }
  const resolved = await resolveStandaloneChatTarget(request);
  if (resolved.isArchived) {
    throw new Error(
      'Archived standalone chats are read-only. Restore the chat before sending a message.',
    );
  }
  const workspaceId = resolved.workspaceId;
  if (
    request.workEntryId !== undefined &&
    resolved.entryId !== null &&
    resolved.entryId !== request.workEntryId
  ) {
    throw new Error('That chat belongs to a different work entry.');
  }
  // A brand-new chat gets its own work entry, reusing the chat id as the
  // entry id (the same convention migrated entries use), so the desktop
  // sidebar shows it as a fresh work area — unless the caller targeted an
  // existing entry for it.
  let entryId = resolved.entryId ?? request.workEntryId ?? request.chatId;
  return getChatStateService().runWithScopeActivity(
    { projectId: workspaceId, worktreeId: entryId },
    async () => {
      // Target resolution is the address-discovery read needed to identify the
      // lifecycle scope. Revalidate an existing target after admission so a
      // deletion that completed during discovery cannot be resurrected.
      if (resolved.entryId) {
        const current = await resolveWorkEntryForChat(
          workspaceId,
          request.chatId,
        );
        if (
          current.entryId !== resolved.entryId ||
          current.archivedInEntryId !== null
        ) {
          throw new Error(
            'The selected work entry is no longer available. Choose another work entry and try again.',
          );
        }
      }
      const { dispatchWorktreeChatTurn } =
        await import('../lib/worktree-chat-turn');
      // An explicitly targeted brand-new chat must land in a workspace that
      // still exists — otherwise a stale remote-control destination would
      // silently create work-entry data for a deleted workspace (CAN-1989).
      if (!resolved.entryId && explicitProjectId) {
        const projects = await readStandaloneProjects();
        if (!projects.some((project) => project.id === workspaceId)) {
          throw new Error(
            'The selected project is no longer available. Choose another project and try again.',
          );
        }
      }
      if (
        !resolved.entryId &&
        request.workEntryId !== undefined &&
        !(await listWorkEntryIds(workspaceId)).includes(request.workEntryId)
      ) {
        throw new Error(
          'The selected work entry is no longer available. Choose another work entry and try again.',
        );
      }
      const tabsBeforeSend = await readChatTabsFile(workspaceId, entryId);
      const existingTab = tabsBeforeSend.tabs.find(
        (tab) => tab.id === request.chatId,
      );
      // Settle the model, including one stored on the chat, before the policy
      // check and before anything is saved or queued.
      const sendModelPin = await resolveSendModelPin(
        workspaceId,
        existingTab?.model,
        request.model,
      );
      if (sendModelPin !== undefined) {
        request = {
          ...request,
          model: sendModelPin,
          providerType:
            getProviderForModel(sendModelPin) ?? request.providerType,
          executionHarness: getExecutionHarnessForModel(sendModelPin),
        };
      }
      const liveSession = existingTab
        ? getSession(workspaceId, entryId, request.chatId)
        : undefined;
      const dispatchedProviderType =
        request.providerType ?? existingTab?.providerType;
      const dispatchedExecutionHarness =
        request.executionHarness ?? existingTab?.executionHarness;
      const accountHarness = accountHarnessFor(
        dispatchedProviderType,
        dispatchedExecutionHarness,
      );
      // A live Cursor session can hold a model the tab never persisted. That
      // is the model the session runs, so when neither the request nor the
      // tab names one it is what dispatch runs and the policy check judges
      // (`resolveStandaloneChatPolicyModels` applies the same rule, so the
      // Portal adapter's preflight agrees with this send). A bare "a session
      // exists" exemption would instead let dispatch fall to the lane resolver
      // and replace the live session with a Claude one.
      const liveSessionModel =
        accountHarness && liveSession
          ? resolveLiveAccountSessionModel(
              workspaceId,
              entryId,
              request.chatId,
              accountHarness,
            )
          : undefined;
      const dispatchableModel =
        request.model ?? existingTab?.model ?? liveSessionModel;
      // Cursor has no default lane. A Cursor route with no model to run would
      // reach the lane resolver, which substitutes Claude on a native lane or
      // leaves `cursor` beside a gateway model that the session then rejects,
      // in both cases after the prompt was saved. Refuse before the Work Entry
      // and prompt are written, as the chat IPC does, and before the policy
      // check below so the user is told to choose a Cursor model rather than
      // hearing about a Claude default the send would never run.
      if (accountHarness && !dispatchableModel) {
        throw new Error(
          accountHarness === 'opencode'
            ? 'Choose an OpenCode model before sending.'
            : accountHarness === 'copilot'
              ? 'Choose a Copilot model to send with Copilot, or choose another model.'
              : 'Choose a Cursor model to send with Cursor, or choose another model.',
        );
      }
      if (accountHarness === 'opencode')
        await assertOpenCodeModelAvailable(dispatchableModel);
      if (accountHarness === 'copilot')
        await assertCopilotModelAvailable(dispatchableModel);
      // Re-check the policy HERE, at the durable-write boundary, not only in
      // the Portal adapter. Automations call this service directly without an
      // adapter preflight. Refusal must precede Work Entry creation and user
      // message persistence so a prompt that cannot run leaves no partial
      // durable state.
      const policy = await resolveStandaloneChatPolicyModels({
        ...(request.projectId === undefined
          ? {}
          : { projectId: request.projectId }),
        ...(request.projectLocalId === undefined
          ? {}
          : { projectLocalId: request.projectLocalId }),
        chatId: request.chatId,
        ...(dispatchableModel === undefined
          ? {}
          : { model: dispatchableModel }),
        ...(request.providerType === undefined
          ? {}
          : { providerType: request.providerType }),
      });
      const workOwner = await resolveAiCreditsScopeOwner({
        kind: 'work',
        projectId: workspaceId,
        worktreeId: entryId,
        chatId: request.chatId,
      });
      if (
        policy.cursorModelRequired ||
        policy.copilotModelRequired ||
        policy.opencodeModelRequired
      ) {
        // Reached only if the tab changed between the read above and the
        // resolver's own read; same refusal, same message.
        throw new Error(
          policy.opencodeModelRequired
            ? 'Choose an OpenCode model before sending.'
            : policy.copilotModelRequired
              ? 'Choose a Copilot model to send with Copilot, or choose another model.'
              : 'Choose a Cursor model to send with Cursor, or choose another model.',
        );
      }
      if (policy.noDispatchableModel) {
        throw new Error(
          policy.noDispatchableModel.missing === 'policy-allowance'
            ? 'Your organization policy allows no model that can run this message.'
            : 'No model is available to send this message. Add a billing source, then try again.',
        );
      }
      if (
        !policy.readable &&
        (await isOrgModelPolicyActiveForStoredAccount(workOwner))
      ) {
        throw new Error(
          'Your organization policy could not be applied to this message. Try again.',
        );
      }
      for (const candidate of policy.models) {
        if (await isModelBlockedByStoredPolicy(candidate, workOwner)) {
          throw new Error('This model is blocked by your organization policy.');
        }
      }
      if (
        existingTab?.providerType === 'cursor' ||
        existingTab?.executionHarness === 'cursor' ||
        (existingTab?.model &&
          getExecutionHarnessForModel(existingTab.model) === 'cursor') ||
        policy.models.some(
          (model) => getExecutionHarnessForModel(model) === 'cursor',
        )
      ) {
        await assertCursorRuntimeForCowork();
      }
      if (
        (existingTab?.providerType === 'copilot' ||
          existingTab?.executionHarness === 'copilot' ||
          policy.models.some(
            (model) => getExecutionHarnessForModel(model) === 'copilot',
          )) &&
        !(await isCopilotRuntimeAvailable())
      )
        throw new Error('Connect Copilot in Settings > Labs.');
      if (!resolved.entryId && request.workEntryId === undefined) {
        const createdEntry = await createWorkEntry(workspaceId, {
          sidebarItemGroupId: request.sidebarItemGroupId,
          id: entryId,
          createdAt: new Date().toISOString(),
        });
        // Explicit IDs suppress generic empty-entry reuse; the registry may
        // still return the same-ID row when this send is retried.
        entryId = createdEntry.entry.id;
      }
      cancelTransientRetryForChat(
        {
          projectId: workspaceId,
          worktreeId: entryId,
          chatId: request.chatId,
        },
        'manual-send',
      );
      if (!explicitProjectId) {
        cancelTransientRetryForChat(
          {
            projectId: STANDALONE_CHAT_PROJECT_ID,
            worktreeId: workspaceId,
            chatId: request.chatId,
          },
          'manual-send',
        );
      }
      const getWindow = options.getWindow ?? getNullWindow;
      const usageLimitBannerBeforeDispatch =
        capturePersistedUsageLimitBannerSnapshot(existingTab);
      const persistedDeferredToolsAllowed =
        request.deferredToolsAllowed ?? existingTab?.deferredToolsAllowed;
      const deferredToolsAllowed = await resolveStandaloneDeferredToolsAllowed(
        persistedDeferredToolsAllowed,
      );
      const approvalMode = await resolvePersistedApprovalMode(
        workspaceId,
        entryId,
        clampToLiveApprovalMode(
          workspaceId,
          entryId,
          request.chatId,
          request.approvalMode ?? existingTab?.approvalMode,
        ),
      );
      const startsNewTrackedChat =
        !existingTab ||
        existingTab.newChatStartedWatcherPending === true ||
        (existingTab.transcript?.messageCount ??
          existingTab.transcript?.committedMessageCount ??
          existingTab.messages.length) === 0;
      const newChatStartedAt = new Date().toISOString();
      const userMessageId = randomUUID();
      const queueTarget = {
        projectId: workspaceId,
        worktreeId: entryId,
        chatId: request.chatId,
      };
      const queue = getChatQueueService();
      if (
        existingTab &&
        (queue.isTurnActive(queueTarget) ||
          liveSession?.hasPendingSteeringInput?.() === true ||
          getActiveChatIds(workspaceId, entryId).includes(request.chatId))
      ) {
        await queue.submit(
          {
            ...queueTarget,
            userMessageId,
            text: request.message,
            fileReferences: request.fileReferences,
            inputMode: request.inputMode,
            model: dispatchableModel,
            providerType: request.providerType ?? existingTab.providerType,
            executionHarness:
              request.executionHarness ?? existingTab.executionHarness,
            modelConfig:
              request.modelConfig == null
                ? existingTab.modelConfig
                : mergeAgentModelConfig(
                    existingTab.modelConfig,
                    request.modelConfig,
                  ),
            thinkingLevel: request.thinkingLevel ?? existingTab.thinkingLevel,
            pluginSelections:
              request.pluginSelections ?? existingTab.pluginSelections,
            deferredToolsAllowed,
            planMode: request.planMode === true,
            approvalMode,
            sessionApprovalRules:
              request.sessionApprovalRules ?? existingTab.sessionApprovalRules,
            sdkSessionId: existingTab.sdkSessionId,
            globalInstructionsSnapshot: existingTab.globalInstructionsSnapshot,
            initiationSource: resolvePresentationSource(request, 'portal'),
            ...(request.agentSent ? { agentSent: request.agentSent } : {}),
          },
          'portal',
        );
        return {
          ok: true,
          chatId: request.chatId,
          userMessageId,
          workEntryId: entryId,
          delivery: 'queued',
        };
      }
      const now = Date.now();
      const userMessage: PersistedChatMessage = {
        id: userMessageId,
        role: 'user',
        timestamp: now,
        blocks: [
          ...(request.fileReferences?.length
            ? [
                {
                  type: 'file_references' as const,
                  references: request.fileReferences,
                },
              ]
            : []),
          { type: 'text', text: request.message },
        ],
        inputMode: request.inputMode ?? 'typed',
        ...(request.agentSent ? { agentSent: request.agentSent } : {}),
      };
      // No history lookup: `userMessageId` was minted above, so no existing
      // banner can match it, and `existingTab` is a metadata-only read whose
      // `messages` throws because this chat's transcript was not selected.
      const automationInfoMessage = buildAutomationInfoMessage(
        request,
        userMessageId,
      );
      const sentTab = await upsertStandaloneMessages({
        executionContext: options.executionContext,
        workspaceId,
        entryId,
        chatId: request.chatId,
        messages: automationInfoMessage
          ? [automationInfoMessage, userMessage]
          : [userMessage],
        model: request.model,
        providerType: request.providerType,
        executionHarness: request.executionHarness,
        modelConfig: request.modelConfig,
        thinkingLevel: request.thinkingLevel,
        planMode: request.planMode,
        pluginSelections: request.pluginSelections,
        deferredToolsAllowed,
        approvalMode,
        sessionApprovalRules:
          request.sessionApprovalRules ?? existingTab?.sessionApprovalRules,
        ...(startsNewTrackedChat
          ? { newChatStartedWatcherFiredAt: newChatStartedAt }
          : {}),
      });
      // Main-owned sends create their Work Entry and durable tab without going
      // through the renderer store. Nudge every desktop surface immediately so
      // the cowork sidebar sees the new entry, even when this workspace/chat is
      // not currently mounted.
      sendToWindow(getWindow(), IPC_CHANNELS.standaloneChatMetaUpdated, {
        projectId: workspaceId,
        chatId: request.chatId,
      });

      scheduleChatSummary({
        projectId: workspaceId,
        worktreeId: entryId,
        chatId: request.chatId,
        cwd: getCoworkWorkspaceRootDir(workspaceId),
        getWindow,
        standaloneChatProjectId: workspaceId,
        persistDescription: (description) =>
          persistStandaloneChatDescription({
            workspaceId,
            entryId,
            chatId: request.chatId,
            description,
          }),
      });

      const emitMessage = (message: PortalChatMessage): void => {
        enqueuePortalEvent(
          createPortalEvent('portal.chat.event', {
            scope: 'standalone',
            projectLocalId: workspaceId,
            projectId: workspaceId,
            workEntryId: entryId,
            chatId: request.chatId,
            message,
          }),
        );
      };
      emitMessage({
        messageId: userMessageId,
        chatId: request.chatId,
        role: 'user',
        promptSource: 'human',
        parts: [{ kind: 'prompt_source', data: { source: 'human' } }],
        status: 'complete',
        text: request.message,
        createdAtMs: now,
        ...(request.agentSent ? { agentSent: request.agentSent } : {}),
      });
      // Portal-initiated turns have no desktop renderer driving them, so this
      // path owns the turn timer: a streaming row at turn start (the browser's
      // "agent is working" signal) finalized — and persisted — on the terminal
      // event.
      let executionUserMessageId: string = userMessageId;
      let turnTimer = createPortalTurnTimer({
        chatId: request.chatId,
        userMessageId,
      });
      emitMessage(turnTimer.startMessage);
      // Native cowork keying: (workspaceId, workEntryId, chatId).
      sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
        projectId: workspaceId,
        worktreeId: entryId,
        chatId: request.chatId,
        data: {
          type: 'canopy_user_prompt',
          original_text: request.message,
          canopy_turn_user_message_id: userMessageId,
          canopy_persisted_messages: automationInfoMessage
            ? [automationInfoMessage, userMessage]
            : [userMessage],
        },
      });
      await emitStandaloneChatSummaryForTab(
        workspaceId,
        entryId,
        sentTab,
        true,
        { value: workOwner },
      );
      if (startsNewTrackedChat) {
        await notifyCanonicalChatStarted(
          {
            projectId: workspaceId,
            worktreeId: entryId,
            chatId: request.chatId,
          },
          userMessageId,
          newChatStartedAt,
        ).catch(() => undefined);
      }
      const acceptanceCleanupTasks: Promise<void>[] = [];
      try {
        const selectedTurnModel =
          request.model ?? sentTab.model ?? liveSessionModel;
        const selectedTurnProviderType = request.model
          ? request.providerType
          : sentTab.model
            ? undefined
            : (request.providerType ?? sentTab.providerType);
        const runtimeProviderType =
          selectedTurnProviderType ??
          (selectedTurnModel
            ? getProviderForModel(selectedTurnModel)
            : undefined) ??
          'claude';
        await dispatchWorktreeChatTurn({
          countsTowardSkillUsage:
            request.initiationSource === 'user' ||
            request.initiationSource === 'portal',
          projectId: workspaceId,
          worktreeId: entryId,
          ...(sentTab.executionContext !== undefined
            ? { executionContext: sentTab.executionContext }
            : {}),
          chatId: request.chatId,
          ...(sentTab.executionContext === undefined
            ? {}
            : { executionContext: sentTab.executionContext }),
          userMessageId,
          text: request.message,
          fileReferences: request.fileReferences,
          inputMode: request.inputMode,
          ...(request.agentSent ? { agentSent: request.agentSent } : {}),
          // Honor the chat's persisted selection when the caller names none.
          // `sentTab` is the tab AFTER the upsert, so this is exactly what the
          // composer shows. Without it, a cowork chat dispatched the provider
          // DEFAULT even though the user had picked a model — mobile persists its
          // pick via `set_model` and then sends neither `model` nor
          // `providerType`, so the picker never affected what actually ran.
          //
          // This also makes the policy preflight sound. The preflight judges the
          // tab's model, and judging something dispatch would not run is the same
          // over-refusal removed for the tab's provider default: a user who picked
          // a PERMITTED model would be refused because an unrelated default was
          // blocked. Now the judged model and the dispatched model are the same
          // value, resolved by the same precedence.
          model: selectedTurnModel,
          // The provider travels with whoever supplied the model, because
          // `resolveAgentModelRuntime` gives an explicit `providerType` precedence
          // over the model's own provider — so any mismatched pair starts a
          // session for one provider running another provider's model id.
          //   - caller supplied the model  -> caller's provider (its own pair)
          //   - tab supplied the model     -> none, derive it from that model
          //   - live Cursor session holds it -> that model, under the tab's
          //                                     provider (the tab never persisted one)
          //   - no model at all            -> a provider only selects the default
          // `setStandaloneChatModel` now keeps the tab's pair in sync, but
          // deriving here keeps tabs persisted before that fix correct too.
          providerType: selectedTurnProviderType,
          executionHarness: sentTab.executionHarness,
          modelConfig: sentTab.modelConfig,
          thinkingLevel: request.thinkingLevel,
          // Like the model above and worktree sends, a send that names no
          // selections runs on the ones saved for the chat.
          pluginSelections:
            request.pluginSelections ?? sentTab.pluginSelections,
          ...(request.packageOverlay
            ? { packageOverlay: request.packageOverlay }
            : {}),
          deferredToolsAllowed,
          planMode: request.planMode === true,
          approvalMode,
          sessionApprovalRules:
            request.sessionApprovalRules ?? existingTab?.sessionApprovalRules,
          initiationSource: resolvePresentationSource(request, 'portal'),
          getWindow,
          onBeforeChatEvent: async (event) => {
            const outcome =
              await getChatStateService().ingestProviderEventWithOutcome({
                projectId: event.projectId,
                worktreeId: event.worktreeId,
                chatId: event.chatId,
                data: event.data,
                mutationId: `${request.chatId}:${userMessageId}:provider:${event.sequenceNamespace}:${event.sequence}`,
                // The active session is authoritative after lane selection
                // (which may substitute another provider for a default).
                providerType:
                  getSessionProviderType(
                    event.projectId,
                    event.worktreeId,
                    event.chatId,
                  ) ?? runtimeProviderType,
                ...(event.turnUserMessageId
                  ? { turnUserMessageId: event.turnUserMessageId }
                  : {}),
                ...(event.onCommitQueued
                  ? { onCommitQueued: event.onCommitQueued }
                  : {}),
              });
            // Activity-only events carry no durable change but are live.
            return outcome !== 'not-applied';
          },
          onTurnAccepted: () => {
            const acceptedData = {
              type: CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
              canopy_turn_user_message_id: userMessageId,
            };
            const acceptedPromptTask = getChatStateService()
              .ingestProviderEvent({
                projectId: workspaceId,
                worktreeId: entryId,
                chatId: request.chatId,
                data: acceptedData,
                mutationId: `${request.chatId}:${userMessageId}:accepted`,
                ...(request.providerType
                  ? { providerType: request.providerType }
                  : {}),
                turnUserMessageId: userMessageId,
              })
              .then(() => {
                sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
                  projectId: workspaceId,
                  worktreeId: entryId,
                  chatId: request.chatId,
                  data: acceptedData,
                });
              })
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[standalone-chat-service] Failed to commit accepted turn state',
                  error,
                );
              });
            acceptanceCleanupTasks.push(acceptedPromptTask);
            const cleanupTask = Promise.all([
              clearPersistedUsageLimitBanner({
                projectId: workspaceId,
                worktreeId: entryId,
                chatId: request.chatId,
                expectedBannerState: usageLimitBannerBeforeDispatch,
              }),
              clearUsageLimitedChat({
                projectId: workspaceId,
                worktreeId: entryId,
                chatId: request.chatId,
              }),
            ])
              .then(() => undefined)
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[standalone-chat-service] Failed to clear accepted turn recovery state',
                  {
                    projectId: workspaceId,
                    worktreeId: entryId,
                    chatId: request.chatId,
                    error,
                  },
                );
              });
            acceptanceCleanupTasks.push(cleanupTask);
          },
          onChatEvent: (event) => {
            if (
              isRecordValue(event.data) &&
              event.data.type === 'canopy_input_delivery' &&
              event.data.phase === 'picked-up' &&
              event.data.startsTurn === true &&
              event.data.turnRootAccepted !== false &&
              typeof event.data.userMessageId === 'string'
            ) {
              executionUserMessageId = event.data.userMessageId;
              turnTimer = createPortalTurnTimer({
                chatId: request.chatId,
                userMessageId: executionUserMessageId,
              });
              emitMessage(turnTimer.startMessage);
            }
            const eventTimerUpdate = turnTimer.updateForEvent(event.data);
            if (eventTimerUpdate) {
              emitMessage(eventTimerUpdate);
            }
            const message = runtimeChatEventToPortalMessage({
              scope: 'standalone',
              chatId: event.chatId,
              data: event.data,
              fallbackMessageId: `${executionUserMessageId}:assistant`,
            });
            if (message) {
              // Canonical provider-event ingestion owns durable transcript
              // state. This display projection can truncate tool output and
              // must not overwrite canonical Cowork history or completed
              // timers during retries and automated continuations.
              emitMessage(message);
              const timerUpdate = turnTimer.updateForMessage(message);
              if (timerUpdate) {
                emitMessage(timerUpdate);
              }
            }
            // Live-emit only — never persisted. The desktop renderer mirrors this
            // turn and persists its OWN timer message; the browser dedupes the
            // overlap between this live row and the renderer's persisted one.
            const completedTimer = event.isTerminalEvent
              ? turnTimer.completeForEvent(event.data)
              : null;
            if (completedTimer) {
              emitMessage(completedTimer);
            }
            if (event.isTerminalEvent) {
              void emitStandaloneChatSummary(
                workspaceId,
                entryId,
                request.chatId,
                { value: workOwner },
              );
            }
          },
        });
        await Promise.all(acceptanceCleanupTasks);
      } catch (error: unknown) {
        await Promise.allSettled(acceptanceCleanupTasks);
        await emitStandaloneChatSummary(workspaceId, entryId, request.chatId, {
          value: workOwner,
        });
        // Dispatch resolves once the provider accepts the send, before the turn
        // ends. Only a rejected dispatch proves that no terminal event will
        // arrive; completing on every resolution lowers the portal timer while
        // the accepted turn is still running. Live-emit only — a rejected turn
        // should not mint a persisted timer artifact.
        const fallbackTimer = turnTimer.finalize();
        if (fallbackTimer) {
          emitMessage(fallbackTimer);
        }
        throw error;
      }
      return {
        ok: true,
        chatId: request.chatId,
        userMessageId,
        workEntryId: entryId,
        delivery: 'accepted',
      };
    },
  );
}

export async function cancelStandaloneChat(
  request: PortalStandaloneChatCancelPayload,
): Promise<{ ok: true }> {
  validateId(request.chatId, 'chatId');
  const explicitProjectId = request.projectLocalId ?? request.projectId;
  if (explicitProjectId) {
    const explicitWorkspaceId = resolveCoworkWorkspaceId(
      validateStandaloneProjectId(explicitProjectId),
    );
    cancelTransientRetriesForWorkspaceChat(
      explicitWorkspaceId,
      request.chatId,
      'stop',
    );
    cancelTransientRetryForChat(
      {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: explicitWorkspaceId,
        chatId: request.chatId,
      },
      'stop',
    );
  } else {
    cancelTransientRetriesForChatId(request.chatId, 'stop');
  }
  const { workspaceId, entryId } = await resolveStandaloneChatTarget(request);
  if (entryId) {
    cancelTransientRetryForChat(
      { projectId: workspaceId, worktreeId: entryId, chatId: request.chatId },
      'stop',
    );
  }
  if (!explicitProjectId) {
    cancelTransientRetryForChat(
      {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: workspaceId,
        chatId: request.chatId,
      },
      'stop',
    );
  }
  const legacyTarget = {
    projectId: STANDALONE_CHAT_PROJECT_ID,
    worktreeId: workspaceId,
    chatId: request.chatId,
  };
  const canonicalTarget = entryId
    ? { projectId: workspaceId, worktreeId: entryId, chatId: request.chatId }
    : undefined;
  const target =
    canonicalTarget &&
    (getSession(workspaceId, canonicalTarget.worktreeId, request.chatId) ||
      !getSession(
        legacyTarget.projectId,
        legacyTarget.worktreeId,
        legacyTarget.chatId,
      ))
      ? canonicalTarget
      : legacyTarget;
  // Lazy by design: chat-turn-cancel imports chat-state and chat-queue, which
  // participate in the standalone service graph. Deferring this reverse edge
  // breaks that initialization cycle; the packaged Electron main build
  // exercises this local import path.
  const { cancelChatTurn } = await import('../lib/chat-turn-cancel');
  await cancelChatTurn(target);
  getChatQueueService().onTurnTerminal(target, 'cancelled');
  const cancelledData = {
    type: 'result',
    is_error: false,
    result: 'Cancelled',
  };
  await getChatStateService().ingestProviderEvent({
    ...target,
    data: cancelledData,
    mutationId: `manual-cancellation:${request.chatId}:${randomUUID()}`,
  });
  enqueuePortalEvent(
    createPortalEvent('portal.chat.event', {
      scope: 'standalone',
      projectLocalId: workspaceId,
      projectId: workspaceId,
      workEntryId: entryId ?? target.worktreeId,
      chatId: request.chatId,
      message: {
        messageId: randomUUID(),
        chatId: request.chatId,
        role: 'assistant',
        status: 'cancelled',
        text: '',
        createdAtMs: Date.now(),
      },
    }),
  );
  return { ok: true };
}

export async function listStandaloneChatTranscript(input?: {
  chatId?: string;
  projectId?: string;
  projectLocalId?: string;
}): Promise<PortalChatMessage[]> {
  return (await getStandaloneChatTranscriptSeed(input)).messages;
}

export async function getStandaloneChatTranscriptSeed(input?: {
  chatId?: string;
  projectId?: string;
  projectLocalId?: string;
}): Promise<PortalChatTranscriptSeed> {
  if (!input?.chatId) return { messages: [], truncated: false };
  validateId(input.chatId, 'chatId');
  const { workspaceId, entryId } = await resolveStandaloneChatTarget(input);
  if (!entryId) return { messages: [], truncated: false };
  const tabsFile = await readChatTabsFile(workspaceId, entryId, {
    chatIds: [input.chatId],
    pageOnly: true,
  });
  const tab = tabsFile.tabs.find((candidate) => candidate.id === input.chatId);
  if (!tab) return { messages: [], truncated: false };
  // Hydrate delivery only when this chat is opened; shell startup uses compact metadata.
  await emitStandaloneChatSummaryForTab(
    workspaceId,
    entryId,
    tab,
    getActiveChatIds(workspaceId, entryId).includes(tab.id),
  );
  return limitPortalChatTranscriptForSeedWithMetadata(
    // Transcript-level projection so each turn's persisted timer row is
    // re-keyed onto the live wire timer id (`${userMessageId}:turn-timer`);
    // see `projectPersistedChatTranscript`.
    projectPersistedChatTranscript({
      scope: 'standalone',
      chatId: tab.id,
      messages: tab.messages,
      autoRoutedModels: tab.autoRoutedModels,
      turnEnds: tab.turnEnds,
      unacceptedTurnEnds: tab.unacceptedTurnEnds,
    }),
  );
}
