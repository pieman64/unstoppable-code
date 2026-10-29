import {
  isLiveSubagentStatus,
  type SubagentNode,
} from '@canopy/agent-transcript';

/** Compact duration: `42s`, `7m`, `2h 5m`. Negative or invalid input is empty. */
export function formatSubagentDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Wall time of the current or last run: live runs count up to `now`, settled
 * runs to when they settled. Empty when the tree carries no start time.
 */
export function formatSubagentElapsed(
  node: Pick<SubagentNode, 'status' | 'startedAt' | 'createdAt' | 'settledAt'>,
  now: number,
): string {
  const start = node.startedAt ?? node.createdAt;
  if (start === undefined) return '';
  const end =
    node.settledAt ??
    (isLiveSubagentStatus(node.status) || node.status === 'idle'
      ? now
      : undefined);
  if (end === undefined) return '';
  return formatSubagentDuration(end - start);
}
