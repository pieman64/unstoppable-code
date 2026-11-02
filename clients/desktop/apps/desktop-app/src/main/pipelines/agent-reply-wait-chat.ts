/**
 * The `wait-for-agent-reply` wait deps over canonical chat state: where a
 * `message_id` stands (host queue, input-delivery ledger, transcript), the
 * chat's running or latest turn, the chat-state owner's settlement
 * (`ChatStateService.settledTurn`) and scope-filtered commit wake-ups.
 * Reads IDs and states only, never message text.
 */
import { isInputLedger } from '@canopy/desktop-shared/chat-input-delivery';
import type { ActiveChatInputProvider } from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import type { ChatStateSnapshot } from '@canopy/desktop-shared/types';
import type { ChatReadContext } from '../project-discovery/chat-target';
import type { ChatStateService } from '../services/chat-state-service';
import type {
  AgentReplyWaitDeps,
  CurrentTurn,
  TurnSettlement,
  WatchedInput,
} from './agent-reply-wait';

/** Where a `message_id` stands in a chat's state, before any transcript fallback. */
export function locateInputInChat(
  snapshot: ChatStateSnapshot,
  chatId: string,
  messageId: string,
):
  | WatchedInput
  | { kind: 'queued'; userMessageId: string }
  | { kind: 'cancelled_row' }
  | { kind: 'not_in_ledger' } {
  // A queue row ID resolves only while its entry is still queued.
  const queued = snapshot.runtimeByChatId[chatId]?.queuedMessages?.find(
    (entry) =>
      entry.id === messageId || entry.request.userMessageId === messageId,
  );
  if (queued)
    return { kind: 'queued', userMessageId: queued.request.userMessageId };
  const tab = snapshot.tabsFile.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  const ledger =
    tab && isInputLedger(tab.inputDelivery) ? tab.inputDelivery : undefined;
  const row = ledger?.rows.find((candidate) => candidate.id === messageId);
  if (!row) return { kind: 'not_in_ledger' };
  // The latest picked-up attempt names the turn it ran in; a steer names the
  // root turn it joined.
  const pickedUp = [...row.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.pickedUpAt !== undefined &&
        attempt.rootUserMessageId !== undefined,
    );
  if (pickedUp?.rootUserMessageId !== undefined)
    return { kind: 'turn', turnId: pickedUp.rootUserMessageId };
  // The accepted prompt picks up an agent-sent row with no delivery attempt
  // (a Codex chat): the row's own message opened the turn.
  if (row.state === 'picked-up') return { kind: 'turn', turnId: row.id };
  return row.state === 'cancelled'
    ? { kind: 'cancelled_row' }
    : { kind: 'pending' };
}

export interface ChatReplyWaitServices {
  chatState: Pick<
    ChatStateService,
    'settledTurn' | 'subscribe' | 'hasTranscriptMessage'
  >;
  readSnapshot(): Promise<ChatStateSnapshot>;
  activeInput(): ReturnType<ActiveChatInputProvider['getActiveChatInput']>;
  /** The newest turn the transcript holds complete, or null. */
  latestSettledTurnId(): Promise<string | null>;
}

export function createChatReplyWaitDeps(
  context: ChatReadContext,
  services: ChatReplyWaitServices,
): AgentReplyWaitDeps {
  const scope = {
    projectId: context.scope.workspaceId,
    worktreeId: context.scope.worktreeId,
  };
  const chatId = context.scope.chatId;
  // The idle-path turn, for the legacy-chat guard in `settle`.
  let latestTurnId: string | null = null;
  // A queue row ID seen while queued, followed by its user message after
  // dispatch removes the row.
  let queuedUserMessageId: string | undefined;
  let unknownOnce = false;
  return {
    async locateInput(input): Promise<WatchedInput> {
      const messageId = queuedUserMessageId ?? input;
      const located = locateInputInChat(
        await services.readSnapshot(),
        chatId,
        messageId,
      );
      if (located.kind === 'queued') {
        queuedUserMessageId = located.userMessageId;
        return { kind: 'pending' };
      }
      if (located.kind !== 'cancelled_row' && located.kind !== 'not_in_ledger')
        return located;
      // An ordinary fallback dispatch, or a chat from before the ledger.
      if (
        await services.chatState.hasTranscriptMessage(scope, chatId, messageId)
      )
        return { kind: 'turn', turnId: messageId };
      if (located.kind === 'cancelled_row') return { kind: 'never_ran' };
      // Dispatch removes the queue row before the ledger or transcript holds
      // the message: a message seen queued keeps waiting, and any other ID is
      // re-checked once on the next pass before it's unknown.
      if (queuedUserMessageId !== undefined || !unknownOnce) {
        unknownOnce = true;
        return { kind: 'pending' };
      }
      return { kind: 'unknown' };
    },
    async currentTurn(): Promise<CurrentTurn> {
      const active = await services.activeInput();
      switch (active.state) {
        case 'active':
          return active.inputId !== undefined
            ? { kind: 'turn', turnId: active.inputId }
            : { kind: 'unknown' };
        case 'pending':
          return { kind: 'pending' };
        case 'unknown':
          return { kind: 'unknown' };
        case 'idle':
          latestTurnId = await services.latestSettledTurnId();
          return latestTurnId === null
            ? { kind: 'none' }
            : { kind: 'turn', turnId: latestTurnId };
      }
    },
    async settle(turnId): Promise<TurnSettlement> {
      const settled = await services.chatState.settledTurn({
        ...scope,
        chatId,
        userMessageId: turnId,
      });
      if (
        settled.outcome === 'pending' &&
        turnId === latestTurnId &&
        (await services.activeInput()).state === 'idle'
      ) {
        // A transcript-complete turn the chat-state owner never marked
        // accepted (a chat from before acceptance markers): idle means it ended.
        return { outcome: 'completed', endedTurnId: turnId, abandoned: false };
      }
      return {
        outcome: settled.outcome,
        endedTurnId: settled.userMessageId ?? turnId,
        abandoned: settled.abandoned,
      };
    },
    onChange(listener): () => void {
      // Events carry no chat ID; sibling chats in the worktree also wake the
      // wait, which coalescing bounds.
      return services.chatState.subscribe((event) => {
        if (
          event.projectId === scope.projectId &&
          event.worktreeId === scope.worktreeId
        )
          listener();
      });
    },
  };
}

/**
 * Production services. Imports are deferred to the first wait so main's
 * startup graph never loads chat state through the pipeline host.
 */
export async function desktopChatReplyWaitServices(
  context: ChatReadContext,
): Promise<ChatReplyWaitServices> {
  const [{ getActiveChatInputProvider }, { TranscriptReader }] =
    await Promise.all([
      import('../services/active-chat-input'),
      import('../project-discovery/reads/transcript'),
    ]);
  // Destructured on its own so the chat boundary check can cap its references.
  const { getChatStateService, readChatWatcherSnapshot } =
    await import('../services/chat-state-service');
  const scope = {
    projectId: context.scope.workspaceId,
    worktreeId: context.scope.worktreeId,
  };
  return {
    chatState: getChatStateService(),
    readSnapshot: () => readChatWatcherSnapshot(scope),
    activeInput: () =>
      getActiveChatInputProvider().getActiveChatInput(context.address),
    async latestSettledTurnId(): Promise<string | null> {
      const page = await new TranscriptReader(context).readPage({
        view: 'turns',
      });
      const newest = [...(page.turns ?? [])]
        .filter((turn) => turn.complete)
        .sort(
          (left, right) => right.start - left.start || right.end - left.end,
        )[0];
      return newest?.id ?? null;
    },
  };
}
