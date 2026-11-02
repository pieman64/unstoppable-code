const CLAUDE_AGENT_ID_PATTERN = /agentId:\s*([A-Za-z0-9._-]+)/i;
const PENDING_TASK_OUTPUT_PATTERN =
  /retrieval_status\W*(?:not_ready|timeout)\b/i;

/** The agent id a Claude Agent/Task launch receipt names, if any. */
export function claudeLaunchedAgentId(output: string): string | undefined {
  return CLAUDE_AGENT_ID_PATTERN.exec(output)?.[1];
}

/**
 * Whether a TaskOutput read returned before its task finished (a non-blocking
 * read of a running task, or a blocking read that timed out). Such a read
 * carries no final result.
 */
export function isPendingTaskOutput(output: string): boolean {
  return PENDING_TASK_OUTPUT_PATTERN.test(output);
}
