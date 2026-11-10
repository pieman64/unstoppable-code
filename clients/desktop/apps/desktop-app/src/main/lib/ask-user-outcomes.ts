/**
 * A question a person dismissed without answering. It keeps the transport's
 * own message, so the AskUserQuestion tool result is unchanged; callers that
 * act on the answer tell a dismissal apart from a question nobody could see.
 */
export class AskUserDismissedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AskUserDismissedError';
  }
}

const ASK_USER_DISMISSAL_MESSAGES: ReadonlySet<string> = new Set([
  'ask_user_cancelled',
  'cancelled',
  'ask_user_timeout',
  'User dismissed',
]);

/**
 * Whether a failed question was dismissed, timed out or stopped, as opposed
 * to one nobody could be asked, which callers acting on the answer treat as
 * a closed failure.
 */
export function isAskUserDismissal(error: unknown): boolean {
  return (
    error instanceof AskUserDismissedError ||
    (error instanceof Error && ASK_USER_DISMISSAL_MESSAGES.has(error.message))
  );
}

/** One question's answers, with each answer's provenance. */
export type RequestPersonAnswers = (
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
    allowOther?: boolean;
  }>,
) => Promise<
  Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
>;

/**
 * Asks a person to confirm before an agent acts. Only a person's answer
 * choosing `confirm` confirms; a dismissal or any other option declines, and
 * no one to ask, an agent's answer or one of unknown origin never confirms.
 */
export async function askPersonToConfirm(
  requestAnswers: RequestPersonAnswers,
  question: string,
  options: { confirm: string; decline: string },
): Promise<'confirmed' | 'declined' | 'no_person'> {
  let answers: Awaited<ReturnType<RequestPersonAnswers>>;
  try {
    answers = await requestAnswers([
      {
        question,
        options: [options.confirm, options.decline],
        multiSelect: false,
        allowOther: false,
      },
    ]);
  } catch (error) {
    return isAskUserDismissal(error) ? 'declined' : 'no_person';
  }
  const answer = answers[0];
  if (answer?.answeredBy !== 'person') return 'no_person';
  return answer.selectedOptions.includes(options.confirm)
    ? 'confirmed'
    : 'declined';
}
