import {
  ASK_USER_ANSWER_ADDITIONAL_PREFIX,
  ASK_USER_ANSWER_PREFIX,
  ASK_USER_ANSWER_SEPARATOR,
  ASK_USER_ANSWER_VALUE_PREFIX,
  stripSentAsMessageFallbackMarker,
} from '@canopy/desktop-shared/lib/ask-user-answers';

/**
 * Reconstructs the structured answers for an answered `AskUserQuestion` tool
 * call from its persisted tool input and result output.
 *
 * The tool input carries the questions as JSON (`{ questions: [{ question }] }`)
 * and the result output is the `Q:/A:/Additional:` text produced by the shared
 * `formatAskUserAnswers` helper. Because the result echoes each
 * question verbatim, we anchor on the exact question strings from the input so
 * parsing stays correct even when a question or free-form answer contains blank
 * lines.
 *
 * Returns `null` when the pair cannot be confidently parsed so callers can fall
 * back to the generic tool-call rendering rather than show a malformed answer.
 */

export interface AnsweredQuestion {
  /** The original question text, exactly as it was asked. */
  question: string;
  /** The user's selected option(s), formatted as the agent received them. */
  answer: string;
  /** Optional free-form ("Other") text the user supplied alongside. */
  additional?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseQuestionTexts(input: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.questions)) {
    return null;
  }
  if (parsed.questions.length === 0) {
    return null;
  }
  const texts: string[] = [];
  for (const entry of parsed.questions) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return null;
    }
    texts.push(entry.question);
  }
  return texts;
}

export function parseAnsweredQuestions(
  input: string,
  output: string,
): AnsweredQuestion[] | null {
  const questions = parseQuestionTexts(input);
  if (!questions) {
    return null;
  }
  const normalizedOutput = stripSentAsMessageFallbackMarker(output);

  const answers: AnsweredQuestion[] = [];
  let cursor = 0;
  for (let i = 0; i < questions.length; i++) {
    const marker = `${ASK_USER_ANSWER_PREFIX}${questions[i]}${ASK_USER_ANSWER_VALUE_PREFIX}`;
    const start = normalizedOutput.indexOf(marker, cursor);
    if (start === -1) {
      return null;
    }
    const bodyStart = start + marker.length;

    let bodyEnd = normalizedOutput.length;
    const nextQuestion = questions[i + 1];
    if (nextQuestion !== undefined) {
      const nextMarker = `${ASK_USER_ANSWER_SEPARATOR}${ASK_USER_ANSWER_PREFIX}${nextQuestion}${ASK_USER_ANSWER_VALUE_PREFIX}`;
      const nextStart = normalizedOutput.indexOf(nextMarker, bodyStart);
      if (nextStart !== -1) {
        bodyEnd = nextStart;
      }
    }

    const body = normalizedOutput.slice(bodyStart, bodyEnd);
    const additionalIndex = body.indexOf(ASK_USER_ANSWER_ADDITIONAL_PREFIX);
    if (additionalIndex === -1) {
      answers.push({ question: questions[i], answer: body.trim() });
    } else {
      answers.push({
        question: questions[i],
        answer: body.slice(0, additionalIndex).trim(),
        additional: body
          .slice(additionalIndex + ASK_USER_ANSWER_ADDITIONAL_PREFIX.length)
          .trim(),
      });
    }
    cursor = bodyEnd;
  }

  return answers;
}
