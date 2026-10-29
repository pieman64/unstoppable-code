import {
  IPC_CHANNELS,
  type TrackedPlansUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  appendPlanCommentReply,
  PLAN_COMMENT_HANDOFF_GRACE_MS,
  waitForSubmittedPlanCommentThread,
  type AppendPlanCommentReplyResult,
} from './plan-persistence';
import { queueSharedPlanSync } from './shared-plan-sync';
import { sendToAllWindows } from './window-send';

export interface ReplyToPlanCommentThreadRequest {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly threadId: string;
  readonly body: string;
  readonly resolve: boolean;
  /**
   * Reject the reply (no write, broadcast, or sync) unless the thread has at
   * least one non-draft comment. A draft-only thread gets the submit hand-off
   * grace to become submitted first. The ordinary file-comment tool sets this;
   * the legacy plan-explore reply tool keeps accepting draft-only threads
   * until it is retired.
   */
  readonly requireSubmittedThread: boolean;
}

export interface ReplyToPlanCommentThreadOptions {
  /**
   * How long to wait for a draft-only thread to become submitted before
   * rejecting. Defaults to {@link PLAN_COMMENT_HANDOFF_GRACE_MS}.
   */
  readonly handoffGraceMs?: number;
}

/**
 * Append the reply, and when a submitted thread is required but the thread is
 * still draft-only, wait up to the hand-off grace for the renderer's
 * acknowledgment and retry once. Without an acknowledgment the original
 * rejection is returned unchanged.
 */
async function appendReplyAfterHandoff(
  request: ReplyToPlanCommentThreadRequest,
  handoffGraceMs: number,
): Promise<AppendPlanCommentReplyResult> {
  const append = (): Promise<AppendPlanCommentReplyResult> =>
    appendPlanCommentReply({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
      threadId: request.threadId,
      body: request.body,
      resolve: request.resolve,
      requireSubmittedThread: request.requireSubmittedThread,
    });

  const first = await append();
  if (
    first.ok ||
    first.reason !== 'not-submitted' ||
    !request.requireSubmittedThread
  ) {
    return first;
  }

  const submitted = await waitForSubmittedPlanCommentThread(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
      threadId: request.threadId,
    },
    handoffGraceMs,
  );
  return submitted ? append() : first;
}

/**
 * The single agent reply path for tracked-plan comment threads, shared by the
 * ordinary `RespondToFileComment` tool and the legacy plan-explore
 * `RespondToComment` tool.
 *
 * Appends the reply under the plan file lock, then broadcasts
 * `trackedPlansUpdated` to every window (plan panels can live in auxiliary
 * windows) and queues the existing shared-plan sync so a teammate on a shared
 * plan receives the reply and any resolution. Queueing never throws and logs
 * its own failures, so a sync problem never turns a posted reply into a
 * reported failure.
 *
 * The renderer acknowledges handed-off comments only after the owning chat
 * accepted the send, so an agent can reply to a thread named in the message
 * that started its turn before that acknowledgment lands. When a submitted
 * thread is required, a draft-only thread therefore gets
 * {@link PLAN_COMMENT_HANDOFF_GRACE_MS} (or `options.handoffGraceMs`) to become
 * submitted before the reply is rejected.
 */
export async function replyToPlanCommentThread(
  request: ReplyToPlanCommentThreadRequest,
  options: ReplyToPlanCommentThreadOptions = {},
): Promise<AppendPlanCommentReplyResult> {
  const result = await appendReplyAfterHandoff(
    request,
    options.handoffGraceMs ?? PLAN_COMMENT_HANDOFF_GRACE_MS,
  );
  const plan = result.ok ? result.plan : undefined;
  if (!plan) {
    return result;
  }

  sendToAllWindows(IPC_CHANNELS.trackedPlansUpdated, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    plan,
    change: 'upsert',
  } satisfies TrackedPlansUpdatedEvent);

  queueSharedPlanSync(plan, 'plan');

  return result;
}
