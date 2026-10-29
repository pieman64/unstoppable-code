import {
  agentSendAcceptanceReceipt,
  reportAgentSendAccepted,
} from '../canopy-runtime/core-chat-message-command-adapter';
import type {
  AgentSendAcceptanceFacts,
  AgentSendRefusalCode,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type {
  WatcherDeliveryIngressCheck,
  ChatWatcherHeldOutcome,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  checkWatcherDeliveryIngress,
  WatcherDeliveryHeldError,
} from './active-chat-input';
import {
  revalidateAgentSenderRequest,
  revalidateAgentSteeringActor,
  agentSendTargetReadiness,
  withAgentSenderAuthority,
  isAgentSenderContextError,
} from '../agent-messaging/sender-context';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type {
  ChatQueueEditRequest,
  ChatQueueOrigin,
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  HostQueuedMessageView,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  isTerminalBackedInterfaceMode,
} from '@canopy/desktop-shared/types';
import { getEffectiveClaudeChatInterfaceMode } from '../lib/claude-tui-chats';
import {
  chatSurfaceUsesGlobalPluginDefaults,
  pluginSelectionsEqual,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  getActiveChatIds,
  getSession,
  getSessionPluginSelections,
  getSessionGlobalPluginDefaultsRevision,
  subscribeGlobalPluginDefaultsRevision,
  hasPendingCodexContinuation,
} from '../agents/session-manager';
import {
  isDelegationDeliveryActive,
  retireDelegationDelivery,
} from '../agents/delegation/lifecycle';
import { getInheritedPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import { isTurnAuthPreflightRefusal } from '../lib/auth-preflight-error';
import { beginChatTurnPreparation } from '../lib/chat-turn-cancel';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToWindow } from '../lib/window-send';
import { isAutoModelRoutingApplyError } from '../model-routing/apply-error';
import { isAutoModelRoutingInProgressError } from '../model-routing/in-progress-error';
import { isChatScopeDeletingError } from './chat-scope-lifecycle';
import type { WatcherSteeringResult } from './chat-input-delivery-coordinator';
import type { ChatMutationOptions } from './chat-state-contracts';

type ChatQueueCommandResult = NonNullable<ChatMutationOptions['commandResult']>;

export type ChatQueueDispatchOptions = Pick<
  PersistedHostQueuedMessage,
  'requiredAccountProxyConnectionId'
>;

function assertValidQueueDispatchOptions(
  options: ChatQueueDispatchOptions,
): void {
  const pin = options.requiredAccountProxyConnectionId;
  if (pin !== undefined && (typeof pin !== 'string' || !pin.trim()))
    throw new Error('Queued continuation billing constraint is invalid.');
}

const QUEUE_PERSISTENCE_RETRY_MIN_MS = 500;
const QUEUE_PERSISTENCE_RETRY_MAX_MS = 5_000;

export type ChatQueueTerminalStatus = 'complete' | 'error' | 'cancelled';
export type ChatQueueMutationResult = 'applied' | 'not_found' | 'busy';
export type ChatQueuePersistenceMutation =
  | {
      type: 'agent-send-accepted';
      request: ChatSendMessageRequest;
      acceptance: AgentSendAcceptanceFacts;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'restore-input';
      request: ChatSendMessageRequest;
      rowId: string;
      epoch: number;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'edit';
      request: ChatSendMessageRequest;
      /** Async question reopened when this queued answer became ordinary text. */
      restoredAsyncQuestionId?: string;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'cancel';
      request: ChatSendMessageRequest;
      lastErrorMessage?: string;
      agentSendRefusalCode?: AgentSendRefusalCode;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'consume-restored-input';
      request: ChatSendMessageRequest;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      type: 'force';
      request: ChatSendMessageRequest;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      /** Cancels a still-queued agent acceptance row; never touches the transcript. */
      type: 'settle-agent-input';
      request: ChatSendMessageRequest;
      reason: string;
      commandResult?: ChatQueueCommandResult;
    }
  | {
      /**
       * The sends taken off the queue, in order, because the worktree setup
       * that held them ended `outcome`; their turns end that way in the
       * commit that removes them.
       */
      type: 'end-setup-held';
      requests: readonly ChatSendMessageRequest[];
      outcome: 'cancelled' | 'failed';
    };

interface HostQueuedMessage extends PersistedHostQueuedMessage {
  editLocked?: boolean;
  /** Runtime-only hold: retain the durable row, but do not stall later input. */
  watcherDeliveryHeld?: ChatWatcherHeldOutcome;
  /** A committed user edit prevents later watcher deliveries coalescing here. */
  watcherConsolidationBoundary?: boolean;
  /** Trusted source messages retained while adjacent watcher rows coalesce. */
  watcherParts?: QueuedWatcherPart[];
}

interface QueuedWatcherPart {
  userMessageId: string;
  kind: string;
  text: string;
  hiddenContextText?: string;
}

interface ChatQueueEntry {
  operationEpoch?: number;
  /** Untagged terminal releases (Stop/destroy) seen for this chat. */
  untaggedTerminals?: number;
  queue: HostQueuedMessage[];
  persistedInputIds: Set<string>;
  turnActive: boolean;
  dispatchInFlight: boolean;
  recoveryInFlight: boolean;
  /** Suppresses changed queue snapshots when concurrent persistence resolves out of order. */
  broadcastRevision?: number;
  /** Serialized public queue shape associated with broadcastRevision. */
  broadcastQueueSignature?: string;
  frozenForDeletion?: boolean;
  authenticationPause?: string;
  /**
   * Set while the chat's worktree Git setup runs. `turnUserMessageId` is the
   * turn the setup holds, which owns the gate meanwhile; once released for it
   * as `firstUserMessageId`, only that send dispatches.
   */
  worktreeSetupHold?: {
    turnUserMessageId?: string;
    firstUserMessageId?: string;
  };
  discardedForDeletion?: boolean;
  /** userMessageId of the currently dispatched turn, for stale-release checks. */
  activeTurnUserMessageId?: string;
  /** Selection snapshot captured when the currently running turn was accepted. */
  activePluginSelections?: ChatTabPluginSelections;
  activeGlobalPluginDefaultsRevision?: number;
  currentGlobalPluginDefaultsRevision?: number;
  drainTimer?: ReturnType<typeof setTimeout>;
  heldRetryTimer?: ReturnType<typeof setTimeout>;
  heldRetryDelayMs?: number;
}

export interface ChatQueueWorktreeDeletion {
  commit(): void;
  rollback(options?: ChatQueueWorktreeDeletionRollbackOptions): void;
}

export interface ChatQueueWorktreeDeletionRollbackOptions {
  /** Every provider session in the scope was removed before deletion failed. */
  sessionsDestroyed?: boolean;
}

export interface ChatQueueServiceDependencies {
  checkWatcherIngress?(
    request: ChatSendMessageRequest,
  ): ReturnType<WatcherDeliveryIngressCheck>;
  steerWatcher?(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    queuedIds: () => string[],
    allowSteering: boolean,
  ): Promise<WatcherSteeringResult>;
  dispatch(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    fromQueue: boolean,
    options?: ChatQueueDispatchOptions,
  ): Promise<void>;
  /**
   * Register Stop ownership for a send the queue has accepted but not yet
   * handed to the provider. The same send's turn preparation, begun inside
   * `dispatch`, inherits a Stop that lands in between.
   */
  beginTurnPreparation?(
    target: ChatQueueTarget & { readonly userMessageId?: string },
  ): { readonly cancelled: boolean; finish(): void };
  cancel(target: ChatQueueTarget): Promise<void>;
  settleCancelledTurn(
    target: ChatQueueTarget,
    turnUserMessageId?: string,
  ): void | Promise<void>;
  /**
   * True when the provider session is already processing (or has internally
   * accepted) a turn that did not originate through this queue service, such
   * as a Claude background-task continuation waking an idle chat.
   */
  hasActiveProviderTurn(target: ChatQueueTarget): boolean;
  /** Selection snapshot of the active provider session, if one exists. */
  getActiveProviderPluginSelections?(
    target: ChatQueueTarget,
  ): ChatTabPluginSelections | undefined;
  getActiveProviderPluginDefaultsRevision?(
    target: ChatQueueTarget,
  ): number | undefined;
  getCurrentPluginDefaultsRevision?(
    target: ChatQueueTarget,
  ): number | undefined;
  /** Settle received events before a new dispatch replaces their route. */
  drainProviderEvents?(target: ChatQueueTarget): Promise<void>;
  endDiscardedTurns?(
    target: ChatQueueTarget,
    requests: readonly ChatSendMessageRequest[],
  ): Promise<void>;
  /** True while a live Codex turn is paused for user input and can resume. */
  hasPendingProviderContinuation(target: ChatQueueTarget): boolean;
  persistRuntime(
    target: ChatQueueTarget,
    queuedMessageIds: readonly string[],
    turnActive: boolean,
    mutation?: ChatQueuePersistenceMutation,
    queuedMessages?: readonly PersistedHostQueuedMessage[],
    activeTurnUserMessageId?: string,
  ): void | Promise<void>;
  broadcast(event: ChatQueueUpdatedEvent): void;
  createId(): string;
  now(): number;
  schedule(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
}

function chatQueueKey(target: ChatQueueTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

/**
 * Host-generated inputs that steer an active turn before they queue: a fired
 * watcher, or a delegate's message to its root chat.
 */
function steersBeforeQueueing(request: ChatSendMessageRequest): boolean {
  return Boolean(request.watcherFired || request.managedDelegationDeliveryId);
}

/** Delegation provenance must be host-issued and still live before admission. */
function validateDelegationDelivery(
  request: ChatSendMessageRequest,
  origin: ChatQueueOrigin,
): void {
  const deliveryId = request.managedDelegationDeliveryId;
  if (
    deliveryId &&
    (origin === 'portal' ||
      deliveryId !== request.userMessageId ||
      !isDelegationDeliveryActive(request, deliveryId))
  ) {
    throw new Error('Invalid delegation delivery');
  }
}

function hasTrackedWatcherDelivery(
  entry: ChatQueueEntry,
  request: ChatSendMessageRequest,
): boolean {
  if (!request.watcherFired) return false;
  const userMessageId = request.userMessageId;
  if (entry.activeTurnUserMessageId === userMessageId) return true;
  return entry.queue.some(
    (message) =>
      message.request.userMessageId === userMessageId ||
      message.request.consolidatedWatcherUserMessageIds?.includes(
        userMessageId,
      ) === true ||
      message.watcherParts?.some(
        (part) => part.userMessageId === userMessageId,
      ) === true,
  );
}

function watcherPartFromRequest(
  request: ChatSendMessageRequest,
): QueuedWatcherPart | undefined {
  if (
    !request.watcherFired ||
    request.agentSent ||
    request.agentSenderProvenance
  )
    return undefined;
  if (
    request.hiddenContext !== undefined &&
    request.hiddenContext.kind !== 'canopy-watcher-event'
  ) {
    return undefined;
  }
  return {
    userMessageId: request.userMessageId,
    kind: request.watcherFired.kind,
    text: request.text,
    ...(request.hiddenContext?.text
      ? { hiddenContextText: request.hiddenContext.text }
      : {}),
  };
}

function watcherVisibleSummary(part: QueuedWatcherPart): string {
  const lines = part.text.trim().split('\n');
  if (
    lines.length > 1 &&
    /(?:^|\s)watcher fired\.$/i.test(lines[0]?.trim() ?? '')
  ) {
    const summary = lines.slice(1).join('\n').trim();
    if (summary) return summary;
  }
  return part.text.trim() || part.kind;
}

function unwrapSystemInstruction(text: string): string {
  const trimmed = text.trim();
  const opening = '<system_instruction>';
  const closing = '</system_instruction>';
  if (trimmed.startsWith(opening) && trimmed.endsWith(closing)) {
    return trimmed.slice(opening.length, -closing.length).trim();
  }
  return trimmed;
}

function combinedWatcherHiddenContext(
  parts: readonly QueuedWatcherPart[],
): ChatSendMessageRequest['hiddenContext'] {
  const withContext = parts.filter(
    (part): part is QueuedWatcherPart & { hiddenContextText: string } =>
      Boolean(part.hiddenContextText?.trim()),
  );
  if (withContext.length === 0) return undefined;
  const contextCount = withContext.length;
  return {
    kind: 'canopy-watcher-event',
    text: [
      '<system_instruction>',
      `${contextCount} watcher event${contextCount === 1 ? '' : 's'} supplied hidden context while ${parts.length} watcher events fired and were consolidated into this queued message. The visible message summarizes every watcher; the entries below preserve hidden context only for events that supplied it. Respond to every watcher represented in the visible message and preserve each provided event's safety and follow-up instructions.`,
      '',
      `<watcher_messages count="${contextCount}">`,
      ...withContext.flatMap((part, index) => [
        `<watcher_message index="${index + 1}">`,
        unwrapSystemInstruction(part.hiddenContextText),
        '</watcher_message>',
      ]),
      '</watcher_messages>',
      '</system_instruction>',
    ].join('\n'),
  };
}

function combinedWatcherRequest(
  request: ChatSendMessageRequest,
  parts: readonly QueuedWatcherPart[],
): ChatSendMessageRequest {
  const count = parts.length;
  const hiddenContext = combinedWatcherHiddenContext(parts);
  return {
    ...request,
    text: parts.map(watcherVisibleSummary).join('\n\n'),
    watcherFired: {
      kind: `Multiple watchers fired (${count})`,
      combinedWatchers: parts.map(({ kind, text }) => ({ kind, text })),
    },
    consolidatedWatcherUserMessageIds: parts.map((part) => part.userMessageId),
    ...(hiddenContext ? { hiddenContext } : { hiddenContext: undefined }),
  };
}

function canSteerQueuedMessage(
  entry: ChatQueueEntry,
  message: HostQueuedMessage,
): boolean {
  return !(
    entry.recoveryInFlight ||
    entry.dispatchInFlight ||
    message.editLocked ||
    message.watcherParts ||
    message.request.watcherFired ||
    message.request.asyncQuestionId ||
    message.requiredAccountProxyConnectionId !== undefined ||
    steerBlockedByCapabilityChange(entry, message) ||
    entry.frozenForDeletion
  );
}

function steerBlockedByCapabilityChange(
  entry: ChatQueueEntry,
  message: HostQueuedMessage,
): boolean {
  return (
    entry.turnActive &&
    (entry.activePluginSelections === undefined ||
      (entry.activeGlobalPluginDefaultsRevision !== undefined &&
        entry.currentGlobalPluginDefaultsRevision !==
          entry.activeGlobalPluginDefaultsRevision) ||
      !pluginSelectionsEqual(
        entry.activePluginSelections,
        normalizePluginSelections(message.request.pluginSelections),
      ))
  );
}

function queuedMessageView(
  message: HostQueuedMessage,
  entry: ChatQueueEntry,
): HostQueuedMessageView {
  return {
    id: message.id,
    text: message.request.text,
    supersedesUserMessageId: message.request.userMessageId,
    promptSource:
      message.request.watcherFired ||
      message.request.initiationSource === 'hook'
        ? 'automated'
        : 'human',
    ...(message.request.fileReferences
      ? { fileReferences: message.request.fileReferences }
      : {}),
    ...(message.request.attachmentPaths
      ? { attachmentPaths: message.request.attachmentPaths }
      : {}),
    ...(message.request.attachmentPromptContexts
      ? { attachmentPromptContexts: message.request.attachmentPromptContexts }
      : {}),
    ...(message.request.inputMode
      ? { inputMode: message.request.inputMode }
      : {}),
    origin: message.origin,
    enqueuedAtMs: message.enqueuedAtMs,
    ...(message.editLocked === true ? { editLocked: true } : {}),
    ...(canSteerQueuedMessage(entry, message) ? { canSteer: true } : {}),
    ...(steerBlockedByCapabilityChange(entry, message)
      ? { steerBlockedByCapabilityChange: true }
      : {}),
    ...(message.request.agentSent
      ? { agentSent: message.request.agentSent }
      : {}),
    ...(message.request.watcherFired
      ? { watcherFired: message.request.watcherFired }
      : {}),
  };
}

async function defaultDispatch(
  request: ChatSendMessageRequest,
  origin: ChatQueueOrigin,
  fromQueue: boolean,
  options?: ChatQueueDispatchOptions,
): Promise<void> {
  // Keep this local-module import lazy to break the queue-service/chat-service
  // cycle: chat-service submits here, while the queue owns dispatch timing.
  const { dispatchHostQueuedWorktreeChatMessage } =
    await import('./chat-service');
  await dispatchHostQueuedWorktreeChatMessage(
    request,
    origin,
    fromQueue,
    options,
  );
}

async function defaultCancel(target: ChatQueueTarget): Promise<void> {
  // Cancellation helpers reconcile back into this queue, so resolve them only
  // when cancellation runs to avoid the initialization cycle.
  const { interruptChatTurnForQueuedMessage } =
    await import('../lib/chat-turn-cancel');
  await interruptChatTurnForQueuedMessage(target);
  // The cancelled turn's terminal event may lag behind cancel() resolving;
  // clear the active-turn marker now so the force-send dispatch that follows
  // does not trip the second-active-turn guard in dispatchWorktreeChatTurn.
  const { clearActiveTurnUserMessageId } =
    await import('../lib/worktree-chat-turn');
  clearActiveTurnUserMessageId(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
}

function defaultBroadcast(event: ChatQueueUpdatedEvent): void {
  // Partial electron test doubles may omit getAllWindows; queue mechanics
  // must not depend on a window being reachable.
  if (typeof BrowserWindow.getAllWindows !== 'function') return;
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, IPC_CHANNELS.chatQueueUpdated, event);
  }
  void import('./chat-service').then(({ projectChatQueueSummary }) =>
    projectChatQueueSummary(event),
  );
}

async function defaultPersistRuntime(
  target: ChatQueueTarget,
  queuedMessageIds: readonly string[],
  turnActive: boolean,
  mutation?: ChatQueuePersistenceMutation,
  queuedMessages?: readonly PersistedHostQueuedMessage[],
  activeTurnUserMessageId?: string,
): Promise<void> {
  // Canonical state dispatches queued commands through this service; keep the
  // reverse dependency local to reconciliation.
  const { getChatStateService } = await import('./chat-state-service');
  await getChatStateService().reconcileHostQueue(
    target,
    queuedMessageIds,
    turnActive,
    mutation,
    queuedMessages,
    activeTurnUserMessageId,
  );
}

function defaultSchedule(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultHasActiveProviderTurn(target: ChatQueueTarget): boolean {
  const session = getSession(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
  // An aborted Claude query can remain registered until its stream cleanup
  // finishes. It cannot receive another input; normal dispatch will await
  // teardown before creating its replacement.
  if (session?.isDisposed?.()) return false;
  return (
    session?.hasPendingSteeringInput?.() === true ||
    getActiveChatIds(target.projectId, target.worktreeId).includes(
      target.chatId,
    )
  );
}

function defaultHasPendingProviderContinuation(
  target: ChatQueueTarget,
): boolean {
  return hasPendingCodexContinuation(
    target.projectId,
    target.worktreeId,
    target.chatId,
  );
}

async function defaultSettleCancelledTurn(
  target: ChatQueueTarget,
  turnUserMessageId?: string,
): Promise<void> {
  // Match the regular Stop IPC's renderer settlement. Codex interruption can
  // resolve before its provider terminal event arrives; forced queue dispatch
  // starts the replacement turn immediately, so that late tagged terminal is
  // then (correctly) ignored as stale. Emit an ordered synthetic terminal now
  // so the superseded turn's timer closes before the replacement prompt opens.
  // chat-service owns dispatch and imports this queue; load it here to break
  // that cycle while preserving ordered cancellation emission.
  const { emitHostQueueForcedCancellation } = await import('./chat-service');
  await emitHostQueueForcedCancellation(target, turnUserMessageId);
}

const DEFAULT_DEPENDENCIES: ChatQueueServiceDependencies = {
  checkWatcherIngress: checkWatcherDeliveryIngress,
  steerWatcher: async (request, origin, queuedIds, allowSteering) => {
    // Chat-state owns this queue. Keep the reverse dependency lazy, as in
    // explicit queued-message steering, to avoid an initialization cycle.
    const { getChatStateService } = await import('./chat-state-service');
    return getChatStateService().inputDelivery.steerWatcher(
      request,
      queuedIds,
      origin,
      allowSteering,
    );
  },
  dispatch: defaultDispatch,
  beginTurnPreparation: beginChatTurnPreparation,
  cancel: defaultCancel,
  settleCancelledTurn: defaultSettleCancelledTurn,
  hasActiveProviderTurn: defaultHasActiveProviderTurn,
  getActiveProviderPluginSelections: (target) =>
    getSessionPluginSelections(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
  getActiveProviderPluginDefaultsRevision: (target) =>
    getSessionGlobalPluginDefaultsRevision(
      target.projectId,
      target.worktreeId,
      target.chatId,
    ),
  getCurrentPluginDefaultsRevision: (target) =>
    chatSurfaceUsesGlobalPluginDefaults(target.projectId)
      ? getInheritedPluginDefaultsRevision(target)
      : undefined,
  drainProviderEvents: async (target): Promise<void> => {
    // Lazy by design: the event router feeds lifecycle state back into this
    // queue. Deferring the reverse edge breaks that initialization cycle; the
    // packaged Electron main build exercises this local import path.
    const { drainCurrentSessionEvents } =
      await import('../agents/session-event-router');
    await drainCurrentSessionEvents(target);
  },
  endDiscardedTurns: async (target, requests): Promise<void> => {
    const { getChatStateService } = await import('./chat-state-service');
    getChatStateService().endDiscardedQueuedTurns(target, requests);
  },
  hasPendingProviderContinuation: defaultHasPendingProviderContinuation,
  persistRuntime: defaultPersistRuntime,
  broadcast: defaultBroadcast,
  createId: randomUUID,
  now: Date.now,
  schedule: defaultSchedule,
};

export class ChatQueueService {
  private readonly entries = new Map<string, ChatQueueEntry>();
  private readonly editLockAttempts = new WeakMap<HostQueuedMessage, symbol>();
  private readonly editLockOwners = new WeakMap<HostQueuedMessage, string>();
  private readonly activeInputHydrations = new Map<string, number>();
  private readonly watcherSubmissions = new Map<string, Promise<void>>();
  private readonly inputRestorations = new Map<string, Promise<void>>();

  public constructor(
    private readonly dependencies: ChatQueueServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  /** Retain consumed IDs only while a previously read worktree snapshot can hydrate. */
  public beginInputHydration(
    projectId: string,
    worktreeId: string,
  ): () => void {
    const scope = `${projectId}/${worktreeId}/`;
    this.activeInputHydrations.set(
      scope,
      (this.activeInputHydrations.get(scope) ?? 0) + 1,
    );
    return (): void => {
      const remaining = (this.activeInputHydrations.get(scope) ?? 1) - 1;
      if (remaining > 0) this.activeInputHydrations.set(scope, remaining);
      else {
        this.activeInputHydrations.delete(scope);
        this.entries.forEach((entry, key) => {
          if (key.startsWith(scope)) this.prunePersistedInputIds(entry);
        });
      }
    };
  }

  private prunePersistedInputIds(entry: ChatQueueEntry): void {
    const liveIds = new Set(entry.queue.map(({ id }) => id));
    entry.persistedInputIds.forEach((id) => {
      if (!liveIds.has(id)) entry.persistedInputIds.delete(id);
    });
  }

  private pruneInputIdsAfterPersistence(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    if (
      !this.activeInputHydrations.has(
        `${target.projectId}/${target.worktreeId}/`,
      )
    )
      this.prunePersistedInputIds(entry);
  }

  /** Refresh the derived Steer state after global or project plugin defaults change. */
  public refreshGlobalPluginDefaults(): void {
    for (const entry of Array.from(this.entries.values())) {
      const queued = entry.queue[0];
      if (!queued || entry.discardedForDeletion) continue;
      const revision = this.dependencies.getCurrentPluginDefaultsRevision?.(
        queued.request,
      );
      if (revision === entry.currentGlobalPluginDefaultsRevision) continue;
      entry.currentGlobalPluginDefaultsRevision = revision;
      this.broadcastBestEffort(queued.request, entry, false);
    }
  }

  private releaseWatcherAuthority(request: ChatSendMessageRequest): void {
    if (!request.watcherDeliveryId) return;
    const deliveryId = request.watcherDeliveryId;
    void import('../app-advisor/watchers')
      .then(({ getAppAdvisorWatcherService }) =>
        getAppAdvisorWatcherService().releaseChatDeliveryAuthority(deliveryId),
      )
      .catch((error: unknown) => {
        logMainProcessWarn(
          '[chat-queue] Failed to release watcher delivery authority:',
          error,
        );
      });
  }

  private resetHeldWatcherRetry(entry: ChatQueueEntry): void {
    if (entry.heldRetryTimer) clearTimeout(entry.heldRetryTimer);
    delete entry.heldRetryTimer;
    delete entry.heldRetryDelayMs;
  }

  private armHeldWatcherRetry(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): void {
    if (
      entry.heldRetryTimer ||
      entry.frozenForDeletion ||
      entry.discardedForDeletion ||
      !entry.queue.some((message) => message.watcherDeliveryHeld)
    )
      return;
    const delay = entry.heldRetryDelayMs ?? 5000;
    entry.heldRetryDelayMs = Math.min(delay * 2, 60000);
    entry.heldRetryTimer = this.dependencies.schedule((): void => {
      delete entry.heldRetryTimer;
      for (const message of entry.queue) delete message.watcherDeliveryHeld;
      this.scheduleDrain(target, entry, 0);
    }, delay);
    entry.heldRetryTimer.unref?.();
  }

  private watcherDispatchSucceeded(
    request: ChatSendMessageRequest,
    entry: ChatQueueEntry,
  ): void {
    this.releaseWatcherAuthority(request);
    this.resetHeldWatcherRetry(entry);
    this.armHeldWatcherRetry(request, entry);
  }

  /** Access-change wakeup for main-accepted watcher inputs whose outbox may be ACKed. */
  public retryHeldWatcherDeliveries(): void {
    for (const entry of Array.from(this.entries.values())) {
      this.resetHeldWatcherRetry(entry);
      const held = entry.queue.find((message) => message.watcherDeliveryHeld);
      if (!held) continue;
      for (const message of entry.queue) delete message.watcherDeliveryHeld;
      this.scheduleDrain(held.request, entry, 0);
    }
  }

  public async submit(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    options: ChatQueueDispatchOptions = {},
  ): Promise<void> {
    validateDelegationDelivery(request, origin);
    assertValidQueueDispatchOptions(options);
    if (request.watcherFired && request.watcherDeliveryId) {
      const check = await this.dependencies.checkWatcherIngress?.(request);
      if (check && !check.allowed)
        throw new WatcherDeliveryHeldError(check.reason);
    }
    if (
      !steersBeforeQueueing(request) ||
      !this.dependencies.steerWatcher ||
      options.requiredAccountProxyConnectionId
    )
      return this.submitNormally(request, origin, options);
    const key = chatQueueKey(request);
    const entry = this.getOrCreateEntry(request);
    const previous = this.watcherSubmissions.get(key) ?? Promise.resolve();
    const submission = previous
      .catch(() => undefined)
      .then(async () => {
        await this.dependencies.drainProviderEvents?.(request);
        // A serialized handoff may wait while its delivery is retired.
        validateDelegationDelivery(request, origin);
        if (
          this.entries.get(key) !== entry ||
          entry.frozenForDeletion ||
          entry.discardedForDeletion
        )
          throw new Error('Chat is closing');
        if (hasTrackedWatcherDelivery(entry, request)) return;
        // Authority may change while another watcher or provider event commits.
        // Retain accepted input locally rather than steering stale source data.
        if (request.watcherDeliveryId) {
          const check = await this.dependencies.checkWatcherIngress?.(request);
          if (check && !check.allowed) {
            await this.enqueueDurably(request, entry, {
              id: this.dependencies.createId(),
              request,
              origin,
              enqueuedAtMs: this.dependencies.now(),
              watcherDeliveryHeld: {
                outcome: check.outcome,
                reason: check.reason,
              },
            });
            this.armHeldWatcherRetry(request, entry);
            return;
          }
        }
        const ownsReservation =
          !entry.dispatchInFlight && !entry.recoveryInFlight;
        if (ownsReservation) entry.recoveryInFlight = true;
        let result: WatcherSteeringResult | undefined;
        try {
          result = await this.dependencies.steerWatcher?.(
            request,
            origin,
            () => entry.queue.map((row) => row.id),
            ownsReservation,
          );
        } finally {
          if (ownsReservation) {
            entry.recoveryInFlight = false;
            if (!entry.turnActive) this.scheduleDrain(request, entry, 0);
          }
        }
        if (result?.status === 'handled') {
          // The input is steered or already in the delivery ledger.
          this.releaseWatcherAuthority(request);
          // The input-delivery ledger owns a steered delegate message from
          // here on; it is never claimed for an ordinary queued dispatch.
          if (result.submitted && request.managedDelegationDeliveryId)
            retireDelegationDelivery(
              request,
              request.managedDelegationDeliveryId,
            );
          return;
        }
        if (
          this.entries.get(key) !== entry ||
          entry.frozenForDeletion ||
          entry.discardedForDeletion
        )
          throw new Error('Chat is closing');
        if (result?.status === 'requeue') {
          await this.restoreWithdrawnInput(
            request,
            result.rowId,
            undefined,
            result.epoch,
            origin,
          );
          await this.drain(request, entry);
          return;
        }
        await this.submitNormally(request, origin, options);
      });
    this.watcherSubmissions.set(key, submission);
    try {
      await submission;
    } finally {
      if (this.watcherSubmissions.get(key) === submission)
        this.watcherSubmissions.delete(key);
    }
  }

  private async submitNormally(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    options: ChatQueueDispatchOptions,
  ): Promise<void> {
    if (
      request.agentSent ||
      request.agentSenderProvenance ||
      request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(request);
    const entry = this.getOrCreateEntry(request);
    if (
      request.agentSendSetup &&
      (await agentSendTargetReadiness(request)) === 'pending'
    ) {
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
      });
      this.scheduleDrain(request, entry, 1000);
      return;
    }
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(request);
    if (hasTrackedWatcherDelivery(entry, request)) return;
    const providerTurnActive = this.dependencies.hasActiveProviderTurn(request);
    const providerContinuationPending =
      this.dependencies.hasPendingProviderContinuation(request);
    // Codex can be interrupted without its terminal event reaching the
    // renderer/host queue. In that split-brain state the composer still sends
    // through the streaming queue path, but the provider session is already
    // idle. Treat that send like the user's existing "Interrupt" action:
    // settle the stale visible turn, clear the stale queue gate, and dispatch
    // the original message immediately with a host-emitted user prompt.
    if (
      request.recoverInterruptedCodexTurn === true &&
      request.executionHarness === 'codex' &&
      !providerTurnActive &&
      !providerContinuationPending &&
      !entry.dispatchInFlight &&
      !entry.recoveryInFlight
    ) {
      // Reserve recovery before the durable enqueue yields. Otherwise a drain
      // armed by the settled turn can dispatch this row during the await, and
      // recovery would then cancel that fresh dispatch and complete its new
      // turn timer as the "interrupted" turn.
      entry.recoveryInFlight = true;
      try {
        await this.enqueueDurably(request, entry, {
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
          ...options,
        });
      } catch (error) {
        entry.recoveryInFlight = false;
        // A drain skipped while recovery was reserved must still run.
        if (!entry.turnActive) this.scheduleDrain(request, entry, 0);
        throw error;
      }
      await this.recoverInterruptedCodexTurn(request, entry);
      await this.drain(request, entry);
      return;
    }
    // Provider sessions can resume without a new Canopy send (for example,
    // when Claude reports a completed background task). In that case the
    // session manager has already raised its active-turn state, but this
    // queue's gate is still idle because it did not dispatch the continuation.
    // Synchronize before deciding whether to dispatch so a renderer send made
    // during that continuation remains a visible host-owned queue row instead
    // of disappearing into the provider SDK's private pending-message queue.
    if (
      !entry.turnActive &&
      (providerTurnActive || providerContinuationPending)
    ) {
      entry.turnActive = true;
      delete entry.activeTurnUserMessageId;
      entry.activePluginSelections =
        this.dependencies.getActiveProviderPluginSelections?.(request);
      entry.activeGlobalPluginDefaultsRevision =
        this.dependencies.getActiveProviderPluginDefaultsRevision?.(request);
    }
    const heldFirst =
      entry.worktreeSetupHold?.firstUserMessageId !== undefined &&
      entry.worktreeSetupHold.firstUserMessageId === request.userMessageId;
    if (heldFirst) {
      delete entry.worktreeSetupHold;
      if (entry.activeTurnUserMessageId === request.userMessageId) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
      }
      if (
        entry.authenticationPause ||
        entry.turnActive ||
        entry.dispatchInFlight ||
        entry.recoveryInFlight
      ) {
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          true,
        );
        if (
          !entry.turnActive &&
          !entry.dispatchInFlight &&
          !entry.recoveryInFlight
        )
          this.scheduleDrain(request, entry, 0);
        return;
      }
      await this.dispatch(request, origin, entry, false, options);
      return;
    }
    if (
      entry.authenticationPause ||
      entry.worktreeSetupHold !== undefined ||
      entry.turnActive ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.queue.length > 0
    ) {
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
        ...options,
      });
      // A restored row can leave the host queue non-empty while every runtime
      // gate is idle (for example after an auth-preflight refusal). A new send
      // is the user's explicit retry trigger: preserve FIFO by enqueueing it,
      // then restart the drain rather than leaving both rows stranded.
      if (
        !entry.turnActive &&
        !entry.dispatchInFlight &&
        !entry.recoveryInFlight &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(request, entry, 0);
      }
      return;
    }
    await this.dispatch(request, origin, entry, false, options);
  }

  public async pauseForAuthentication(
    target: ChatQueueTarget,
    attemptId: string,
  ): Promise<void> {
    const entry = this.getOrCreateEntry(target);
    if (entry.authenticationPause === attemptId) return;
    entry.authenticationPause = attemptId;
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    const persistence = this.broadcast(target, entry);
    if (persistence) await persistence;
  }

  /** Release only the matching attempt. Its resumed turn will drain follow-ups. */
  public releaseAuthenticationPause(
    target: ChatQueueTarget,
    attemptId: string,
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (entry?.authenticationPause === attemptId) {
      delete entry.authenticationPause;
      this.broadcastBestEffort(target, entry);
    }
  }

  /** Manual Stop retires even a pause restored without an in-memory attempt. */
  public releaseAuthenticationPauseForStop(
    target: ChatQueueTarget,
  ): string | undefined {
    const entry = this.entries.get(chatQueueKey(target));
    const attemptId = entry?.authenticationPause;
    if (!entry || !attemptId) return undefined;
    delete entry.authenticationPause;
    this.broadcastBestEffort(target, entry);
    return attemptId;
  }

  /**
   * Holds the chat's sends while its worktree's Git setup runs: a send queues
   * instead of dispatching, and nothing drains, not even after a Stop, until
   * the hold is released. `turnUserMessageId`, the turn the setup holds,
   * owns the gate as the chat's active turn meanwhile.
   */
  public holdForWorktreeSetup(
    target: ChatQueueTarget,
    turnUserMessageId?: string,
  ): void {
    const entry = this.getOrCreateEntry(target);
    entry.worktreeSetupHold = {
      ...(entry.worktreeSetupHold?.turnUserMessageId !== undefined
        ? { turnUserMessageId: entry.worktreeSetupHold.turnUserMessageId }
        : {}),
      ...(turnUserMessageId !== undefined ? { turnUserMessageId } : {}),
    };
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    if (turnUserMessageId !== undefined && !entry.turnActive) {
      entry.turnActive = true;
      entry.activeTurnUserMessageId = turnUserMessageId;
      this.broadcastBestEffort(target, entry);
    }
  }

  /**
   * Releases the setup hold. With `firstUserMessageId`, the turn the setup
   * held, only that send may dispatch, ahead of the sends queued behind it;
   * the hold lifts when it is submitted. Otherwise the queue drains as usual.
   */
  public releaseWorktreeSetupHold(
    target: ChatQueueTarget,
    options: { firstUserMessageId?: string } = {},
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    const hold = entry?.worktreeSetupHold;
    if (!entry || !hold) return;
    if (options.firstUserMessageId !== undefined) {
      entry.worktreeSetupHold = {
        ...hold,
        firstUserMessageId: options.firstUserMessageId,
      };
      return;
    }
    delete entry.worktreeSetupHold;
    if (
      hold.turnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId === hold.turnUserMessageId &&
      !entry.dispatchInFlight
    ) {
      entry.turnActive = false;
      delete entry.activeTurnUserMessageId;
      this.broadcastBestEffort(target, entry);
    }
    if (
      !entry.turnActive &&
      !entry.dispatchInFlight &&
      !entry.recoveryInFlight &&
      entry.queue.length > 0
    )
      this.scheduleDrain(target, entry, 0);
  }

  /**
   * Removes the sends queued behind a worktree setup that ended `outcome`,
   * in order, so their turns end that way without running. The commit that
   * removes them records their ends; if it fails they stay queued.
   */
  public async takeWorktreeSetupHeldSends(
    target: ChatQueueTarget,
    outcome: 'cancelled' | 'failed',
  ): Promise<ChatSendMessageRequest[]> {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry?.worktreeSetupHold || entry.queue.length === 0) return [];
    const taken = entry.queue.splice(0);
    const requests = taken.map((message) => message.request);
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'end-setup-held',
        requests,
        outcome,
      });
      if (persistence) await persistence;
    } catch (error) {
      entry.queue.unshift(...taken);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    return requests;
  }

  public onTurnTerminal(
    target: ChatQueueTarget,
    status: ChatQueueTerminalStatus,
    turnUserMessageId?: string,
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    // A terminal notification tagged with a superseded turn's id must not
    // release the gate: after a cancel-release already drained the next
    // message, the old turn's late provider terminal would otherwise clear
    // turnActive mid-turn and overlap dispatches. Untagged releases (IPC
    // cancel/destroy paths) are deliberate and always accepted.
    if (
      turnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== turnUserMessageId
    ) {
      return;
    }
    if (turnUserMessageId === undefined) {
      entry.untaggedTerminals = (entry.untaggedTerminals ?? 0) + 1;
    }
    entry.turnActive = false;
    delete entry.activeTurnUserMessageId;
    this.broadcastBestEffort(target, entry);
    this.scheduleDrain(target, entry, status === 'complete' ? 0 : 500);
  }

  /**
   * Reacquire the host queue gate when provider output revives a turn that
   * had just emitted a terminal event. Returns false when another turn has
   * already acquired the gate, so stale continuation output can be dropped.
   */
  public onTurnRevived(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): boolean {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return true;
    if (
      entry.turnActive &&
      entry.activeTurnUserMessageId !== undefined &&
      entry.activeTurnUserMessageId !== turnUserMessageId
    ) {
      return false;
    }
    this.confirmTurnRevived(target, turnUserMessageId);
    return true;
  }

  /**
   * Apply a turn-root acceptance that was already arbitrated by the provider
   * event router. This is deliberately not a second ownership decision: it
   * makes the accepted stamp durable against an old root's concurrent terminal
   * release while rejected stamps never call this path.
   */
  public confirmTurnRevived(
    target: ChatQueueTarget,
    turnUserMessageId: string,
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    if (entry.drainTimer) {
      clearTimeout(entry.drainTimer);
      delete entry.drainTimer;
    }
    entry.turnActive = true;
    entry.activeTurnUserMessageId = turnUserMessageId;
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(target);
    entry.activePluginSelections =
      this.dependencies.getActiveProviderPluginSelections?.(target) ??
      entry.activePluginSelections;
    entry.activeGlobalPluginDefaultsRevision =
      this.dependencies.getActiveProviderPluginDefaultsRevision?.(target) ??
      entry.activeGlobalPluginDefaultsRevision;
    this.broadcastBestEffort(target, entry);
  }

  public async edit(
    request: ChatQueueEditRequest,
    commandResult?: ChatQueueCommandResult,
    attachmentMode: 'replace' | 'preserve' = 'replace',
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(request));
    const message = entry?.queue.find(
      (candidate) => candidate.id === request.entryId,
    );
    if (!entry || !message) {
      // Existing-channel terminal-local edits are canonical input policy, not IPC policy.
      const { getChatStateService } = await import('./chat-state-service');
      return getChatStateService().editRetainedTerminalAgentInput(request);
    }
    if (entry.recoveryInFlight) return 'busy';
    const previousRequest = message.request;
    const previousWatcherParts = message.watcherParts;
    const previousWatcherConsolidationBoundary =
      message.watcherConsolidationBoundary;
    const restoredAsyncQuestionId = message.request.asyncQuestionId;
    const { asyncQuestionId: _asyncQuestionId, ...editableRequest } =
      message.request;
    void _asyncQuestionId;
    message.request = {
      ...editableRequest,
      text: request.text,
      ...(attachmentMode === 'replace'
        ? {
            fileReferences: request.fileReferences,
            attachmentPaths: request.attachmentPaths,
            attachmentPromptContexts: request.attachmentPromptContexts,
          }
        : {}),
      ...(request.inputMode ? { inputMode: request.inputMode } : {}),
    };
    delete message.watcherParts;
    message.watcherConsolidationBoundary = true;
    delete message.editLocked;
    try {
      const persistence = this.broadcast(request, entry, {
        type: 'edit',
        request: message.request,
        ...(restoredAsyncQuestionId ? { restoredAsyncQuestionId } : {}),
        ...(commandResult ? { commandResult } : {}),
      });
      if (persistence) await persistence;
    } catch (error) {
      message.request = previousRequest;
      if (previousWatcherParts) message.watcherParts = previousWatcherParts;
      else delete message.watcherParts;
      if (previousWatcherConsolidationBoundary) {
        message.watcherConsolidationBoundary = true;
      } else {
        delete message.watcherConsolidationBoundary;
      }
      this.broadcastBestEffort(request, entry);
      throw error;
    }
    if (!entry.turnActive && entry.queue[0]?.id === message.id) {
      void this.drain(request, entry);
    }
    return 'applied';
  }

  public async cancel(
    target: ChatQueueTarget,
    entryId: string,
    commandResult?: ChatQueueCommandResult,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const index =
      entry?.queue.findIndex((message) => message.id === entryId) ?? -1;
    if (!entry || index < 0) {
      const { getChatStateService } = await import('./chat-state-service');
      return getChatStateService().cancelRetainedTerminalAgentInput(
        target,
        entryId,
      );
    }
    if (entry.recoveryInFlight) return 'busy';
    const [message] = entry.queue.splice(index, 1);
    if (!message) return 'not_found';
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'cancel',
        request: message.request,
        ...(commandResult ? { commandResult } : {}),
      });
      if (persistence) await persistence;
    } catch (error) {
      entry.queue.splice(index, 0, message);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    this.releaseWatcherAuthority(message.request);
    if (!entry.turnActive) void this.drain(target, entry);
    return 'applied';
  }

  public async force(
    target: ChatQueueTarget,
    entryId: string,
    commandResult?: ChatQueueCommandResult,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return 'not_found';
    const message = entry.queue.find((candidate) => candidate.id === entryId);
    if (!message) return 'not_found';
    if (
      message.request.agentSent ||
      message.request.agentSenderProvenance ||
      message.request.hiddenContext?.kind === 'agent-sender-context'
    )
      await revalidateAgentSenderRequest(message.request);
    if (
      message.request.agentSendSetup &&
      (await agentSendTargetReadiness(message.request)) === 'pending'
    )
      return 'busy';
    // A terminal notification can release turnActive before the provider
    // dispatch promise finishes unwinding. Leave the queued row intact until
    // the existing completion path can drain it instead of overlapping a
    // second dispatch (or a recovery operation) for the same chat.
    if (entry.dispatchInFlight || entry.recoveryInFlight) return 'busy';
    // The awaits above can let a cancel or edit remove the row; never cancel
    // the active turn for a forced row that no longer exists.
    if (!entry.queue.includes(message)) return 'not_found';
    const epoch = entry.operationEpoch ?? 0;
    entry.recoveryInFlight = true;
    try {
      // Cancel the active turn BEFORE removing the row: if cancel rejects, the
      // queued message stays intact and the turn gate is untouched, instead of
      // the row being lost and turnActive wedged true forever.
      if (entry.turnActive) {
        const interruptedTurnUserMessageId = entry.activeTurnUserMessageId;
        await this.dependencies.cancel(target);
        if ((entry.operationEpoch ?? 0) !== epoch) return 'busy';
        try {
          await this.dependencies.settleCancelledTurn(
            target,
            interruptedTurnUserMessageId,
          );
        } catch (error) {
          // UI settlement is best-effort. Once provider cancellation succeeds,
          // a renderer notification failure must not wedge the host queue gate.
          logMainProcessWarn(
            '[chat-queue] Failed to settle cancelled turn before forced dispatch:',
            error,
          );
        }
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
      }
      // Re-resolve after the await — a concurrent cancel/edit may have mutated
      // the queue while the turn cancellation was in flight.
      const index = entry.queue.findIndex(
        (candidate) => candidate.id === entryId,
      );
      if (index < 0) {
        // The row was removed concurrently; still drain the head we just freed.
        this.scheduleDrain(target, entry, 0);
        return 'not_found';
      }
      entry.queue.splice(index, 1);
      entry.recoveryInFlight = false;
      await this.dispatchDequeued(
        message,
        entry,
        (): void => {
          entry.queue.splice(Math.min(index, entry.queue.length), 0, message);
        },
        {
          type: 'force',
          request: message.request,
          ...(commandResult ? { commandResult } : {}),
        },
      );
      return 'applied';
    } finally {
      entry.recoveryInFlight = false;
      if (!entry.turnActive) this.scheduleDrain(target, entry, 500);
    }
  }

  public invalidatePendingInputOperations(target: ChatQueueTarget): void {
    const entry = this.getOrCreateEntry(target);
    entry.operationEpoch = (entry.operationEpoch ?? 0) + 1;
  }

  public releaseInputOwnership(target: ChatQueueTarget): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (
      entry?.turnActive === true &&
      entry.activeTurnUserMessageId === undefined &&
      !entry.dispatchInFlight &&
      !entry.recoveryInFlight &&
      !this.dependencies.hasActiveProviderTurn(target) &&
      !this.dependencies.hasPendingProviderContinuation(target)
    ) {
      entry.turnActive = false;
      this.broadcastBestEffort(target, entry);
    }
    if (
      !entry ||
      entry.turnActive ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      entry.authenticationPause !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      entry.queue.length === 0 ||
      entry.drainTimer
    ) {
      return;
    }
    this.scheduleDrain(target, entry, 0);
  }

  public async steer(
    target: ChatQueueTarget,
    entryId: string,
    receipt: ChatQueueCommandResult,
  ): Promise<ChatQueueMutationResult> {
    const entry = this.entries.get(chatQueueKey(target));
    const index =
      entry?.queue.findIndex((message) => message.id === entryId) ?? -1;
    if (!entry || index < 0) return 'not_found';
    const message = entry.queue[index];
    if (!canSteerQueuedMessage(entry, message)) return 'busy';
    if (
      message.request.agentSendSetup &&
      (await agentSendTargetReadiness(message.request)) === 'pending'
    )
      return 'busy';
    await revalidateAgentSenderRequest(message.request);
    if (receipt.agentSteeringActor)
      await revalidateAgentSteeringActor(
        receipt.agentSteeringActor,
        target.projectId,
      );
    // The awaits above let a cancel or drain move rows; re-find by identity.
    const current = entry.queue.indexOf(message);
    if (this.entries.get(chatQueueKey(target)) !== entry || current < 0)
      return 'not_found';
    if (!canSteerQueuedMessage(entry, message)) return 'busy';
    entry.recoveryInFlight = true;
    entry.queue.splice(current, 1);
    let claimed = false;
    try {
      // Lazy by design: chat-state constructs and calls this queue singleton,
      // so a static reverse import would create an initialization cycle. The
      // packaged Electron main build exercises this local import path.
      const { getChatStateService } = await import('./chat-state-service');
      await getChatStateService().inputDelivery.steerQueued(
        message.request,
        () => entry.queue.map((r) => r.id),
        { ...receipt, outcome: 'applied', entityId: target.chatId },
        () => {
          claimed = true;
          // Durable ownership has moved to input delivery. Release the queue
          // operation before provider submission so a proven rejection can
          // restore this same row as ordinary queued input.
          entry.recoveryInFlight = false;
          this.broadcastBestEffort(target, entry);
        },
        message.origin,
      );
      return 'applied';
    } catch (error) {
      if (!claimed) entry.queue.splice(current, 0, message);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.broadcastBestEffort(target, entry);
      if (!entry.turnActive) this.scheduleDrain(target, entry, 0);
    }
  }

  public async restoreWithdrawnInput(
    request: ChatSendMessageRequest,
    rowId: string,
    receipt: ChatQueueCommandResult | undefined,
    epoch: number,
    origin: ChatQueueOrigin = 'desktop',
  ): Promise<void> {
    const restorationKey = `${chatQueueKey(request)}:${rowId}:${receipt?.commandId ?? ''}`;
    const existing = this.inputRestorations.get(restorationKey);
    if (existing) {
      await existing;
      return;
    }
    const restoration = this.restoreWithdrawnInputOnce(
      request,
      rowId,
      receipt,
      epoch,
      origin,
    );
    this.inputRestorations.set(restorationKey, restoration);
    try {
      await restoration;
    } finally {
      if (this.inputRestorations.get(restorationKey) === restoration) {
        this.inputRestorations.delete(restorationKey);
      }
    }
  }

  public async consumeRestoredInput(
    target: ChatQueueTarget,
    rowId: string,
  ): Promise<void> {
    const restorationPrefix = `${chatQueueKey(target)}:${rowId}:`;
    const matchingRestorations = Array.from(this.inputRestorations.entries())
      .filter(([key]) => key.startsWith(restorationPrefix))
      .map(([, restoration]) => restoration);
    await Promise.all(matchingRestorations);

    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    const index = entry.queue.findIndex((message) => message.id === rowId);
    if (index < 0) {
      entry.persistedInputIds.delete(rowId);
      return;
    }
    if (entry.recoveryInFlight || entry.dispatchInFlight) {
      throw new Error('Another message operation is in progress');
    }
    const [message] = entry.queue.splice(index, 1);
    if (!message) return;
    entry.recoveryInFlight = true;
    try {
      const persistence = this.broadcast(target, entry, {
        type: 'consume-restored-input',
        request: message.request,
      });
      if (persistence) await persistence;
      entry.persistedInputIds.delete(rowId);
      this.releaseWatcherAuthority(message.request);
    } catch (error) {
      entry.queue.splice(index, 0, message);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      this.broadcastBestEffort(target, entry);
    }
  }

  private async restoreWithdrawnInputOnce(
    request: ChatSendMessageRequest,
    rowId: string,
    receipt: ChatQueueCommandResult | undefined,
    epoch: number,
    origin: ChatQueueOrigin,
  ): Promise<void> {
    const entry = this.getOrCreateEntry(request);
    if (entry.frozenForDeletion) throw new Error('Chat is closing');
    if (entry.queue.some((message) => message.id === rowId)) return;
    if (entry.recoveryInFlight || entry.dispatchInFlight)
      throw new Error('Another message operation is in progress');
    entry.recoveryInFlight = true;
    const message: HostQueuedMessage = {
      id: rowId,
      request,
      origin,
      enqueuedAtMs: this.dependencies.now(),
    };
    entry.queue.push(message);
    try {
      if (request.watcherFired && request.watcherDeliveryId) {
        const check = await this.dependencies.checkWatcherIngress?.(request);
        if (check && !check.allowed) {
          message.watcherDeliveryHeld = {
            outcome: check.outcome,
            reason: check.reason,
          };
        }
      }
      await this.broadcast(request, entry, {
        type: 'restore-input',
        rowId,
        request,
        epoch,
        ...(receipt ? { commandResult: receipt } : {}),
      });
    } catch (error) {
      entry.queue = entry.queue.filter((r) => r !== message);
      throw error;
    } finally {
      entry.recoveryInFlight = false;
      if (this.entries.get(chatQueueKey(request)) === entry) {
        this.broadcastBestEffort(request, entry, false);
      }
    }
    entry.persistedInputIds.add(rowId);
    this.armHeldWatcherRetry(request, entry);
    if (!entry.turnActive) this.scheduleDrain(request, entry, 0);
  }

  public hydratePersistedInput(
    request: ChatSendMessageRequest,
    rowId: string,
    origin: ChatQueueOrigin,
    enqueuedAtMs: number,
    authenticationAttemptId?: string,
    requiredAccountProxyConnectionId?: string,
  ): void {
    assertValidQueueDispatchOptions({ requiredAccountProxyConnectionId });
    const entry = this.getOrCreateEntry(request);
    if (authenticationAttemptId)
      entry.authenticationPause = authenticationAttemptId;
    if (
      entry.persistedInputIds.has(rowId) ||
      entry.queue.some((message) => message.id === rowId)
    )
      return;
    entry.persistedInputIds.add(rowId);
    entry.queue.push({
      id: rowId,
      request,
      origin,
      enqueuedAtMs,
      ...(requiredAccountProxyConnectionId !== undefined
        ? { requiredAccountProxyConnectionId }
        : {}),
    });
  }

  public async setEditLock(
    target: ChatQueueTarget,
    entryId: string,
    locked: boolean,
    acquisitionId?: string,
  ): Promise<void> {
    const entry = this.entries.get(chatQueueKey(target));
    const message = entry?.queue.find((candidate) => candidate.id === entryId);
    if (!entry || !message) {
      if (locked)
        throw new Error('This message is no longer available to edit.');
      return;
    }
    if (
      !locked &&
      acquisitionId !== undefined &&
      this.editLockOwners.get(message) !== acquisitionId
    )
      return;
    if (entry.recoveryInFlight)
      throw new Error('Another message operation is in progress');
    if (locked && message.editLocked)
      throw new Error('This message is no longer available to edit.');
    const attempt = Symbol(entryId);
    if (locked && acquisitionId !== undefined)
      this.editLockOwners.set(message, acquisitionId);
    else this.editLockOwners.delete(message);
    if (locked) this.editLockAttempts.set(message, attempt);
    else this.editLockAttempts.delete(message);
    let undoConsolidation: (() => void) | undefined;
    if (locked) message.editLocked = true;
    else {
      delete message.editLocked;
      undoConsolidation = this.consolidateNextWatcherRow(entry, message);
    }
    try {
      const persistence = this.broadcast(target, entry);
      if (persistence) await persistence;
    } catch (error) {
      if (locked && this.editLockAttempts.get(message) === attempt) {
        this.editLockAttempts.delete(message);
        this.editLockOwners.delete(message);
        delete message.editLocked;
        // A drain that ran while this lock was pending skipped the head.
        if (
          this.entries.get(chatQueueKey(target)) === entry &&
          !entry.turnActive &&
          entry.queue[0] === message
        )
          this.scheduleDrain(target, entry, 0);
      }
      undoConsolidation?.();
      this.broadcastBestEffort(target, entry);
      throw error;
    }
    // Persistence can finish after removal, an edit, or cancellation. A
    // successful acquisition must still refer to a live, locked queue row.
    if (
      locked &&
      (this.entries.get(chatQueueKey(target)) !== entry ||
        this.editLockAttempts.get(message) !== attempt ||
        !entry.queue.some(
          (candidate) => candidate.id === entryId && candidate.editLocked,
        ))
    ) {
      throw new Error('This message is no longer available to edit.');
    }
    if (!locked && !entry.turnActive && entry.queue[0]?.id === message.id) {
      await this.drain(target, entry);
    }
  }

  private consolidateNextWatcherRow(
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
  ): (() => void) | undefined {
    const index = entry.queue.indexOf(message);
    const next = index >= 0 ? entry.queue[index + 1] : undefined;
    if (
      !next ||
      message.request.watcherDeliveryId !== undefined ||
      next.request.watcherDeliveryId !== undefined ||
      message.watcherConsolidationBoundary === true ||
      next.editLocked === true ||
      next.watcherConsolidationBoundary === true
    ) {
      return undefined;
    }
    const currentPart = watcherPartFromRequest(message.request);
    const nextPart = watcherPartFromRequest(next.request);
    const currentParts =
      message.watcherParts ?? (currentPart ? [currentPart] : undefined);
    const nextParts = next.watcherParts ?? (nextPart ? [nextPart] : undefined);
    if (
      !currentParts ||
      !nextParts ||
      Boolean(message.request.planMode) !== Boolean(next.request.planMode)
    ) {
      return undefined;
    }

    const previousRequest = message.request;
    const previousParts = message.watcherParts;
    const combinedParts = [...currentParts, ...nextParts];
    message.watcherParts = combinedParts;
    message.request = combinedWatcherRequest(message.request, combinedParts);
    entry.queue.splice(index + 1, 1);
    return (): void => {
      message.request = previousRequest;
      if (previousParts) message.watcherParts = previousParts;
      else delete message.watcherParts;
      entry.queue.splice(Math.min(index + 1, entry.queue.length), 0, next);
    };
  }

  /**
   * Keep host-owned queued sends aligned with a capability update. The
   * in-flight turn retains its immutable snapshot, while every prompt that
   * has not dispatched yet must use the newly approved selections.
   */
  public updateQueuedPluginSelections(
    target: ChatQueueTarget,
    pluginSelections: ChatSendMessageRequest['pluginSelections'],
    deferredToolsAllowed: ChatSendMessageRequest['deferredToolsAllowed'],
  ): void {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return;
    entry.queue = entry.queue.map((message) => ({
      ...message,
      request: {
        ...message.request,
        pluginSelections,
        ...(typeof deferredToolsAllowed === 'boolean'
          ? { deferredToolsAllowed }
          : {}),
      },
    }));
    this.broadcastBestEffort(target, entry);
  }

  public beginWorktreeDeletion(
    projectId: string,
    worktreeId: string,
  ): ChatQueueWorktreeDeletion {
    const prefix = `${projectId}/${worktreeId}/`;
    const frozen: Array<{
      key: string;
      chatId: string;
      entry: ChatQueueEntry;
    }> = [];
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      entry.frozenForDeletion = true;
      this.resetHeldWatcherRetry(entry);
      if (entry.drainTimer) {
        clearTimeout(entry.drainTimer);
        delete entry.drainTimer;
      }
      frozen.push({ key, chatId: key.slice(prefix.length), entry });
    });

    let settled = false;
    return {
      commit: (): void => {
        if (settled) return;
        settled = true;
        for (const { key, chatId, entry } of frozen) {
          if (this.entries.get(key) !== entry) continue;
          delete entry.frozenForDeletion;
          entry.discardedForDeletion = true;
          for (const message of entry.queue)
            this.releaseWatcherAuthority(message.request);
          const discarded = entry.queue.map((message) => message.request);
          entry.queue = [];
          this.entries.delete(key);
          if (discarded.length > 0) {
            void this.dependencies
              .endDiscardedTurns?.({ projectId, worktreeId, chatId }, discarded)
              .catch((error: unknown) => {
                logMainProcessWarn(
                  '[chat-queue] Could not end the turns of discarded queued sends:',
                  error,
                );
              });
          }
        }
      },
      rollback: (options?: ChatQueueWorktreeDeletionRollbackOptions): void => {
        if (settled) return;
        settled = true;
        for (const { key, chatId, entry } of frozen) {
          if (this.entries.get(key) !== entry) continue;
          delete entry.frozenForDeletion;
          if (options?.sessionsDestroyed === true) {
            entry.turnActive = false;
            delete entry.activeTurnUserMessageId;
          }
          const target = { projectId, worktreeId, chatId };
          this.armHeldWatcherRetry(target, entry);
          this.broadcastBestEffort(target, entry);
          if (
            !entry.turnActive &&
            !entry.dispatchInFlight &&
            !entry.recoveryInFlight &&
            entry.queue.length > 0
          ) {
            this.scheduleDrain(target, entry, 0);
          }
        }
      },
    };
  }

  /** Test-only: drop all per-chat state and pending drain timers. */
  public resetForTests(): void {
    this.entries.forEach((entry) => {
      if (entry.drainTimer) clearTimeout(entry.drainTimer);
      this.resetHeldWatcherRetry(entry);
    });
    this.entries.clear();
    this.activeInputHydrations.clear();
    this.inputRestorations.clear();
  }

  /** Whether this message is the chat's dispatching turn or a queued row. */
  public holdsUserMessage(
    target: ChatQueueTarget,
    userMessageId: string,
  ): boolean {
    const entry = this.entries.get(chatQueueKey(target));
    if (!entry) return false;
    return (
      entry.activeTurnUserMessageId === userMessageId ||
      entry.queue.some(
        (message) => message.request.userMessageId === userMessageId,
      )
    );
  }

  /** The queued send the chat is handing to its provider, if any. */
  public dispatchingUserMessageId(target: ChatQueueTarget): string | undefined {
    const entry = this.entries.get(chatQueueKey(target));
    return entry?.dispatchInFlight ? entry.activeTurnUserMessageId : undefined;
  }

  /**
   * The user message id of the turn the chat is running: set when that turn
   * is dispatched, so a message queued behind it never changes it.
   */
  public runningTurnUserMessageId(target: ChatQueueTarget): string | undefined {
    return this.entries.get(chatQueueKey(target))?.activeTurnUserMessageId;
  }

  public isTurnActive(target: ChatQueueTarget): boolean {
    return this.entries.get(chatQueueKey(target))?.turnActive === true;
  }

  /** Host-owned automatic messages can be withdrawn before native dispatch. */
  public async cancelUserMessages(
    target: ChatQueueTarget,
    userMessageIds: readonly string[],
  ): Promise<void> {
    const ids = new Set(userMessageIds);
    const entry = this.entries.get(chatQueueKey(target));
    const matches =
      entry?.queue.filter((message) =>
        ids.has(message.request.userMessageId),
      ) ?? [];
    for (const message of matches) await this.cancel(target, message.id);
  }

  /** Withdraw one queued send before it starts, reporting the queue's result. */
  public async withdrawQueuedUserMessage(
    target: ChatQueueTarget,
    userMessageId: string,
  ): Promise<ChatQueueMutationResult> {
    const queued = this.entries
      .get(chatQueueKey(target))
      ?.queue.find(
        (message) => message.request.userMessageId === userMessageId,
      );
    return queued ? this.cancel(target, queued.id) : 'not_found';
  }

  public broadcastWorktree(projectId: string, worktreeId: string): void {
    const prefix = `${projectId}/${worktreeId}/`;
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      const chatId = key.slice(prefix.length);
      this.broadcastBestEffort({ projectId, worktreeId, chatId }, entry);
    });
  }

  /**
   * Race-free pull of the current queue snapshots for a worktree's chats.
   * The renderer requests this during hydration (request/response), so a
   * reloaded renderer recovers the live queue even though the push-based
   * `chatQueueUpdated` broadcast can fire before its listener is attached.
   */
  public getWorktreeSnapshots(
    projectId: string,
    worktreeId: string,
  ): ChatQueueUpdatedEvent[] {
    const prefix = `${projectId}/${worktreeId}/`;
    const snapshots: ChatQueueUpdatedEvent[] = [];
    this.entries.forEach((entry, key) => {
      if (!key.startsWith(prefix)) return;
      if (entry.queue.length === 0) return;
      const chatId = key.slice(prefix.length);
      snapshots.push({
        projectId,
        worktreeId,
        chatId,
        queue: entry.queue
          .filter((message) => !message.request.managedDelegationDeliveryId)
          .map((message) => queuedMessageView(message, entry)),
      });
    });
    return snapshots;
  }

  private getOrCreateEntry(target: ChatQueueTarget): ChatQueueEntry {
    const key = chatQueueKey(target);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: ChatQueueEntry = {
      queue: [],
      persistedInputIds: new Set(),
      turnActive: false,
      dispatchInFlight: false,
      recoveryInFlight: false,
      currentGlobalPluginDefaultsRevision:
        this.dependencies.getCurrentPluginDefaultsRevision?.(target),
    };
    this.entries.set(key, entry);
    return entry;
  }

  private async drain(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
  ): Promise<void> {
    if (
      entry.authenticationPause !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      entry.queue.length === 0 ||
      entry.turnActive ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight
    )
      return;
    // Provider I/O can already be idle while its pickup/result events are
    // awaiting the durable reducer. Preserve that route until ingress settles.
    try {
      await this.dependencies.drainProviderEvents?.(target);
      if (this.entries.get(chatQueueKey(target)) !== entry) return;
    } catch (error) {
      logMainProcessWarn(
        '[chat-queue] Could not settle provider events before dispatch:',
        error,
      );
      return;
    }
    if (
      entry.authenticationPause !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true ||
      entry.turnActive ||
      entry.dispatchInFlight ||
      entry.recoveryInFlight ||
      this.dependencies.hasActiveProviderTurn(target)
    ) {
      return;
    }
    const index = entry.queue.findIndex(
      (message) => !message.watcherDeliveryHeld,
    );
    const message = entry.queue[index];
    if (!message) {
      this.broadcastBestEffort(target, entry);
      return;
    }
    if (message.request.agentSendSetup) {
      try {
        await revalidateAgentSenderRequest(message.request);
        if ((await agentSendTargetReadiness(message.request)) === 'pending') {
          this.scheduleDrain(target, entry, 1000);
          return;
        }
      } catch {
        /* Dequeue persists typed cancellation for unavailable targets. */
      }
      if (
        entry.turnActive ||
        entry.dispatchInFlight ||
        entry.recoveryInFlight ||
        entry.queue[index] !== message
      )
        return;
    }
    if (message.editLocked) return;
    entry.queue.splice(index, 1);
    try {
      await this.dispatchDequeued(message, entry, (): void => {
        entry.queue.splice(index, 0, message);
      });
    } catch {
      // Dispatch failures already reset turnActive in dispatchDequeued();
      // swallow so
      // the fire-and-forget drain callers never produce an unhandled
      // rejection. The renderer's legacy flush behaved the same way.
    }
  }

  /**
   * Atomically move a host-owned queued row into the active-turn state before
   * provider dispatch. If canonical persistence rejects, restore the row so a
   * transient journal failure cannot silently discard an undispatched prompt.
   */
  private async dispatchDequeued(
    message: HostQueuedMessage,
    entry: ChatQueueEntry,
    restore: () => void,
    mutation?: ChatQueuePersistenceMutation,
  ): Promise<void> {
    let providerDispatchStarted = false;
    // Set for known pre-provider refusals below, and read by `finally` so it
    // does not re-arm a drain the catch deliberately declined to schedule.
    let waitsForExternalRetryTrigger = false;
    entry.turnActive = true;
    entry.activeTurnUserMessageId = message.request.userMessageId;
    entry.currentGlobalPluginDefaultsRevision =
      this.dependencies.getCurrentPluginDefaultsRevision?.(message.request);
    entry.activePluginSelections = normalizePluginSelections(
      message.request.pluginSelections,
    );
    entry.activeGlobalPluginDefaultsRevision =
      entry.currentGlobalPluginDefaultsRevision;
    entry.dispatchInFlight = true;
    // Same Stop ownership as a direct send: it spans the durable dequeue.
    const preparation = this.dependencies.beginTurnPreparation?.(
      message.request,
    );
    try {
      if (message.request.watcherFired && message.request.watcherDeliveryId) {
        const check = await this.dependencies.checkWatcherIngress?.(
          message.request,
        );
        if (check && !check.allowed) {
          message.watcherDeliveryHeld = {
            outcome: check.outcome,
            reason: check.reason,
          };
          entry.turnActive = false;
          delete entry.activeTurnUserMessageId;
          restore();
          this.armHeldWatcherRetry(message.request, entry);
          await this.persistRestoredQueueUntilDurable(message.request, entry);
          return;
        }
        delete message.watcherDeliveryHeld;
      }
      // Persist queue removal and active-turn acquisition together. There must
      // never be a durable idle state in which the queued row is already gone.
      const persistence = this.broadcast(message.request, entry, mutation);
      if (persistence) await persistence;
      if (
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true
      ) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
        restore();
        // The row is already back in memory. A journal failure here must not
        // escape into the outer catch, whose pre-dispatch recovery would run
        // `restore()` a second time and duplicate the same queued prompt.
        this.broadcastBestEffort(message.request, entry);
        return;
      }
      if (entry.discardedForDeletion === true) {
        this.releaseWatcherAuthority(message.request);
        return;
      }
      if (
        message.request.agentSent ||
        message.request.agentSenderProvenance ||
        message.request.hiddenContext?.kind === 'agent-sender-context'
      )
        await revalidateAgentSenderRequest(message.request);
      if (message.request.watcherFired && message.request.watcherDeliveryId)
        await this.assertWatcherIngress(message.request);
      providerDispatchStarted = true;
      const dispatchOptions = {
        requiredAccountProxyConnectionId:
          message.requiredAccountProxyConnectionId,
      };
      if (message.request.agentSenderProvenance)
        await withAgentSenderAuthority(
          message.request,
          () =>
            this.dependencies.dispatch(
              message.request,
              message.origin,
              true,
              dispatchOptions,
            ),
          revalidateAgentSenderRequest,
        );
      else
        await this.dependencies.dispatch(
          message.request,
          message.origin,
          true,
          dispatchOptions,
        );
      this.watcherDispatchSucceeded(message.request, entry);
      const currentEntry = this.entries.get(chatQueueKey(message.request));
      if (
        preparation?.cancelled &&
        currentEntry === entry &&
        currentEntry.frozenForDeletion !== true &&
        currentEntry.discardedForDeletion !== true
      ) {
        // As with the initial send, acceptance can finish after Stop commits.
        await this.settleCancelledHandoffUntilDurable(
          message.request,
          entry,
          message.request.userMessageId,
        );
      }
    } catch (error) {
      entry.turnActive = false;
      delete entry.activeTurnUserMessageId;
      if (
        error instanceof WatcherDeliveryHeldError &&
        entry.discardedForDeletion !== true
      ) {
        message.watcherDeliveryHeld = {
          outcome: error.outcome,
          reason: error.reason,
        };
        restore();
        this.armHeldWatcherRetry(message.request, entry);
        await this.persistRestoredQueueUntilDurable(message.request, entry);
        return;
      }
      // The send-time auth preflight (CAN-1814) runs INSIDE
      // `dependencies.dispatch`, i.e. after `providerDispatchStarted` is
      // already true, so its refusal used to skip `restore()` entirely. The row
      // had been durably enqueued by `enqueueDurably` and was then durably
      // removed by the `broadcast(...)` above; `drain()`'s bare `catch {}`
      // swallowed the error and the user watched their typed follow-up vanish
      // with no card, no error, and no log (CAN-1814 review).
      //
      // The auth refusal and Auto model-application refusal are provably
      // PRE-dispatch: both run before `ensureChatForTrustedSend`, before the
      // user message is persisted, and before the session is created, so
      // nothing was sent and the row is safe to put back. They join
      // `isChatScopeDeletingError` for exactly that reason rather than widening
      // the flag itself —
      // `providerDispatchStarted` exists to stop a partially-sent prompt from
      // being re-sent, and it keeps that job for every other error.
      if (
        isAgentSenderContextError(error) &&
        entry.discardedForDeletion !== true
      ) {
        if (
          error.code === 'target_not_ready' &&
          message.request.agentSendSetup &&
          (await agentSendTargetReadiness(message.request).catch(
            () => 'ready',
          )) === 'pending'
        ) {
          restore();
          await this.persistRestoredQueueUntilDurable(message.request, entry);
          this.scheduleDrain(message.request, entry, 1000);
          return;
        }
        // Sender/target authorization refusals are permanent. Persist cancellation
        // before releasing the next row; never restore this row to the FIFO head.
        await this.persistRestoredQueueUntilDurable(message.request, entry, {
          type: 'cancel',
          request: message.request,
          agentSendRefusalCode:
            error.code === 'authorization_conflict'
              ? 'owner_boundary'
              : error.code,
          lastErrorMessage:
            'The agent that sent this message can no longer reach this chat.',
        });
        this.releaseWatcherAuthority(message.request);
        return;
      }
      const refusedByAuthPreflight = isTurnAuthPreflightRefusal(error);
      const autoModelApplyFailed = isAutoModelRoutingApplyError(error);
      const autoModelRoutingInProgress = isAutoModelRoutingInProgressError(
        error,
      )
        ? error
        : undefined;
      waitsForExternalRetryTrigger =
        refusedByAuthPreflight || autoModelApplyFailed;
      const shouldRestore =
        (!providerDispatchStarted ||
          waitsForExternalRetryTrigger ||
          autoModelRoutingInProgress !== undefined ||
          isChatScopeDeletingError(error)) &&
        entry.discardedForDeletion !== true;
      if (shouldRestore) {
        restore();
        logMainProcessWarn(
          refusedByAuthPreflight
            ? '[chat-queue] Retaining queued message refused by the authentication preflight:'
            : autoModelApplyFailed
              ? '[chat-queue] Retaining queued Auto message after its routed model could not be applied:'
              : autoModelRoutingInProgress
                ? '[chat-queue] Retaining queued Auto message while its routing decision is still in progress:'
                : '[chat-queue] Retaining queued message after dispatch failed before provider start:',
          error,
        );
      }
      if (!shouldRestore) this.releaseWatcherAuthority(message.request);
      if (entry.discardedForDeletion !== true) {
        const restorationPersisted = shouldRestore
          ? await this.persistRestoredQueueUntilDurable(message.request, entry)
          : false;
        if (!shouldRestore) {
          // The dropped row will never run; settle its agent acceptance row.
          if (message.request.agentSenderProvenance)
            await this.persistRestoredQueueUntilDurable(
              message.request,
              entry,
              {
                type: 'settle-agent-input',
                request: message.request,
                reason: error instanceof Error ? error.message : String(error),
              },
            );
          else this.broadcastBestEffort(message.request, entry);
        }
        // Authentication and model-application refusals wait for an external
        // trigger because an immediate redrain would repeat the same failure.
        // An active routing decision is different: the server supplies a
        // bounded retry delay and the same durable request ID replays safely.
        //
        // NOT on reconnect, despite the obvious guess. The OAuth settle
        // listener reaches the queue only via `resumeChatsAfterMcpOAuthSuccess`
        // -> `sendWorktreeChatMessage` -> `submit`, and that runs only for a
        // chat that has a `PendingAuthResume` — i.e. one whose turn this
        // failure actually stopped. A chat whose turn ended normally while the
        // credential lapsed keeps its refused row until the user acts. Visible
        // and user-actionable, so a stall rather than a loss (CAN-1814 review).
        if (restorationPersisted && !waitsForExternalRetryTrigger) {
          this.scheduleDrain(
            message.request,
            entry,
            autoModelRoutingInProgress
              ? autoModelRoutingInProgress.retryAfterMs
              : 500,
          );
        }
      }
      throw error;
    } finally {
      preparation?.finish();
      entry.dispatchInFlight = false;
      if (
        this.entries.get(chatQueueKey(message.request)) === entry &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true
      ) {
        this.broadcastBestEffort(message.request, entry, false);
      }
      if (
        !waitsForExternalRetryTrigger &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        !entry.turnActive &&
        !entry.recoveryInFlight &&
        entry.queue.some((message) => !message.watcherDeliveryHeld) &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(message.request, entry, 0);
      }
    }
  }

  private async settleCancelledHandoffUntilDurable(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    turnUserMessageId: string,
  ): Promise<void> {
    let retryDelayMs = QUEUE_PERSISTENCE_RETRY_MIN_MS;
    while (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true
    ) {
      try {
        await this.dependencies.settleCancelledTurn(target, turnUserMessageId);
        return;
      } catch (error) {
        logMainProcessWarn(
          '[chat-queue] Retrying stopped handoff settlement before next dispatch:',
          error,
        );
        await new Promise<void>((resolve) => {
          this.dependencies.schedule(resolve, retryDelayMs);
        });
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          QUEUE_PERSISTENCE_RETRY_MAX_MS,
        );
      }
    }
  }

  private async persistRestoredQueueUntilDurable(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    mutation?: ChatQueuePersistenceMutation,
  ): Promise<boolean> {
    let retryDelayMs = QUEUE_PERSISTENCE_RETRY_MIN_MS;
    while (
      this.entries.get(chatQueueKey(target)) === entry &&
      entry.frozenForDeletion !== true &&
      entry.discardedForDeletion !== true
    ) {
      try {
        const persistence = this.broadcast(target, entry, mutation);
        if (persistence) await persistence;
        return true;
      } catch (error) {
        logMainProcessWarn(
          '[chat-queue] Retrying durable queued-input settlement:',
          error,
        );
        await new Promise<void>((resolve) => {
          this.dependencies.schedule(resolve, retryDelayMs);
        });
        retryDelayMs = Math.min(
          retryDelayMs * 2,
          QUEUE_PERSISTENCE_RETRY_MAX_MS,
        );
      }
    }
    return false;
  }

  private scheduleDrain(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    delayMs: number,
  ): void {
    if (
      entry.authenticationPause !== undefined ||
      entry.worktreeSetupHold !== undefined ||
      entry.frozenForDeletion === true ||
      entry.discardedForDeletion === true
    ) {
      return;
    }
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    entry.drainTimer = this.dependencies.schedule((): void => {
      delete entry.drainTimer;
      if (
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true ||
        entry.discardedForDeletion === true
      ) {
        return;
      }
      void this.drain(target, entry);
    }, delayMs);
  }

  /** Recheck after durable writes and other awaited preparation, at handoff. */
  private async assertWatcherIngress(
    request: ChatSendMessageRequest,
  ): Promise<void> {
    if (!request.watcherFired || !request.watcherDeliveryId) return;
    const check = await this.dependencies.checkWatcherIngress?.(request);
    if (check && !check.allowed)
      throw new WatcherDeliveryHeldError(check.reason);
  }

  private async dispatch(
    request: ChatSendMessageRequest,
    origin: ChatQueueOrigin,
    entry: ChatQueueEntry,
    fromQueue: boolean,
    options: ChatQueueDispatchOptions = {},
  ): Promise<void> {
    if (entry.turnActive) {
      await this.enqueueDurably(request, entry, {
        id: this.dependencies.createId(),
        request,
        origin,
        enqueuedAtMs: this.dependencies.now(),
        ...options,
      });
      return;
    }
    let acquiredTurn = false;
    entry.dispatchInFlight = true;
    const untaggedTerminalsAtStart = entry.untaggedTerminals ?? 0;
    // Take Stop ownership before the first await; the session may not exist
    // yet, so a provider-level cancel alone would miss this send.
    const preparation = this.dependencies.beginTurnPreparation?.(request);
    try {
      // An idle composer can submit before already-received provider events
      // finish committing. Reserve this submission's position without claiming
      // a turn: the old route must still be allowed to revive during the drain.
      await this.dependencies.drainProviderEvents?.(request);
      if (this.entries.get(chatQueueKey(request)) !== entry) return;
      if (preparation?.cancelled) {
        this.releaseWatcherAuthority(request);
        // Stop cancelled this send before it claimed the turn. While that Stop
        // is still unwinding, hold the gate for it so no queued send starts
        // first; Stop's own untagged terminal then releases and drains. If the
        // terminal already ran, there is nothing left to wait for.
        if ((entry.untaggedTerminals ?? 0) === untaggedTerminalsAtStart) {
          entry.turnActive = true;
          entry.activeTurnUserMessageId = request.userMessageId;
          this.broadcastBestEffort(request, entry);
        }
        return;
      }
      if (
        entry.turnActive ||
        this.dependencies.hasActiveProviderTurn(request) ||
        this.dependencies.hasPendingProviderContinuation(request)
      ) {
        entry.turnActive = true;
        entry.activePluginSelections =
          this.dependencies.getActiveProviderPluginSelections?.(request);
        entry.activeGlobalPluginDefaultsRevision =
          this.dependencies.getActiveProviderPluginDefaultsRevision?.(request);
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            ...options,
          },
          true,
        );
        return;
      }
      if (
        request.agentSendSetup &&
        (await agentSendTargetReadiness(request)) === 'pending'
      ) {
        await this.enqueueDurably(request, entry, {
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
        });
        this.scheduleDrain(request, entry, 1000);
        return;
      }
      acquiredTurn = true;
      entry.turnActive = true;
      entry.activeTurnUserMessageId = request.userMessageId;
      entry.currentGlobalPluginDefaultsRevision =
        this.dependencies.getCurrentPluginDefaultsRevision?.(request);
      entry.activePluginSelections = normalizePluginSelections(
        request.pluginSelections,
      );
      entry.activeGlobalPluginDefaultsRevision =
        entry.currentGlobalPluginDefaultsRevision;
      const acceptance = this.acceptanceMutation(request, 'started');
      const persistence = this.broadcast(request, entry, acceptance);
      if (persistence) await persistence;
      if (acceptance) reportAgentSendAccepted(request, acceptance.acceptance);
      if (
        entry.authenticationPause !== undefined ||
        entry.worktreeSetupHold !== undefined ||
        entry.frozenForDeletion === true
      ) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
        entry.queue.unshift({
          id: this.dependencies.createId(),
          request,
          origin,
          enqueuedAtMs: this.dependencies.now(),
          ...options,
        });
        const restoredPersistence = this.broadcast(request, entry);
        if (restoredPersistence) await restoredPersistence;
        return;
      }
      if (entry.discardedForDeletion === true) {
        this.releaseWatcherAuthority(request);
        return;
      }
      // A Stop after this claim is settled by that Stop's own gate release;
      // the hand-off below inherits the cancel. Releasing here would let a
      // queued send start before Stop finishes.
      if (
        request.agentSent ||
        request.agentSenderProvenance ||
        request.hiddenContext?.kind === 'agent-sender-context'
      )
        await revalidateAgentSenderRequest(request);
      if (request.watcherFired && request.watcherDeliveryId)
        await this.assertWatcherIngress(request);
      if (request.agentSenderProvenance)
        await withAgentSenderAuthority(
          request,
          () => this.dependencies.dispatch(request, origin, fromQueue, options),
          revalidateAgentSenderRequest,
        );
      else
        await this.dependencies.dispatch(request, origin, fromQueue, options);
      this.watcherDispatchSucceeded(request, entry);
      const currentEntry = this.entries.get(chatQueueKey(request));
      if (
        preparation?.cancelled &&
        currentEntry === entry &&
        currentEntry.frozenForDeletion !== true &&
        currentEntry.discardedForDeletion !== true
      ) {
        // Stop can commit before an in-flight acceptance write finishes.
        // Settle that late prefix while dispatch still owns the queue gate.
        await this.settleCancelledHandoffUntilDurable(
          request,
          entry,
          request.userMessageId,
        );
      }
    } catch (error) {
      if (
        error instanceof WatcherDeliveryHeldError &&
        entry.discardedForDeletion !== true
      ) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
        await this.enqueueDurably(
          request,
          entry,
          {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
            watcherDeliveryHeld: {
              outcome: error.outcome,
              reason: error.reason,
            },
          },
          true,
        );
        this.armHeldWatcherRetry(request, entry);
        return;
      }
      if (
        isAgentSenderContextError(error) &&
        acquiredTurn &&
        entry.discardedForDeletion !== true
      ) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
        if (
          error.code === 'target_not_ready' &&
          request.agentSendSetup &&
          (await agentSendTargetReadiness(request).catch(() => 'ready')) ===
            'pending'
        ) {
          await this.enqueueDurably(request, entry, {
            id: this.dependencies.createId(),
            request,
            origin,
            enqueuedAtMs: this.dependencies.now(),
          });
          this.scheduleDrain(request, entry, 1000);
          return;
        }
        await this.persistRestoredQueueUntilDurable(request, entry, {
          type: 'cancel',
          request,
          agentSendRefusalCode:
            error.code === 'authorization_conflict'
              ? 'owner_boundary'
              : error.code,
          lastErrorMessage:
            'The agent that sent this message can no longer reach this chat.',
        });
        return;
      }
      // Rows enqueued while this dispatch was in flight must not strand:
      // release the gate, publish the corrected state, and drain them.
      if (acquiredTurn) {
        entry.turnActive = false;
        delete entry.activeTurnUserMessageId;
      }
      if (entry.discardedForDeletion !== true) {
        if (acquiredTurn && request.agentSenderProvenance)
          await this.persistRestoredQueueUntilDurable(request, entry, {
            type: 'settle-agent-input',
            request,
            reason: error instanceof Error ? error.message : String(error),
          });
        else this.broadcastBestEffort(request, entry);
        this.scheduleDrain(request, entry, 500);
      }
      throw error;
    } finally {
      preparation?.finish();
      entry.dispatchInFlight = false;
      // A different client can enqueue while the first send is handing off to
      // the provider. Publish the released gate so its Steer control does not
      // stay disabled until another queue mutation or a terminal event.
      if (
        this.entries.get(chatQueueKey(request)) === entry &&
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        entry.queue.length > 0
      ) {
        this.broadcastBestEffort(request, entry, false);
      }
      if (
        entry.frozenForDeletion !== true &&
        entry.discardedForDeletion !== true &&
        !entry.turnActive &&
        !entry.recoveryInFlight &&
        entry.queue.some((message) => !message.watcherDeliveryHeld) &&
        !entry.drainTimer
      ) {
        this.scheduleDrain(request, entry, 0);
      }
    }
  }

  private async recoverInterruptedCodexTurn(
    request: ChatSendMessageRequest,
    entry: ChatQueueEntry,
  ): Promise<void> {
    entry.recoveryInFlight = true;
    try {
      const interruptedTurnUserMessageId = entry.activeTurnUserMessageId;
      if (entry.turnActive) {
        await this.dependencies.cancel(request);
      }
      try {
        await this.dependencies.settleCancelledTurn(
          request,
          interruptedTurnUserMessageId,
        );
      } catch (error) {
        // UI settlement is best-effort. The provider is already idle, so a
        // renderer notification failure must not strand the recovery message.
        logMainProcessWarn(
          '[chat-queue] Failed to settle interrupted Codex turn before recovery dispatch:',
          error,
        );
      }
      entry.turnActive = false;
      delete entry.activeTurnUserMessageId;
    } finally {
      entry.recoveryInFlight = false;
    }
  }

  private acceptanceMutation(
    request: ChatSendMessageRequest,
    disposition: 'started' | 'queued',
    queuedMessageId?: string,
  ):
    | Extract<ChatQueuePersistenceMutation, { type: 'agent-send-accepted' }>
    | undefined {
    if (
      disposition === 'started' &&
      request.agentSent &&
      isTerminalBackedInterfaceMode(
        getEffectiveClaudeChatInterfaceMode(request.interfaceMode),
      )
    )
      return undefined;
    const acceptance: AgentSendAcceptanceFacts = {
      acceptedInputId: request.userMessageId,
      disposition,
      acceptedAt: new Date(this.dependencies.now()).toISOString(),
      ...(queuedMessageId ? { queuedMessageId } : {}),
    };
    const commandResult = agentSendAcceptanceReceipt(request, acceptance);
    return commandResult
      ? { type: 'agent-send-accepted', request, acceptance, commandResult }
      : undefined;
  }

  private async enqueueDurably(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    message: HostQueuedMessage,
    prepend = false,
  ): Promise<void> {
    const previous = entry.queue[entry.queue.length - 1];
    const incomingPart = watcherPartFromRequest(message.request);
    const previousPart = previous
      ? watcherPartFromRequest(previous.request)
      : undefined;
    if (
      !prepend &&
      !message.request.watcherDeliveryId &&
      !previous?.request.watcherDeliveryId &&
      previous &&
      previous.editLocked !== true &&
      previous.watcherConsolidationBoundary !== true &&
      Boolean(previous.request.planMode) ===
        Boolean(message.request.planMode) &&
      incomingPart &&
      (previous.watcherParts || previousPart)
    ) {
      const previousRequest = previous.request;
      const previousParts = previous.watcherParts;
      const combinedParts = [
        ...(previousParts ?? (previousPart ? [previousPart] : [])),
        incomingPart,
      ];
      previous.watcherParts = combinedParts;
      previous.request = combinedWatcherRequest(
        previous.request,
        combinedParts,
      );
      try {
        const persistence = this.broadcast(target, entry);
        if (persistence) await persistence;
      } catch (error) {
        previous.request = previousRequest;
        if (previousParts) previous.watcherParts = previousParts;
        else delete previous.watcherParts;
        this.broadcastBestEffort(target, entry);
        throw error;
      }
      return;
    }
    if (prepend) entry.queue.unshift(message);
    else entry.queue.push(message);
    // A snapshot loaded before dequeue/cancel can finish hydrating afterward.
    // Remember locally accepted IDs as well as recovered IDs so that stale
    // snapshot cannot reintroduce a row this live queue already consumed.
    entry.persistedInputIds.add(message.id);
    const acceptance = this.acceptanceMutation(
      message.request,
      'queued',
      message.id,
    );
    try {
      const persistence = this.broadcast(target, entry, acceptance);
      if (persistence) await persistence;
      if (acceptance)
        reportAgentSendAccepted(message.request, acceptance.acceptance);
    } catch (error) {
      const index = entry.queue.findIndex(
        (candidate) => candidate.id === message.id,
      );
      if (index >= 0) entry.queue.splice(index, 1);
      entry.persistedInputIds.delete(message.id);
      this.broadcastBestEffort(target, entry);
      throw error;
    }
  }

  private broadcast(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    mutation?: ChatQueuePersistenceMutation,
  ): void | Promise<void> {
    const event = {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
      queue: entry.queue
        .filter((message) => !message.request.managedDelegationDeliveryId)
        .map((message) => queuedMessageView(message, entry)),
    };
    const queueSignature = JSON.stringify(event.queue);
    let revision = entry.broadcastRevision ?? 0;
    if (entry.broadcastQueueSignature !== queueSignature) {
      revision += 1;
      entry.broadcastRevision = revision;
      entry.broadcastQueueSignature = queueSignature;
    }
    const persistence = this.dependencies.persistRuntime(
      target,
      entry.queue.map((message) => message.id),
      entry.turnActive,
      mutation,
      entry.queue.map(
        ({
          id,
          request,
          origin,
          enqueuedAtMs,
          requiredAccountProxyConnectionId,
        }) => ({
          id,
          request,
          origin,
          enqueuedAtMs,
          ...(requiredAccountProxyConnectionId !== undefined
            ? { requiredAccountProxyConnectionId }
            : {}),
          ...(entry.authenticationPause
            ? { authenticationAttemptId: entry.authenticationPause }
            : {}),
        }),
      ),
      entry.activeTurnUserMessageId,
    );
    if (!persistence || typeof persistence.then !== 'function') {
      this.dependencies.broadcast(event);
      this.pruneInputIdsAfterPersistence(target, entry);
      return;
    }
    return persistence.then(() => {
      this.pruneInputIdsAfterPersistence(target, entry);
      if (
        entry.discardedForDeletion !== true &&
        entry.broadcastRevision === revision
      ) {
        this.dependencies.broadcast(event);
      }
    });
  }

  private broadcastBestEffort(
    target: ChatQueueTarget,
    entry: ChatQueueEntry,
    persist = true,
  ): void {
    try {
      if (!persist) {
        this.dependencies.broadcast({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
          queue: entry.queue.map((message) =>
            queuedMessageView(message, entry),
          ),
        });
        return;
      }
      const persistence = this.broadcast(target, entry);
      if (persistence) {
        void persistence.catch((error: unknown) => {
          logMainProcessWarn(
            '[chat-queue] Refusing to broadcast queue state before canonical persistence:',
            error,
          );
        });
      }
    } catch (error) {
      logMainProcessWarn(
        '[chat-queue] Refusing to broadcast queue state before canonical persistence:',
        error,
      );
    }
  }
}

let chatQueueService: ChatQueueService | undefined;

export function getChatQueueService(): ChatQueueService {
  if (!chatQueueService) {
    chatQueueService = new ChatQueueService();
    subscribeGlobalPluginDefaultsRevision(() => {
      chatQueueService?.refreshGlobalPluginDefaults();
    });
  }
  return chatQueueService;
}
