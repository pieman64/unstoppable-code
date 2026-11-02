/**
 * Standard chat tab previews.
 * Resting on a background chat tab opens the shared `ChatTabPreviewCard`
 * under it: the last prompt, the agent's latest reply and the turn's status,
 * live while the card is open. Browser tabs get theirs from
 * `browser-tab-preview.tsx`.
 *
 * Cheap by construction: the tab bar asks for a card element per background
 * tab, but its content mounts only while the card is open, so only the
 * hovered chat subscribes, and only to that chat's tab and runtime. Hovering
 * the tab already warms its transcript through `noteChatIntent` (the panel
 * grid's tab intent), so a chat whose body is not loaded shows its status and
 * cached reply preview first, then its prompt once the body arrives.
 */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, type JSX, type ReactNode } from 'react';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import {
  ChatTabPreviewCard,
  type ChatTabPreviewCardProps,
  type ChatTabPreviewStatus,
} from '@canopy/ui-shared/components/panels';
import type { ChatRuntimeStatus } from '@canopy/desktop-shared/types';
import {
  useChatStore,
  useChatTabRenderState,
  type ChatRenderTarget,
  type ChatTabRenderEntry,
} from '@/stores/chatStore';
import { hasPendingQuestionForChat } from '@/stores/chat/pending-questions';
import { hasPendingApprovalForChat } from '@/stores/chat/pending-approvals';
import type { ChatMessage } from '@/stores/chat/types';
import { noteChatIntent } from '@/stores/chat/chat-prefetch';
import { warmUpChat } from '@/lib/chat-interest';

/** What the user waits on, if anything; it outranks every other status. */
export type ChatTabPreviewWaiting = 'question' | 'approval' | 'plan' | null;

const WORKING_RUNTIME: ReadonlySet<ChatRuntimeStatus> =
  new Set<ChatRuntimeStatus>(['queued', 'starting', 'streaming', 'completing']);
const STOPPED_RUNTIME: ReadonlySet<ChatRuntimeStatus> =
  new Set<ChatRuntimeStatus>(['cancelled', 'interrupted']);

function textOf(message: ChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();
}

/** A message a sub-agent sent or received inside one of the chat's calls. */
function isDelegatedMessage(message: ChatMessage): boolean {
  return (
    message.parentToolUseId !== undefined || message.parentBlockId !== undefined
  );
}

/**
 * The user's prompt that opened a turn. Hidden deliveries continue a turn, and
 * a sub-agent's instructions belong to its call, not to the chat.
 */
function isPromptMessage(message: ChatMessage): boolean {
  return (
    message.hidden !== true &&
    !isDelegatedMessage(message) &&
    isUserTurnBoundary(message) &&
    message.blocks.some((block) => block.type === 'text')
  );
}

/** A sub-agent's own messages belong to its call, not to the chat's reply. */
function isOwnAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.hidden !== true &&
    !isDelegatedMessage(message)
  );
}

/**
 * Whether the latest turn has rows that are not in memory: its own summary
 * still has an older cursor, or its prompt was not loaded while older rows
 * exist.
 */
function latestTurnPartlyLoaded(
  tab: ChatTabRenderEntry['tab'],
  promptLoaded: boolean,
): boolean {
  const transcriptWindow = tab?.transcriptWindow;
  if (!transcriptWindow) return false;
  const latest = transcriptWindow.turns?.reduce<
    NonNullable<typeof transcriptWindow.turns>[number] | undefined
  >(
    (newest, candidate) =>
      newest === undefined || candidate.start > newest.start
        ? candidate
        : newest,
    undefined,
  );
  if (latest !== undefined) return latest.before !== undefined;
  return !promptLoaded && transcriptWindow.before !== undefined;
}

/**
 * The card's facts for one chat. Pure, so the unit tests can pin every
 * state; `waiting` comes from the store's pending questions and approvals.
 */
export function deriveChatTabPreview(
  entry: ChatTabRenderEntry,
  waiting: ChatTabPreviewWaiting,
): ChatTabPreviewCardProps {
  const { tab, runtime } = entry;
  const messages: readonly ChatMessage[] = tab
    ? [...tab.messages, ...(tab.pendingUserMessages ?? [])]
    : [];
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isPromptMessage(messages[index])) {
      promptIndex = index;
      break;
    }
  }
  const promptMessage = promptIndex >= 0 ? messages[promptIndex] : undefined;
  // The chat's own rows in the latest turn. Tool calls can sit on system rows
  // (Codex stores commands, file changes and searches there); the reply is
  // only the assistant's words.
  const turnRows = messages
    .slice(promptIndex + 1)
    .filter((row) => row.hidden !== true && !isDelegatedMessage(row));
  const turn = turnRows.filter(isOwnAssistantMessage);
  const bodyKnown = messages.length > 0;

  const replies = bodyKnown
    ? turn.map(textOf).filter((text) => text.length > 0)
    : [];
  const cachedReply = tab?.transcript?.lastAssistantPreview?.trim() ?? '';
  // Only a fully loaded turn can be counted: a long turn keeps just its
  // latest rows in memory, and a count of those would read as the total.
  const toolCount =
    bodyKnown && !latestTurnPartlyLoaded(tab, promptIndex >= 0)
      ? turnRows.reduce(
          (count, message) =>
            count +
            message.blocks.filter((block) => block.type === 'tool_use').length,
          0,
        )
      : null;

  const turnEnd =
    promptMessage !== undefined ? tab?.turnEnds?.[promptMessage.id] : undefined;
  const lastMessageAt =
    tab?.transcript?.lastMessageAt ?? messages[messages.length - 1]?.timestamp;
  const endedAt = turnEnd?.endedAt ?? runtime?.lastActivityAt ?? lastMessageAt;

  const status = previewStatus(entry, waiting, {
    startedAt: runtime?.activeTurn?.startedAt ?? promptMessage?.timestamp,
    endedAt,
    // Main's record of how the latest turn ended, which outlives a restart.
    endedOutcome: turnEnd?.outcome,
    hasHistory:
      bodyKnown ||
      (tab?.transcript?.messageCount ??
        tab?.transcript?.committedMessageCount ??
        0) > 0,
  });

  return {
    prompt: promptMessage ? textOf(promptMessage) : null,
    // Until the body loads, the cached preview of the agent's last words.
    replies:
      replies.length > 0 || bodyKnown ? replies : cachedReplyList(cachedReply),
    status,
    toolCount,
  };
}

function cachedReplyList(cachedReply: string): string[] {
  return cachedReply.length > 0 ? [cachedReply] : [];
}

function previewStatus(
  { tab, runtime }: ChatTabRenderEntry,
  waiting: ChatTabPreviewWaiting,
  times: {
    startedAt: number | undefined;
    endedAt: number | undefined;
    endedOutcome: 'completed' | 'failed' | 'cancelled' | undefined;
    hasHistory: boolean;
  },
): ChatTabPreviewStatus {
  if (waiting !== null) return { kind: 'waiting', reason: waiting };
  if (
    tab?.status === 'streaming' ||
    (runtime !== undefined && WORKING_RUNTIME.has(runtime.status))
  ) {
    return times.startedAt === undefined
      ? { kind: 'working' }
      : { kind: 'working', startedAt: times.startedAt };
  }
  if (!times.hasHistory) return { kind: 'empty' };
  // Only an error reads as failed; a turn the user stopped or a restart cut
  // short is just stopped.
  const kind =
    times.endedOutcome === 'failed' ||
    tab?.status === 'error' ||
    runtime?.status === 'failed'
      ? 'failed'
      : times.endedOutcome === 'cancelled' ||
          (runtime !== undefined && STOPPED_RUNTIME.has(runtime.status))
        ? 'stopped'
        : 'finished';
  return times.endedAt === undefined
    ? { kind }
    : { kind, endedAt: times.endedAt };
}

function useChatTabPreviewWaiting(
  target: ChatRenderTarget,
): ChatTabPreviewWaiting {
  const { projectId, worktreeId, chatId } = target;
  return useChatStore((state): ChatTabPreviewWaiting => {
    if (
      hasPendingQuestionForChat(
        state.pendingQuestions,
        projectId,
        worktreeId,
        chatId,
      )
    ) {
      return 'question';
    }
    if (
      hasPendingApprovalForChat(
        state.pendingApprovals,
        projectId,
        worktreeId,
        chatId,
      )
    ) {
      return 'approval';
    }
    const planPending =
      Object.values(state.pendingPlanExits).some(
        (pending) => pending.chatId === chatId,
      ) ||
      state.worktreeChats[`${projectId}/${worktreeId}`]?.tabs.some(
        (tab) => tab.id === chatId && tab.pendingPlanExit !== undefined,
      ) === true;
    return planPending ? 'plan' : null;
  });
}

const selectEntry = (entry: ChatTabRenderEntry): ChatTabRenderEntry => entry;

/** The open card's live content for one chat. */
function DesktopChatTabPreview({
  target,
}: {
  target: ChatRenderTarget;
}): JSX.Element {
  const entry = useChatTabRenderState(target, selectEntry);
  const waiting = useChatTabPreviewWaiting(target);
  const { projectId, worktreeId, chatId } = target;
  // Main sends a chat's new messages only to windows interested in it. Keep
  // the previewed chat warm while the card is open, so a running chat's
  // replies keep arriving even when it is not among the recently shown ones.
  useEffect(() => {
    warmUpChat({ projectId, worktreeId, chatId }).catch((): void => undefined);
  }, [projectId, worktreeId, chatId]);
  // Messages main left out before the chat was warm make the transcript
  // stale; the prefetch catches it up.
  const stale = entry.tab?.transcriptStale === true;
  useEffect(() => {
    if (stale) {
      noteChatIntent({ kind: 'chat', projectId, worktreeId, chatId }, 'focus');
    }
  }, [stale, projectId, worktreeId, chatId]);
  const props = useMemo(
    () => deriveChatTabPreview(entry, waiting),
    [entry, waiting],
  );
  return <ChatTabPreviewCard {...props} />;
}

/**
 * The panel tab bar's `renderTabHoverCard` for one worktree's grid: a preview
 * card for chat tabs, nothing for any other kind (they keep their tooltip).
 */
export function createChatTabHoverCardRenderer(
  projectId: string,
  worktreeId: string,
): (tab: PanelTabModel) => ReactNode | null {
  return (tab): ReactNode | null => {
    const chatId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
    if (chatId === undefined || chatId.length === 0) return null;
    return <DesktopChatTabPreview target={{ projectId, worktreeId, chatId }} />;
  };
}
