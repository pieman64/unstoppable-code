import {
  APP_ADVISOR_PROJECT_ID,
  type AutomationAction,
  type ChatAttachmentPromptContext,
  type FileReference,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { describeFiveFieldCron } from '@canopy/ui-shared/lib/cron-description';
import type { QueuedChatMessage } from '@/stores/chatStore';
import { formatUsageLimitTimeLabel } from './usage-limit-time-label';

/**
 * A scheduled `worktree_session_prompt` automation, projected into the shape the
 * chat history needs to render it next to ordinary queued messages. Derived
 * from `useAutomationsStore.activities`, so disable/delete/re-enable/edit stay
 * in sync automatically — these are never stored as `tab.queuedMessages`.
 */
export interface ScheduledQueuedMessage {
  automationId: string;
  activityName: string;
  chatId: string;
  chatTitle?: string;
  text: string;
  fileReferences?: FileReference[];
  attachmentPaths?: string[];
  attachmentPromptContexts?: ChatAttachmentPromptContext[];
  inputMode?: 'typed' | 'voice';
  /** ISO 8601 next fire time (`activity.nextRunAt`). */
  scheduledAt: string;
  /** Whether the underlying schedule is one-time or recurring. */
  scheduleKind: 'one_time' | 'cron';
  /** Five-field cron expression; present only when `scheduleKind` is `cron`. */
  scheduleExpression?: string;
  /**
   * CAN-5782: read-only in chat. Other schedules share the workflow this
   * message's automation runs, so it is edited on that Workflow page.
   */
  workflowPipelineId?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Human cadence for a recurring scheduled message ("Every hour"), falling
 * back to "Recurring" when the expression has no confident description.
 * Returns `null` for one-time schedules. Shared by the composer notice, the
 * scheduled bubble, and the sidebar popover so their wording cannot drift.
 */
export function formatScheduledCadence(
  message: Pick<ScheduledQueuedMessage, 'scheduleKind' | 'scheduleExpression'>,
): string | null {
  if (message.scheduleKind !== 'cron') return null;
  const described = message.scheduleExpression
    ? describeFiveFieldCron(message.scheduleExpression)
    : null;
  return described ?? 'Recurring';
}

/**
 * Short send time for a scheduled message: a clock time today, a weekday and
 * time within the week, and a short date ("Oct 14, 9:00 AM") wherever a bare
 * weekday would be ambiguous: seven or more days away, or on today's weekday
 * but another date (a weekly run right after it fires). Returns `null` for a
 * missing or invalid time.
 */
export function formatScheduledSendLabel(
  at: number | string | undefined,
): string | null {
  const nearLabel = formatUsageLimitTimeLabel(at);
  if (nearLabel === null || at === undefined) return null;
  const when = new Date(at);
  const now = new Date();
  const withinWeek = Math.abs(when.getTime() - now.getTime()) < SEVEN_DAYS_MS;
  const sameWeekdayOtherDate =
    when.getDay() === now.getDay() &&
    when.toDateString() !== now.toDateString();
  if (withinWeek && !sameWeekdayOtherDate) return nearLabel;
  return when.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Display union for the chat history queue area: ordinary queued chat messages
 * and derived scheduled `worktree_session_prompt` automations. Kept separate so
 * `QueuedChatMessage` storage is never mutated.
 */
export type ChatQueuedDisplayMessage =
  | { source: 'chat_queue'; message: QueuedChatMessage; index: number }
  | {
      source: 'scheduled_automation';
      automationId: string;
      text: string;
      fileReferences?: FileReference[];
      attachmentPaths?: string[];
      attachmentPromptContexts?: ChatAttachmentPromptContext[];
      inputMode?: 'typed' | 'voice';
      scheduledAt: string;
      activityName: string;
    };

/**
 * Derive the scheduled messages to show in an existing chat's history from the
 * automations store. Enabled `worktree_session_prompt` activities targeting
 * this exact Code, Cowork, or App Advisor chat stay visible even after their
 * due time while the main-process scheduler waits for an active session to
 * become idle.
 */
export function getScheduledMessagesForChat(args: {
  activities: ScheduledActivity[];
  workspaceId: string;
  worktreeId: string;
  chatId: string;
  now?: Date;
}): ScheduledQueuedMessage[] {
  const { activities, workspaceId, worktreeId, chatId } = args;

  return getScheduledMessagesForWorktree({
    activities,
    workspaceId,
    worktreeId,
  }).filter((message) => message.chatId === chatId);
}

/**
 * Derive all active scheduled messages for a worktree, regardless of the
 * target chat tab. Used by the sidebar worktree row indicator/popover.
 */

/**
 * The session prompt an activity sends, if it sends one. A converted
 * automation whose workflow other schedules share keeps it as
 * `ownedPipeline.chatAction` (CAN-5782).
 */
function sessionPromptAction(
  activity: ScheduledActivity,
): Extract<AutomationAction, { type: 'worktree_session_prompt' }> | undefined {
  const action = activity.ownedPipeline?.chatAction ?? activity.action;
  return action.type === 'worktree_session_prompt' ? action : undefined;
}

/** The `getScheduledMessagesForWorktree`/`hasScheduledMessagesForWorktree` match rule, shared so the two never drift. */
function matchesWorktreeSessionPromptSchedule(
  activity: ScheduledActivity,
  workspaceId: string,
  worktreeId: string,
): boolean {
  if (!activity.enabled) return false;
  const action = sessionPromptAction(activity);
  if (action === undefined) return false;
  if (action.workspaceId !== workspaceId) return false;
  // App Advisor chats are entry-keyed but persisted automations stay
  // entry-agnostic (legacy rows carry the read-only `global` slot, and
  // entries can change when a chat is recreated). Match project-wide and
  // let the per-chat filter scope by chatId, mirroring the transport rule
  // that chat-id targets resolve entries dynamically.
  if (
    workspaceId !== APP_ADVISOR_PROJECT_ID &&
    action.worktreeId !== worktreeId
  ) {
    return false;
  }
  if (!activity.nextRunAt) return false;
  const next = new Date(activity.nextRunAt).getTime();
  return Number.isFinite(next);
}

/**
 * Whether a worktree has any scheduled `worktree_session_prompt` automation,
 * without projecting the full message list. A per-row sidebar selector reads
 * this boolean reactively (see `desktopWorktreeRowOverrides.tsx`) so a change
 * to an unrelated automation does not re-render every row; the popover
 * itself still snapshots the full list from `getScheduledMessagesForWorktree`
 * only when it opens.
 */
export function hasScheduledMessagesForWorktree(
  activities: ScheduledActivity[],
  workspaceId: string,
  worktreeId: string,
): boolean {
  return activities.some((activity) =>
    matchesWorktreeSessionPromptSchedule(activity, workspaceId, worktreeId),
  );
}

export function getScheduledMessagesForWorktree(args: {
  activities: ScheduledActivity[];
  workspaceId: string;
  worktreeId: string;
}): ScheduledQueuedMessage[] {
  const { activities, workspaceId, worktreeId } = args;

  const matches = activities.filter((activity) =>
    matchesWorktreeSessionPromptSchedule(activity, workspaceId, worktreeId),
  );

  matches.sort((left, right) => {
    const leftMs = new Date(left.nextRunAt ?? '').getTime();
    const rightMs = new Date(right.nextRunAt ?? '').getTime();
    if (leftMs !== rightMs) return leftMs - rightMs;
    return left.id.localeCompare(right.id);
  });

  return matches.flatMap((activity): ScheduledQueuedMessage[] => {
    const action = sessionPromptAction(activity);
    // The filter guarantees a session prompt.
    if (action === undefined) return [];
    const { ownedPipeline } = activity;
    return [
      {
        automationId: activity.id,
        activityName: activity.name,
        chatId: action.chatId,
        ...(action.chatTitle ? { chatTitle: action.chatTitle } : {}),
        text: action.prompt,
        ...(action.fileReferences
          ? { fileReferences: action.fileReferences }
          : {}),
        ...(action.attachmentPaths
          ? { attachmentPaths: action.attachmentPaths }
          : {}),
        ...(action.attachmentPromptContexts
          ? { attachmentPromptContexts: action.attachmentPromptContexts }
          : {}),
        ...(action.inputMode ? { inputMode: action.inputMode } : {}),
        scheduledAt: activity.nextRunAt ?? '',
        scheduleKind: activity.schedule.kind,
        ...(activity.schedule.kind === 'cron'
          ? { scheduleExpression: activity.schedule.expression }
          : {}),
        ...(ownedPipeline !== undefined && !ownedPipeline.chatEditable
          ? { workflowPipelineId: ownedPipeline.pipelineId }
          : {}),
      },
    ];
  });
}
