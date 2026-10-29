import { describeReviewCommentContext } from '@canopy/desktop-shared/types/code-review';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSendMessageRequest,
  FileAnnotationDocument,
  ReviewAnnotation,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';

export type FileCommentSubmitHiddenContext = Extract<
  NonNullable<ChatSendMessageRequest['hiddenContext']>,
  { kind: 'file-comment-instructions' }
>;

const FILE_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT =
  '<system_instruction>For each file comment thread: inspect the referenced view, comparison, side, snapshot, and quoted lines before answering. Diff coordinates are not current-file coordinates; outdated anchors require verification. Comments may be questions; do not assume a change is requested when ambiguous. Use GetFileComments to read full thread history. After addressing a thread, use RespondToFileComment to reply and resolve it, or leave it open and ask for clarification. Apply clearly requested changes directly.</system_instruction>';

export interface UseFileComments {
  document: FileAnnotationDocument;
  /** Both origins for the shared drawer; editor markers still use document. */
  drawerThreads?: ReviewCommentThread[];
  stagedCount: number;
  otherViewCount: number;
  view: 'file' | 'diff';
  addComment: (anchor: ReviewCommentAnchor, body: string) => void;
  discussAnnotation: (annotation: ReviewAnnotation, body: string) => void;
  addReply: (threadId: string, body: string) => void;
  editStagedComment: (
    threadId: string,
    commentId: string,
    body: string,
  ) => void;
  deleteStagedComment: (threadId: string, commentId: string) => void;
  toggleResolved: (threadId: string) => void;
  dismissAnnotation: (annotationId: string) => void;
  submit: (
    send: (
      message: string,
      hiddenContext: FileCommentSubmitHiddenContext,
    ) => Promise<boolean>,
  ) => Promise<void>;
}

function emptyDocument(filePath: string): FileAnnotationDocument {
  return { filePath, annotations: [], commentThreads: [] };
}

function countStaged(threads: ReviewCommentThread[]): number {
  return threads.reduce(
    (count, thread) =>
      thread.status === 'open'
        ? count +
          thread.comments.filter((comment) => comment.staged === true).length
        : count,
    0,
  );
}

function formatLocation(anchor: ReviewCommentAnchor, filePath: string): string {
  if (anchor.unanchored) return filePath;
  const start = anchor.lineStart;
  const end = anchor.lineEnd ?? start;
  if (start === undefined) return filePath;
  return end !== undefined && end !== start
    ? `${filePath}:${start}-${end}`
    : `${filePath}:${start}`;
}

export interface FileCommentSubmitPayload {
  message: string;
  submittedComments: ReadonlyMap<string, string>;
}

export function prepareFileCommentSubmit(
  document: FileAnnotationDocument,
): FileCommentSubmitPayload {
  const entries = document.commentThreads.flatMap((thread) => {
    if (thread.status !== 'open') return [];
    const staged = thread.comments.filter((comment) => comment.staged === true);
    return staged.length ? [{ thread, staged }] : [];
  });
  const submittedComments = new Map<string, string>();
  for (const { staged } of entries) {
    for (const comment of staged) {
      submittedComments.set(comment.id, comment.body);
    }
  }
  if (entries.length === 0) {
    return { message: '', submittedComments };
  }

  const sections = entries.map(({ thread, staged }, index) => {
    const lines = [
      `${index + 1}. ${thread.anchor.view === 'diff' ? 'Diff' : 'File'} comment thread \`${thread.id}\`:`,
      `   - Location: ${formatLocation(thread.anchor, document.filePath)}`,
    ];
    lines.push(
      `   - Context: ${describeReviewCommentContext(thread.anchor)}; anchor ${thread.anchorState}`,
    );
    if (!thread.anchor.unanchored && thread.anchor.quote.trim()) {
      lines.push('   - Selected file text:');
      lines.push('     ```');
      for (const line of thread.anchor.quote.split('\n')) {
        lines.push(`     ${line}`);
      }
      lines.push('     ```');
    }
    for (const comment of staged) {
      lines.push(`   - Comment: ${comment.body}`);
    }
    return lines.join('\n');
  });

  return {
    message: [
      `I have ${entries.length} file comment thread${entries.length === 1 ? '' : 's'} to review.`,
      '',
      ...sections,
    ].join('\n'),
    submittedComments,
  };
}

export function composeFileCommentSubmitMessage(
  document: FileAnnotationDocument,
): string {
  return prepareFileCommentSubmit(document).message;
}

export function markFileCommentsSubmitted(
  document: FileAnnotationDocument,
  submittedComments: ReadonlyMap<string, string>,
): FileAnnotationDocument {
  return {
    ...document,
    commentThreads: document.commentThreads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((comment) =>
        submittedComments.has(comment.id) &&
        submittedComments.get(comment.id) === comment.body
          ? { ...comment, staged: false }
          : comment,
      ),
    })),
  };
}

function hiddenContext(): FileCommentSubmitHiddenContext {
  return {
    kind: 'file-comment-instructions',
    text: FILE_COMMENT_SUBMIT_HIDDEN_CONTEXT_TEXT,
  };
}

function withEffectiveDiffState(
  document: FileAnnotationDocument,
  diff: ReviewCommentAnchor['diff'] | undefined,
): FileAnnotationDocument {
  return {
    ...document,
    commentThreads: document.commentThreads.map((thread) =>
      thread.anchor.view === 'diff' &&
      (!diff || thread.anchor.diff?.snapshotId !== diff.snapshotId)
        ? { ...thread, anchorState: 'outdated' as const }
        : thread,
    ),
  };
}

export function useFileComments(
  projectId: string,
  worktreeId: string,
  filePath: string,
  view: 'file' | 'diff' = 'file',
  diff?: ReviewCommentAnchor['diff'],
  diffAnnotations?: ReviewAnnotation[],
): UseFileComments {
  const [document, setDocument] = useState<FileAnnotationDocument>(() =>
    emptyDocument(filePath),
  );
  const documentRef = useRef(document);
  const submitInFlightRef = useRef(false);
  const replaceDocument = useCallback((next: FileAnnotationDocument): void => {
    documentRef.current = next;
    setDocument(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    replaceDocument(emptyDocument(filePath));
    void window.api.fileAnnotations
      .get({ projectId, worktreeId, filePath })
      .then((next) => {
        if (!cancelled) replaceDocument(next);
      })
      .catch(() => {
        // Keep the empty local document when persisted annotations cannot be
        // loaded. A later update event can still restore the shared state.
      });
    const unsubscribe = window.api.fileAnnotations.onUpdated((event) => {
      if (
        event.projectId === projectId &&
        event.worktreeId === worktreeId &&
        event.document.filePath === filePath
      ) {
        replaceDocument(event.document);
      }
    });
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [filePath, projectId, replaceDocument, worktreeId]);

  const persist = useCallback(
    (update: (current: FileAnnotationDocument) => FileAnnotationDocument) => {
      setDocument((current) => {
        const next = update(current);
        documentRef.current = next;
        void window.api.fileAnnotations
          .save({
            projectId,
            worktreeId,
            document: next,
            baseCommentThreadIds: current.commentThreads.map(
              (thread) => thread.id,
            ),
          })
          .catch(() => {
            // Preserve the optimistic local draft. The next successful edit or
            // update event will reconcile it with persisted state.
          });
        return next;
      });
    },
    [projectId, worktreeId],
  );

  const addComment = useCallback(
    (anchor: ReviewCommentAnchor, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const now = new Date().toISOString();
      const { diff: anchorDiff, ...anchorWithoutDiff } = anchor;
      const identity = anchorDiff ?? diff;
      const thread: ReviewCommentThread = {
        id: crypto.randomUUID(),
        status: 'open',
        createdAt: now,
        anchor: {
          ...anchorWithoutDiff,
          ...(view === 'diff' && identity
            ? { view: 'diff' as const, diff: identity }
            : { view: 'file' as const }),
        },
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
      persist((current) => ({
        ...current,
        commentThreads: [...current.commentThreads, thread],
      }));
    },
    [persist, view, diff],
  );

  const discussAnnotation = useCallback(
    (annotation: ReviewAnnotation, body: string): void => {
      addComment(
        {
          source: 'code',
          repoId: annotation.repoId,
          filePath,
          side: annotation.side,
          lineStart: annotation.lineStart,
          lineEnd: annotation.lineEnd,
          quote: '',
          annotationId: annotation.id,
        },
        body,
      );
    },
    [addComment, filePath],
  );

  const addReply = useCallback(
    (threadId: string, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const comment: ReviewComment = {
        id: crypto.randomUUID(),
        author: 'user',
        body: trimmed,
        createdAt: new Date().toISOString(),
        staged: true,
      };
      persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
          thread.id === threadId
            ? { ...thread, comments: [...thread.comments, comment] }
            : thread,
        ),
      }));
    },
    [persist],
  );

  const editStagedComment = useCallback(
    (threadId: string, commentId: string, body: string): void => {
      const trimmed = body.trim();
      if (!trimmed) return;
      persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
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
      }));
    },
    [persist],
  );

  const deleteStagedComment = useCallback(
    (threadId: string, commentId: string): void => {
      persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.flatMap((thread) => {
          if (thread.id !== threadId) return [thread];
          const comments = thread.comments.filter(
            (comment) => comment.id !== commentId || comment.staged !== true,
          );
          return comments.length ? [{ ...thread, comments }] : [];
        }),
      }));
    },
    [persist],
  );

  const toggleResolved = useCallback(
    (threadId: string): void => {
      persist((current) => ({
        ...current,
        commentThreads: current.commentThreads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                status: thread.status === 'open' ? 'resolved' : 'open',
              }
            : thread,
        ),
      }));
    },
    [persist],
  );

  const dismissAnnotation = useCallback(
    (annotationId: string): void => {
      void window.api.fileAnnotations
        .dismiss({ projectId, worktreeId, filePath, annotationId })
        .then(replaceDocument)
        .catch(() => {
          // Leave the annotation visible when persistence rejects the
          // dismissal so the UI never implies it was successfully cleared.
        });
    },
    [filePath, projectId, replaceDocument, worktreeId],
  );

  const submit = useCallback(
    async (
      send: (
        message: string,
        context: FileCommentSubmitHiddenContext,
      ) => Promise<boolean>,
    ): Promise<void> => {
      if (submitInFlightRef.current) return;
      const effective = withEffectiveDiffState(documentRef.current, diff);
      const { message, submittedComments } =
        prepareFileCommentSubmit(effective);
      if (!message) return;
      submitInFlightRef.current = true;
      try {
        let sent = false;
        try {
          sent = await send(message, hiddenContext());
        } catch {
          sent = false;
        }
        if (!sent) return;

        const latest = documentRef.current;
        const submitted = markFileCommentsSubmitted(latest, submittedComments);
        replaceDocument(submitted);
        try {
          const saved = await window.api.fileAnnotations.save({
            projectId,
            worktreeId,
            document: submitted,
            baseCommentThreadIds: latest.commentThreads.map(
              (thread) => thread.id,
            ),
          });
          if (documentRef.current === submitted) {
            replaceDocument(saved);
          }
        } catch {
          // Dispatch was accepted, so keep the local comments submitted even
          // if persistence fails. A later edit will retry persistence.
        }
      } finally {
        submitInFlightRef.current = false;
      }
    },
    [diff, projectId, replaceDocument, worktreeId],
  );

  // The drawer and header must agree about which threads are active. A retained
  // comparison can become outdated without its stored open/resolved status changing.
  const effectiveDocument = useMemo(
    () => withEffectiveDiffState(document, diff),
    [document, diff],
  );
  const drawerThreads = effectiveDocument.commentThreads;
  const visibleDocument = useMemo(
    () => ({
      ...effectiveDocument,
      annotations:
        view === 'file'
          ? effectiveDocument.annotations
          : (diffAnnotations ?? []),
      commentThreads: drawerThreads.filter(
        (thread) => (thread.anchor.view ?? 'file') === view,
      ),
    }),
    [effectiveDocument, view, drawerThreads, diffAnnotations],
  );
  const otherViewCount = drawerThreads.filter(
    (thread) =>
      thread.status === 'open' &&
      thread.anchorState !== 'outdated' &&
      (thread.anchor.view ?? 'file') !== view,
  ).length;

  const stagedCount = useMemo(
    () => countStaged(effectiveDocument.commentThreads),
    [effectiveDocument.commentThreads],
  );

  return {
    document: visibleDocument,
    drawerThreads,
    view,
    otherViewCount,
    stagedCount,
    addComment,
    discussAnnotation,
    addReply,
    editStagedComment,
    deleteStagedComment,
    toggleResolved,
    dismissAnnotation,
    submit,
  };
}
