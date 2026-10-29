import { describeReviewCommentContext } from '@canopy/desktop-shared/types/code-review';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type {
  ChatSendMessageRequest,
  CodeReviewFile,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type { AddNodeCommentInput } from '@/components/plan-explore/usePlanComments';
import type { CodeReviewTarget } from '@/stores/codeReviewStore';

/**
 * Single source of truth for a code review's comment threads. Owns the
 * `threads` state, persistence (`window.api.codeReview.saveComments`), and
 * every mutation (code-line comments, diagram-node comments, replies,
 * deletes, resolve toggles, submit-to-chat). Modeled directly on
 * `usePlanComments.ts` — read that file side-by-side when changing this one.
 */

export type ReviewCommentSubmitHiddenContext = Extract<
  NonNullable<ChatSendMessageRequest['hiddenContext']>,
  { kind: 'file-comment-instructions' }
>;

export const REVIEW_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT =
  '<system_instruction>For each comment thread: inspect the referenced code before answering, using git and file reads in this worktree. Comments may simply be questions; do not assume changes are requested if a comment is ambiguous. After addressing a thread, use RespondToFileComment with its thread id to post a short reply and resolve it (or leave it open and ask for clarification). Use GetFileComments with a thread id to read the full conversation if a thread already has earlier replies. When a fix is clearly requested, apply it directly and describe the change in your reply.</system_instruction>';

export interface UseReviewComments {
  threads: ReviewCommentThread[];
  stagedCount: number;
  addCodeComment: (anchor: ReviewCommentAnchor, body: string) => void;
  addDiagramComment: (input: AddNodeCommentInput) => void;
  /** A general note not attached to any code line or diagram node. */
  addGeneralComment: (body: string) => void;
  addReply: (threadId: string, body: string) => void;
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  deleteStagedComment: (threadId: string, commentId: string) => void;
  toggleResolved: (threadId: string) => void;
  submit: (
    send: (
      message: string,
      hiddenContext: ReviewCommentSubmitHiddenContext,
    ) => Promise<boolean>,
  ) => Promise<void>;
}

/**
 * A comment is pending submission to the chat agent when it is still an
 * un-submitted draft. Unlike plan comments, review comments have no
 * `'remote'` author/`submittedToChat` handoff concept — only the owner's own
 * staged drafts are ever pending.
 */
export function isPendingSubmission(comment: ReviewComment): boolean {
  return comment.staged === true;
}

function countPendingComments(threads: ReviewCommentThread[]): number {
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

export function formatCodeLocation(anchor: ReviewCommentAnchor): string {
  const repoPrefix = anchor.repoId ? `${anchor.repoId}/` : '';
  const path = anchor.filePath ?? '';
  const lineRef =
    anchor.lineStart == null
      ? ''
      : anchor.lineEnd != null && anchor.lineEnd !== anchor.lineStart
        ? `:${anchor.lineStart}-${anchor.lineEnd}`
        : `:${anchor.lineStart}`;
  const sideLabel = anchor.side === 'old' ? 'old' : 'new';
  return `${repoPrefix}${path}${lineRef} (${sideLabel} side)`;
}

export function diagramLocationLabel(anchor: ReviewCommentAnchor): string {
  const kindLabel =
    anchor.diagramKind === 'dataModelDiff' ? 'data model' : 'logic';
  return `${kindLabel} diagram node "${anchor.quote}"`;
}

export function composeReviewCommentSubmitHiddenContext(): ReviewCommentSubmitHiddenContext {
  return {
    kind: 'file-comment-instructions',
    text: REVIEW_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT,
  };
}

/**
 * Compose the chat-handoff message for all open threads with staged drafts.
 * Each section carries a stable thread id (so the agent can use
 * RespondToFileComment / GetFileComments) plus enough anchor context — the
 * repo/file/line locator and, for code anchors, the exact quoted source lines
 * in a fenced block — for the agent to locate the passage. Returns an empty
 * string when nothing is pending.
 */
export function composeReviewCommentSubmitMessage(
  threads: ReviewCommentThread[],
): string {
  const entries: { thread: ReviewCommentThread; pending: ReviewComment[] }[] =
    [];
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

    const lines: string[] = [
      `${number}. Comment thread \`${thread.id}\`:`,
      `   - Context: ${describeReviewCommentContext(anchor.source === 'code' ? { ...anchor, view: 'diff' } : anchor)}`,
    ];

    if (anchor.source === 'diagram') {
      lines.push(`   - Location: ${diagramLocationLabel(anchor)}`);
    } else if (anchor.unanchored) {
      lines.push('   - Location: general note');
    } else {
      lines.push(`   - Location: ${formatCodeLocation(anchor)}`);
      lines.push('   - Quoted code:');
      lines.push('     ```code');
      for (const sourceLine of anchor.quote.split('\n')) {
        lines.push(`     ${sourceLine}`);
      }
      lines.push('     ```');
    }

    for (const comment of entry.pending) {
      lines.push(`   - Comment: ${comment.body}`);
    }
    return lines.join('\n');
  });

  const threadWord =
    entries.length === 1 ? 'comment thread' : 'comment threads';

  return [
    `I have ${entries.length} ${threadWord} on this branch's changes.`,
    '',
    ...sections,
  ].join('\n');
}

export function useReviewComments(
  target: CodeReviewTarget,
  review: CodeReviewFile | null,
  diagramOnly: boolean | ((thread: ReviewCommentThread) => boolean) = false,
): UseReviewComments {
  const [threads, setThreads] = useState<ReviewCommentThread[]>(
    review?.commentThreads ?? [],
  );

  const submitInFlight = useRef(false);

  // Re-derive threads from the persisted review whenever its comment threads
  // change (live reload from the codeReviewUpdated event).
  useEffect(() => {
    setThreads(review?.commentThreads ?? []);
  }, [review?.commentThreads]);

  const saveThreads = useCallback(
    (
      nextThreads: ReviewCommentThread[],
      current: ReviewCommentThread[],
    ): void => {
      void window.api.codeReview.saveComments({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        commentThreads: nextThreads,
        baseCommentThreadIds: current.map((thread) => thread.id),
        baseCommentThreads: current,
      });
    },
    [target.projectId, target.worktreeId],
  );

  const addCodeComment = useCallback(
    (anchor: ReviewCommentAnchor, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: { ...anchor, source: 'code' },
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      setThreads((current) => {
        const next = [...current, thread];
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  const addDiagramComment = useCallback(
    (input: AddNodeCommentInput): void => {
      const trimmed = input.body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const anchor: ReviewCommentAnchor = {
        source: 'diagram',
        diagramKind:
          input.diagramKind === 'dataModelDiff' ? 'dataModelDiff' : 'logicDiff',
        nodeId: input.nodeId,
        quote: input.title,
        unanchored: false,
        diagramFingerprint:
          review?.diagrams[
            input.diagramKind === 'dataModelDiff'
              ? 'dataModelDiff'
              : 'logicDiff'
          ]?.derivedFromFingerprint,
      };
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor,
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      setThreads((current) => {
        const next = [...current, thread];
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads, review?.diagrams],
  );

  const addGeneralComment = useCallback(
    (body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const now = new Date().toISOString();
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: { source: 'code', quote: '', unanchored: true },
        anchorState: 'matched',
        comments: [
          {
            id: crypto.randomUUID(),
            author: 'user',
            body: trimmed,
            createdAt: now,
            staged: true,
          },
        ],
      };
      setThreads((current) => {
        const next = [...current, thread];
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  const addReply = useCallback(
    (threadId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
        staged: true,
      };
      setThreads((current) => {
        const next = current.map((thread) =>
          thread.id === threadId
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        );
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  const editStagedComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      const trimmed = body.trim();
      if (trimmed.length === 0) {
        return;
      }
      setThreads((current) => {
        const next = current.map((thread) =>
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
        );
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  // Fully remove a staged (not-yet-submitted) comment. When it was the
  // thread's only comment, the thread — and its anchor marker — is removed
  // too.
  const deleteStagedComment = useCallback(
    (threadId: string, commentId: string): void => {
      setThreads((current) => {
        const next: ReviewCommentThread[] = [];
        for (const thread of current) {
          if (thread.id !== threadId) {
            next.push(thread);
            continue;
          }
          const comments = thread.comments.filter(
            (comment) => comment.id !== commentId || comment.staged !== true,
          );
          if (comments.length > 0) {
            next.push({ ...thread, comments });
          }
          // else: drop the now-empty thread entirely.
        }
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  const toggleResolved = useCallback(
    (threadId: string): void => {
      setThreads((current) => {
        const next: ReviewCommentThread[] = current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                status: thread.status === 'open' ? 'resolved' : 'open',
              }
            : thread,
        );
        saveThreads(next, current);
        return next;
      });
    },
    [saveThreads],
  );

  const submit = useCallback(
    async (
      send: (
        message: string,
        hiddenContext: ReviewCommentSubmitHiddenContext,
      ) => Promise<boolean>,
    ): Promise<void> => {
      if (submitInFlight.current) return;
      const submitting = threads.filter((thread) =>
        typeof diagramOnly === 'function'
          ? diagramOnly(thread)
          : !diagramOnly || thread.anchor.source === 'diagram',
      );
      const message = composeReviewCommentSubmitMessage(submitting);
      if (!message) {
        return;
      }
      // Snapshot exactly which comments this submission carried so the
      // post-send flip only touches those. Comments added while `send` is in
      // flight keep `staged: true` — the functional updater below never
      // overwrites concurrent mutations with this callback's stale `threads`.
      const submittedCommentIds = new Map<string, string>();
      for (const thread of submitting) {
        if (thread.status !== 'open') {
          continue;
        }
        for (const comment of thread.comments) {
          if (isPendingSubmission(comment)) {
            submittedCommentIds.set(comment.id, comment.body);
          }
        }
      }
      submitInFlight.current = true;
      let sent = false;
      try {
        sent = await send(message, composeReviewCommentSubmitHiddenContext());
      } finally {
        submitInFlight.current = false;
      }
      if (!sent) {
        return;
      }
      setThreads((current) => {
        const next = current.map((thread) => ({
          ...thread,
          comments: thread.comments.map((comment) =>
            comment.staged === true &&
            submittedCommentIds.get(comment.id) === comment.body
              ? { ...comment, staged: false }
              : comment,
          ),
        }));
        saveThreads(next, current);
        return next;
      });
    },
    [threads, saveThreads, diagramOnly],
  );

  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) =>
        typeof diagramOnly === 'function'
          ? diagramOnly(thread)
          : !diagramOnly || thread.anchor.source === 'diagram',
      ),
    [threads, diagramOnly],
  );
  const stagedCount = useMemo(
    () => countPendingComments(visibleThreads),
    [visibleThreads],
  );

  return {
    threads: visibleThreads,
    stagedCount,
    addCodeComment,
    addDiagramComment,
    addGeneralComment,
    addReply,
    editStagedComment,
    deleteStagedComment,
    toggleResolved,
    submit,
  };
}
