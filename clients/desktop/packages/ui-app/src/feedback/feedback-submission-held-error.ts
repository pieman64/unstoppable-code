/**
 * Thrown by a host's `onSubmit` when nothing was sent because the host is
 * already showing the choice the person has to make. The form stays as it is.
 */
export class FeedbackSubmissionHeldError extends Error {
  constructor() {
    super('The report was not sent.');
    this.name = 'FeedbackSubmissionHeldError';
  }
}
