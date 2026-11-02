import type { AnsweredQuestionDisplay } from './AskUserQuestionCard';

// Display parser for the existing Q:/A:/Additional: transcript format. Kept
// browser-safe so every transcript host uses the same anchored parser.
const ASK_USER_ANSWER_SEPARATOR = '\n\n';
const ASK_USER_ANSWER_PREFIX = 'Q: ';
const ASK_USER_ANSWER_VALUE_PREFIX = '\nA: ';
const ASK_USER_ANSWER_ADDITIONAL_PREFIX = '\nAdditional: ';
const FALLBACK_SUFFIX = '\n\n[Sent as message fallback]';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseQuestions(
  input: string,
): Array<{ question: string; secret: boolean }> | null {
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
  const questions: Array<{ question: string; secret: boolean }> = [];
  for (const entry of parsed.questions) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return null;
    }
    questions.push({ question: entry.question, secret: entry.secret === true });
  }
  return questions;
}

export function parseAskUserQuestionAnswers(
  input: string,
  output: string,
): AnsweredQuestionDisplay[] | null {
  const questions = parseQuestions(input);
  if (!questions) {
    return null;
  }
  const normalizedOutput = output.endsWith(FALLBACK_SUFFIX)
    ? output.slice(0, -FALLBACK_SUFFIX.length)
    : output;

  const answers: AnsweredQuestionDisplay[] = [];
  let cursor = 0;
  for (let i = 0; i < questions.length; i++) {
    const marker = `${ASK_USER_ANSWER_PREFIX}${questions[i].question}${ASK_USER_ANSWER_VALUE_PREFIX}`;
    const start = normalizedOutput.indexOf(marker, cursor);
    if (start === -1) {
      return null;
    }
    const bodyStart = start + marker.length;

    let bodyEnd = normalizedOutput.length;
    const nextQuestion = questions[i + 1]?.question;
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
      answers.push({ question: questions[i].question, answer: body.trim() });
    } else {
      answers.push({
        question: questions[i].question,
        answer: body.slice(0, additionalIndex).trim(),
        additional: questions[i].secret
          ? '[hidden]'
          : body
              .slice(additionalIndex + ASK_USER_ANSWER_ADDITIONAL_PREFIX.length)
              .trim(),
        ...(questions[i].secret ? { secret: true } : {}),
      });
    }
    cursor = bodyEnd;
  }

  return answers;
}
