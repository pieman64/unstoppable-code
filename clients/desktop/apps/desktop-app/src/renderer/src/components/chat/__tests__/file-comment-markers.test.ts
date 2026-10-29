import type {
  ReviewAnnotation,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';
import {
  buildFileEditorDecorations,
  showsStandaloneFileCommentMarker,
} from '../file-comment-markers';

function thread(
  overrides: Partial<ReviewCommentThread> = {},
): ReviewCommentThread {
  return {
    id: 'thread-1',
    status: 'open',
    createdAt: '2026-07-27T00:00:00.000Z',
    anchorState: 'matched',
    anchor: {
      source: 'code',
      quote: 'const value = 1;',
      lineStart: 1,
      lineEnd: 1,
    },
    comments: [],
    ...overrides,
  };
}

describe('showsStandaloneFileCommentMarker', () => {
  it('shows unresolved standalone comments', () => {
    expect(showsStandaloneFileCommentMarker(thread())).toBe(true);
  });

  it('does not let a resolved thread force a file highlight', () => {
    expect(
      showsStandaloneFileCommentMarker(thread({ status: 'resolved' })),
    ).toBe(false);
  });

  it('leaves agent-attached thread visibility to its annotation', () => {
    expect(
      showsStandaloneFileCommentMarker(
        thread({
          anchor: {
            source: 'code',
            quote: 'const value = 1;',
            lineStart: 1,
            lineEnd: 1,
            annotationId: 'annotation-1',
          },
        }),
      ),
    ).toBe(false);
  });
});

describe('buildFileEditorDecorations', () => {
  it('uses one first-line glyph for a multi-line agent highlight', () => {
    const annotation: ReviewAnnotation = {
      id: 'annotation-1',
      repoId: 'repo-1',
      filePath: '/repo/file.ts',
      side: 'new',
      lineStart: 4,
      lineEnd: 8,
      kind: 'context',
      title: 'Agent note',
      body: 'Inspect these lines.',
    };

    const decorations = buildFileEditorDecorations([annotation], [], 20);
    const highlights = decorations.filter(
      (decoration) => decoration.options.className === 'canopy-file-annotation',
    );
    const glyphs = decorations.filter(
      (decoration) =>
        decoration.options.glyphMarginClassName ===
        'canopy-file-annotation-glyph',
    );

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.range).toMatchObject({
      startLineNumber: 4,
      endLineNumber: 8,
    });
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]?.range).toMatchObject({
      startLineNumber: 4,
      endLineNumber: 4,
    });
  });
});
