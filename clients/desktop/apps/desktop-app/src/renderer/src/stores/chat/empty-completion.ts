// Empty-completion recovery (CAN-2307).
//
// The main process decides whether a turn finished with no visible output and
// records `ChatRuntimeState.emptyCompletionRecovery`. This module is the
// renderer's pure read side: it turns that record plus the projected
// transcript into what the composer needs to render the recovery notice and
// what the store needs to dispatch its two send actions.
//
// Nothing here ever retries on its own. `automaticRetryAllowed` is typed
// `false` on the wire for exactly that reason, and both actions below are only
// ever reached from an explicit click.
import { USAGE_LIMIT_RESUME_CONTINUE_PROMPT } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import type {
  ChatAttachmentPromptContext,
  EmptyCompletionRecovery,
  FileReference,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';

/**
 * The nudge "Resume" sends. It asks the SAME provider session to finish the
 * turn it already has the history for, so a tool call that already ran is not
 * re-issued — the model sees its own completed work first.
 */
export const EMPTY_COMPLETION_RESUME_PROMPT =
  USAGE_LIMIT_RESUME_CONTINUE_PROMPT;

/** What "Try again" re-sends: the original turn's prompt, verbatim. */
export interface EmptyCompletionRetryPrompt {
  text: string;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  inputMode?: 'typed' | 'voice';
}

/**
 * Composer-facing projection of the recovery record.
 *
 * `ActiveComposerView` deliberately carries these as three FLAT fields rather
 * than this object: that projection is read through `useShallow`, so a freshly
 * built nested object would never compare equal and would re-render the
 * composer forever. The object is reassembled (memoized) at the one component
 * that renders the notice.
 */
export interface EmptyCompletionRecoveryView {
  turnUserMessageId: string;
  /**
   * True when the empty turn already issued at least one tool call. Answers
   * the ticket's "what makes a tool action consequential" for this surface:
   * any `tool_use` the agent emitted in the turn, whether or not a result came
   * back. An unanswered call is the WORSE case — the app cannot see whether
   * the side effect landed — so it counts too. Re-sending the original prompt
   * can repeat that work, which is why "Resume" leads and "Try again" is
   * labelled as the second choice when this is set.
   */
  repeatsToolActivity: boolean;
  /** False when the original prompt could not be recovered (no text to re-send). */
  canRetryPrompt: boolean;
}

function indexOfTurnUserMessage(
  messages: readonly PersistedChatMessage[],
  turnUserMessageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === turnUserMessageId && message.role === 'user',
  );
}

/**
 * Recover the prompt that opened the empty turn so the user never retypes it.
 * Returns `null` when the turn's user message is gone from the projected
 * window or carried no text (an attachment-only turn has nothing to re-send as
 * a prompt).
 */
export function buildEmptyCompletionRetryPrompt(
  messages: readonly PersistedChatMessage[],
  turnUserMessageId: string,
): EmptyCompletionRetryPrompt | null {
  const index = indexOfTurnUserMessage(messages, turnUserMessageId);
  if (index < 0) return null;
  const message = messages[index];
  if (!message) return null;

  const text = message.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
  if (text.length === 0) return null;

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
 * Whether the empty turn issued any tool call. Scoped to the turn, not the
 * whole transcript: earlier turns' tools are already settled and a retry of
 * THIS prompt cannot repeat them.
 */
export function emptyCompletionTurnRanTools(
  messages: readonly PersistedChatMessage[],
  turnUserMessageId: string,
): boolean {
  const index = indexOfTurnUserMessage(messages, turnUserMessageId);
  if (index < 0) return false;
  return messages
    .slice(index + 1)
    .some(
      (message) =>
        message.role !== 'user' &&
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' || block.type === 'codex_agent_call',
        ),
    );
}

/**
 * Build the composer view, or `undefined` when there is no recovery to show.
 */
export function computeEmptyCompletionRecoveryView(
  recovery: EmptyCompletionRecovery | undefined,
  messages: readonly PersistedChatMessage[],
): EmptyCompletionRecoveryView | undefined {
  if (!recovery) return undefined;
  return {
    turnUserMessageId: recovery.turnUserMessageId,
    repeatsToolActivity: emptyCompletionTurnRanTools(
      messages,
      recovery.turnUserMessageId,
    ),
    canRetryPrompt:
      buildEmptyCompletionRetryPrompt(messages, recovery.turnUserMessageId) !==
      null,
  };
}
