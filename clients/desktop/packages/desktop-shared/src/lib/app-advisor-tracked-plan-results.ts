import { z } from 'zod';
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorJson,
  TrackedPlanData,
} from '../types';
import type { PlanCommentThread } from '../types/plan-diagrams';

/**
 * App Advisor's tracked-plan read results, shared by the renderer dispatcher
 * and Electron main (CAN-5998) so a moved read answers exactly as the
 * renderer did. Callers load the plans; these functions shape the answer.
 */

export interface TrackedPlanResult {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}

function jsonValue(value: unknown): AppAdvisorJson {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

export function trackedPlanNotFound(planId: string): TrackedPlanResult {
  return {
    ok: false,
    error: {
      code: 'not_found',
      message: `Tracked plan ${planId} was not found.`,
    },
  };
}

export const TRACKED_PLAN_LIST_DEFAULT_LIMIT = 50;
export const TRACKED_PLAN_LIST_MAX_LIMIT = 200;
export const TRACKED_PLAN_CONTENT_DEFAULT_MAX_CHARS = 20_000;
export const TRACKED_PLAN_CONTENT_MAX_CHARS = 100_000;
export const TRACKED_PLAN_COMMENT_DEFAULT_LIMIT = 50;
export const TRACKED_PLAN_COMMENT_MAX_LIMIT = 200;
export const TRACKED_PLAN_COMMENT_BODY_MAX_CHARS = 4_000;

export function clampTrackedPlanListLimit(limit: number | undefined): number {
  if (limit === undefined) return TRACKED_PLAN_LIST_DEFAULT_LIMIT;
  return Math.max(1, Math.min(TRACKED_PLAN_LIST_MAX_LIMIT, Math.floor(limit)));
}

export function clampTrackedPlanCommentLimit(
  limit: number | undefined,
): number {
  if (limit === undefined) return TRACKED_PLAN_COMMENT_DEFAULT_LIMIT;
  return Math.max(
    1,
    Math.min(TRACKED_PLAN_COMMENT_MAX_LIMIT, Math.floor(limit)),
  );
}

export function clampTrackedPlanContentMaxChars(
  limit: number | undefined,
): number {
  if (limit === undefined) return TRACKED_PLAN_CONTENT_DEFAULT_MAX_CHARS;
  return Math.max(
    1,
    Math.min(TRACKED_PLAN_CONTENT_MAX_CHARS, Math.floor(limit)),
  );
}

export function truncateFreeformText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  if (maxChars <= 0) {
    return { text: '', truncated: true };
  }

  let prefixLength = maxChars;
  let suffix = '';
  for (let i = 0; i < 3; i += 1) {
    suffix = `\n\n[truncated ${text.length - prefixLength} chars]`;
    const nextPrefixLength = Math.max(0, maxChars - suffix.length);
    if (nextPrefixLength === prefixLength) break;
    prefixLength = nextPrefixLength;
  }
  if (prefixLength <= 0 || suffix.length > maxChars) {
    return { text: text.slice(0, maxChars), truncated: true };
  }

  return {
    text: `${text.slice(0, prefixLength)}${suffix}`,
    truncated: true,
  };
}

export function trackedPlanCommentCounts(
  plan: Pick<TrackedPlanData, 'commentThreads'>,
): Record<string, AppAdvisorJson> {
  const threads = plan.commentThreads ?? [];
  return {
    commentThreadCount: threads.length,
    openThreadCount: threads.filter((thread) => thread.status === 'open')
      .length,
    resolvedThreadCount: threads.filter(
      (thread) => thread.status === 'resolved',
    ).length,
    outdatedThreadCount: threads.filter(
      (thread) => thread.anchorState === 'outdated',
    ).length,
    stagedCommentCount: threads.reduce(
      (count, thread) =>
        count +
        thread.comments.filter((comment) => comment.staged === true).length,
      0,
    ),
  };
}

export function trackedPlanSummary(
  plan: TrackedPlanData,
): Record<string, AppAdvisorJson> {
  return {
    id: plan.id,
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    source: plan.source,
    title: plan.title,
    reviewStatus: plan.reviewStatus,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    latestRevisionNumber: plan.latestRevisionNumber,
    linkedExecutionIds: plan.linkedExecutionIds,
    hidden: plan.hidden === true,
    sourceFilePath: plan.sourceFilePath ?? null,
    sourceRepoId: plan.sourceRepoId ?? null,
    contentLength: plan.content.length,
    ...trackedPlanCommentCounts(plan),
  };
}

export function trackedPlanListResult(
  action: Extract<AppAdvisorAction, { type: 'tracked-plan.list' }>,
  plans: readonly TrackedPlanData[],
): TrackedPlanResult {
  const query = action.query?.trim().toLowerCase();
  const includeHidden = action.includeHidden === true;
  const matching = plans.filter((plan) => {
    if (!includeHidden && plan.hidden === true) return false;
    if (action.reviewStatus && plan.reviewStatus !== action.reviewStatus) {
      return false;
    }
    if (!query) return true;
    return (
      plan.title.toLowerCase().includes(query) ||
      plan.id.toLowerCase().includes(query) ||
      plan.content.toLowerCase().includes(query)
    );
  });
  const limit = clampTrackedPlanListLimit(action.limit);
  const selected = matching.slice(0, limit);
  return {
    ok: true,
    result: {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      ...(action.reviewStatus ? { reviewStatus: action.reviewStatus } : {}),
      ...(query ? { query } : {}),
      totalPlans: plans.length,
      matchedPlans: matching.length,
      returnedPlans: selected.length,
      plans: selected.map(trackedPlanSummary),
    },
  };
}

export function trackedPlanGetResult(
  action: Extract<AppAdvisorAction, { type: 'tracked-plan.get' }>,
  plan: TrackedPlanData | null,
): TrackedPlanResult {
  if (!plan) return trackedPlanNotFound(action.planId);
  const includeContent = action.includeContent !== false;
  const maxChars = clampTrackedPlanContentMaxChars(action.maxContentChars);
  const content = truncateFreeformText(plan.content, maxChars);
  return {
    ok: true,
    result: {
      plan: {
        ...trackedPlanSummary(plan),
        revisions: plan.revisions.map((revision) => ({
          revisionNumber: revision.revisionNumber,
          source: revision.source,
          reviewStatus: revision.reviewStatus,
          createdAt: revision.createdAt,
          approvedAt: revision.approvedAt ?? null,
          dismissedAt: revision.dismissedAt ?? null,
          contentLength: revision.content.length,
        })),
        diagrams: jsonValue(plan.diagrams ?? null),
        lastEditSource: plan.lastEditSource ?? null,
        ...(includeContent
          ? { content: content.text, contentTruncated: content.truncated }
          : {}),
      },
    },
  };
}

function serializePlanComment(comment: {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  staged?: boolean;
}): Record<string, AppAdvisorJson> {
  const body = truncateFreeformText(
    comment.body,
    TRACKED_PLAN_COMMENT_BODY_MAX_CHARS,
  );
  return {
    id: comment.id,
    author: comment.author,
    createdAt: comment.createdAt,
    staged: comment.staged === true,
    body: body.text,
    bodyTruncated: body.truncated,
  };
}

function serializePlanCommentThread(
  thread: PlanCommentThread,
  includeComments: boolean,
): Record<string, AppAdvisorJson> {
  const stagedCommentCount = thread.comments.filter(
    (comment) => comment.staged === true,
  ).length;
  const latestComment = thread.comments[thread.comments.length - 1];
  const anchorQuote = truncateFreeformText(
    thread.anchor.quote,
    TRACKED_PLAN_COMMENT_BODY_MAX_CHARS,
  );
  return {
    id: thread.id,
    status: thread.status,
    anchorState: thread.anchorState,
    createdAt: thread.createdAt,
    commentCount: thread.comments.length,
    stagedCommentCount,
    latestCommentAt: latestComment?.createdAt ?? null,
    anchor: {
      source: thread.anchor.source ?? 'document',
      diagramKind: thread.anchor.diagramKind ?? null,
      unanchored: thread.anchor.unanchored === true,
      lineStart: thread.anchor.lineStart ?? null,
      lineEnd: thread.anchor.lineEnd ?? null,
      planNodeId: thread.anchor.planNodeId ?? null,
      headingPath: thread.anchor.headingPath ?? [],
      quote: anchorQuote.text,
      quoteTruncated: anchorQuote.truncated,
      renderedText: thread.anchor.renderedText ?? null,
    },
    ...(includeComments
      ? { comments: thread.comments.map(serializePlanComment) }
      : {}),
  };
}

function threadMatchesQuery(
  thread: PlanCommentThread,
  query: string | undefined,
): boolean {
  if (!query) return true;
  const haystack = [
    thread.id,
    thread.anchor.quote,
    thread.anchor.renderedText ?? '',
    ...(thread.anchor.headingPath ?? []),
    ...thread.comments.map((comment) => comment.body),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(query);
}

export function trackedPlanCommentThreadsResult(
  action: Extract<
    AppAdvisorAction,
    { type: 'tracked-plan.list_comment_threads' }
  >,
  plan: TrackedPlanData | null,
): TrackedPlanResult {
  if (!plan) return trackedPlanNotFound(action.planId);
  const query = action.query?.trim().toLowerCase();
  const matching = (plan.commentThreads ?? []).filter((thread) => {
    if (action.status && thread.status !== action.status) return false;
    if (action.anchorState && thread.anchorState !== action.anchorState) {
      return false;
    }
    if (
      action.staged !== undefined &&
      thread.comments.some((comment) => comment.staged === true) !==
        action.staged
    ) {
      return false;
    }
    return threadMatchesQuery(thread, query);
  });
  const limit = clampTrackedPlanCommentLimit(action.limit);
  const selected = matching.slice(0, limit);
  return {
    ok: true,
    result: {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      planId: action.planId,
      planTitle: plan.title,
      ...(action.status ? { status: action.status } : {}),
      ...(action.anchorState ? { anchorState: action.anchorState } : {}),
      ...(action.staged !== undefined ? { staged: action.staged } : {}),
      ...(query ? { query } : {}),
      ...trackedPlanCommentCounts(plan),
      matchedThreads: matching.length,
      returnedThreads: selected.length,
      threads: selected.map((thread) =>
        serializePlanCommentThread(thread, action.includeComments === true),
      ),
    },
  };
}

export function trackedPlanCommentThreadResult(
  action: Extract<
    AppAdvisorAction,
    { type: 'tracked-plan.get_comment_thread' }
  >,
  plan: TrackedPlanData | null,
): TrackedPlanResult {
  if (!plan) return trackedPlanNotFound(action.planId);
  const thread = (plan.commentThreads ?? []).find(
    (candidate) => candidate.id === action.threadId,
  );
  if (!thread) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Comment thread ${action.threadId} was not found on tracked plan ${action.planId}.`,
      },
    };
  }
  return {
    ok: true,
    result: {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      planId: action.planId,
      planTitle: plan.title,
      thread: serializePlanCommentThread(thread, true),
    },
  };
}
