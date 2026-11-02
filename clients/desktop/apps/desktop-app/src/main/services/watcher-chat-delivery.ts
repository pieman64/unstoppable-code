import {
  APP_ADVISOR_PROJECT_ID,
  getExecutionHarnessForModel,
  getModelSource,
  getProviderForChatModel,
  getProviderForModel,
  isTerminalBackedInterfaceMode,
} from '@canopy/desktop-shared/types';
import type {
  ChatSendMessageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { assertWritableScope } from '../lib/read-only-scope';
import { getEffectiveClaudeChatInterfaceMode } from '../lib/claude-tui-chats';
import { assertChatScopeAcceptsTurns } from '../lib/retired-chat-scope-guard';
import { validateId } from '../lib/validation';
import type { ChatScopeKey } from './chat-state-contracts';

export interface WatcherChatDelivery {
  projectId: string;
  worktreeId: string;
  chatId: string;
  watcherId: string;
  deliveryId: string;
  text: string;
  hiddenContextText?: string;
  watcherFired?: { kind: string };
}

interface GeneratedWatcherMessageDelivery {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  text: string;
  hiddenContextText?: string;
  watcherFired?: { kind: string };
  watcherDeliveryId?: string;
  delegationNoticeBatchId?: string;
}

export type WatcherChatDeliveryOutcome =
  | 'submitted'
  | 'already_delivered'
  | 'terminal_presenter';

export type GeneratedWatcherMessageDeliveryOutcome =
  | WatcherChatDeliveryOutcome
  | 'parent_gone';

const DESTINATION_UNAVAILABLE = 'Watcher destination chat is not available.';
const deliveryTails = new Map<string, Promise<void>>();

/**
 * Electron specs read what main dispatched, including the hidden event
 * context that is never persisted. The build-time gate removes the caller.
 */
function recordE2eWatcherDelivery(
  delivery: GeneratedWatcherMessageDelivery,
): void {
  const globalKey = '__CANOPY_E2E_WATCHER_DELIVERIES__';
  const entry = {
    chatId: delivery.chatId,
    text: delivery.text,
    hiddenContextText: delivery.hiddenContextText ?? null,
  };
  const existing: unknown = Reflect.get(globalThis, globalKey);
  if (Array.isArray(existing)) {
    existing.push(entry);
    return;
  }
  Reflect.set(globalThis, globalKey, [entry]);
}

/**
 * Lets an Electron spec keep one chat's delivery pending before dispatch, as
 * a busy destination would: `{ chatId, released }` until `released` settles.
 * Main dispatches watcher messages itself, so an IPC hang cannot hold them.
 * The build-time gate removes the caller.
 */
async function waitForE2eWatcherDeliveryHold(chatId: string): Promise<void> {
  const hold: unknown = Reflect.get(
    globalThis,
    '__CANOPY_E2E_WATCHER_DELIVERY_HOLD__',
  );
  if (
    typeof hold === 'object' &&
    hold !== null &&
    Reflect.get(hold, 'chatId') === chatId
  ) {
    const released: unknown = Reflect.get(hold, 'released');
    if (released instanceof Promise) await released;
  }
}

function deliveryKey(scope: ChatScopeKey, chatId: string): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, chatId]);
}

/**
 * Whether the durable queue or the delivery ledger already holds this id.
 *
 * The runtime's `activeTurn` is deliberately not a receipt: it keeps naming a
 * turn whose dispatch was rejected before its prompt was persisted. A turn
 * that is really running is held by the live queue, which ignores a repeated
 * id at submit.
 */
function hasTrackedWatcherDelivery(
  tab: PersistedChatTab,
  userMessageId: string,
  runtime:
    | { queuedMessages?: Array<{ request: ChatSendMessageRequest }> }
    | undefined,
): boolean {
  if (
    runtime?.queuedMessages?.some(
      ({ request }) =>
        request.userMessageId === userMessageId ||
        request.consolidatedWatcherUserMessageIds?.includes(userMessageId) ===
          true,
    )
  ) {
    return true;
  }
  return (
    tab.inputDelivery?.rows.some(
      (row) =>
        row.id === userMessageId ||
        row.payload.userMessageId === userMessageId ||
        row.payload.consolidatedWatcherUserMessageIds?.includes(
          userMessageId,
        ) === true ||
        row.attempts.some(
          (attempt) =>
            attempt.rootUserMessageId === userMessageId ||
            attempt.payloadSnapshot?.userMessageId === userMessageId ||
            attempt.payloadSnapshot?.consolidatedWatcherUserMessageIds?.includes(
              userMessageId,
            ) === true,
        ),
    ) ?? false
  );
}

function isTerminalBackedClaudeTab(tab: PersistedChatTab): boolean {
  const source = tab.model
    ? getModelSource(tab.model)
    : tab.providerType === 'claude' || tab.providerType === undefined
      ? 'claude-managed'
      : undefined;
  return (
    source === 'claude-managed' &&
    isTerminalBackedInterfaceMode(
      getEffectiveClaudeChatInterfaceMode(tab.interfaceMode),
    )
  );
}

async function deliverWithinScope(
  delivery: GeneratedWatcherMessageDelivery,
  scope: ChatScopeKey,
): Promise<GeneratedWatcherMessageDeliveryOutcome> {
  const usageCleanupBefore = Date.now();
  const state = (await import('./chat-state-service')).getChatStateService();
  const recovered = await state.recoverHostRuntime(scope);
  const tab = recovered.tabs.find(
    (candidate) => candidate.id === delivery.chatId,
  );
  if (!tab || (tab.kind ?? 'chat') !== 'chat' || tab.readOnly) {
    return 'parent_gone';
  }

  const terminalBacked = isTerminalBackedClaudeTab(tab);
  if (terminalBacked && delivery.projectId === APP_ADVISOR_PROJECT_ID) {
    return 'parent_gone';
  }

  if (
    (await state.hasTranscriptMessage(
      scope,
      delivery.chatId,
      delivery.userMessageId,
    )) ||
    (await state.hasMutation(
      scope,
      `${delivery.chatId}:${delivery.userMessageId}:accepted`,
    )) ||
    hasTrackedWatcherDelivery(
      tab,
      delivery.userMessageId,
      recovered.runtimeByChatId[delivery.chatId],
    )
  ) {
    return 'already_delivered';
  }

  if (terminalBacked) return 'terminal_presenter';

  const chatService = await import('./chat-service');
  let persistedOptions: Awaited<
    ReturnType<typeof chatService.buildExistingTabDispatchOptions>
  >;
  try {
    persistedOptions = await chatService.buildExistingTabDispatchOptions(
      delivery.projectId,
      delivery.worktreeId,
      delivery.chatId,
    );
  } catch (error) {
    if (
      error instanceof chatService.ExistingTabDispatchTargetNotFoundError ||
      (error instanceof Error && error.message === 'Target chat is readonly.')
    ) {
      return 'parent_gone';
    }
    throw error;
  }

  const model = persistedOptions.model ?? tab.model;
  const persistedHarness =
    persistedOptions.executionHarness ?? tab.executionHarness;
  const persistedProvider = persistedOptions.providerType ?? tab.providerType;
  const executionHarness =
    persistedHarness ??
    (model ? getExecutionHarnessForModel(model) : undefined) ??
    (persistedProvider === 'codex' ||
    persistedProvider === 'cursor' ||
    persistedProvider === 'copilot'
      ? persistedProvider
      : 'claude');
  const modelProvider = model
    ? (getProviderForChatModel(model, executionHarness) ??
      getProviderForModel(model))
    : undefined;
  const providerType =
    executionHarness === 'cursor' || executionHarness === 'copilot'
      ? executionHarness
      : (persistedProvider ??
        modelProvider ??
        (executionHarness === 'claude' || executionHarness === 'codex'
          ? executionHarness
          : 'claude'));
  const { clampToLiveApprovalMode } =
    await import('../approvals/live-approval-modes');
  const { resolvePersistedApprovalMode } =
    await import('../lib/approval-mode-resolution');
  const approvalMode = await resolvePersistedApprovalMode(
    delivery.projectId,
    delivery.worktreeId,
    clampToLiveApprovalMode(
      delivery.projectId,
      delivery.worktreeId,
      delivery.chatId,
      tab.approvalMode,
    ),
  );
  const pendingSystemInstructions = tab.pendingSystemInstructions?.map(
    (instruction) => ({ ...instruction }),
  );
  const request: ChatSendMessageRequest = {
    ...persistedOptions,
    projectId: delivery.projectId,
    worktreeId: delivery.worktreeId,
    chatId: delivery.chatId,
    userMessageId: delivery.userMessageId,
    text: delivery.text,
    ...(model ? { model } : {}),
    ...(providerType ? { providerType } : {}),
    executionHarness,
    approvalMode,
    hiddenContext: {
      kind: 'canopy-watcher-event',
      text: delivery.hiddenContextText ?? '',
    },
    ...(delivery.watcherFired
      ? { watcherFired: { ...delivery.watcherFired } }
      : {}),
    ...(delivery.watcherDeliveryId !== undefined
      ? { watcherDeliveryId: delivery.watcherDeliveryId }
      : {}),
    ...(delivery.delegationNoticeBatchId !== undefined
      ? { delegationNoticeBatchId: delivery.delegationNoticeBatchId }
      : {}),
    ...(pendingSystemInstructions ? { pendingSystemInstructions } : {}),
    ...(delivery.projectId === APP_ADVISOR_PROJECT_ID
      ? { assistantMode: 'app-advisor' }
      : {}),
    initiationSource: 'user',
  };

  const target = { ...scope, chatId: delivery.chatId };
  (await import('./stopped-turn-resume-service'))
    .getStoppedTurnResumeService()
    .invalidateForNewTurn(target, delivery.userMessageId);
  if (__CANOPY_E2E__) {
    recordE2eWatcherDelivery(delivery);
    await waitForE2eWatcherDeliveryHold(delivery.chatId);
  }
  await chatService.dispatchLocalWorktreeChatMessage(request);
  await (
    await import('../lib/usage-limited-chats-registry')
  ).clearUsageLimitedChat(target, { onlyIfDetectedBefore: usageCleanupBefore });
  return 'submitted';
}

async function enqueueGeneratedWatcherMessage(
  delivery: GeneratedWatcherMessageDelivery,
): Promise<GeneratedWatcherMessageDeliveryOutcome> {
  const scope = {
    projectId: delivery.projectId,
    worktreeId: delivery.worktreeId,
  };
  const key = deliveryKey(scope, delivery.chatId);
  const previous = deliveryTails.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const state = (
        await import('./chat-state-service')
      ).getChatStateService();
      return state.runWithScopeActivity(scope, () =>
        deliverWithinScope(delivery, scope),
      );
    });
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  deliveryTails.set(key, settled);
  try {
    return await current;
  } finally {
    if (deliveryTails.get(key) === settled) deliveryTails.delete(key);
  }
}

export async function deliverGeneratedWatcherMessageToChat(
  delivery: GeneratedWatcherMessageDelivery,
): Promise<GeneratedWatcherMessageDeliveryOutcome> {
  validateId(delivery.projectId, 'projectId');
  validateId(delivery.worktreeId, 'worktreeId');
  validateId(delivery.chatId, 'chatId');
  validateId(delivery.userMessageId, 'userMessageId');
  if (delivery.watcherDeliveryId !== undefined)
    validateId(delivery.watcherDeliveryId, 'watcherDeliveryId');
  if (delivery.delegationNoticeBatchId !== undefined) {
    validateId(delivery.delegationNoticeBatchId, 'delegationNoticeBatchId');
    if (delivery.delegationNoticeBatchId !== delivery.userMessageId)
      throw new Error(
        'A delegation notice batch ID must match its user message ID.',
      );
  }

  try {
    assertWritableScope(delivery.projectId);
    assertChatScopeAcceptsTurns(delivery.projectId);
  } catch {
    return 'parent_gone';
  }

  return enqueueGeneratedWatcherMessage(delivery);
}

export async function deliverWatcherMessageToChat(
  delivery: WatcherChatDelivery,
): Promise<WatcherChatDeliveryOutcome> {
  validateId(delivery.projectId, 'projectId');
  validateId(delivery.worktreeId, 'worktreeId');
  validateId(delivery.chatId, 'chatId');
  validateId(delivery.watcherId, 'watcherId');
  validateId(delivery.deliveryId, 'deliveryId');
  const userMessageId = `watcher-${delivery.deliveryId}`;
  validateId(userMessageId, 'userMessageId');
  assertWritableScope(delivery.projectId);
  assertChatScopeAcceptsTurns(delivery.projectId);

  const outcome = await deliverGeneratedWatcherMessageToChat({
    projectId: delivery.projectId,
    worktreeId: delivery.worktreeId,
    chatId: delivery.chatId,
    userMessageId,
    text: delivery.text,
    ...(delivery.hiddenContextText !== undefined
      ? { hiddenContextText: delivery.hiddenContextText }
      : {}),
    ...(delivery.watcherFired !== undefined
      ? { watcherFired: delivery.watcherFired }
      : {}),
    watcherDeliveryId: delivery.deliveryId,
  });
  if (outcome === 'parent_gone') throw new Error(DESTINATION_UNAVAILABLE);
  return outcome;
}
