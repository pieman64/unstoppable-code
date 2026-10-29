import { useCallback, useEffect, useMemo } from 'react';
import type {
  ChatSendMessageRequest,
  PlanComment,
  PlanCommentAnchor,
  PlanCommentThread,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { planPanelTitle } from '@/lib/panels/plan-panel-identity';
import {
  planViewKey,
  usePlanViewStore,
  type PlanViewTarget,
} from '@/stores/planViewStore';

/**
 * A plan's comment threads and every mutation on them (document comments,
 * diagram-node comments, replies, deletes, resolve toggles, submit-to-chat).
 * The threads live in the shared plan view store keyed by the plan's
 * `(projectId, worktreeId, planId)`, so every view of one plan (a plan panel,
 * its split diagram) reads the same threads and writes through one path
 * (`mutateThreads`, which saves via `window.api.activity.plans.saveComments`).
 * Two views never overwrite each other's edits.
 *
 * Pending comments are submitted to the owning worktree's ordinary chat
 * (`workspace-chat`), which reads and answers them with the file-comment
 * tools.
 */

/** Input for a diagram-node comment, gathered from the node detail panel. */
export interface AddNodeCommentInput {
  diagramKind: 'sequence' | 'logicDiff' | 'dataModelDiff';
  nodeId: string;
  title: string;
  detail?: string;
  files?: string[];
  headingPath?: string[];
  quote?: string;
  planNodeIds?: string[];
  body: string;
}

/**
 * Provider-only instructions sent with submitted plan comments: the
 * file-comment kind for the owning worktree's ordinary chat.
 */
export type PlanCommentSubmitHiddenContext = Extract<
  NonNullable<ChatSendMessageRequest['hiddenContext']>,
  { kind: 'file-comment-instructions' }
>;

/**
 * How a submit settled: nothing was pending (`empty`), another submit of the
 * plan was still in flight (`busy`), the chat accepted the comments (`sent`),
 * or the send failed or was refused and every comment stays pending
 * (`rejected`).
 */
export type PlanCommentSubmitOutcome = 'empty' | 'busy' | 'sent' | 'rejected';

/**
 * Sends the composed message and hidden context to the owning worktree's
 * ordinary chat. Resolves `true` once the chat accepts it; resolving `false`
 * or throwing leaves every comment pending.
 */
export type PlanCommentSubmitSend = (
  message: string,
  hiddenContext: PlanCommentSubmitHiddenContext,
) => Promise<boolean>;

/**
 * Instructions for the owning worktree's ordinary chat, which reads and
 * answers plan threads with the file-comment tools. That chat keeps its normal
 * ability to change code, so the text says discussing the plan is not by
 * itself a request to implement it.
 */
export const PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT =
  "<system_instruction>These comment threads are on a tracked plan, not a source file. Document threads quote the exact plan markdown, diagram-node threads name the diagram and node, and general threads have no anchor; anchors reflect the plan's latest revision and may be outdated. Comments may be questions; do not assume a change is requested when a comment is ambiguous, and discussing the plan does not by itself ask you to implement it. Use GetFileComments with a thread id to read a thread's full history and the plan's editable file. Edit the plan only through the file GetFileComments reports; if none is available, answer in the thread. After addressing a thread, use RespondToFileComment to reply and resolve it, or leave it open and ask for clarification.</system_instruction>";

/** The plan a workspace-chat submission names in its message. */
export interface PlanCommentSubmitPlanIdentity {
  readonly planId: string;
  readonly title: string;
}

export interface UsePlanComments {
  threads: PlanCommentThread[];
  stagedCount: number;
  addDocumentComment: (anchor: PlanCommentAnchor, body: string) => void;
  addNodeComment: (input: AddNodeCommentInput) => void;
  addReply: (threadId: string, body: string) => void;
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  deleteStagedComment: (threadId: string, commentId: string) => void;
  toggleResolved: (threadId: string) => void;
  /**
   * Submit every pending comment to the owning worktree's ordinary chat
   * through `send`. Only the comments in the accepted snapshot are marked
   * submitted; a second submit of the same plan while one is in flight
   * resolves `busy` without sending.
   */
  submit: (send: PlanCommentSubmitSend) => Promise<PlanCommentSubmitOutcome>;
}

/** Collapse whitespace and clip a quote for compact display/handoff. */
export function truncateQuote(quote: string, max = 160): string {
  const collapsed = quote.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * A comment is pending submission to the chat agent when it is either the
 * owner's own un-submitted draft (`staged`) or a teammate's web-authored
 * (`remote`) comment the owner has not yet handed off. Both are actioned the
 * same way; the remote-author analogue of clearing `staged` is setting
 * `submittedToChat` (CAN-393).
 */
export function isPendingSubmission(comment: PlanComment): boolean {
  if (comment.staged === true) {
    return true;
  }
  return comment.author === 'remote' && comment.submittedToChat !== true;
}

function countPendingComments(threads: PlanCommentThread[]): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.status !== 'open') {
      continue;
    }
    for (const comment of thread.comments) {
      if (isPendingSubmission(comment)) {
        count += 1;
      }
    }
  }
  return count;
}

/** Attribution suffix for a pending comment in the chat handoff. */
function commentLabel(comment: PlanComment): string {
  if (comment.author === 'remote') {
    const name = comment.remoteAuthor?.displayName ?? 'a teammate';
    return `Comment (from ${name})`;
  }
  return 'Comment';
}

function formatLineRef(anchor: PlanCommentThread['anchor']): string {
  if (anchor.lineStart == null) {
    return '';
  }
  if (anchor.lineEnd != null && anchor.lineEnd !== anchor.lineStart) {
    return ` (lines ${anchor.lineStart}–${anchor.lineEnd})`;
  }
  return ` (line ${anchor.lineStart})`;
}

function diagramLabel(
  diagramKind: 'sequence' | 'logicDiff' | 'dataModelDiff' | undefined,
): string {
  if (diagramKind === 'logicDiff') return 'logic diagram';
  if (diagramKind === 'dataModelDiff') return 'data model diagram';
  return 'sequence diagram';
}

/** The hidden context that tells the owning worktree chat's agent how to act on plan comments. */
export function composePlanCommentSubmitHiddenContext(): PlanCommentSubmitHiddenContext {
  return {
    kind: 'file-comment-instructions',
    text: PLAN_WORKSPACE_COMMENT_HIDDEN_CONTEXT_TEXT,
  };
}

function submitMessageHeader(
  threadCount: number,
  namedPlan: PlanCommentSubmitPlanIdentity | undefined,
): string {
  const threadWord = threadCount === 1 ? 'comment thread' : 'comment threads';
  if (!namedPlan) {
    return `I have ${threadCount} ${threadWord} on the plan.`;
  }
  return `I have ${threadCount} ${threadWord} on the plan "${planPanelTitle(namedPlan)}" (plan ${namedPlan.planId}).`;
}

/**
 * Compose the chat-handoff message for all open threads with comments pending
 * submission — the owner's own staged drafts and any teammate (`remote`)
 * comments not yet handed off. Each section carries a stable thread id (so the
 * agent can read and answer the thread with its comment tools) plus enough
 * anchor context for the agent to locate the passage in the plan. Teammate
 * comments are attributed by display name. `namedPlan` names the plan in the
 * opening line; an ordinary worktree chat needs that, while the dedicated plan
 * chat already knows its plan. Returns an empty string when nothing is
 * pending.
 */
export function composePlanCommentSubmitMessage(
  threads: PlanCommentThread[],
  namedPlan?: PlanCommentSubmitPlanIdentity,
): string {
  const entries: { thread: PlanCommentThread; pending: PlanComment[] }[] = [];
  for (const thread of threads) {
    if (thread.status !== 'open') {
      continue;
    }
    const pending = thread.comments.filter(isPendingSubmission);
    if (pending.length > 0) {
      entries.push({ thread, pending });
    }
  }

  if (entries.length === 0) {
    return '';
  }

  const sections = entries.map((entry, i) => {
    const number = i + 1;
    const { thread } = entry;
    const { anchor } = thread;

    // Diagram-node comment: name the diagram + node, then point the agent back
    // to the plan passage via heading path and (when present) exact markdown.
    if (anchor.source === 'diagram') {
      const heading =
        anchor.headingPath && anchor.headingPath.length > 0
          ? ` in section "${anchor.headingPath.join(' › ')}"`
          : '';
      const title = anchor.renderedText ?? '';
      const lines: string[] = [
        `${number}. Comment on the ${diagramLabel(anchor.diagramKind)} node "${title}" (thread ${thread.id})${heading}:`,
      ];
      if (anchor.headingPath && anchor.headingPath.length > 0) {
        lines.push(`   - Plan anchor: ${anchor.headingPath.join(' › ')}`);
      }
      if (anchor.quote.trim().length > 0) {
        lines.push('   - Exact plan markdown:');
        lines.push('     ```markdown');
        for (const sourceLine of anchor.quote.split('\n')) {
          lines.push(`     ${sourceLine}`);
        }
        lines.push('     ```');
      }
      for (const comment of entry.pending) {
        lines.push(`   - ${commentLabel(comment)}: ${comment.body}`);
      }
      return lines.join('\n');
    }

    // Unanchored (general) comment: no plan passage to edit, just a note/question.
    if (anchor.unanchored) {
      const lines: string[] = [
        `${number}. Comment thread ${thread.id} (general comment, not anchored to any passage):`,
      ];
      for (const comment of entry.pending) {
        lines.push(`   - ${commentLabel(comment)}: ${comment.body}`);
      }
      return lines.join('\n');
    }

    // Document comment: hand the agent the RAW markdown of the anchored passage
    // (in a fenced block) plus locators, so it can find the exact text to edit.
    const heading =
      anchor.headingPath && anchor.headingPath.length > 0
        ? ` in section "${anchor.headingPath.join(' › ')}"`
        : '';
    const lines: string[] = [
      `${number}. Comment thread ${thread.id}${heading}${formatLineRef(anchor)}:`,
    ];
    if (anchor.renderedText && anchor.renderedText.trim().length > 0) {
      lines.push(
        `   - Highlighted text: "${truncateQuote(anchor.renderedText)}"`,
      );
    }
    lines.push('   - Exact plan markdown excerpt:');
    lines.push('     ```markdown');
    for (const sourceLine of anchor.quote.split('\n')) {
      lines.push(`     ${sourceLine}`);
    }
    lines.push('     ```');
    for (const comment of entry.pending) {
      lines.push(`   - ${commentLabel(comment)}: ${comment.body}`);
    }
    return lines.join('\n');
  });

  return [submitMessageHeader(entries.length, namedPlan), '', ...sections].join(
    '\n',
  );
}

const EMPTY_THREADS: PlanCommentThread[] = [];

/** Composite key for one comment, unique across a plan's threads. */
function commentKey(threadId: string, commentId: string): string {
  return JSON.stringify([threadId, commentId]);
}

/**
 * The exact comments a submission hands off: each pending comment in an open
 * thread, keyed by thread + comment id, with the body that was sent.
 */
function snapshotPendingComments(
  threads: readonly PlanCommentThread[],
): ReadonlyMap<string, string> {
  const pending = new Map<string, string>();
  for (const thread of threads) {
    if (thread.status !== 'open') {
      continue;
    }
    for (const comment of thread.comments) {
      if (isPendingSubmission(comment)) {
        pending.set(commentKey(thread.id, comment.id), comment.body);
      }
    }
  }
  return pending;
}

function markCommentSubmitted(comment: PlanComment): PlanComment {
  if (comment.staged === true) {
    return { ...comment, staged: false };
  }
  // Mark teammate comments handed off so they are not re-counted or
  // re-submitted on the next pass.
  if (comment.author === 'remote' && comment.submittedToChat !== true) {
    return { ...comment, submittedToChat: true };
  }
  return comment;
}

/**
 * Acknowledge only the comments in an accepted submission snapshot. A comment
 * added, or a draft edited, while the send was in flight keeps its pending
 * state. Returns `threads` itself when nothing changes.
 */
function markSubmittedComments(
  threads: PlanCommentThread[],
  accepted: ReadonlyMap<string, string>,
): PlanCommentThread[] {
  let changed = false;
  const next = threads.map((thread) => {
    let threadChanged = false;
    const comments = thread.comments.map((comment) => {
      if (accepted.get(commentKey(thread.id, comment.id)) !== comment.body) {
        return comment;
      }
      const marked = markCommentSubmitted(comment);
      threadChanged = threadChanged || marked !== comment;
      return marked;
    });
    if (!threadChanged) {
      return thread;
    }
    changed = true;
    return { ...thread, comments };
  });
  return changed ? next : threads;
}

/** Whether `send` accepted the message; a thrown send counts as refused. */
async function sendAccepted(
  send: PlanCommentSubmitSend,
  message: string,
  hiddenContext: PlanCommentSubmitHiddenContext,
): Promise<boolean> {
  try {
    return await send(message, hiddenContext);
  } catch {
    return false;
  }
}

function newStagedComment(body: string, createdAt: string): PlanComment {
  return {
    id: crypto.randomUUID(),
    author: 'user',
    body,
    createdAt,
    staged: true,
  };
}

function newThread(anchor: PlanCommentAnchor, body: string): PlanCommentThread {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    status: 'open',
    createdAt: now,
    anchor,
    anchorState: 'matched',
    comments: [newStagedComment(body, now)],
  };
}

function nodeCommentAnchor(input: AddNodeCommentInput): PlanCommentAnchor {
  const quote = input.quote ?? '';
  return {
    source: 'diagram',
    diagramKind: input.diagramKind,
    planNodeId: input.nodeId,
    renderedText: input.title,
    quote,
    // Without a plan quote the node can't go outdated; keep it pinned.
    unanchored: quote.length === 0,
    ...(input.headingPath ? { headingPath: input.headingPath } : {}),
  };
}

/**
 * Hold the plan's shared view entry while mounted and keep it seeded from the
 * persisted threads. Returns the threads to render: the shared entry once it
 * is synced, otherwise the persisted threads.
 */
function useSharedPlanThreads(
  key: string,
  persisted: PlanCommentThread[] | undefined,
): PlanCommentThread[] {
  const entryThreads = usePlanViewStore((state) => {
    const entry = state.entries[key];
    return entry?.threadsSynced ? entry.threads : undefined;
  });

  useEffect(() => {
    usePlanViewStore.getState().acquire(key);
    return (): void => {
      usePlanViewStore.getState().release(key);
    };
  }, [key]);

  // Re-derive threads from the persisted plan whenever its comment threads
  // change (live reload from the trackedPlansUpdated event).
  useEffect(() => {
    usePlanViewStore.getState().syncPersistedThreads(key, persisted);
  }, [key, persisted]);

  return entryThreads ?? persisted ?? EMPTY_THREADS;
}

export function usePlanComments(plan: TrackedPlanData): UsePlanComments {
  const { projectId, worktreeId, id: planId, title: planTitle } = plan;
  const key = planViewKey(projectId, worktreeId, planId);
  const threads = useSharedPlanThreads(key, plan.commentThreads);
  const target = useMemo(
    (): PlanViewTarget => ({ projectId, worktreeId, planId }),
    [projectId, worktreeId, planId],
  );

  const mutate = useCallback(
    (updater: (current: PlanCommentThread[]) => PlanCommentThread[]): void => {
      usePlanViewStore.getState().mutateThreads(key, target, updater);
    },
    [key, target],
  );

  const addDocumentComment = useCallback(
    (anchor: PlanCommentAnchor, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const thread = newThread({ ...anchor, source: 'document' }, trimmed);
      mutate((current) => [...current, thread]);
    },
    [mutate],
  );

  const addNodeComment = useCallback(
    (input: AddNodeCommentInput): void => {
      const trimmed = input.body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const thread = newThread(nodeCommentAnchor(input), trimmed);
      mutate((current) => [...current, thread]);
    },
    [mutate],
  );

  const addReply = useCallback(
    (threadId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const comment = newStagedComment(trimmed, new Date().toISOString());
      mutate((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        ),
      );
    },
    [mutate],
  );

  const editStagedComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      mutate((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                comments: thread.comments.map((comment) =>
                  comment.id === commentId && comment.staged === true
                    ? { ...comment, body: trimmed }
                    : comment,
                ),
              }
            : thread,
        ),
      );
    },
    [mutate],
  );

  // Fully remove a staged (not-yet-submitted) comment. When it was the thread's
  // only comment, the thread — and its anchor highlight — is removed too.
  const deleteStagedComment = useCallback(
    (threadId: string, commentId: string): void => {
      mutate((current) => {
        const next: PlanCommentThread[] = [];
        for (const thread of current) {
          if (thread.id !== threadId) {
            next.push(thread);
            continue;
          }
          const comments = thread.comments.filter(
            (comment) => comment.id !== commentId,
          );
          if (comments.length > 0) {
            next.push({ ...thread, comments });
          }
          // else: drop the now-empty thread entirely.
        }
        return next;
      });
    },
    [mutate],
  );

  const toggleResolved = useCallback(
    (threadId: string): void => {
      mutate((current) =>
        current.map(
          (thread): PlanCommentThread =>
            thread.id === threadId
              ? {
                  ...thread,
                  status: thread.status === 'open' ? 'resolved' : 'open',
                }
              : thread,
        ),
      );
    },
    [mutate],
  );

  // Submit the pending comments as they are now. Only that snapshot is marked
  // submitted after an accepted send; the view entry is held for the whole
  // send so the acknowledgment lands even if every view closes meanwhile, and
  // no second submit of the plan starts until this one settles.
  const submit = useCallback(
    async (send: PlanCommentSubmitSend): Promise<PlanCommentSubmitOutcome> => {
      const store = usePlanViewStore.getState();
      store.acquire(key);
      if (!store.beginSubmit(key)) {
        store.release(key);
        return 'busy';
      }
      try {
        const entry = usePlanViewStore.getState().entries[key];
        const snapshot = entry?.threadsSynced ? entry.threads : threads;
        const message = composePlanCommentSubmitMessage(snapshot, {
          planId: target.planId,
          title: planTitle,
        });
        if (!message) {
          return 'empty';
        }
        const accepted = snapshotPendingComments(snapshot);
        const sent = await sendAccepted(
          send,
          message,
          composePlanCommentSubmitHiddenContext(),
        );
        if (!sent) {
          return 'rejected';
        }
        mutate((current) => markSubmittedComments(current, accepted));
        return 'sent';
      } finally {
        const settled = usePlanViewStore.getState();
        settled.endSubmit(key);
        settled.release(key);
      }
    },
    [key, target, planTitle, threads, mutate],
  );

  const stagedCount = useMemo(() => countPendingComments(threads), [threads]);

  return {
    threads,
    stagedCount,
    addDocumentComment,
    addNodeComment,
    addReply,
    editStagedComment,
    deleteStagedComment,
    toggleResolved,
    submit,
  };
}
