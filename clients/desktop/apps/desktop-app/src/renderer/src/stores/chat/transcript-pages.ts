import type {
  ChatTranscriptPageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { TranscriptPage } from '@canopy/agent-transcript/transcript-storage';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import { preservePendingUserMessages } from './optimistic-presentation';
import type { ChatMessage, ChatTab } from './types';
import { chatStoreApi } from './store-ref';
import { chatScopeKey } from './revisioned-sync';
import {
  beginTranscriptPerformanceStage,
  recordTranscriptPerformanceCounter,
} from '@/lib/transcript-performance';

export const TRANSCRIPT_PAGE_LOAD_ERROR = "Couldn't load messages.";

export function installTranscriptPage<
  T extends Pick<
    PersistedChatTab,
    'messages' | 'transcriptWindow' | 'transcriptLoaded'
  > & { pendingUserMessages?: ChatMessage[] },
>(tab: T, page: TranscriptPage, older: boolean): T {
  const finishPerformanceStage = beginTranscriptPerformanceStage(
    'page_install',
    {
      pageRows: page.messages.length,
      retainedRows: older ? tab.messages.length : 0,
    },
  );
  recordTranscriptPerformanceCounter('page_installs');
  if (page.view === 'turns') {
    const previous = older ? tab.transcriptWindow : undefined;
    const ordinals = { ...previous?.messageOrdinals, ...page.messageOrdinals };
    const rows = new Map(
      (older ? tab.messages : []).map((row) => [row.id, row]),
    );
    for (const row of sanitizePersistedChatMessages(page.messages))
      rows.set(row.id, row);
    const turns = new Map(
      previous?.turns?.map((turn) => [turn.id, turn]) ?? [],
    );
    for (const turn of page.turns ?? []) {
      const retained = turns.get(turn.id);
      turns.set(
        turn.id,
        retained
          ? {
              ...turn,
              before:
                retained.before === undefined || turn.before === undefined
                  ? undefined
                  : Math.min(retained.before, turn.before),
            }
          : turn,
      );
    }
    const orderedMessages = Array.from(rows.values()).sort(
      (a, b) =>
        (ordinals[a.id] ?? Number.MAX_SAFE_INTEGER) -
        (ordinals[b.id] ?? Number.MAX_SAFE_INTEGER),
    );
    const preserved = preservePendingUserMessages(
      tab,
      orderedMessages,
      page.messages,
    );
    finishPerformanceStage({ installedRows: preserved.messages.length });
    return {
      ...preserved,
      transcriptLoaded: true,
      transcriptWindow: {
        view: 'turns',
        before: page.turnId ? previous?.before : page.before,
        turns: Array.from(turns.values()).sort((a, b) => a.start - b.start),
        messageOrdinals: ordinals,
        totalMessages: page.totalMessages,
        transcriptRevision: page.transcriptRevision,
      },
    };
  }
  const supplementalId = tab.transcriptWindow?.latestHumanMessage?.id;
  const rawHuman =
    page.latestHumanMessage ?? tab.transcriptWindow?.latestHumanMessage;
  const candidates =
    rawHuman && !page.messages.some((message) => message.id === rawHuman.id)
      ? [rawHuman, ...page.messages]
      : page.messages;
  const sanitizedById = new Map(
    sanitizePersistedChatMessages(candidates).map((message) => [
      message.id,
      message,
    ]),
  );
  const rows = new Map(
    page.messages.flatMap((message) => {
      const sanitized = sanitizedById.get(message.id);
      return sanitized ? [[message.id, sanitized] as const] : [];
    }),
  );
  if (older) {
    for (const message of tab.messages) {
      if (message.id !== supplementalId && !rows.has(message.id))
        rows.set(message.id, message);
    }
  }
  const human = rawHuman ? sanitizedById.get(rawHuman.id) : undefined;
  const supplement = human && !rows.has(human.id) ? human : undefined;
  const messages = [
    ...(supplement ? [supplement] : []),
    ...Array.from(rows.values()),
  ];
  const preserved = preservePendingUserMessages(tab, messages, page.messages);
  finishPerformanceStage({ installedRows: preserved.messages.length });
  return {
    ...preserved,
    transcriptLoaded: true,
    transcriptWindow: {
      before: page.before,
      totalMessages: page.totalMessages,
      transcriptRevision: page.transcriptRevision,
      ...(supplement ? { latestHumanMessage: supplement } : {}),
    },
  };
}

/** An in-flight read can never recreate a removed chat or overwrite a newer
 * stream/reset. Pagination changes only the selected chat's transient view. */
export async function loadChatTranscriptPage(
  target: Pick<
    ChatTranscriptPageRequest,
    'projectId' | 'worktreeId' | 'chatId'
  >,
  older = false,
  turnId?: string,
  catchUp?: (tab: ChatTab, page: TranscriptPage) => ChatTab,
): Promise<void> {
  const api = chatStoreApi();
  const key = chatScopeKey(target.projectId, target.worktreeId);
  const initial = api
    .getState()
    .worktreeChats[key]?.tabs.find((tab) => tab.id === target.chatId);
  // Hook startup persists its initial transcript before the queue releases the
  // placeholder. Hydrating it early would make the still-cancellable queue
  // entry look like a normal conversation with sent messages.
  if (!initial || initial.queuedHookPlaceholder === true) return;
  // Stale newest-page reads have one replay-aware owner. Earlier pages
  // retain their normal lazy merge path.
  if (initial.transcriptStale && !older && !catchUp) return;
  // A turn outside the loaded window has no interior cursor yet: walk the
  // global history cursor one page at a time until it appears (the same loop
  // transcript search uses), instead of dropping the request.
  const knownTurn = turnId
    ? initial.transcriptWindow?.turns?.find((turn) => turn.id === turnId)
    : undefined;
  const before = knownTurn
    ? knownTurn.before
    : initial.transcriptWindow?.before;
  if (older && before === undefined) return;
  const page = await window.api.chat.getTranscriptPage({
    ...target,
    view: 'turns',
    ...(knownTurn ? { turnId } : {}),
    ...(older
      ? {
          before,
          transcriptRevision: initial.transcriptWindow?.transcriptRevision,
        }
      : {}),
  });
  let changed = false;
  api.setState((state) => {
    const scope = state.worktreeChats[key];
    const current = scope?.tabs.find((tab) => tab.id === target.chatId);
    if (!scope || !current || current.queuedHookPlaceholder === true)
      return state;
    const storeRevision =
      current.transcript?.transcriptRevision ??
      current.transcriptWindow?.transcriptRevision;
    const stale = catchUp
      ? current.createdAt !== initial.createdAt
      : older
        ? // Ordinals are append-only and the merge sorts by ordinal, so rows
          // below the loaded window stay valid while the tail streams. Only a
          // replaced chat, a window reset while in flight, or a page newer than
          // this store (the store itself is stale) invalidate an earlier page.
          current.createdAt !== initial.createdAt ||
          current.transcriptWindow === undefined ||
          (storeRevision !== undefined &&
            page.transcriptRevision > storeRevision)
        : current.createdAt !== initial.createdAt ||
          current.messages !== initial.messages ||
          current.transcript?.transcriptRevision !==
            initial.transcript?.transcriptRevision;
    if (stale) {
      changed = true;
      return state;
    }
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [key]: {
          ...scope,
          tabs: scope.tabs.map((tab) =>
            tab.id === target.chatId
              ? catchUp
                ? catchUp(tab, page)
                : installTranscriptPage(tab, page, older)
              : tab,
          ),
        },
      },
    };
  });
  if (changed) throw new Error(TRANSCRIPT_PAGE_LOAD_ERROR);
}
