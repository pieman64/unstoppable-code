import type {
  ReviewAnnotation,
  ReviewCommentAnchor,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import type * as monaco from 'monaco-editor';

type StandaloneMarkedFileCommentThread = ReviewCommentThread & {
  status: 'open';
  anchor: ReviewCommentAnchor & {
    lineStart: number;
    annotationId?: undefined;
  };
};

/**
 * Only unresolved, standalone threads add their own marker to a file.
 * Agent-attached threads inherit the annotation marker, while resolved
 * threads remain available in the comments drawer without forcing a highlight.
 */
export function showsStandaloneFileCommentMarker(
  thread: ReviewCommentThread,
): thread is StandaloneMarkedFileCommentThread {
  return (
    thread.status === 'open' &&
    !thread.anchor.annotationId &&
    thread.anchor.lineStart !== undefined
  );
}

export function buildFileEditorDecorations(
  annotations: ReviewAnnotation[],
  commentThreads: ReviewCommentThread[],
  lineCount: number,
): monaco.editor.IModelDeltaDecoration[] {
  const annotationDecorations = annotations
    .filter(
      (annotation) =>
        annotation.lineStart >= 1 && annotation.lineStart <= lineCount,
    )
    .flatMap((annotation): monaco.editor.IModelDeltaDecoration[] => {
      const hoverMessage = {
        value: `**Agent highlight**\n\n${annotation.title}\n\n_Click to view or clear._`,
      };
      return [
        {
          range: {
            startLineNumber: annotation.lineStart,
            startColumn: 1,
            endLineNumber: Math.min(annotation.lineEnd, lineCount),
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'canopy-file-annotation',
            linesDecorationsClassName: 'canopy-file-annotation-line-decoration',
            hoverMessage,
          },
        },
        {
          // Monaco repeats glyphMarginClassName on every line covered by its
          // decoration, so the marker uses a separate first-line range.
          range: {
            startLineNumber: annotation.lineStart,
            startColumn: 1,
            endLineNumber: annotation.lineStart,
            endColumn: 1,
          },
          options: {
            glyphMarginClassName: 'canopy-file-annotation-glyph',
            glyphMarginHoverMessage: hoverMessage,
          },
        },
      ];
    });

  const threadDecorations = commentThreads.flatMap(
    (thread): monaco.editor.IModelDeltaDecoration[] => {
      if (
        !showsStandaloneFileCommentMarker(thread) ||
        thread.anchor.lineStart < 1 ||
        thread.anchor.lineStart > lineCount
      ) {
        return [];
      }
      const startLine = thread.anchor.lineStart;
      return [
        {
          range: {
            startLineNumber: startLine,
            startColumn: 1,
            endLineNumber: Math.min(
              thread.anchor.lineEnd ?? startLine,
              lineCount,
            ),
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: 'canopy-file-comment-anchor',
            hoverMessage: { value: 'Open file comment thread' },
          },
        },
        {
          range: {
            startLineNumber: startLine,
            startColumn: 1,
            endLineNumber: startLine,
            endColumn: 1,
          },
          options: {
            glyphMarginClassName: 'canopy-file-comment-glyph',
            glyphMarginHoverMessage: {
              value: 'Open file comment thread',
            },
          },
        },
      ];
    },
  );

  return [...annotationDecorations, ...threadDecorations];
}
