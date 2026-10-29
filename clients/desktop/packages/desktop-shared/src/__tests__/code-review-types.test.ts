import {
  emptyCodeReviewFile,
  isReviewAnnotationSet,
  isReviewCommentThread,
  normalizeCodeReviewFile,
} from '../types/code-review';

describe('code-review types', () => {
  it('validates comparison provenance without reinterpreting legacy file anchors', () => {
    const thread = {
      id: 'thread',
      status: 'open',
      createdAt: '2026-09-17',
      anchorState: 'matched',
      comments: [],
      anchor: {
        source: 'code',
        quote: 'removed',
        view: 'diff',
        side: 'old',
        diff: { source: 'uncommitted', snapshotId: 'snapshot' },
      },
    };
    expect(isReviewCommentThread(thread)).toBe(true);
    expect(
      isReviewCommentThread({
        ...thread,
        anchor: {
          ...thread.anchor,
          diff: { source: 'unknown', snapshotId: 'snapshot' },
        },
      }),
    ).toBe(false);
    expect(
      isReviewCommentThread({
        ...thread,
        anchor: { ...thread.anchor, diff: { source: 'turn', snapshotId: '' } },
      }),
    ).toBe(false);
    expect(
      isReviewCommentThread({
        ...thread,
        anchor: { source: 'code', quote: '' },
      }),
    ).toBe(true);
  });

  it('emptyCodeReviewFile returns an unarmed v1 file', () => {
    const file = emptyCodeReviewFile();
    expect(file).toEqual({
      version: 1,
      armed: false,
      commentThreads: [],
      diagrams: {},
    });
  });

  it('isReviewAnnotationSet accepts a valid set', () => {
    expect(
      isReviewAnnotationSet({
        schemaVersion: 1,
        annotations: [
          {
            id: 'a1',
            repoId: 'repo-1',
            filePath: 'src/index.ts',
            side: 'new',
            lineStart: 3,
            lineEnd: 5,
            kind: 'explanation',
            title: 'Retry loop',
            body: 'Retries the request three times.',
          },
        ],
      }),
    ).toBe(true);
  });

  it('isReviewAnnotationSet rejects bad kind and missing fields', () => {
    expect(isReviewAnnotationSet(null)).toBe(false);
    expect(isReviewAnnotationSet({ schemaVersion: 1 })).toBe(false);
    expect(
      isReviewAnnotationSet({
        schemaVersion: 1,
        annotations: [{ id: 'a1', kind: 'nope' }],
      }),
    ).toBe(false);
  });

  it('normalizeCodeReviewFile falls back on corrupt input and preserves valid data', () => {
    expect(normalizeCodeReviewFile(undefined)).toEqual(emptyCodeReviewFile());
    expect(normalizeCodeReviewFile({ version: 2 })).toEqual(
      emptyCodeReviewFile(),
    );
    const valid = {
      version: 1,
      armed: true,
      armedAt: '2026-07-07T00:00:00.000Z',
      commentThreads: [
        {
          id: 't1',
          status: 'open',
          createdAt: '2026-07-07T00:00:00.000Z',
          anchor: {
            source: 'code',
            quote: 'const x = 1;',
            repoId: 'repo-1',
            filePath: 'src/index.ts',
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
          },
          anchorState: 'matched',
          comments: [
            {
              id: 'c1',
              author: 'user',
              body: 'Why?',
              createdAt: '2026-07-07T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
      diagrams: {},
    };
    expect(normalizeCodeReviewFile(valid)).toEqual(valid);
    // Invalid threads are dropped, not fatal.
    expect(
      normalizeCodeReviewFile({
        version: 1,
        armed: false,
        commentThreads: [{ id: 42 }],
        diagrams: {},
      }),
    ).toEqual(emptyCodeReviewFile());
  });
});
