import { checkWatcherDeliveryIngress } from './active-chat-input';
import { assertUntrustedChatInput } from '../agent-messaging/untrusted-input';
import {
  revalidateAgentSenderRequest,
  agentSendTargetReadiness,
  withAgentSenderAuthority,
  isAgentSenderContextError,
  AgentSenderContextError,
} from '../agent-messaging/sender-context';
import {
  withLegacyChatMessageCommand,
  agentSendAcceptanceReceipt,
  reportAgentSendAccepted,
} from '../canopy-runtime/core-chat-message-command-adapter';
import {
  retainedTerminalAgentInput,
  settleTerminalAgentImports,
} from '../agent-messaging/terminal-input';
import { inputSettingsKey } from '@canopy/desktop-shared/chat-input-delivery';
import {
  isMcpActivationMessage,
  mcpActivationMessageId,
} from './mcp-activation-message';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import {
  clearOpenCodeForkPlanReview,
  prepareOpenCodeVisibleFork,
} from '@canopy/desktop-shared/lib/opencode-fork-context';
import type { ChatPlanReviewApproval } from '@canopy/protocol/portal';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  isAgentDelegationTranscript,
  type AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type {
  DelegationRun,
  DelegationRunItems,
} from '../lib/chat-delegation-log';
import { persistedDelegationSnapshot } from '../agents/delegation/card-persistence';
import { CHAT_CUSTOM_TITLE_MAX_LENGTH } from '@canopy/protocol';
import { validateQuestionControlAnswers } from '@canopy/protocol/portal';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  hasTrustedVisualToolUse,
  type VisualToolTarget,
} from './visual-tool-identity';
import { publishForeignChatActivity } from './foreign-activity-sources';
import type { AgentSession } from '../agents/types';
import { settleInputExecution } from './chat-input-delivery-state';
import { detachInputDelivery } from '@canopy/desktop-shared/chat-input-delivery';
import {
  recordProviderEventApplied,
  recordProviderEventIngested,
} from '@canopy/desktop-shared/node/work-counters';
import { searchTranscriptMessages } from '../lib/chat-transcript-search';
import type {
  ChatStateV2Backend as ChatStateV2BackendType,
  ChatStorageImportOptions,
} from './chat-state-v2-backend';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import { createHash, randomUUID } from 'node:crypto';
import { hasLiveDelegations } from '../agents/delegation/activity';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  mcpActivationRecordSchema,
  readMcpActivationRecord,
  type McpActivationRecord,
  type McpActivationScope,
} from '@canopy/protocol/mcp-servers';
import {
  ChatInputDeliveryCoordinator,
  type InputPickupObserver,
} from './chat-input-delivery-coordinator';
import { isInputLedger, type InputRow } from './chat-input-delivery-state';
import type { ChatInputDeliveryEvent } from '@canopy/protocol/portal';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  claudeResultErrorMessage,
  parseAgentTranscriptLines,
  setTranscriptModelResolver,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import type {
  ChatTranscriptPageRequest,
  ChatTranscriptSearchRequest,
  ChatTranscriptSearchResult,
  ChatToolOutputRequest,
  ChatToolOutputResponse,
  ChatVisualReadRequest,
  ChatVisualReadResponse,
  AgentModelConfig,
  ArchivedChatEntry,
  ArchivedChatsFile,
  ChatCommand,
  ChatCommandEnvelope,
  ChatCommandExecutionOptions,
  ChatCommandResult,
  ChatCoreMutation,
  ChatQueueOrigin,
  ChatQueueEditRequest,
  ChatRuntimeState,
  ChatSendMessageRequest,
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  ChatTabMetadataPatch,
  ChatTabsFile,
  ChangedFileInfo,
  McpQuestionAnswer,
  PersistedChatMessage,
  PersistedCommandReceipt,
  PortalChatSendIdentity,
  PortalChatSendReceiptProbe,
  PersistedHostQueuedMessage,
  PersistedChatTab,
  PersistedPendingQuestion,
  PlanExitRequestEvent,
  TurnDiffTreeRef,
} from '@canopy/desktop-shared/types';
import {
  chatAgentSent,
  type AgentSentInfo,
} from '@canopy/protocol/portal/external-agent-sender';
import {
  isRetiredPlanChatScope,
  RETIRED_PLAN_CHAT_MESSAGE,
} from '@canopy/desktop-shared/lib/retired-chat-scopes';
import type {
  TranscriptDescriptor,
  TranscriptPage,
} from '@canopy/agent-transcript/transcript-storage';
import type { PersistedVisualReference } from '@canopy/agent-transcript/types';
import {
  ChatStateV2Repository,
  type TranscriptPreviewOptions,
  type TranscriptPreviewRead,
} from './chat-state-v2-repository';
import {
  APP_ADVISOR_PROJECT_ID,
  CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE,
  CODE_REVIEW_CHAT_PROJECT_ID,
  getEffectiveModelContextWindow,
  getExecutionHarnessForModel,
  getChatHarnessOptions,
  getModelContextWindow,
  getModelDisplayName,
  getProviderForModel,
  isSetAutoArchiveRequestedEventData,
  isTerminalBackedInterfaceMode,
  normalizeAgentModelConfig,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  resolveKnownModel,
  resolveModelAlias,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import {
  createPersistedChatTab,
  createPersistedFileTab,
  mergePersistedMessagesById,
} from '@canopy/desktop-shared/persisted-chat-state';
import { normalizeOrgMemoryTurn } from '@canopy/desktop-shared/lib/org-memory';
import {
  persistedTabProvider,
  resolveTerminalDrivenChat,
} from '../lib/terminal-driven-chat';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { formatAskUserAnswers } from '@canopy/desktop-shared/lib/ask-user-answers';
import { resolveClaudeForkResumePoint } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import {
  canonicalizeAgentModelConfig,
  isCodexSpeed,
  readCodexSpeedRecord,
  withCodexSpeed,
} from '@canopy/desktop-shared/lib/codex-speed';
import {
  defineChatTabMetadataProperty,
  isSafeChatTabMetadataKey,
} from '@canopy/desktop-shared/chat-tab-metadata';
import { resolveRequest, rejectRequest } from '../mcp/pending-requests';
import { toArchivedChatSummary } from '../lib/chat-archives';
import {
  isAgentContinuationEvent,
  isCodexSubagentFollowupEvent,
  isCodexSubagentTerminalEvent,
  isPlanHandoffResult,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  isUserAbortResult,
} from '../lib/chat-turn-audit';
import { projectChatStateChanges } from './chat-state-projection';
import { notifyChatTabsMaterialized } from '../lib/chat-tabs';
import {
  isPersistedChatMessage,
  isPersistedChatTab,
} from '../lib/chat-tabs-reader';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import {
  buildPersistedTurnInterruptedMutations,
  closeOpenPersistedToolUses,
  closeOpenPersistedTurnTimers,
  settlePersistedForkMessages,
} from '../lib/persisted-chat-settle';
import {
  resolveTurnSuccession,
  succeedInterruptedTurns,
} from '../lib/chat-turn-succession';
import { turnMessages } from '../lib/chat-turn-messages';
import {
  recordedTurnEnd,
  withTurnEnd,
  withoutTurnEnd,
  type TurnEnds,
} from '../lib/chat-turn-ends';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { preserveSettledTurnTimers } from '../lib/settled-turn-timer-guard';
import { recordInterruptedChats } from '../lib/usage-limited-chats-registry';
import { installChatTranscriptRewriteDiagnosticSink } from './chat-transcript-rewrite-diagnostics';
import { isRealWorkspaceTarget } from '../lib/chat-targets';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { withWorkspaceTargetRuntimeStartReservation } from '../lib/workspace-target-exclusion';
// Type-only: erased at compile time, so it cannot create the import cycle
// the lazy `recordDiagnostic` default below deliberately avoids.
import type { SessionDiagnosticRecord } from '../observability/service';
import type {
  ChatReadSelection,
  TranscriptConsumeOptions,
} from './chat-state-v2-backend';
import type { CanonicalChatState } from './chat-state-reducer';
import { ChatScopeDeletingError } from './chat-scope-lifecycle';
import {
  chatSendAdmissionCheck,
  type ChatSendAdmissionCheck,
} from './chat-send-admission';
import {
  claimWorktreeGitSetup,
  type WorktreeGitSetupOutcome,
} from '../lib/worktree-git-setup';
import {
  beginChatTurnPreparation,
  type PendingChatTurnPreparation,
} from '../lib/chat-turn-preparation';
import {
  automationInfoMessageId,
  buildAutomationInfoMessage,
} from './automation-info-message';
import {
  ChatStateRevisionConflictError,
  type ChatScopeKey,
  type ChatStateCommit,
  type ChatStateStorageDiagnostic,
} from './chat-state-contracts';
import type { ChatQueuePersistenceMutation } from './chat-queue-service';
import {
  SHOW_VISUAL_TOOL_KEY,
  type StageVisualDocument,
  type VisualStagingSidecar,
  type VisualStagingTarget,
  type VisualToolIdentityResolver,
} from '../lib/chat-visual-contracts';

setTranscriptModelResolver({
  resolveModelAlias,
  resolveKnownModel,
  resolveRuntimeModel,
  getModelDisplayName,
  getModelContextWindow: (model, aiCreditsRouted) =>
    aiCreditsRouted
      ? getEffectiveModelContextWindow(model, true)
      : getModelContextWindow(model),
});

export interface ProviderEventInput extends ChatScopeKey {
  chatId: string;
  data: unknown;
  providerType?:
    | 'claude'
    | 'codex'
    | 'ollama'
    | 'cursor'
    | 'copilot'
    | 'opencode';
  mutationId?: string;
  source?: 'provider' | 'terminal';
  turnUserMessageId?: string;
  /**
   * Called once the event's commit holds its place in the scope's commit
   * order. Its producer may then submit its next event without waiting for
   * this commit to be durable (group commit); see
   * `lib/session-event-commit-pipeline.ts`.
   */
  onCommitQueued?: () => void;
}

/**
 * `applied` committed a canonical change. `activity-only` committed nothing
 * because the event only refreshed runtime activity, yet it is still a live
 * event for chat-event listeners. `not-applied` is a duplicate, stale-turn, or
 * other rejected event that must not be delivered.
 */
export type ChatTurnOutcome = 'pending' | 'completed' | 'failed' | 'cancelled';

export type ProviderEventIngestOutcome =
  | 'applied'
  | 'activity-only'
  | 'not-applied';

type ChatStateRepositoryPort = Pick<
  ChatStateV2Repository,
  keyof ChatStateV2Repository
>;

interface PlanReviewApprovalRecordRequest extends ChatScopeKey {
  chatId: string;
  planId: string;
  revisionNumber: number;
  approvedAt: string;
}

function matchesOpenCodePlanReview(
  tab: PersistedChatTab | undefined,
  runtime: ChatRuntimeState | undefined,
  approval: ChatPlanReviewApproval,
): boolean {
  return (
    tab !== undefined &&
    tab.kind !== 'file' &&
    tab.readOnly !== true &&
    tab.planMode === true &&
    tab.trackedPlanSource === 'opencode' &&
    tab.pendingPlanExitRequestId === approval.requestId &&
    tab.pendingPlanExit?.source === 'opencode' &&
    tab.trackedPlanId === approval.planId &&
    tab.latestRevisionNumber === approval.revisionNumber &&
    tab.trackedPlanReviewStatus === 'pending' &&
    persistedTabProvider(tab) === 'opencode' &&
    runtime?.activeTurn === undefined &&
    (runtime?.queuedMessageIds.length ?? 0) === 0 &&
    (runtime === undefined ||
      ![
        'queued',
        'starting',
        'streaming',
        'awaiting_input',
        'completing',
      ].includes(runtime.status))
  );
}

export interface ChatStateServiceOptions {
  withPlanReviewRevision?: <T>(
    request: PlanReviewApprovalRecordRequest,
    commit: () => Promise<T>,
  ) => Promise<{ accepted: false } | { accepted: true; result: T }>;
  approvePlanReview?: (
    request: PlanReviewApprovalRecordRequest,
  ) => Promise<boolean>;
  onInputPickup?: InputPickupObserver;
  inputSession?: (
    target: ChatScopeKey & { chatId: string },
  ) => Promise<AgentSession | undefined>;
  repository?: ChatStateRepositoryPort;
  now?: () => number;
  createId?: () => string;
  steer?: (request: ChatSendMessageRequest) => Promise<boolean>;
  dispatch?: (
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
  ) => Promise<void>;
  authorizeSend?: (
    target: ChatScopeKey & {
      tab: PersistedChatTab;
      allowTrustedTerminal?: boolean;
    },
  ) => Promise<void>;
  /**
   * The outcome of the scope's worktree Git setup that an admitted send's
   * turn waits for and ends with: one still running, or one that failed or
   * was cancelled before any send claimed it. Synchronous.
   */
  awaitWorktreeSetup?: (
    scope: ChatScopeKey,
  ) => Promise<WorktreeGitSetupOutcome> | undefined;
  notifyTurnTerminal?: (event: ChatTurnTerminalNotice) => Promise<void>;
  worktreeSetupQueue?: ChatWorktreeSetupQueue;
  /**
   * The route a send must carry, settled before anything is written: see
   * `resolveSendModelPin`.
   */
  resolveSendModel?: (
    target: ChatScopeKey,
    stored: string | undefined,
    requested: string | undefined,
  ) => Promise<string | undefined>;
  cleanupSession?: (target: ChatScopeKey & { chatId: string }) => Promise<void>;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  recordDiagnostic?: (record: SessionDiagnosticRecord) => void;
  /** Exact MCP-qualified Claude names; defaults empty (fail closed). */
  claudeToolNames?: ReadonlySet<string>;
  /** Exact Codex dynamic tool names; defaults empty (fail closed). */
  codexToolNames?: ReadonlySet<string>;
  /** Trusted Cursor session ledger lookup; absent by default (fail closed). */
  cursorToolUse?: (target: VisualToolTarget, toolUseId: string) => boolean;
}

/** Trusted host-only execution metadata that must never come from renderer input. */
export interface TrustedChatCommandExecutionOptions extends ChatCommandExecutionOptions {
  agentSent?: AgentSentInfo;
}

interface ScopeActivityLease {
  lifecycleKey: string;
  active: boolean;
}

/**
 * A delegated run whose child transcript lives in the chat's delegate log
 * commits only its card's persisted projection: the event becomes a card
 * patch with no items, so the parent transcript neither gains nor loses
 * child rows and its live-only progress is never committed. The event's
 * other consumers (live delivery, the observability sidecar) still see
 * everything it carries.
 */
function withCardOnlyDelegation(input: ProviderEventInput): ProviderEventInput {
  const data = input.data;
  if (
    !isRecord(data) ||
    data.type !== 'canopy_delegation' ||
    !isAgentDelegationTranscript(data.delegation) ||
    data.delegation.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG
  )
    return input;
  return {
    ...input,
    data: {
      ...data,
      delegation: {
        ...data.delegation,
        snapshot: persistedDelegationSnapshot(data.delegation.snapshot),
        transcriptMode: 'patch',
        transcript: [],
      },
    },
  };
}

type ArchiveChatBackend = Pick<
  ChatStateV2BackendType,
  'page' | 'toolOutput' | 'visual' | 'readDelegationItems'
>;

const ARCHIVE_BACKEND_CACHE_LIMIT = 16;
/** Longest a streaming chat's persisted runtime.lastActivityAt may lag. */
const PROVIDER_ACTIVITY_PERSIST_INTERVAL_MS = 10_000;
const EMPTY_SHOW_VISUAL_TOOL_NAMES: ReadonlySet<string> = new Set();

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === 'tool_result' &&
    value.isError !== true &&
    value.is_error !== true
  );
}

function hasSuccessfulToolResult(value: unknown): boolean {
  return Array.isArray(value) && value.some(isSuccessfulToolResult);
}

function cursorSnapshotHasToolResult(data: Record<string, unknown>): boolean {
  if (
    hasSuccessfulToolResult(data.content) ||
    hasSuccessfulToolResult(data.blocks)
  )
    return true;
  if (!isRecord(data.message)) return false;
  return (
    hasSuccessfulToolResult(data.message.content) ||
    hasSuccessfulToolResult(data.message.blocks)
  );
}

function cursorPatchHasToolResult(data: Record<string, unknown>): boolean {
  if (!Array.isArray(data.patches)) return false;
  return data.patches.some(
    (patch) => isRecord(patch) && isSuccessfulToolResult(patch.block),
  );
}

/** True only for native provider result events that can safely admit visuals. */
export function isNativeVisualToolResultEvent(event: {
  providerType?: string;
  source?: string;
  data: unknown;
}): boolean {
  if (event.source === 'terminal' || !isRecord(event.data)) return false;
  const data = event.data;
  if (
    data.type === 'claude_terminal_transcript_sync' ||
    data.type === 'result' ||
    data.type === 'error'
  )
    return false;
  if (event.providerType === 'claude' && data.type === 'user') {
    const message = isRecord(data.message) ? data.message : undefined;
    return (
      hasSuccessfulToolResult(message?.content) ||
      hasSuccessfulToolResult(data.content)
    );
  }
  if (event.providerType === 'codex' && data.type === 'codex') {
    if (!isRecord(data.event) || data.event.type !== 'item.completed')
      return false;
    const item = data.event.item;
    return (
      isRecord(item) &&
      item.type === 'dynamic_tool_call' &&
      item.success !== false &&
      item.status !== 'failed' &&
      item.status !== 'error'
    );
  }
  if (event.providerType !== 'cursor' && data.provider !== 'cursor')
    return false;
  if (data.type === 'canopy_assistant_patch')
    return cursorPatchHasToolResult(data);
  return data.type === 'assistant' && cursorSnapshotHasToolResult(data);
}

/** Resolves only an exact injected provider tool name; empty is fail-closed. */
export function createShowVisualToolKeyResolver(
  knownToolNames: ReadonlySet<string>,
): VisualToolIdentityResolver {
  return (call) =>
    call.toolName !== undefined && knownToolNames.has(call.toolName)
      ? SHOW_VISUAL_TOOL_KEY
      : undefined;
}

function visualResolverForEvent(
  input: ProviderEventInput,
  claudeToolNames: ReadonlySet<string>,
  codexToolNames: ReadonlySet<string>,
  cursorToolUse?: (target: VisualToolTarget, toolUseId: string) => boolean,
): VisualToolIdentityResolver {
  const data = isRecord(input.data) ? input.data : {};
  if (input.providerType === 'claude' && data.type === 'user')
    return createShowVisualToolKeyResolver(claudeToolNames);
  if (input.providerType === 'codex' && data.type === 'codex')
    return (call) =>
      call.codexCallId && call.toolName && codexToolNames.has(call.toolName)
        ? SHOW_VISUAL_TOOL_KEY
        : undefined;
  if (
    (input.providerType === 'cursor' ||
      (input.providerType === undefined && data.provider === 'cursor')) &&
    (data.type === 'canopy_assistant_patch' || data.type === 'assistant')
  ) {
    const target = {
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      chatId: input.chatId,
    };
    return (call) =>
      cursorToolUse?.(target, call.toolUseId)
        ? SHOW_VISUAL_TOOL_KEY
        : undefined;
  }
  return () => undefined;
}

/** Restores trusted prior refs and strips any ref supplied by parsed data. */
export function preserveProviderVisualReferences(
  previousMessages: readonly PersistedChatMessage[],
  reducedMessages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  const refsByMessageAndTool = new Map<
    string,
    Map<string, PersistedVisualReference>
  >();
  for (const message of previousMessages)
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.visualRef) continue;
      const refs =
        refsByMessageAndTool.get(message.id) ??
        new Map<string, PersistedVisualReference>();
      refs.set(block.toolUseId, block.visualRef);
      refsByMessageAndTool.set(message.id, refs);
    }
  return reducedMessages.map((message) => {
    let changed = false;
    const blocks = message.blocks.map((block) => {
      if (block.type !== 'tool_result') return block;
      const trustedRef = refsByMessageAndTool
        .get(message.id)
        ?.get(block.toolUseId);
      if (trustedRef) {
        if (block.visualRef === trustedRef) return block;
        changed = true;
        return { ...block, visualRef: trustedRef };
      }
      if (!block.visualRef) return block;
      const { visualRef: _untrusted, ...safe } = block;
      void _untrusted;
      changed = true;
      return safe;
    });
    return changed ? { ...message, blocks } : message;
  });
}

function initialChatTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const title = firstLine ?? 'New chat';
  return title.slice(0, 40) + (title.length > 40 ? '...' : '');
}

type CreateChatTabCommand = Extract<ChatCommand, { type: 'chat.create_tab' }>;

/**
 * Canonical write form of a caller-supplied model config: unsupported fields
 * are dropped, and any Codex speed is stored as the exact `speed` with its
 * derived `fastMode` (never `true` for Ultra fast).
 */
function canonicalModelConfig(
  config: AgentModelConfig | undefined,
): AgentModelConfig | undefined {
  const normalized = normalizeAgentModelConfig(config);
  return normalized ? canonicalizeAgentModelConfig(normalized) : undefined;
}

function canonicalModelConfigField(
  config: AgentModelConfig | undefined,
): Pick<PersistedChatTab, 'modelConfig'> {
  const modelConfig = canonicalModelConfig(config);
  return modelConfig ? { modelConfig } : {};
}

function persistedChatTabFromCreateCommand(
  command: CreateChatTabCommand,
  createdAt: string,
  projectId: string,
): PersistedChatTab {
  if (command.seedTab) assertUntrustedChatInput(command.seedTab);
  if (
    command.seedTab &&
    command.seedTab.id === command.tabId &&
    isPersistedChatTab(command.seedTab)
  ) {
    const seed = structuredClone(command.seedTab);
    const seedModelConfig = canonicalModelConfig(seed.modelConfig);
    if (seedModelConfig) seed.modelConfig = seedModelConfig;
    else delete seed.modelConfig;
    if (!isCodexSpeed(seed.retainedCodexSpeed)) delete seed.retainedCodexSpeed;
    delete seed.approvalMode;
    delete seed.sessionApprovalRules;
    delete seed.kind;
    delete seed.filePath;
    delete seed.fileViewMode;
    delete seed.fileDiffContext;
    return {
      ...seed,
      id: command.tabId,
      createdAt,
      ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
    };
  }
  return {
    ...createPersistedChatTab({
      id: command.tabId,
      createdAt,
      ...(command.title ? { title: command.title } : {}),
      ...(command.providerType ? { providerType: command.providerType } : {}),
      ...(command.model ? { model: command.model } : {}),
      ...(command.defaultStampModel
        ? { defaultStampModel: command.defaultStampModel }
        : {}),
      ...canonicalModelConfigField(command.modelConfig),
      ...(command.planMode ? { planMode: true } : {}),
      ...(command.proposalMode ? { proposalMode: command.proposalMode } : {}),
      ...(typeof command.deferredToolsAllowed === 'boolean'
        ? { deferredToolsAllowed: command.deferredToolsAllowed }
        : {}),
      ...(command.interfaceMode
        ? { interfaceMode: command.interfaceMode }
        : {}),
      ...(command.selectedRepoId
        ? { selectedRepoId: command.selectedRepoId }
        : {}),
    }),
    ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}),
    ...(command.pluginSelections
      ? { pluginSelections: command.pluginSelections }
      : {}),
    ...newChatPluginDefaultsStamp(projectId),
    ...(command.aiCreditsRouting
      ? { aiCreditsRouting: command.aiCreditsRouting }
      : {}),
    ...(typeof command.subscriptionBillingOverride === 'boolean'
      ? {
          subscriptionBillingOverride: command.subscriptionBillingOverride,
        }
      : {}),
  };
}

/**
 * The session rules a tab materialized for a trusted send starts with: only
 * the deny rules the send carries, which can only make it stricter. Grants
 * are never seeded onto a new tab.
 */
function trustedSendDenyRulesField(
  rules: ChatSendMessageRequest['sessionApprovalRules'],
): Pick<PersistedChatTab, 'sessionApprovalRules'> {
  const denies = (rules ?? []).filter((rule) => rule.behavior === 'deny');
  return denies.length > 0 ? { sessionApprovalRules: denies } : {};
}

/**
 * A title a send names its chat with: the name the chat keeps as its custom
 * title, ahead of any generated summary. Undefined when none is usable.
 */
function explicitChatTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, CHAT_CUSTOM_TITLE_MAX_LENGTH) : undefined;
}

function hasPlaceholderChatTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === '' || normalized === 'new chat';
}

function initialTitleChatKey(scope: ChatScopeKey, chatId: string): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, chatId]);
}

/** Nullable legacy fields and whitespace alone do not settle naming. */
export function isInitialChatTitleEligible(tab: {
  customTitle?: string | null;
  description?: string | null;
  title?: string | null;
  automaticTitleState?: 'pending' | 'closed';
  kind?: 'chat' | 'file';
  readOnly?: boolean;
}): boolean {
  return (
    tab.kind !== 'file' &&
    tab.readOnly !== true &&
    tab.automaticTitleState !== 'closed' &&
    !tab.customTitle?.trim() &&
    !tab.description?.trim() &&
    (tab.automaticTitleState === 'pending' ||
      hasPlaceholderChatTitle(tab.title ?? ''))
  );
}

function isEditablePersistedChatTab(
  tab: PersistedChatTab | undefined,
): boolean {
  return tab !== undefined && tab.kind !== 'file' && tab.readOnly !== true;
}

function rememberedEditableTabAfterClose(
  tabs: PersistedChatTab[],
  activeTabId: string,
  rememberedTabId: string | undefined,
): PersistedChatTab | undefined {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (isEditablePersistedChatTab(activeTab)) return activeTab;
  const rememberedTab = tabs.find((tab) => tab.id === rememberedTabId);
  if (isEditablePersistedChatTab(rememberedTab)) return rememberedTab;
  return tabs.slice().reverse().find(isEditablePersistedChatTab);
}

function tabWithSendModel(
  tab: PersistedChatTab,
  command: Extract<ChatCommand, { type: 'chat.send_message' }>,
): PersistedChatTab {
  if (command.model === undefined && command.providerType === undefined) {
    return tab;
  }
  const model = command.model ?? tab.model;
  const providerType =
    command.providerType ?? (model ? getProviderForModel(model) : undefined);
  if (model === tab.model && providerType === tab.providerType) {
    return tab;
  }
  const next = { ...tab, model, providerType };
  const currentHarness =
    tab.executionHarness ??
    (tab.model ? getExecutionHarnessForModel(tab.model) : undefined);
  const targetHarness = model ? getExecutionHarnessForModel(model) : undefined;
  const providerChanged = persistedTabProvider(tab) !== providerType;
  if (providerChanged) {
    delete next.modelConfig;
    delete next.thinkingLevel;
    delete next.codexFastModeEnabled;
    delete next.interfaceMode;
    delete next.executionHarness;
    delete next.executionHarnessExplicitlyChosen;
  }
  if (
    providerChanged ||
    (tab.model !== model &&
      currentHarness !== undefined &&
      targetHarness !== undefined &&
      currentHarness !== targetHarness)
  ) {
    delete next.sdkSessionId;
    delete next.globalInstructionsSnapshot;
    delete next.codexReconstructionSeedId;
    delete next.claudeForkSessionOnNextSend;
    delete next.claudeTerminal;
    delete next.executionHarness;
    delete next.executionHarnessExplicitlyChosen;
  }
  if (
    providerType === 'cursor' ||
    targetHarness === 'cursor' ||
    providerType === 'copilot' ||
    targetHarness === 'copilot'
  ) {
    delete next.aiCreditsRouting;
    delete next.subscriptionBillingOverride;
    delete next.billingExplicitlyChosen;
  }
  return next;
}

function terminalTranscriptTitle(
  data: Record<string, unknown>,
): string | undefined {
  if (
    data.type !== 'claude_terminal_transcript_sync' ||
    !Array.isArray(data.messages)
  ) {
    return undefined;
  }
  for (const candidate of data.messages) {
    if (!isPersistedChatMessage(candidate) || candidate.role !== 'user') {
      continue;
    }
    const text = candidate.blocks
      .filter(
        (
          block,
        ): block is Extract<
          (typeof candidate.blocks)[number],
          { type: 'text' }
        > => block.type === 'text',
      )
      .map((block) => block.text)
      .join('')
      .trim();
    if (text) return initialChatTitle(text);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringFieldIsValid(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function isChatInputDeliveryEvent(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChatInputDeliveryEvent {
  return (
    value.type === 'canopy_input_delivery' &&
    typeof value.attemptId === 'string' &&
    typeof value.generation === 'string' &&
    (value.provider === 'claude' || value.provider === 'codex') &&
    (value.phase === 'accepted' ||
      value.phase === 'picked-up' ||
      value.phase === 'withdrawn' ||
      value.phase === 'completed' ||
      value.phase === 'unknown') &&
    optionalStringFieldIsValid(value, 'providerTurnId') &&
    optionalStringFieldIsValid(value, 'itemId') &&
    optionalStringFieldIsValid(value, 'userMessageId') &&
    (value.startsTurn === undefined || typeof value.startsTurn === 'boolean') &&
    (value.turnRootAccepted === undefined ||
      typeof value.turnRootAccepted === 'boolean')
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isChangedFileInfo(value: unknown): value is ChangedFileInfo {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === 'string' &&
    typeof value.status === 'string' &&
    [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'unmerged',
      'type-changed',
      'untracked',
      'unknown',
    ].includes(value.status) &&
    typeof value.insertions === 'number' &&
    Number.isFinite(value.insertions) &&
    typeof value.deletions === 'number' &&
    Number.isFinite(value.deletions) &&
    isOptionalString(value.previousPath) &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.repoName)
  );
}

function isTurnDiffTreeRef(value: unknown): value is TurnDiffTreeRef {
  return (
    isRecord(value) &&
    typeof value.startTree === 'string' &&
    typeof value.endTree === 'string' &&
    isOptionalString(value.repoId) &&
    isOptionalString(value.startHeadCommitSha)
  );
}

/**
 * Scopes whose chat closes have never archived (mirrors the renderer's
 * `shouldArchiveChatTargetOnClose` complement): the synthetic plan-explore,
 * code-review, and pipeline-editor sentinels. Only these may hard-delete a
 * contentful chat through close mode `discard`.
 */
function isHardDeleteChatScope(projectId: string, worktreeId: string): boolean {
  return (
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    (projectId === PIPELINE_EDITOR_PROJECT_ID &&
      worktreeId === PIPELINE_EDITOR_WORKTREE_ID)
  );
}

function chatRuntimeHostKey(scope: ChatScopeKey, chatId: string): string {
  return `${scope.projectId}\u0000${scope.worktreeId}\u0000${chatId}`;
}

export interface ChatTurnTerminalNotice extends ChatScopeKey {
  chatId: string;
  userMessageId: string;
  outcome: 'cancelled' | 'failed';
  data: Record<string, unknown>;
}

/** The chat queue's hold on sends while a worktree's Git setup runs. */
export interface ChatWorktreeSetupQueue {
  hold(
    target: ChatScopeKey & { chatId: string },
    turnUserMessageId?: string,
  ): Promise<void>;
  release(
    target: ChatScopeKey & { chatId: string },
    options?: { firstUserMessageId?: string },
  ): Promise<void>;
  /**
   * Removes the sends queued behind the hold, whose setup ended `outcome`,
   * recording their ends in the commit that removes them.
   */
  takeHeld(
    target: ChatScopeKey & { chatId: string },
    outcome: 'cancelled' | 'failed',
  ): Promise<readonly ChatSendMessageRequest[]>;
}

type SendMessageCommand = Extract<
  ChatCommandEnvelope['command'],
  { type: 'chat.send_message' }
>;

interface HeldSend {
  readonly key: string;
  readonly scope: ChatScopeKey;
  readonly envelope: ChatCommandEnvelope;
  readonly command: SendMessageCommand;
  readonly revision: number;
  readonly timestamp: number;
  readonly startsNewTrackedChat: boolean;
  readonly admissionCheck: ChatSendAdmissionCheck | undefined;
  readonly preparation: PendingChatTurnPreparation | undefined;
  state: 'held' | 'dispatching' | 'settled';
}

interface SetupHold {
  readonly scope: ChatScopeKey;
  readonly chatId: string;
  acquired: Promise<void>;
  owner: HeldSend | undefined;
}

const UNFINISHED_RUNTIME_STATUSES: readonly string[] = [
  'queued',
  'starting',
  'streaming',
  'awaiting_input',
  'completing',
];

const WORKTREE_SETUP_FAILED = 'The worktree could not be set up.';

/**
 * The chat's turn ends after a runtime commit: a turn whose runtime settles
 * records how it ended, and a turn that runs again drops its record. A
 * settled runtime that stays settled records nothing, since a terminal
 * runtime no longer names the turn it settled.
 */
function settleTurnEnds(
  ends: TurnEnds | undefined,
  previous: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
  turnUserMessageId: string | undefined,
  endedAt: number,
): TurnEnds | undefined {
  if (UNFINISHED_RUNTIME_STATUSES.includes(next.status)) {
    return next.activeTurn
      ? withoutTurnEnd(ends, next.activeTurn.userMessageId)
      : ends;
  }
  const outcome =
    next.status === 'completed' ||
    next.status === 'failed' ||
    next.status === 'cancelled'
      ? next.status
      : undefined;
  if (!outcome || !turnUserMessageId) return ends;
  const settles =
    previous === undefined ||
    !['completed', 'failed', 'cancelled'].includes(previous.status) ||
    (previous.activeTurn?.userMessageId === turnUserMessageId &&
      previous.status !== outcome);
  return settles
    ? withTurnEnd(ends, turnUserMessageId, outcome, endedAt)
    : ends;
}

const UNACCEPTED_TURN_END_RETRIES = 8;

function recordUnacceptedTurnEnd(
  tab: PersistedChatTab,
  userMessageId: string,
  outcome: 'cancelled' | 'failed',
): ChatCoreMutation {
  return {
    type: 'tab.metadata_patched',
    tabId: tab.id,
    patch: {
      unacceptedTurnEnds: {
        ...tab.unacceptedTurnEnds,
        [userMessageId]: outcome,
      },
    },
  };
}

function closeUnacceptedTurnTimer(
  tab: PersistedChatTab,
  userMessageId: string,
  startedAt: number,
  completedAt: number,
): ChatCoreMutation[] {
  const promptIndex = tab.messages.findIndex(
    (message) => message.id === userMessageId,
  );
  if (promptIndex < 0) return [];
  const after = tab.messages.slice(promptIndex + 1);
  const nextPrompt = after.findIndex(isUserTurnBoundary);
  const turn = nextPrompt < 0 ? after : after.slice(0, nextPrompt);
  const timed = turn.filter((message) =>
    message.blocks.some((block) => block.type === 'turn_timer'),
  );
  if (timed.length === 0)
    return [
      {
        type: 'message.upserted',
        chatId: tab.id,
        afterMessageId: userMessageId,
        message: {
          id: `${userMessageId}-turn-timer`,
          role: 'system',
          timestamp: completedAt,
          blocks: [{ type: 'turn_timer', startedAt, completedAt }],
        },
      },
    ];
  return closeOpenPersistedTurnTimers(timed, completedAt)
    .filter((message, index) => message !== timed[index])
    .map((message) => ({
      type: 'message.upserted',
      chatId: tab.id,
      message,
    }));
}

interface UnacceptedTurnEnd {
  readonly userMessageId: string;
  readonly startedAt: number;
  readonly outcome: 'cancelled' | 'failed';
  readonly reason: string;
}

/**
 * Records, in order, how turns no provider accepted ended: on their chat
 * (`unacceptedTurnEnds`, which turnOutcome reports, and with the time they
 * ended among its `turnEnds`, so a chat's latest end can be ordered),
 * closing each turn's timer in the transcript, and, while no other turn runs
 * the chat, in the chat's runtime, which then describes the last of them. Returns the chat
 * mutations and the runtime they leave, `runtime` itself when it is kept.
 */
function recordUnacceptedTurnEnds(
  tab: PersistedChatTab,
  runtime: ChatRuntimeState | undefined,
  ends: readonly UnacceptedTurnEnd[],
  occurredAt: number,
): { mutations: ChatCoreMutation[]; runtime: ChatRuntimeState | undefined } {
  const unacceptedTurnEnds = { ...tab.unacceptedTurnEnds };
  let turnEnds = tab.turnEnds;
  const timers: ChatCoreMutation[] = [];
  let ended = runtime;
  for (const end of ends) {
    unacceptedTurnEnds[end.userMessageId] = end.outcome;
    // Keeps the last accepted end, which the chat's latest end is ordered
    // against.
    turnEnds = withTurnEnd(
      turnEnds,
      end.userMessageId,
      end.outcome,
      occurredAt,
      tab.lastAcceptedUserMessageId,
    );
    timers.push(
      ...closeUnacceptedTurnTimer(
        tab,
        end.userMessageId,
        end.startedAt,
        occurredAt,
      ),
    );
    if (
      ended !== undefined &&
      UNFINISHED_RUNTIME_STATUSES.includes(ended.status) &&
      ended.activeTurn?.userMessageId !== end.userMessageId
    )
      continue;
    ended = {
      status: end.outcome,
      queuedMessageIds: ended?.queuedMessageIds ?? [],
      ...(ended?.queuedMessages
        ? { queuedMessages: ended.queuedMessages }
        : {}),
      activeTurn: {
        userMessageId: end.userMessageId,
        startedAt: end.startedAt,
      },
      lastActivityAt: occurredAt,
      ...(end.outcome === 'failed'
        ? {
            error: {
              code: 'provider_error' as const,
              message: end.reason,
              retryable: true,
              occurredAt: new Date(occurredAt).toISOString(),
            },
          }
        : {}),
    };
  }
  return {
    mutations: [
      {
        type: 'tab.metadata_patched',
        tabId: tab.id,
        patch: { unacceptedTurnEnds, turnEnds },
      },
      ...timers,
    ],
    runtime: ended,
  };
}

function unacceptedTurnMutationId(
  target: { chatId: string; userMessageId: string },
  outcome: 'cancelled' | 'failed',
): string {
  return `${target.chatId}:${target.userMessageId}:unaccepted:${outcome}`;
}

/**
 * The user messages of a chat whose transcript position does not mark the
 * start of a turn yet: queued sends, and the queued send the chat queue is
 * `dispatching` until its provider accepts it, which the chat persists before
 * its prompt event moves it to its dispatch position; and sends that ended
 * before any provider accepted them.
 */
function provisionalTurnIds(
  state: CanonicalChatState,
  chatId: string,
  dispatching: string | undefined,
): ReadonlySet<string> {
  const tab =
    state.tabsFile.tabs.find((candidate) => candidate.id === chatId) ??
    state.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
  const runtime = state.runtimeByChatId[chatId];
  const ids = new Set<string>([
    ...Object.keys(tab?.unacceptedTurnEnds ?? {}),
    ...(runtime?.queuedMessageIds ?? []),
    ...(runtime?.queuedMessages ?? []).map(
      (message) => message.request.userMessageId,
    ),
  ]);
  if (
    dispatching !== undefined &&
    dispatching !== tab?.lastAcceptedUserMessageId
  ) {
    ids.add(dispatching);
  }
  return ids;
}

function admittedSendRequest(
  scope: ChatScopeKey,
  command: SendMessageCommand,
  canonical: PersistedChatTab,
  {
    startsNewTrackedChat,
    asyncAnswer,
  }: {
    startsNewTrackedChat: boolean;
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] };
  },
): ChatSendMessageRequest {
  const resumePointRequired =
    canonical.forkedFrom?.resumePointRequired === true &&
    canonical.sdkSessionId !== undefined &&
    canonical.claudeForkSessionOnNextSend === true;
  const claudeForkResumeAt =
    canonical.sdkSessionId &&
    canonical.claudeForkSessionOnNextSend &&
    resumePointRequired
      ? resolveClaudeForkResumePoint(
          canonical.messages,
          canonical.forkedFrom?.atMessageId,
        )
      : undefined;
  const safeSdkSessionId =
    canonical.sdkSessionId &&
    canonical.claudeForkSessionOnNextSend &&
    resumePointRequired &&
    !claudeForkResumeAt
      ? undefined
      : canonical.sdkSessionId;
  const claudeForkStartsFresh =
    Boolean(canonical.sdkSessionId) &&
    canonical.claudeForkSessionOnNextSend === true &&
    resumePointRequired &&
    !claudeForkResumeAt;
  return {
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
    chatId: command.chatId,
    userMessageId: command.userMessageId,
    ...(asyncAnswer
      ? {
          clientUserMessageId: `answer-${asyncAnswer.questionId}`,
          asyncQuestionId: asyncAnswer.questionId,
        }
      : {}),
    ...(command.agentSent ? { agentSent: command.agentSent } : {}),
    ...(command.agentSenderProvenance
      ? { agentSenderProvenance: command.agentSenderProvenance }
      : {}),
    ...(command.hiddenContext ? { hiddenContext: command.hiddenContext } : {}),
    ...(command.agentSendSetup
      ? { agentSendSetup: command.agentSendSetup }
      : {}),
    text: command.text,
    ...(command.fileReferences
      ? { fileReferences: command.fileReferences }
      : {}),
    ...(command.attachmentPaths
      ? { attachmentPaths: command.attachmentPaths }
      : {}),
    ...(command.attachmentPromptContexts
      ? { attachmentPromptContexts: command.attachmentPromptContexts }
      : {}),
    ...(command.inputMode ? { inputMode: command.inputMode } : {}),
    ...(canonical.executionHarness
      ? { executionHarness: canonical.executionHarness }
      : {}),
    ...(canonical.thinkingLevel
      ? { thinkingLevel: canonical.thinkingLevel }
      : {}),
    ...(canonical.codexFastModeEnabled !== undefined
      ? { codexFastModeEnabled: canonical.codexFastModeEnabled }
      : {}),
    ...(canonical.globalInstructionsSnapshot
      ? { globalInstructionsSnapshot: canonical.globalInstructionsSnapshot }
      : {}),
    ...(canonical.providerType ? { providerType: canonical.providerType } : {}),
    ...(canonical.model ? { model: canonical.model } : {}),
    // The canonical tab is the authority: a surface that entered Auto with
    // `chat.patch_tab_settings` (Remote Control) sends an ordinary message
    // with no mode on it, and that turn must still route.
    ...((command.modelSelectionMode ?? canonical.modelSelectionMode) === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(canonical.modelConfig ? { modelConfig: canonical.modelConfig } : {}),
    ...(canonical.pluginSelections
      ? { pluginSelections: canonical.pluginSelections }
      : {}),
    ...(typeof canonical.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: canonical.deferredToolsAllowed }
      : {}),
    ...(command.planReviewApproval
      ? { planMode: false }
      : canonical.planMode
        ? { planMode: true }
        : {}),
    ...(canonical.approvalMode ? { approvalMode: canonical.approvalMode } : {}),
    ...(canonical.sessionApprovalRules
      ? { sessionApprovalRules: canonical.sessionApprovalRules }
      : {}),
    ...(canonical.interfaceMode
      ? { interfaceMode: canonical.interfaceMode }
      : {}),
    ...(safeSdkSessionId ? { sdkSessionId: safeSdkSessionId } : {}),
    ...(canonical.codexReconstructionSeedId
      ? { codexReconstructionSeedId: canonical.codexReconstructionSeedId }
      : {}),
    ...(safeSdkSessionId && canonical.claudeForkSessionOnNextSend
      ? {
          claudeForkSession: true,
          ...(claudeForkResumeAt ? { claudeForkResumeAt } : {}),
        }
      : {}),
    ...(claudeForkStartsFresh ? { claudeForkStartsFresh: true } : {}),
    ...(canonical.selectedRepoId
      ? { selectedRepoId: canonical.selectedRepoId }
      : {}),
    ...(canonical.proposalMode
      ? { codexProposalMode: canonical.proposalMode }
      : {}),
    ...(canonical.aiCreditsRouting
      ? { aiCreditsRouting: canonical.aiCreditsRouting }
      : {}),
    ...(canonical.subscriptionBillingOverride
      ? { subscriptionBillingOverride: true }
      : {}),
    ...(startsNewTrackedChat ? { startsNewTrackedChat: true } : {}),
  };
}

/**
 * A refused start never runs; its agent acceptance row must not stay pending,
 * or watchers could bind to an input that never completes.
 */
function settleRefusedAgentInput(
  tab: PersistedChatTab | undefined,
  userMessageId: string,
  reason: string,
): ChatCoreMutation[] {
  const ledger = tab?.inputDelivery;
  if (
    !tab ||
    !isInputLedger(ledger) ||
    !ledger.rows.some(
      (row) =>
        row.id === userMessageId &&
        row.state === 'queued' &&
        row.payload.agentSenderProvenance !== undefined,
    )
  )
    return [];
  return [
    {
      type: 'tab.metadata_patched',
      tabId: tab.id,
      patch: {
        inputDelivery: {
          ...ledger,
          rows: ledger.rows.map((row) =>
            row.id === userMessageId
              ? {
                  ...row,
                  revision: row.revision + 1,
                  state: 'cancelled' as const,
                  reason,
                }
              : row,
          ),
        },
      },
    },
  ];
}

function awaitingSetupKey(
  scope: ChatScopeKey,
  message: { chatId: string; userMessageId: string },
): string {
  return `${chatRuntimeHostKey(scope, message.chatId)}\u0000${message.userMessageId}`;
}

function chatScopeLifecycleKey(scope: ChatScopeKey): string {
  return `${scope.projectId}\u0000${scope.worktreeId}`;
}

/** Commands that can start or continue a provider turn in a chat. */
function isTurnStartingCommand(command: ChatCommand): boolean {
  return (
    command.type === 'chat.send_message' ||
    command.type === 'chat.force_queued_message' ||
    command.type === 'chat.steer_queued_message' ||
    command.type === 'chat.input_delivery_action' ||
    command.type === 'chat.answer_question'
  );
}

/**
 * Commands a retired chat scope (a legacy plan chat) refuses: every turn
 * start plus the other commands that write user messages into a chat.
 * Closing, archiving and dismissing stay allowed so old chats can be cleaned
 * up.
 */
function isRetiredScopeRefusedCommand(command: ChatCommand): boolean {
  return (
    isTurnStartingCommand(command) ||
    command.type === 'chat.commit_terminal_initial_prompt' ||
    command.type === 'chat.fork_tab' ||
    command.type === 'chat.import_session'
  );
}

function commandResult(
  envelope: ChatCommandEnvelope,
  revision: number,
  outcome: ChatCommandResult['outcome'],
  details: Partial<
    Pick<ChatCommandResult, 'reason' | 'entityId' | 'messageId'>
  > = {},
): ChatCommandResult {
  return {
    commandId: envelope.commandId,
    revision,
    outcome,
    ...details,
  };
}

/**
 * Only mutations that can discard, replace, or reorder existing user state
 * reject a stale client revision. Idempotent metadata patches intentionally
 * commute with newer transcript/runtime commits; applying the envelope's
 * observed revision to those patches would make independent commands from one
 * interaction conflict with each other.
 */
function requiresExpectedRevision(command: ChatCommand): boolean {
  switch (command.type) {
    case 'chat.reorder_tabs':
    case 'chat.close_tab':
    case 'chat.close_tabs':
    case 'chat.archive_tab':
    case 'chat.restore_archive':
    case 'chat.edit_queued_message':
    case 'chat.cancel_queued_message':
    case 'chat.force_queued_message':
    case 'chat.answer_question':
    case 'chat.dismiss_question':
    case 'chat.reset_to_point':
      return true;
    default:
      return false;
  }
}

function expectedRevisionForCommand(
  envelope: ChatCommandEnvelope,
): number | undefined {
  // A remote view acknowledges a particular observed message. Unlike local
  // desired-state metadata patches, it must not clear output committed since
  // the portal adapter checked that message against its snapshot.
  if (
    envelope.origin === 'portal' &&
    envelope.command.type === 'chat.mark_read'
  ) {
    return envelope.expectedTabRevision ?? envelope.expectedRevision;
  }
  if (!requiresExpectedRevision(envelope.command)) return undefined;
  return envelope.expectedTabRevision ?? envelope.expectedRevision;
}

function expectedRevisionOption(
  envelope: ChatCommandEnvelope,
): { expectedRevision: number } | Record<string, never> {
  const expectedRevision = expectedRevisionForCommand(envelope);
  return expectedRevision === undefined ? {} : { expectedRevision };
}

function buildUserMessage(
  command:
    | ChatSendMessageRequest
    | Extract<
        ChatCommand,
        {
          type: 'chat.send_message' | 'chat.commit_terminal_initial_prompt';
        }
      >,
  timestamp: number,
): PersistedChatMessage {
  return {
    id: command.userMessageId,
    role: 'user',
    // A message an external MCP agent sent stays the person's own.
    userMessageSource:
      'agentSent' in command && chatAgentSent(command.agentSent)
        ? 'agent'
        : 'watcherFired' in command && command.watcherFired
          ? 'watcher'
          : 'initiationSource' in command && command.initiationSource === 'hook'
            ? 'hook'
            : 'human',
    ...('agentSent' in command && command.agentSent
      ? { agentSent: command.agentSent }
      : {}),
    timestamp,
    blocks: [
      ...(command.fileReferences?.length
        ? [
            {
              type: 'file_references' as const,
              references: command.fileReferences,
            },
          ]
        : []),
      { type: 'text' as const, text: command.text },
    ],
    ...(command.attachmentPaths?.length
      ? { attachmentPaths: command.attachmentPaths }
      : {}),
    ...(command.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: command.attachmentPromptContexts }
      : {}),
    ...(command.inputMode ? { inputMode: command.inputMode } : {}),
    ...('watcherFired' in command && command.watcherFired
      ? { watcherFired: command.watcherFired }
      : {}),
  };
}

function eventMutationId(input: ProviderEventInput): string {
  if (input.mutationId) return input.mutationId;
  return createHash('sha256')
    .update(input.projectId)
    .update('\u0000')
    .update(input.worktreeId)
    .update('\u0000')
    .update(input.chatId)
    .update('\u0000')
    .update(JSON.stringify(input.data))
    .digest('hex');
}

function transcriptState(
  tab: PersistedChatTab,
  runtime: ChatRuntimeState | undefined,
): TranscriptReducerState {
  return {
    messages: tab.messages,
    status:
      runtime?.status === 'failed'
        ? 'error'
        : runtime &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            )
          ? 'streaming'
          : 'idle',
    error: runtime?.error?.message ?? null,
    planMode: tab.planMode ?? false,
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.sdkSessionId ? { sdkSessionId: tab.sdkSessionId } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.usage ? { usage: tab.usage } : {}),
    ...(tab.agentUsage ? { agentUsage: tab.agentUsage } : {}),
    ...(tab.llmProviderUsageLimitBanner
      ? { llmProviderUsageLimitBanner: tab.llmProviderUsageLimitBanner }
      : {}),
  };
}

function mergePromptMessages(
  messages: readonly PersistedChatMessage[],
  data: Record<string, unknown>,
): PersistedChatMessage[] {
  const next = [...messages];
  const imported = Array.isArray(data.canopy_persisted_messages)
    ? data.canopy_persisted_messages
    : [];
  for (const candidate of imported) {
    if (!isPersistedChatMessage(candidate)) continue;
    const message = candidate;
    const index = next.findIndex((current) => current.id === message.id);
    if (index < 0) next.push(message);
    else {
      const answerBlock = next[index].blocks.find(
        (block) => block.type === 'text' && block.asyncQuestionAnswer,
      );
      next[index] =
        answerBlock?.type === 'text' && answerBlock.asyncQuestionAnswer
          ? {
              ...message,
              blocks: message.blocks.map((block) =>
                block.type === 'text'
                  ? {
                      ...block,
                      asyncQuestionAnswer: answerBlock.asyncQuestionAnswer,
                    }
                  : block,
              ),
            }
          : message;
    }
  }
  // Only a real user-prompt event establishes a new turn. Queued prompts and
  // answers may have been submitted during an earlier turn; move their boundary
  // to the actual dispatch position while retaining structured answer data.
  const promptIndex = next.findIndex(
    (message) => message.id === data.canopy_turn_user_message_id,
  );
  const prompt = next[promptIndex];
  if (
    prompt &&
    (promptIndex < next.length - 1 ||
      prompt.blocks.some(
        (block) =>
          block.type === 'text' &&
          block.asyncQuestionAnswer?.startsTurn === false,
      ))
  ) {
    next.splice(promptIndex, 1);
    next.push({
      ...prompt,
      blocks: prompt.blocks.map((block) =>
        block.type === 'text' && block.asyncQuestionAnswer
          ? {
              ...block,
              asyncQuestionAnswer: {
                ...block.asyncQuestionAnswer,
                startsTurn: true,
              },
            }
          : block,
      ),
    });
  }
  return next;
}

/**
 * Structural equality of persisted JSON data, independent of key order and
 * object prototypes; an undefined member is equivalent to an absent one.
 */
function isSamePersistedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => isSamePersistedValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(
    (key) => right[key] !== undefined,
  );
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => isSamePersistedValue(left[key], right[key]))
  );
}

/** Whether a provider runtime patch only advances a recent activity time. */
function isRecentActivityOnlyRuntime(
  current: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
  now: number,
): boolean {
  if (!current) return false;
  const { lastActivityAt: currentActivityAt, ...currentRest } = current;
  const { lastActivityAt: _nextActivityAt, ...nextRest } = next;
  void _nextActivityAt;
  return (
    isSamePersistedValue(currentRest, nextRest) &&
    now - (currentActivityAt ?? 0) < PROVIDER_ACTIVITY_PERSIST_INTERVAL_MS
  );
}

function runtimeForEvent(
  current: ChatRuntimeState | undefined,
  data: unknown,
  now: number,
  turnUserMessageId?: string,
  codexRootThreadId?: string,
  turnHasVisibleOutput?: boolean,
): ChatRuntimeState {
  const base: ChatRuntimeState = current ?? {
    status: 'idle',
    queuedMessageIds: [],
  };
  if (!isRecord(data)) return { ...base, lastActivityAt: now };
  const eventTurnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  const effectiveTurnUserMessageId =
    turnUserMessageId ?? eventTurnUserMessageId;
  const activeTurn =
    base.activeTurn ??
    (effectiveTurnUserMessageId
      ? { userMessageId: effectiveTurnUserMessageId, startedAt: now }
      : undefined);
  const settledTurnRevival =
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(base.status) &&
    isSettledProviderTurnRevival(data, turnUserMessageId);
  const buildEmptyCompletionRuntime = (): ChatRuntimeState | null => {
    if (!effectiveTurnUserMessageId || turnHasVisibleOutput !== false) {
      return null;
    }
    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : activeTurn?.sessionId;
    return {
      status: 'failed',
      activeTurn: {
        ...(activeTurn ?? {
          userMessageId: effectiveTurnUserMessageId,
          startedAt: now,
        }),
        ...(sessionId ? { sessionId } : {}),
      },
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
      error: {
        code: 'empty_completion',
        message:
          'The provider completed this turn without returning any output.',
        retryable: true,
        occurredAt: new Date(now).toISOString(),
      },
      emptyCompletionRecovery: {
        turnUserMessageId: effectiveTurnUserMessageId,
        detectedAt: now,
        automaticRetryAllowed: false,
      },
    };
  };
  const recoversEmptyCompletion =
    base.error?.code === 'empty_completion' &&
    base.emptyCompletionRecovery?.turnUserMessageId ===
      effectiveTurnUserMessageId &&
    !settledTurnRevival &&
    turnHasVisibleOutput === true;
  if (
    recoversEmptyCompletion &&
    !isRootTerminalChatEventData(data, codexRootThreadId)
  ) {
    return {
      status: 'completed',
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
    };
  }
  const retainsEmptyCompletion =
    base.error?.code === 'empty_completion' &&
    base.emptyCompletionRecovery?.turnUserMessageId ===
      effectiveTurnUserMessageId &&
    !settledTurnRevival &&
    turnHasVisibleOutput === false;
  if (
    retainsEmptyCompletion &&
    !isRootTerminalChatEventData(data, codexRootThreadId)
  ) {
    return { ...base, lastActivityAt: now };
  }
  if (data.type === 'codex' && isRecord(data.event)) {
    const eventType = data.event.type;
    const item = isRecord(data.event.item) ? data.event.item : undefined;
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        base.status,
      ) &&
      isCodexSubagentFollowupEvent(data, codexRootThreadId)
    ) {
      return { ...base, lastActivityAt: now };
    }
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        base.status,
      ) &&
      (eventType === 'item.started' ||
        eventType === 'item.updated' ||
        eventType === 'item.completed') &&
      item?.type === 'agent_message' &&
      item.delivery === 'async'
    ) {
      return { ...base, lastActivityAt: now };
    }
    if (eventType === 'turn.started') {
      return {
        ...base,
        status: 'streaming',
        ...(activeTurn ? { activeTurn } : {}),
        lastActivityAt: now,
      };
    }
    if (
      eventType === 'turn.completed' &&
      !isCodexSubagentTerminalEvent(data, codexRootThreadId)
    ) {
      // A stop can tear the session down before its terminal result, so the
      // interrupted completion itself must settle the turn as cancelled.
      if (data.event.status === 'interrupted') {
        return {
          status: 'cancelled',
          queuedMessageIds: base.queuedMessageIds,
          ...(base.queuedMessages
            ? { queuedMessages: base.queuedMessages }
            : {}),
          lastActivityAt: now,
        };
      }
      return (
        buildEmptyCompletionRuntime() ?? {
          status: 'completed',
          queuedMessageIds: base.queuedMessageIds,
          ...(base.queuedMessages
            ? { queuedMessages: base.queuedMessages }
            : {}),
          lastActivityAt: now,
        }
      );
    }
    if (
      (eventType === 'turn.failed' || eventType === 'error') &&
      !isCodexSubagentTerminalEvent(data, codexRootThreadId)
    ) {
      return {
        status: 'failed',
        queuedMessageIds: base.queuedMessageIds,
        ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
        lastActivityAt: now,
        error: {
          code: 'provider_error',
          message:
            typeof data.event.message === 'string'
              ? data.event.message
              : 'Codex turn failed',
          retryable: true,
          occurredAt: new Date(now).toISOString(),
        },
      };
    }
    return {
      ...base,
      status: 'streaming',
      ...(activeTurn ? { activeTurn } : {}),
      lastActivityAt: now,
    };
  }
  if (isRootTerminalChatEventData(data, codexRootThreadId)) {
    // A plan handed to review ends its turn by an abort, which may leave no
    // visible output; the turn still did its work.
    const planHandoff = isPlanHandoffResult(data);
    const cancelled =
      !planHandoff &&
      (isUserAbortResult(data) ||
        (data.type === 'result' &&
          typeof data.result === 'string' &&
          /^(?:(?:turn )?cancel(?:l)?ed|interrupted by user|aborted by user|session aborted|session ended)$/i.test(
            data.result.trim(),
          )));
    const failed =
      !planHandoff &&
      !cancelled &&
      (data.type === 'error' ||
        (data.type === 'result' && data.is_error === true));
    if (!planHandoff && !cancelled && !failed) {
      const emptyCompletionRuntime = buildEmptyCompletionRuntime();
      if (emptyCompletionRuntime) return emptyCompletionRuntime;
    }
    return {
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      lastActivityAt: now,
      ...(failed
        ? {
            error: {
              code: 'provider_error' as const,
              message:
                typeof data.error === 'string'
                  ? data.error
                  : data.type === 'result'
                    ? claudeResultErrorMessage(data)
                    : 'Provider turn failed',
              retryable: true,
              occurredAt: new Date(now).toISOString(),
            },
          }
        : {}),
    };
  }
  if (data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE) {
    // Every dispatch commits its prompt (`starting`) before the host records
    // acceptance, so a turn that is already completed, failed or cancelled
    // here ended while its prompt was being handed over: the provider failed
    // to start (an MCP proxy port held by another instance, a spawn or
    // authentication failure) or Stop won the race. Acceptance is host
    // bookkeeping, not provider activity, and must not reopen that turn as a
    // live one nothing will ever settle. An `interrupted` turn (restart
    // recovery) can still be redispatched under its original prompt.
    if (['completed', 'failed', 'cancelled'].includes(base.status)) {
      return { ...base, lastActivityAt: now };
    }
    return {
      ...base,
      status: 'streaming',
      ...(activeTurn ? { activeTurn } : {}),
      lastActivityAt: now,
    };
  }
  if (data.type === 'canopy_user_prompt') {
    const promptTurn =
      turnUserMessageId && base.activeTurn?.userMessageId !== turnUserMessageId
        ? { userMessageId: turnUserMessageId, startedAt: now }
        : activeTurn;
    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id
        : promptTurn?.sessionId;
    return {
      status: 'starting',
      queuedMessageIds: base.queuedMessageIds,
      ...(base.queuedMessages ? { queuedMessages: base.queuedMessages } : {}),
      ...(base.steeringCapabilities
        ? { steeringCapabilities: base.steeringCapabilities }
        : {}),
      ...(promptTurn
        ? {
            activeTurn: {
              ...promptTurn,
              ...(sessionId ? { sessionId } : {}),
            },
          }
        : {}),
      lastActivityAt: now,
    };
  }
  if (
    canFollowSettledProviderTurn(
      data,
      turnUserMessageId,
      base.activeTurn?.userMessageId,
      codexRootThreadId,
    ) ||
    (['completed', 'failed', 'cancelled', 'interrupted'].includes(
      base.status,
    ) &&
      !settledTurnRevival)
  ) {
    return { ...base, lastActivityAt: now };
  }
  const sessionId =
    typeof data.session_id === 'string'
      ? data.session_id
      : activeTurn?.sessionId;
  const {
    error: _settledError,
    emptyCompletionRecovery: _emptyCompletionRecovery,
    ...activeBase
  } = base;
  void _settledError;
  void _emptyCompletionRecovery;
  return {
    ...activeBase,
    status: 'streaming',
    ...(activeTurn
      ? { activeTurn: { ...activeTurn, ...(sessionId ? { sessionId } : {}) } }
      : {}),
    lastActivityAt: now,
  };
}

function hasVisibleTurnOutput(
  messages: PersistedChatMessage[],
  turnUserMessageId: string,
  turnDiff: NonNullable<PersistedChatTab['turnDiffs']>[string] | undefined,
): boolean {
  const userIndex = messages.findIndex(
    (message) => message.id === turnUserMessageId && message.role === 'user',
  );
  if (userIndex < 0) return true;
  if (turnDiff && turnDiff.files.length > 0) return true;

  return messages.slice(userIndex + 1).some((message) => {
    if (message.role !== 'user' && (message.attachmentPaths?.length ?? 0) > 0) {
      return true;
    }
    return message.blocks.some((block) => {
      switch (block.type) {
        case 'text':
        case 'thinking':
          return message.role !== 'user' && block.text.trim().length > 0;
        case 'tool_result':
        case 'codex_agent_call':
          return true;
        case 'file_references':
          return message.role !== 'user' && block.references.length > 0;
        case 'image':
          return (
            message.role !== 'user' &&
            (block.path.length > 0 || Boolean(block.dataUrl))
          );
        default:
          return false;
      }
    });
  });
}

function applyTrustedEventMetadata(
  tab: PersistedChatTab,
  data: Record<string, unknown>,
  now: number,
): PersistedChatTab {
  if (data.canopy_fork_model_context === 'fresh' && tab.forkedFrom) {
    return {
      ...tab,
      forkedFrom: { ...tab.forkedFrom, modelContext: 'fresh' },
    };
  }
  if (
    data.type === 'org_memory_used' &&
    data.localChatId === tab.id &&
    typeof data.localMessageId === 'string' &&
    tab.messages.some(
      (message) =>
        message.id === data.localMessageId && message.role === 'user',
    )
  ) {
    const memory = normalizeOrgMemoryTurn(data);
    if (memory) {
      return {
        ...tab,
        memoryByMessageId: {
          ...tab.memoryByMessageId,
          [data.localMessageId]: memory,
        },
      };
    }
  }
  if (data.type === 'claude_terminal_transcript_sync') {
    tab = settleTerminalAgentImports(
      tab,
      Array.isArray(data.messages)
        ? data.messages.filter(isPersistedChatMessage)
        : [],
      now,
    );
    const settingsSync = isRecord(data.settingsSync) ? data.settingsSync : {};
    const model =
      typeof settingsSync.model === 'string' && settingsSync.model.length > 0
        ? settingsSync.model
        : undefined;
    const turnDiffs = readTerminalTurnDiffs(data.turnDiffs);
    return {
      ...tab,
      ...(model ? { model, providerType: 'claude' as const } : {}),
      ...(typeof settingsSync.planMode === 'boolean'
        ? { planMode: settingsSync.planMode }
        : {}),
      ...(turnDiffs ? { turnDiffs: { ...tab.turnDiffs, ...turnDiffs } } : {}),
    };
  }
  if (
    data.type === 'turn_diff' &&
    typeof data.userMessageId === 'string' &&
    Array.isArray(data.files) &&
    data.files.every(isChangedFileInfo) &&
    typeof data.totalInsertions === 'number' &&
    typeof data.totalDeletions === 'number' &&
    typeof data.capturedAt === 'number'
  ) {
    return {
      ...tab,
      turnDiffs: {
        ...tab.turnDiffs,
        [data.userMessageId]: {
          files: data.files,
          totalInsertions: data.totalInsertions,
          totalDeletions: data.totalDeletions,
          capturedAt: data.capturedAt,
          ...(Array.isArray(data.treeRefs) &&
          data.treeRefs.every(isTurnDiffTreeRef)
            ? { treeRefs: data.treeRefs }
            : {}),
        },
      },
    };
  }
  if (isSetAutoArchiveRequestedEventData(data)) {
    return {
      ...tab,
      autoArchive: data.enabled ? true : undefined,
    };
  }
  if (data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE) {
    const acceptedId =
      typeof data.canopy_turn_user_message_id === 'string'
        ? data.canopy_turn_user_message_id
        : undefined;
    const acceptedTab: PersistedChatTab = {
      ...tab,
      ...(acceptedId ? { lastAcceptedUserMessageId: acceptedId } : {}),
    };
    if (isInputLedger(tab.inputDelivery)) {
      acceptedTab.inputDelivery = {
        ...tab.inputDelivery,
        rows: tab.inputDelivery.rows.map((row) =>
          row.id === data.canopy_turn_user_message_id &&
          row.payload.agentSenderProvenance
            ? { ...row, state: 'picked-up', revision: row.revision + 1 }
            : row,
        ),
      };
    }
    if (acceptedId && tab.unacceptedTurnEnds?.[acceptedId]) {
      const ends = { ...tab.unacceptedTurnEnds };
      delete ends[acceptedId];
      if (Object.keys(ends).length > 0) acceptedTab.unacceptedTurnEnds = ends;
      else delete acceptedTab.unacceptedTurnEnds;
    }
    delete acceptedTab.llmProviderUsageLimitBanner;
    delete acceptedTab.dismissedLlmProviderUsageLimitBannerKey;
    delete acceptedTab.claudeUsageLimitBanner;
    delete acceptedTab.dismissedClaudeUsageLimitBannerKey;
    const consumedIds = new Set(
      Array.isArray(data.canopy_consumed_pending_system_instruction_ids)
        ? data.canopy_consumed_pending_system_instruction_ids.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    );
    if (consumedIds.size === 0 || !tab.pendingSystemInstructions?.length) {
      return acceptedTab;
    }
    const pendingSystemInstructions = tab.pendingSystemInstructions.filter(
      (instruction) => !consumedIds.has(instruction.id),
    );
    return {
      ...acceptedTab,
      pendingSystemInstructions:
        pendingSystemInstructions.length > 0
          ? pendingSystemInstructions
          : undefined,
    };
  }
  return tab;
}

const NON_METADATA_TAB_KEYS = new Set([
  'id',
  'messages',
  'createdAt',
  'kind',
  'filePath',
]);

/**
 * Build the smallest canonical mutation for provider-owned tab metadata.
 * Provider reduction intentionally carries the existing transcript alongside
 * metadata, but journaling that whole tab turns every usage/session update
 * into an O(transcript) record. Missing optional fields are encoded as null so
 * replay removes them rather than retaining stale metadata.
 */
function buildTabMetadataPatch(
  current: PersistedChatTab,
  next: PersistedChatTab,
): ChatTabMetadataPatch {
  const patch: ChatTabMetadataPatch = {};
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of Array.from(keys)) {
    if (!isSafeChatTabMetadataKey(key) || NON_METADATA_TAB_KEYS.has(key)) {
      continue;
    }
    const currentValue: unknown = Reflect.get(current, key);
    const nextValue: unknown = Reflect.get(next, key);
    if (isDeepStrictEqual(currentValue, nextValue)) continue;
    defineChatTabMetadataProperty(
      patch,
      key,
      nextValue === undefined ? null : nextValue,
    );
  }
  return patch;
}

function canFollowSettledProviderTurn(
  data: Record<string, unknown>,
  turnUserMessageId?: string,
  activeTurnUserMessageId?: string,
  codexRootThreadId?: string,
): boolean {
  return (
    data.type === 'canopy_delegation' ||
    data.type === 'turn_diff' ||
    data.type === 'claude_terminal_transcript_sync' ||
    data.type === 'org_memory_used' ||
    data.type === 'canopy_org_memory_used' ||
    isCodexSubagentFollowupEvent(data, codexRootThreadId) ||
    (data.type === 'system' &&
      data.subtype === 'init' &&
      data.canopy_turn_revival === true &&
      (typeof data.canopy_turn_user_message_id !== 'string' ||
        (data.canopy_turn_user_message_id === turnUserMessageId &&
          (activeTurnUserMessageId === undefined ||
            data.canopy_turn_user_message_id === activeTurnUserMessageId)))) ||
    isSetAutoArchiveRequestedEventData(data)
  );
}

function shouldResumeAutoArchivedChat(data: Record<string, unknown>): boolean {
  return (
    data.type === 'canopy_user_prompt' ||
    data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
    isAgentContinuationEvent(data) ||
    (data.type === 'system' &&
      data.subtype === 'init' &&
      data.canopy_turn_revival === true)
  );
}

function isSettledProviderTurnRevival(
  data: Record<string, unknown>,
  turnUserMessageId?: string,
): boolean {
  const eventTurnUserMessageId =
    typeof data.canopy_turn_user_message_id === 'string'
      ? data.canopy_turn_user_message_id
      : undefined;
  return (
    (data.canopy_turn_revival === true &&
      (eventTurnUserMessageId === undefined ||
        turnUserMessageId === undefined ||
        eventTurnUserMessageId === turnUserMessageId)) ||
    (eventTurnUserMessageId === undefined && isAgentContinuationEvent(data))
  );
}

function readTerminalTurnDiffs(value: unknown): PersistedChatTab['turnDiffs'] {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<PersistedChatTab['turnDiffs']> = {};
  for (const [userMessageId, candidate] of Object.entries(value)) {
    if (
      !isRecord(candidate) ||
      !Array.isArray(candidate.files) ||
      !candidate.files.every(isChangedFileInfo) ||
      typeof candidate.totalInsertions !== 'number' ||
      typeof candidate.totalDeletions !== 'number' ||
      typeof candidate.capturedAt !== 'number'
    ) {
      continue;
    }
    result[userMessageId] = {
      files: candidate.files,
      totalInsertions: candidate.totalInsertions,
      totalDeletions: candidate.totalDeletions,
      capturedAt: candidate.capturedAt,
      ...(Array.isArray(candidate.treeRefs) &&
      candidate.treeRefs.every(isTurnDiffTreeRef)
        ? { treeRefs: candidate.treeRefs }
        : {}),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function countTurns(tab: PersistedChatTab): number {
  if (tab.transcript?.userMessageCount !== undefined)
    return tab.transcript.userMessageCount;
  return tab.messages.filter((message) => message.role === 'user').length;
}

/** The session-events record of a scope storage diagnostic. */
export function storageSessionDiagnostic(
  diagnostic: ChatStateStorageDiagnostic,
): SessionDiagnosticRecord {
  return {
    version: 1,
    timestamp: diagnostic.occurredAt,
    kind: 'chat_storage_diagnostic',
    sessionKey: `${diagnostic.projectId}/${diagnostic.worktreeId}/`,
    projectId: diagnostic.projectId,
    worktreeId: diagnostic.worktreeId,
    chatId: '',
    providerType: 'unknown',
    chatStorageKind: diagnostic.kind,
    chatStorageAuthority: diagnostic.storageAuthority,
    chatStorageJournalBytes: diagnostic.journalBytes,
    chatStorageRecordBytes: diagnostic.recordBytes,
    chatStorageRecordCount: diagnostic.recordCount,
    chatStorageMaxRecordBytes: diagnostic.maxRecordBytes,
    chatStorageMeanRecordBytes: diagnostic.meanRecordBytes,
    chatStorageCheckpointDurationMs: diagnostic.checkpointDurationMs,
    chatStorageCheckpointAbortCount: diagnostic.checkpointAbortCount,
    ...(diagnostic.journalTailReason
      ? { chatStorageJournalTailReason: diagnostic.journalTailReason }
      : {}),
    ...(diagnostic.maintenanceReason
      ? { chatStorageMaintenanceReason: diagnostic.maintenanceReason }
      : {}),
    ...(diagnostic.journalQuarantineFile
      ? { chatStorageJournalQuarantineFile: diagnostic.journalQuarantineFile }
      : {}),
    ...(diagnostic.revisionGap
      ? {
          chatStorageGapExpectedRevision:
            diagnostic.revisionGap.expectedRevision,
          chatStorageGapFoundRevision: diagnostic.revisionGap.foundRevision,
          chatStorageGapNewestRevision: diagnostic.revisionGap.newestRevision,
          chatStorageGapTabsRevision: diagnostic.revisionGap.tabsRevision,
          chatStorageGapArchiveRevision: diagnostic.revisionGap.archiveRevision,
          chatStorageGapStaleComponent: diagnostic.revisionGap.staleComponent,
          chatStorageGapSkippedMutationCount:
            diagnostic.revisionGap.skippedMutationCount,
        }
      : {}),
  };
}

function matchesPortalSendReceipt(
  receipt: PersistedCommandReceipt,
  identity: PortalChatSendIdentity,
): boolean {
  return (
    receipt.outcome === 'applied' &&
    receipt.entityId === identity.chatId &&
    receipt.messageId === identity.userMessageId &&
    receipt.portalSend?.chatId === identity.chatId &&
    receipt.portalSend.userMessageId === identity.userMessageId &&
    receipt.portalSend.fingerprint === identity.fingerprint
  );
}

class ChatSendAuthorizationRevokedError extends Error {
  public constructor(
    message = 'The paired session no longer authorizes this send.',
  ) {
    super(message);
  }
}

export class ChatStateService implements ChatStateCommandPort {
  public readonly inputDelivery: ChatInputDeliveryCoordinator;
  private readonly repository: ChatStateRepositoryPort;
  private readonly nativeClaimRollback = new WeakMap<
    ChatSendMessageRequest,
    { row: InputRow; revision: number }
  >();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly steer: (request: ChatSendMessageRequest) => Promise<boolean>;
  private readonly dispatch: (
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
  ) => Promise<void>;
  private readonly withPlanReviewRevision: NonNullable<
    ChatStateServiceOptions['withPlanReviewRevision']
  >;
  private readonly approvePlanReview: (
    request: PlanReviewApprovalRecordRequest,
  ) => Promise<boolean>;
  private readonly authorizeSend: (
    target: ChatScopeKey & {
      tab: PersistedChatTab;
      allowTrustedTerminal?: boolean;
    },
  ) => Promise<void>;
  private readonly awaitWorktreeSetup: (
    scope: ChatScopeKey,
  ) => Promise<WorktreeGitSetupOutcome> | undefined;
  private readonly notifyTurnTerminal: (
    event: ChatTurnTerminalNotice,
  ) => Promise<void>;
  private readonly worktreeSetupQueue: ChatWorktreeSetupQueue;
  private readonly resolveSendModel: NonNullable<
    ChatStateServiceOptions['resolveSendModel']
  >;
  private readonly cleanupSession: (
    target: ChatScopeKey & { chatId: string },
  ) => Promise<void>;
  private readonly schedule: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly reconcileHostRuntime: boolean;
  /**
   * Chats whose initial naming is settled: ineligible and not `pending`
   * (closed, a saved custom title or description, a file or read-only tab,
   * or a legacy meaningful title). Settled chats never become eligible again,
   * so later sends skip the canonical read; a stale entry can only suppress
   * naming. Entries are id strings kept for the process lifetime, unpruned.
   */
  private readonly settledInitialTitleChats = new Set<string>();
  private readonly recordDiagnostic: (record: SessionDiagnosticRecord) => void;
  private readonly claudeToolNames: ReadonlySet<string>;
  private readonly codexToolNames: ReadonlySet<string>;
  private readonly cursorToolUse?: (
    target: VisualToolTarget,
    toolUseId: string,
  ) => boolean;
  private readonly unsubscribeStorageDiagnostics: () => void;
  private readonly listeners = new Set<
    (event: ChatStateChangedEvent) => void
  >();
  private readonly pendingQuestionScopes = new Map<
    string,
    ChatScopeKey & { chatId: string }
  >();
  private readonly latestProjectionCommitRevisionByScope = new Map<
    string,
    number
  >();

  public async getCommandReceipt(request: {
    projectId: string;
    worktreeId: string;
    commandId: string;
  }): Promise<PersistedCommandReceipt | null> {
    return (
      (await this.repository.getReceipt(request, request.commandId)) ?? null
    );
  }

  public async getPortalSendReceipt(request: {
    projectId: string;
    worktreeId: string;
    commandId: string;
    identity: PortalChatSendIdentity;
  }): Promise<PortalChatSendReceiptProbe> {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.commandId, 'commandId');
    validateId(request.identity.chatId, 'chatId');
    validateId(request.identity.userMessageId, 'userMessageId');
    if (!/^[a-f0-9]{64}$/.test(request.identity.fingerprint))
      return { outcome: 'conflict' };
    const receipt =
      (await this.repository.getReceipt(request, request.commandId)) ??
      (await this.repository.getPortalSendReceipt(
        request,
        request.identity.userMessageId,
      ));
    if (receipt) {
      return matchesPortalSendReceipt(receipt, request.identity)
        ? { outcome: 'matched', receipt }
        : { outcome: 'conflict' };
    }
    const state = await this.repository.getState(request, {
      chatIds: [request.identity.chatId],
    });
    const existingMessage = state.tabsFile.tabs
      .find((tab) => tab.id === request.identity.chatId)
      ?.messages.some(
        (message) => message.id === request.identity.userMessageId,
      );
    return { outcome: existingMessage ? 'conflict' : 'missing' };
  }
  /** Accepted sends not yet guaranteed visible in the queue/session hosts. */
  private readonly dispatchesInFlight = new Map<string, number>();
  private readonly heldSends = new Map<string, HeldSend>();
  private readonly setupHolds = new Map<string, SetupHold>();
  private draining = false;
  /** Commands currently claiming a scope/commandId idempotency key. */
  private readonly commandsInFlight = new Map<
    string,
    Promise<ChatCommandResult>
  >();
  /**
   * Ref-counted deletion boundaries. Worktree cleanup owns the outer boundary
   * while deleteScope owns the nested chat-state boundary.
   */
  private readonly deletingScopeIds = new Map<string, number>();
  /** Admitted sends that deletion must include in its session cleanup sweep. */
  private readonly activeScopeOperations = new Map<string, number>();
  /** Deletion waiters released when the last admitted send leaves a scope. */
  private readonly scopeOperationDrainWaiters = new Map<
    string,
    Set<() => void>
  >();
  /** Active leases inherited by awaited descendants of an admitted operation. */
  private readonly scopeActivityLeases = new AsyncLocalStorage<
    readonly ScopeActivityLease[]
  >();
  /** Immutable archive scopes retain bounded ownership and artifact caches. */
  private readonly archiveBackends = new Map<
    string,
    Promise<ArchiveChatBackend>
  >();

  public constructor(options: ChatStateServiceOptions = {}) {
    this.claudeToolNames =
      options.claudeToolNames ?? EMPTY_SHOW_VISUAL_TOOL_NAMES;
    this.codexToolNames =
      options.codexToolNames ?? EMPTY_SHOW_VISUAL_TOOL_NAMES;
    this.cursorToolUse = options.cursorToolUse;
    this.recordDiagnostic =
      options.recordDiagnostic ??
      ((record): void => {
        // Lazy by design: the observability service pulls in the codex runtime
        // graph, which reaches back into the chat state port; a static import
        // here would reintroduce an initialization cycle.
        void import('../observability')
          .then(({ getObservabilityService }) => {
            getObservabilityService().recordSessionDiagnostic(record);
          })
          .catch(() => {
            // A diagnostic that cannot be recorded must never change the
            // outcome of the command that produced it.
          });
      });
    this.repository =
      options.repository ??
      new ChatStateV2Repository({
        hasLiveDependency: async (scope): Promise<boolean> => {
          // Lazy by design: these local services import the chat-state singleton,
          // so static imports here would reintroduce an initialization cycle.
          const [{ getActiveChatIds }, { getChatQueueService }] =
            await Promise.all([
              import('../agents/session-manager'),
              import('./chat-queue-service'),
            ]);
          return (
            getActiveChatIds(scope.projectId, scope.worktreeId).length > 0 ||
            getChatQueueService().getWorktreeSnapshots(
              scope.projectId,
              scope.worktreeId,
            ).length > 0
          );
        },
      });
    this.unsubscribeStorageDiagnostics =
      this.repository.subscribeStorageDiagnostics((diagnostic) => {
        this.recordDiagnostic(storageSessionDiagnostic(diagnostic));
      });
    this.reconcileHostRuntime = options.repository === undefined;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.steer =
      options.steer ??
      (async (request): Promise<boolean> => {
        // Lazy by design: session-manager imports the chat-state singleton;
        // a static import here would reintroduce that initialization cycle.
        const { getSession } = await import('../agents/session-manager');
        const session = getSession(
          request.projectId,
          request.worktreeId,
          request.chatId,
        );
        if (!session || session.isDisposed?.()) return false;
        return (
          (await session.steerActiveTurn?.(
            request.text,
            request.clientUserMessageId ?? request.userMessageId,
          )) ?? false
        );
      });
    this.dispatch =
      options.dispatch ??
      (async (request, origin): Promise<void> => {
        // Lazy by design: chat-queue-service imports the chat state port during
        // startup, so a static import would reintroduce an initialization cycle.
        const { getChatQueueService } = await import('./chat-queue-service');
        await getChatQueueService().submit(request, origin);
      });
    this.awaitWorktreeSetup =
      options.awaitWorktreeSetup ??
      ((target): Promise<WorktreeGitSetupOutcome> | undefined =>
        claimWorktreeGitSetup(target.projectId, target.worktreeId));
    this.notifyTurnTerminal =
      options.notifyTurnTerminal ??
      (async (event): Promise<void> => {
        const [{ getAppAdvisorWatcherService }, { isCoworkWorkspace }] =
          await Promise.all([
            import('../app-advisor/watchers'),
            import('../lib/workspace-registry'),
          ]);
        await getAppAdvisorWatcherService().handleChatTerminalEvent({
          scope: isCoworkWorkspace(event.projectId) ? 'standalone' : 'worktree',
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          data: event.data,
          status: event.outcome === 'failed' ? 'failure' : 'cancelled',
          receivedAt: new Date(this.now()).toISOString(),
        });
      });
    this.worktreeSetupQueue = options.worktreeSetupQueue ?? {
      hold: async (target, turnUserMessageId): Promise<void> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().holdForWorktreeSetup(target, turnUserMessageId);
      },
      release: async (target, releaseOptions): Promise<void> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        getChatQueueService().releaseWorktreeSetupHold(target, releaseOptions);
      },
      takeHeld: async (
        target,
        outcome,
      ): Promise<readonly ChatSendMessageRequest[]> => {
        const { getChatQueueService } = await import('./chat-queue-service');
        return getChatQueueService().takeWorktreeSetupHeldSends(
          target,
          outcome,
        );
      },
    };
    this.resolveSendModel =
      options.resolveSendModel ??
      (async (target, stored, requested): Promise<string | undefined> => {
        // Lazy by design: the default-model resolver reaches services that
        // import the chat-state singleton.
        const { resolveSendModelPin } =
          await import('../agents/agent-default-model');
        return resolveSendModelPin(target.projectId, stored, requested);
      });
    this.withPlanReviewRevision =
      options.withPlanReviewRevision ??
      (async <T>(
        request: PlanReviewApprovalRecordRequest,
        commit: () => Promise<T>,
      ): Promise<{ accepted: false } | { accepted: true; result: T }> => {
        const { withTrackedPlanRevision } =
          await import('../lib/plan-persistence');
        return withTrackedPlanRevision(
          { ...request, source: 'opencode', reviewStatus: 'approved' },
          commit,
        );
      });
    this.approvePlanReview =
      options.approvePlanReview ??
      (async (request): Promise<boolean> => {
        const { approveOpenCodePlanReview } = await import('./plans-service');
        return approveOpenCodePlanReview(request);
      });
    this.authorizeSend =
      options.authorizeSend ??
      (async (target): Promise<void> => {
        // Lazy by design: chat-service owns the singleton chat-state port and
        // statically importing it here would create an initialization cycle.
        const { assertWorktreeChatSendNotSplitLocked } =
          await import('./chat-service');
        assertWorktreeChatSendNotSplitLocked(
          target.projectId,
          target.worktreeId,
        );
        if (
          target.allowTrustedTerminal !== true &&
          (await resolveTerminalDrivenChat(target))
        ) {
          throw new Error(
            'Terminal-backed chats cannot be driven from the revisioned renderer.',
          );
        }
      });
    this.cleanupSession =
      options.cleanupSession ??
      (async (target): Promise<void> => {
        // Lazy by design: session-manager owns provider sessions that call back
        // into this service; defer both sides until cleanup is actually needed.
        const [{ cancelChatTurn }, { destroySession }] = await Promise.all([
          import('../lib/chat-turn-cancel'),
          import('../agents/session-manager'),
        ]);
        try {
          await cancelChatTurn(target);
        } finally {
          await destroySession(
            target.projectId,
            target.worktreeId,
            target.chatId,
          );
        }
      });
    this.inputDelivery = new ChatInputDeliveryCoordinator(
      this.repository,
      options.inputSession ??
        (async (target): Promise<AgentSession | undefined> => {
          // Lazy by design: session-manager imports this chat-state singleton;
          // defer the reverse edge to break that initialization cycle. The
          // packaged Electron main build exercises this local import path.
          const { getSession } = await import('../agents/session-manager');
          return getSession(target.projectId, target.worktreeId, target.chatId);
        }),
      this.authorizeSend,
      options.onInputPickup ??
        (async (target, row, event): Promise<void> => {
          const attempt = row.attempts.find(
            (candidate) => candidate.id === event.attemptId,
          );
          const payload = attempt?.payloadSnapshot ?? row.payload;
          try {
            // Observability composes chat-state during main-process startup;
            // defer the reverse edge to avoid that initialization cycle. The
            // packaged Electron main build exercises this local import path.
            const { getObservabilityService } =
              await import('../observability');
            getObservabilityService().observeSteeringInput({
              ...target,
              provider: event.provider,
              userMessageId: row.id,
              originalUserText: attempt?.displayText ?? row.text,
              submittedText: attempt?.submittedText ?? row.text,
              fileReferences: payload.fileReferences,
              planMode: payload.planMode ?? false,
              initiationSource: payload.initiationSource ?? 'user',
              startsTurn:
                event.startsTurn === true && event.turnRootAccepted !== false,
            });
          } catch (error) {
            // An audit sink failure must not drop the already committed provider event.
            logMainProcessWarn('Failed to record steering pickup audit', error);
          }
        }),
      checkWatcherDeliveryIngress,
    );
    this.schedule = options.schedule ?? setTimeout;
    this.repository.setCommitListener(
      (commit): Promise<void> => this.publishCommit(commit),
    );
  }

  /** Claim only a committed visible first input; serialize with all chat writes. */
  public async claimNewChatStarted(
    input: ChatScopeKey & {
      chatId: string;
      sourceInputId: string;
      occurredAt: string;
    },
  ): Promise<boolean> {
    let claimed = false;
    await this.repository.transactWith(
      input,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === input.chatId,
        );
        if (!tab || tab.newChatStartedWatcherFiredAt !== undefined) return [];
        const visibleUsers = tab.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.hidden !== true &&
            message.parentBlockId === undefined &&
            message.parentToolUseId === undefined,
        );
        if (!visibleUsers.some((message) => message.id === input.sourceInputId))
          return [];
        if (
          tab.newChatStartedWatcherPending !== true &&
          visibleUsers[0]?.id !== input.sourceInputId
        )
          return [];
        claimed = true;
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              newChatStartedWatcherPending: null,
              newChatStartedWatcherFiredAt: input.occurredAt,
            },
          },
        ];
      },
      { source: 'migration', chatIds: [input.chatId], fullTranscript: true },
    );
    return claimed;
  }

  public async getState(request: ChatScopeKey): Promise<ChatStateSnapshot> {
    // Register before reading the snapshot: a queue mutation can commit while
    // that read is in flight, and the older rows may hydrate afterward.
    const { getChatQueueService } = await import('./chat-queue-service');
    const releaseInputHydration = this.reconcileHostRuntime
      ? getChatQueueService().beginInputHydration(
          request.projectId,
          request.worktreeId,
        )
      : undefined;
    try {
      let state = await this.repository.getState(request);
      if (this.reconcileHostRuntime) {
        state = await this.reconcileRuntimeHosts(request, state);
        for (const tab of state.tabsFile.tabs) {
          if (isInputLedger(tab.inputDelivery))
            await this.inputDelivery.recover({ ...request, chatId: tab.id });
        }
        state = await this.repository.getState(request);
      }
      if (state.tabsFile.activeTabId)
        state = await this.repository.getState(request, {
          chatIds: [state.tabsFile.activeTabId],
          pageOnly: true,
        });
      for (const question of state.tabsFile.pendingQuestions ?? []) {
        this.pendingQuestionScopes.set(question.requestId, {
          ...request,
          chatId: question.chatId,
        });
      }
      // Lazy for the documented chat-state/chat-queue initialization cycle; the
      // queue is runtime-only and is not needed while materializing snapshots.
      const recoveryError = this.repository
        .getDiagnostics(request)
        .find(
          (diagnostic) =>
            diagnostic.kind === 'unrecoverable_snapshot' ||
            diagnostic.kind === 'unrecoverable_journal',
        )?.message;
      const runtimeByChatId = { ...state.runtimeByChatId };
      if (this.reconcileHostRuntime)
        await Promise.all(
          state.tabsFile.tabs.map(async (tab) => {
            const runtime = runtimeByChatId[tab.id] ?? {
              status: 'idle' as const,
              queuedMessageIds: [],
            };
            runtimeByChatId[tab.id] = {
              ...runtime,
              steeringCapabilities: await this.inputDelivery.capabilities({
                ...request,
                chatId: tab.id,
              }),
            };
          }),
        );
      // Canonical publication can queue behind a watcher mutation awaiting
      // this snapshot. Start recovery only after the read has returned; failed
      // publication retains its durable pending marker for the next read.
      if (this.reconcileHostRuntime) {
        for (const tab of state.tabsFile.tabs) {
          if (
            tab.kind === 'file' ||
            !isTerminalBackedInterfaceMode(tab.interfaceMode)
          )
            continue;
          setImmediate(() => {
            void import('../integration/claude-terminal-session-service')
              .then(({ getClaudeTerminalSessionService }) =>
                getClaudeTerminalSessionService().resumePendingObservations({
                  ...request,
                  chatId: tab.id,
                }),
              )
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-state] Could not resume terminal watcher observations:',
                  error,
                );
              });
          });
        }
      }
      return {
        schemaVersion: 1,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        revision: state.tabsFile.revision ?? 0,
        tabsFile: {
          ...state.tabsFile,
          tabs: state.tabsFile.tabs.map((tab) => ({
            ...tab,
            messages: Object.prototype.propertyIsEnumerable.call(
              tab,
              'messages',
            )
              ? tab.messages
              : [],
            ...(tab.transcript
              ? {
                  transcript: tab.transcript,
                  transcriptLoaded: Object.prototype.propertyIsEnumerable.call(
                    tab,
                    'messages',
                  ),
                }
              : {}),
          })),
        },
        archives: state.archivesFile.archived.map((entry) =>
          toArchivedChatSummary(entry, this.now()),
        ),
        runtimeByChatId,
        queue: getChatQueueService().getWorktreeSnapshots(
          request.projectId,
          request.worktreeId,
        ),
        ...(recoveryError ? { recoveryError } : {}),
      };
    } finally {
      releaseInputHydration?.();
    }
  }

  public hasMutation(
    request: ChatScopeKey,
    mutationId: string,
  ): Promise<boolean> {
    return this.repository.hasMutation(request, mutationId);
  }

  /**
   * How the turn of one user message ended, or `pending` while it has not.
   * Answered from durable chat state, never from the bounded mutation
   * index: a turn that ran reports the end its chat recorded when its
   * runtime settled (`turnEnds`), and a turn that ended before any provider
   * accepted it reports the outcome recorded for it (`unacceptedTurnEnds`).
   * Otherwise it is pending while the chat queue holds it as the dispatching
   * turn or a queued row, or the chat queues it or runs or can resume it as
   * its active turn, whose own failure or cancellation is reported while it
   * is the active turn. A turn without a recorded end that is no longer
   * active (it ended before ends were recorded, or its record was dropped
   * past the bound) has ended once it passed acceptance: it is the chat's
   * last accepted turn (`lastAcceptedUserMessageId`) or precedes it in the
   * transcript, since a chat accepts its turns one at a time and a later
   * turn is accepted only after every earlier one ended or left the queue.
   * Every turn of an archived chat has ended, because a chat with queued or
   * active work cannot be archived. A turn an app restart interrupted is
   * carried on by the turn that resumed it (`interruptedTurns`), so it
   * reports how the last resume in that chain ended; it is pending while it
   * awaits a resume, and cancelled once another turn started instead or its
   * chat was archived. A null `userMessageId` names the chat's first turn,
   * `pending` until the chat has a user message.
   */
  public async turnOutcome(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<ChatTurnOutcome> {
    const { chatId } = target;
    const read = (fullTranscript: boolean): Promise<CanonicalChatState> =>
      this.repository.getState(target, {
        chatIds: [chatId],
        ...(fullTranscript ? { fullTranscript: true } : { pageOnly: true }),
      });
    let state = await read(target.userMessageId === null);
    const archived = state.archivesFile.archived.find(
      (entry) => entry.tab.id === chatId,
    )?.tab;
    let tab = state.tabsFile.tabs.find((candidate) => candidate.id === chatId);
    if (!tab) {
      if (!archived) return 'pending';
      if (target.userMessageId === null) return 'completed';
      const succession = resolveTurnSuccession(
        archived.interruptedTurns,
        target.userMessageId,
      );
      if (succession.abandoned || succession.awaitingResume) {
        return 'cancelled';
      }
      return (
        recordedTurnEnd(archived.turnEnds, succession.userMessageId) ??
        archived.unacceptedTurnEnds?.[succession.userMessageId] ??
        'completed'
      );
    }
    const watchedUserMessageId =
      target.userMessageId ??
      tab.messages.find((message) => message.role === 'user')?.id ??
      null;
    if (watchedUserMessageId === null) return 'pending';
    const succession = resolveTurnSuccession(
      tab.interruptedTurns,
      watchedUserMessageId,
    );
    if (succession.abandoned) return 'cancelled';
    if (succession.awaitingResume) return 'pending';
    const { userMessageId } = succession;
    const ended =
      recordedTurnEnd(tab.turnEnds, userMessageId) ??
      tab.unacceptedTurnEnds?.[userMessageId];
    if (ended) return ended;
    const { getChatQueueService } = await import('./chat-queue-service');
    if (getChatQueueService().holdsUserMessage(target, userMessageId)) {
      return 'pending';
    }
    const runtime = state.runtimeByChatId[chatId];
    if (runtime?.queuedMessageIds.includes(userMessageId)) return 'pending';
    if (runtime?.activeTurn?.userMessageId === userMessageId) {
      switch (runtime.status) {
        case 'failed':
        case 'cancelled':
          return runtime.status;
        case 'idle':
        case 'completed':
          return 'completed';
        default:
          return 'pending';
      }
    }
    const lastAccepted = tab.lastAcceptedUserMessageId;
    if (lastAccepted === undefined) return 'pending';
    if (lastAccepted === userMessageId) return 'completed';
    const precedes = (messages: readonly PersistedChatMessage[]): boolean => {
      const ids = messages
        .filter((message) => message.role === 'user')
        .map((message) => message.id);
      const position = ids.indexOf(userMessageId);
      const acceptedPosition = ids.indexOf(lastAccepted);
      return position >= 0 && acceptedPosition > position;
    };
    if (precedes(tab.messages)) return 'completed';
    if (target.userMessageId !== null) {
      state = await read(true);
      tab = state.tabsFile.tabs.find((candidate) => candidate.id === chatId);
      if (tab && precedes(tab.messages)) return 'completed';
    }
    return 'pending';
  }

  /**
   * How a watched turn ended, as `turnOutcome` reports it, with the turn that
   * carried it on after app restarts interrupted it and whether another turn
   * started instead of a resume. Includes the owner's original terminal time
   * when retained, and the reason an input ended without a report of its own.
   */
  public async settledTurn(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<{
    outcome: ChatTurnOutcome;
    userMessageId: string | null;
    abandoned: boolean;
    endedAt?: number;
    endReason?: 'unaccepted' | 'abandoned';
  }> {
    const outcome = await this.turnOutcome(target);
    if (target.userMessageId === null) {
      return { outcome, userMessageId: null, abandoned: false };
    }
    const succession = await this.turnSuccession({
      ...target,
      userMessageId: target.userMessageId,
    });
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === target.chatId) ??
      state.archivesFile.archived.find(
        (candidate) => candidate.tab.id === target.chatId,
      )?.tab;
    const endedAt = tab?.turnEnds?.[succession.userMessageId]?.endedAt;
    return {
      outcome,
      ...succession,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(succession.abandoned
        ? { endReason: 'abandoned' }
        : tab?.unacceptedTurnEnds?.[succession.userMessageId] !== undefined
          ? { endReason: 'unaccepted' }
          : {}),
    };
  }

  /**
   * The messages of one turn of a chat, read from the end of its transcript
   * back to the user message that opened it (`turnMessages`): the turn of
   * `userMessageId`, or with null the chat's latest turn. A user message
   * whose place in the transcript does not mark a turn yet neither ends the
   * turn nor belongs to it. Those messages and the transcript come from one
   * read under the chat's scope lease, so a follow-up accepted meanwhile is
   * never both provisional and at its dispatch position. Null when the
   * transcript does not hold that message.
   */
  public async turnReplyMessages(
    target: ChatScopeKey & { chatId: string; userMessageId: string | null },
  ): Promise<PersistedChatMessage[] | null> {
    const { getChatQueueService } = await import('./chat-queue-service');
    const queue = getChatQueueService();
    const opens = (
      message: PersistedChatMessage,
      provisional: ReadonlySet<string>,
    ): boolean =>
      message.role === 'user' &&
      (target.userMessageId === null
        ? isUserTurnBoundary(message) && !provisional.has(message.id)
        : message.id === target.userMessageId);
    const { value: provisional, messages } =
      await this.repository.readTranscriptTail(
        target,
        target.chatId,
        { chatIds: [target.chatId], pageOnly: true },
        {
          fromState: (state) =>
            provisionalTurnIds(
              state,
              target.chatId,
              queue.dispatchingUserMessageId(target),
            ),
          reachedStart: (ids, page) =>
            page.some((message) => opens(message, ids)),
        },
      );
    const opening = messages
      .filter((message) => opens(message, provisional))
      .pop();
    if (opening) return turnMessages(messages, opening.id, provisional);
    return target.userMessageId === null
      ? messages.filter(
          (message) => message.role !== 'user' || !provisional.has(message.id),
        )
      : null;
  }

  /**
   * The turn that carries a watched turn on: the turn itself, or the last
   * turn in its chain of resumes after app restarts interrupted it, and
   * whether another turn started instead of a resume (`abandoned`).
   */
  public async turnSuccession(
    target: ChatScopeKey & { chatId: string; userMessageId: string },
  ): Promise<{ userMessageId: string; abandoned: boolean }> {
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === target.chatId) ??
      state.archivesFile.archived.find(
        (entry) => entry.tab.id === target.chatId,
      )?.tab;
    const { userMessageId, abandoned } = resolveTurnSuccession(
      tab?.interruptedTurns,
      target.userMessageId,
    );
    return { userMessageId, abandoned };
  }

  /** {@link provisionalTurnIds} of a chat as its current state reports them. */
  public async provisionalTurnUserMessageIds(
    target: ChatScopeKey & { chatId: string },
  ): Promise<ReadonlySet<string>> {
    const { getChatQueueService } = await import('./chat-queue-service');
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
      pageOnly: true,
    });
    return provisionalTurnIds(
      state,
      target.chatId,
      getChatQueueService().dispatchingUserMessageId(target),
    );
  }

  /** Whether a live or auto-archived chat durably contains one message id.
   * A bounded point lookup: it never loads or pages the whole transcript. */
  public hasTranscriptMessage(
    request: ChatScopeKey,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.repository.hasMessage(request, chatId, messageId);
  }

  public searchTranscript(
    request: ChatTranscriptSearchRequest,
    signal?: AbortSignal,
  ): Promise<ChatTranscriptSearchResult> {
    return this.consumeTranscript(request, request.chatId, false, (messages) =>
      searchTranscriptMessages(messages, request.query, signal),
    );
  }

  public async getTranscriptPage(
    request: ChatTranscriptPageRequest,
  ): Promise<TranscriptPage> {
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.page(
        request.chatId,
        request.before,
        request.transcriptRevision,
        request,
      );
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.page(
        request.chatId,
        request.before,
        request.transcriptRevision,
        request,
      );
    }
    return this.repository.page(
      request,
      request.chatId,
      request.before,
      request.transcriptRevision,
      request,
    );
  }

  /**
   * Appends delegated runs' new and changed child transcript items to the
   * parent chat's delegate logs, under one scope lease. False when the chat
   * no longer exists.
   */
  public appendDelegationItems(
    scope: ChatScopeKey,
    chatId: string,
    runs: readonly DelegationRunItems[],
  ): Promise<boolean> {
    return this.repository.appendDelegationItems(scope, chatId, runs);
  }

  /** A delegated run's child transcript from its parent chat's delegate log. */
  public async readDelegationItems(
    request: ChatScopeKey & {
      chatId: string;
      archivedContainerId?: string;
      standaloneHistory?: boolean;
    } & DelegationRun,
  ): Promise<AgentDelegationTranscriptItem[]> {
    const run = {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
    };
    if (request.standaloneHistory) {
      const backend = await this.standaloneArchiveBackend(
        request.projectId,
        request.chatId,
      );
      return backend.readDelegationItems(request.chatId, run);
    }
    if (request.archivedContainerId) {
      const backend = await this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
      return backend.readDelegationItems(request.chatId, run);
    }
    return this.repository.readDelegationItems(request, request.chatId, run);
  }

  public async readToolOutput(
    request: ChatToolOutputRequest,
    signal?: AbortSignal,
  ): Promise<ChatToolOutputResponse> {
    const backend = await this.readArchiveBackend(request);
    if (backend) {
      return backend.toolOutput(
        request.chatId,
        request.messageId,
        request.toolUseId,
        request.reference,
        request.offset,
        request.limit,
        signal,
      );
    }
    return this.repository.toolOutput(
      request,
      request.chatId,
      request.messageId,
      request.toolUseId,
      request.reference,
      request.offset,
      request.limit,
      signal,
    );
  }

  public async readVisual(
    request: ChatVisualReadRequest,
    signal?: AbortSignal,
  ): Promise<ChatVisualReadResponse> {
    const backend = await this.readArchiveBackend(request);
    if (backend)
      return backend.visual(
        request.chatId,
        request.messageId,
        request.toolUseId,
        request.reference,
        request.offset,
        request.limit,
        signal,
      );
    return this.repository.visual(
      request,
      request.chatId,
      request.messageId,
      request.toolUseId,
      request.reference,
      request.offset,
      request.limit,
      signal,
    );
  }

  private async readArchiveBackend(request: {
    projectId: string;
    chatId: string;
    standaloneHistory?: boolean;
    archivedContainerId?: string;
  }): Promise<ArchiveChatBackend | undefined> {
    if (request.standaloneHistory)
      return this.standaloneArchiveBackend(request.projectId, request.chatId);
    if (request.archivedContainerId)
      return this.archivedContainerBackend(
        request.projectId,
        request.archivedContainerId,
      );
    return undefined;
  }

  private standaloneArchiveBackend(
    projectId: string,
    chatId: string,
  ): Promise<ArchiveChatBackend> {
    return this.archiveBackend(
      JSON.stringify(['standalone', projectId, chatId]),
      async () => {
        // Keep archive filesystem setup and backend loading off packaged main
        // startup until an archived transcript is first opened.
        const [{ getStandaloneHistoryStorage }, { ChatStateV2Backend }] =
          await Promise.all([
            import('../lib/standalone-history'),
            import('./chat-state-v2-backend'),
          ]);
        const store = await getStandaloneHistoryStorage(projectId, chatId);
        if (!store) throw new Error('Standalone archive not found');
        return new ChatStateV2Backend(store);
      },
    );
  }

  private archivedContainerBackend(
    projectId: string,
    containerId: string,
  ): Promise<ArchiveChatBackend> {
    return this.archiveBackend(
      JSON.stringify(['container', projectId, containerId]),
      async () => {
        // Keep archive filesystem setup and backend loading off packaged main
        // startup until an archived transcript is first opened.
        const [{ getArchivedContainerChatStorage }, { ChatStateV2Backend }] =
          await Promise.all([
            import('../lib/archived-containers'),
            import('./chat-state-v2-backend'),
          ]);
        const store = await getArchivedContainerChatStorage(
          projectId,
          containerId,
        );
        return new ChatStateV2Backend(store);
      },
    );
  }

  private archiveBackend(
    key: string,
    create: () => Promise<ArchiveChatBackend>,
  ): Promise<ArchiveChatBackend> {
    const cached = this.archiveBackends.get(key);
    if (cached) {
      this.archiveBackends.delete(key);
      this.archiveBackends.set(key, cached);
      return cached;
    }
    const loading = create();
    this.archiveBackends.set(key, loading);
    if (this.archiveBackends.size > ARCHIVE_BACKEND_CACHE_LIMIT) {
      const oldest = this.archiveBackends.keys().next();
      if (!oldest.done) this.archiveBackends.delete(oldest.value);
    }
    void loading.catch(() => {
      if (this.archiveBackends.get(key) === loading) {
        this.archiveBackends.delete(key);
      }
    });
    return loading;
  }

  private async reconcileRuntimeHosts(
    scope: ChatScopeKey,
    state: CanonicalChatState,
  ): Promise<CanonicalChatState> {
    // Both host registries depend on the installed chat-state port. Resolve
    // them after repository startup to avoid a circular module initializer.
    const [
      { getActiveChatIds },
      { getChatQueueService },
      { getClaudeTerminalSessionService },
    ] = await Promise.all([
      import('../agents/session-manager'),
      import('./chat-queue-service'),
      import('../integration/claude-terminal-session-service'),
    ]);
    const queueService = getChatQueueService();
    const hydratedTargets = new Map<
      string,
      ChatScopeKey & { chatId: string }
    >();
    for (const tab of state.tabsFile.tabs) {
      if (tab.kind === 'file') continue;
      const runtime = state.runtimeByChatId[tab.id];
      const durableQueueIds = new Set(runtime?.queuedMessageIds ?? []);
      for (const message of runtime?.queuedMessages ?? []) {
        if (!durableQueueIds.has(message.id)) continue;
        queueService.hydratePersistedInput(
          message.request,
          message.id,
          message.origin,
          message.enqueuedAtMs,
          message.authenticationAttemptId,
          message.requiredAccountProxyConnectionId,
        );
        hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
      }
      if (!isInputLedger(tab.inputDelivery)) continue;
      for (const row of [...tab.inputDelivery.rows]
        .filter(
          (candidate) =>
            candidate.state === 'queued' && durableQueueIds.has(candidate.id),
        )
        .sort((left, right) => left.createdAt - right.createdAt)) {
        queueService.hydratePersistedInput(
          row.payload,
          row.id,
          row.origin ?? 'desktop',
          row.createdAt,
        );
        hydratedTargets.set(tab.id, { ...scope, chatId: tab.id });
      }
    }
    // The transaction checks transcript timers before it can classify idle
    // and interrupted runtimes, so it may only touch runtimes whose
    // transcripts were selected from this snapshot. A runtime accepted
    // between the read and the lease is reconciled by the next snapshot.
    const selectedChatIds = new Set(Object.keys(state.runtimeByChatId));
    const commit = await this.repository.transactWith(
      scope,
      async (current) => {
        // Resolve every liveness source inside the serialized transaction so
        // a stale pre-transaction snapshot cannot interrupt a newly accepted
        // turn. Queue turnActive covers the period after dispatch returns;
        // dispatchesInFlight covers durable acceptance through host exposure.
        const activeChatIds = new Set(
          getActiveChatIds(scope.projectId, scope.worktreeId),
        );
        const hostQueueIds = new Map(
          queueService
            .getWorktreeSnapshots(scope.projectId, scope.worktreeId)
            .map((snapshot) => [
              snapshot.chatId,
              snapshot.queue.map((message) => message.id),
            ]),
        );
        const mutations: ChatCoreMutation[] = [];
        for (const [chatId, runtime] of Object.entries(
          current.runtimeByChatId,
        )) {
          if (!selectedChatIds.has(chatId)) continue;
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === chatId,
          );
          if (!tab || tab.kind === 'file') continue;
          const openTimer = tab.messages.some((message) =>
            message.blocks.some(
              (block) =>
                block.type === 'turn_timer' &&
                block.completedAt == null &&
                (block.pausedAt == null || block.resumedAt != null),
            ),
          );
          const terminalActive =
            tab.claudeTerminal &&
            ['running', 'starting'].includes(tab.claudeTerminal.turnState);
          const unfinished = [
            'queued',
            'starting',
            'streaming',
            'awaiting_input',
            'completing',
          ].includes(runtime.status);
          if (
            !unfinished &&
            !terminalActive &&
            !(openTimer && ['idle', 'interrupted'].includes(runtime.status))
          )
            continue;
          const queuedMessageIds = hostQueueIds.get(chatId) ?? [];
          if (runtime.status === 'queued' && queuedMessageIds.length > 0) {
            if (
              JSON.stringify(queuedMessageIds) !==
              JSON.stringify(runtime.queuedMessageIds)
            ) {
              mutations.push({
                type: 'runtime.patched',
                chatId,
                runtime: { ...runtime, queuedMessageIds },
              });
            }
            continue;
          }
          const target = { ...scope, chatId };
          const terminal = getClaudeTerminalSessionService().getState(
            scope.projectId,
            scope.worktreeId,
            chatId,
          );
          if (
            activeChatIds.has(chatId) ||
            (terminal && !['exited', 'error'].includes(terminal.turnState)) ||
            queueService.isTurnActive(target) ||
            this.dispatchesInFlight.has(chatRuntimeHostKey(scope, chatId))
          ) {
            continue;
          }
          const now = this.now();
          // Persist the resume target before closing its durable running marker.
          // A registry failure leaves the original state available for a retry.
          if (isRealWorkspaceTarget(target)) {
            await recordInterruptedChats([
              {
                ...target,
                provider:
                  tab.providerType ??
                  (tab.model ? getProviderForModel(tab.model) : undefined) ??
                  'claude',
                detectedAt: now,
                resumeReason: 'app_shutdown',
                workspaceName: '',
                chatTitle: tab.title ?? '',
              },
            ]);
          }
          if (terminalActive && tab.claudeTerminal)
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: chatId,
              patch: {
                claudeTerminal: { ...tab.claudeTerminal, turnState: 'exited' },
              },
            });
          for (const question of current.tabsFile.pendingQuestions ?? []) {
            // Synchronous questions belong to the interrupted provider turn,
            // but Codex async questions remain actionable after that turn has
            // settled and must survive restart reconciliation.
            if (question.chatId === chatId && question.delivery !== 'async')
              mutations.push({
                type: 'pending_question.removed',
                chatId,
                requestId: question.requestId,
              });
          }
          mutations.push(
            ...buildPersistedTurnInterruptedMutations(
              chatId,
              tab.messages,
              runtime,
              now,
              queuedMessageIds,
              tab,
            ),
          );
        }
        return mutations;
      },
      {
        ...{
          source: 'automation',
          mutationId: `host-reconcile:${state.tabsFile.revision ?? 0}`,
          checkpoint: true,
        },
        chatIds: Array.from(selectedChatIds),
      },
    );
    for (const target of Array.from(hydratedTargets.values()))
      queueService.releaseInputOwnership(target);
    return commit.state;
  }

  public subscribe(
    listener: (event: ChatStateChangedEvent) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async command(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions = {},
  ): Promise<ChatCommandResult> {
    if (
      isRetiredPlanChatScope(envelope.projectId) &&
      isRetiredScopeRefusedCommand(envelope.command)
    ) {
      // Canonical command hosts (the chat-command IPC, the portal) reach this
      // service directly: refuse a legacy plan chat before its scope is
      // opened, so nothing is read, migrated, or persisted. No surface shows
      // the retired scope, so the reported revision is never observed.
      return commandResult(envelope, 0, 'rejected', {
        reason: RETIRED_PLAN_CHAT_MESSAGE,
      });
    }
    if (envelope.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
      await this.assertViewerCommandAllowed(envelope);
    }
    const lifecycleKey = chatScopeLifecycleKey(envelope);
    const isSendCommand = isTurnStartingCommand(envelope.command);
    if (isSendCommand && !this.isScopeDeletionBlocking(lifecycleKey)) {
      return this.runWithScopeActivity(envelope, () =>
        this.commandWithinScopeActivity(envelope, options),
      );
    }
    return this.commandWithinScopeActivity(envelope, options);
  }

  /**
   * The shared-container viewer scope is read-only content, but its view state
   * is recipient-local: tab activation, order and read markers, plus file tabs
   * the recipient opens beside the published chats (the standard file viewer
   * keeps its tab identity here). Every other command, and any file-tab
   * command aimed at a published chat, fails closed.
   */
  private async assertViewerCommandAllowed(
    envelope: ChatCommandEnvelope<ChatCommand>,
  ): Promise<void> {
    const command = envelope.command;
    switch (command.type) {
      case 'chat.activate_tab':
      case 'chat.reorder_tabs':
      case 'chat.mark_read':
      case 'chat.mark_unread':
      case 'chat.dismiss_attention':
      case 'chat.create_file_tab':
        return;
      case 'chat.patch_tab_settings': {
        const fileViewKeys = new Set<string>([
          'fileViewMode',
          'fileDiffContext',
          'filePath',
          'title',
        ]);
        if (
          Object.keys(command.patch).every((key) => fileViewKeys.has(key)) &&
          (await this.viewerTabsAreFileTabs(envelope, [command.tabId]))
        ) {
          return;
        }
        break;
      }
      case 'chat.close_tab':
        if (
          command.mode === 'discard_empty' &&
          command.replacementTab === undefined &&
          command.replacementTabId === undefined &&
          (await this.viewerTabsAreFileTabs(envelope, [command.tabId]))
        ) {
          return;
        }
        break;
      case 'chat.close_tabs':
        if (
          command.replacementTab === undefined &&
          command.replacementTabId === undefined &&
          command.targets.every((target) => target.mode === 'discard_empty') &&
          (await this.viewerTabsAreFileTabs(
            envelope,
            command.targets.map((target) => target.tabId),
          ))
        ) {
          return;
        }
        break;
      default:
        break;
    }
    assertWritableScope(envelope.projectId);
  }

  private async viewerTabsAreFileTabs(
    scope: ChatScopeKey,
    tabIds: readonly string[],
  ): Promise<boolean> {
    if (tabIds.length === 0) return false;
    const { tabs } = await this.getCompatibilityTabs(
      { projectId: scope.projectId, worktreeId: scope.worktreeId },
      { chatIds: tabIds, pageOnly: true },
    );
    return tabIds.every(
      (tabId) => tabs.find((tab) => tab.id === tabId)?.kind === 'file',
    );
  }

  private async commandWithinScopeActivity(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const isSendCommand = isTurnStartingCommand(envelope.command);
    if (
      this.isScopeDeletionBlocking(chatScopeLifecycleKey(envelope)) ||
      (this.deletingScopeIds.has(chatScopeLifecycleKey(envelope)) &&
        !isSendCommand)
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(envelope),
        'rejected',
        { reason: 'Chat scope is being deleted' },
      );
    }
    const claimKey = `${envelope.projectId}\u0000${envelope.worktreeId}\u0000${envelope.commandId}`;
    const claimed = this.commandsInFlight.get(claimKey);
    if (claimed) {
      const result = await claimed;
      if (
        options.portalSend &&
        (result.outcome === 'applied' || result.outcome === 'already_applied')
      ) {
        return this.executeCommandWithDiagnostics(envelope, options);
      }
      if (options.onAgentSendAccepted) {
        const receipt = await this.repository.getReceipt(
          envelope,
          envelope.commandId,
        );
        if (receipt?.agentSendAcceptance)
          options.onAgentSendAccepted(receipt.agentSendAcceptance);
      }
      return result.outcome === 'applied'
        ? { ...result, outcome: 'already_applied' }
        : result;
    }
    const execution = withWorkspaceTargetRuntimeStartReservation(
      envelope.projectId,
      envelope.worktreeId,
      () => this.executeCommandWithDiagnostics(envelope, options),
    );
    this.commandsInFlight.set(claimKey, execution);
    try {
      return await execution;
    } finally {
      if (this.commandsInFlight.get(claimKey) === execution) {
        this.commandsInFlight.delete(claimKey);
      }
    }
  }

  /**
   * Failure chokepoint for the revisioned command path. A `rejected` outcome
   * and an escaping error both surface the same generic "couldn't save this
   * chat change" banner in the renderer, which drops the `reason` main
   * computed; without this record a field report has no way to say which
   * command failed or why. Recorded here rather than in `command()` so a
   * deduplicated concurrent caller replaying the same result does not
   * double-count one failure.
   */
  private async executeCommandWithDiagnostics(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    try {
      const result = await this.executeCommandWithConflictHandling(
        envelope,
        options,
      );
      if (result.outcome === 'rejected') {
        this.recordCommandFailure(envelope, 'rejected', result.reason);
      }
      return result;
    } catch (error) {
      this.recordCommandFailure(
        envelope,
        'threw',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private recordCommandFailure(
    envelope: ChatCommandEnvelope<ChatCommand>,
    outcome: 'rejected' | 'threw',
    reason: string | undefined,
  ): void {
    const command = envelope.command;
    // Entity ids only: the command payload can carry message text, file
    // paths, and attachments that have no place in a diagnostics day file.
    const chatId =
      'chatId' in command
        ? command.chatId
        : 'tabId' in command
          ? command.tabId
          : '';
    try {
      this.recordDiagnostic({
        version: 1,
        timestamp: new Date(this.now()).toISOString(),
        kind: 'chat_command_failed',
        sessionKey: `${envelope.projectId}/${envelope.worktreeId}/${chatId}`,
        projectId: envelope.projectId,
        worktreeId: envelope.worktreeId,
        chatId,
        providerType: 'unknown',
        chatCommandType: command.type,
        chatCommandId: envelope.commandId,
        chatCommandOutcome: outcome,
        ...(reason ? { error: reason } : {}),
      });
    } catch {
      // Diagnostics are best-effort and must never change a command outcome.
    }
  }

  private async executeCommandWithConflictHandling(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    try {
      return await this.executeCommand(envelope, options);
    } catch (error) {
      if (error instanceof ChatSendAuthorizationRevokedError) {
        return commandResult(
          envelope,
          await this.repository.getRevision(envelope),
          'rejected',
          { reason: error.message },
        );
      }
      if (error instanceof ChatStateRevisionConflictError) {
        return commandResult(envelope, error.actualRevision, 'conflict', {
          reason: error.message,
        });
      }
      throw error;
    }
  }

  private async executeCommand(
    envelope: ChatCommandEnvelope<ChatCommand>,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const scope = {
      projectId: envelope.projectId,
      worktreeId: envelope.worktreeId,
    };
    if (options.portalSend) {
      if (
        envelope.origin !== 'portal' ||
        envelope.command.type !== 'chat.send_message' ||
        envelope.command.chatId !== options.portalSend.chatId ||
        envelope.command.userMessageId !== options.portalSend.userMessageId
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The logical portal send identity does not match the command.',
          },
        );
      }
      const probe = await this.getPortalSendReceipt({
        ...scope,
        commandId: envelope.commandId,
        identity: options.portalSend,
      });
      if (probe.outcome === 'matched') {
        return commandResult(
          envelope,
          probe.receipt.revision,
          'already_applied',
          {
            entityId: probe.receipt.entityId,
            messageId: probe.receipt.messageId,
          },
        );
      }
      if (probe.outcome === 'conflict') {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          { reason: 'The logical portal send payload or target has changed.' },
        );
      }
    }
    const receipt = await this.repository.getReceipt(scope, envelope.commandId);
    if (receipt) {
      if (receipt.agentSendAcceptance)
        options.onAgentSendAccepted?.(receipt.agentSendAcceptance);
      return commandResult(envelope, receipt.revision, 'already_applied', {
        ...(receipt.reason ? { reason: receipt.reason } : {}),
        ...(receipt.entityId ? { entityId: receipt.entityId } : {}),
        ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
      });
    }
    const revision = await this.repository.getRevision(scope);
    const expectedRevision = expectedRevisionForCommand(envelope);
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return commandResult(envelope, revision, 'conflict', {
        reason: `Expected revision ${expectedRevision}, current revision is ${revision}`,
      });
    }

    switch (envelope.command.type) {
      case 'chat.create_tab':
        return this.createTab(
          scope,
          envelope,
          false,
          options.canCommitCreate,
          options.preserveActiveTab,
        );
      case 'chat.create_file_tab':
        return this.createTab(scope, envelope, true);
      case 'chat.activate_tab':
        return this.activateTab(scope, envelope, envelope.command.tabId);
      case 'chat.reorder_tabs':
        return this.commit(scope, envelope, [
          { type: 'tab.order_changed', tabIds: envelope.command.tabIds },
        ]);
      case 'chat.patch_tab_settings':
        return this.patchTabSettings(scope, envelope, envelope.command);
      case 'chat.set_model':
        return this.setModel(scope, envelope);
      case 'chat.mark_read':
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            unread: false,
          }),
        );
      case 'chat.mark_unread':
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            unread: true,
            attentionDismissedAt: undefined,
          }),
        );
      case 'chat.dismiss_attention':
        return this.patchWholeTab(
          scope,
          envelope,
          envelope.command.chatId,
          (tab) => ({
            ...tab,
            attentionDismissedAt: this.now(),
          }),
        );
      case 'chat.send_message':
        return this.sendMessage(scope, envelope, options);
      case 'chat.commit_terminal_initial_prompt':
        return this.commitTerminalInitialPrompt(scope, envelope);
      case 'chat.edit_queued_message':
      case 'chat.cancel_queued_message':
      case 'chat.steer_queued_message':
      case 'chat.force_queued_message':
        return this.queueCommand(scope, envelope);
      case 'chat.input_delivery_action':
        return this.inputDelivery.action(envelope);
      case 'chat.answer_question':
        return this.answerQuestion(scope, envelope, false, options);
      case 'chat.dismiss_question':
        return this.answerQuestion(scope, envelope, true, options);
      case 'chat.close_tab':
        return this.closeTab(
          scope,
          envelope,
          envelope.command.tabId,
          envelope.command.mode,
        );
      case 'chat.close_tabs':
        return this.closeTabs(scope, envelope, envelope.command);
      case 'chat.archive_tab':
        return this.closeTab(
          scope,
          envelope,
          envelope.command.tabId,
          'archive',
        );
      case 'chat.restore_archive':
        return this.restoreArchive(scope, envelope, envelope.command);
      case 'chat.mark_archive_read':
        return this.commit(scope, envelope, [
          {
            type: 'archive.read_state_changed',
            archiveEntryId: envelope.command.archiveEntryId,
            chatId: envelope.command.archiveEntryId,
            unread: envelope.command.unread,
          },
        ]);
      case 'chat.mark_all_archives_read':
        return this.markAllArchivesRead(scope, envelope);
      case 'chat.fork_tab':
        return this.forkTab(scope, envelope, envelope.command);
      case 'chat.reset_to_point':
        return this.resetToPoint(scope, envelope, envelope.command);
      case 'chat.set_scheduled_send_draft':
        return this.commitExistingTabCommand(
          scope,
          envelope,
          envelope.command.chatId,
          [
            {
              type: 'tab.metadata_patched',
              tabId: envelope.command.chatId,
              patch: {
                scheduledSendDraft: envelope.command.draft,
                ...(envelope.command.clearPendingRevertAttachment === true
                  ? { pendingRevertAttachmentPath: null }
                  : {}),
              },
            },
          ],
        );
      case 'chat.import_session':
        return this.importSession(scope, envelope, envelope.command);
    }
  }

  /** Stage one prepared visual through the trusted scope route. */
  public stageVisual(
    scope: ChatScopeKey,
    target: VisualStagingTarget,
    document: StageVisualDocument,
  ): Promise<VisualStagingSidecar> {
    return this.repository.stageVisual(scope, target, document);
  }

  /** Whether the provider event committed a canonical change. */
  public async ingestProviderEvent(
    input: ProviderEventInput,
  ): Promise<boolean> {
    return (await this.ingestProviderEventWithOutcome(input)) === 'applied';
  }

  public async ingestProviderEventWithOutcome(
    providerInput: ProviderEventInput,
  ): Promise<ProviderEventIngestOutcome> {
    recordProviderEventIngested();
    const input = withCardOnlyDelegation(providerInput);
    if (isRecord(input.data) && input.data.type === 'canopy_input_delivery') {
      const event = input.data;
      if (!isChatInputDeliveryEvent(event)) return 'not-applied';
      const observed = await this.inputDelivery.observe(input, event);
      if (observed) recordProviderEventApplied();
      return observed ? 'applied' : 'not-applied';
    }
    const data = isRecord(input.data) ? input.data : {};
    const delegation =
      data.type === 'canopy_delegation' && isRecord(data.delegation)
        ? data.delegation
        : undefined;
    // Delegates can finish many parent turns later. Hydrate their own card
    // for sequence checks; a new run falls back to its retained parent turn.
    // This is only a read hint. The shared reducer still validates the whole
    // event once, including its transcript; do not walk that transcript twice.
    const messageAnchor =
      delegation &&
      typeof delegation.delegationId === 'string' &&
      typeof delegation.runGeneration === 'number' &&
      Number.isSafeInteger(delegation.runGeneration) &&
      delegation.runGeneration >= 1 &&
      typeof delegation.parentTurnId === 'string'
        ? {
            messageId: `delegated-agent-${delegation.delegationId}${delegation.runGeneration > 1 ? `-run-${delegation.runGeneration}` : ''}`,
            fallbackMessageId: delegation.parentTurnId,
            ...(delegation.runGeneration > 1
              ? {
                  previousRunMessageId: `delegated-agent-${delegation.delegationId}${delegation.runGeneration > 2 ? `-run-${delegation.runGeneration - 1}` : ''}`,
                }
              : {}),
          }
        : undefined;
    const checkpoint =
      isRecord(input.data) &&
      (isTerminalChatEventData(input.data) ||
        input.data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE);
    const refreshCapabilities =
      (data.type === 'system' && data.subtype === 'init') ||
      data.type === 'result' ||
      data.type === 'canopy_user_prompt' ||
      data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE ||
      (data.type === 'codex' &&
        isRecord(data.event) &&
        ['turn.started', 'turn.completed', 'turn.failed'].includes(
          String(data.event.type),
        ));
    const capabilities = refreshCapabilities
      ? await this.inputDelivery.capabilities(input)
      : undefined;
    const mutationId = eventMutationId(input);
    let emptyCompletionDiagnostic: SessionDiagnosticRecord | undefined;
    let activityOnly = false;
    let abandonedTurns: string[] = [];
    const build = (current: CanonicalChatState): ChatCoreMutation[] => {
      activityOnly = false;
      const data = isRecord(input.data) ? input.data : {};
      let tab = current.tabsFile.tabs.find(
        (candidate) => candidate.id === input.chatId,
      );
      const archivedCandidate = tab
        ? undefined
        : current.archivesFile.archived.find(
            (entry) =>
              entry.tab.id === input.chatId && entry.tab.autoArchive === true,
          );
      const resumesArchive =
        archivedCandidate !== undefined && shouldResumeAutoArchivedChat(data);
      if (archivedCandidate) {
        tab = archivedCandidate.tab;
      }
      if (!tab || tab.kind === 'file') {
        throw new Error(`Provider event targets missing chat ${input.chatId}`);
      }
      const runtime = current.runtimeByChatId[input.chatId];
      const activeTurnUserMessageId = runtime?.activeTurn?.userMessageId;
      const providerTurnIsSettled =
        runtime !== undefined &&
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          runtime.status,
        );
      const revivesSettledProviderTurn =
        providerTurnIsSettled &&
        isSettledProviderTurnRevival(data, input.turnUserMessageId);
      const startsOrAcknowledgesTurn =
        data.type === 'canopy_user_prompt' ||
        data.type === CANOPY_USER_PROMPT_ACCEPTED_EVENT_TYPE;
      const reconcilesEmptyCompletion =
        runtime?.error?.code === 'empty_completion' &&
        activeTurnUserMessageId === input.turnUserMessageId;
      if (
        input.turnUserMessageId &&
        !startsOrAcknowledgesTurn &&
        !reconcilesEmptyCompletion &&
        !canFollowSettledProviderTurn(
          data,
          input.turnUserMessageId,
          activeTurnUserMessageId,
          tab.sdkSessionId,
        ) &&
        ((activeTurnUserMessageId !== undefined &&
          activeTurnUserMessageId !== input.turnUserMessageId) ||
          (providerTurnIsSettled && !revivesSettledProviderTurn))
      ) {
        return [];
      }
      const now = this.now();
      const succession =
        data.type === 'canopy_user_prompt' &&
        typeof data.canopy_turn_user_message_id === 'string'
          ? succeedInterruptedTurns(
              tab.interruptedTurns,
              data.canopy_turn_user_message_id,
              data.canopy_resumes_interrupted_turn === true,
            )
          : undefined;
      abandonedTurns = succession?.abandoned ?? [];
      const trustedTab = applyTrustedEventMetadata(tab, data, now);
      const eventTab =
        succession && succession.turns !== tab.interruptedTurns
          ? { ...trustedTab, interruptedTurns: succession.turns }
          : trustedTab;
      let base = transcriptState(
        eventTab,
        current.runtimeByChatId[input.chatId],
      );
      const existingPromptIndex = eventTab.messages.findIndex(
        (message) => message.id === data.canopy_turn_user_message_id,
      );
      const reordersExistingPrompt =
        data.type === 'canopy_user_prompt' &&
        existingPromptIndex >= 0 &&
        existingPromptIndex < eventTab.messages.length - 1;
      if (data.type === 'canopy_user_prompt') {
        base = {
          ...base,
          messages: mergePromptMessages(base.messages, data),
        };
      }
      let messageSequence = 0;
      const createMessageId = (): string =>
        `${input.chatId}:${mutationId}:${messageSequence++}`;
      const provider =
        input.providerType ??
        tab.providerType ??
        (tab.model ? getProviderForModel(tab.model) : 'claude');
      const reduced =
        data.type === 'claude_terminal_transcript_sync' &&
        Array.isArray(data.messages)
          ? {
              ...base,
              messages: mergePersistedMessagesById(
                base.messages,
                data.messages.filter(isPersistedChatMessage),
              ),
            }
          : data.type === 'codex' && isRecord(data.event)
            ? applyCodexTranscriptEvent(base, data.event, {
                now,
                createMessageId,
                aiCreditsRouted: tab.aiCreditsRouted,
              })
            : applyClaudeTranscriptEvent(base, data, {
                now,
                createMessageId,
                aiCreditsRouted: tab.aiCreditsRouted,
              });
      const {
        status: _status,
        error: _error,
        currentTodos: _todos,
        currentTaskTodos: _taskTodos,
        lastEventAt: _lastEventAt,
        codexThreads: _codexThreads,
        messages: reducedMessages,
        ...persistedMetadata
      } = reduced;
      void _status;
      void _error;
      void _todos;
      void _taskTodos;
      void _lastEventAt;
      void _codexThreads;
      const trustedReducedMessages = preserveProviderVisualReferences(
        tab.messages,
        reducedMessages,
      );
      const stickyPlanReview =
        Boolean(eventTab.trackedPlanId) &&
        eventTab.trackedPlanReviewStatus === 'pending';
      const pendingPlanSource =
        eventTab.pendingPlanExit?.source ?? eventTab.trackedPlanSource;
      const codexRootThreadId =
        typeof persistedMetadata.sdkSessionId === 'string'
          ? persistedMetadata.sdkSessionId
          : tab.sdkSessionId;
      const effectiveTurnUserMessageId =
        input.turnUserMessageId ??
        (typeof data.canopy_turn_user_message_id === 'string'
          ? data.canopy_turn_user_message_id
          : runtime?.activeTurn?.userMessageId);
      const turnHasVisibleOutput = effectiveTurnUserMessageId
        ? hasVisibleTurnOutput(
            trustedReducedMessages,
            effectiveTurnUserMessageId,
            eventTab.turnDiffs?.[effectiveTurnUserMessageId],
          )
        : undefined;
      const clearPendingPlanExit =
        isRootTerminalChatEventData(input.data, codexRootThreadId) &&
        !stickyPlanReview &&
        !isPlanProposal({
          ...eventTab.pendingPlanExit,
          source: pendingPlanSource,
        });
      const metadataTab: PersistedChatTab = {
        ...eventTab,
        ...persistedMetadata,
        ...(hasPlaceholderChatTitle(eventTab.title)
          ? {
              title: terminalTranscriptTitle(data) ?? eventTab.title,
              automaticTitleState:
                eventTab.automaticTitleState === 'closed'
                  ? 'closed'
                  : 'pending',
            }
          : {}),
        providerType: reduced.providerType ?? provider,
        messages: eventTab.messages,
        ...(clearPendingPlanExit ? { pendingPlanExit: undefined } : {}),
        ...(clearPendingPlanExit
          ? { pendingPlanExitRequestId: undefined }
          : {}),
      };
      // Init publishes the child's own session id. Consume the one-shot
      // source cutoff in that same durable commit: compatibility callbacks
      // run after ingestion and can already see the new id, so they cannot
      // reliably distinguish a pending fork from an initialized child.
      if (
        data.type === 'system' &&
        data.subtype === 'init' &&
        typeof data.session_id === 'string' &&
        data.session_id.length > 0 &&
        metadataTab.claudeForkSessionOnNextSend === true
      ) {
        delete metadataTab.claudeForkSessionOnNextSend;
        if (metadataTab.forkedFrom?.resumePointRequired === true) {
          metadataTab.forkedFrom = { ...metadataTab.forkedFrom };
          delete metadataTab.forkedFrom.resumePointRequired;
        }
      }
      const nextRuntime = runtimeForEvent(
        current.runtimeByChatId[tab.id],
        input.data,
        now,
        input.turnUserMessageId,
        codexRootThreadId,
        turnHasVisibleOutput,
      );
      const turnEnds = settleTurnEnds(
        metadataTab.turnEnds,
        runtime,
        nextRuntime,
        effectiveTurnUserMessageId,
        now,
      );
      if (turnEnds !== metadataTab.turnEnds) {
        if (turnEnds) metadataTab.turnEnds = turnEnds;
        else delete metadataTab.turnEnds;
      }
      // The shared reducer reopens a settled turn's timer in place; main
      // never commits that edit to settled history (see the guard).
      const messages = preserveSettledTurnTimers({
        previous: tab.messages,
        next: trustedReducedMessages,
        previousRuntime: runtime,
        nextRuntime,
        now,
        createMessageId,
      });
      if (
        isInputLedger(metadataTab.inputDelivery) &&
        isRootTerminalChatEventData(input.data, codexRootThreadId)
      )
        metadataTab.inputDelivery = settleInputExecution(
          metadataTab.inputDelivery,
          input.turnUserMessageId ?? activeTurnUserMessageId,
          nextRuntime.status,
          now,
        );
      if (archivedCandidate && !resumesArchive) {
        const updatedArchivedTab = { ...metadataTab, messages };
        return [
          {
            type: 'archive.upserted',
            entry: {
              ...archivedCandidate,
              tab: updatedArchivedTab,
              turnCount: countTurns(updatedArchivedTab),
            },
          },
        ];
      }
      const mutations: ChatCoreMutation[] = archivedCandidate
        ? [
            {
              type: 'archive.removed',
              archiveEntryId: archivedCandidate.tab.id,
              chatId: archivedCandidate.tab.id,
            },
            { type: 'tab.created', tab: archivedCandidate.tab },
          ]
        : [];
      const metadataPatch = buildTabMetadataPatch(tab, metadataTab);
      if (Object.keys(metadataPatch).length > 0) {
        mutations.push({
          type: 'tab.metadata_patched',
          tabId: tab.id,
          patch: metadataPatch,
        });
      }
      if (reordersExistingPrompt) {
        mutations.push({
          type: 'messages.replaced',
          chatId: tab.id,
          messages,
          removedMessageIds: [],
        });
      }
      const nextById = new Map(
        messages.map((message) => [message.id, message]),
      );
      const currentById = new Map(
        tab.messages.map((message) => [message.id, message]),
      );
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message) continue;
        const existing = currentById.get(message.id);
        if (
          !existing ||
          (existing !== message &&
            JSON.stringify(existing) !== JSON.stringify(message))
        ) {
          // A delegation card and its rows can update after this window or
          // a renderer page has moved on. Position them so neither storage
          // nor a client appends them to the tail. Storage ignores the
          // position for rows it already holds.
          const afterMessageId =
            messageAnchor !== undefined &&
            (message.id === messageAnchor.messageId ||
              message.parentBlockId === messageAnchor.messageId)
              ? existing
                ? (messages[index - 1]?.id ?? messageAnchor.fallbackMessageId)
                : index > 0 &&
                    messages
                      .slice(index + 1)
                      .some((later) => currentById.has(later.id))
                  ? messages[index - 1]?.id
                  : undefined
              : undefined;
          mutations.push({
            type: 'message.upserted',
            chatId: tab.id,
            message,
            ...(afterMessageId ? { afterMessageId } : {}),
          });
          if (
            !message.parentBlockId &&
            (!message.codexThreadId ||
              message.codexThreadId === codexRootThreadId)
          ) {
            for (const block of message.blocks) {
              if (block.type !== 'text' || !block.asyncQuestion) continue;
              const { requestId, questions } = block.asyncQuestion;
              // Started/completed/replayed events share one durable request.
              // Settled records are deliberately retained so replay cannot
              // make a previously answered or dismissed question actionable.
              if (
                (current.tabsFile.pendingQuestions ?? []).some(
                  (question) =>
                    question.requestId === requestId &&
                    question.chatId === tab.id,
                )
              )
                continue;
              mutations.push({
                type: 'pending_question.upserted',
                question: {
                  requestId,
                  chatId: tab.id,
                  delivery: 'async',
                  questions: questions.map((question, index) => ({
                    id: String(index),
                    question: question.title,
                    options: question.options ?? [],
                    multiSelect: false,
                    allowOther: true,
                  })),
                },
              });
            }
          }
        }
      }
      for (const existing of tab.messages) {
        if (!nextById.has(existing.id)) {
          mutations.push({
            type: 'message.removed',
            chatId: tab.id,
            messageId: existing.id,
          });
        }
      }
      if (
        nextRuntime.error?.code === 'empty_completion' &&
        nextRuntime.emptyCompletionRecovery &&
        runtime?.error?.code !== 'empty_completion'
      ) {
        emptyCompletionDiagnostic = {
          version: 1,
          timestamp: new Date(now).toISOString(),
          kind: 'empty_turn_completion',
          sessionKey: `${input.projectId}/${input.worktreeId}/${input.chatId}`,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
          providerType: provider ?? 'unknown',
          emptyCompletionTurnUserMessageId:
            nextRuntime.emptyCompletionRecovery.turnUserMessageId,
          ...(typeof data.duration_ms === 'number'
            ? { emptyCompletionDurationMs: data.duration_ms }
            : {}),
        };
      }
      const runtimePatch: ChatRuntimeState = {
        ...nextRuntime,
        ...(refreshCapabilities ? { steeringCapabilities: capabilities } : {}),
      };
      // Every commit journals and rewrites the scope indexes, so an event
      // whose only change is a fresher lastActivityAt is not committed; the
      // next other commit, or the persist interval, carries it. Turn-boundary
      // events always commit: their mutation IDs record prompt acceptance.
      if (
        mutations.length === 0 &&
        !checkpoint &&
        !refreshCapabilities &&
        isRecentActivityOnlyRuntime(runtime, runtimePatch, now)
      ) {
        activityOnly = true;
        return mutations;
      }
      mutations.push({
        type: 'runtime.patched',
        chatId: tab.id,
        runtime: runtimePatch,
      });
      return mutations;
    };
    const transactionOptions = {
      source: input.source ?? 'provider',
      mutationId,
      checkpoint,
      chatIds: [input.chatId],
      fullTranscript: data.type === 'canopy_user_prompt',
      ...(messageAnchor ? { messageAnchor } : {}),
      ...(input.onCommitQueued ? { onQueued: input.onCommitQueued } : {}),
    };
    const commit = isNativeVisualToolResultEvent(input)
      ? await this.repository.transactProviderEventWith(
          input,
          build,
          transactionOptions,
          {
            resolveToolKey: visualResolverForEvent(
              input,
              this.claudeToolNames,
              this.codexToolNames,
              this.cursorToolUse,
            ),
          },
        )
      : await this.repository.transactWith(input, build, transactionOptions);
    if (commit.applied && emptyCompletionDiagnostic) {
      try {
        this.recordDiagnostic(emptyCompletionDiagnostic);
      } catch {
        // Diagnostics are best-effort and must never change provider ingestion.
      }
    }
    if (commit.applied) {
      recordProviderEventApplied();
      for (const userMessageId of abandonedTurns) {
        this.deliverUnacceptedTurnEnd(
          { projectId: input.projectId, worktreeId: input.worktreeId },
          { chatId: input.chatId, userMessageId },
          'cancelled',
          'Interrupted by an app restart and not resumed.',
          { canopy_turn_abandoned: true },
        );
      }
      return 'applied';
    }
    return activityOnly ? 'activity-only' : 'not-applied';
  }

  /**
   * Bridge the legacy desktop send channel into main-owned state.
   *
   * A renderer can create a tab and immediately send before its revisioned
   * create command or compatibility snapshot reaches main. Provider ingestion
   * must never race that propagation. The repository-side conditional makes
   * this compare-and-create atomic with a concurrent canonical create and
   * preserves whichever writer established the tab first.
   */
  public async ensureChatForTrustedSend(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    const scope = {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
    };
    if (this.isScopeDeletionBlocking(chatScopeLifecycleKey(scope))) {
      throw new ChatScopeDeletingError();
    }
    const createdAt = new Date(this.now()).toISOString();
    const explicitTitle = explicitChatTitle(request.title);
    const title = explicitTitle ?? initialChatTitle(request.text);
    const tab: PersistedChatTab = {
      ...createPersistedChatTab({
        id: request.chatId,
        createdAt,
        title,
        ...(request.providerType ? { providerType: request.providerType } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...canonicalModelConfigField(request.modelConfig),
        ...(request.planMode ? { planMode: true } : {}),
        ...(request.codexProposalMode
          ? { proposalMode: request.codexProposalMode }
          : {}),
        ...(typeof request.deferredToolsAllowed === 'boolean'
          ? { deferredToolsAllowed: request.deferredToolsAllowed }
          : {}),
        ...(request.interfaceMode
          ? { interfaceMode: request.interfaceMode }
          : {}),
        ...(request.selectedRepoId
          ? { selectedRepoId: request.selectedRepoId }
          : {}),
      }),
      ...(explicitTitle ? { customTitle: explicitTitle } : {}),
      ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}),
      ...trustedSendDenyRulesField(request.sessionApprovalRules),
      ...(request.pluginSelections
        ? { pluginSelections: request.pluginSelections }
        : {}),
      automaticTitleState: explicitTitle ? 'closed' : 'pending',
      ...newChatPluginDefaultsStamp(request.projectId),
      ...(request.sdkSessionId ? { sdkSessionId: request.sdkSessionId } : {}),
      ...(request.codexReconstructionSeedId
        ? { codexReconstructionSeedId: request.codexReconstructionSeedId }
        : {}),
      ...(request.pendingSystemInstructions?.length
        ? { pendingSystemInstructions: request.pendingSystemInstructions }
        : {}),
      ...(request.aiCreditsRouting
        ? { aiCreditsRouting: request.aiCreditsRouting }
        : {}),
      ...(request.subscriptionBillingOverride
        ? { subscriptionBillingOverride: true }
        : {}),
    };
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const existing = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!existing) {
          if (context.hasRemovedTab(request.chatId)) {
            throw new Error(
              `Trusted send targets removed chat ${request.chatId}`,
            );
          }
          // Chats nobody asked for open behind the tab the user is on:
          // hook-started chats and sends that ask to stay behind (scheduled
          // and catch-up automation runs). Everything the user set in motion
          // comes forward as before: a Run now, a pipeline Run, a delegate,
          // the usage-limit, auth-failure, and transient-error retries, and
          // the Pull or Commit & Push resolution chat. Only a brand-new chat
          // is affected, and only while the current active tab still
          // exists; an empty scope still selects the new chat.
          const keepActiveTab =
            (request.preserveActiveTab === true ||
              request.initiationSource === 'hook') &&
            current.tabsFile.tabs.some(
              (candidate) => candidate.id === current.tabsFile.activeTabId,
            );
          return [
            { type: 'tab.created' as const, tab },
            ...(keepActiveTab
              ? []
              : [
                  {
                    type: 'tab.active_changed' as const,
                    activeTabId: request.chatId,
                  },
                ]),
          ];
        }
        const retitle =
          existing.messages.length === 0 &&
          hasPlaceholderChatTitle(existing.title) &&
          existing.title !== title;
        const name =
          explicitTitle !== undefined &&
          existing.messages.length === 0 &&
          existing.customTitle === undefined;
        const requestHarness =
          request.executionHarness ??
          (request.model
            ? getExecutionHarnessForModel(request.model)
            : undefined);
        // Advisor hydration can change an empty tab's default before its first
        // dispatch. Commit that route before the prompt makes it a chat lock.
        const synchronizeAdvisorRouting =
          request.projectId === APP_ADVISOR_PROJECT_ID &&
          (existing.transcript?.messageCount ?? existing.messages.length) ===
            0 &&
          existing.executionHarnessExplicitlyChosen !== true;
        const backfillRouting =
          request.model !== undefined &&
          requestHarness !== undefined &&
          (synchronizeAdvisorRouting ||
            (existing.model === undefined &&
              (existing.executionHarness === undefined ||
                existing.executionHarness === requestHarness)));
        const backfillApprovalMode =
          existing.approvalMode === undefined &&
          request.approvalMode !== undefined;
        if (retitle || name || backfillRouting || backfillApprovalMode) {
          return [
            {
              type: 'tab.created' as const,
              tab: {
                ...existing,
                ...(retitle ? { title } : {}),
                ...(name ? { customTitle: explicitTitle } : {}),
                ...(retitle || name
                  ? {
                      // An explicit title is a saved name and closes naming,
                      // like a rename; a placeholder stays eligible.
                      automaticTitleState:
                        explicitTitle !== undefined ||
                        existing.automaticTitleState === 'closed'
                          ? ('closed' as const)
                          : ('pending' as const),
                    }
                  : {}),
                ...(backfillRouting ? { model: request.model } : {}),
                ...(backfillRouting && request.providerType
                  ? { providerType: request.providerType }
                  : {}),
                ...(backfillRouting &&
                (synchronizeAdvisorRouting ||
                  existing.executionHarness === undefined)
                  ? { executionHarness: requestHarness }
                  : {}),
                ...(backfillRouting
                  ? canonicalModelConfigField(request.modelConfig)
                  : {}),
                ...(backfillApprovalMode
                  ? { approvalMode: request.approvalMode }
                  : {}),
              },
            },
          ];
        }
        return [];
      },
      {
        ...{
          source: 'migration',
          mutationId: `trusted-send-tab:${request.chatId}`,
        },
        chatIds: [request.chatId],
      },
    );
    await this.commitAutomationStartBanner(scope, request);
  }

  /**
   * Commits the automation banner (automation name and launch time) directly
   * ahead of an automation-initiated prompt. Renderer-driven sends (App
   * Advisor quick prompts, Cowork IPC sends, local worktree drains) persist
   * only their user message, so without this the banner existed only as the
   * renderer's optimistic copy and vanished on the canonical projection.
   *
   * The banner id is derived from the prompt's user-message id: when a main
   * send path already wrote it, or a retried trusted send committed it, it is
   * left exactly as it is, so its position and timestamp never change. A
   * prompt that is already in the transcript gets no retroactive banner.
   */
  private async commitAutomationStartBanner(
    scope: ChatScopeKey,
    request: ChatSendMessageRequest,
  ): Promise<void> {
    if (request.initiationSource !== 'automation') return;
    const bannerId = automationInfoMessageId(request.userMessageId);
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!tab || context.hasRemovedMessage(bannerId)) return [];
        if (
          tab.messages.some(
            (message) =>
              message.id === bannerId || message.id === request.userMessageId,
          )
        )
          return [];
        const banner = buildAutomationInfoMessage(
          request,
          request.userMessageId,
        );
        return banner
          ? [
              {
                type: 'message.upserted' as const,
                chatId: request.chatId,
                message: banner,
              },
            ]
          : [];
      },
      {
        source: 'automation',
        mutationId: `${request.chatId}:${request.userMessageId}:automation-info`,
        chatIds: [request.chatId],
      },
    );
  }

  public async upsertPendingQuestion(
    scope: ChatScopeKey,
    question: PersistedPendingQuestion,
  ): Promise<void> {
    await this.repository.transact(
      scope,
      [
        { type: 'pending_question.upserted', question },
        {
          type: 'runtime.patched',
          chatId: question.chatId,
          runtime: {
            status: 'awaiting_input',
            queuedMessageIds: [],
            lastActivityAt: this.now(),
          },
        },
      ],
      { source: 'provider', mutationId: `question:${question.requestId}` },
    );
    this.pendingQuestionScopes.set(question.requestId, {
      ...scope,
      chatId: question.chatId,
    });
  }

  public async consumePendingQuestion(
    scope: ChatScopeKey,
    chatId: string,
    requestId: string,
  ): Promise<void> {
    const state = await this.repository.getState(scope);
    const question = (state.tabsFile.pendingQuestions ?? []).find(
      (candidate) =>
        candidate.requestId === requestId && candidate.chatId === chatId,
    );
    if (!question) {
      this.pendingQuestionScopes.delete(requestId);
      return;
    }
    const previousRuntime = state.runtimeByChatId[chatId] ?? {
      status: 'streaming' as const,
      queuedMessageIds: [],
    };
    await this.repository.transact(
      scope,
      [
        // Answered records are retained: portal answered-question bubbles and
        // reload idempotence project from the committed `answeredAt` state.
        // Only an unanswered consume (timeout/cancel/abort) removes the record.
        ...(question.answeredAt === undefined
          ? [{ type: 'pending_question.removed', requestId, chatId } as const]
          : []),
        {
          type: 'runtime.patched',
          chatId,
          runtime: {
            ...previousRuntime,
            status:
              previousRuntime.status === 'awaiting_input'
                ? 'streaming'
                : previousRuntime.status,
            lastActivityAt: this.now(),
          },
        },
      ],
      {
        source: 'provider',
        mutationId: `question-consumed:${requestId}`,
      },
    );
    this.pendingQuestionScopes.delete(requestId);
  }

  public async answerPendingQuestion(
    requestId: string,
    answers: readonly McpQuestionAnswer[],
    dismiss = false,
  ): Promise<boolean> {
    const target = this.pendingQuestionScopes.get(requestId);
    if (!target) return false;
    const result = await this.command({
      schemaVersion: 1,
      commandId: this.createId(),
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      command: dismiss
        ? {
            type: 'chat.dismiss_question',
            chatId: target.chatId,
            questionId: requestId,
          }
        : {
            type: 'chat.answer_question',
            chatId: target.chatId,
            questionId: requestId,
            answers: [...answers],
          },
    });
    if (dismiss && result.outcome === 'applied') {
      this.pendingQuestionScopes.delete(requestId);
    }
    return result.outcome === 'applied' || result.outcome === 'already_applied';
  }

  /** Durable correlation before a trusted tool input crosses to a managed terminal. */
  public async retainTrustedTerminalInput(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    await revalidateAgentSenderRequest(request);
    if (
      !request.agentSenderProvenance ||
      request.agentSenderProvenance.acceptedInputId !== request.userMessageId
    ) {
      throw new Error('Missing trusted terminal input provenance');
    }
    // The retained inputDelivery row is the terminal path's actual host-held queue record.
    const acceptance = {
      acceptedInputId: request.userMessageId,
      disposition: 'queued' as const,
      queuedMessageId: request.userMessageId,
      acceptedAt: new Date(this.now()).toISOString(),
    };
    const receipt = agentSendAcceptanceReceipt(request, acceptance);
    await this.repository.transactWith(
      request,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (!tab || tab.readOnly)
          throw new Error('Terminal chat is no longer available');
        if (tab.inputDelivery && !isInputLedger(tab.inputDelivery))
          throw new Error('Unsupported message history version');
        const ledger = tab.inputDelivery ?? {
          version: 1 as const,
          epoch: 0,
          rows: [],
        };
        const previous = ledger.rows.find(
          (row) => row.id === request.userMessageId,
        );
        if (previous) {
          if (
            previous.payload.text !== request.text ||
            JSON.stringify(previous.payload.agentSenderProvenance) !==
              JSON.stringify(request.agentSenderProvenance) ||
            JSON.stringify(previous.payload.agentSent) !==
              JSON.stringify(request.agentSent)
          )
            throw new Error('Terminal input correlation conflict');
          if (
            previous.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            )
          )
            return [];
          if (
            previous.state !== 'queued' ||
            !previous.payload.agentSent ||
            previous.payload.agentSenderProvenance?.acceptedInputId !==
              request.userMessageId
          )
            throw new Error(
              'Terminal input is no longer available for handoff',
            );
        }
        const retained: InputRow = {
          id: request.userMessageId,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? this.now(),
          state: 'sending',
          text: request.text,
          payload: structuredClone({
            ...request,
            ...(previous
              ? {
                  agentSent: previous.payload.agentSent,
                  agentSenderProvenance: previous.payload.agentSenderProvenance,
                  hiddenContext: previous.payload.hiddenContext,
                }
              : {}),
            pendingSystemInstructions:
              request.pendingSystemInstructions ??
              tab.pendingSystemInstructions,
          }),
          settingsKey: inputSettingsKey(tab),
          currentAttemptId: request.userMessageId,
          attempts: [
            ...(previous?.attempts ?? []),
            {
              id: request.userMessageId,
              generation: 'managed-terminal',
              provider: 'claude',
              createdAt: this.now(),
            },
          ],
        };
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...ledger,
                rows: previous
                  ? ledger.rows.map((row) =>
                      row.id === retained.id ? retained : row,
                    )
                  : [...ledger.rows, retained],
              },
            },
          },
        ];
      },
      {
        source: 'provider',
        chatIds: [request.chatId],
        ...(receipt
          ? {
              mutationId: `${receipt.commandId}:agent-send-accepted`,
              commandResult: receipt,
            }
          : {}),
      },
    );
    if (receipt) reportAgentSendAccepted(request, acceptance);
  }

  /** Recover main authority when a terminal-local queue drains through native ingress. */
  public async claimRetainedTerminalAgentInputForNative(
    request: ChatSendMessageRequest,
  ): Promise<ChatSendMessageRequest> {
    const state = await this.repository.getState(request, {
      chatIds: [request.chatId],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === request.chatId,
    );
    const retainedRow = isInputLedger(tab?.inputDelivery)
      ? tab.inputDelivery.rows.find(
          (row) =>
            row.id === request.userMessageId &&
            row.payload.agentSent &&
            row.payload.agentSenderProvenance &&
            row.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            ),
        )
      : undefined;
    if (
      retainedRow &&
      (retainedRow.state === 'cancelled' ||
        retainedRow.attempts.some(
          (attempt) =>
            attempt.generation === 'managed-terminal' &&
            attempt.withdrawnAt !== undefined,
        ))
    )
      throw new Error(
        'The agent that sent this message can no longer reach this chat.',
      );
    // Delivery is proven by terminal pickup, not transcript presence: core
    // precommits agent messages before the terminal picks them up.
    const pickedUp = (row: InputRow | undefined): boolean =>
      row?.attempts.some(
        (attempt) =>
          attempt.generation === 'managed-terminal' &&
          attempt.pickedUpAt !== undefined,
      ) === true;
    if (
      !tab ||
      pickedUp(retainedRow) ||
      !retainedTerminalAgentInput(tab, request.userMessageId)
    )
      return request;
    // Shares the delayed-delivery refusal and durable withdrawal with pre-paste authorization.
    await this.authorizeRetainedTerminalAgentInputWrite(
      request,
      request.userMessageId,
    );
    let trusted: ChatSendMessageRequest | undefined;
    let originalRow: InputRow | undefined;
    await this.repository.transactWith(
      request,
      (current) => {
        const live = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        trusted = live
          ? retainedTerminalAgentInput(live, request.userMessageId)
          : undefined;
        if (!live || !trusted || !isInputLedger(live.inputDelivery))
          throw new Error(
            'The agent that sent this message can no longer reach this chat.',
          );
        originalRow = live.inputDelivery.rows.find(
          (row) => row.id === request.userMessageId,
        );
        if (pickedUp(originalRow))
          throw new Error(
            'The agent that sent this message can no longer reach this chat.',
          );
        const now = this.now();
        return [
          {
            type: 'tab.metadata_patched',
            tabId: live.id,
            patch: {
              inputDelivery: {
                ...live.inputDelivery,
                rows: live.inputDelivery.rows.map((row) =>
                  row.id === request.userMessageId
                    ? {
                        ...row,
                        revision: row.revision + 1,
                        state: 'cancelled',
                        reason: 'Superseded by native delivery',
                        attempts: row.attempts.map((attempt) =>
                          attempt.generation === 'managed-terminal'
                            ? {
                                ...attempt,
                                withdrawnAt: now,
                                turnOutcome: 'cancelled',
                                turnSettledAt: now,
                              }
                            : attempt,
                        ),
                      }
                    : row,
                ),
              },
            },
          },
        ];
      },
      { source: 'provider', chatIds: [request.chatId] },
    );
    if (!trusted)
      throw new Error(
        'The agent that sent this message can no longer reach this chat.',
      );
    // Only payload/authority fields come from retention; model/mode/approval settings remain current.
    const claimed: ChatSendMessageRequest = {
      ...request,
      text: trusted.text,
      fileReferences: trusted.fileReferences,
      attachmentPaths: trusted.attachmentPaths,
      attachmentPromptContexts: trusted.attachmentPromptContexts,
      inputMode: trusted.inputMode,
      agentSent: trusted.agentSent,
      agentSenderProvenance: trusted.agentSenderProvenance,
      hiddenContext: trusted.hiddenContext,
      initiationSource: trusted.initiationSource,
    };
    if (originalRow)
      this.nativeClaimRollback.set(claimed, {
        row: originalRow,
        revision: originalRow.revision + 1,
      });
    return claimed;
  }

  /** Restore only our provisional withdrawal, never a later user cancel or delivered input. */
  public async restoreRetainedTerminalAgentInputAfterFailedNativeAdmission(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    const rollback = this.nativeClaimRollback.get(request);
    if (!rollback) return;
    // Core precommits agent messages to the transcript, so only native
    // acceptance shows the input was delivered.
    if (
      await this.repository.hasMutation(
        request,
        `${request.chatId}:${request.userMessageId}:accepted`,
      )
    ) {
      this.nativeClaimRollback.delete(request);
      return;
    }
    await this.repository.transactWith(
      request,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        const runtime = current.runtimeByChatId[request.chatId];
        if (
          !tab ||
          !isInputLedger(tab.inputDelivery) ||
          runtime?.queuedMessages?.some(
            (message) =>
              message.request.userMessageId === request.userMessageId,
          )
        )
          return [];
        const row = tab.inputDelivery.rows.find(
          (candidate) => candidate.id === request.userMessageId,
        );
        if (
          !row ||
          row.revision !== rollback.revision ||
          row.state !== 'cancelled' ||
          row.reason !== 'Superseded by native delivery'
        )
          return [];
        return [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((candidate) =>
                  candidate.id === row.id
                    ? { ...rollback.row, revision: row.revision + 1 }
                    : candidate,
                ),
              },
            },
          },
        ];
      },
      { source: 'provider', chatIds: [request.chatId] },
    );
    this.nativeClaimRollback.delete(request);
  }

  /** Existing queue-cancel compatibility for renderer-local terminal inputs. */
  public async cancelRetainedTerminalAgentInput(
    target: ChatScopeKey & { chatId: string },
    entryId: string,
  ): Promise<'applied' | 'not_found'> {
    let outcome: 'applied' | 'not_found' = 'not_found';
    let endedTurn = false;
    const commit = await this.repository.transactWith(
      target,
      (current) => {
        outcome = 'not_found';
        endedTurn = false;
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === target.chatId,
        );
        if (!tab || !isInputLedger(tab.inputDelivery)) return [];
        const row = tab.inputDelivery.rows.find(
          (candidate) =>
            candidate.id === entryId &&
            candidate.attempts.some(
              (attempt) => attempt.generation === 'managed-terminal',
            ),
        );
        const existingMessage = tab.messages.find(
          (message) => message.id === entryId,
        );
        const agentInput =
          row?.payload.agentSenderProvenance &&
          row.payload.userMessageId === row.id;
        // A superseded row went to native delivery; once its prompt is in
        // the transcript or its turn runs, a late cancel must not undo it.
        const nativelyDelivered =
          row?.state === 'cancelled' &&
          row.reason === 'Superseded by native delivery' &&
          (existingMessage !== undefined ||
            current.runtimeByChatId[target.chatId]?.activeTurn
              ?.userMessageId === entryId);
        // Core sends precommit agent messages before the terminal picks them up.
        const delivered = agentInput
          ? nativelyDelivered ||
            row.attempts.some(
              (attempt) =>
                attempt.id === row.currentAttemptId &&
                attempt.generation === 'managed-terminal' &&
                attempt.pickedUpAt !== undefined,
            )
          : existingMessage !== undefined;
        if (
          !row ||
          delivered ||
          (row.state === 'cancelled' &&
            row.reason !== 'Superseded by native delivery') ||
          row.state === 'picked-up'
        )
          return [];
        const now = this.now();
        outcome = 'applied';
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((candidate) =>
                  candidate.id === row.id
                    ? {
                        ...candidate,
                        revision: candidate.revision + 1,
                        state: 'cancelled',
                        reason: 'Cancelled before delivery',
                        attempts: candidate.attempts.map((attempt) =>
                          attempt.generation === 'managed-terminal'
                            ? {
                                ...attempt,
                                withdrawnAt: attempt.withdrawnAt ?? now,
                                turnOutcome: 'cancelled',
                                turnSettledAt: now,
                              }
                            : attempt,
                        ),
                      }
                    : candidate,
                ),
              },
            },
          },
        ];
        if (agentInput && existingMessage) {
          mutations.push({
            type: 'message.removed',
            chatId: tab.id,
            messageId: entryId,
          });
        }
        // End the cancelled input's turn so watchers bound to it settle.
        if (
          tab.turnEnds?.[entryId] === undefined &&
          tab.unacceptedTurnEnds?.[entryId] === undefined
        ) {
          mutations.push(recordUnacceptedTurnEnd(tab, entryId, 'cancelled'));
          endedTurn = true;
        }
        return mutations;
      },
      { source: 'renderer-command', chatIds: [target.chatId] },
    );
    if (endedTurn && commit.applied)
      this.deliverUnacceptedTurnEnd(
        target,
        { chatId: target.chatId, userMessageId: entryId },
        'cancelled',
        'Cancelled',
      );
    return outcome;
  }

  /** Revalidate delayed terminal input immediately before a paste crosses to the worker. */
  public async authorizeRetainedTerminalAgentInputWrite(
    target: ChatScopeKey & { chatId: string },
    acceptedInputId: string,
  ): Promise<void> {
    const refusal =
      'The agent that sent this message can no longer reach this chat.';
    const withdrawn = (tab: PersistedChatTab | undefined): boolean => {
      const row = isInputLedger(tab?.inputDelivery)
        ? tab.inputDelivery.rows.find(
            (candidate) => candidate.id === acceptedInputId,
          )
        : undefined;
      return (
        row?.payload.agentSent !== undefined &&
        row.payload.agentSenderProvenance?.acceptedInputId ===
          acceptedInputId &&
        row.payload.userMessageId === acceptedInputId &&
        row.payload.chatId === target.chatId &&
        row.payload.hiddenContext?.kind === 'agent-sender-context' &&
        row.attempts.some(
          (attempt) =>
            attempt.generation === 'managed-terminal' &&
            attempt.withdrawnAt !== undefined,
        )
      );
    };
    const state = await this.repository.getState(target, {
      chatIds: [target.chatId],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    if (withdrawn(tab)) throw new Error(refusal);
    const payload = tab
      ? retainedTerminalAgentInput(tab, acceptedInputId)
      : undefined;
    if (!payload) return;
    try {
      await withAgentSenderAuthority(
        payload,
        () => undefined,
        revalidateAgentSenderRequest,
      );
    } catch (error) {
      const refusalError = new AgentSenderContextError(
        isAgentSenderContextError(error)
          ? error.code
          : 'owner_context_unavailable',
        refusal,
      );
      const reason = isAgentSenderContextError(error)
        ? `agent_send:${error.code === 'authorization_conflict' ? 'owner_boundary' : error.code}`
        : 'agent_send:owner_context_unavailable';
      let endedTurn = false;
      try {
        const commit = await this.repository.transactWith(
          target,
          (current) => {
            endedTurn = false;
            const live = current.tabsFile.tabs.find(
              (candidate) => candidate.id === target.chatId,
            );
            if (!live || !isInputLedger(live.inputDelivery)) return [];
            const now = this.now();
            const mutations: ChatCoreMutation[] = [
              {
                type: 'tab.metadata_patched',
                tabId: live.id,
                patch: {
                  inputDelivery: {
                    ...live.inputDelivery,
                    rows: live.inputDelivery.rows.map((candidate) =>
                      candidate.id === acceptedInputId
                        ? {
                            ...candidate,
                            state: 'cancelled',
                            revision: candidate.revision + 1,
                            reason,
                            attempts: candidate.attempts.map((attempt) =>
                              attempt.generation === 'managed-terminal'
                                ? {
                                    ...attempt,
                                    withdrawnAt: attempt.withdrawnAt ?? now,
                                    turnOutcome: 'cancelled',
                                    turnSettledAt: now,
                                  }
                                : attempt,
                            ),
                          }
                        : candidate,
                    ),
                  },
                },
              },
            ];
            // The refused input never runs; end its turn so bound watchers settle.
            if (
              live.inputDelivery.rows.some(
                (candidate) => candidate.id === acceptedInputId,
              ) &&
              live.turnEnds?.[acceptedInputId] === undefined &&
              live.unacceptedTurnEnds?.[acceptedInputId] === undefined
            ) {
              mutations.push(
                recordUnacceptedTurnEnd(live, acceptedInputId, 'cancelled'),
              );
              endedTurn = true;
            }
            return mutations;
          },
          { source: 'provider', chatIds: [target.chatId] },
        );
        if (endedTurn && commit.applied)
          this.deliverUnacceptedTurnEnd(
            target,
            { chatId: target.chatId, userMessageId: acceptedInputId },
            'cancelled',
            'Cancelled',
          );
      } catch {
        throw refusalError;
      }
      throw refusalError;
    }
    // A cancel may commit while validation awaits. An empty transaction orders
    // this read after it; the caller writes in this continuation.
    let withdrawnDuringValidation = false;
    await this.repository.transactWith(
      target,
      (current) => {
        withdrawnDuringValidation = withdrawn(
          current.tabsFile.tabs.find(
            (candidate) => candidate.id === target.chatId,
          ),
        );
        return [];
      },
      { source: 'provider', chatIds: [target.chatId] },
    );
    if (withdrawnDuringValidation) throw new Error(refusal);
  }

  /** Canonical edit for a trusted terminal input still waiting in a renderer queue. */
  public async editRetainedTerminalAgentInput(
    request: ChatQueueEditRequest,
  ): Promise<'applied' | 'not_found'> {
    assertUntrustedChatInput(request);
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.chatId, 'chatId');
    validateId(request.entryId, 'entryId');
    if (typeof request.text !== 'string')
      throw new Error('Queued message text must be a string.');
    let outcome: 'applied' | 'not_found' = 'not_found';
    await this.repository.transactWith(
      request,
      (current) => {
        const ownerTab = current.tabsFile.tabs.find(
          (candidate) =>
            isInputLedger(candidate.inputDelivery) &&
            candidate.inputDelivery.rows.some(
              (row) =>
                row.id === request.entryId &&
                row.attempts.some(
                  (attempt) => attempt.generation === 'managed-terminal',
                ),
            ),
        );
        if (!ownerTab) return [];
        const tab = ownerTab.id === request.chatId ? ownerTab : undefined;
        const payload = tab
          ? retainedTerminalAgentInput(tab, request.entryId)
          : undefined;
        const row =
          tab && isInputLedger(tab.inputDelivery)
            ? tab.inputDelivery.rows.find(
                (candidate) => candidate.id === request.entryId,
              )
            : undefined;
        const existingMessage = tab?.messages.find(
          (message) => message.id === request.entryId,
        );
        const agentInput =
          row?.payload.agentSenderProvenance &&
          row.payload.userMessageId === row.id;
        const delivered = agentInput
          ? row.state === 'picked-up' ||
            row.attempts.some(
              (attempt) =>
                attempt.id === row.currentAttemptId &&
                attempt.generation === 'managed-terminal' &&
                attempt.pickedUpAt !== undefined,
            )
          : existingMessage !== undefined;
        if (
          !tab ||
          tab.readOnly ||
          !payload ||
          !isInputLedger(tab.inputDelivery) ||
          delivered ||
          payload.projectId !== request.projectId ||
          payload.worktreeId !== request.worktreeId
        ) {
          throw new Error(
            'The retained terminal agent input is no longer editable.',
          );
        }
        outcome = 'applied';
        const editedPayload: ChatSendMessageRequest = {
          ...payload,
          text: request.text,
          fileReferences: request.fileReferences,
          attachmentPaths: request.attachmentPaths,
          attachmentPromptContexts: request.attachmentPromptContexts,
          ...(request.inputMode ? { inputMode: request.inputMode } : {}),
        };
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((row) =>
                  row.id === request.entryId
                    ? {
                        ...row,
                        revision: row.revision + 1,
                        text: request.text,
                        payload: editedPayload,
                      }
                    : row,
                ),
              },
            },
          },
        ];
        if (agentInput && existingMessage) {
          mutations.push({
            type: 'message.upserted',
            chatId: tab.id,
            message: buildUserMessage(editedPayload, existingMessage.timestamp),
          });
        }
        return mutations;
      },
      { source: 'renderer-command', chatIds: [request.chatId] },
    );
    return outcome;
  }

  public async reconcileHostQueue(
    scope: ChatScopeKey & { chatId: string },
    queuedMessageIds: readonly string[],
    turnActive: boolean,
    mutation?: ChatQueuePersistenceMutation,
    queuedMessages?: readonly PersistedHostQueuedMessage[],
    activeTurnUserMessageId?: string,
  ): Promise<void> {
    const loaded = await this.repository.getState(scope, {
      chatIds: [scope.chatId],
    });
    const setupEnds: UnacceptedTurnEnd[] =
      mutation?.type === 'end-setup-held'
        ? mutation.requests.map((request) => ({
            userMessageId: request.userMessageId,
            startedAt: this.now(),
            outcome: mutation.outcome,
            reason: WORKTREE_SETUP_FAILED,
          }))
        : [];
    const deliverSetupEnds = (): void => {
      for (const end of setupEnds) {
        this.deliverUnacceptedTurnEnd(
          scope,
          { chatId: scope.chatId, userMessageId: end.userMessageId },
          end.outcome,
          end.reason,
        );
      }
    };
    if (
      !loaded.tabsFile.tabs.some(
        (candidate) =>
          candidate.id === scope.chatId && candidate.kind !== 'file',
      )
    ) {
      if (mutation?.type === 'cancel') {
        this.deliverUnacceptedTurnEnd(
          scope,
          {
            chatId: scope.chatId,
            userMessageId: mutation.request.userMessageId,
          },
          'cancelled',
          'Cancelled',
        );
      }
      deliverSetupEnds();
      return;
    }
    // Set by the transaction when settling a dropped agent input ends its turn.
    let settledAgentInputEnd = false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        settledAgentInputEnd = false;
        const previous = current.runtimeByChatId[scope.chatId] ?? {
          status: 'idle' as const,
          queuedMessageIds: [],
        };
        const reconciled: ChatRuntimeState = {
          ...previous,
          status:
            !turnActive && queuedMessageIds.length > 0
              ? 'queued'
              : previous.status === 'queued'
                ? 'idle'
                : previous.status,
          queuedMessageIds: [...queuedMessageIds],
          queuedMessages: queuedMessages ? [...queuedMessages] : [],
          ...(turnActive && activeTurnUserMessageId
            ? {
                activeTurn:
                  previous.activeTurn?.userMessageId === activeTurnUserMessageId
                    ? previous.activeTurn
                    : {
                        userMessageId: activeTurnUserMessageId,
                        startedAt: previous.activeTurn?.startedAt ?? this.now(),
                      },
              }
            : {}),
          lastActivityAt: this.now(),
          ...(mutation?.type === 'cancel' && mutation.lastErrorMessage
            ? {
                error: {
                  code: 'cancelled',
                  message: mutation.lastErrorMessage,
                  retryable: false,
                  occurredAt: new Date(this.now()).toISOString(),
                },
              }
            : {}),
        };
        const setupTab =
          setupEnds.length > 0
            ? current.tabsFile.tabs.find((t) => t.id === scope.chatId)
            : undefined;
        const ended = setupTab
          ? recordUnacceptedTurnEnds(
              setupTab,
              reconciled,
              setupEnds,
              this.now(),
            )
          : undefined;
        const mutations: ChatCoreMutation[] = [
          {
            type: 'runtime.patched',
            chatId: scope.chatId,
            runtime: ended?.runtime ?? reconciled,
          },
          ...(ended?.mutations ?? []),
        ];
        if (mutation?.type === 'agent-send-accepted') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          if (!tab || (tab.inputDelivery && !isInputLedger(tab.inputDelivery)))
            throw new Error('Agent input ledger is unavailable');
          const ledger = tab.inputDelivery ?? {
            version: 1 as const,
            epoch: 0,
            rows: [],
          };
          if (
            !ledger.rows.some(
              (row) => row.id === mutation.request.userMessageId,
            )
          ) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: tab.id,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: [
                    ...ledger.rows,
                    {
                      id: mutation.request.userMessageId,
                      revision: 1,
                      createdAt: Date.parse(mutation.acceptance.acceptedAt),
                      state: 'queued',
                      text: mutation.request.text,
                      payload: structuredClone(mutation.request),
                      settingsKey: inputSettingsKey(tab),
                      attempts: [],
                    },
                  ],
                },
              },
            });
          }
        }
        if (mutation?.type === 'restore-input') {
          const tab = current.tabsFile.tabs.find((t) => t.id === scope.chatId);
          const ledger = tab?.inputDelivery;
          const row = ledger?.rows.find((r) => r.id === mutation.rowId);
          if (
            !isInputLedger(ledger) ||
            ledger.epoch !== mutation.epoch ||
            !row ||
            !['cancelled', 'editing'].includes(row.state)
          )
            throw new Error('The input is no longer available to queue');
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: scope.chatId,
            patch: {
              inputDelivery: {
                ...ledger,
                rows: ledger.rows.map((r) =>
                  r.id === row.id
                    ? {
                        ...r,
                        state: 'queued',
                        revision: r.revision + 1,
                        text: mutation.request.text,
                        payload: mutation.request,
                        draft: undefined,
                        queueIntent: undefined,
                      }
                    : r,
                ),
              },
            },
          });
        }
        const restoredAsyncQuestionId =
          mutation?.type === 'edit'
            ? mutation.restoredAsyncQuestionId
            : mutation?.type === 'cancel'
              ? mutation.request.asyncQuestionId
              : undefined;
        if (restoredAsyncQuestionId) {
          const answeredQuestion = (
            current.tabsFile.pendingQuestions ?? []
          ).find(
            (question) =>
              question.requestId === restoredAsyncQuestionId &&
              question.chatId === scope.chatId &&
              question.delivery === 'async' &&
              question.answeredAt !== undefined,
          );
          if (answeredQuestion) {
            const {
              answeredAt: _answeredAt,
              answers: _answers,
              dismissedAt: _dismissedAt,
              ...pendingQuestion
            } = answeredQuestion;
            void _answeredAt;
            void _answers;
            void _dismissedAt;
            mutations.push({
              type: 'pending_question.upserted',
              question: pendingQuestion,
            });
          }
        }
        if (mutation?.type === 'edit') {
          const editedTab = current.tabsFile.tabs.find(
            (tab) => tab.id === scope.chatId,
          );
          const ledger = editedTab?.inputDelivery;
          if (
            isInputLedger(ledger) &&
            ledger.rows.some(
              (row) =>
                row.id === mutation.request.userMessageId &&
                row.payload.agentSenderProvenance &&
                row.state !== 'picked-up',
            )
          ) {
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: ledger.rows.map((row) =>
                    row.id === mutation.request.userMessageId &&
                    row.state !== 'picked-up'
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'queued',
                          text: mutation.request.text,
                          payload: {
                            ...mutation.request,
                            agentSent: row.payload.agentSent,
                            agentSenderProvenance:
                              row.payload.agentSenderProvenance,
                            hiddenContext: row.payload.hiddenContext,
                          },
                        }
                      : row,
                  ),
                },
              },
            });
          }
          const existingMessage = current.tabsFile.tabs
            .find((tab) => tab.id === scope.chatId)
            ?.messages.find(
              (message) => message.id === mutation.request.userMessageId,
            );
          // Local host-queued prompts enter the transcript at dispatch. An
          // edit must only update a prompt that was already persisted.
          if (existingMessage) {
            mutations.push({
              type: 'message.upserted',
              chatId: scope.chatId,
              message: buildUserMessage(
                mutation.request,
                existingMessage.timestamp,
              ),
            });
          }
        } else if (mutation?.type === 'settle-agent-input') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          const ledger = tab?.inputDelivery;
          const userMessageId = mutation.request.userMessageId;
          if (
            tab &&
            isInputLedger(ledger) &&
            ledger.rows.some(
              (row) =>
                row.id === userMessageId &&
                row.state === 'queued' &&
                row.payload.agentSenderProvenance !== undefined,
            )
          ) {
            const now = this.now();
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...ledger,
                  rows: ledger.rows.map((row) =>
                    row.id === userMessageId
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'cancelled',
                          reason: mutation.reason,
                          attempts: row.attempts.map((attempt) =>
                            attempt.pickedUpAt === undefined
                              ? {
                                  ...attempt,
                                  withdrawnAt: attempt.withdrawnAt ?? now,
                                  turnOutcome: 'failed',
                                  turnSettledAt: now,
                                }
                              : attempt,
                          ),
                        }
                      : row,
                  ),
                },
              },
            });
            // The dropped input never runs: end its turn so watchers bound to
            // it settle, unless dispatch already recorded that turn's end.
            if (
              tab.turnEnds?.[userMessageId] === undefined &&
              tab.unacceptedTurnEnds?.[userMessageId] === undefined
            ) {
              mutations.push(
                recordUnacceptedTurnEnd(tab, userMessageId, 'failed'),
              );
              settledAgentInputEnd = true;
            }
          }
        } else if (mutation?.type === 'cancel') {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === scope.chatId,
          );
          const ledger = tab?.inputDelivery;
          const agentRow = isInputLedger(ledger)
            ? ledger.rows.find(
                (row) =>
                  row.id === mutation.request.userMessageId &&
                  row.payload.agentSenderProvenance !== undefined,
              )
            : undefined;
          // An agent acceptance row must settle on every cancel, or active-input
          // lookups keep reporting the removed input as pending.
          if (
            (mutation.lastErrorMessage || agentRow) &&
            isInputLedger(tab?.inputDelivery)
          ) {
            const now = this.now();
            mutations.push({
              type: 'tab.metadata_patched',
              tabId: scope.chatId,
              patch: {
                inputDelivery: {
                  ...tab.inputDelivery,
                  rows: tab.inputDelivery.rows.map((row) =>
                    row.id === mutation.request.userMessageId &&
                    row.state !== 'picked-up'
                      ? {
                          ...row,
                          revision: row.revision + 1,
                          state: 'cancelled',
                          reason: mutation.agentSendRefusalCode
                            ? `agent_send:${mutation.agentSendRefusalCode}`
                            : (mutation.lastErrorMessage ?? 'cancelled'),
                          attempts: row.attempts.map((attempt) =>
                            attempt.pickedUpAt === undefined
                              ? {
                                  ...attempt,
                                  withdrawnAt: attempt.withdrawnAt ?? now,
                                  turnOutcome: 'cancelled',
                                  turnSettledAt: now,
                                }
                              : attempt,
                          ),
                        }
                      : row,
                  ),
                },
              },
            });
          }
          mutations.push(
            {
              type: 'message.removed',
              chatId: scope.chatId,
              messageId: mutation.request.userMessageId,
            },
            ...(tab
              ? [
                  recordUnacceptedTurnEnd(
                    tab,
                    mutation.request.userMessageId,
                    'cancelled',
                  ),
                ]
              : []),
          );
        }
        return mutations;
      },
      {
        ...(mutation?.type !== 'end-setup-held' && mutation?.commandResult
          ? {
              source: 'renderer-command',
              mutationId:
                mutation.type === 'agent-send-accepted'
                  ? `${mutation.commandResult.commandId}:agent-send-accepted`
                  : mutation.commandResult.commandId,
              commandResult: mutation.commandResult,
            }
          : { source: 'automation' }),
        ...(setupEnds.length > 0 ? { checkpoint: true } : {}),
        chatIds: [scope.chatId],
      },
    );
    if (mutation?.type === 'cancel' && commit.applied) {
      this.deliverUnacceptedTurnEnd(
        scope,
        { chatId: scope.chatId, userMessageId: mutation.request.userMessageId },
        'cancelled',
        'Cancelled',
      );
    }
    if (
      mutation?.type === 'settle-agent-input' &&
      settledAgentInputEnd &&
      commit.applied
    ) {
      this.deliverUnacceptedTurnEnd(
        scope,
        { chatId: scope.chatId, userMessageId: mutation.request.userMessageId },
        'failed',
        mutation.reason,
      );
    }
    if (commit.applied) deliverSetupEnds();
  }

  public endDiscardedQueuedTurns(
    target: ChatScopeKey & { chatId: string },
    requests: readonly Pick<ChatSendMessageRequest, 'userMessageId'>[],
  ): void {
    for (const request of requests) {
      this.deliverUnacceptedTurnEnd(
        target,
        { chatId: target.chatId, userMessageId: request.userMessageId },
        'cancelled',
        'Cancelled',
      );
    }
  }

  /** Trusted rejected-startup fallback when transcript error recording failed. */
  public async settleRejectedStartup(
    target: ChatScopeKey & { chatId: string },
    message: string,
  ): Promise<void> {
    const snapshot = await this.repository.getState(target, {
      chatIds: [target.chatId],
    });
    const observed = snapshot.runtimeByChatId[target.chatId];
    if (observed?.status !== 'starting') return;
    const userMessageId = observed.activeTurn?.userMessageId;
    if (
      userMessageId &&
      (await this.repository.hasMutation(
        target,
        `${target.chatId}:${userMessageId}:accepted`,
      ))
    )
      return;
    await this.repository.transactWith(
      target,
      (current) => {
        const runtime = current.runtimeByChatId[target.chatId];
        // Acceptance or another commit after the observation must never be
        // overwritten by startup rollback. Ordinary close guards still apply.
        if (
          current.tabsFile.revision !== snapshot.tabsFile.revision ||
          runtime?.status !== 'starting'
        )
          return [];
        return [
          {
            type: 'runtime.patched',
            chatId: target.chatId,
            runtime: runtimeForEvent(
              runtime,
              { type: 'error', error: message },
              this.now(),
            ),
          },
        ];
      },
      { source: 'automation', chatIds: [target.chatId] },
    );
  }

  public async removeUnacceptedUserPrompt(
    input: ChatScopeKey & {
      chatId: string;
      userMessageId: string;
    },
  ): Promise<void> {
    await this.repository.transactWith(
      input,
      (current) => {
        const message = current.tabsFile.tabs
          .find((tab) => tab.id === input.chatId)
          ?.messages.find((candidate) => candidate.id === input.userMessageId);
        if (!message) return [];
        return [
          {
            type: 'message.removed',
            chatId: input.chatId,
            messageId: input.userMessageId,
          },
        ];
      },
      {
        source: 'automation',
        mutationId: `${input.chatId}:${input.userMessageId}:prompt-rejected`,
        chatIds: [input.chatId],
      },
    );
  }

  public async replaceCompatibilityTabs(
    scope: ChatScopeKey,
    tabsFile: ChatTabsFile,
    options?: {
      changedTabIds?: readonly string[];
      removedTabIds?: readonly string[];
      activeTabId?: string;
      authoritative?: boolean;
      beforePublish?: () => void;
      preparePublish?: () => Promise<void>;
    },
  ): Promise<ChatTabsFile> {
    const state = await this.repository.replaceCompatibilityTabs(
      scope,
      tabsFile,
      {
        ...(options?.changedTabIds
          ? { changedTabIds: options.changedTabIds }
          : {}),
        ...(options?.removedTabIds
          ? { removedTabIds: options.removedTabIds }
          : {}),
        ...(options?.activeTabId ? { activeTabId: options.activeTabId } : {}),
        ...(options?.authoritative ? { authoritative: true } : {}),
        ...(options?.beforePublish
          ? { beforePublish: options.beforePublish }
          : {}),
        ...(options?.preparePublish
          ? { preparePublish: options.preparePublish }
          : {}),
        source: 'migration',
      },
    );
    return state.tabsFile;
  }

  /** Commit recovery metadata and its one transcript row under the canonical lease. */
  public async compareAndSetMcpActivation(
    scope: McpActivationScope,
    expected: McpActivationRecord | undefined,
    next: McpActivationRecord,
  ): Promise<boolean> {
    const record = mcpActivationRecordSchema.parse(next);
    const messageId = mcpActivationMessageId(record.originatingMessageId);
    let updated = false;
    await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === scope.chatId,
        );
        if (
          !tab ||
          tab.kind === 'file' ||
          tab.readOnly ||
          !isDeepStrictEqual(
            readMcpActivationRecord(tab.mcpActivation),
            expected,
          )
        )
          return [];
        const removed =
          context.hasRemovedMessage(messageId, scope.chatId) ||
          context.hasRemovedMessage(record.originatingMessageId, scope.chatId);
        // A removed task cannot restart. Its existing attempt must still be
        // cancellable and admission must remain reconcilable after a crash.
        if (
          removed &&
          (!expected ||
            expected.activationId !== record.activationId ||
            expected.attemptId !== record.attemptId ||
            expected.originatingMessageId !== record.originatingMessageId ||
            !['cancelled', 'failed', 'completed'].includes(record.phase))
        )
          return [];
        const mutations: ChatCoreMutation[] = [
          {
            type: 'tab.metadata_patched',
            tabId: scope.chatId,
            patch: { mcpActivation: record },
          },
        ];
        if (!removed) {
          const previous = tab.messages.find(
            (message) => message.id === messageId,
          );
          mutations.push({
            type: 'message.upserted',
            chatId: scope.chatId,
            message: {
              id: messageId,
              role: 'system',
              timestamp: previous?.timestamp ?? this.now(),
              blocks: [{ type: 'mcp_activation', record }],
            },
          });
        }
        updated = true;
        return mutations;
      },
      {
        source: 'migration',
        chatIds: [scope.chatId],
        messageAnchor: {
          messageId,
          fallbackMessageId: record.originatingMessageId,
        },
      },
    );
    return updated;
  }

  /** Atomically update one compatibility tab against the latest canonical state. */
  public async updateCompatibilityTab(
    scope: ChatScopeKey,
    chatId: string,
    update: (
      tab: PersistedChatTab,
      runtime: ChatRuntimeState | undefined,
    ) => PersistedChatTab | null,
    mutationId?: string,
    options?: { metadataOnly?: boolean },
  ): Promise<{ tabsFile: ChatTabsFile; updated: boolean }> {
    let updated = false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (!tab) return [];
        const nextTab = update(tab, current.runtimeByChatId[chatId]);
        if (!nextTab) return [];
        updated = true;
        return [{ type: 'tab.created', tab: nextTab }];
      },
      {
        ...{
          source: 'migration',
          ...(mutationId ? { mutationId } : {}),
        },
        ...(options?.metadataOnly
          ? {}
          : { chatIds: [chatId], fullTranscript: true }),
      },
    );
    return { tabsFile: commit.state.tabsFile, updated };
  }

  /** Atomically merge a compatibility tabs file against canonical state. */
  public async updateCompatibilityTabs(
    scope: ChatScopeKey,
    update: (tabsFile: ChatTabsFile) => ChatTabsFile,
    mutationId?: string,
    transcriptChatIds?: readonly string[],
  ): Promise<ChatTabsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const incoming = update(current.tabsFile);
        const currentById = new Map(
          current.tabsFile.tabs.map((tab) => [tab.id, tab]),
        );
        const mutations: ChatCoreMutation[] = incoming.tabs
          .filter((tab) => !isDeepStrictEqual(currentById.get(tab.id), tab))
          .map((tab) => ({ type: 'tab.created' as const, tab }));
        if (mutations.length > 0) {
          mutations.push({
            type: 'tab.order_changed',
            tabIds: incoming.tabs.map(({ id }) => id),
          });
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: incoming.activeTabId,
            ...(incoming.lastActiveEditableChatId
              ? { lastActiveEditableChatId: incoming.lastActiveEditableChatId }
              : {}),
            ...(incoming.lastActiveChatProvider
              ? { lastActiveChatProvider: incoming.lastActiveChatProvider }
              : {}),
          });
        }
        if (incoming.pendingQuestions !== undefined) {
          const remaining = new Map(
            (current.tabsFile.pendingQuestions ?? []).map((question) => [
              question.requestId,
              question,
            ]),
          );
          for (const question of incoming.pendingQuestions) {
            if (!isDeepStrictEqual(remaining.get(question.requestId), question))
              mutations.push({ type: 'pending_question.upserted', question });
            remaining.delete(question.requestId);
          }
          for (const question of Array.from(remaining.values()))
            mutations.push({
              type: 'pending_question.removed',
              requestId: question.requestId,
              chatId: question.chatId,
            });
        }
        return mutations;
      },
      {
        source: 'migration',
        ...(mutationId ? { mutationId } : {}),
        ...(transcriptChatIds ? { chatIds: transcriptChatIds } : {}),
      },
    );
    return commit.state.tabsFile;
  }

  /** Retire a review before its tracked plan is revised in the plan store. */
  public async retirePlanReview(request: {
    projectId: string;
    worktreeId: string;
    chatId: string;
    planId: string;
    expectedUserMessageId?: string;
    isCurrent: () => boolean;
  }): Promise<boolean> {
    let retired = false;
    const commit = await this.repository.transactWith(
      { projectId: request.projectId, worktreeId: request.worktreeId },
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === request.chatId,
        );
        if (
          !tab ||
          tab.kind === 'file' ||
          !tab.planMode ||
          tab.trackedPlanSource !== 'opencode' ||
          tab.trackedPlanId !== request.planId ||
          !request.isCurrent() ||
          (request.expectedUserMessageId !== undefined &&
            current.runtimeByChatId[request.chatId]?.activeTurn
              ?.userMessageId !== request.expectedUserMessageId)
        )
          return [];
        const pendingSystemInstructions = tab.pendingSystemInstructions?.filter(
          (instruction) =>
            instruction.id !== `plan-file-location:${request.planId}`,
        );
        retired = true;
        return [
          {
            type: 'tab.created',
            tab: {
              ...tab,
              pendingPlanExit: undefined,
              pendingPlanExitRequestId: undefined,
              trackedPlanId: undefined,
              trackedPlanSource: undefined,
              trackedPlanReviewStatus: undefined,
              latestRevisionNumber: undefined,
              hasOutstandingProposal: false,
              pendingSystemInstructions: pendingSystemInstructions?.length
                ? pendingSystemInstructions
                : undefined,
            },
          },
        ];
      },
      {
        source: 'provider',
        mutationId: `retire-plan-review-${this.createId()}`,
      },
    );
    return commit.applied && retired;
  }

  /** Persist every durable field that the renderer projects for plan review. */
  public async commitPlanExit(
    event: PlanExitRequestEvent,
    guard?: {
      requirePlanMode?: boolean;
      expectedUserMessageId?: string;
      isCurrent?: () => boolean;
    },
  ): Promise<boolean> {
    const commit = await this.repository.transactWith(
      { projectId: event.projectId, worktreeId: event.worktreeId },
      (current) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === event.chatId,
        );
        if (!tab || tab.kind === 'file' || tab.readOnly)
          throw new Error('The plan chat is no longer available.');
        if (
          event.turnUserMessageId !== undefined &&
          current.runtimeByChatId[event.chatId]?.activeTurn?.userMessageId !==
            event.turnUserMessageId
        )
          throw new Error('The plan turn has been superseded.');
        if (guard?.isCurrent && !guard.isCurrent()) return [];
        if (guard?.requirePlanMode && !tab.planMode) return [];
        if (
          guard?.expectedUserMessageId !== undefined &&
          current.runtimeByChatId[event.chatId]?.activeTurn?.userMessageId !==
            guard.expectedUserMessageId
        )
          return [];
        return [
          {
            type: 'tab.created',
            tab: {
              ...tab,
              pendingPlanExit: {
                ...event.toolInput,
                ...(event.source ? { source: event.source } : {}),
                ...(event.reviewMode ? { reviewMode: event.reviewMode } : {}),
              },
              pendingPlanExitRequestId: event.requestId,
              pendingSystemInstructions: event.pendingSystemInstructions?.length
                ? event.pendingSystemInstructions
                : undefined,
              trackedPlanReviewStatus: 'pending',
              ...(event.reviewMode === 'proposal'
                ? { hasOutstandingProposal: true }
                : {}),
              ...(event.planId ? { trackedPlanId: event.planId } : {}),
              ...(event.source ? { trackedPlanSource: event.source } : {}),
              ...(event.revisionNumber !== undefined
                ? { latestRevisionNumber: event.revisionNumber }
                : {}),
              attentionDismissedAt: undefined,
            },
          },
        ];
      },
      {
        source: 'provider',
        mutationId: `plan-exit-${event.requestId}`,
      },
    );
    return commit.state.tabsFile.tabs.some(
      (tab) =>
        tab.id === event.chatId &&
        tab.pendingPlanExitRequestId === event.requestId,
    );
  }

  public async consumeTranscript<T>(
    scope: ChatScopeKey,
    chatId: string,
    fullOutputs: boolean,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
    options?: TranscriptConsumeOptions,
  ): Promise<T> {
    return this.repository.consumeTranscript(
      scope,
      chatId,
      fullOutputs,
      consume,
      options,
    );
  }

  /** Search-only preview projection; the repository releases its scope writer
   * before the consumer builds text from pinned transcript handles.
   */
  public async consumeTranscriptPreview<T>(
    scope: ChatScopeKey,
    chatId: string,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
      descriptor: TranscriptDescriptor,
      read: TranscriptPreviewRead,
    ) => Promise<T>,
    isCurrent?: () => boolean,
    options?: TranscriptPreviewOptions,
  ): Promise<T> {
    return this.repository.consumeTranscriptPreview(
      scope,
      chatId,
      consume,
      isCurrent,
      options,
    );
  }

  /**
   * Chat search's incremental in-flight text: the rows a chat's in-progress
   * turn changed since a transcript revision, from the delta journal in
   * memory. Undefined when only a full preview read can answer.
   */
  public activeTurnDelta(
    scope: ChatScopeKey,
    chatId: string,
    since: number,
  ): ReturnType<ChatStateRepositoryPort['activeTurnDelta']> {
    return this.repository.activeTurnDelta(scope, chatId, since);
  }

  public async getCompatibilityTabs(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<ChatTabsFile> {
    return (await this.repository.getState(scope, selection)).tabsFile;
  }

  /** Trusted adapter for the deprecated renderer-snapshot archive channel. */
  public async archiveCompatibilityTab(
    scope: ChatScopeKey,
    entry: ArchivedChatEntry,
  ): Promise<ArchivedChatsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const currentTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === entry.tab.id,
        );
        if (!currentTab) {
          throw new Error(`Unknown compatibility archive tab: ${entry.tab.id}`);
        }
        const completedAt = Number.isFinite(Date.parse(entry.archivedAt))
          ? Date.parse(entry.archivedAt)
          : this.now();
        const messages = closeOpenPersistedToolUses(
          closeOpenPersistedTurnTimers(currentTab.messages, completedAt),
          completedAt,
        );
        const finalizedTab =
          messages === currentTab.messages
            ? currentTab
            : { ...currentTab, messages };
        return [
          { type: 'tab.removed', tabId: currentTab.id },
          {
            type: 'archive.upserted',
            entry: {
              ...entry,
              tab: finalizedTab,
              turnCount: countTurns(finalizedTab),
            },
          },
        ];
      },
      {
        ...{
          source: 'migration',
          mutationId: `legacy-archive:${entry.tab.id}:${entry.archivedAt}`,
          checkpoint: true,
        },
        chatIds: [entry.tab.id],
      },
    );
    return commit.state.archivesFile;
  }

  public async getCompatibilityArchives(
    scope: ChatScopeKey,
    selection: ChatReadSelection = {},
  ): Promise<ArchivedChatsFile> {
    return (await this.repository.getState(scope, selection)).archivesFile;
  }

  /** Authoritative eligibility includes retained archives; no caller-text fallback. */
  public async getInitialChatTitlePrompt(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<string | null> {
    const settledKey = initialTitleChatKey(scope, chatId);
    if (this.settledInitialTitleChats.has(settledKey)) return null;
    const state = await this.repository.getState(scope, { chatIds: [chatId] });
    const tab =
      state.tabsFile.tabs.find((candidate) => candidate.id === chatId) ??
      state.archivesFile.archived.find((entry) => entry.tab.id === chatId)?.tab;
    if (!tab) return null;
    if (!isInitialChatTitleEligible(tab)) {
      if (tab.automaticTitleState !== 'pending') {
        this.settledInitialTitleChats.add(settledKey);
      }
      return null;
    }
    return this.repository.consumeTranscript(
      scope,
      chatId,
      false,
      async (messages) => {
        for await (const message of messages) {
          if (
            message.role !== 'user' ||
            message.hidden === true ||
            message.parentToolUseId ||
            message.parentBlockId ||
            message.userMessageSource === 'deferred_tools_reload' ||
            message.userMessageSource === 'immediate_turn_restart'
          )
            continue;
          return message.blocks
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();
        }
        return null;
      },
    );
  }

  /** Returns true only after the first title is durably committed. Errors propagate. */
  public async commitInitialChatTitle(
    scope: ChatScopeKey,
    chatId: string,
    description: string,
  ): Promise<boolean> {
    const title = description.trim();
    if (!title) return false;
    const commit = await this.repository.transactWith(
      scope,
      (current) => {
        const live = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        const archived = live
          ? undefined
          : current.archivesFile.archived.find(
              (entry) => entry.tab.id === chatId,
            );
        const tab = live ?? archived?.tab;
        if (!tab || !isInitialChatTitleEligible(tab)) return [];
        if (live)
          return [
            {
              type: 'tab.metadata_patched',
              tabId: chatId,
              patch: { description: title, automaticTitleState: 'closed' },
            },
          ];
        if (!archived) return [];
        return [
          {
            type: 'archive.upserted',
            entry: {
              ...archived,
              tab: {
                ...archived.tab,
                description: title,
                automaticTitleState: 'closed',
              },
            },
          },
        ];
      },
      { source: 'automation', chatIds: [chatId] },
    );
    if (commit.applied) {
      this.settledInitialTitleChats.add(initialTitleChatKey(scope, chatId));
    }
    return commit.applied;
  }

  /**
   * Persist generated chat metadata regardless of whether the chat is still
   * live, including retained transcripts. Compatibility writer only: it
   * ignores naming state, so initial naming must use `commitInitialChatTitle`.
   */
  public async updateChatDescription(
    scope: ChatScopeKey,
    chatId: string,
    description: string,
  ): Promise<void> {
    await this.repository.transactWith(
      scope,
      (current) => {
        const liveTab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === chatId,
        );
        if (liveTab) {
          return liveTab.description === description
            ? []
            : [
                {
                  type: 'tab.created' as const,
                  tab: { ...liveTab, description },
                },
              ];
        }
        const archived = current.archivesFile.archived.find(
          (entry) => entry.tab.id === chatId,
        );
        if (!archived || archived.tab.description === description) {
          return [];
        }
        return [
          {
            type: 'archive.upserted' as const,
            entry: {
              ...archived,
              tab: { ...archived.tab, description },
            },
          },
        ];
      },
      { source: 'automation' },
    );
  }

  public async replaceCompatibilityState(
    scope: ChatScopeKey,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile,
  ): Promise<void> {
    const loaded = await this.repository.getState(scope);
    if (
      tabsFile.tabs.length === 0 &&
      archivesFile.archived.length === 0 &&
      loaded.tabsFile.tabs.length === 0 &&
      loaded.archivesFile.archived.length === 0
    ) {
      return;
    }
    await this.repository.transactWith(
      scope,
      (current) => {
        const mutations: ChatCoreMutation[] = [];
        const incomingTabIds = new Set(tabsFile.tabs.map((tab) => tab.id));
        for (const tab of current.tabsFile.tabs) {
          if (!incomingTabIds.has(tab.id)) {
            mutations.push({ type: 'tab.removed', tabId: tab.id });
          }
        }
        for (const tab of tabsFile.tabs) {
          const retained =
            current.tabsFile.tabs.find(
              (candidate) => candidate.id === tab.id,
            ) ??
            current.archivesFile.archived.find(
              (entry) => entry.tab.id === tab.id,
            )?.tab;
          mutations.push({
            type: 'tab.created',
            tab: {
              ...tab,
              ...(retained?.automaticTitleState
                ? { automaticTitleState: retained.automaticTitleState }
                : {}),
            },
            replaceTranscript: true,
          });
        }
        if (tabsFile.tabs.length > 0) {
          mutations.push({
            type: 'tab.order_changed',
            tabIds: tabsFile.tabs.map((tab) => tab.id),
          });
          mutations.push({
            type: 'tab.active_changed',
            activeTabId: incomingTabIds.has(tabsFile.activeTabId)
              ? tabsFile.activeTabId
              : tabsFile.tabs[0].id,
            ...(tabsFile.lastActiveEditableChatId
              ? {
                  lastActiveEditableChatId: tabsFile.lastActiveEditableChatId,
                }
              : {}),
            ...(tabsFile.lastActiveChatProvider
              ? { lastActiveChatProvider: tabsFile.lastActiveChatProvider }
              : {}),
          });
        }
        const incomingQuestions = new Set(
          (tabsFile.pendingQuestions ?? []).map(
            (question) => question.requestId,
          ),
        );
        for (const question of current.tabsFile.pendingQuestions ?? []) {
          if (!incomingQuestions.has(question.requestId)) {
            mutations.push({
              type: 'pending_question.removed',
              requestId: question.requestId,
              chatId: question.chatId,
            });
          }
        }
        for (const question of tabsFile.pendingQuestions ?? []) {
          mutations.push({ type: 'pending_question.upserted', question });
        }
        const incomingArchiveIds = new Set(
          archivesFile.archived.map((entry) => entry.tab.id),
        );
        for (const entry of current.archivesFile.archived) {
          if (!incomingArchiveIds.has(entry.tab.id)) {
            mutations.push({
              type: 'archive.removed',
              archiveEntryId: entry.tab.id,
              chatId: entry.tab.id,
            });
          }
        }
        for (const entry of [...archivesFile.archived].reverse()) {
          const retained =
            current.tabsFile.tabs.find((tab) => tab.id === entry.tab.id) ??
            current.archivesFile.archived.find(
              (candidate) => candidate.tab.id === entry.tab.id,
            )?.tab;
          mutations.push({
            type: 'archive.upserted',
            entry: {
              ...entry,
              tab: {
                ...entry.tab,
                ...(retained?.automaticTitleState
                  ? { automaticTitleState: retained.automaticTitleState }
                  : {}),
              },
            },
            replaceTranscript: true,
          });
        }
        return mutations;
      },
      { source: 'import', checkpoint: true, fullTranscript: true },
    );
  }

  public async replaceCompatibilityArchives(
    scope: ChatScopeKey,
    archivesFile: ArchivedChatsFile,
    options: { authoritative?: boolean } = {},
  ): Promise<ArchivedChatsFile> {
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        const mutations: ChatCoreMutation[] = [];
        const freshCompatibilitySnapshot =
          archivesFile.revision !== undefined &&
          archivesFile.revision === current.archivesFile.revision;
        const incomingArchiveIds = new Set(
          archivesFile.archived.map((entry) => entry.tab.id),
        );
        const currentById = new Map(
          current.archivesFile.archived.map((entry) => [entry.tab.id, entry]),
        );
        if (freshCompatibilitySnapshot || options.authoritative) {
          for (const entry of current.archivesFile.archived) {
            if (!incomingArchiveIds.has(entry.tab.id)) {
              mutations.push({
                type: 'archive.removed',
                archiveEntryId: entry.tab.id,
                chatId: entry.tab.id,
              });
            }
          }
        }
        for (const entry of [...archivesFile.archived].reverse()) {
          if (
            !currentById.has(entry.tab.id) &&
            options.authoritative !== true &&
            transaction.hasRemovedArchiveEntry(entry.tab.id)
          ) {
            continue;
          }
          const canonical = currentById.get(entry.tab.id);
          let next =
            freshCompatibilitySnapshot ||
            options.authoritative === true ||
            !canonical
              ? entry
              : canonical;
          // Main owns naming state, so even an authoritative snapshot keeps
          // the canonical value; a stale archive entry cannot reopen naming.
          if (canonical?.tab.automaticTitleState) {
            next = {
              ...next,
              tab: {
                ...next.tab,
                automaticTitleState: canonical.tab.automaticTitleState,
              },
            };
          }
          if (canonical && options.authoritative !== true) {
            const tab = { ...next.tab };
            if (
              Object.prototype.propertyIsEnumerable.call(next.tab, 'messages')
            ) {
              // V2 keeps unselected canonical rows on disk. Omitting them from
              // this upsert preserves them without hydrating the transcript.
              const retained = Object.prototype.propertyIsEnumerable.call(
                canonical.tab,
                'messages',
              )
                ? canonical.tab.messages.filter(isMcpActivationMessage)
                : [];
              tab.messages = mergePersistedMessagesById(
                retained,
                next.tab.messages.filter(
                  (message) => !isMcpActivationMessage(message),
                ),
              );
            }
            for (const key of [
              'mcpActivation',
              'inputDelivery',
              'lastAcceptedUserMessageId',
              'unacceptedTurnEnds',
              'turnEnds',
              'interruptedTurns',
            ] as const) {
              if (canonical.tab[key] === undefined) delete tab[key];
              else Object.assign(tab, { [key]: canonical.tab[key] });
            }
            next = { ...next, tab };
          }
          mutations.push({
            type: 'archive.upserted',
            ...(options.authoritative
              ? { replaceTranscript: true as const }
              : {}),
            entry: next,
          });
        }
        return mutations;
      },
      {
        source: 'import',
        checkpoint: true,
        fullTranscript: options.authoritative === true,
      },
    );
    return commit.state.archivesFile;
  }

  public async readCompatibilityArchive(
    scope: ChatScopeKey,
    chatId: string,
    fullTranscript = true,
  ): Promise<ArchivedChatEntry | null> {
    const state = await this.repository.getState(scope, {
      chatIds: [chatId],
      fullTranscript,
      pageOnly: !fullTranscript,
    });
    return (
      state.archivesFile.archived.find((entry) => entry.tab.id === chatId) ??
      null
    );
  }

  public async removeCompatibilityArchive(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<ArchivedChatEntry | null> {
    let removed: ArchivedChatEntry | null = null;
    await this.repository.transactWith(
      scope,
      (current) => {
        removed =
          current.archivesFile.archived.find(
            (entry) => entry.tab.id === chatId,
          ) ?? null;
        return removed
          ? [
              {
                type: 'archive.removed' as const,
                archiveEntryId: chatId,
                chatId,
              },
            ]
          : [];
      },
      { source: 'migration', checkpoint: true },
    );
    return removed;
  }

  public async copyStorageChats(
    source: ChatScopeKey,
    destination: ChatScopeKey,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile = { version: 1, archived: [] },
    sourceChatIds?: Readonly<Record<string, string>>,
    transformMessage?: ChatStorageImportOptions['transformMessage'],
    throughMessageIds?: ChatStorageImportOptions['throughMessageIds'],
    beforePublish?: ChatStorageImportOptions['beforePublish'],
    preparePublish?: ChatStorageImportOptions['preparePublish'],
  ): Promise<void> {
    await this.repository.copyChats(
      source,
      destination,
      { tabsFile, archivesFile },
      sourceChatIds,
      transformMessage,
      throughMessageIds,
      beforePublish,
      preparePublish,
    );
  }

  public async captureStorageScope(
    scope: ChatScopeKey,
    destination: ChatStorageV2,
    allowDuringScopeDeletion = false,
    captureExecutor?: (
      source: ChatStorageV2,
      destination: ChatStorageV2,
    ) => Promise<void>,
  ): Promise<void> {
    await this.repository.captureScope(
      scope,
      destination,
      allowDuringScopeDeletion,
      captureExecutor,
    );
  }

  public async importStorageScope(
    scope: ChatScopeKey,
    source: ChatStorageV2,
    tabsFile: ChatTabsFile,
    archivesFile: ArchivedChatsFile,
    options: ChatStorageImportOptions = {},
  ): Promise<void> {
    await this.repository.importScope(
      scope,
      source,
      { tabsFile, archivesFile },
      options,
    );
  }

  public flushScope(projectId: string, worktreeId: string): Promise<void> {
    return this.repository.flushScope({ projectId, worktreeId });
  }

  public flushScopeForArchivedContainerCaptureDuringDeletion(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    return this.repository.flushScope(
      { projectId, worktreeId },
      { allowDuringScopeDeletion: true },
    );
  }

  public async drain(): Promise<void> {
    this.draining = true;
    try {
      await this.repository.drainAll();
    } finally {
      this.unsubscribeStorageDiagnostics();
    }
  }

  /**
   * Admit a scope-local operation before its first asynchronous preparation.
   * Deletion closes admission first, then waits for every admitted operation
   * so none can create a provider session after the cleanup sweep.
   */
  public async runWithScopeActivity<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycleKey = chatScopeLifecycleKey(scope);
    const inheritedLeases = (this.scopeActivityLeases.getStore() ?? []).filter(
      (lease) => lease.active,
    );
    if (this.isScopeDeletionBlocking(lifecycleKey)) {
      throw new ChatScopeDeletingError();
    }
    this.activeScopeOperations.set(
      lifecycleKey,
      (this.activeScopeOperations.get(lifecycleKey) ?? 0) + 1,
    );
    const lease: ScopeActivityLease = { lifecycleKey, active: true };
    try {
      return await this.scopeActivityLeases.run(
        [...inheritedLeases, lease],
        operation,
      );
    } finally {
      lease.active = false;
      const remaining = (this.activeScopeOperations.get(lifecycleKey) ?? 1) - 1;
      if (remaining > 0) {
        this.activeScopeOperations.set(lifecycleKey, remaining);
      } else {
        this.activeScopeOperations.delete(lifecycleKey);
        const waiters = this.scopeOperationDrainWaiters.get(lifecycleKey);
        this.scopeOperationDrainWaiters.delete(lifecycleKey);
        waiters?.forEach((resolve) => resolve());
      }
    }
  }

  private isScopeDeletionBlocking(lifecycleKey: string): boolean {
    if (!this.deletingScopeIds.has(lifecycleKey)) {
      return false;
    }
    return !(this.scopeActivityLeases.getStore() ?? []).some(
      (lease) => lease.active && lease.lifecycleKey === lifecycleKey,
    );
  }

  private waitForScopeActivityDrain(lifecycleKey: string): Promise<void> {
    if (!this.activeScopeOperations.has(lifecycleKey)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters =
        this.scopeOperationDrainWaiters.get(lifecycleKey) ?? new Set();
      waiters.add(resolve);
      this.scopeOperationDrainWaiters.set(lifecycleKey, waiters);
    });
  }

  /**
   * Keep service-level command paths closed while an outer cleanup still needs
   * repository writes (for example, provider teardown event commits). Nested
   * callers are ref-counted so an inner deletion fence cannot release the
   * outer lifecycle boundary early.
   */
  public async runWithScopeDeletionLifecycle<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lifecycleKey = chatScopeLifecycleKey(scope);
    this.deletingScopeIds.set(
      lifecycleKey,
      (this.deletingScopeIds.get(lifecycleKey) ?? 0) + 1,
    );
    try {
      await this.waitForScopeActivityDrain(lifecycleKey);
      return await operation();
    } finally {
      const remaining = (this.deletingScopeIds.get(lifecycleKey) ?? 1) - 1;
      if (remaining <= 0) {
        this.deletingScopeIds.delete(lifecycleKey);
      } else {
        this.deletingScopeIds.set(lifecycleKey, remaining);
      }
    }
  }

  /**
   * Keep every mutating chat path and repository write closed for the full
   * lifetime of a larger scope cleanup.
   */
  public async runWithScopeDeletion<T>(
    scope: ChatScopeKey,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runWithScopeDeletionLifecycle(scope, async () => {
      return this.repository.runWithScopeDeletion(scope, async () => {
        return operation();
      });
    });
  }

  /**
   * Commit removal of every canonical entity, then drain the scope and delete
   * its snapshots, backups, journal, and recovery sidecars. Callers destroy
   * provider sessions before entering this boundary.
   */
  public async deleteScope(scope: ChatScopeKey): Promise<void> {
    await this.runWithScopeDeletion(scope, async () => {
      await this.repository.transactWith(
        scope,
        (current) => [
          ...current.tabsFile.tabs.map(
            (tab): ChatCoreMutation => ({
              type: 'tab.removed',
              tabId: tab.id,
            }),
          ),
          ...current.archivesFile.archived.map(
            (entry): ChatCoreMutation => ({
              type: 'archive.removed',
              archiveEntryId: entry.tab.id,
              chatId: entry.tab.id,
            }),
          ),
        ],
        {
          source: 'migration',
          mutationId: `scope-delete:${scope.projectId}:${scope.worktreeId}`,
          checkpoint: true,
          allowDuringScopeDeletion: true,
        },
      );
      await this.repository.deleteEmptyScope(scope);
    });
  }

  private async createTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    file: boolean,
    canCommitCreate?: () => boolean,
    preserveActiveTab?: true,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    const tabId = 'tabId' in command ? command.tabId : '';
    const createdAt = new Date(this.now()).toISOString();
    const invalidSeed =
      command.type === 'chat.create_tab' &&
      command.seedTab !== undefined &&
      (command.seedTab.id !== command.tabId ||
        !isPersistedChatTab(command.seedTab));
    if (invalidSeed) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected', {
        reason: 'The seeded chat tab is invalid or has a mismatched id',
      });
    }
    const tab =
      file && command.type === 'chat.create_file_tab'
        ? createPersistedFileTab({
            id: command.tabId,
            filePath: command.filePath,
            createdAt,
            ...(command.title ? { title: command.title } : {}),
            ...(command.viewMode ? { viewMode: command.viewMode } : {}),
            ...(command.pinned ? { pinned: true } : {}),
          })
        : command.type === 'chat.create_tab'
          ? persistedChatTabFromCreateCommand(
              command,
              createdAt,
              scope.projectId,
            )
          : undefined;
    if (!tab) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected');
    }
    const starter = command.type === 'chat.create_tab' && command.starter;
    let existingChatId: string | undefined;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, context) => {
        if (canCommitCreate?.() === false)
          throw new ChatSendAuthorizationRevokedError(
            'The paired session no longer authorizes this chat creation.',
          );
        existingChatId = undefined;
        if (current.tabsFile.tabs.some((candidate) => candidate.id === tabId)) {
          return [];
        }
        if (context.hasRemovedTab(tabId)) {
          return [];
        }
        if (starter) {
          existingChatId = current.tabsFile.tabs.find(
            (candidate) => (candidate.kind ?? 'chat') === 'chat',
          )?.id;
          if (existingChatId !== undefined) return [];
        }
        const mutations: ChatCoreMutation[] = [{ type: 'tab.created', tab }];
        if (
          (!preserveActiveTab || !current.tabsFile.activeTabId) &&
          (command.type !== 'chat.create_file_tab' ||
            command.activate !== false)
        )
          mutations.push({ type: 'tab.active_changed', activeTabId: tab.id });
        return mutations;
      },
      {
        source: 'renderer-command',
        mutationId: envelope.commandId,
        commandResult: {
          commandId: envelope.commandId,
          outcome: 'applied',
          entityId: tab.id,
        },
        ...expectedRevisionOption(envelope),
        ...(canCommitCreate
          ? {
              beforePublish: (): void => {
                if (!canCommitCreate())
                  throw new ChatSendAuthorizationRevokedError(
                    'The paired session no longer authorizes this chat creation.',
                  );
              },
            }
          : {}),
      },
    );
    const tabExists = commit.state.tabsFile.tabs.some(
      (candidate) => candidate.id === tabId,
    );
    if (!tabExists && existingChatId !== undefined) {
      // The starter is unnecessary: the scope already has this chat.
      return commandResult(envelope, commit.revision, 'already_applied', {
        entityId: existingChatId,
        reason: 'The scope already has a chat',
      });
    }
    const outcome: ChatCommandResult['outcome'] = !tabExists
      ? 'not_found'
      : commit.applied
        ? 'applied'
        : 'already_applied';
    return commandResult(
      envelope,
      commit.revision,
      outcome,
      outcome === 'not_found'
        ? { reason: 'The tab id is tombstoned' }
        : { entityId: tab.id },
    );
  }

  private async importSession(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.import_session' }>,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    const { targetChatId, source } = command;
    if (state.tabsFile.tabs.some((tab) => tab.id === targetChatId)) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'already_applied',
        { entityId: targetChatId },
      );
    }
    if (await this.repository.hasRemovedTab(scope, targetChatId)) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'not_found',
        {
          reason: 'The imported chat id is tombstoned',
        },
      );
    }
    if (source.kind !== 'transcript') {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'rejected', {
        reason:
          'Session export imports must first be resolved by the trusted main import adapter',
      });
    }

    const parsed = parseAgentTranscriptLines(
      source.content.split(/\r?\n/),
      source.providerType,
      { closeOpenTurnAtEnd: true },
    );
    if (parsed.messages.length === 0) {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'rejected', {
        reason: 'The transcript did not contain any valid chat messages',
      });
    }
    const now = this.now();
    const tab: PersistedChatTab = {
      ...createPersistedChatTab({
        id: targetChatId,
        title: 'Imported chat',
        createdAt: new Date(now).toISOString(),
        providerType: parsed.providerType ?? source.providerType,
      }),
      ...newChatPluginDefaultsStamp(scope.projectId),
      messages: parsed.messages,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...(parsed.agentUsage ? { agentUsage: parsed.agentUsage } : {}),
    };
    return this.commit(
      scope,
      envelope,
      [
        { type: 'tab.created', tab },
        { type: 'tab.active_changed', activeTabId: targetChatId },
        {
          type: 'runtime.patched',
          chatId: targetChatId,
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: now,
          },
        },
      ],
      { entityId: targetChatId },
    );
  }

  private async commit(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    mutations: ChatCoreMutation[],
    details: Partial<Pick<ChatCommandResult, 'entityId' | 'messageId'>> = {},
  ): Promise<ChatCommandResult> {
    try {
      const commit = await this.repository.transact(scope, mutations, {
        ...{
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            ...details,
          },
          ...expectedRevisionOption(envelope),
        },
        fullTranscript: mutations.some(
          (mutation) => mutation.type === 'messages.replaced',
        ),
      });
      // A retained mutation id with an evicted receipt replays as a no-op.
      return commandResult(
        envelope,
        commit.revision,
        commit.applied ? 'applied' : 'already_applied',
        details,
      );
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async commitExistingTabCommand(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    mutations: ChatCoreMutation[],
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    if (!state.tabsFile.tabs.some((tab) => tab.id === tabId)) {
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    }
    return this.commit(scope, envelope, mutations, { entityId: tabId });
  }

  private async activateTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const target = current.tabsFile.tabs.find((tab) => tab.id === tabId);
          if (!target) {
            outcome = 'not_found';
            return [];
          }
          const currentActive = current.tabsFile.tabs.find(
            (tab) => tab.id === current.tabsFile.activeTabId,
          );
          const lastActiveEditableChatId = isEditablePersistedChatTab(target)
            ? target.id
            : isEditablePersistedChatTab(currentActive)
              ? currentActive?.id
              : current.tabsFile.lastActiveEditableChatId;
          const lastActiveChatProvider =
            persistedTabProvider(target) ??
            persistedTabProvider(currentActive) ??
            current.tabsFile.lastActiveChatProvider;
          return [
            {
              type: 'tab.active_changed',
              activeTabId: tabId,
              ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
              ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: tabId,
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async patchTabSettings(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.patch_tab_settings' }>,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.tabId,
          );
          if (!tab) {
            outcome = 'not_found';
            return [];
          }
          if (
            command.expectedPendingPlanExitRequestId !== undefined &&
            (tab.pendingPlanExitRequestId !==
              command.expectedPendingPlanExitRequestId ||
              (tab.pendingPlanExit?.source === 'opencode' &&
                current.runtimeByChatId[command.tabId]?.activeTurn !==
                  undefined))
          ) {
            // A revision is saved before its new review request. The old
            // request must not approve that revision during publication.
            outcome = 'conflict';
            return [];
          }
          if (
            command.expectedPendingPlanExitRequestId !== undefined &&
            (command.patch.pendingPlanExit === null ||
              command.patch.pendingPlanExitRequestId === null ||
              command.patch.planMode === false ||
              command.patch.trackedPlanReviewStatus === 'approved' ||
              command.patch.trackedPlanReviewStatus === 'dismissed') &&
            isPlanProposal({
              ...tab.pendingPlanExit,
              source: tab.pendingPlanExit?.source ?? tab.trackedPlanSource,
            }) &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              current.runtimeByChatId[command.tabId]?.status ?? 'idle',
            )
          ) {
            outcome = 'conflict';
            return [];
          }
          if (
            command.expectedPluginSelections !== undefined &&
            !isDeepStrictEqual(
              normalizePluginSelections(tab.pluginSelections),
              normalizePluginSelections(command.expectedPluginSelections),
            )
          ) {
            outcome = 'conflict';
            return [];
          }
          return [
            {
              type: 'tab.metadata_patched',
              tabId: command.tabId,
              patch: {
                ...command.patch,
                ...(command.patch.customTitle?.trim() ||
                (command.patch.customTitle === null && tab.customTitle?.trim())
                  ? { automaticTitleState: 'closed' as const }
                  : {}),
              },
            },
          ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.tabId,
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: command.tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async patchWholeTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    patch: (
      tab: PersistedChatTab,
      runtime?: ChatRuntimeState,
    ) => PersistedChatTab,
  ): Promise<ChatCommandResult> {
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === tabId,
          );
          return tab
            ? [
                {
                  type: 'tab.created',
                  tab: patch(tab, current.runtimeByChatId[tabId]),
                },
              ]
            : [];
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: tabId,
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [tabId],
        },
      );
      if (
        !commit.state.tabsFile.tabs.some((candidate) => candidate.id === tabId)
      ) {
        // Read/attention clears are idempotent desired-state patches. A view
        // can acknowledge a renderer-created starter tab just before the
        // trusted send materializes it in main; absence already satisfies the
        // clear and must not be treated as a destructive stale-entity conflict.
        return commandResult(envelope, commit.revision, 'already_applied');
      }
      return commandResult(envelope, commit.revision, 'applied', {
        entityId: tabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async setModel(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.set_model') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    if (command.autoRoutedMessageId !== undefined) {
      validateId(command.autoRoutedMessageId, 'auto-routed message id');
    }
    if (command.notice) {
      validateId(command.notice.id, 'model change notice id');
      if (
        !Number.isFinite(command.notice.timestamp) ||
        !command.notice.text.trim()
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          { reason: 'Invalid model change notice' },
        );
      }
    }
    return this.patchWholeTab(
      scope,
      envelope,
      command.tabId,
      (tab, runtime) => {
        if (command.executionHarness !== undefined) {
          if (
            !getChatHarnessOptions(command.model).includes(
              command.executionHarness,
            )
          ) {
            throw new Error(
              'This model does not support the selected harness.',
            );
          }
          const autoStartingFirstTurn =
            command.preserveModelSelectionMode === true &&
            tab.sdkSessionId === undefined &&
            tab.messages.length === 1 &&
            runtime?.status === 'starting';
          if (
            !autoStartingFirstTurn &&
            (tab.messages.length > 0 ||
              (runtime?.queuedMessageIds.length ?? 0) > 0 ||
              (runtime &&
                [
                  'queued',
                  'starting',
                  'streaming',
                  'awaiting_input',
                  'completing',
                ].includes(runtime.status)))
          ) {
            throw new Error('Start a new chat to change its harness.');
          }
        }
        const currentProvider =
          tab.providerType ??
          (tab.model ? getProviderForModel(tab.model) : command.providerType);
        const currentHarness =
          tab.executionHarness ??
          (tab.model ? getExecutionHarnessForModel(tab.model) : undefined);
        const targetHarness =
          command.executionHarness ??
          (tab.model === command.model &&
          tab.executionHarnessExplicitlyChosen === true
            ? tab.executionHarness
            : undefined) ??
          getExecutionHarnessForModel(command.model);
        const harnessChanged =
          currentHarness !== undefined &&
          targetHarness !== undefined &&
          currentHarness !== targetHarness;
        const leavesTerminalMode =
          isTerminalBackedInterfaceMode(tab.interfaceMode) &&
          !isTerminalBackedInterfaceMode(
            command.settings
              ? (command.settings.interfaceMode ?? undefined)
              : tab.interfaceMode,
          );
        const next: PersistedChatTab = {
          ...tab,
          model: command.model,
          providerType: command.providerType,
          modelExplicitlyChosen: true,
          messages:
            command.notice &&
            !tab.messages.some((message) => message.id === command.notice?.id)
              ? [
                  ...tab.messages,
                  {
                    id: command.notice.id,
                    role: 'system',
                    timestamp: command.notice.timestamp,
                    blocks: [{ type: 'text', text: command.notice.text }],
                  },
                ]
              : tab.messages,
          ...(command.autoRoutedMessageId !== undefined
            ? {
                autoRoutedModels: {
                  ...tab.autoRoutedModels,
                  [command.autoRoutedMessageId]: command.model,
                },
              }
            : {}),
        };
        if (command.preserveModelSelectionMode !== true) {
          delete next.modelSelectionMode;
        }
        if (currentProvider !== command.providerType) {
          delete next.modelConfig;
          delete next.thinkingLevel;
          delete next.codexFastModeEnabled;
          delete next.interfaceMode;
          if (currentProvider === 'codex') {
            // Keep the requested Codex speed while the chat runs another
            // provider, in this same durable command, so returning to Codex
            // restores the user's choice instead of the provider default.
            const retainedCodexSpeed = readCodexSpeedRecord(
              tab.modelConfig,
              tab.codexFastModeEnabled,
            );
            if (retainedCodexSpeed === undefined) {
              delete next.retainedCodexSpeed;
            } else {
              next.retainedCodexSpeed = retainedCodexSpeed;
            }
          } else if (command.providerType === 'codex') {
            // Returning to Codex consumes the retained speed atomically. The
            // model-change path restores it into `settings`, which replaces
            // this below; a settings-less change (such as a Remote Control
            // model pick) restores it here instead of dropping it.
            if (isCodexSpeed(tab.retainedCodexSpeed)) {
              next.modelConfig = withCodexSpeed(
                undefined,
                tab.retainedCodexSpeed,
              );
            }
            delete next.retainedCodexSpeed;
          }
          // The harness is pinned only while a conversation stays on the same
          // provider family. A cross-provider model change (including an
          // organization-policy fallback) must let the next send resolve and
          // persist the new model's harness; retaining the old pin would route a
          // visibly Claude model through Codex, or vice versa.
          delete next.executionHarness;
          delete next.sdkSessionId;
          delete next.globalInstructionsSnapshot;
          delete next.codexReconstructionSeedId;
          delete next.claudeForkSessionOnNextSend;
          delete next.claudeTerminal;
        } else if (harnessChanged || leavesTerminalMode) {
          delete next.sdkSessionId;
          delete next.globalInstructionsSnapshot;
          delete next.codexReconstructionSeedId;
          delete next.claudeForkSessionOnNextSend;
          delete next.claudeTerminal;
        }
        if (
          targetHarness === 'cursor' ||
          command.providerType === 'cursor' ||
          targetHarness === 'copilot' ||
          command.providerType === 'copilot' ||
          targetHarness === 'opencode' ||
          command.providerType === 'opencode'
        ) {
          // Cursor bills only through the connected Cursor account. Clear the
          // incompatible routing in the same durable command as the model so no
          // caller-dependent follow-up patch can leave a Cursor tab routed to
          // AI Credits, which the provider rejects on every send.
          delete next.aiCreditsRouting;
          delete next.subscriptionBillingOverride;
          delete next.billingExplicitlyChosen;
        }
        if (command.settings) {
          const settingsModelConfig = canonicalizeAgentModelConfig(
            command.settings.modelConfig,
          );
          next.thinkingLevel = command.settings.thinkingLevel;
          next.modelConfig = settingsModelConfig;
          // The deprecated alias only projects the stored speed.
          next.codexFastModeEnabled =
            settingsModelConfig.fastMode ??
            command.settings.codexFastModeEnabled;
          if (command.settings.interfaceMode) {
            next.interfaceMode = command.settings.interfaceMode;
          } else {
            delete next.interfaceMode;
          }
        }
        if (tab.messages.length === 0) {
          if (
            command.executionHarness !== undefined ||
            (tab.model === command.model &&
              tab.executionHarnessExplicitlyChosen === true)
          ) {
            next.executionHarness = targetHarness;
            next.executionHarnessExplicitlyChosen = true;
          } else {
            delete next.executionHarness;
            delete next.executionHarnessExplicitlyChosen;
          }
        }
        return next;
      },
    );
  }

  private async sendMessage(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    options: TrustedChatCommandExecutionOptions = {},
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const originalCommand = envelope.command;
    const command =
      originalCommand.type === 'chat.send_message' &&
      options.agentSent !== undefined
        ? { ...originalCommand, agentSent: options.agentSent }
        : originalCommand;
    if (command.type !== 'chat.send_message') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    validateId(command.chatId, 'chatId');
    validateId(command.userMessageId, 'userMessageId');
    const release = this.holdDispatch(
      chatRuntimeHostKey(scope, command.chatId),
    );
    return withLegacyChatMessageCommand(
      envelope,
      () =>
        this.sendAcceptedMessage(
          scope,
          envelope,
          command,
          options,
          asyncAnswer,
        ),
      undefined,
      options,
    ).finally(release);
  }

  /**
   * Whether this message was admitted and its turn waits for its worktree's
   * Git setup before it dispatches.
   */
  public isAwaitingWorktreeSetup(
    target: ChatScopeKey & { chatId: string; userMessageId: string },
  ): boolean {
    return this.heldSends.has(awaitingSetupKey(target, target));
  }

  private holdDispatch(runtimeHostKey: string): () => void {
    this.dispatchesInFlight.set(
      runtimeHostKey,
      (this.dispatchesInFlight.get(runtimeHostKey) ?? 0) + 1,
    );
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (this.dispatchesInFlight.get(runtimeHostKey) ?? 1) - 1;
      if (remaining > 0) {
        this.dispatchesInFlight.set(runtimeHostKey, remaining);
      } else {
        this.dispatchesInFlight.delete(runtimeHostKey);
      }
    };
  }

  private async sendAcceptedMessage(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<
      ChatCommandEnvelope['command'],
      { type: 'chat.send_message' }
    >,
    options: TrustedChatCommandExecutionOptions,
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const trustedRequest: ChatSendMessageRequest = {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
      text: command.text,
      agentSent: command.agentSent,
      agentSenderProvenance: command.agentSenderProvenance,
      hiddenContext: command.hiddenContext,
      agentSendSetup: command.agentSendSetup,
    };
    if (command.agentSendSetup) await agentSendTargetReadiness(trustedRequest);
    if (
      command.agentSent ||
      command.agentSenderProvenance ||
      command.hiddenContext ||
      command.agentSendSetup
    )
      await revalidateAgentSenderRequest(trustedRequest);
    const stateBeforeAuthorization = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    const tabBeforeAuthorization = stateBeforeAuthorization.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    // Settle the model, including one stored on the chat, before authorization
    // judges it and before the prompt is committed. Auto picks its own model.
    const storedModel =
      tabBeforeAuthorization?.kind === 'file'
        ? undefined
        : tabBeforeAuthorization?.model;
    const sendModel =
      (command.modelSelectionMode ??
        tabBeforeAuthorization?.modelSelectionMode) === 'auto'
        ? undefined
        : await this.resolveSendModel(scope, storedModel, command.model);
    const requestedCommand = command;
    if (sendModel !== undefined) {
      command = {
        ...command,
        model: sendModel,
        providerType: getProviderForModel(sendModel) ?? command.providerType,
      };
    }
    if (
      tabBeforeAuthorization &&
      tabBeforeAuthorization.kind !== 'file' &&
      tabBeforeAuthorization.readOnly !== true &&
      !tabBeforeAuthorization.messages.some(
        (message) => message.id === command.userMessageId,
      )
    ) {
      await this.authorizeSend({
        ...scope,
        tab: tabWithSendModel(tabBeforeAuthorization, command),
        ...(command.agentSenderProvenance
          ? { allowTrustedTerminal: true }
          : {}),
      });
    }
    const pendingPlanReviewApproval =
      command.planReviewApproval &&
      !tabBeforeAuthorization?.messages.some(
        (message) => message.id === command.userMessageId,
      )
        ? command.planReviewApproval
        : undefined;
    if (pendingPlanReviewApproval) {
      if (
        asyncAnswer ||
        command.planMode === true ||
        options.canCommitSend?.() === false ||
        !matchesOpenCodePlanReview(
          tabBeforeAuthorization,
          stateBeforeAuthorization.runtimeByChatId[command.chatId],
          pendingPlanReviewApproval,
        )
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The plan review changed or the chat is busy. Review the current proposal before implementing it.',
          },
        );
      }
      // The plan store records the explicit review first. It grants no chat
      // permissions: the revision lock and canonical transaction below recheck
      // the saved plan, request and live pairing before accepting the message.
      if (
        !(await this.approvePlanReview({
          ...scope,
          chatId: command.chatId,
          planId: pendingPlanReviewApproval.planId,
          revisionNumber: pendingPlanReviewApproval.revisionNumber,
          approvedAt: new Date(this.now()).toISOString(),
        }))
      ) {
        return commandResult(
          envelope,
          await this.repository.getRevision(scope),
          'rejected',
          {
            reason:
              'The saved plan changed. Request a new proposal before implementing it.',
          },
        );
      }
    }
    const timestamp = this.now();
    const firstMessageTitle = initialChatTitle(command.text);
    const newChatStartedWatcherFiredAt = new Date(timestamp).toISOString();
    let startsNewTrackedChat = false;
    let installedStartingRuntime = false;
    let admissionCheck: ChatSendAdmissionCheck | undefined;
    let precommitResult:
      | {
          outcome: 'not_found' | 'already_applied' | 'rejected';
          reason?: string;
        }
      | undefined;
    const commitSend = (): Promise<ChatStateCommit> =>
      this.repository.transactWith(
        scope,
        (current, _revision, transaction) => {
          if (options.portalSend) {
            const receipt = transaction.getPortalSendReceipt(
              command.userMessageId,
            );
            if (receipt) {
              precommitResult = matchesPortalSendReceipt(
                receipt,
                options.portalSend,
              )
                ? { outcome: 'already_applied' }
                : {
                    outcome: 'rejected',
                    reason:
                      'The logical portal send payload or target has changed.',
                  };
              return [];
            }
          }
          const persistedTab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.chatId,
          );
          if (!persistedTab || persistedTab.kind === 'file') {
            precommitResult = { outcome: 'not_found' };
            return [];
          }
          // A model change that landed after the stored model was read wins
          // over a pin taken from it.
          const tab = tabWithSendModel(
            persistedTab,
            requestedCommand.model === undefined &&
              persistedTab.model !== storedModel
              ? requestedCommand
              : command,
          );
          if (tab.readOnly) {
            precommitResult = {
              outcome: 'rejected',
              reason: 'Target chat is readonly',
            };
            return [];
          }
          const question = asyncAnswer
            ? (current.tabsFile.pendingQuestions ?? []).find(
                (candidate) =>
                  candidate.chatId === tab.id &&
                  candidate.requestId === asyncAnswer.questionId,
              )
            : undefined;
          if (asyncAnswer && (!question || question.answeredAt !== undefined)) {
            precommitResult = {
              outcome: question ? 'already_applied' : 'not_found',
            };
            return [];
          }
          if (
            tab.messages.some(({ id }) => id === command.userMessageId) &&
            !command.agentSenderProvenance
          ) {
            precommitResult = options.portalSend
              ? {
                  outcome: 'rejected',
                  reason:
                    'The message has no matching logical portal send receipt.',
                }
              : { outcome: 'already_applied' };
            return [];
          }
          if (options.canCommitSend?.() === false) {
            precommitResult = {
              outcome: 'rejected',
              reason: 'The paired session no longer authorizes this send.',
            };
            return [];
          }
          if (transaction.hasRemovedMessage(command.userMessageId)) {
            precommitResult = {
              outcome: 'not_found',
              reason: 'The message id is tombstoned',
            };
            return [];
          }
          admissionCheck = chatSendAdmissionCheck({
            ...scope,
            chatId: tab.id,
            userMessageId: command.userMessageId,
          });
          const admissionRefusal = admissionCheck?.(tab);
          if (admissionRefusal !== undefined) {
            precommitResult = { outcome: 'rejected', reason: admissionRefusal };
            return [];
          }
          startsNewTrackedChat =
            tab.newChatStartedWatcherFiredAt === undefined &&
            (tab.newChatStartedWatcherPending === true ||
              tab.messages.length === 0);
          const runtime = current.runtimeByChatId[tab.id];
          // Persist queued input without superseding the running provider turn.
          // Its events can arrive before dispatch reconciles the host queue.
          const turnAlreadyActive =
            runtime !== undefined &&
            ['starting', 'streaming', 'awaiting_input', 'completing'].includes(
              runtime.status,
            );
          const approval = command.planReviewApproval;
          if (
            approval &&
            (asyncAnswer ||
              command.planMode === true ||
              !matchesOpenCodePlanReview(tab, runtime, approval))
          ) {
            precommitResult = {
              outcome: 'rejected',
              reason:
                'The plan review changed or the chat is busy. Review the current proposal before implementing it.',
            };
            return [];
          }
          installedStartingRuntime =
            !asyncAnswer &&
            !turnAlreadyActive &&
            !this.setupHolds.has(chatRuntimeHostKey(scope, tab.id));
          return [
            ...(tab !== persistedTab
              ? [{ type: 'tab.created' as const, tab }]
              : []),
            ...(question && asyncAnswer
              ? [
                  {
                    type: 'pending_question.upserted' as const,
                    question: {
                      ...question,
                      answers: asyncAnswer.answers,
                      answeredAt: timestamp,
                    },
                  },
                ]
              : []),
            ...(tab.messages.length === 0 &&
            hasPlaceholderChatTitle(tab.title) &&
            tab.title !== firstMessageTitle
              ? [
                  {
                    type: 'tab.created' as const,
                    tab: {
                      ...tab,
                      title: firstMessageTitle,
                      automaticTitleState:
                        tab.automaticTitleState === 'closed'
                          ? ('closed' as const)
                          : ('pending' as const),
                    },
                  },
                ]
              : []),
            ...(command.selectedRepoId !== undefined ||
            command.modelConfig !== undefined ||
            command.planMode !== undefined ||
            command.codexProposalMode !== undefined ||
            command.modelSelectionMode !== undefined
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      ...(command.selectedRepoId !== undefined
                        ? { selectedRepoId: command.selectedRepoId }
                        : {}),
                      ...(command.modelConfig !== undefined
                        ? { modelConfig: command.modelConfig }
                        : {}),
                      ...(command.planMode !== undefined
                        ? { planMode: command.planMode }
                        : {}),
                      ...(command.codexProposalMode !== undefined
                        ? { proposalMode: command.codexProposalMode }
                        : {}),
                      ...(command.modelSelectionMode !== undefined
                        ? { modelSelectionMode: command.modelSelectionMode }
                        : {}),
                    },
                  },
                ]
              : []),
            ...(approval
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      planMode: false,
                      pendingPlanExit: null,
                      pendingPlanExitRequestId: null,
                      trackedPlanReviewStatus: 'approved' as const,
                      hasOutstandingProposal: false,
                    },
                  },
                ]
              : []),
            ...(startsNewTrackedChat
              ? [
                  {
                    type: 'tab.metadata_patched' as const,
                    tabId: tab.id,
                    patch: {
                      newChatStartedWatcherPending: null,
                      newChatStartedWatcherFiredAt,
                    },
                  },
                ]
              : []),
            {
              type: 'message.upserted',
              chatId: tab.id,
              message: {
                ...buildUserMessage(command, timestamp),
                ...(asyncAnswer
                  ? {
                      blocks: [
                        {
                          type: 'text' as const,
                          text: command.text,
                          asyncQuestionAnswer: {
                            requestId: asyncAnswer.questionId,
                            startsTurn: false,
                            answers: asyncAnswer.answers,
                          },
                        },
                      ],
                    }
                  : {}),
              },
            },
            ...(installedStartingRuntime
              ? [
                  {
                    type: 'runtime.patched' as const,
                    chatId: tab.id,
                    runtime: {
                      status: 'starting' as const,
                      queuedMessageIds: [],
                      activeTurn: {
                        userMessageId: command.userMessageId,
                        startedAt: timestamp,
                      },
                      lastActivityAt: timestamp,
                    },
                  },
                ]
              : []),
          ];
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: command.agentSenderProvenance
              ? `${envelope.commandId}:agent-send-input`
              : envelope.commandId,
            ...(!command.agentSenderProvenance
              ? {
                  commandResult: {
                    commandId: envelope.commandId,
                    outcome: 'applied' as const,
                    entityId: command.chatId,
                    messageId: command.userMessageId,
                    ...(options.portalSend
                      ? { portalSend: options.portalSend }
                      : {}),
                  },
                }
              : {}),
            ...expectedRevisionOption(envelope),
          },
          chatIds: [command.chatId],
          ...(options.canCommitSend
            ? {
                beforePublish: (): void => {
                  if (options.canCommitSend?.() === false)
                    throw new ChatSendAuthorizationRevokedError();
                },
              }
            : {}),
        },
      );

    // The plan lock is held only through canonical acceptance, never provider
    // dispatch. Plan edits cannot race the revision check and this commit.
    const guardedCommit = pendingPlanReviewApproval
      ? await this.withPlanReviewRevision(
          {
            ...scope,
            chatId: command.chatId,
            planId: pendingPlanReviewApproval.planId,
            revisionNumber: pendingPlanReviewApproval.revisionNumber,
            approvedAt: new Date(timestamp).toISOString(),
          },
          commitSend,
        )
      : { accepted: true as const, result: await commitSend() };
    if (!guardedCommit.accepted) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
        {
          reason:
            'The saved plan changed. Request a new proposal before implementing it.',
        },
      );
    }
    const commit = guardedCommit.result;

    if (precommitResult) {
      return commandResult(envelope, commit.revision, precommitResult.outcome, {
        messageId: command.userMessageId,
        ...(precommitResult.reason ? { reason: precommitResult.reason } : {}),
      });
    }

    const canonical = commit.state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    if (!canonical) {
      throw new Error(
        `Committed chat ${command.chatId} is missing from canonical state`,
      );
    }
    if (!commit.applied && !command.agentSenderProvenance) {
      return commandResult(envelope, commit.revision, 'already_applied', {
        entityId: command.chatId,
        messageId: command.userMessageId,
      });
    }
    const setupHold = asyncAnswer
      ? undefined
      : (this.setupHolds.get(chatRuntimeHostKey(scope, command.chatId)) ??
        this.beginSetupHold(scope, command.chatId));
    if (setupHold) {
      await setupHold.acquired;
      if (installedStartingRuntime && setupHold.owner === undefined) {
        this.holdTurnForSetup(setupHold, {
          key: awaitingSetupKey(scope, command),
          scope,
          envelope,
          command,
          revision: commit.revision,
          timestamp,
          startsNewTrackedChat,
          admissionCheck,
        });
        await setupHold.acquired;
        return commandResult(envelope, commit.revision, 'applied', {
          entityId: command.chatId,
          messageId: command.userMessageId,
        });
      }
    }
    return this.dispatchAdmitted(
      scope,
      envelope,
      command,
      commit.revision,
      {
        request: admittedSendRequest(scope, command, canonical, {
          startsNewTrackedChat,
          asyncAnswer,
        }),
        timestamp,
        installedStartingRuntime,
      },
      asyncAnswer,
    );
  }

  /**
   * Starts holding a chat's sends for its worktree's pending Git setup, or
   * returns undefined when no setup is pending. Sends admitted meanwhile
   * queue behind the hold in the chat queue, where they show and can be
   * cancelled as queued input.
   */
  private beginSetupHold(
    scope: ChatScopeKey,
    chatId: string,
  ): SetupHold | undefined {
    const setup = this.awaitWorktreeSetup(scope);
    if (!setup) return undefined;
    const key = chatRuntimeHostKey(scope, chatId);
    const target = { ...scope, chatId };
    const releaseDispatch = this.holdDispatch(key);
    const hold: SetupHold = {
      scope,
      chatId,
      acquired: this.worktreeSetupQueue.hold(target).catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] Could not hold the chat queue for worktree setup for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
          error,
        );
      }),
      owner: undefined,
    };
    this.setupHolds.set(key, hold);
    void setup
      .catch((): WorktreeGitSetupOutcome => 'failed')
      .then((outcome) => this.settleSetupHold(hold, outcome))
      .catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] A send held for worktree setup did not settle for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
          error,
        );
      })
      .finally(() => {
        hold.owner?.preparation?.finish();
        if (hold.owner) this.heldSends.delete(hold.owner.key);
        if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
        releaseDispatch();
      });
    return hold;
  }

  /** Makes a send that starts the chat's turn the turn the setup holds. */
  private holdTurnForSetup(
    hold: SetupHold,
    admitted: Omit<HeldSend, 'preparation' | 'state'>,
  ): void {
    const { scope, command } = admitted;
    const held: HeldSend = {
      ...admitted,
      preparation: beginChatTurnPreparation({
        ...scope,
        chatId: command.chatId,
        userMessageId: command.userMessageId,
        onCancel: () => this.settleHeldSend(held, 'cancelled'),
      }),
      state: 'held',
    };
    hold.owner = held;
    this.heldSends.set(held.key, held);
    const target = { ...scope, chatId: command.chatId };
    hold.acquired = hold.acquired
      .then(() => this.worktreeSetupQueue.hold(target, command.userMessageId))
      .catch((error: unknown) => {
        logMainProcessWarn(
          `[chat-state] Could not hold the chat queue for worktree setup for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
          error,
        );
      });
  }

  /**
   * Ends a chat's setup hold. When setup is ready the held turn dispatches
   * ahead of the sends queued behind it, which then run in order; when it
   * failed or was cancelled, the held turn and every queued send end that
   * way: one commit takes the queued sends off the queue and records their
   * ends (`reconcileHostQueue`), so none is ever durably without both its
   * queue row and its end. A shutdown leaves them all for startup
   * reconciliation.
   */
  private async settleSetupHold(
    hold: SetupHold,
    outcome: WorktreeGitSetupOutcome,
  ): Promise<void> {
    await hold.acquired;
    if (this.draining) return;
    const target = { ...hold.scope, chatId: hold.chatId };
    const key = chatRuntimeHostKey(hold.scope, hold.chatId);
    const owner = hold.owner;
    if (outcome !== 'ready') {
      if (owner) await this.settleHeldSend(owner, outcome);
      await this.untilSettled(hold, async () => {
        await this.worktreeSetupQueue.takeHeld(target, outcome);
        await this.worktreeSetupQueue.release(target);
      });
      if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
      return;
    }
    try {
      if (owner) await this.dispatchHeldTurn(hold, owner);
    } finally {
      await this.untilSettled(hold, () =>
        this.worktreeSetupQueue.release(target),
      );
      if (!this.draining && this.setupHolds.get(key) === hold)
        this.setupHolds.delete(key);
    }
  }

  /**
   * Runs a step that ends a chat's setup hold until it succeeds, retrying
   * with backoff, so a step that cannot persist (taking the held sends off
   * the queue, releasing the queue's hold) leaves the chat held, its sends
   * queued and none dispatched, rather than stuck behind a hold nothing
   * releases. A shutdown stops retrying and leaves the hold for startup
   * reconciliation.
   */
  private async untilSettled(
    hold: SetupHold,
    step: () => Promise<void>,
  ): Promise<void> {
    for (let attempt = 0; !this.draining; attempt += 1) {
      try {
        await step();
        return;
      } catch (error) {
        logMainProcessWarn(
          `[chat-state] Could not end the worktree setup hold of ${hold.scope.projectId}/${hold.scope.worktreeId}/${hold.chatId}; retrying:`,
          error,
        );
      }
      await new Promise<void>((resolve) => {
        this.schedule(
          resolve,
          Math.min(1_000 * 2 ** attempt, 30_000),
        ).unref?.();
      });
    }
  }

  /**
   * Dispatches the turn a setup held once setup is ready, if it is still the
   * chat's live, unstopped turn and its send's admission still holds.
   */
  private async dispatchHeldTurn(
    hold: SetupHold,
    held: HeldSend,
  ): Promise<void> {
    if (held.state !== 'held') return;
    const { scope, command } = held;
    await this.worktreeSetupQueue.release(
      { ...scope, chatId: command.chatId },
      { firstUserMessageId: command.userMessageId },
    );
    const committed = await this.repository.hasMessage(
      scope,
      command.chatId,
      command.userMessageId,
    );
    const state = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    if (held.state !== 'held' || this.draining) return;
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    const runtime = state.runtimeByChatId[command.chatId];
    const ownsRuntime =
      runtime?.activeTurn?.userMessageId === command.userMessageId;
    if (
      held.preparation?.cancelled === true ||
      !tab ||
      tab.kind === 'file' ||
      tab.readOnly === true ||
      !committed ||
      (ownsRuntime && !UNFINISHED_RUNTIME_STATUSES.includes(runtime.status))
    ) {
      await this.settleHeldSend(held, 'cancelled');
      return;
    }
    const admissionRefusal = held.admissionCheck?.(tab);
    if (admissionRefusal !== undefined) {
      await this.settleHeldSend(held, 'failed', admissionRefusal);
      return;
    }
    held.state = 'dispatching';
    const key = chatRuntimeHostKey(hold.scope, hold.chatId);
    if (this.setupHolds.get(key) === hold) this.setupHolds.delete(key);
    await this.dispatchAdmitted(scope, held.envelope, command, held.revision, {
      request: admittedSendRequest(scope, command, tab, {
        startsNewTrackedChat: held.startsNewTrackedChat,
      }),
      timestamp: held.timestamp,
      installedStartingRuntime: ownsRuntime,
      acknowledged: true,
    });
  }

  private async settleHeldSend(
    held: HeldSend,
    outcome: 'cancelled' | 'failed',
    reason: string = WORKTREE_SETUP_FAILED,
  ): Promise<void> {
    if (held.state !== 'held') return;
    held.state = 'settled';
    await this.endUnacceptedTurn(
      held.scope,
      held.command,
      held.timestamp,
      outcome,
      reason,
    );
  }

  /**
   * Ends a turn no provider accepted. One commit records how it ended on its
   * chat (`unacceptedTurnEnds`, which turnOutcome reports) and, while no
   * other turn runs the chat, in the chat's runtime. Its terminal event is
   * delivered only once that commit is durable, or once the chat itself is
   * gone. A commit that fails is retried with backoff; until one succeeds
   * the turn stays as durable state last recorded it, which startup
   * recovery records as interrupted if none ever does.
   */
  private async endUnacceptedTurn(
    scope: ChatScopeKey,
    command: { chatId: string; userMessageId: string },
    startedAt: number,
    outcome: 'cancelled' | 'failed',
    reason: string,
    attempt = 0,
  ): Promise<void> {
    const occurredAt = this.now();
    let acceptedMeanwhile = false;
    try {
      await this.repository.transactWith(
        scope,
        (current) => {
          const tab = current.tabsFile.tabs.find(
            (candidate) => candidate.id === command.chatId,
          );
          if (!tab) return [];
          if (
            attempt > 0 &&
            tab.lastAcceptedUserMessageId === command.userMessageId
          ) {
            acceptedMeanwhile = true;
            return [];
          }
          const runtime = current.runtimeByChatId[command.chatId];
          const ended = recordUnacceptedTurnEnds(
            tab,
            runtime,
            [
              {
                userMessageId: command.userMessageId,
                startedAt,
                outcome,
                reason,
              },
            ],
            occurredAt,
          );
          return [
            ...ended.mutations,
            ...(ended.runtime !== undefined && ended.runtime !== runtime
              ? [
                  {
                    type: 'runtime.patched' as const,
                    chatId: command.chatId,
                    runtime: ended.runtime,
                  },
                ]
              : []),
          ];
        },
        {
          source: 'provider',
          mutationId: unacceptedTurnMutationId(command, outcome),
          checkpoint: true,
          chatIds: [command.chatId],
        },
      );
    } catch (error) {
      logMainProcessWarn(
        `[chat-state] Could not record how an unaccepted turn ended for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
        error,
      );
      if (!this.draining && attempt < UNACCEPTED_TURN_END_RETRIES) {
        const retry = this.schedule(
          () => {
            void this.endUnacceptedTurn(
              scope,
              command,
              startedAt,
              outcome,
              reason,
              attempt + 1,
            );
          },
          Math.min(1_000 * 2 ** attempt, 30_000),
        );
        retry.unref?.();
      }
      return;
    }
    if (acceptedMeanwhile) return;
    this.deliverUnacceptedTurnEnd(scope, command, outcome, reason);
  }

  private deliverUnacceptedTurnEnd(
    scope: ChatScopeKey,
    command: { chatId: string; userMessageId: string },
    outcome: 'cancelled' | 'failed',
    reason: string,
    marker: Record<string, true> = { canopy_turn_unaccepted: true },
  ): void {
    void this.notifyTurnTerminal({
      ...scope,
      chatId: command.chatId,
      userMessageId: command.userMessageId,
      outcome,
      data: {
        type: 'result',
        is_error: outcome === 'failed',
        result: outcome === 'failed' ? reason : 'Cancelled',
        canopy_turn_user_message_id: command.userMessageId,
        ...marker,
      },
    }).catch((error: unknown) => {
      logMainProcessWarn(
        `[chat-state] Could not deliver the end of an unaccepted turn for ${scope.projectId}/${scope.worktreeId}/${command.chatId}:`,
        error,
      );
    });
  }

  private async settleHeldSendsOfChat(
    scope: ChatScopeKey,
    chatId: string,
  ): Promise<void> {
    const runtimeHostKey = chatRuntimeHostKey(scope, chatId);
    await Promise.all(
      Array.from(this.heldSends.values())
        .filter(
          (held) =>
            chatRuntimeHostKey(held.scope, held.command.chatId) ===
            runtimeHostKey,
        )
        .map((held) => this.settleHeldSend(held, 'cancelled')),
    );
  }

  private async dispatchAdmitted(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: SendMessageCommand,
    revision: number,
    admitted: {
      request: ChatSendMessageRequest;
      timestamp: number;
      installedStartingRuntime: boolean;
      acknowledged?: boolean;
    },
    asyncAnswer?: { questionId: string; answers: McpQuestionAnswer[] },
  ): Promise<ChatCommandResult> {
    const { request, timestamp, installedStartingRuntime } = admitted;
    try {
      // The live provider owns turn liveness. Async questions themselves never
      // pause a turn, and a persisted "streaming" status can be stale on resume.
      if (!asyncAnswer || !(await this.steer(request))) {
        await this.dispatch(request, envelope.origin ?? 'desktop');
      }
    } catch (error) {
      if (isAgentSenderContextError(error)) {
        // Dispatch can refuse an agent send after its input was committed.
        // Reject atomically before surfacing the typed refusal to the sender.
        if (!asyncAnswer && command.agentSenderProvenance) {
          await this.repository.transactWith(
            scope,
            (current) => [
              ...(current.tabsFile.tabs
                .find((candidate) => candidate.id === command.chatId)
                ?.messages.some(
                  (message) => message.id === command.userMessageId,
                )
                ? [
                    {
                      type: 'message.removed' as const,
                      chatId: command.chatId,
                      messageId: command.userMessageId,
                    },
                  ]
                : []),
              // Clear only a turn this send still owns, keeping queued payloads;
              // a newer send may have started or queued during authorization.
              ...((): ChatCoreMutation[] => {
                const runtime = current.runtimeByChatId[command.chatId];
                if (
                  !installedStartingRuntime ||
                  runtime?.activeTurn?.userMessageId !== command.userMessageId
                )
                  return [];
                const {
                  activeTurn: _ownedTurn,
                  error: _error,
                  ...rest
                } = runtime;
                void _ownedTurn;
                void _error;
                return [
                  {
                    type: 'runtime.patched' as const,
                    chatId: command.chatId,
                    runtime: {
                      ...rest,
                      status: 'idle' as const,
                      lastActivityAt: this.now(),
                    },
                  },
                ];
              })(),
            ],
            {
              source: 'renderer-command',
              mutationId: `${envelope.commandId}:agent-send-rejected`,
              commandResult: {
                commandId: envelope.commandId,
                outcome: 'rejected',
                reason: error.message,
              },
              chatIds: [command.chatId],
            },
          );
        }
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      if (asyncAnswer) {
        const rollback = await this.repository.transactWith(
          scope,
          (current) => {
            const question = current.tabsFile.pendingQuestions?.find(
              (candidate) =>
                candidate.requestId === asyncAnswer.questionId &&
                candidate.chatId === command.chatId,
            );
            if (!question || question.answeredAt !== timestamp) return [];
            const {
              answeredAt: _answeredAt,
              answers: _answers,
              ...pending
            } = question;
            void _answeredAt;
            void _answers;
            return [
              { type: 'pending_question.upserted', question: pending },
              {
                type: 'message.removed',
                chatId: command.chatId,
                messageId: command.userMessageId,
              },
            ];
          },
          {
            source: 'renderer-command',
            mutationId: `${envelope.commandId}:answer-rejected`,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'rejected',
              reason,
            },
          },
        );
        // An unknown transport failure must not trigger a second delivery or
        // settle the still-running provider. Keep the form for explicit retry.
        return commandResult(envelope, rollback.revision, 'rejected', {
          reason,
        });
      }
      if (!installedStartingRuntime && admitted.acknowledged !== true) {
        const rollback = await this.repository.transactWith(
          scope,
          (current) =>
            current.tabsFile.tabs
              .find((candidate) => candidate.id === command.chatId)
              ?.messages.some((message) => message.id === command.userMessageId)
              ? [
                  {
                    type: 'message.removed' as const,
                    chatId: command.chatId,
                    messageId: command.userMessageId,
                  },
                ]
              : [],
          {
            source: 'renderer-command',
            mutationId: `${envelope.commandId}:queue-rejected`,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'rejected',
              reason,
            },
            chatIds: [command.chatId],
          },
        );
        return commandResult(envelope, rollback.revision, 'rejected', {
          reason,
        });
      }
      if (
        await this.repository.hasMutation(
          scope,
          `${command.chatId}:${command.userMessageId}:accepted`,
        )
      ) {
        await this.repository.transactWith(
          scope,
          (current) => {
            const runtime = current.runtimeByChatId[command.chatId];
            if (
              runtime !== undefined &&
              runtime.activeTurn?.userMessageId !== command.userMessageId &&
              UNFINISHED_RUNTIME_STATUSES.includes(runtime.status)
            )
              return [];
            const failedRuntime: ChatRuntimeState = {
              status: 'failed',
              queuedMessageIds: runtime?.queuedMessageIds ?? [],
              ...(runtime?.queuedMessages
                ? { queuedMessages: runtime.queuedMessages }
                : {}),
              activeTurn: {
                userMessageId: command.userMessageId,
                startedAt: timestamp,
              },
              lastActivityAt: this.now(),
              error: {
                code: 'provider_error',
                message: reason,
                retryable: true,
                occurredAt: new Date(this.now()).toISOString(),
              },
            };
            const tab = current.tabsFile.tabs.find(
              (candidate) => candidate.id === command.chatId,
            );
            const turnEnds = tab
              ? settleTurnEnds(
                  tab.turnEnds,
                  runtime,
                  failedRuntime,
                  command.userMessageId,
                  this.now(),
                )
              : undefined;
            return [
              ...(tab && turnEnds && turnEnds !== tab.turnEnds
                ? [
                    {
                      type: 'tab.metadata_patched' as const,
                      tabId: tab.id,
                      patch: { turnEnds },
                    },
                  ]
                : []),
              {
                type: 'runtime.patched',
                chatId: command.chatId,
                runtime: failedRuntime,
              },
              ...settleRefusedAgentInput(tab, command.userMessageId, reason),
            ];
          },
          {
            source: 'provider',
            mutationId: `${envelope.commandId}:dispatch-failed`,
            checkpoint: true,
            chatIds: [command.chatId],
          },
        );
      } else {
        await this.endUnacceptedTurn(
          scope,
          command,
          timestamp,
          'failed',
          reason,
        );
        if (command.agentSenderProvenance)
          await this.repository.transactWith(
            scope,
            (current) =>
              settleRefusedAgentInput(
                current.tabsFile.tabs.find(
                  (candidate) => candidate.id === command.chatId,
                ),
                command.userMessageId,
                reason,
              ),
            {
              source: 'provider',
              mutationId: `${envelope.commandId}:agent-input-refused`,
              chatIds: [command.chatId],
            },
          );
      }
    }
    return commandResult(envelope, revision, 'applied', {
      entityId: command.chatId,
      messageId: command.userMessageId,
    });
  }

  private async commitTerminalInitialPrompt(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (command.type !== 'chat.commit_terminal_initial_prompt') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    validateId(command.chatId, 'chatId');
    validateId(command.userMessageId, 'userMessageId');
    validateId(command.turnTimerMessageId, 'turnTimerMessageId');
    const snapshot = await this.repository.getState(scope, {
      chatIds: [command.chatId],
    });
    const snapshotTab = snapshot.tabsFile.tabs.find(
      (tab) => tab.id === command.chatId,
    );
    const trustedInput = snapshotTab
      ? retainedTerminalAgentInput(snapshotTab, command.userMessageId)
      : undefined;
    if (trustedInput) await revalidateAgentSenderRequest(trustedInput);
    const timestamp = this.now();
    const firstMessageTitle = initialChatTitle(command.text);
    let precommitResult:
      | 'not_found'
      | 'already_applied'
      | 'rejected'
      | undefined;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        const tab = current.tabsFile.tabs.find(
          (candidate) => candidate.id === command.chatId,
        );
        if (!tab || tab.kind === 'file') {
          precommitResult = 'not_found';
          return [];
        }
        if (tab.readOnly) {
          precommitResult = 'rejected';
          return [];
        }
        if (tab.messages.some(({ id }) => id === command.userMessageId)) {
          precommitResult = 'already_applied';
          return [];
        }
        if (
          transaction.hasRemovedMessage(command.userMessageId) ||
          transaction.hasRemovedMessage(command.turnTimerMessageId)
        ) {
          precommitResult = 'not_found';
          return [];
        }
        const consumedIds = new Set(command.pendingSystemInstructionIds ?? []);
        const pendingSystemInstructions =
          tab.pendingSystemInstructions?.filter(
            (instruction) => !consumedIds.has(instruction.id),
          ) ?? [];
        const mutations: ChatCoreMutation[] = [];
        if (trustedInput && isInputLedger(tab.inputDelivery)) {
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              inputDelivery: {
                ...tab.inputDelivery,
                rows: tab.inputDelivery.rows.map((row) =>
                  row.id === command.userMessageId
                    ? { ...row, state: 'picked-up', revision: row.revision + 1 }
                    : row,
                ),
              },
            },
          });
        }
        if (
          tab.messages.length === 0 &&
          hasPlaceholderChatTitle(tab.title) &&
          tab.title !== firstMessageTitle
        ) {
          mutations.push({
            type: 'tab.created',
            tab: {
              ...tab,
              title: firstMessageTitle,
              automaticTitleState:
                tab.automaticTitleState === 'closed' ? 'closed' : 'pending',
            },
          });
        }
        mutations.push(
          {
            type: 'message.upserted',
            chatId: tab.id,
            message: buildUserMessage(trustedInput ?? command, timestamp),
          },
          {
            type: 'message.upserted',
            chatId: tab.id,
            message: {
              id: command.turnTimerMessageId,
              role: 'system',
              timestamp,
              blocks: [
                {
                  type: 'turn_timer',
                  startedAt: timestamp,
                  completedAt: null,
                },
              ],
            },
          },
        );
        if (
          consumedIds.size > 0 &&
          pendingSystemInstructions.length !==
            (tab.pendingSystemInstructions?.length ?? 0)
        ) {
          mutations.push({
            type: 'tab.metadata_patched',
            tabId: tab.id,
            patch: {
              pendingSystemInstructions:
                pendingSystemInstructions.length > 0
                  ? pendingSystemInstructions
                  : null,
            },
          });
        }
        return mutations;
      },
      {
        ...{
          source: 'terminal',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.chatId,
            messageId: command.userMessageId,
          },
        },
        chatIds: [command.chatId],
      },
    );
    if (precommitResult) {
      return commandResult(envelope, commit.revision, precommitResult, {
        entityId: command.chatId,
        messageId: command.userMessageId,
      });
    }
    return commandResult(
      envelope,
      commit.revision,
      commit.applied ? 'applied' : 'already_applied',
      { entityId: command.chatId, messageId: command.userMessageId },
    );
  }

  private async queueCommand(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    // See getState(): queue-service is loaded lazily to break its chat-state
    // port initialization cycle, not as a performance deferral.
    const { getChatQueueService } = await import('./chat-queue-service');
    const queue = getChatQueueService();
    const command = envelope.command;
    if (
      command.type !== 'chat.edit_queued_message' &&
      command.type !== 'chat.cancel_queued_message' &&
      command.type !== 'chat.steer_queued_message' &&
      command.type !== 'chat.force_queued_message'
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    const chatId = command.chatId;
    const durableCommandResult = {
      commandId: envelope.commandId,
      outcome: 'applied' as const,
      entityId: chatId,
      ...(command.type === 'chat.steer_queued_message' &&
      command.agentSteeringActor
        ? { agentSteeringActor: command.agentSteeringActor }
        : {}),
    };
    // Do not hold the repository's per-scope serializer while queue.force()
    // cancels and settles a provider turn: settlement re-enters this service
    // to commit the terminal provider event for the same scope.
    await this.repository.assertExpectedRevision(
      scope,
      expectedRevisionForCommand(envelope),
    );
    let queueResult: 'applied' | 'not_found' | 'busy';
    if (command.type === 'chat.edit_queued_message') {
      queueResult = await queue.edit(
        {
          ...scope,
          chatId: command.chatId,
          entryId: command.queuedMessageId,
          text: command.text,
          ...(command.fileReferences
            ? { fileReferences: command.fileReferences }
            : {}),
          ...(command.attachmentPaths
            ? { attachmentPaths: command.attachmentPaths }
            : {}),
          ...(command.attachmentPromptContexts
            ? { attachmentPromptContexts: command.attachmentPromptContexts }
            : {}),
          ...(command.inputMode ? { inputMode: command.inputMode } : {}),
        },
        durableCommandResult,
        envelope.origin === 'portal' ? 'preserve' : 'replace',
      );
    } else if (command.type === 'chat.cancel_queued_message') {
      queueResult = await queue.cancel(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
      );
    } else if (command.type === 'chat.steer_queued_message') {
      queueResult = await queue.steer(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
      );
    } else {
      queueResult = await queue.force(
        { ...scope, chatId: command.chatId },
        command.queuedMessageId,
        durableCommandResult,
      );
    }
    if (queueResult !== 'applied') {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        queueResult === 'not_found' ? 'not_found' : 'rejected',
        queueResult === 'busy'
          ? { reason: 'The queued message is currently being dispatched' }
          : undefined,
      );
    }
    return commandResult(
      envelope,
      await this.repository.getRevision(scope),
      'applied',
      { entityId: chatId },
    );
  }

  private async answerQuestion(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    dismiss: boolean,
    options: TrustedChatCommandExecutionOptions,
  ): Promise<ChatCommandResult> {
    const command = envelope.command;
    if (
      command.type !== 'chat.answer_question' &&
      command.type !== 'chat.dismiss_question'
    ) {
      return commandResult(
        envelope,
        await this.repository.getRevision(scope),
        'rejected',
      );
    }
    let question: PersistedPendingQuestion | undefined;
    let noOpOutcome: 'not_found' | 'already_applied' | undefined;
    try {
      const state = await this.repository.getState(scope);
      if (!dismiss && command.type === 'chat.answer_question') {
        const pending = state.tabsFile.pendingQuestions?.find(
          (candidate) =>
            candidate.chatId === command.chatId &&
            candidate.requestId === command.questionId,
        );
        if (pending?.delivery === 'async') {
          if (pending.answeredAt !== undefined)
            return commandResult(
              envelope,
              await this.repository.getRevision(scope),
              'already_applied',
            );
          // Use the stored question text and ids, never caller-supplied labels.
          if (command.answers.length !== pending.questions.length)
            throw new Error('Answer every question before submitting');
          const answers = pending.questions.map((question, index) => {
            const answer = command.answers[index];
            if (
              !answer ||
              (answer.questionId !== undefined &&
                answer.questionId !== question.id) ||
              answer.selectedOptions.length > 1 ||
              answer.selectedOptions.some(
                (option) => !question.options.includes(option),
              ) ||
              (!answer.selectedOptions.length && !answer.freeformText?.trim())
            )
              throw new Error('Invalid question answer');
            return {
              ...answer,
              questionId: question.id,
              question: question.question,
            };
          });
          return await this.sendMessage(
            scope,
            {
              ...envelope,
              command: {
                type: 'chat.send_message',
                chatId: command.chatId,
                userMessageId: `answer-${envelope.commandId}`,
                text: formatAskUserAnswers(answers),
                ...(options.agentSent ? { agentSent: options.agentSent } : {}),
              },
            },
            options,
            { questionId: pending.requestId, answers },
          );
        }
      }
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const currentQuestion = (
            current.tabsFile.pendingQuestions ?? []
          ).find(
            (candidate) =>
              candidate.chatId === command.chatId &&
              (candidate.requestId === command.questionId ||
                candidate.toolUseId === command.questionId),
          );
          question = currentQuestion;
          if (!currentQuestion) {
            noOpOutcome = 'not_found';
            return [];
          }
          if (currentQuestion.answeredAt !== undefined) {
            noOpOutcome = 'already_applied';
            return [];
          }
          if (command.type === 'chat.answer_question') {
            const error = validateQuestionControlAnswers(
              currentQuestion.questions,
              command.answers,
            );
            if (error) throw new Error(error);
          }
          const persistedAnswers =
            command.type === 'chat.answer_question'
              ? command.answers.map((answer, index) => {
                  const suppliedQuestionId =
                    typeof answer.questionId === 'string' &&
                    answer.questionId.length > 0
                      ? answer.questionId
                      : undefined;
                  const matchedQuestion = suppliedQuestionId
                    ? currentQuestion.questions.find(
                        (candidate) => candidate.id === suppliedQuestionId,
                      )
                    : currentQuestion.questions[index];
                  const persistedAnswer =
                    typeof matchedQuestion?.id === 'string' &&
                    matchedQuestion.id.length > 0
                      ? { ...answer, questionId: matchedQuestion.id }
                      : answer;
                  if (!answer.freeformText) {
                    return persistedAnswer;
                  }
                  if (
                    matchedQuestion !== undefined &&
                    matchedQuestion.secret !== true
                  ) {
                    return persistedAnswer;
                  }
                  return { ...persistedAnswer, freeformText: '[hidden]' };
                })
              : [];
          return dismiss && currentQuestion.delivery !== 'async'
            ? [
                {
                  type: 'pending_question.removed' as const,
                  requestId: currentQuestion.requestId,
                  chatId: currentQuestion.chatId,
                },
              ]
            : [
                {
                  type: 'pending_question.upserted' as const,
                  question: {
                    ...currentQuestion,
                    answers: persistedAnswers,
                    answeredAt: this.now(),
                    ...(dismiss ? { dismissedAt: this.now() } : {}),
                  },
                },
              ];
        },
        {
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
          },
          ...expectedRevisionOption(envelope),
        },
      );
      if (noOpOutcome) {
        return commandResult(envelope, commit.revision, noOpOutcome, {
          ...(question ? { entityId: question.requestId } : {}),
        });
      }
      if (!question) {
        return commandResult(envelope, commit.revision, 'rejected');
      }
      if (commit.applied) {
        if (question.delivery === 'async')
          return commandResult(envelope, commit.revision, 'applied', {
            entityId: question.requestId,
          });
        if (dismiss) rejectRequest(question.requestId, 'cancelled');
        else if (command.type === 'chat.answer_question') {
          resolveRequest(question.requestId, command.answers);
        }
      }
      return commandResult(envelope, commit.revision, 'applied', {
        entityId: question.requestId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async closeTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    tabId: string,
    mode: 'archive' | 'discard_empty' | 'discard',
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    let reason: string | undefined;
    let result: ChatCommandResult;
    try {
      const commit = await this.repository.transactWith(
        scope,
        (state) => {
          const tab = state.tabsFile.tabs.find(
            (candidate) => candidate.id === tabId,
          );
          if (!tab) {
            outcome = 'not_found';
            return [];
          }
          const runtime = state.runtimeByChatId[tabId];
          const runtimeActive =
            runtime !== undefined &&
            [
              'queued',
              'starting',
              'streaming',
              'awaiting_input',
              'completing',
            ].includes(runtime.status);
          if (
            runtimeActive ||
            hasLiveDelegations(
              `${scope.projectId}/${scope.worktreeId}/${tabId}`,
            ) ||
            (isInputLedger(tab.inputDelivery) &&
              tab.inputDelivery.rows.some((row) =>
                ['sending', 'pending', 'cancelling'].includes(row.state),
              )) ||
            (runtime?.queuedMessageIds.length ?? 0) > 0 ||
            tab.pendingPlanExit !== undefined
          ) {
            outcome = 'rejected';
            reason =
              'The chat cannot be closed while it has active, queued, or pending plan work';
            return [];
          }
          if (mode === 'discard_empty' && tab.messages.length > 0) {
            outcome = 'rejected';
            reason = 'Only a deliberately blank starter can be discarded';
            return [];
          }
          if (
            mode === 'discard' &&
            !isHardDeleteChatScope(scope.projectId, scope.worktreeId)
          ) {
            outcome = 'rejected';
            reason =
              'Only sentinel scopes that never archive can discard a used chat';
            return [];
          }
          const mutations: ChatCoreMutation[] = [
            { type: 'tab.removed', tabId },
          ];
          if (mode === 'archive') {
            const archivedAt = this.now();
            const messages = closeOpenPersistedToolUses(
              closeOpenPersistedTurnTimers(tab.messages, archivedAt),
              archivedAt,
            );
            const finalizedTab =
              messages === tab.messages ? tab : { ...tab, messages };
            mutations.push({
              type: 'archive.upserted',
              entry: {
                tab: finalizedTab,
                archivedAt: new Date(archivedAt).toISOString(),
                turnCount: countTurns(finalizedTab),
                ...('unread' in envelope.command && envelope.command.unread
                  ? { unread: true }
                  : {}),
              },
            });
          }
          const closeCommand =
            envelope.command.type === 'chat.close_tab'
              ? envelope.command
              : undefined;
          const replacementTabId =
            closeCommand?.replacementTab?.tabId ??
            closeCommand?.replacementTabId;
          if (replacementTabId && state.tabsFile.tabs.length === 1) {
            const replacementCommand = closeCommand?.replacementTab ?? {
              type: 'chat.create_tab' as const,
              tabId: replacementTabId,
            };
            const replacement = persistedChatTabFromCreateCommand(
              replacementCommand,
              new Date(this.now()).toISOString(),
              scope.projectId,
            );
            mutations.push(
              { type: 'tab.created', tab: replacement },
              { type: 'tab.active_changed', activeTabId: replacement.id },
            );
          } else if (state.tabsFile.activeTabId === tabId) {
            const remainingTabs = state.tabsFile.tabs.filter(
              (candidate) => candidate.id !== tabId,
            );
            const successor = remainingTabs[remainingTabs.length - 1];
            if (successor) {
              const rememberedEditableTab = rememberedEditableTabAfterClose(
                remainingTabs,
                successor.id,
                state.tabsFile.lastActiveEditableChatId,
              );
              mutations.push({
                type: 'tab.active_changed',
                activeTabId: successor.id,
                ...(rememberedEditableTab
                  ? { lastActiveEditableChatId: rememberedEditableTab.id }
                  : {}),
              });
              if (successor.kind !== 'file') {
                mutations.push({
                  type: 'tab.metadata_patched',
                  tabId: successor.id,
                  patch: {
                    unread: false,
                    attentionDismissedAt: this.now(),
                  },
                });
              }
            }
          }
          return mutations;
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: tabId,
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [tabId],
        },
      );
      result = commandResult(envelope, commit.revision, outcome, {
        ...(reason ? { reason } : {}),
        ...(outcome === 'applied' ? { entityId: tabId } : {}),
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      result = commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.outcome === 'applied') {
      await this.settleHeldSendsOfChat(scope, tabId);
      const keepSession =
        envelope.command.type === 'chat.archive_tab' &&
        envelope.command.keepSession === true;
      if (keepSession) {
        // session-manager owns provider sessions that call back into this
        // service, so resolve it only after the archive commit is complete.
        const { markChatSessionIdle } =
          await import('../agents/session-manager');
        markChatSessionIdle(scope.projectId, scope.worktreeId, tabId);
      } else {
        const target = { ...scope, chatId: tabId };
        try {
          await this.cleanupSession(target);
        } catch (error) {
          const retry = this.schedule(() => {
            void this.cleanupSession(target).catch((retryError: unknown) => {
              logMainProcessWarn(
                `[chat-state] Provider cleanup retry failed for ${scope.projectId}/${scope.worktreeId}/${tabId}:`,
                retryError,
              );
            });
          }, 1_000);
          retry.unref?.();
          logMainProcessWarn(
            `[chat-state] Provider cleanup failed; scheduled retry for ${scope.projectId}/${scope.worktreeId}/${tabId}:`,
            error,
          );
        }
      }
    }
    return result;
  }

  private async closeTabs(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.close_tabs' }>,
  ): Promise<ChatCommandResult> {
    const cleanupIds: string[] = [];
    let outcome: ChatCommandResult['outcome'] = 'applied';
    let reason: string | undefined;
    let resultEntityId: string | undefined = command.targets[0]?.tabId;
    let result: ChatCommandResult;
    try {
      const commit = await this.repository.transactWith(
        scope,
        (state) => {
          const targetIds = new Set<string>();
          const mutations: ChatCoreMutation[] = [];
          const archivedAt = this.now();
          cleanupIds.length = 0;

          for (const target of command.targets) {
            if (targetIds.has(target.tabId)) {
              outcome = 'rejected';
              reason = 'A tab can appear only once in a bulk close';
              resultEntityId = undefined;
              return [];
            }
            targetIds.add(target.tabId);
            const tab = state.tabsFile.tabs.find(
              (candidate) => candidate.id === target.tabId,
            );
            if (!tab) {
              outcome = 'not_found';
              resultEntityId = target.tabId;
              return [];
            }
            const runtime = state.runtimeByChatId[target.tabId];
            const runtimeActive =
              runtime !== undefined &&
              [
                'queued',
                'starting',
                'streaming',
                'awaiting_input',
                'completing',
              ].includes(runtime.status);
            if (
              runtimeActive ||
              hasLiveDelegations(
                `${scope.projectId}/${scope.worktreeId}/${target.tabId}`,
              ) ||
              (isInputLedger(tab.inputDelivery) &&
                tab.inputDelivery.rows.some((row) =>
                  ['sending', 'pending', 'cancelling'].includes(row.state),
                )) ||
              (runtime?.queuedMessageIds.length ?? 0) > 0 ||
              tab.pendingPlanExit !== undefined
            ) {
              outcome = 'rejected';
              reason =
                'The chat cannot be closed while it has active, queued, or pending plan work';
              resultEntityId = target.tabId;
              return [];
            }
            if (target.mode === 'discard_empty' && tab.messages.length > 0) {
              outcome = 'rejected';
              reason = 'Only a deliberately blank starter can be discarded';
              resultEntityId = target.tabId;
              return [];
            }
            if (
              target.mode === 'discard' &&
              !isHardDeleteChatScope(scope.projectId, scope.worktreeId)
            ) {
              outcome = 'rejected';
              reason =
                'Only sentinel scopes that never archive can discard a used chat';
              resultEntityId = target.tabId;
              return [];
            }

            mutations.push({ type: 'tab.removed', tabId: target.tabId });
            if (target.mode === 'archive') {
              const messages = closeOpenPersistedToolUses(
                closeOpenPersistedTurnTimers(tab.messages, archivedAt),
                archivedAt,
              );
              const finalizedTab =
                messages === tab.messages ? tab : { ...tab, messages };
              mutations.push({
                type: 'archive.upserted',
                entry: {
                  tab: finalizedTab,
                  archivedAt: new Date(archivedAt).toISOString(),
                  turnCount: countTurns(finalizedTab),
                },
              });
            }
            cleanupIds.push(target.tabId);
          }

          const replacementTabId =
            command.replacementTab?.tabId ?? command.replacementTabId;
          if (
            replacementTabId &&
            targetIds.size === state.tabsFile.tabs.length
          ) {
            const replacementCommand = command.replacementTab ?? {
              type: 'chat.create_tab' as const,
              tabId: replacementTabId,
            };
            const replacement = persistedChatTabFromCreateCommand(
              replacementCommand,
              new Date(this.now()).toISOString(),
              scope.projectId,
            );
            mutations.push(
              { type: 'tab.created', tab: replacement },
              { type: 'tab.active_changed', activeTabId: replacement.id },
            );
          } else if (targetIds.has(state.tabsFile.activeTabId)) {
            const previousActiveIndex = state.tabsFile.tabs.findIndex(
              (candidate) => candidate.id === state.tabsFile.activeTabId,
            );
            const remainingTabs = state.tabsFile.tabs.filter(
              (candidate) => !targetIds.has(candidate.id),
            );
            const successor =
              remainingTabs[
                Math.min(previousActiveIndex, remainingTabs.length - 1)
              ];
            if (successor) {
              const rememberedEditableTab = rememberedEditableTabAfterClose(
                remainingTabs,
                successor.id,
                state.tabsFile.lastActiveEditableChatId,
              );
              mutations.push({
                type: 'tab.active_changed',
                activeTabId: successor.id,
                ...(rememberedEditableTab
                  ? { lastActiveEditableChatId: rememberedEditableTab.id }
                  : {}),
              });
              if (successor.kind !== 'file') {
                mutations.push({
                  type: 'tab.metadata_patched',
                  tabId: successor.id,
                  patch: {
                    unread: false,
                    attentionDismissedAt: this.now(),
                  },
                });
              }
            }
          }
          return mutations;
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              ...(command.targets[0]?.tabId
                ? { entityId: command.targets[0].tabId }
                : {}),
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: command.targets.map((target) => target.tabId),
        },
      );
      result = commandResult(envelope, commit.revision, outcome, {
        ...(reason ? { reason } : {}),
        ...(resultEntityId ? { entityId: resultEntityId } : {}),
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      result = commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.outcome === 'applied') {
      for (const chatId of cleanupIds) {
        await this.settleHeldSendsOfChat(scope, chatId);
        const cleanupTarget = { ...scope, chatId };
        try {
          await this.cleanupSession(cleanupTarget);
        } catch (error) {
          const retry = this.schedule(() => {
            void this.cleanupSession(cleanupTarget).catch(
              (retryError: unknown) => {
                logMainProcessWarn(
                  `[chat-state] Provider cleanup retry failed for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
                  retryError,
                );
              },
            );
          }, 1_000);
          retry.unref?.();
          logMainProcessWarn(
            `[chat-state] Provider cleanup failed; scheduled retry for ${scope.projectId}/${scope.worktreeId}/${chatId}:`,
            error,
          );
        }
      }
    }
    return result;
  }

  private async restoreArchive(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.restore_archive' }>,
  ): Promise<ChatCommandResult> {
    let outcome: ChatCommandResult['outcome'] = 'applied';
    const targetTabId = command.targetTabId ?? command.archiveEntryId;
    try {
      const commit = await this.repository.transactWith(
        scope,
        (current) => {
          const entry = current.archivesFile.archived.find(
            (candidate) => candidate.tab.id === command.archiveEntryId,
          );
          if (!entry) {
            outcome = current.tabsFile.tabs.some(
              (tab) => tab.id === targetTabId,
            )
              ? 'already_applied'
              : 'not_found';
            return [];
          }
          if (current.tabsFile.tabs.some((tab) => tab.id === targetTabId)) {
            outcome = 'conflict';
            return [];
          }
          const { autoArchive: _autoArchive, ...restoredTab } = entry.tab;
          void _autoArchive;
          return [
            {
              type: 'archive.removed',
              archiveEntryId: entry.tab.id,
              chatId: entry.tab.id,
            },
            {
              type: 'tab.created',
              tab: { ...restoredTab, id: targetTabId },
              ...(targetTabId !== entry.tab.id
                ? { transcriptSourceChatId: entry.tab.id }
                : {}),
            },
            { type: 'tab.active_changed', activeTabId: targetTabId },
          ];
        },
        {
          ...{
            source: 'renderer-command',
            mutationId: envelope.commandId,
            commandResult: {
              commandId: envelope.commandId,
              outcome: 'applied',
              entityId: targetTabId,
            },
            ...expectedRevisionOption(envelope),
          },
          chatIds: [command.archiveEntryId],
          fullTranscript: targetTabId !== command.archiveEntryId,
        },
      );
      if (!commit.applied && outcome === 'applied') {
        outcome = 'already_applied';
      }
      return commandResult(envelope, commit.revision, outcome, {
        entityId: targetTabId,
      });
    } catch (error) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(
        envelope,
        revision,
        error instanceof ChatStateRevisionConflictError
          ? 'conflict'
          : 'rejected',
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async markAllArchivesRead(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope);
    const mutations: ChatCoreMutation[] = state.archivesFile.archived
      .filter((entry) => entry.unread)
      .map((entry) => ({
        type: 'archive.read_state_changed' as const,
        archiveEntryId: entry.tab.id,
        chatId: entry.tab.id,
        unread: false,
      }));
    if (mutations.length === 0) {
      return commandResult(
        envelope,
        state.tabsFile.revision ?? 0,
        'already_applied',
      );
    }
    return this.commit(scope, envelope, mutations);
  }

  private async forkTab(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.fork_tab' }>,
  ): Promise<ChatCommandResult> {
    if (
      command.destinationTab !== undefined &&
      (command.destinationTab.id !== command.targetTabId ||
        command.destinationTab.messages.length !== 0 ||
        !isPersistedChatTab(command.destinationTab))
    ) {
      const revision = await this.repository.getRevision(scope);
      return commandResult(envelope, revision, 'rejected', {
        reason: 'The continuation destination metadata is invalid',
      });
    }
    let tombstonedTarget = false;
    let missingSourceOrAnchor = false;
    const commit = await this.repository.transactWith(
      scope,
      (current, _revision, transaction) => {
        if (transaction.hasRemovedTab(command.targetTabId)) {
          tombstonedTarget = true;
          return [];
        }
        if (
          current.tabsFile.tabs.some(
            (candidate) => candidate.id === command.targetTabId,
          )
        ) {
          return [];
        }
        const source = current.tabsFile.tabs.find(
          (tab) => tab.id === command.sourceTabId,
        );
        if (!source) {
          missingSourceOrAnchor = true;
          return [];
        }
        const atIndex = command.atMessageId
          ? source.messages.findIndex(
              (message) => message.id === command.atMessageId,
            )
          : source.messages.length - 1;
        if (atIndex < 0) {
          missingSourceOrAnchor = true;
          return [];
        }
        // Fork construction belongs to this serialized snapshot. Building it
        // before transactWith lets a concurrent source mutation produce a
        // stale fork even though creation itself is journal-atomic.
        const truncated = atIndex < source.messages.length - 1;
        const forkTitleLabel =
          source.customTitle?.trim() ||
          source.description?.trim() ||
          source.title.trim() ||
          'Chat';
        const forkAnchorMessageId =
          command.atMessageId ?? source.messages[atIndex]?.id;
        let fork: PersistedChatTab = {
          ...structuredClone(source),
          id: command.targetTabId,
          title: forkTitleLabel.startsWith('Fork: ')
            ? forkTitleLabel
            : `Fork: ${forkTitleLabel}`,
          createdAt: new Date(this.now()).toISOString(),
          messages:
            command.cloneMode === 'continuation'
              ? closeOpenPersistedTurnTimers(
                  structuredClone(source.messages.slice(0, atIndex + 1)),
                  this.now(),
                )
              : settlePersistedForkMessages(
                  structuredClone(source.messages.slice(0, atIndex + 1)),
                  this.now(),
                ),
          newChatStartedWatcherPending: true,
          forkedFrom: {
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: source.id,
            ...(forkAnchorMessageId
              ? { atMessageId: forkAnchorMessageId }
              : {}),
          },
        };
        if (command.destinationTab) {
          const canonicalMessages = fork.messages;
          fork = {
            ...fork,
            ...structuredClone(command.destinationTab),
            id: command.targetTabId,
            messages: canonicalMessages,
          };
        }
        // A derived creation title does not transfer the user-owned override.
        delete fork.customTitle;
        delete fork.mcpActivation;
        delete fork.automaticTitleState;
        // Session AI Credits routing covered the source chat's usage limit;
        // a fork starts on its normal billing. Persistent routing and the
        // subscription choice are durable chat settings and carry over
        // (CAN-4200).
        if (fork.aiCreditsRouting?.scope === 'session') {
          delete fork.aiCreditsRouting;
        }
        // The latest response can be beyond a historical fork's cutoff.
        // Match the optimistic renderer clone in this durable snapshot,
        // including when destination metadata supplied its own usage state.
        if (truncated && fork.usage) {
          delete fork.usage.cursorReportedUsage;
          if (fork.usage.opencodeReportedUsage) {
            delete fork.usage.opencodeReportedUsage;
            fork.usage.contextTokens = 0;
            fork.usage.contextWindow = 0;
          }
        }
        const forkSource = structuredClone(source);
        if (truncated && isInputLedger(forkSource.inputDelivery)) {
          const anchorTimestamp = source.messages[atIndex]?.timestamp;
          forkSource.inputDelivery = {
            ...forkSource.inputDelivery,
            rows: forkSource.inputDelivery.rows.filter(
              (row) =>
                anchorTimestamp !== undefined &&
                row.createdAt <= anchorTimestamp,
            ),
          };
        }
        fork.inputDelivery = detachInputDelivery(
          forkSource,
          { ...scope, chatId: fork.id },
          () => randomUUID(),
        );
        delete fork.newChatStartedWatcherFiredAt;
        delete fork.adhocMigrationSource;
        delete fork.sharedRun;
        delete fork.pendingRevertAttachmentPath;
        delete fork.scheduledSendDraft;
        delete fork.readOnly;
        delete fork.staleSessionDetected;
        delete fork.llmProviderUsageLimitBanner;
        delete fork.dismissedLlmProviderUsageLimitBannerKey;
        delete fork.attentionDismissedAt;
        delete fork.autoArchive;
        delete fork.unread;
        delete fork.codexReconstructionSeedId;
        delete fork.claudeTerminal;
        const providerType =
          source.providerType ??
          (source.model ? getProviderForModel(source.model) : 'claude');
        const carriedSdkSessionId =
          command.sourceSdkSessionId ?? source.sdkSessionId;
        // Every ordinary Claude fork is a snapshot: even a whole-history fork
        // can sit unsent while the source advances. Carry the source session
        // only with the last kept chain entry as `resumeSessionAt`. Explicit
        // continuation/import flows use cloneMode='continuation' instead.
        // Legacy transcripts without a chain entry start fresh, and fresh
        // provenance propagates through later forks.
        const claudeFork =
          command.cloneMode !== 'continuation' && providerType === 'claude';
        const forkRequiresResumePoint =
          claudeFork && carriedSdkSessionId !== undefined;
        const sourceStartsFresh =
          carriedSdkSessionId === undefined &&
          (truncated || source.forkedFrom?.modelContext === 'fresh');
        const forkResumePoint = forkRequiresResumePoint
          ? resolveClaudeForkResumePoint(
              fork.messages,
              fork.messages[fork.messages.length - 1]?.id,
            )
          : undefined;
        if (
          claudeFork &&
          carriedSdkSessionId &&
          (!forkRequiresResumePoint || forkResumePoint !== undefined)
        ) {
          fork.sdkSessionId = carriedSdkSessionId;
          fork.claudeForkSessionOnNextSend = true;
          if (forkRequiresResumePoint && fork.forkedFrom) {
            fork.forkedFrom = {
              ...fork.forkedFrom,
              resumePointRequired: true,
            };
          }
        } else {
          delete fork.sdkSessionId;
          delete fork.claudeForkSessionOnNextSend;
          if (
            claudeFork &&
            (forkRequiresResumePoint || sourceStartsFresh) &&
            fork.forkedFrom
          ) {
            fork.forkedFrom = { ...fork.forkedFrom, modelContext: 'fresh' };
          }
        }
        if (providerType === 'opencode') {
          clearOpenCodeForkPlanReview(fork);
        }
        if (
          providerType === 'opencode' &&
          command.cloneMode !== 'continuation'
        ) {
          // The copied canonical snapshot determines context, not renderer metadata.
          fork.forkedFrom = {
            projectId: scope.projectId,
            worktreeId: scope.worktreeId,
            chatId: source.id,
            ...(forkAnchorMessageId
              ? { atMessageId: forkAnchorMessageId }
              : {}),
          };
          prepareOpenCodeVisibleFork(fork);
          delete fork.pendingSystemInstructions;
        }
        if (command.syncWarning) {
          const timestamp = this.now();
          fork.messages.push({
            id: `${command.targetTabId}-terminal-sync-warning`,
            role: 'system',
            timestamp,
            blocks: [
              {
                type: 'claude_terminal_sync_warning',
                timestamp,
                message: command.syncWarning,
              },
            ],
          });
        }
        return [
          {
            type: 'tab.created' as const,
            tab: fork,
            transcriptSourceChatId: source.id,
          },
          { type: 'tab.active_changed' as const, activeTabId: fork.id },
        ];
      },
      {
        ...{
          source: 'renderer-command',
          mutationId: envelope.commandId,
          commandResult: {
            commandId: envelope.commandId,
            outcome: 'applied',
            entityId: command.targetTabId,
          },
          ...expectedRevisionOption(envelope),
        },
        chatIds: [command.sourceTabId],
        fullTranscript: true,
      },
    );
    if (tombstonedTarget) {
      return commandResult(envelope, commit.revision, 'not_found', {
        entityId: command.targetTabId,
        reason: 'The fork target id is tombstoned',
      });
    }
    if (missingSourceOrAnchor) {
      return commandResult(envelope, commit.revision, 'not_found');
    }
    const targetExists = commit.state.tabsFile.tabs.some(
      (candidate) => candidate.id === command.targetTabId,
    );
    return commandResult(
      envelope,
      commit.revision,
      !targetExists
        ? 'not_found'
        : commit.applied
          ? 'applied'
          : 'already_applied',
      { entityId: command.targetTabId },
    );
  }

  private async resetToPoint(
    scope: ChatScopeKey,
    envelope: ChatCommandEnvelope,
    command: Extract<ChatCommand, { type: 'chat.reset_to_point' }>,
  ): Promise<ChatCommandResult> {
    const state = await this.repository.getState(scope, {
      chatIds: [command.chatId],
      fullTranscript: true,
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === command.chatId,
    );
    if (!tab)
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    const index = tab.messages.findIndex(
      (message) => message.id === command.userMessageId,
    );
    if (index < 0)
      return commandResult(envelope, state.tabsFile.revision ?? 0, 'not_found');
    const messages = tab.messages.slice(0, index + 1);
    const removedMessages = tab.messages.slice(index + 1);
    const removedMessageIds = removedMessages.map((message) => message.id);
    const removedAsyncQuestionIds = new Set(
      removedMessages.flatMap((message) =>
        message.blocks.flatMap((block) =>
          block.type === 'text' && block.asyncQuestion
            ? [block.asyncQuestion.requestId]
            : [],
        ),
      ),
    );
    const pendingQuestionRemovals = (state.tabsFile.pendingQuestions ?? [])
      .filter(
        (question) =>
          question.chatId === tab.id &&
          removedAsyncQuestionIds.has(question.requestId),
      )
      .map((question) => ({
        type: 'pending_question.removed' as const,
        requestId: question.requestId,
        chatId: tab.id,
      }));
    return this.commit(
      scope,
      envelope,
      [
        {
          type: 'messages.replaced',
          chatId: tab.id,
          messages,
          removedMessageIds,
        },
        ...pendingQuestionRemovals,
        {
          type: 'runtime.patched',
          chatId: tab.id,
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { entityId: tab.id },
    );
  }

  private async publishCommit(commit: ChatStateCommit): Promise<void> {
    const projectionScopeKey = `${commit.projectId}\u0000${commit.worktreeId}`;
    this.latestProjectionCommitRevisionByScope.set(
      projectionScopeKey,
      Math.max(
        this.latestProjectionCommitRevisionByScope.get(projectionScopeKey) ?? 0,
        commit.revision,
      ),
    );
    const changedTabIds = new Set<string>();
    const removedTabIds = new Set<string>();
    for (const mutation of commit.record.mutations) {
      switch (mutation.type) {
        case 'tab.created':
          changedTabIds.add(mutation.tab.id);
          break;
        case 'tab.metadata_patched':
          changedTabIds.add(mutation.tabId);
          break;
        case 'message.upserted':
        case 'message.removed':
        case 'messages.replaced':
        case 'runtime.patched':
          changedTabIds.add(mutation.chatId);
          break;
        case 'pending_question.upserted':
          this.pendingQuestionScopes.set(mutation.question.requestId, {
            projectId: commit.projectId,
            worktreeId: commit.worktreeId,
            chatId: mutation.question.chatId,
          });
          changedTabIds.add(mutation.question.chatId);
          break;
        case 'pending_question.removed':
          this.pendingQuestionScopes.delete(mutation.requestId);
          changedTabIds.add(mutation.chatId);
          break;
        case 'tab.removed':
          changedTabIds.delete(mutation.tabId);
          removedTabIds.add(mutation.tabId);
          break;
        default:
          break;
      }
    }
    publishForeignChatActivity({
      projectId: commit.projectId,
      worktreeId: commit.worktreeId,
      tabs: commit.state.tabsFile.tabs.filter((tab): boolean =>
        changedTabIds.has(tab.id),
      ),
      runtimeByChatId: commit.state.runtimeByChatId,
      removedTabIds: Array.from(removedTabIds),
    });
    const delta = {
      changedTabIds: Array.from(changedTabIds),
      removedTabIds: Array.from(removedTabIds),
    };
    try {
      await notifyChatTabsMaterialized(
        commit.projectId,
        commit.worktreeId,
        commit.state.tabsFile,
        delta,
      );
    } catch (error) {
      const retry = this.schedule(() => {
        void (async (): Promise<void> => {
          if (
            (this.latestProjectionCommitRevisionByScope.get(
              projectionScopeKey,
            ) ?? 0) > commit.revision
          ) {
            return;
          }
          try {
            await notifyChatTabsMaterialized(
              commit.projectId,
              commit.worktreeId,
              commit.state.tabsFile,
              delta,
            );
          } catch (retryError) {
            logMainProcessWarn(
              `[chat-state] Projection retry failed at revision ${commit.revision}:`,
              retryError,
            );
          }
        })();
      }, 100);
      retry.unref?.();
      logMainProcessWarn(
        `[chat-state] Projection failed; scheduled retry at revision ${commit.revision}:`,
        error,
      );
    }
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: this.createId(),
      occurredAt: commit.record.occurredAt,
      projectId: commit.projectId,
      worktreeId: commit.worktreeId,
      baseRevision: commit.baseRevision,
      revision: commit.revision,
      changes: [
        ...projectChatStateChanges(commit.record.mutations),
        ...commit.state.tabsFile.tabs.flatMap((tab) =>
          tab.transcript && changedTabIds.has(tab.id)
            ? [
                {
                  type: 'transcript.updated' as const,
                  chatId: tab.id,
                  transcript: tab.transcript,
                  reset: commit.record.mutations.some(
                    (mutation) =>
                      (mutation.type === 'messages.replaced' ||
                        mutation.type === 'message.removed') &&
                      mutation.chatId === tab.id,
                  ),
                },
              ]
            : [],
        ),
      ],
    };
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch {
        const retry = setTimeout(() => {
          try {
            if (this.listeners.has(listener)) listener(event);
          } catch {
            // Projection retries remain isolated from canonical state.
          }
        }, 100);
        retry.unref?.();
      }
    }
  }
}

let chatStateService: ChatStateService | undefined;

export function getChatStateService(): ChatStateService {
  if (!chatStateService) {
    chatStateService = new ChatStateService({
      claudeToolNames: new Set([
        CANOPY_INJECTED_TOOL_REGISTRY.show_visual.claudeToolName,
      ]),
      codexToolNames: new Set([
        CANOPY_INJECTED_TOOL_REGISTRY.show_visual.codexToolName,
      ]),
      cursorToolUse: hasTrustedVisualToolUse,
    });
    // Lazy for the same initialization cycle as `recordDiagnostic` above.
    installChatTranscriptRewriteDiagnosticSink((record): void => {
      void import('../observability')
        .then(({ getObservabilityService }) => {
          getObservabilityService().recordAppDiagnostic(record);
        })
        .catch(() => {
          // A rewrite diagnostic never changes a committed transaction.
        });
    });
  }
  return chatStateService;
}

/**
 * Drop the singleton so the next `getChatStateService()` builds a fresh one,
 * or install `next` (a service built with test-specific repository options).
 */
export function resetChatStateServiceForTests(next?: ChatStateService): void {
  chatStateService = next;
}

/** Main-only watcher producer reads; never an interface command port. */
export function readChatWatcherSnapshot(
  target: ChatScopeKey,
): Promise<ChatStateSnapshot> {
  return getChatStateService().getState(target);
}

export function consumeChatWatcherTranscript<T>(
  target: ChatScopeKey & { chatId: string },
  consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
): Promise<T> {
  return getChatStateService().consumeTranscript(
    target,
    target.chatId,
    false,
    consume,
  );
}
