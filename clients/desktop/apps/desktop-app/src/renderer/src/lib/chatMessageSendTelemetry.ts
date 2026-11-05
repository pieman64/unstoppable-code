import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from './cowork';

/**
 * `chat:message_send` (CAN-4630): one event each time the user submits a
 * message from a chat composer, recorded at submit and before dispatch so a
 * send that fails before its turn starts still counts. Turns report their own
 * end through `chat:turn_end`.
 *
 * Context is bounded: the surface, the composer mode (`plan` or `default`),
 * whether a suggested prompt was used, the chosen provider and model, and the
 * composer's billing prediction.
 * Message text, chat ids and project ids are never recorded.
 */

const OPERATION_NAME = 'canopy.chat_message_send';

export type ChatMessageSendSurface =
  | 'home'
  | 'worktree_chat'
  | 'standalone_chat'
  | 'app_advisor';

/** Suggested-prompt key for the Home composer; chat composers use their tab id. */
export const HOME_COMPOSER_KEY = 'home';

/** Composers with a suggested prompt inserted since their last send. */
const composersWithSuggestedPrompt = new Set<string>();

/**
 * The surface a chat composer sends from, or `null` for the Pipeline Editor
 * assistant, which is not a chat the user started.
 */
export function chatMessageSendSurfaceForProject(
  projectId: string,
): Exclude<ChatMessageSendSurface, 'home'> | null {
  if (projectId === PIPELINE_EDITOR_PROJECT_ID) return null;
  if (projectId === APP_ADVISOR_PROJECT_ID) return 'app_advisor';
  return isCoworkChatTarget(projectId) ? 'standalone_chat' : 'worktree_chat';
}

/**
 * Records that a suggested prompt was inserted into a composer. The next send
 * from that composer reports it, even if the user edited the text first.
 */
export function markSuggestedPromptInserted(composerKey: string): void {
  composersWithSuggestedPrompt.add(composerKey);
}

export function trackChatMessageSend(input: {
  surface: ChatMessageSendSurface;
  /** The composer's suggested-prompt key; `undefined` when it has none. */
  composerKey: string | undefined;
  provider?: string;
  model?: string;
  /** Auto chooses the model per turn, so neither the fallback model nor its provider is the user's choice. */
  isAutoModel?: boolean;
  isAiCreditsBilled: boolean;
  /** The composer's effective plan state at submit (CAN-5382). */
  isPlanMode: boolean;
}): void {
  const provider = input.isAutoModel ? undefined : input.provider;
  const model = input.isAutoModel ? 'auto' : input.model;
  const isSuggestedPrompt =
    input.composerKey !== undefined &&
    composersWithSuggestedPrompt.delete(input.composerKey);
  const context = {
    chat_surface: input.surface,
    composer_mode: input.isPlanMode ? 'plan' : 'default',
    is_suggested_prompt: isSuggestedPrompt,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    is_ai_credits_billed: input.isAiCreditsBilled,
  };
  try {
    startClientOperation(OPERATION_NAME, { context });
    succeedClientOperation(OPERATION_NAME, { context });
  } catch {
    // Instrumentation must never affect the send path.
  }
}

/**
 * A send from a chat tab's composer (worktree, standalone and App Advisor
 * chats). Nothing is sent for the Pipeline Editor or an untargeted composer.
 */
export function trackChatComposerSend(input: {
  target: { projectId: string; chatId: string } | undefined;
  provider?: string;
  model?: string;
  isAutoModel?: boolean;
  isAiCreditsBilled: boolean;
  /** The composer's availability-gated plan state at submit. */
  isPlanMode: boolean;
}): void {
  const { target, ...send } = input;
  if (!target) return;
  const surface = chatMessageSendSurfaceForProject(target.projectId);
  if (!surface) return;
  trackChatMessageSend({ surface, composerKey: target.chatId, ...send });
}
