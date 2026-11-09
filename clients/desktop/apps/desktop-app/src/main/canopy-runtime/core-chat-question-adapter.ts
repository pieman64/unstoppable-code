import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
  canopyUnavailableError,
  type CanopyDispatcherInstructionHandlerMap,
} from '@canopy/core-runtime';
import type { CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import type {
  ChatCancelRequest,
  ChatStateSnapshot,
  McpQuestionAnswer,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type {
  ChatQuestionRespondOutcome,
  ChatQuestionResponse,
  RespondToChatQuestionRequest,
} from '../chat-questions/respond';
import { chatSummaryOf } from './core-chat-turn-adapter';

/** Desktop effects behind `core.chat.question.respond` (CAN-4128). */
export interface CoreChatQuestionHost {
  /** The same lookup core.chat.turn.cancel uses (turn ownership and the chat-search index). */
  scopesForChat(chatId: string): Promise<readonly ChatCancelRequest[]>;
  getState(scope: ChatCancelRequest): Promise<ChatStateSnapshot>;
  /** The live core wait's scope for this question, or null. */
  liveScope(questionId: string): ChatCancelRequest | null;
  respond(
    request: RespondToChatQuestionRequest,
  ): Promise<ChatQuestionRespondOutcome>;
}

/**
 * The trusted renderer relay principals of this app's own windows
 * (renderer-relay/trusted-surface.ts): the only callers of this operation
 * whose answer is a person's. Every other caller's answer is an agent's.
 */
const PERSON_PRINCIPAL_IDS: ReadonlySet<string> = new Set([
  'local-desktop-renderer:main',
  'local-desktop-renderer:app-advisor',
]);

export const QUESTION_ANSWER_SHAPE_MESSAGE =
  'Send answers keyed by question ID, or dismissed: true.';

type QuestionHandlers = Pick<
  CanopyDispatcherInstructionHandlerMap<
    typeof CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS
  >,
  'core.chat.question.respond'
>;

const AnswerValueSchema = z.strictObject({
  selectedOptions: z.array(z.string().max(1_024)).max(64),
  freeformText: z.string().max(16_384).optional(),
});

const notFound = (): CanopyOperationError =>
  new CanopyOperationError({
    kind: 'not_found',
    code: 'core.chat.question.notFound',
    message: 'The question was not found.',
    retry: { kind: 'never' },
  });

const unavailable = (): CanopyOperationError =>
  canopyUnavailableError('Chat state is unavailable.', {
    kind: 'same_request',
    delayMs: 1_000,
  });

/** Stored order and question text; a question's key is its id, else its index. */
function answersInStoredOrder(
  question: PersistedPendingQuestion,
  answers: Readonly<Record<string, unknown>>,
): McpQuestionAnswer[] {
  const keys = question.questions.map(
    (stored, index) => stored.id ?? String(index),
  );
  if (
    Object.keys(answers).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(answers, key))
  )
    throw canopyInvalidArgumentError(QUESTION_ANSWER_SHAPE_MESSAGE);
  return question.questions.map((stored, index) => {
    const parsed = AnswerValueSchema.safeParse(answers[keys[index] ?? '']);
    if (!parsed.success)
      throw canopyInvalidArgumentError(QUESTION_ANSWER_SHAPE_MESSAGE);
    const { selectedOptions, freeformText } = parsed.data;
    return {
      ...(stored.id ? { questionId: stored.id } : {}),
      question: stored.question,
      selectedOptions,
      ...(freeformText !== undefined ? { freeformText } : {}),
    };
  });
}

export function createCoreChatQuestionAdapter(
  host: CoreChatQuestionHost,
): QuestionHandlers {
  return {
    'core.chat.question.respond': async (
      params,
      context,
    ): Promise<NonNullable<ReturnType<typeof chatSummaryOf>>> => {
      const { chatId, questionId, answers, dismissed } = params;
      const shapeValid =
        dismissed === true
          ? answers === undefined
          : answers !== undefined && Object.keys(answers).length > 0;
      if (!shapeValid)
        throw canopyInvalidArgumentError(QUESTION_ANSWER_SHAPE_MESSAGE);

      const candidates = new Map<string, ChatCancelRequest>();
      const live = host.liveScope(questionId);
      if (live && live.chatId === chatId)
        candidates.set(`${live.projectId}/${live.worktreeId}`, live);
      for (const scope of await host.scopesForChat(chatId)) {
        const key = `${scope.projectId}/${scope.worktreeId}`;
        if (!candidates.has(key)) candidates.set(key, scope);
      }
      let found:
        | { scope: ChatCancelRequest; question: PersistedPendingQuestion }
        | undefined;
      let readFailed = false;
      for (const scope of candidates.values()) {
        let state: ChatStateSnapshot;
        try {
          state = await host.getState(scope);
        } catch {
          // An unreadable scope must not hide the question in another one.
          readFailed = true;
          continue;
        }
        const question = state.tabsFile.pendingQuestions?.find(
          (item) => item.requestId === questionId && item.chatId === chatId,
        );
        if (question) {
          found = { scope, question };
          break;
        }
      }
      if (!found) {
        if (readFailed) throw unavailable();
        throw notFound();
      }

      const response: ChatQuestionResponse =
        dismissed === true
          ? { kind: 'dismiss' }
          : {
              kind: 'answer',
              answers: answersInStoredOrder(found.question, answers ?? {}),
            };
      const { scope } = found;
      const outcome = await host.respond({
        scope: { projectId: scope.projectId, worktreeId: scope.worktreeId },
        chatId,
        questionId,
        response,
        commandId: randomUUID(),
        ...(PERSON_PRINCIPAL_IDS.has(context.caller.principalId)
          ? { executionOptions: { answeredByPerson: true } }
          : {}),
      });
      switch (outcome.status) {
        case 'applied': {
          const summary = chatSummaryOf(await host.getState(scope), chatId);
          if (!summary) throw notFound();
          return summary;
        }
        case 'already_settled':
        case 'cancelled':
          throw new CanopyOperationError({
            kind: 'failed_precondition',
            code: 'core.chat.question.invalidState',
            message: 'The question is already settled.',
            retry: {
              kind: 'after_refresh',
              resource: 'core.chat.snapshot.get',
            },
          });
        case 'not_found':
          throw notFound();
        case 'invalid':
          throw canopyInvalidArgumentError(outcome.message);
        case 'conflict':
          throw new CanopyOperationError({
            kind: 'failed_precondition',
            code: 'core.chat.question.revisionConflict',
            message: 'The chat changed; read it again.',
            retry: {
              kind: 'after_refresh',
              resource: 'core.chat.snapshot.get',
            },
          });
        case 'unavailable':
          throw unavailable();
      }
    },
  };
}
