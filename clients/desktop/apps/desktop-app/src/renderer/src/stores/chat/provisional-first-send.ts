import { normalizeFingerprintText } from '@canopy/desktop-shared/lib/transcript-fingerprint';
import {
  reconcilePendingTurn,
  setupQueuedFirstSend,
} from './optimistic-presentation';
import type { FileReference } from '@canopy/desktop-shared/types';
import {
  chatTabHasConversationContent,
  firstMessageTitlePatch,
  shouldGenerateTitleFromFirstMessage,
} from './tab-utils';
import type {
  ChatMessage,
  ChatTab,
  ProvisionalFirstSend,
  ProvisionalFirstSendFailure,
  QueuedChatMessage,
} from './types';

export interface ProvisionalFirstSendInput {
  userMessageId: string;
  submittedAt: number;
  text: string;
  fileReferences?: readonly FileReference[];
  attachmentPaths?: readonly string[];
  /** The destination worktree is still setting up, so the send will queue. */
  queuedForSetup?: boolean;
}

export function provisionalTimerMessageId(userMessageId: string): string {
  return `${userMessageId}:provisional-timer`;
}

function provisionalPendingTurn(
  userMessageId: string,
  submittedAt: number,
): NonNullable<ChatTab['pendingTurn']> {
  return {
    userMessageId,
    timerMessage: {
      id: provisionalTimerMessageId(userMessageId),
      role: 'system',
      timestamp: submittedAt,
      blocks: [
        {
          type: 'turn_timer',
          startedAt: submittedAt,
          completedAt: null,
        },
      ],
    },
  };
}

/** The current preparation attempt; the first one shares the message id. */
export function provisionalFirstSendAttemptId(
  record: ProvisionalFirstSend,
): string {
  return record.attemptId ?? record.userMessageId;
}

/**
 * Presents the echo, a renderer-only turn and the first-message title on an
 * empty, idle chat. Returns the same tab when this submission is already
 * presented, and `null` when the tab is not a safe target.
 */
export function presentProvisionalFirstSendOnTab(
  tab: ChatTab,
  input: ProvisionalFirstSendInput,
): ChatTab | null {
  if (tab.provisionalFirstSend?.userMessageId === input.userMessageId) {
    return tab;
  }
  if (
    tab.kind === 'file' ||
    tab.readOnly === true ||
    tab.status !== 'idle' ||
    tab.provisionalFirstSend !== undefined ||
    tab.pendingTurn !== undefined ||
    (tab.pendingUserMessages?.length ?? 0) > 0 ||
    chatTabHasConversationContent(tab) ||
    (!input.text.trim() && !input.attachmentPaths?.length)
  ) {
    return null;
  }
  const blocks: ChatMessage['blocks'] = input.fileReferences?.length
    ? [{ type: 'file_references', references: [...input.fileReferences] }]
    : [];
  blocks.push({ type: 'text', text: input.text });
  const message: ChatMessage = {
    id: input.userMessageId,
    role: 'user',
    timestamp: input.submittedAt,
    blocks,
    ...(input.attachmentPaths?.length
      ? { attachmentPaths: [...input.attachmentPaths] }
      : {}),
  };
  const titlePatch = firstMessageTitlePatch(tab, input.text);
  return {
    ...tab,
    ...titlePatch,
    messages: [...tab.messages, message],
    pendingUserMessages: [message],
    pendingTurn: provisionalPendingTurn(input.userMessageId, input.submittedAt),
    provisionalFirstSend: {
      userMessageId: input.userMessageId,
      submittedAt: input.submittedAt,
      phase: 'preparing',
      ...(input.queuedForSetup ? { queuedForSetup: true } : {}),
      ...(titlePatch
        ? {
            ownedTitle: titlePatch,
            priorTitle: {
              title: tab.title,
              automaticTitleState: tab.automaticTitleState,
            },
          }
        : {}),
    },
  };
}

function ownsTitle(tab: ChatTab, record: ProvisionalFirstSend): boolean {
  return (
    record.ownedTitle !== undefined &&
    !tab.customTitle &&
    tab.title === record.ownedTitle.title &&
    tab.automaticTitleState === record.ownedTitle.automaticTitleState
  );
}

/**
 * Removes this submission's echo and turn bridge. A canonical copy of the
 * message (no longer pending) and another submission's turn are kept.
 * `restoreTitle` reverts the title only while this submission still owns it.
 */
function retireProvisionalEcho(
  tab: ChatTab,
  record: ProvisionalFirstSend,
  restoreTitle: boolean,
): ChatTab {
  const { userMessageId } = record;
  const stillPending =
    tab.pendingUserMessages?.some((message) => message.id === userMessageId) ===
    true;
  const pendingUserMessages = tab.pendingUserMessages?.filter(
    (message) => message.id !== userMessageId,
  );
  const next: ChatTab = {
    ...tab,
    messages: stillPending
      ? tab.messages.filter((message) => message.id !== userMessageId)
      : tab.messages,
    pendingUserMessages: pendingUserMessages?.length
      ? pendingUserMessages
      : undefined,
    pendingTurn:
      tab.pendingTurn?.userMessageId === userMessageId &&
      tab.pendingTurn.timerMessage.id ===
        provisionalTimerMessageId(userMessageId)
        ? undefined
        : tab.pendingTurn,
  };
  if (restoreTitle && record.priorTitle && ownsTitle(tab, record)) {
    next.title = record.priorTitle.title;
    next.automaticTitleState = record.priorTitle.automaticTitleState;
  }
  return next;
}

/**
 * Withdraws a submission that never reached a turn or a queue. A no-op once
 * it was adopted or queued, so a late failure cannot remove an accepted turn.
 */
export function withdrawProvisionalFirstSendFromTab(
  tab: ChatTab,
  userMessageId: string,
  replacementFailureId?: string,
): ChatTab {
  const record = tab.provisionalFirstSend;
  // Once `sendMessage` adopts the echo, its own failure handling owns it.
  if (
    record?.userMessageId !== userMessageId ||
    (record.phase !== 'preparing' &&
      !(
        record.phase === 'failed' &&
        replacementFailureId !== undefined &&
        record.failure?.failureId === replacementFailureId
      ))
  )
    return tab;
  // A canonical echo can arrive before the send promise settles. Its title
  // belongs to that accepted turn even if a transport callback later fails.
  if (!tab.pendingUserMessages?.some((message) => message.id === userMessageId))
    return tab;
  const next = retireProvisionalEcho(tab, record, true);
  next.pendingQueueMessages = next.pendingQueueMessages?.filter(
    (entry) => entry.userMessageId !== userMessageId,
  );
  delete next.provisionalFirstSend;
  return next;
}

/**
 * Marks the current attempt failed because its model was refused
 * (CAN-5021). The unsent prompt and title stay, so the chat never falls back
 * to its empty state, and the starting turn ends. A dispatched, queued,
 * claimed, or replaced attempt is left alone.
 */
export function failProvisionalFirstSendOnTab(
  tab: ChatTab,
  userMessageId: string,
  attemptId: string,
  failure: ProvisionalFirstSendFailure,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (
    record?.userMessageId !== userMessageId ||
    record.phase !== 'preparing' ||
    record.dispatchClaimed === true ||
    provisionalFirstSendAttemptId(record) !== attemptId ||
    !tab.pendingUserMessages?.some((message) => message.id === userMessageId)
  )
    return tab;
  const next: ChatTab = {
    ...tab,
    provisionalFirstSend: { ...record, phase: 'failed', failure },
  };
  if (
    tab.pendingTurn?.userMessageId === userMessageId &&
    tab.pendingTurn.timerMessage.id === provisionalTimerMessageId(userMessageId)
  )
    next.pendingTurn = undefined;
  return next;
}

/**
 * Claims a failed first send for one retry under a new attempt: the same
 * prompt resumes preparing in place, never withdrawn and re-presented. A
 * second claim of the same failure is a no-op.
 */
export function retryFailedProvisionalFirstSendOnTab(
  tab: ChatTab,
  userMessageId: string,
  failureId: string,
  attemptId: string,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (
    record?.userMessageId !== userMessageId ||
    record.phase !== 'failed' ||
    record.failure?.failureId !== failureId
  )
    return tab;
  const resumed: ProvisionalFirstSend = {
    ...record,
    phase: 'preparing',
    attemptId,
    dispatchClaimed: false,
  };
  delete resumed.failure;
  return {
    ...tab,
    pendingTurn: provisionalPendingTurn(userMessageId, record.submittedAt),
    provisionalFirstSend: resumed,
  };
}

/** Only for a native preparation confirmed cancelled before host dispatch. */
export function rejectUndispatchedProvisionalFirstSend(
  tab: ChatTab,
  userMessageId: string,
  timerMessageId: string,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (record?.userMessageId !== userMessageId || record.phase !== 'dispatched')
    return tab;
  const next = retireProvisionalEcho(tab, record, true);
  // Legacy adoption has already removed the pending-user marker. The caller
  // knows no host request was made, so these exact adopted rows remain ours.
  next.messages = next.messages.filter(
    (message) => message.id !== userMessageId && message.id !== timerMessageId,
  );
  if (next.pendingTurn?.userMessageId === userMessageId)
    next.pendingTurn = undefined;
  delete next.provisionalFirstSend;
  return next;
}

/**
 * Hands the submission to a queue row: the echo and bridge go in the same
 * update that adds the row, and the question title stays.
 */
export function handOffProvisionalFirstSendToQueue(
  tab: ChatTab,
  userMessageId: string | undefined,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (!userMessageId || record?.userMessageId !== userMessageId) return tab;
  if (record.phase === 'queued') return tab;
  const queued: ProvisionalFirstSend = { ...record, phase: 'queued' };
  // The real row now shows it. A later flush presents the starting turn.
  delete queued.queuedForSetup;
  return {
    ...retireProvisionalEcho(tab, record, false),
    provisionalFirstSend: queued,
  };
}

export function cancelProvisionalFirstSendQueue(
  tab: ChatTab,
  userMessageId: string | undefined,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (
    !userMessageId ||
    record?.userMessageId !== userMessageId ||
    record.phase !== 'queued'
  )
    return tab;
  const next = retireProvisionalEcho(tab, record, true);
  next.pendingQueueMessages = next.pendingQueueMessages?.filter(
    (entry) => entry.userMessageId !== userMessageId,
  );
  delete next.provisionalFirstSend;
  return next;
}

/** Queue removal and the next echo commit together, before send preparation. */
export function resumeQueuedProvisionalFirstSend(
  tab: ChatTab,
  row: QueuedChatMessage,
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (
    record?.phase !== 'queued' ||
    row.dispatchOptions?.userMessageId !== record.userMessageId
  )
    return tab;
  const echo = presentProvisionalFirstSendOnTab(
    {
      ...tab,
      messages: [],
      transcript: undefined,
      queuedMessages: [],
      provisionalFirstSend: undefined,
    },
    {
      userMessageId: record.userMessageId,
      submittedAt: record.submittedAt,
      text: row.text,
      fileReferences: row.fileReferences,
      attachmentPaths: row.attachmentPaths,
    },
  );
  if (!echo) return tab;
  return {
    ...tab,
    messages: [...tab.messages, ...echo.messages],
    pendingTurn: echo.pendingTurn,
    pendingUserMessages: echo.pendingUserMessages,
    provisionalFirstSend: {
      ...record,
      phase: 'preparing',
      dispatchClaimed: false,
    },
  };
}

/**
 * The submission `sendMessage` is adopting, when its message id matches the
 * presented echo. Setup-queued first sends retain it when they flush.
 */
export function adoptableProvisionalFirstSend(
  tab: ChatTab | undefined,
  userMessageId: string | undefined,
): ProvisionalFirstSend | undefined {
  const record = tab?.provisionalFirstSend;
  return userMessageId && record?.userMessageId === userMessageId
    ? record
    : undefined;
}

/**
 * Keeps an owned question title over a canonical placeholder title. A
 * generated or user-assigned title wins.
 */
export function preserveProvisionalFirstSendTitle(
  previous: ChatTab,
  next: ChatTab,
): ChatTab {
  const record = previous.provisionalFirstSend;
  if (!record) return next;
  const carried: ChatTab = { ...next, provisionalFirstSend: record };
  if (
    !record.ownedTitle ||
    next.customTitle ||
    !shouldGenerateTitleFromFirstMessage(next.title) ||
    !ownsTitle(previous, record)
  ) {
    return carried;
  }
  return {
    ...carried,
    title: record.ownedTitle.title,
    automaticTitleState: record.ownedTitle.automaticTitleState,
  };
}

/** Admission outlives the presentation lease until the first send is acknowledged. */
export function isProvisionalFirstSendAdmissionPending(
  tab: ChatTab | undefined,
): boolean {
  const record = tab?.provisionalFirstSend;
  if (!tab || !record) return false;
  if (record.phase === 'queued') {
    return (
      tab.pendingQueueMessages?.some(
        (pending) => pending.userMessageId === record.userMessageId,
      ) === true
    );
  }
  // A failed first send stays the chat's only first send until it is retried.
  if (record.phase === 'failed') return true;
  if (tab.status === 'error') return false;
  return (
    record.phase === 'preparing' ||
    (record.phase === 'dispatched' &&
      tab.pendingUserMessages?.some(
        (message) => message.id === record.userMessageId,
      ) === true)
  );
}

/**
 * The user message whose turn shows the pending "Starting…" status: the
 * provisional first send, until it queues or the chat errors. A send headed
 * for the setup queue never shows it. The turn
 * renderer ends it on the first visible output or a finished timer.
 */
export function startingTurnUserMessageId(tab: ChatTab): string | undefined {
  const record = tab.provisionalFirstSend;
  if (
    !record ||
    record.phase === 'queued' ||
    record.phase === 'failed' ||
    tab.status === 'error' ||
    setupQueuedFirstSend(tab)
  ) {
    return undefined;
  }
  return record.terminalUserMessageId ?? record.userMessageId;
}

/** A terminal import keeps its canonical id; retire only this submission's echo. */
export function reconcileProvisionalTerminalFirstSend(
  tab: ChatTab,
  incoming: readonly ChatMessage[],
): ChatTab {
  const record = tab.provisionalFirstSend;
  if (!record?.terminalPromptText || record.phase === 'queued') return tab;
  if (record.terminalUserMessageId) return reconcilePendingTurn(tab);
  const pending = tab.pendingUserMessages?.find(
    (message) => message.id === record.userMessageId,
  );
  if (!pending) return tab;
  // Claude imports images separately; compare without this submission's paths.
  const attachmentPaths = new Set(pending.attachmentPaths ?? []);
  const comparableText = (text: string): string =>
    normalizeFingerprintText(
      text
        .split('\n')
        .filter((line) => !attachmentPaths.has(line.trim()))
        .join('\n'),
    );
  const textOf = (message: ChatMessage): string =>
    comparableText(
      message.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n'),
    );
  const displayText = textOf(pending);
  const submittedText = comparableText(record.terminalPromptText);
  const accepted = incoming.find((message) => {
    if (message.role !== 'user' || message.timestamp < record.submittedAt)
      return false;
    const text = textOf(message);
    return (
      (submittedText !== '' && text === submittedText) ||
      (displayText !== '' &&
        (text === displayText || text.endsWith(` ${displayText}`))) ||
      (displayText === '' &&
        (pending.attachmentPaths?.length ?? 0) > 0 &&
        (message.attachmentPaths?.length ?? 0) > 0)
    );
  });
  if (!accepted) return tab;
  const pendingUserMessages = tab.pendingUserMessages?.filter(
    (message) => message.id !== record.userMessageId,
  );
  const next: ChatTab = {
    ...tab,
    messages: tab.messages.filter(
      (message) =>
        message.id !== record.userMessageId || message.id === accepted.id,
    ),
    pendingUserMessages: pendingUserMessages?.length
      ? pendingUserMessages
      : undefined,
    pendingTurn:
      tab.pendingTurn?.userMessageId === record.userMessageId
        ? { ...tab.pendingTurn, userMessageId: accepted.id }
        : tab.pendingTurn,
    provisionalFirstSend: {
      ...record,
      phase: 'dispatched',
      terminalUserMessageId: accepted.id,
    },
  };
  return reconcilePendingTurn(next);
}

/** Leaves the unsent echo and its title patch out of a persisted snapshot. */
export function persistableProvisionalFirstSendView(
  tab: ChatTab,
): Pick<ChatTab, 'messages' | 'title' | 'automaticTitleState'> {
  const record = tab.provisionalFirstSend;
  if (!record) {
    return {
      messages: tab.messages,
      title: tab.title,
      automaticTitleState: tab.automaticTitleState,
    };
  }
  const restoreTitle =
    record.priorTitle !== undefined && ownsTitle(tab, record);
  return {
    messages:
      (record.phase === 'preparing' || record.phase === 'failed') &&
      tab.pendingUserMessages?.some(
        (message) => message.id === record.userMessageId,
      )
        ? tab.messages.filter((message) => message.id !== record.userMessageId)
        : tab.messages,
    title:
      restoreTitle && record.priorTitle ? record.priorTitle.title : tab.title,
    automaticTitleState:
      restoreTitle && record.priorTitle
        ? record.priorTitle.automaticTitleState
        : tab.automaticTitleState,
  };
}
