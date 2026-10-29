// Revisioned chat-state slice (frontend plan).
//
// Binds the pure sync engine (`revisioned-sync.ts`), canonical delta
// application (`canonical-changes.ts`), and the typed command dispatch layer
// (`revisioned-commands.ts`) to the chat store. When the main process
// exposes the revisioned chat service (`chat:get-state` / `chat:command` /
// `chat:state-changed`), scopes hydrated here become read-only projections of
// main-owned canonical state: committed deltas apply in revision order, gaps
// trigger a single snapshot refresh with the approved recovery UX, and
// mutations flow through typed command envelopes with per-command optimistic
// overlays. When the service is unavailable (older main process), callers
// fall back to the legacy hydration path.
import type { StateCreator } from 'zustand';
import type {
  ChatCommand,
  ChatGetStateRequest,
  ChatStateChangedEvent,
  ChatStateScopesDeclaration,
  ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import { getProviderForModel } from '@canopy/desktop-shared/types';
import { isPlanProposal } from '@canopy/desktop-shared/plan-review';
import { MAX_DECLARED_CHAT_STATE_SCOPES } from '@canopy/desktop-shared/lib/chat-state-cadence';
import { chatStoreApi } from '../store-ref';
import {
  recordStaleChatCatchUpChanges,
  invalidateStaleChatCatchUpScope,
} from '../stale-catch-up';
import {
  RevisionedChatSync,
  chatScopeKey,
  type ChatScopeSyncStatus,
} from '../revisioned-sync';
import {
  OptimisticCommandTracker,
  classifyChatCommandResult,
  createChatCommandEnvelope,
  type ChatCommandDisposition,
} from '../revisioned-commands';
import {
  CHAT_STATE_COMMAND_FAILED_NOTICE,
  CHAT_STATE_CONFLICT_NOTICE,
} from '../revisioned-copy';
import {
  applyCanonicalChanges,
  applyRuntimeStatusesToTabs,
  preserveRendererOnlyTabFields,
  type CanonicalScopeProjection,
} from '../canonical-changes';
import { fromPersistedTabs } from '../persisted-tabs';
import {
  attachHostQueueMirror,
  hostQueueViewsToQueuedMessages,
} from '../queue-mirror';
import { hydratePendingQuestionsFromFile } from '../pending-questions';
import {
  hydratedKeys,
  pendingEagerChatCreation,
  revisionedSetupPendingKeys,
  speculativeHydrationKeys,
  pruneUnreadWorktreeKey,
  recordWorktreeChatTouch,
  scheduleIdleChatUnload,
} from '../hydration';
import {
  resolveBillingSeed,
  resolveDefaultChatInterfaceMode,
  resolveDeferredToolsAllowedDefault,
  resolveTabDefaults,
} from '../defaults';
import { getDefaultPlugins } from '../tab-utils';
import {
  beginTranscriptPerformanceStage,
  markTranscriptPerformanceCommitStart,
  recordTranscriptPerformanceCorrelation,
  recordTranscriptPerformanceCounter,
} from '@/lib/transcript-performance';
import { requestChatInterestRedeclare } from '@/lib/chat-interest/redeclare';
import { sanitizePluginSelectionsWithCachedSupport } from '../plugin-provider-support';
import type { PendingQuestion } from '../types';
import type { ChatRevisionedSlice, ChatState } from '../state';
import { pendingTabCreation } from '../pending-tab-creation';
import { pendingApprovalModeTransitions } from './approvals';
import {
  chatHasLiveDelegates,
  subscribeChatDelegatesSettled,
  useDelegationActivityStore,
  type ChatDelegationTarget,
} from '../../delegationActivityStore';

// ---------------------------------------------------------------------------
// Module state (engine + tracker singletons, availability detection)
// ---------------------------------------------------------------------------

type RevisionedAvailability = 'unknown' | 'available' | 'unavailable';

let availability: RevisionedAvailability = 'unknown';
let controller: RevisionedChatSync | null = null;
const commandTracker = new OptimisticCommandTracker();
const pendingUnreadByScope = new Map<string, Set<string>>();
interface OptimisticActiveTabSelection {
  token: number;
  tabId: string;
  rollbackTabId: string;
  confirmedRevision?: number;
}
const optimisticActiveTabByScope = new Map<
  string,
  OptimisticActiveTabSelection
>();
const canonicalActiveTabByScope = new Map<string, string>();
let optimisticActiveTabToken = 0;
interface OptimisticClosedTab {
  token: number;
  confirmedRevision?: number;
}
const optimisticClosedTabsByScope = new Map<
  string,
  Map<string, OptimisticClosedTab>
>();
let optimisticTabCloseToken = 0;
const initialHydrations = new Map<
  string,
  Promise<'installed' | 'unavailable' | 'failed'>
>();
const canonicalAutoArchivesInFlight = new Map<string, symbol>();
const canonicalAutoArchivesRetryPending = new Set<string>();
const canonicalTerminalUnread = new Map<string, boolean>();
/**
 * Legacy (non-revisioned) scopes decide auto-archive once, on the completed
 * turn's terminal event. A chat whose delegates were still live then is
 * remembered here and archived when its delegates finish.
 */
const legacyAutoArchivesAwaitingDelegates = new Set<string>();
let disposeAutoArchiveAfterDelegates: (() => void) | null = null;

function clearCanonicalAutoArchiveRetryState(targetKey: string): void {
  canonicalTerminalUnread.delete(targetKey);
  canonicalAutoArchivesRetryPending.delete(targetKey);
}

function clearCanonicalTerminalUnreadForScope(scopeKey: string): void {
  const prefix = `${scopeKey}/`;
  canonicalAutoArchivesInFlight.forEach((_attempt, targetKey) => {
    if (targetKey.startsWith(prefix)) {
      canonicalAutoArchivesInFlight.delete(targetKey);
    }
  });
  canonicalTerminalUnread.forEach((_unread: boolean, targetKey: string) => {
    if (targetKey.startsWith(prefix)) canonicalTerminalUnread.delete(targetKey);
  });
  canonicalAutoArchivesRetryPending.forEach((targetKey) => {
    if (targetKey.startsWith(prefix))
      canonicalAutoArchivesRetryPending.delete(targetKey);
  });
}

function pruneCanonicalTerminalUnreadForSnapshot(
  scopeKey: string,
  autoArchiveCompletedChatIds: ReadonlySet<string>,
): void {
  const prefix = `${scopeKey}/`;
  canonicalTerminalUnread.forEach((_unread: boolean, targetKey: string) => {
    if (
      targetKey.startsWith(prefix) &&
      !autoArchiveCompletedChatIds.has(targetKey.slice(prefix.length))
    ) {
      clearCanonicalAutoArchiveRetryState(targetKey);
    }
  });
}

export function scheduleCanonicalAutoArchives(
  projectId: string,
  worktreeId: string,
  candidateChatIds?: ReadonlySet<string>,
): void {
  const api = chatStoreApi();
  const state = api.getState();
  const key = chatScopeKey(projectId, worktreeId);
  const chatState = state.worktreeChats[key];
  if (!chatState) return;

  for (const tab of chatState.tabs) {
    const hasUnansweredAsyncQuestion = Object.values(
      state.pendingQuestions,
    ).some(
      (question) =>
        question.chatId === tab.id &&
        question.projectId === projectId &&
        question.worktreeId === worktreeId &&
        question.delivery === 'async' &&
        question.answeredAt === undefined,
    );
    if (
      (candidateChatIds && !candidateChatIds.has(tab.id)) ||
      tab.autoArchive !== true ||
      state.runtimeByChatId[tab.id]?.status !== 'completed' ||
      tab.queuedMessages.length > 0 ||
      tab.pendingPlanExit ||
      hasUnansweredAsyncQuestion
    ) {
      continue;
    }
    const targetKey = `${key}/${tab.id}`;
    // A completed snapshot can initiate auto-archive without a terminal
    // presentation event. Retain its eligibility if main refuses the first
    // attempt, so a later completed runtime delta can request a retry.
    if (!canonicalTerminalUnread.has(targetKey)) {
      canonicalTerminalUnread.set(targetKey, tab.unread === true);
    }
    // Live delegates keep the chat open. Keep the flag and its eligibility;
    // the chat is re-evaluated when its delegates finish
    // (`installAutoArchiveAfterDelegates`).
    if (chatHasLiveDelegates(projectId, worktreeId, tab.id)) {
      continue;
    }
    if (canonicalAutoArchivesInFlight.has(targetKey)) {
      // A later canonical completion arrived while main was still deciding
      // whether the first archive can proceed. Replay it once if refused.
      canonicalAutoArchivesRetryPending.add(targetKey);
      continue;
    }
    const attempt = Symbol(targetKey);
    canonicalAutoArchivesInFlight.set(targetKey, attempt);
    void api
      .getState()
      .autoArchiveChatTab(
        projectId,
        worktreeId,
        tab.id,
        canonicalTerminalUnread.get(targetKey) ?? tab.unread === true,
      )
      .catch((error: unknown) => {
        // The archive action handles IPC refusals itself. Keep the retry
        // signal if an unexpected error escapes that boundary as well.
        // eslint-disable-next-line no-console
        console.error('Failed to auto-archive chat', error);
        return false;
      })
      .then((archived) => {
        // The scope may have been released and rehydrated while the IPC was
        // pending. Only this attempt may settle its own retry state.
        if (canonicalAutoArchivesInFlight.get(targetKey) !== attempt) return;
        if (archived) canonicalTerminalUnread.delete(targetKey);
        canonicalAutoArchivesInFlight.delete(targetKey);
        const retryPending =
          canonicalAutoArchivesRetryPending.delete(targetKey);
        if (!archived && retryPending) {
          scheduleCanonicalAutoArchives(
            projectId,
            worktreeId,
            new Set([tab.id]),
          );
        }
      });
  }
}

/**
 * Legacy-scope counterpart of the canonical deferral: the completed turn's
 * auto-archive waits for this chat's live delegates to finish.
 */
export function deferLegacyAutoArchiveUntilDelegatesFinish(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  legacyAutoArchivesAwaitingDelegates.add(
    `${chatScopeKey(projectId, worktreeId)}/${chatId}`,
  );
}

/**
 * Re-evaluate a chat's pending auto-archive once its delegates finished.
 * Archives only when the chat is still marked, its parent turn is idle (the
 * same completion checks the turn's own auto-archive applies), and no
 * delegate restarted in the meantime.
 */
export function reevaluateAutoArchiveAfterDelegates(
  target: ChatDelegationTarget,
): void {
  const { projectId, worktreeId, chatId } = target;
  if (chatHasLiveDelegates(projectId, worktreeId, chatId)) return;
  const api = chatStoreApi();
  const state = api.getState();
  const key = chatScopeKey(projectId, worktreeId);
  const targetKey = `${key}/${chatId}`;
  if (state.chatStateSync[key] !== undefined) {
    legacyAutoArchivesAwaitingDelegates.delete(targetKey);
    scheduleCanonicalAutoArchives(projectId, worktreeId, new Set([chatId]));
    return;
  }
  // Before the activity snapshot, only this renderer's explicit deferral is
  // evidence that the turn finished with delegates. After hydration, the
  // persisted marker can recover a deferral lost across a renderer reload.
  if (
    !legacyAutoArchivesAwaitingDelegates.has(targetKey) &&
    !useDelegationActivityStore.getState().hydrated
  ) {
    return;
  }
  // The in-memory deferral is lost on renderer reload. The persisted tab's
  // auto-archive marker remains the source of truth once delegates settle.
  legacyAutoArchivesAwaitingDelegates.delete(targetKey);
  const tab = state.worktreeChats[key]?.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  if (
    !tab ||
    tab.kind === 'file' ||
    tab.autoArchive !== true ||
    tab.status === 'streaming' ||
    tab.queuedMessages.length > 0 ||
    tab.pendingPlanExit
  ) {
    return;
  }
  void state.autoArchiveChatTab(
    projectId,
    worktreeId,
    chatId,
    tab.unread === true,
  );
}

/**
 * Re-run auto-archive for chats whose delegates just finished. Idempotent;
 * installed once at app start beside the delegation activity store.
 */
export function installAutoArchiveAfterDelegates(): () => void {
  if (disposeAutoArchiveAfterDelegates !== null) {
    return disposeAutoArchiveAfterDelegates;
  }
  const reconciled = new Set<string>();
  const unsubscribe = subscribeChatDelegatesSettled((target) => {
    reconciled.add(
      `${chatScopeKey(target.projectId, target.worktreeId)}/${target.chatId}`,
    );
    reevaluateAutoArchiveAfterDelegates(target);
  });
  const reconcileHydratedTabs = (): void => {
    if (!useDelegationActivityStore.getState().hydrated) return;
    const state = chatStoreApi().getState();
    reconciled.forEach((targetKey) => {
      const separator = targetKey.lastIndexOf('/');
      const tab = state.worktreeChats[targetKey.slice(0, separator)]?.tabs.find(
        (candidate) => candidate.id === targetKey.slice(separator + 1),
      );
      if (tab?.autoArchive !== true) reconciled.delete(targetKey);
    });
    for (const [scopeKey, scope] of Object.entries(state.worktreeChats)) {
      if (state.chatStateSync[scopeKey] !== undefined) continue;
      const separator = scopeKey.indexOf('/');
      if (separator < 0) continue;
      const projectId = scopeKey.slice(0, separator);
      const worktreeId = scopeKey.slice(separator + 1);
      for (const tab of scope.tabs) {
        const targetKey = `${scopeKey}/${tab.id}`;
        if (
          reconciled.has(targetKey) ||
          tab.autoArchive !== true ||
          tab.status === 'streaming' ||
          chatHasLiveDelegates(projectId, worktreeId, tab.id)
        ) {
          continue;
        }
        reconciled.add(targetKey);
        reevaluateAutoArchiveAfterDelegates({
          projectId,
          worktreeId,
          chatId: tab.id,
        });
      }
    }
  };
  const unsubscribeActivity = useDelegationActivityStore.subscribe(
    (state, previous) => {
      if (!previous.hydrated && state.hydrated) reconcileHydratedTabs();
    },
  );
  const unsubscribeChats = chatStoreApi().subscribe((state, previous) => {
    if (state.worktreeChats !== previous.worktreeChats) reconcileHydratedTabs();
  });
  reconcileHydratedTabs();
  const dispose = (): void => {
    unsubscribe();
    unsubscribeActivity();
    unsubscribeChats();
    if (disposeAutoArchiveAfterDelegates === dispose) {
      disposeAutoArchiveAfterDelegates = null;
    }
  };
  disposeAutoArchiveAfterDelegates = dispose;
  return dispose;
}

/** Remember that compatibility presentation has computed final unread state. */
export function recordCanonicalTerminalPresentation(
  projectId: string,
  worktreeId: string,
  chatId: string,
  unread: boolean,
): void {
  const targetKey = `${chatScopeKey(projectId, worktreeId)}/${chatId}`;
  canonicalTerminalUnread.set(targetKey, unread);
  scheduleCanonicalAutoArchives(projectId, worktreeId, new Set([chatId]));
}

/**
 * Preserve a newer user tab choice while older committed activation events
 * are still crossing the main/renderer boundary. The overlay is scoped and
 * monotonic so rapid B -> C clicks cannot be rolled back by B settling late.
 */
export function beginOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  tabId: string,
): number {
  const token = ++optimisticActiveTabToken;
  const key = chatScopeKey(projectId, worktreeId);
  const chatState = chatStoreApi().getState().worktreeChats[key];
  const canonicalActiveTabId = canonicalActiveTabByScope.get(key);
  optimisticActiveTabByScope.set(key, {
    token,
    tabId,
    rollbackTabId:
      (canonicalActiveTabId &&
      chatState?.tabs.some((tab) => tab.id === canonicalActiveTabId)
        ? canonicalActiveTabId
        : chatState?.activeTabId) ?? '',
  });
  return token;
}

export function confirmOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  token: number,
  revision: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const selection = optimisticActiveTabByScope.get(key);
  if (!selection || selection.token !== token) return;
  selection.confirmedRevision = revision;
  const appliedRevision =
    chatStoreApi().getState().chatStateSync[key]?.revision;
  if (appliedRevision !== null && appliedRevision !== undefined) {
    if (appliedRevision >= revision) optimisticActiveTabByScope.delete(key);
  }
}

export function rollbackOptimisticActiveTabSelection(
  projectId: string,
  worktreeId: string,
  token: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const selection = optimisticActiveTabByScope.get(key);
  if (!selection || selection.token !== token) return;
  optimisticActiveTabByScope.delete(key);
  chatStoreApi().setState((state) => {
    const chatState = state.worktreeChats[key];
    const canonicalActiveTabId = canonicalActiveTabByScope.get(key);
    const rollbackTabId =
      canonicalActiveTabId &&
      chatState?.tabs.some((tab) => tab.id === canonicalActiveTabId)
        ? canonicalActiveTabId
        : selection.rollbackTabId;
    if (
      !chatState ||
      chatState.activeTabId !== selection.tabId ||
      !chatState.tabs.some((tab) => tab.id === rollbackTabId)
    ) {
      return {};
    }
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: { ...chatState, activeTabId: rollbackTabId },
      },
    };
  });
}

/** Keep tabs hidden after an optimistic panel close until its commit arrives. */
export function beginOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  tabIds: readonly string[],
): number {
  const token = ++optimisticTabCloseToken;
  const key = chatScopeKey(projectId, worktreeId);
  const tabs =
    optimisticClosedTabsByScope.get(key) ??
    new Map<string, OptimisticClosedTab>();
  for (const tabId of tabIds) tabs.set(tabId, { token });
  optimisticClosedTabsByScope.set(key, tabs);
  return token;
}

export function confirmOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  token: number,
  revision: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const tabs = optimisticClosedTabsByScope.get(key);
  if (!tabs) return;
  const appliedRevision =
    chatStoreApi().getState().chatStateSync[key]?.revision;
  for (const [tabId, close] of Array.from(tabs.entries())) {
    if (close.token !== token) continue;
    if (
      appliedRevision !== null &&
      appliedRevision !== undefined &&
      appliedRevision >= revision
    ) {
      tabs.delete(tabId);
    } else {
      close.confirmedRevision = revision;
    }
  }
  if (tabs.size === 0) optimisticClosedTabsByScope.delete(key);
}

export function rollbackOptimisticTabClose(
  projectId: string,
  worktreeId: string,
  token: number,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const tabs = optimisticClosedTabsByScope.get(key);
  if (!tabs) return;
  let removed = false;
  for (const [tabId, close] of Array.from(tabs.entries())) {
    if (close.token === token) {
      tabs.delete(tabId);
      removed = true;
    }
  }
  if (tabs.size === 0) optimisticClosedTabsByScope.delete(key);
  if (removed) getController().forceRefresh(projectId, worktreeId);
}

function enqueuePendingUnread(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  const pending = pendingUnreadByScope.get(key) ?? new Set<string>();
  pending.add(chatId);
  pendingUnreadByScope.set(key, pending);
}

function flushPendingUnread(projectId: string, worktreeId: string): void {
  const key = chatScopeKey(projectId, worktreeId);
  const pending = pendingUnreadByScope.get(key);
  if (!pending || pending.size === 0) return;
  pendingUnreadByScope.delete(key);
  pending.forEach((chatId: string) => {
    void persistUnreadWhenScopeLive(projectId, worktreeId, chatId);
  });
}

/** Commit focus-derived unread state once the canonical scope is writable. */
export async function persistUnreadWhenScopeLive(
  projectId: string,
  worktreeId: string,
  chatId: string,
): Promise<void> {
  const key = chatScopeKey(projectId, worktreeId);
  const api = chatStoreApi();
  const phase = api.getState().chatStateSync[key]?.phase;
  if (phase === 'refreshing' || phase === 'refresh_error') {
    enqueuePendingUnread(projectId, worktreeId, chatId);
    return;
  }
  const disposition = await api
    .getState()
    .dispatchChatCommand(
      { projectId, worktreeId },
      { type: 'chat.mark_unread', chatId },
    );
  const latestPhase = api.getState().chatStateSync[key]?.phase;
  if (
    disposition === 'transport_failed' &&
    (latestPhase === 'refreshing' || latestPhase === 'refresh_error')
  ) {
    enqueuePendingUnread(projectId, worktreeId, chatId);
  }
}

/**
 * Synchronous pre-check for hydration call sites: true only when the
 * revisioned chat service might be reachable. Keeps the legacy hydration
 * path free of extra async hops when the preload (or a test double) does not
 * expose `chat.getState` at all.
 */
export function revisionedChatStateSupported(): boolean {
  return (
    availability !== 'unavailable' &&
    typeof window.api.chat.getState === 'function'
  );
}

function isRevisionedUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes('No handler registered')) return true;
  const code: unknown = 'code' in error ? error.code : undefined;
  return code === 'unavailable';
}

function getController(): RevisionedChatSync {
  if (controller) return controller;
  controller = new RevisionedChatSync(
    {
      getState: (request): Promise<ChatStateSnapshot> => {
        if (typeof window.api.chat.getState !== 'function') {
          return Promise.reject(
            Object.assign(new Error('Revisioned chat state is unavailable.'), {
              code: 'unavailable',
            }),
          );
        }
        return window.api.chat.getState(request);
      },
    },
    {
      installSnapshot: (snapshot, context): void => {
        installSnapshotIntoStore(snapshot, context.reason);
      },
      applyCommittedEvent: (event): void => {
        applyCommittedEventToStore(event);
      },
      onStatusChanged: (projectId, worktreeId, status): void => {
        publishScopeStatus(projectId, worktreeId, status);
      },
      onTrackedScopesChanged: (scopes): void => {
        declareChatStateScopes(scopes);
      },
    },
  );
  // Nothing is tracked yet: events for every scope would be ignored.
  declareChatStateScopes([]);
  return controller;
}

/**
 * Tell main which scopes this window applies `chat:state-changed` for, so it
 * sends no others. The controller is this window's only consumer of that
 * channel; it ignores every other scope (revisioned-sync rule 8). Called
 * synchronously before each snapshot query, so main routes the scope to this
 * window before it reads the snapshot. A rejected declaration leaves main
 * sending every scope. The window's chat interest is declared again on the
 * next frame as well.
 */
function declareChatStateScopes(scopes: ChatGetStateRequest[]): void {
  requestChatInterestRedeclare();
  if (typeof window.api.chat.setStateScopes !== 'function') return;
  const declaration: ChatStateScopesDeclaration =
    scopes.length > MAX_DECLARED_CHAT_STATE_SCOPES
      ? { kind: 'all' }
      : { kind: 'scopes', scopes };
  void Promise.resolve(window.api.chat.setStateScopes(declaration)).catch(
    (): void => {
      // Main fails open (every scope) when it rejects a declaration.
    },
  );
}

// ---------------------------------------------------------------------------
// Store mutation helpers (called from engine host callbacks)
// ---------------------------------------------------------------------------

function publishScopeStatus(
  projectId: string,
  worktreeId: string,
  status: ChatScopeSyncStatus | null,
): void {
  const key = chatScopeKey(projectId, worktreeId);
  chatStoreApi().setState((state) => {
    const next = { ...state.chatStateSync };
    if (status === null) delete next[key];
    else next[key] = status;
    return { chatStateSync: next };
  });
  if (status?.phase === 'live') {
    const selection = optimisticActiveTabByScope.get(key);
    if (
      selection?.confirmedRevision !== undefined &&
      status.revision !== null &&
      status.revision >= selection.confirmedRevision
    ) {
      optimisticActiveTabByScope.delete(key);
    }
    const closingTabs = optimisticClosedTabsByScope.get(key);
    if (closingTabs && status.revision !== null) {
      for (const [tabId, close] of Array.from(closingTabs.entries())) {
        if (
          close.confirmedRevision !== undefined &&
          status.revision >= close.confirmedRevision
        ) {
          closingTabs.delete(tabId);
        }
      }
      if (closingTabs.size === 0) optimisticClosedTabsByScope.delete(key);
    }
    flushPendingUnread(projectId, worktreeId);
    const api = chatStoreApi();
    if (
      api.getState().worktreeChats[key]?.tabs.length === 0 &&
      !speculativeHydrationKeys.has(key)
    ) {
      void api.getState().ensureWorktreeHasChatTab({ projectId, worktreeId });
    }
  }
}

function scopePendingQuestions(
  pendingQuestions: Record<string, PendingQuestion>,
  projectId: string,
  worktreeId: string,
): string[] {
  return Object.entries(pendingQuestions)
    .filter(
      ([, pending]) =>
        pending.projectId === projectId && pending.worktreeId === worktreeId,
    )
    .map(([requestId]) => requestId);
}

function commandChatIds(command: ChatCommand): string[] {
  if (command.type === 'chat.create_tab') return [];
  if (command.type === 'chat.close_tabs') {
    return command.targets.map((target) => target.tabId);
  }
  if (command.type === 'chat.reorder_tabs') return command.tabIds;
  if (command.type === 'chat.fork_tab') {
    return [command.sourceTabId, command.targetTabId];
  }
  if (command.type === 'chat.import_session') return [command.targetChatId];
  if (command.type === 'chat.restore_archive') {
    return command.targetTabId ? [command.targetTabId] : [];
  }
  if ('tabId' in command && typeof command.tabId === 'string') {
    return [command.tabId];
  }
  if ('chatId' in command && typeof command.chatId === 'string') {
    return [command.chatId];
  }
  return [];
}

function recoverUntrackedPlanProposals(
  projectId: string,
  worktreeId: string,
): void {
  const state = chatStoreApi().getState();
  for (const tab of state.worktreeChats[chatScopeKey(projectId, worktreeId)]
    ?.tabs ?? []) {
    const input = tab.pendingPlanExit;
    const source = input?.source;
    if (
      tab.pendingPlanExitRequestId &&
      input &&
      (source === 'cursor' || source === 'codex') &&
      isPlanProposal(input)
    ) {
      state.handlePlanExitRequest(
        {
          projectId,
          worktreeId,
          chatId: tab.id,
          requestId: tab.pendingPlanExitRequestId,
          source,
          toolInput: input,
        },
        'recover',
      );
    }
  }
}

/**
 * Install a canonical snapshot as the scope's client projection. On
 * Renderer-only presentation state (composer attachments, local queue rows,
 * live editing state) is preserved per tab whenever a scope already exists.
 * On `refresh`, outstanding optimistic command overlays are also dropped — the
 * snapshot supersedes them.
 */
function installSnapshotIntoStore(
  snapshot: ChatStateSnapshot,
  reason: 'hydrate' | 'refresh',
): void {
  const api = chatStoreApi();
  const { projectId, worktreeId } = snapshot;
  invalidateStaleChatCatchUpScope(projectId, worktreeId);
  const key = chatScopeKey(projectId, worktreeId);
  const state = api.getState();
  canonicalActiveTabByScope.set(key, snapshot.tabsFile.activeTabId);

  const modelDefaults = state.modelDefaults;
  const resolvedDefaults = resolveTabDefaults(projectId, modelDefaults);
  const defaultProviderType = resolvedDefaults.model
    ? getProviderForModel(resolvedDefaults.model)
    : undefined;
  const defaultPluginSelections = sanitizePluginSelectionsWithCachedSupport(
    getDefaultPlugins(projectId, worktreeId, state.worktreeDefaultPlugins),
    defaultProviderType,
  );

  const chatState = fromPersistedTabs(
    snapshot.tabsFile,
    defaultPluginSelections,
    resolvedDefaults.model,
    resolvedDefaults.thinkingLevel,
    resolveDefaultChatInterfaceMode(projectId, modelDefaults),
    resolvedDefaults.modelConfig,
    resolveDeferredToolsAllowedDefault(
      projectId,
      worktreeId,
      state.deferredToolsDefaults,
    ),
    resolveBillingSeed(modelDefaults),
    defaultProviderType,
    false,
  );

  // Canonical runtime state governs streaming controls; the renderer never
  // infers durable lifecycle from provider events or session probes here.
  chatState.tabs = applyRuntimeStatusesToTabs(
    chatState.tabs,
    snapshot.runtimeByChatId,
  );

  const previous = state.worktreeChats[key];
  if (reason === 'refresh') {
    commandTracker.dropScope(projectId, worktreeId);
    optimisticActiveTabByScope.delete(key);
    optimisticClosedTabsByScope.delete(key);
  }
  if (previous) {
    chatState.tabs = chatState.tabs.map((tab) =>
      preserveRendererOnlyTabFields(
        previous.tabs.find((prev) => prev.id === tab.id),
        tab,
      ),
    );
    // Re-derive status from canonical runtime after preserving transient
    // fields (preserve keeps the previous status by default).
    chatState.tabs = applyRuntimeStatusesToTabs(
      chatState.tabs,
      snapshot.runtimeByChatId,
    );
  }

  if (previous) {
    const eagerTabs = previous.tabs.filter(
      (tab) =>
        tab.pendingInitialCreation &&
        !chatState.tabs.some((canonical) => canonical.id === tab.id),
    );
    if (eagerTabs.length) {
      chatState.tabs = [...chatState.tabs, ...eagerTabs];
      chatState.activeTabId = previous.activeTabId;
      chatState.lastActiveEditableChatId = previous.lastActiveEditableChatId;
    }
  }

  const queuedByChatId = new Map(
    snapshot.queue.map((entry) => [
      entry.chatId,
      hostQueueViewsToQueuedMessages(entry.queue),
    ]),
  );
  chatState.tabs = attachHostQueueMirror(chatState.tabs, queuedByChatId);

  const hydratedPendingQuestions = hydratePendingQuestionsFromFile(
    snapshot.tabsFile,
    projectId,
    worktreeId,
    chatState,
  );

  api.setState((current) => {
    const pendingQuestions = { ...current.pendingQuestions };
    for (const requestId of scopePendingQuestions(
      pendingQuestions,
      projectId,
      worktreeId,
    )) {
      delete pendingQuestions[requestId];
    }
    Object.assign(pendingQuestions, hydratedPendingQuestions);

    const runtimeByChatId = { ...current.runtimeByChatId };
    for (const tab of current.worktreeChats[key]?.tabs ?? []) {
      delete runtimeByChatId[tab.id];
    }
    Object.assign(runtimeByChatId, snapshot.runtimeByChatId);

    const hasUnreadTab = chatState.tabs.some((tab) => tab.unread === true);
    const unreadWorktreeKeys = hasUnreadTab
      ? current.unreadWorktreeKeys.has(key)
        ? current.unreadWorktreeKeys
        : new Set(Array.from(current.unreadWorktreeKeys).concat(key))
      : pruneUnreadWorktreeKey(current.unreadWorktreeKeys, key, chatState.tabs);

    return {
      worktreeChats: { ...current.worktreeChats, [key]: chatState },
      archivedChats: {
        ...current.archivedChats,
        [key]: snapshot.archives,
      },
      runtimeByChatId,
      pendingQuestions,
      unreadWorktreeKeys,
      ...(snapshot.recoveryError
        ? {
            chatStateNotices: {
              ...current.chatStateNotices,
              [key]: {
                kind: 'command_failed' as const,
                message: snapshot.recoveryError,
              },
            },
          }
        : {}),
    };
  });
  pruneCanonicalTerminalUnreadForSnapshot(
    key,
    new Set(
      chatState.tabs
        .filter(
          (tab) =>
            tab.autoArchive === true &&
            snapshot.runtimeByChatId[tab.id]?.status === 'completed',
        )
        .map((tab) => tab.id),
    ),
  );
  // A prefetch's snapshot waits for the real load to archive anything.
  if (!speculativeHydrationKeys.has(key))
    scheduleCanonicalAutoArchives(projectId, worktreeId);
  recoverUntrackedPlanProposals(projectId, worktreeId);
}

function applyCommittedEventToStore(event: ChatStateChangedEvent): void {
  const receiptStartedAt = performance.now();
  const finishReceiptStage = beginTranscriptPerformanceStage('event_receipt', {
    changes: event.changes.length,
  });
  const api = chatStoreApi();
  const { projectId, worktreeId } = event;
  const key = chatScopeKey(projectId, worktreeId);
  const correlationId = `${key}:${event.revision}`;
  recordTranscriptPerformanceCounter('canonical_revision_receipts');
  const commitChatIds = new Set<string>();
  for (const change of event.changes) {
    switch (change.type) {
      case 'messages.omitted':
      case 'transcript.updated':
      case 'message.upserted':
      case 'message.removed':
      case 'messages.replaced':
      case 'runtime.patched':
      case 'archive.removed':
      case 'archive.read_state_changed':
        commitChatIds.add(change.chatId);
        break;
      case 'tab.upserted':
        commitChatIds.add(change.tab.id);
        break;
      case 'tab.removed':
      case 'tab.metadata_patched':
        commitChatIds.add(change.tabId);
        break;
      case 'tab.active_changed':
        commitChatIds.add(change.activeTabId);
        break;
      case 'pending_question.upserted':
        commitChatIds.add(change.question.chatId);
        break;
      case 'pending_question.removed':
        commitChatIds.add(change.chatId);
        break;
      case 'archive.upserted':
        commitChatIds.add(change.archive.chatId);
        break;
      case 'tab.order_changed':
        break;
    }
  }
  const stateBeforeEvent = api.getState();
  const terminallyReadyChatIds = new Set<string>();
  for (const change of event.changes) {
    if (
      change.type === 'tab.metadata_patched' &&
      typeof change.patch.unread === 'boolean'
    ) {
      const targetKey = `${key}/${change.tabId}`;
      if (canonicalTerminalUnread.has(targetKey)) {
        canonicalTerminalUnread.set(targetKey, change.patch.unread);
      }
    }
    if (
      change.type === 'tab.removed' ||
      (change.type === 'tab.upserted' && change.tab.autoArchive !== true) ||
      (change.type === 'tab.metadata_patched' &&
        (change.patch.autoArchive === false ||
          change.patch.autoArchive === null))
    ) {
      clearCanonicalAutoArchiveRetryState(
        `${key}/${change.type === 'tab.upserted' ? change.tab.id : change.tabId}`,
      );
    }
    if (
      change.type === 'runtime.patched' &&
      change.runtime.status !== 'completed'
    ) {
      clearCanonicalAutoArchiveRetryState(`${key}/${change.chatId}`);
    }
    if (
      change.type === 'runtime.patched' &&
      change.runtime.status === 'completed' &&
      canonicalTerminalUnread.has(`${key}/${change.chatId}`)
    ) {
      terminallyReadyChatIds.add(change.chatId);
    }
    if (
      change.type === 'tab.upserted' &&
      change.tab.autoArchive === true &&
      stateBeforeEvent.worktreeChats[key]?.tabs.find(
        (tab) => tab.id === change.tab.id,
      )?.autoArchive !== true &&
      canonicalTerminalUnread.has(`${key}/${change.tab.id}`)
    ) {
      terminallyReadyChatIds.add(change.tab.id);
    }
    if (
      change.type === 'tab.metadata_patched' &&
      change.patch.autoArchive === true &&
      stateBeforeEvent.worktreeChats[key]?.tabs.find(
        (tab) => tab.id === change.tabId,
      )?.autoArchive !== true &&
      canonicalTerminalUnread.has(`${key}/${change.tabId}`)
    ) {
      terminallyReadyChatIds.add(change.tabId);
    }
    if (
      change.type === 'pending_question.upserted' &&
      change.question.delivery === 'async' &&
      change.question.dismissedAt !== undefined
    ) {
      terminallyReadyChatIds.add(change.question.chatId);
    }
  }

  const publicationStartedAt = performance.now();
  const finishPublicationStage = beginTranscriptPerformanceStage(
    'store_publication',
    { changes: event.changes.length },
  );
  commitChatIds.forEach((chatId) => {
    markTranscriptPerformanceCommitStart(chatId, correlationId, {
      changes: event.changes.length,
      revisionReceipts: 1,
    });
  });
  api.setState((current) => {
    const chatState = current.worktreeChats[key];
    if (!chatState) return {};

    const projection: CanonicalScopeProjection = {
      chatState,
      archives: current.archivedChats[key] ?? [],
      runtimeByChatId: current.runtimeByChatId,
      pendingQuestions: current.pendingQuestions,
    };
    let next = applyCanonicalChanges(projection, event.changes, {
      projectId,
      worktreeId,
    });
    for (const change of event.changes) {
      if (change.type === 'tab.active_changed') {
        canonicalActiveTabByScope.set(key, change.activeTabId);
      }
    }
    recordStaleChatCatchUpChanges(event);
    const optimisticallyClosedTabs = optimisticClosedTabsByScope.get(key);
    if (optimisticallyClosedTabs?.size) {
      const tabs = next.chatState.tabs.filter(
        (tab) => !optimisticallyClosedTabs.has(tab.id),
      );
      if (tabs.length !== next.chatState.tabs.length) {
        const activeTabId = tabs.some(
          (tab) => tab.id === next.chatState.activeTabId,
        )
          ? next.chatState.activeTabId
          : (tabs[0]?.id ?? '');
        next = {
          ...next,
          chatState: { ...next.chatState, tabs, activeTabId },
        };
      }
    }
    const optimisticSelection = optimisticActiveTabByScope.get(key);
    if (
      optimisticSelection &&
      next.chatState.activeTabId !== optimisticSelection.tabId &&
      next.chatState.tabs.some((tab) => tab.id === optimisticSelection.tabId)
    ) {
      next = {
        ...next,
        chatState: {
          ...next.chatState,
          activeTabId: optimisticSelection.tabId,
        },
      };
    }

    const hasUnreadTab = next.chatState.tabs.some((tab) => tab.unread === true);
    const unreadWorktreeKeys = hasUnreadTab
      ? current.unreadWorktreeKeys.has(key)
        ? current.unreadWorktreeKeys
        : new Set(Array.from(current.unreadWorktreeKeys).concat(key))
      : pruneUnreadWorktreeKey(
          current.unreadWorktreeKeys,
          key,
          next.chatState.tabs,
        );

    return {
      worktreeChats: { ...current.worktreeChats, [key]: next.chatState },
      // Unchanged archives keep the map's identity, so a selector of the
      // whole map (the Cowork page) does not re-render for every commit. A
      // scope without an entry still gets one, as before.
      archivedChats:
        current.archivedChats[key] === next.archives
          ? current.archivedChats
          : { ...current.archivedChats, [key]: next.archives },
      runtimeByChatId: next.runtimeByChatId,
      pendingQuestions: next.pendingQuestions,
      unreadWorktreeKeys,
    };
  });
  finishPublicationStage();
  finishReceiptStage();
  recordTranscriptPerformanceCorrelation(
    correlationId,
    'store_publication',
    performance.now() - publicationStartedAt,
    { changes: event.changes.length },
  );
  recordTranscriptPerformanceCorrelation(
    correlationId,
    'event_receipt',
    performance.now() - receiptStartedAt,
    { changes: event.changes.length },
  );
  if (terminallyReadyChatIds.size > 0) {
    scheduleCanonicalAutoArchives(
      projectId,
      worktreeId,
      terminallyReadyChatIds,
    );
  }
}

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

export const createRevisionedSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatRevisionedSlice
> = (set, get) => ({
  chatStateSync: {},
  runtimeByChatId: {},
  chatStateNotices: {},

  handleChatStateChanged: (event): void => {
    if (availability === 'unavailable') return;
    getController().handleEvent(event);
  },

  hydrateChatScopeRevisioned: async (
    projectId,
    worktreeId,
    options,
  ): Promise<'installed' | 'unavailable' | 'failed'> => {
    if (availability === 'unavailable') return 'unavailable';
    if (typeof window.api.chat.getState !== 'function') {
      availability = 'unavailable';
      return 'unavailable';
    }
    const sync = getController();
    const key = chatScopeKey(projectId, worktreeId);
    const pendingHydration = initialHydrations.get(key);
    if (pendingHydration) return pendingHydration;
    if (sync.getStatus(projectId, worktreeId)?.phase === 'live') {
      return 'installed';
    }
    if (options?.speculative) speculativeHydrationKeys.add(key);

    // Defaults for empty-scope tabs come from the shared model-defaults
    // machinery; load them before the snapshot installs synchronously.
    try {
      await get().ensureModelDefaultsLoaded();
    } catch {
      // Defaults are a display nicety; canonical state still installs.
    }

    const hydration = (async (): Promise<
      'installed' | 'unavailable' | 'failed'
    > => {
      try {
        const result = await sync.hydrate(projectId, worktreeId);
        if (result === 'failed') return 'failed';
        availability = 'available';
        hydratedKeys.add(key);
        revisionedSetupPendingKeys.add(key);
        recordWorktreeChatTouch(key);
        // A scope hydrated outside a load (prefetch, refresh) still ages out.
        scheduleIdleChatUnload();
        return 'installed';
      } catch (error) {
        if (
          availability !== 'available' &&
          isRevisionedUnavailableError(error)
        ) {
          availability = 'unavailable';
          return 'unavailable';
        }
        // Unrecoverable load error: surface the inline load-error treatment
        // (never a blank starter chat) and let Retry re-issue the hydration.
        set((state) => ({
          chatStateSync: {
            ...state.chatStateSync,
            [key]: { phase: 'refresh_error', revision: null },
          },
        }));
        return 'failed';
      } finally {
        initialHydrations.delete(key);
      }
    })();
    initialHydrations.set(key, hydration);
    return hydration;
  },

  retryChatStateRefresh: (projectId, worktreeId): void => {
    const sync = getController();
    if (sync.isTracking(projectId, worktreeId)) {
      sync.retry(projectId, worktreeId);
      return;
    }
    // Initial hydration failed; clear the synthetic error status and retry
    // the full hydration.
    const key = chatScopeKey(projectId, worktreeId);
    set((state) => {
      const chatStateSync = { ...state.chatStateSync };
      delete chatStateSync[key];
      return { chatStateSync };
    });
    void get().hydrateChatScopeRevisioned(projectId, worktreeId);
  },

  releaseChatScopeRevisioned: (projectId, worktreeId): void => {
    controller?.release(projectId, worktreeId);
    commandTracker.dropScope(projectId, worktreeId);
    const key = chatScopeKey(projectId, worktreeId);
    pendingUnreadByScope.delete(key);
    clearCanonicalTerminalUnreadForScope(key);
    optimisticActiveTabByScope.delete(key);
    canonicalActiveTabByScope.delete(key);
    optimisticClosedTabsByScope.delete(key);
    set((state) => {
      const chatStateSync = { ...state.chatStateSync };
      delete chatStateSync[key];
      const chatStateNotices = { ...state.chatStateNotices };
      delete chatStateNotices[key];
      const runtimeByChatId = { ...state.runtimeByChatId };
      for (const tab of state.worktreeChats[key]?.tabs ?? []) {
        delete runtimeByChatId[tab.id];
      }
      return { chatStateSync, chatStateNotices, runtimeByChatId };
    });
  },

  dismissChatStateNotice: (projectId, worktreeId): void => {
    const key = chatScopeKey(projectId, worktreeId);
    set((state) => {
      if (!(key in state.chatStateNotices)) return {};
      const chatStateNotices = { ...state.chatStateNotices };
      delete chatStateNotices[key];
      return { chatStateNotices };
    });
  },

  dispatchChatCommand: async (
    scope,
    command,
    options,
  ): Promise<ChatCommandDisposition> => {
    if (
      command.type === 'chat.steer_queued_message' ||
      (command.type === 'chat.input_delivery_action' &&
        ['save', 'resend', 'resend-original'].includes(command.action))
    ) {
      await pendingApprovalModeTransitions(
        scope.projectId,
        scope.worktreeId,
        command.chatId,
      );
    }
    const key = chatScopeKey(scope.projectId, scope.worktreeId);
    for (const chatId of commandChatIds(command)) {
      const eagerCreation = pendingEagerChatCreation({ ...scope, chatId });
      if (eagerCreation && !(await eagerCreation)) return 'transport_failed';
    }
    const pendingCreations = commandChatIds(command)
      .map((chatId) =>
        pendingTabCreation(scope.projectId, scope.worktreeId, chatId),
      )
      .filter(
        (creation): creation is Promise<ChatCommandDisposition> =>
          creation !== undefined,
      );
    for (const creation of Array.from(new Set(pendingCreations))) {
      const creationDisposition = await creation;
      if (creationDisposition !== 'accepted') return creationDisposition;
    }
    const sync = get().chatStateSync[key];
    if (sync?.phase === 'refreshing' || sync?.phase === 'refresh_error') {
      // Send and destructive actions are disabled while the scope refreshes
      // or shows the load-error treatment; nothing was submitted.
      return 'transport_failed';
    }

    const envelope = createChatCommandEnvelope(scope, command, {
      ...(options?.commandId ? { commandId: options.commandId } : {}),
      ...(options?.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}),
    });
    const tracked = Boolean(options?.rollback || options?.reconcile);
    if (tracked) {
      commandTracker.register({
        commandId: envelope.commandId,
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        rollback: options?.rollback ?? ((): void => undefined),
        ...(options?.reconcile ? { reconcile: options.reconcile } : {}),
      });
    }

    const setNotice = (
      kind: 'conflict' | 'command_failed',
      message: string,
    ): void => {
      set((state) => ({
        chatStateNotices: {
          ...state.chatStateNotices,
          [key]: { kind, message },
        },
      }));
    };

    try {
      if (typeof window.api.chat.command !== 'function') {
        throw Object.assign(new Error('Chat commands are unavailable.'), {
          code: 'unavailable',
        });
      }
      const result = await window.api.chat.command(envelope);
      try {
        options?.onResult?.(result);
      } catch {
        // The command result is already durable; sequencing observers must
        // not reinterpret a committed command as a transport failure.
      }
      const settled = tracked ? commandTracker.settleResult(result) : null;
      const disposition =
        options?.acceptNotFound === true && result.outcome === 'not_found'
          ? 'accepted'
          : (settled?.disposition ?? classifyChatCommandResult(result));
      if (disposition === 'conflict') {
        // Stale destructive command: never auto-retry; refresh the view.
        setNotice('conflict', CHAT_STATE_CONFLICT_NOTICE);
        getController().forceRefresh(scope.projectId, scope.worktreeId);
      } else if (disposition === 'rejected') {
        setNotice('command_failed', CHAT_STATE_COMMAND_FAILED_NOTICE);
      }
      return disposition;
    } catch {
      if (tracked) commandTracker.settleTransportFailure(envelope.commandId);
      setNotice('command_failed', CHAT_STATE_COMMAND_FAILED_NOTICE);
      return 'transport_failed';
    }
  },
});

/**
 * Reconcile an uncertain settings-command outcome using the canonical snapshot.
 */
export function refreshChatScopeRevisioned(
  projectId: string,
  worktreeId: string,
): void {
  const sync = getController();
  if (sync.isTracking(projectId, worktreeId)) {
    sync.forceRefresh(projectId, worktreeId);
  } else {
    void chatStoreApi()
      .getState()
      .hydrateChatScopeRevisioned(projectId, worktreeId);
  }
}

export function isScopeRevisionedLive(
  state: Pick<ChatState, 'chatStateSync'>,
  projectId: string,
  worktreeId: string,
): boolean {
  const sync = state.chatStateSync[chatScopeKey(projectId, worktreeId)];
  return sync !== undefined && sync.phase !== 'hydrating';
}

/**
 * Wait for a scope refresh that is already in progress to return to its live
 * projection. Idempotent metadata commands can use this to retry once instead
 * of being lost in the narrow race between a live pre-check and dispatch.
 */
export function waitForChatScopeLive(
  projectId: string,
  worktreeId: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const api = chatStoreApi();
  const key = chatScopeKey(projectId, worktreeId);
  const initialPhase = api.getState().chatStateSync[key]?.phase;
  if (initialPhase === 'live') return Promise.resolve(true);
  if (initialPhase !== 'refreshing') return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(live);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    unsubscribe = api.subscribe((state) => {
      const phase = state.chatStateSync[key]?.phase;
      if (phase === 'live') finish(true);
      else if (phase !== 'refreshing') finish(false);
    });

    const currentPhase = api.getState().chatStateSync[key]?.phase;
    if (currentPhase === 'live') finish(true);
    else if (currentPhase !== 'refreshing') finish(false);
  });
}

/** True while send/destructive controls must be disabled for the scope. */
export function isChatScopeCommandBlocked(
  state: Pick<ChatState, 'chatStateSync'>,
  projectId: string,
  worktreeId: string,
): boolean {
  const phase = state.chatStateSync[chatScopeKey(projectId, worktreeId)]?.phase;
  return phase === 'refreshing' || phase === 'refresh_error';
}
