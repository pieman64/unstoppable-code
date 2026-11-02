import type { ScheduledActivity } from '@canopy/desktop-shared/types';

/**
 * Exact chat identity a usage-limit resume automation targets. `workspaceId`
 * is the automation action's workspace, which is the chat's project id.
 */
export interface ScheduledResumeChatKey {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/**
 * Whether `activity` is an enabled usage-limit resume for exactly this chat
 * that has not fired yet: its `nextRunAt` parses to a finite time strictly
 * after `now`. Missing, invalid, past, and exactly-current times do not
 * count, so a still-listed chat becomes resumable again once its scheduled
 * time passes or the schedule is cleared. Ordinary scheduled sends never
 * match.
 */
export function isPendingUsageLimitResume(
  activity: ScheduledActivity,
  target: ScheduledResumeChatKey,
  now: number,
): boolean {
  if (!activity.enabled) return false;
  const action = activity.action;
  if (action.type !== 'worktree_session_prompt') return false;
  if (action.purpose !== 'usage_limit_resume') return false;
  if (
    action.workspaceId !== target.workspaceId ||
    action.worktreeId !== target.worktreeId ||
    action.chatId !== target.chatId
  ) {
    return false;
  }
  if (!activity.nextRunAt) return false;
  const next = new Date(activity.nextRunAt).getTime();
  return Number.isFinite(next) && next > now;
}

/** The first pending usage-limit resume for the chat, in list order. */
export function findPendingUsageLimitResume(
  activities: readonly ScheduledActivity[],
  target: ScheduledResumeChatKey,
  now: number,
): ScheduledActivity | undefined {
  return activities.find((activity) =>
    isPendingUsageLimitResume(activity, target, now),
  );
}

export function hasPendingUsageLimitResume(
  activities: readonly ScheduledActivity[],
  target: ScheduledResumeChatKey,
  now: number,
): boolean {
  return findPendingUsageLimitResume(activities, target, now) !== undefined;
}
