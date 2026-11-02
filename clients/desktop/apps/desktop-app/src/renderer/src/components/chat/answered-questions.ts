// Compatibility entry point for desktop callers and parser conformance tests.
// All hosts share the browser-safe display parser.
export {
  parseAskUserQuestionAnswers as parseAnsweredQuestions,
  type AnsweredQuestionDisplay as AnsweredQuestion,
} from '@canopy/ui-shared/components';
