import { type JSX } from 'react';
import {
  AnsweredQuestionsBlock as SharedAnsweredQuestionsBlock,
  type AnsweredQuestionDisplay,
} from '@canopy/ui-shared/components';
import type { AnsweredQuestion } from './answered-questions';

/**
 * Thin wrapper mapping the desktop `parseAnsweredQuestions` output onto the
 * shared `@canopy/ui-shared` answered-display shape. The parser
 * (`answered-questions.ts`) already reconstructs the joined answer + optional
 * freeform (`[hidden]` for secrets is baked into the persisted output), so this
 * only reshapes fields. Test ids (`answered-questions` / `answered-question`)
 * are owned by the shared block.
 */
export function AnsweredQuestionsBlock({
  answers,
}: {
  answers: AnsweredQuestion[];
}): JSX.Element {
  const display: AnsweredQuestionDisplay[] = answers.map((answer) => ({
    question: answer.question,
    answer: answer.answer,
    ...(answer.additional ? { additional: answer.additional } : {}),
  }));
  return <SharedAnsweredQuestionsBlock answers={display} />;
}
