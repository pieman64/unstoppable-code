/**
 * Whether a settled App Advisor renderer response may be replayed for a
 * repeated request id. A success or a definitive failure is replayed, so a
 * stage that ran never runs twice. A retryable failure did not complete its
 * stage, so a later attempt with the same request id runs it again.
 */
export function isReplayableAppAdvisorResponse(response: {
  ok: boolean;
  error?: { retryable?: boolean };
}): boolean {
  return response.ok || response.error?.retryable !== true;
}
