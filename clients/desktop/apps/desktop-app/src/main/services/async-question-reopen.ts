import type {
  ChatCoreMutation,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';

/**
 * Opens an answered async question again when its answer became ordinary
 * text (the user edited or cancelled it), so the question card asks again.
 * Returns no mutation when the question is missing or still unanswered.
 */
export function reopenAsyncQuestionMutations(
  pendingQuestions: readonly PersistedPendingQuestion[] | undefined,
  chatId: string,
  questionId: string,
): ChatCoreMutation[] {
  const answeredQuestion = pendingQuestions?.find(
    (question) =>
      question.requestId === questionId &&
      question.chatId === chatId &&
      question.delivery === 'async' &&
      question.answeredAt !== undefined,
  );
  if (!answeredQuestion) return [];
  const {
    answeredAt: _answeredAt,
    answers: _answers,
    dismissedAt: _dismissedAt,
    ...pendingQuestion
  } = answeredQuestion;
  void _answeredAt;
  void _answers;
  void _dismissedAt;
  return [{ type: 'pending_question.upserted', question: pendingQuestion }];
}
