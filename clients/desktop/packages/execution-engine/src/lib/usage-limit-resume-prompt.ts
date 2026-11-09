import type { UsageLimitedChatItem } from '../execution-types';
import type {
  ChatAttachmentPromptContext,
  FileReference,
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript';

/**
 * Default resume prompt. Used when the last turn already contained agent
 * activity (the agent did at least one thing before the usage limit hit), so a
 * plain "keep going" nudge is the right resume.
 */
export const USAGE_LIMIT_RESUME_CONTINUE_PROMPT = 'Continue';

export interface UsageLimitResumePrompt {
  /** Text to dispatch to resume the usage-limited chat. */
  text: string;
  /** File references from the original user message, when re-sending it. */
  fileReferences?: FileReference[];
  /** Attached file paths from the original user message, when re-sending it. */
  attachmentPaths?: string[];
  /** Prompt treatment metadata for attached files, when re-sending them. */
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  /** Original authoring mode, when known. */
  inputMode?: 'typed' | 'voice';
  /**
   * `true` when {@link text} re-sends the user's last message because the last
   * turn was just a user prompt that hit the usage limit before the agent did
   * anything; `false` when it falls back to {@link USAGE_LIMIT_RESUME_CONTINUE_PROMPT}.
   */
  resendsUserMessage: boolean;
}

/**
 * Blocks that unambiguously mean the agent produced output in a turn:
 * images, assistant thinking, tool calls, tool results, or a Codex subagent call.
 * `text` is handled separately (only non-empty assistant text counts).
 */
export function isAgentActivityBlock(block: PersistedChatBlock): boolean {
  return (
    block.type === 'image' ||
    block.type === 'thinking' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'codex_agent_call'
  );
}

/**
 * Whether a post-user-message transcript message represents the agent actually
 * doing something. Assistant messages count when they carry any non-empty text
 * or an activity block; tool-result system messages count too. Pure layout
 * system messages (turn timers, hook/automation info, etc.) do not.
 */
export function messageHasAgentActivity(
  message: PersistedChatMessage,
): boolean {
  if (message.role === 'user') {
    return false;
  }
  return message.blocks.some((block) => {
    if (block.type === 'text') {
      return message.role === 'assistant' && block.text.trim().length > 0;
    }
    return isAgentActivityBlock(block);
  });
}

/** True when any projected transcript message contains semantic agent work. */
export function transcriptHasAgentActivity(
  messages: readonly PersistedChatMessage[],
): boolean {
  return messages.some(messageHasAgentActivity);
}

function extractUserMessagePayload(
  message: PersistedChatMessage,
): Omit<UsageLimitResumePrompt, 'resendsUserMessage'> | null {
  const text = message.blocks
    .filter(
      (block): block is Extract<PersistedChatBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (text.length === 0) {
    return null;
  }

  const fileReferences = message.blocks.flatMap((block) =>
    block.type === 'file_references' ? block.references : [],
  );

  return {
    text,
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
    ...(message.attachmentPaths?.length
      ? { attachmentPaths: message.attachmentPaths }
      : {}),
    ...(message.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: message.attachmentPromptContexts }
      : {}),
    ...(message.inputMode ? { inputMode: message.inputMode } : {}),
  };
}

/**
 * Decide what a usage-limit resume should dispatch into a chat.
 *
 * If the last turn was simply the user's message immediately hitting the usage
 * limit — i.e. nothing after the last user message shows any agent activity —
 * the agent never got to process it, so resume by re-sending the user's last
 * message. Otherwise the agent already did work in that turn, so resume with
 * the plain {@link USAGE_LIMIT_RESUME_CONTINUE_PROMPT} nudge.
 *
 * The usage-limit rejection itself is never persisted as a transcript block
 * (it lives on the tab's banner state), so this only inspects the message list.
 * Callers should only invoke it for chats already known to be usage-limited.
 */
export function computeUsageLimitResumePrompt(
  messages: readonly PersistedChatMessage[],
): UsageLimitResumePrompt {
  const fallback: UsageLimitResumePrompt = {
    text: USAGE_LIMIT_RESUME_CONTINUE_PROMPT,
    resendsUserMessage: false,
  };

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return fallback;
  }

  for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && messageHasAgentActivity(message)) {
      return fallback;
    }
  }

  const payload = extractUserMessagePayload(messages[lastUserIndex]);
  if (!payload) {
    return fallback;
  }
  return { ...payload, resendsUserMessage: true };
}

/** Missing, empty or promptless history cannot support a confident preview. */
export function describeUsageLimitResumePromptKind(
  messages: readonly PersistedChatMessage[] | undefined,
): UsageLimitedChatItem['resumePromptKind'] {
  if (
    !messages?.some(
      (message) =>
        message.role === 'user' &&
        (message.blocks.length === 0 ||
          !message.blocks.every((block) => block.type === 'tool_result')),
    )
  )
    return undefined;
  return computeUsageLimitResumePrompt(messages).resendsUserMessage
    ? 'resend_user_message'
    : 'continue';
}
