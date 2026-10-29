import type { ChatMessage, ChatTab, QueuedChatMessage } from './types';

/** Keep pending user echoes across a metadata refresh or a stale history page. */
export function preservePendingUserMessages<
  T extends {
    messages: ChatMessage[];
    pendingUserMessages?: ChatMessage[];
    pendingTurn?: ChatTab['pendingTurn'];
    pendingQueueDispatch?: ChatTab['pendingQueueDispatch'];
    pendingQueueMessages?: ChatTab['pendingQueueMessages'];
  },
>(
  tab: T,
  messages: ChatMessage[],
  authoritativeMessages: ChatMessage[] = messages,
): T {
  tab = reconcilePendingTurn(
    reconcileQueueDispatch({ ...tab, messages }, authoritativeMessages),
  );
  messages = tab.messages;
  if (!tab.pendingUserMessages?.length && !tab.pendingQueueMessages?.length)
    return { ...tab, messages };
  const confirmed = new Set(authoritativeMessages.map((message) => message.id));
  const pendingUserMessages = (tab.pendingUserMessages ?? []).filter(
    (message) => !confirmed.has(message.id),
  );
  const visible = new Set(messages.map((message) => message.id));
  const missing = pendingUserMessages.filter(
    (message) => !visible.has(message.id),
  );
  return {
    ...tab,
    pendingUserMessages: pendingUserMessages.length
      ? pendingUserMessages
      : undefined,
    pendingQueueMessages: tab.pendingQueueMessages?.filter(
      (entry) => !confirmed.has(entry.userMessageId),
    ),
    messages: missing.length ? [...messages, ...missing] : messages,
  };
}

/** Queue views expose host row ids rather than user-message ids. Match new
 * desktop rows one-to-one against the submitted payload, excluding every row
 * already present at submission. Identical consecutive sends remain distinct. */
export function reconcilePendingQueueMessages(
  pending: ChatTab['pendingQueueMessages'],
  rows: QueuedChatMessage[],
): ChatTab['pendingQueueMessages'] {
  if (!pending?.length) return pending;
  const consumed = new Set<string>();
  const remaining = pending.filter((entry) => {
    const match = rows.find(
      (row) =>
        row.hostQueueEntryId !== undefined &&
        row.origin === 'desktop' &&
        !consumed.has(row.hostQueueEntryId) &&
        !entry.previousHostIds.includes(row.hostQueueEntryId) &&
        row.text === entry.message.text &&
        JSON.stringify(row.fileReferences ?? []) ===
          JSON.stringify(entry.message.fileReferences ?? []) &&
        JSON.stringify(row.attachmentPaths ?? []) ===
          JSON.stringify(entry.message.attachmentPaths ?? []),
    );
    if (!match?.hostQueueEntryId) return true;
    consumed.add(match.hostQueueEntryId);
    return false;
  });
  return consumed.size === 0
    ? pending
    : remaining.length
      ? remaining.map((entry) => ({
          ...entry,
          previousHostIds: [...entry.previousHostIds, ...Array.from(consumed)],
        }))
      : undefined;
}

const projectedQueues = new WeakMap<ChatTab, QueuedChatMessage[]>();
export function presentedQueueMessages(tab: ChatTab): QueuedChatMessage[] {
  if (!tab.pendingQueueMessages?.length) return tab.queuedMessages;
  const cached = projectedQueues.get(tab);
  if (cached) return cached;
  const result = [
    ...tab.queuedMessages,
    ...tab.pendingQueueMessages.map((entry) => entry.message),
  ];
  projectedQueues.set(tab, result);
  return result;
}

/** A user echo is not proof that the timer arrived. Retire the bridge only
 * when this turn has a canonical timer, and remove its local timer atomically. */
export function reconcilePendingTurn<
  T extends {
    messages: ChatMessage[];
    pendingTurn?: ChatTab['pendingTurn'];
  },
>(tab: T): T {
  const pending = tab.pendingTurn;
  if (!pending) return tab;
  const userIndex = tab.messages.findIndex(
    (message) => message.id === pending.userMessageId,
  );
  if (userIndex < 0) return tab;
  const following = tab.messages.slice(userIndex + 1);
  const nextUser = following.findIndex((message) => message.role === 'user');
  const turn = nextUser < 0 ? following : following.slice(0, nextUser);
  if (
    !turn.some(
      (message) =>
        message.id !== pending.timerMessage.id &&
        message.blocks.some((block) => block.type === 'turn_timer'),
    )
  )
    return tab;
  return {
    ...tab,
    pendingTurn: undefined,
    messages: tab.messages.filter(
      (message) => message.id !== pending.timerMessage.id,
    ),
  };
}

const projectedMessages = new WeakMap<ChatTab, ChatMessage[]>();
export function presentedMessages(tab: ChatTab): ChatMessage[] {
  if (
    tab.queuedHookPlaceholder === true &&
    tab.queuedHookInfo &&
    tab.messages.length === 0
  ) {
    return presentedQueuedHookBanner(tab, tab.queuedHookInfo);
  }
  if (!tab.pendingTurn || tab.status === 'error') return tab.messages;
  const cached = projectedMessages.get(tab);
  if (cached) return cached;
  const timer = tab.pendingTurn.timerMessage;
  const messages = tab.messages.some((message) => message.id === timer.id)
    ? tab.messages
    : [...tab.messages, timer];
  projectedMessages.set(tab, messages);
  return messages;
}

/** Queue ids are not transcript ids. Match only a new canonical user message,
 * never an earlier identical prompt, then transfer the pending timer to it. */
export function reconcileQueueDispatch<
  T extends {
    messages: ChatMessage[];
    pendingUserMessages?: ChatMessage[];
    pendingTurn?: ChatTab['pendingTurn'];
    pendingQueueDispatch?: ChatTab['pendingQueueDispatch'];
  },
>(tab: T, authoritativeMessages: ChatMessage[]): T {
  const pending = tab.pendingQueueDispatch;
  if (!pending) return tab;
  const payload = (message: ChatMessage): string =>
    JSON.stringify({
      text: message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      references: message.blocks.flatMap((block) =>
        block.type === 'file_references' ? block.references : [],
      ),
      attachments: message.attachmentPaths ?? [],
    });
  const expected = payload(pending.message);
  const accepted = authoritativeMessages.find(
    (message) =>
      message.role === 'user' &&
      message.id !== pending.message.id &&
      !pending.previousMessageIds.includes(message.id) &&
      payload(message) === expected,
  );
  if (!accepted) return tab;
  return {
    ...tab,
    pendingQueueDispatch: undefined,
    messages: tab.messages.filter(
      (message) => message.id !== pending.message.id,
    ),
    pendingUserMessages: tab.pendingUserMessages?.filter(
      (message) => message.id !== pending.message.id,
    ),
    pendingTurn:
      tab.pendingTurn?.userMessageId === pending.message.id
        ? { ...tab.pendingTurn, userMessageId: accepted.id }
        : tab.pendingTurn,
  };
}

export function presentDequeuedMessage(
  tab: ChatTab,
  row: QueuedChatMessage,
  timestamp: number,
): ChatTab {
  if (!row.hostQueueEntryId) return tab;
  const user: ChatMessage = {
    id: `pending-queue-user:${row.hostQueueEntryId}`,
    role: 'user',
    timestamp,
    blocks: [
      ...(row.fileReferences?.length
        ? [{ type: 'file_references', references: row.fileReferences } as const]
        : []),
      { type: 'text', text: row.text },
    ],
    ...(row.attachmentPaths ? { attachmentPaths: row.attachmentPaths } : {}),
    ...(row.attachmentPromptContexts
      ? { attachmentPromptContexts: row.attachmentPromptContexts }
      : {}),
    ...(row.watcherFired ? { watcherFired: row.watcherFired } : {}),
  };
  return {
    ...tab,
    messages: [...tab.messages, user],
    pendingUserMessages: [...(tab.pendingUserMessages ?? []), user],
    pendingQueueDispatch: {
      entryId: row.hostQueueEntryId,
      message: user,
      previousMessageIds: tab.messages.map((message) => message.id),
    },
    pendingTurn: {
      userMessageId: user.id,
      timerMessage: {
        id: `pending-queue-timer:${row.hostQueueEntryId}`,
        role: 'system',
        timestamp,
        blocks: [
          { type: 'turn_timer', startedAt: timestamp, completedAt: null },
        ],
      },
    },
  };
}

/** Auth/pre-dispatch refusal can put the same row back in the host queue. */
export function restoreDispatchedQueueRow(
  tab: ChatTab,
  rows: QueuedChatMessage[],
): ChatTab {
  const pending = tab.pendingQueueDispatch;
  if (!pending || !rows.some((row) => row.hostQueueEntryId === pending.entryId))
    return tab;
  return {
    ...tab,
    pendingQueueDispatch: undefined,
    messages: tab.messages.filter(
      (message) => message.id !== pending.message.id,
    ),
    pendingUserMessages: tab.pendingUserMessages?.filter(
      (message) => message.id !== pending.message.id,
    ),
    pendingTurn:
      tab.pendingTurn?.userMessageId === pending.message.id
        ? undefined
        : tab.pendingTurn,
  };
}

/** A queued hook chat has no transcript until it starts; present the same
 * banner its started transcript opens with so the hook origin shows at once.
 * Cached by the hook info object, which survives placeholder setting edits. */
const queuedHookBanners = new WeakMap<
  NonNullable<ChatTab['queuedHookInfo']>,
  ChatMessage[]
>();
function presentedQueuedHookBanner(
  tab: ChatTab,
  hookInfo: NonNullable<ChatTab['queuedHookInfo']>,
): ChatMessage[] {
  const cached = queuedHookBanners.get(hookInfo);
  if (cached) return cached;
  const messages: ChatMessage[] = [
    {
      id: `queued-hook-info:${tab.id}`,
      role: 'system',
      timestamp: hookInfo.timestamp,
      blocks: [
        {
          type: 'hook_info',
          triggerName: hookInfo.triggerName,
          timestamp: hookInfo.timestamp,
        },
      ],
    },
  ];
  queuedHookBanners.set(hookInfo, messages);
  return messages;
}
