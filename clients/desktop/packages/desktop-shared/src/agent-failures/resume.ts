/** Continuation nudge shared with chat usage-limit recovery. */
export { USAGE_LIMIT_RESUME_CONTINUE_PROMPT as AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT } from '../lib/usage-limit-resume-prompt';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return the Claude session established by an SDK event. No id means the
 * provider never proved that a resumable session started, so retry callers
 * must replay the task in a fresh session.
 */
export function readClaudeRetrySessionId(event: unknown): string | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const sessionId = event.session_id;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId
    : undefined;
}
