import {
  MODEL_ROUTING_MAX_PROMPT_CHARACTERS,
  truncateAutoModelRoutingRecentMessages,
  type AutoModelRoutingRequestV1,
  type AutoModelRoutingRecentMessage,
} from '@canopy/protocol/model-routing';
import type {
  ChatSendMessageRequest,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
} from '@canopy/desktop-shared/lib/codex-speed';
import { extname } from 'node:path';
import { assertAutoRoutingCodexSpeed } from '../codex/speed-policy';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.svg',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
]);

function messageText(
  message: PersistedChatTab['messages'][number],
): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const text = message.blocks
    .filter(
      (block): block is Extract<typeof block, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

function recentMessages(
  tab: PersistedChatTab,
  currentUserMessageId: string,
): AutoModelRoutingRecentMessage[] {
  return truncateAutoModelRoutingRecentMessages(
    tab.messages
      .filter((message) => message.id !== currentUserMessageId)
      .flatMap((message) => {
        const text = messageText(message);
        return text && (message.role === 'user' || message.role === 'assistant')
          ? [{ role: message.role, text }]
          : [];
      }),
  );
}

/**
 * The routing wire contract only knows Fast on/off. Read the exact speed
 * (enum before legacy boolean/alias); Ultra fast is never collapsed into
 * Regular — Auto cannot honor it, so it is rejected before routing.
 */
function autoRoutingFastMode(request: ChatSendMessageRequest): boolean {
  const speed =
    readCodexSpeedRecord(request.modelConfig, request.codexFastModeEnabled) ??
    DEFAULT_CODEX_SPEED;
  assertAutoRoutingCodexSpeed(speed);
  return speed === 'fast';
}

export function buildDesktopAutoRoutingState(input: {
  request: ChatSendMessageRequest;
  tab: PersistedChatTab;
  workspace: 'single-repo' | 'multi-repo' | 'cowork';
}): AutoModelRoutingRequestV1['state'] {
  const { request, tab } = input;
  const paths = new Set([
    ...(request.fileReferences?.map((reference) => reference.absolutePath) ??
      []),
    ...(request.attachmentPaths ?? []),
    ...(request.attachmentPromptContexts?.map(
      (context) => context.attachmentPath,
    ) ?? []),
  ]);
  const attachmentCounts = { files: 0, images: 0, documents: 0 };
  for (const path of Array.from(paths)) {
    const extension = extname(path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) attachmentCounts.images += 1;
    else if (DOCUMENT_EXTENSIONS.has(extension))
      attachmentCounts.documents += 1;
    else attachmentCounts.files += 1;
  }
  return {
    // Bounded to the wire contract: the server rejects a longer prompt
    // outright, so an untruncated paste would fail the whole decision rather
    // than degrade it. The head is kept because that is where the ask is.
    prompt: request.text.slice(0, MODEL_ROUTING_MAX_PROMPT_CHARACTERS),
    recentMessages: recentMessages(tab, request.userMessageId),
    attachmentCounts,
    mode: {
      task: request.planMode === true ? 'plan' : 'execute',
      ...(request.approvalMode ? { approval: request.approvalMode } : {}),
      ...(request.codexProposalMode
        ? { proposal: request.codexProposalMode }
        : {}),
      ...(request.modelConfig?.thinkingLevel
        ? { thinkingLevel: request.modelConfig.thinkingLevel }
        : request.thinkingLevel
          ? { thinkingLevel: request.thinkingLevel }
          : {}),
      fast: autoRoutingFastMode(request),
      workspace: input.workspace,
    },
  };
}
