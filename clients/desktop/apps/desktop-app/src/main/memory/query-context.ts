import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { readWorktreeSummary } from '../lib/worktree-summary-persistence';
import {
  MEMORY_CONTEXT_MAX_RECENT_MESSAGES,
  isMachineGeneratedMemoryText,
  isTrivialMemoryInput,
  type MemoryQueryContext,
} from './memory-context';

const EMPTY_CONTEXT: MemoryQueryContext = {
  recentUserMessages: [],
  summaryDescription: null,
};
const MEMORY_CONTEXT_MAX_TRANSCRIPT_PAGES = 3;
const MEMORY_CONTEXT_MAX_TRANSCRIPT_ROWS = 2_000;

function visibleUserText(message: PersistedChatMessage): string {
  return message.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .trim();
}

export function recentUserMessageTexts(
  messages: PersistedChatMessage[],
  currentUserMessageId: string,
): string[] {
  // Scan newest-first and stop once the cap is met so long chats do not
  // materialize every prior user message just to discard all but the last few.
  // The collected slice is reversed to keep the documented oldest-first order.
  const newestFirst: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (!isHumanAuthoredUserMessage(message)) continue;
    if (message.id === currentUserMessageId) continue;
    const text = visibleUserText(message);
    // Reuse the dispatch rules: short acknowledgements, slash commands, and
    // machine-generated text (watcher notifications, pipeline invocations
    // persisted as user messages) carry no retrieval signal worth spending
    // query budget on — and machine text actively drags retrieval toward the
    // automation's topic instead of the user's.
    if (isTrivialMemoryInput(text) || isMachineGeneratedMemoryText(text))
      continue;
    newestFirst.push(text);
    if (newestFirst.length >= MEMORY_CONTEXT_MAX_RECENT_MESSAGES) break;
  }
  return newestFirst.reverse();
}

export async function collectMemoryQueryContext(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  currentUserMessageId: string;
  signal?: AbortSignal;
}): Promise<MemoryQueryContext> {
  const { signal, ...transcriptRequest } = options;
  try {
    const [tabsFile, worktreeSummary] = await Promise.all([
      readChatTabsFile(options.projectId, options.worktreeId, {
        chatIds: [options.chatId],
        pageOnly: true,
      }).catch(() => null),
      readWorktreeSummary(options.projectId, options.worktreeId).catch(
        () => null,
      ),
    ]);
    const tab = tabsFile?.tabs.find((entry) => entry.id === options.chatId);
    let recentUserMessages = tab
      ? recentUserMessageTexts(
          tab.messages.filter(
            (message) =>
              message.id !== tab.transcriptWindow?.latestHumanMessage?.id,
          ),
          options.currentUserMessageId,
        )
      : [];
    let before = tab?.transcriptWindow?.before;
    let pagesRead = 0;
    let rowsRead = tab?.messages.length ?? 0;
    const pagingAborted = (): boolean => signal?.aborted === true;
    while (
      before !== undefined &&
      recentUserMessages.length < MEMORY_CONTEXT_MAX_RECENT_MESSAGES &&
      pagesRead < MEMORY_CONTEXT_MAX_TRANSCRIPT_PAGES &&
      rowsRead < MEMORY_CONTEXT_MAX_TRANSCRIPT_ROWS &&
      !pagingAborted()
    ) {
      // Defer the heavy state service until older V2 pages are needed.
      const { getChatStateService } =
        await import('../services/chat-state-service');
      if (pagingAborted()) break;
      const page = await getChatStateService().getTranscriptPage({
        ...transcriptRequest,
        before,
        transcriptRevision: tab?.transcriptWindow?.transcriptRevision,
      });
      pagesRead += 1;
      rowsRead += page.messages.length;
      if (pagingAborted()) break;
      recentUserMessages = [
        ...recentUserMessageTexts(page.messages, options.currentUserMessageId),
        ...recentUserMessages,
      ].slice(-MEMORY_CONTEXT_MAX_RECENT_MESSAGES);
      before = page.before;
    }
    return {
      recentUserMessages,
      // Prefer the per-chat description (scoped to this conversation) over the
      // worktree-level summary description.
      summaryDescription:
        tab?.description?.trim() ||
        worktreeSummary?.description?.trim() ||
        null,
    };
  } catch {
    return EMPTY_CONTEXT;
  }
}
