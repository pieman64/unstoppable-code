import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  CHAT_TRANSIENT_RETRY_DELAYS_MS,
  CHAT_TRANSIENT_RETRY_MAX_ATTEMPTS,
  classifyAgentFailure,
  isRetryableCodexTransportFailureEvent,
} from '@canopy/execution-engine/agent-failures';
import {
  computeUsageLimitResumePrompt,
  USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
  type UsageLimitResumePrompt,
} from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import {
  IPC_CHANNELS,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  TRANSIENT_RETRY_STATE_EVENT_TYPE,
  getProviderForModel,
  isTerminalBackedInterfaceMode,
  type AgentProviderType,
  type ChatActiveSessionInfo,
  type ChatSendMessageRequest,
  type PersistedChatTab,
  type TransientRetryStateEventData,
  type TransientRetryStateSnapshotEntry,
  type UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';
import {
  getAllActiveSessionInfos,
  getSessionAiCreditsRoutedState,
  isSessionAiCreditsRouted,
} from '../agents/session-manager';
import { getEffectiveClaudeChatInterfaceMode } from './claude-tui-chats';
import {
  getChatTurnAuditStatus,
  isRecord,
  isTerminalChatEventData,
} from './chat-turn-audit';
import { readChatTabsFile } from './chat-tabs-reader';
import { isTransientRetryEligibleTarget } from './chat-targets';
import { readPreferencesFile } from './preferences-store';
import { sendToWindow } from './window-send';

type RetryPhase =
  | 'scheduled'
  | 'dispatching'
  | 'awaiting_outcome'
  | 'exhausted';

interface RetryEntry {
  target: UsageLimitedChatTarget;
  provider: AgentProviderType;
  phase: RetryPhase;
  attempt: number;
  nextRetryAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  pinnedPrompt: UsageLimitResumePrompt | null;
  pendingRetryUserMessageId: string | null;
  recentFailureEvents: unknown[];
  sawAgentActivity: boolean;
}

interface RecentAttemptEvents {
  events: unknown[];
  sawAgentActivity: boolean;
}

interface PendingRetryStart {
  target: UsageLimitedChatTarget;
  provider: AgentProviderType;
  generation: number;
}

export interface NonRetryableChatFailure {
  kind: 'non_retryable_failure';
  detail?: string;
}

interface TransientErrorRetryPreferences {
  autoRetryTransientErrorsChats: boolean;
}

export interface TransientErrorRetryServiceDependencies {
  readPreferences: () => Promise<TransientErrorRetryPreferences>;
  readChatTab: (
    target: UsageLimitedChatTarget,
  ) => Promise<PersistedChatTab | undefined>;
  getActiveSessions: () => readonly ChatActiveSessionInfo[];
  dispatchRetry: (
    target: UsageLimitedChatTarget,
    prompt: UsageLimitResumePrompt,
    userMessageId: string,
    getWindow: () => BrowserWindow | null,
    shouldContinue: () => boolean,
  ) => Promise<void>;
  emitState: (
    target: UsageLimitedChatTarget,
    data: TransientRetryStateEventData,
  ) => void;
}

interface InitializedRetryService {
  getWindow: () => BrowserWindow | null;
  dependencies: TransientErrorRetryServiceDependencies;
}

const MAX_RECENT_FAILURE_EVENTS = 30;
const retryEntries = new Map<string, RetryEntry>();
const pendingRetryStarts = new Map<string, PendingRetryStart>();
const recentEventsByKey = new Map<string, RecentAttemptEvents>();
const generationByKey = new Map<string, number>();
const ignoredRetryUserMessageIds = new Set<string>();
let initializedService: InitializedRetryService | null = null;

type RetryActivityListener = (
  target: UsageLimitedChatTarget,
  active: boolean,
  retryUserMessageId?: string,
) => void;
const retryActivityListeners = new Set<RetryActivityListener>();

/** Observe main-owned retry work independently of renderer-only banner events. */
export function subscribeTransientRetryActivity(
  listener: RetryActivityListener,
): () => void {
  retryActivityListeners.add(listener);
  for (const entry of Array.from(retryEntries.values())) {
    listener(
      entry.target,
      entry.phase !== 'exhausted',
      entry.pendingRetryUserMessageId ?? undefined,
    );
  }
  for (const pending of Array.from(pendingRetryStarts.values()))
    listener(pending.target, true);
  return (): void => {
    retryActivityListeners.delete(listener);
  };
}

function notifyRetryActivity(
  target: UsageLimitedChatTarget,
  active: boolean,
  retryUserMessageId?: string,
): void {
  for (const listener of Array.from(retryActivityListeners))
    listener(target, active, retryUserMessageId);
}

function chatKey(target: UsageLimitedChatTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

function bumpGeneration(key: string): number {
  const generation = (generationByKey.get(key) ?? 0) + 1;
  generationByKey.set(key, generation);
  return generation;
}

function appendRecentEvent(events: unknown[], eventData: unknown): void {
  events.push(eventData);
  if (events.length > MAX_RECENT_FAILURE_EVENTS) {
    events.splice(0, events.length - MAX_RECENT_FAILURE_EVENTS);
  }
}

function ignoreRetryUserMessageId(userMessageId: string): void {
  ignoredRetryUserMessageIds.add(userMessageId);
}

function retryAuditStatus(
  eventData: Record<string, unknown>,
): 'success' | 'failure' | 'cancelled' | 'interrupted' {
  if (eventData.type === 'codex' && isRecord(eventData.event)) {
    if (eventData.event.type === 'turn.failed') return 'failure';
    if (eventData.event.type === 'turn.completed') return 'success';
  }
  return getChatTurnAuditStatus(eventData);
}

function isRetryAgentActivityEvent(eventData: unknown): boolean {
  if (!isRecord(eventData)) return false;
  if (eventData.type === 'assistant') {
    if (typeof eventData.message === 'string') {
      return eventData.message.trim().length > 0;
    }
    if (!isRecord(eventData.message)) return false;
    if (typeof eventData.message.content === 'string') {
      return eventData.message.content.trim().length > 0;
    }
    if (!Array.isArray(eventData.message.content)) return false;
    return eventData.message.content.some((block) => {
      if (!isRecord(block)) return false;
      if (block.type === 'tool_use') return true;
      return typeof block.text === 'string' && block.text.trim().length > 0;
    });
  }
  if (eventData.type !== 'codex' || !isRecord(eventData.event)) {
    return false;
  }
  if (
    eventData.event.type !== 'item.started' &&
    eventData.event.type !== 'item.updated' &&
    eventData.event.type !== 'item.completed'
  ) {
    return false;
  }
  if (!isRecord(eventData.event.item)) return false;
  return [
    'agent_message',
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'dynamic_tool_call',
    'collab_agent_tool_call',
    'web_search',
    'image_view',
  ].includes(String(eventData.event.item.type));
}

/**
 * Codex can intermittently reject its automatic cyber access-program selection
 * during ordinary work. A same-thread continuation has recovered this exact
 * failure. Keep the exception local to bounded chat recovery: classifying it
 * globally would also retry pipeline steps and background helper operations.
 */
function isCodexCyberAccessProgramFailure(eventData: unknown): boolean {
  if (
    !isRecord(eventData) ||
    eventData.type !== 'codex' ||
    !isRecord(eventData.event) ||
    eventData.event.type !== 'turn.failed'
  ) {
    return false;
  }
  const error = eventData.event.error;
  if (
    !isRecord(error) ||
    typeof error.message !== 'string' ||
    error.message.length > 4_096 ||
    (error.codexErrorInfo !== undefined && error.codexErrorInfo !== 'other')
  ) {
    return false;
  }
  // Parse the provider's complete JSON error, not a substring in tool output,
  // diagnostic prose, or an earlier nonterminal event.
  try {
    const body: unknown = JSON.parse(error.message);
    return (
      isRecord(body) &&
      body.type === 'error' &&
      body.status === 400 &&
      isRecord(body.error) &&
      body.error.type === 'invalid_request_error' &&
      body.error.code === 'unsupported_parameter' &&
      body.error.param === 'access_programs.cyber' &&
      body.error.message ===
        'The access_programs parameter is not enabled for this organization.'
    );
  } catch {
    return false;
  }
}

/**
 * The Codex app-server transport failed this chat before or around its turn:
 * an unanswered thread start or resume, a resume refused while the thread was
 * still closing, or a shared restart on behalf of another chat. The session
 * marks these on the terminal event. Like the cyber exception above, this is
 * chat-only policy: pipelines and background helpers resume differently.
 */
function isCodexTransportFailure(
  provider: AgentProviderType,
  events: readonly unknown[],
): boolean {
  return (
    provider === 'codex' &&
    isRetryableCodexTransportFailureEvent(events[events.length - 1])
  );
}

function isTransientFailure(
  target: UsageLimitedChatTarget,
  provider: AgentProviderType,
  events: readonly unknown[],
): boolean {
  const classification = classifyAgentFailure({
    provider,
    accountScope: isSessionAiCreditsRouted(
      target.projectId,
      target.worktreeId,
      target.chatId,
    )
      ? 'ai_credits'
      : 'native',
    events,
    error: events[events.length - 1],
  });
  if (classification) {
    return classification.kind === 'provider_temporarily_unavailable';
  }
  if (isCodexTransportFailure(provider, events)) return true;
  return (
    provider === 'codex' &&
    isCodexCyberAccessProgramFailure(events[events.length - 1]) &&
    // Unknown routing is not evidence of a native session.
    getSessionAiCreditsRoutedState(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ) === false
  );
}

function terminalFailureDetail(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event)) continue;
    if (typeof event.error === 'string' && event.error.trim().length > 0) {
      return event.error;
    }
    if (
      event.type === 'result' &&
      event.is_error === true &&
      typeof event.result === 'string' &&
      event.result.trim().length > 0
    ) {
      return event.result;
    }
    if (Array.isArray(event.errors)) {
      const message = event.errors.find(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.trim().length > 0,
      );
      if (message) return message;
    }
    if (event.type === 'codex' && isRecord(event.event)) {
      if (
        typeof event.event.message === 'string' &&
        event.event.message.trim().length > 0
      ) {
        return event.event.message;
      }
      if (
        typeof event.event.error === 'string' &&
        event.event.error.trim().length > 0
      ) {
        return event.event.error;
      }
    }
  }
  return undefined;
}

function nonRetryableFailureAttention(
  target: UsageLimitedChatTarget,
  provider: AgentProviderType,
  events: readonly unknown[],
): NonRetryableChatFailure | null {
  const classification = classifyAgentFailure({
    provider,
    accountScope: isSessionAiCreditsRouted(
      target.projectId,
      target.worktreeId,
      target.chatId,
    )
      ? 'ai_credits'
      : 'native',
    events,
    error: events[events.length - 1],
  });
  // Authentication and usage limits have their own richer attention sources;
  // retryable provider outages remain automation concerns. Only an otherwise
  // unclassified terminal failure asks the human to inspect the run.
  if (classification !== null) return null;
  // A Codex transport failure is retried like a provider outage.
  if (isCodexTransportFailure(provider, events)) return null;
  const detail = terminalFailureDetail(events);
  return {
    kind: 'non_retryable_failure',
    ...(detail ? { detail } : {}),
  };
}

async function readPersistedChatTab(
  target: UsageLimitedChatTarget,
): Promise<PersistedChatTab | undefined> {
  const tabsFile = await readChatTabsFile(target.projectId, target.worktreeId, {
    chatIds: [target.chatId],
  });
  return tabsFile.tabs.find((tab) => tab.id === target.chatId);
}

async function dispatchPersistedRetry(
  target: UsageLimitedChatTarget,
  prompt: UsageLimitResumePrompt,
  userMessageId: string,
  getWindow: () => BrowserWindow | null,
  shouldContinue: () => boolean,
): Promise<void> {
  // Lazy loading breaks the retry-service -> chat-service -> session ->
  // retry-service import cycle while preserving the canonical chat dispatch.
  const { buildExistingTabDispatchOptions, sendWorktreeChatMessage } =
    await import('../services/chat-service');
  if (!shouldContinue()) return;
  const tabOptions = await buildExistingTabDispatchOptions(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  if (!shouldContinue()) return;
  const request: ChatSendMessageRequest = {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    text: prompt.text,
    ...(prompt.fileReferences?.length
      ? { fileReferences: prompt.fileReferences }
      : {}),
    ...(prompt.attachmentPaths?.length
      ? { attachmentPaths: prompt.attachmentPaths }
      : {}),
    ...(prompt.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: prompt.attachmentPromptContexts }
      : {}),
    userMessageId,
    initiationSource: 'automation',
    inputMode: prompt.inputMode ?? 'typed',
    ...tabOptions,
  };
  if (
    target.projectId === PIPELINE_EDITOR_PROJECT_ID &&
    target.worktreeId === PIPELINE_EDITOR_WORKTREE_ID
  ) {
    // Keep the specialized runtime out of the retry service's eager import
    // graph while routing Pipeline Assistant retries through its canonical
    // system prompt, tools, model selection, and working directory.
    const { dispatchPipelineEditorChatMessage } =
      await import('../pipeline-editor/chat-service');
    if (!shouldContinue()) return;
    await dispatchPipelineEditorChatMessage(request, {
      getMainWindow: getWindow,
      toolSurfaces: { getMainWindow: getWindow },
    });
    return;
  }
  if (!shouldContinue()) return;
  await sendWorktreeChatMessage(request, {
    getWindow,
    preserveTransientRetry: true,
  });
}

function emitRetryState(
  getWindow: () => BrowserWindow | null,
  target: UsageLimitedChatTarget,
  data: TransientRetryStateEventData,
): void {
  sendToWindow(getWindow(), IPC_CHANNELS.chatEvent, {
    ...target,
    data,
  });
}

function retryStateData(
  entry: RetryEntry,
  active: boolean,
): TransientRetryStateEventData {
  return {
    type: TRANSIENT_RETRY_STATE_EVENT_TYPE,
    provider: entry.provider,
    active,
    attempt: entry.attempt,
    maxAttempts: CHAT_TRANSIENT_RETRY_MAX_ATTEMPTS,
    nextRetryAt: active ? entry.nextRetryAt : null,
    exhausted: active && entry.phase === 'exhausted',
  };
}

function persistedTabProvider(
  tab: PersistedChatTab,
  fallback: AgentProviderType,
): AgentProviderType {
  return (
    tab.providerType ??
    (tab.model ? (getProviderForModel(tab.model) ?? fallback) : fallback)
  );
}

function emitEntryState(entry: RetryEntry, active: boolean): void {
  notifyRetryActivity(
    entry.target,
    active && entry.phase !== 'exhausted',
    entry.pendingRetryUserMessageId ?? undefined,
  );
  initializedService?.dependencies.emitState(
    entry.target,
    retryStateData(entry, active),
  );
}

function deleteEntryWithoutGenerationBump(
  key: string,
  entry: RetryEntry,
  emitInactive: boolean,
): void {
  if (entry.timer) clearTimeout(entry.timer);
  retryEntries.delete(key);
  pendingRetryStarts.delete(key);
  recentEventsByKey.delete(key);
  if (emitInactive) emitEntryState(entry, false);
}

function clearLiveEntry(key: string, entry: RetryEntry): void {
  bumpGeneration(key);
  if (entry.pendingRetryUserMessageId) {
    ignoreRetryUserMessageId(entry.pendingRetryUserMessageId);
  }
  deleteEntryWithoutGenerationBump(key, entry, true);
}

function isLiveEntry(
  key: string,
  generation: number,
  entry: RetryEntry,
): boolean {
  return (
    generationByKey.get(key) === generation && retryEntries.get(key) === entry
  );
}

function armRetryTimer(
  key: string,
  entry: RetryEntry,
  generation: number,
): void {
  const delay = CHAT_TRANSIENT_RETRY_DELAYS_MS[entry.attempt - 1];
  if (delay === undefined) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.phase = 'scheduled';
  entry.nextRetryAt = Date.now() + delay;
  entry.timer = setTimeout(() => {
    void dispatchScheduledRetry(key, generation);
  }, delay);
  emitEntryState(entry, true);
}

async function dispatchScheduledRetry(
  key: string,
  generation: number,
): Promise<void> {
  const service = initializedService;
  const entry = retryEntries.get(key);
  if (
    !service ||
    !entry ||
    entry.phase !== 'scheduled' ||
    !isLiveEntry(key, generation, entry)
  ) {
    return;
  }

  entry.timer = null;
  entry.phase = 'dispatching';
  try {
    const preferences = await service.dependencies.readPreferences();
    if (!isLiveEntry(key, generation, entry)) return;
    if (!preferences.autoRetryTransientErrorsChats) {
      clearLiveEntry(key, entry);
      return;
    }

    const activeSession = service.dependencies
      .getActiveSessions()
      .find(
        (session) =>
          session.projectId === entry.target.projectId &&
          session.worktreeId === entry.target.worktreeId &&
          session.chatId === entry.target.chatId,
      );
    if (
      activeSession &&
      (activeSession.turnActive || activeSession.pendingMessageCount > 0)
    ) {
      clearLiveEntry(key, entry);
      return;
    }

    const tab = await service.dependencies.readChatTab(entry.target);
    if (!isLiveEntry(key, generation, entry)) return;
    if (!tab) {
      clearLiveEntry(key, entry);
      return;
    }
    // Dispatch options are rebuilt from the persisted tab immediately before
    // every retry. Keep terminal guards, banner state, and outcome
    // classification aligned with the provider that request will dispatch.
    entry.provider = persistedTabProvider(tab, entry.provider);
    if (
      entry.provider === 'claude' &&
      isTerminalBackedInterfaceMode(
        getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
      )
    ) {
      clearLiveEntry(key, entry);
      return;
    }

    entry.pinnedPrompt ??= computeUsageLimitResumePrompt(tab.messages);
    if (!isLiveEntry(key, generation, entry)) return;

    const userMessageId = randomUUID();
    entry.pendingRetryUserMessageId = userMessageId;
    entry.recentFailureEvents = [];
    entry.sawAgentActivity = false;
    entry.nextRetryAt = null;
    entry.phase = 'awaiting_outcome';
    notifyRetryActivity(entry.target, true, userMessageId);

    try {
      await service.dependencies.dispatchRetry(
        entry.target,
        entry.pinnedPrompt,
        userMessageId,
        service.getWindow,
        () => isLiveEntry(key, generation, entry),
      );
    } catch {
      const liveEntry = retryEntries.get(key);
      if (
        liveEntry &&
        generationByKey.get(key) === generation &&
        liveEntry.phase === 'awaiting_outcome' &&
        liveEntry.pendingRetryUserMessageId === userMessageId
      ) {
        clearLiveEntry(key, liveEntry);
      }
    }
  } catch {
    const liveEntry = retryEntries.get(key);
    if (liveEntry && isLiveEntry(key, generation, liveEntry)) {
      clearLiveEntry(key, liveEntry);
    }
  }
}

function beginRetryCycle(
  target: UsageLimitedChatTarget,
  provider: AgentProviderType,
  events: readonly unknown[],
  sawAgentActivity: boolean,
): void {
  const service = initializedService;
  if (!service || !isTransientFailure(target, provider, events)) return;

  const key = chatKey(target);
  const generation = bumpGeneration(key);
  pendingRetryStarts.set(key, { target, provider, generation });
  notifyRetryActivity(target, true);
  void (async (): Promise<void> => {
    try {
      const preferences = await service.dependencies.readPreferences();
      const pending = pendingRetryStarts.get(key);
      if (
        generationByKey.get(key) !== generation ||
        pending?.generation !== generation
      ) {
        return;
      }
      pendingRetryStarts.delete(key);
      if (!preferences.autoRetryTransientErrorsChats) {
        notifyRetryActivity(target, false);
        return;
      }

      const entry: RetryEntry = {
        target,
        provider,
        phase: 'scheduled',
        attempt: 1,
        nextRetryAt: null,
        timer: null,
        pinnedPrompt: sawAgentActivity
          ? {
              text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
              resendsUserMessage: false,
            }
          : null,
        pendingRetryUserMessageId: null,
        recentFailureEvents: [],
        sawAgentActivity: false,
      };
      retryEntries.set(key, entry);
      armRetryTimer(key, entry, generation);
    } catch {
      if (generationByKey.get(key) === generation) {
        pendingRetryStarts.delete(key);
        notifyRetryActivity(target, false);
      }
    }
  })();
}

function handleAwaitingOutcome(
  key: string,
  entry: RetryEntry,
  eventData: unknown,
): NonRetryableChatFailure | null {
  if (!isRecord(eventData)) return null;
  const eventUserMessageId =
    typeof eventData.canopy_turn_user_message_id === 'string'
      ? eventData.canopy_turn_user_message_id
      : null;
  if (
    eventUserMessageId &&
    eventUserMessageId !== entry.pendingRetryUserMessageId
  ) {
    return null;
  }

  if (!isTerminalChatEventData(eventData)) {
    appendRecentEvent(entry.recentFailureEvents, eventData);
    entry.sawAgentActivity ||= isRetryAgentActivityEvent(eventData);
    return null;
  }

  appendRecentEvent(entry.recentFailureEvents, eventData);
  const outcomeEvents = entry.recentFailureEvents;
  const sawAgentActivity =
    entry.sawAgentActivity || isRetryAgentActivityEvent(eventData);
  entry.recentFailureEvents = [];
  entry.sawAgentActivity = false;
  const status = retryAuditStatus(eventData);
  if (status === 'cancelled' || status === 'interrupted') return null;

  const generation = bumpGeneration(key);
  entry.pendingRetryUserMessageId = null;
  if (status === 'success') {
    deleteEntryWithoutGenerationBump(key, entry, true);
    return null;
  }

  if (!isTransientFailure(entry.target, entry.provider, outcomeEvents)) {
    const attention = nonRetryableFailureAttention(
      entry.target,
      entry.provider,
      outcomeEvents,
    );
    deleteEntryWithoutGenerationBump(key, entry, true);
    return attention;
  }
  if (sawAgentActivity) {
    // Progress changes what to send, never the bounded retry budget. Replaying
    // the pinned original prompt after work could repeat completed actions.
    entry.pinnedPrompt = {
      text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
      resendsUserMessage: false,
    };
  }
  if (entry.attempt >= CHAT_TRANSIENT_RETRY_MAX_ATTEMPTS) {
    entry.phase = 'exhausted';
    entry.nextRetryAt = null;
    emitEntryState(entry, true);
    return null;
  }

  entry.attempt += 1;
  armRetryTimer(key, entry, generation);
  return null;
}

export function initTransientErrorRetryService(
  getWindow: () => BrowserWindow | null,
  overrides: Partial<TransientErrorRetryServiceDependencies> = {},
): void {
  initializedService = {
    getWindow,
    dependencies: {
      readPreferences: overrides.readPreferences ?? readPreferencesFile,
      readChatTab: overrides.readChatTab ?? readPersistedChatTab,
      getActiveSessions:
        overrides.getActiveSessions ?? getAllActiveSessionInfos,
      dispatchRetry: overrides.dispatchRetry ?? dispatchPersistedRetry,
      emitState:
        overrides.emitState ??
        ((target, data): void => emitRetryState(getWindow, target, data)),
    },
  };
}

export function noteChatSessionEvent(
  target: UsageLimitedChatTarget,
  provider: AgentProviderType,
  eventData: unknown,
): NonRetryableChatFailure | null {
  if (!initializedService || !isTransientRetryEligibleTarget(target)) {
    return null;
  }
  const key = chatKey(target);
  const entry = retryEntries.get(key);
  if (entry) {
    if (entry.phase === 'awaiting_outcome') {
      return handleAwaitingOutcome(key, entry, eventData);
    }
    return null;
  }

  // A transient terminal event starts an async preference read. Ignore the
  // provider's immediate synthetic follow-up terminal while that read is in
  // flight so it cannot invalidate the reserved generation.
  if (pendingRetryStarts.has(key)) return null;

  if (
    isRecord(eventData) &&
    typeof eventData.canopy_turn_user_message_id === 'string' &&
    ignoredRetryUserMessageIds.has(eventData.canopy_turn_user_message_id)
  ) {
    return null;
  }

  const recentAttempt = recentEventsByKey.get(key) ?? {
    events: [],
    sawAgentActivity: false,
  };
  appendRecentEvent(recentAttempt.events, eventData);
  recentAttempt.sawAgentActivity ||= isRetryAgentActivityEvent(eventData);
  recentEventsByKey.set(key, recentAttempt);
  if (!isRecord(eventData) || !isTerminalChatEventData(eventData)) return null;

  recentEventsByKey.delete(key);
  if (retryAuditStatus(eventData) !== 'failure') return null;
  const attention = nonRetryableFailureAttention(
    target,
    provider,
    recentAttempt.events,
  );
  beginRetryCycle(
    target,
    provider,
    recentAttempt.events,
    recentAttempt.sawAgentActivity,
  );
  return attention;
}

/** Return the live retry state needed to hydrate a newly loaded renderer. */
export function getTransientRetryStateSnapshot(): TransientRetryStateSnapshotEntry[] {
  return Array.from(retryEntries.values(), (entry) => ({
    ...entry.target,
    data: retryStateData(entry, true),
  }));
}

export function cancelTransientRetryForChat(
  target: UsageLimitedChatTarget & { userMessageId?: string },
  _reason: string,
): boolean {
  void _reason;
  const key = chatKey(target);
  const entry = retryEntries.get(key);
  const pending = pendingRetryStarts.get(key);
  const userMessageId = target.userMessageId;
  const cancelledRetryDispatch =
    typeof userMessageId === 'string' &&
    (entry?.pendingRetryUserMessageId === userMessageId ||
      ignoredRetryUserMessageIds.has(userMessageId));
  if (cancelledRetryDispatch && userMessageId) {
    ignoredRetryUserMessageIds.delete(userMessageId);
  }
  bumpGeneration(key);
  recentEventsByKey.delete(key);
  pendingRetryStarts.delete(key);
  if (entry) {
    if (entry.pendingRetryUserMessageId) {
      ignoreRetryUserMessageId(entry.pendingRetryUserMessageId);
    }
    deleteEntryWithoutGenerationBump(key, entry, true);
    return cancelledRetryDispatch;
  }
  if (pending && initializedService) {
    const pendingEntry: RetryEntry = {
      target: pending.target,
      provider: pending.provider,
      phase: 'scheduled',
      attempt: 1,
      nextRetryAt: null,
      timer: null,
      pinnedPrompt: null,
      pendingRetryUserMessageId: null,
      recentFailureEvents: [],
      sawAgentActivity: false,
    };
    emitEntryState(pendingEntry, false);
  }
  return cancelledRetryDispatch;
}

/** Collect matching live and pending entries before cancellation mutates maps. */
function cancelTransientRetriesMatching(
  matches: (target: UsageLimitedChatTarget) => boolean,
  reason: string,
): void {
  const targets = new Map<string, UsageLimitedChatTarget>();
  for (const entry of Array.from(retryEntries.values())) {
    if (matches(entry.target)) {
      targets.set(chatKey(entry.target), entry.target);
    }
  }
  for (const pending of Array.from(pendingRetryStarts.values())) {
    if (matches(pending.target)) {
      targets.set(chatKey(pending.target), pending.target);
    }
  }
  for (const target of Array.from(targets.values())) {
    cancelTransientRetryForChat(target, reason);
  }
}

export function cancelTransientRetriesForWorkspaceChat(
  workspaceId: string,
  chatId: string,
  reason: string,
): void {
  cancelTransientRetriesMatching(
    (target): boolean =>
      target.projectId === workspaceId && target.chatId === chatId,
    reason,
  );
}

/**
 * Unscoped standalone commands resolve their workspace asynchronously. Stop
 * every same-ID candidate before that scan so none can dispatch while target
 * resolution is pending.
 */
export function cancelTransientRetriesForChatId(
  chatId: string,
  reason: string,
): void {
  cancelTransientRetriesMatching(
    (target): boolean => target.chatId === chatId,
    reason,
  );
}

export function resetTransientRetryServiceForTests(): void {
  for (const entry of Array.from(retryEntries.values())) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  retryEntries.clear();
  pendingRetryStarts.clear();
  recentEventsByKey.clear();
  generationByKey.clear();
  ignoredRetryUserMessageIds.clear();
  initializedService = null;
}
