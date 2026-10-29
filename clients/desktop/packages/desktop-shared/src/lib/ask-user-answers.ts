import type { McpQuestionAnswer } from '../types';

export const ASK_USER_ANSWER_SEPARATOR = '\n\n';
export const ASK_USER_ANSWER_PREFIX = 'Q: ';
export const ASK_USER_ANSWER_VALUE_PREFIX = '\nA: ';
export const ASK_USER_ANSWER_ADDITIONAL_PREFIX = '\nAdditional: ';
export const SENT_AS_MESSAGE_FALLBACK_MARKER = '[Sent as message fallback]';
export const SENT_AS_MESSAGE_FALLBACK_SUFFIX = `${ASK_USER_ANSWER_SEPARATOR}${SENT_AS_MESSAGE_FALLBACK_MARKER}`;

export function formatAskUserAnswers(answers: McpQuestionAnswer[]): string {
  return answers
    .map((answer) => {
      let text = `${ASK_USER_ANSWER_PREFIX}${answer.question}${ASK_USER_ANSWER_VALUE_PREFIX}${answer.selectedOptions.join(', ')}`;
      if (answer.freeformText) {
        text += `${ASK_USER_ANSWER_ADDITIONAL_PREFIX}${answer.freeformText}`;
      }
      return text;
    })
    .join(ASK_USER_ANSWER_SEPARATOR);
}

export function appendSentAsMessageFallbackMarker(output: string): string {
  return `${output}${SENT_AS_MESSAGE_FALLBACK_SUFFIX}`;
}

export function stripSentAsMessageFallbackMarker(output: string): string {
  return output.endsWith(SENT_AS_MESSAGE_FALLBACK_SUFFIX)
    ? output.slice(0, -SENT_AS_MESSAGE_FALLBACK_SUFFIX.length)
    : output;
}
