import type { UsageLimitedSessionGroup } from '@canopy/desktop-shared/types';

/**
 * Compact view of every idle interrupted session the app knows about —
 * usage limits, authentication failures, and application stops, across all
 * providers — as returned by `listUsageLimitedIdleSessions({})`.
 */
export interface InterruptedSessionsSummary {
  count: number;
  /**
   * Order-independent identity of the interrupted set. Two summaries with
   * the same signature describe the same sessions, which is what a
   * dismissal is keyed to: the Home banner stays hidden while the set is
   * unchanged and returns as soon as it differs.
   */
  signature: string;
}

export const EMPTY_INTERRUPTED_SESSIONS: InterruptedSessionsSummary = {
  count: 0,
  signature: '',
};

function sessionKey(
  session: UsageLimitedSessionGroup['sessions'][number],
): string {
  return session.kind === 'chat'
    ? `chat:${session.projectId}/${session.worktreeId}/${session.chatId}`
    : `pipeline:${session.executionId}`;
}

export function summarizeInterruptedSessions(
  groups: UsageLimitedSessionGroup[],
): InterruptedSessionsSummary {
  const keys = groups.flatMap((group) => group.sessions.map(sessionKey)).sort();
  if (keys.length === 0) {
    return EMPTY_INTERRUPTED_SESSIONS;
  }
  return { count: keys.length, signature: keys.join('\n') };
}

/**
 * The banner shows whenever something is interrupted, unless the user
 * dismissed exactly this interrupted set.
 */
export function shouldShowInterruptedSessionsBanner(
  summary: InterruptedSessionsSummary,
  dismissedSignature: string | null,
): boolean {
  return summary.count > 0 && summary.signature !== dismissedSignature;
}
