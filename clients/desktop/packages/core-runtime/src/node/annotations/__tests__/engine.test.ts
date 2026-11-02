import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AnnotationScope,
  StoredAnnotationCommentThread,
  StoredFileAnnotation,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { createFileAnnotationEngine } from '../engine';

// Ported from the desktop's file-annotations-persistence suite (CAN-4104),
// plus the revision, compare-and-swap and lock cases the engine added.

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotations-engine-'));
const statePath = (scope: AnnotationScope): string =>
  join(tempDir, `${scope.projectId}-${scope.worktreeId}.json`);
const engine = createFileAnnotationEngine({ statePath });
const scope = (
  projectId: string,
  worktreeId = 'worktree',
): AnnotationScope => ({
  projectId,
  worktreeId,
});

const annotation: StoredFileAnnotation = {
  id: 'annotation-1',
  kind: 'context',
  title: 'Check this',
  body: 'Check this',
  repoId: 'repo',
  filePath: '/workspace/src/file.ts',
  side: 'new',
  lineStart: 2,
  lineEnd: 3,
};

const thread: StoredAnnotationCommentThread = {
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-07-26T00:00:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    repoId: 'repo',
    filePath: '/workspace/src/file.ts',
    side: 'new',
    lineStart: 2,
    lineEnd: 3,
    quote: 'two\nthree',
    annotationId: annotation.id,
  },
  comments: [
    {
      id: 'comment-1',
      author: 'agent',
      body: 'Could you confirm this?',
      createdAt: '2026-07-26T00:00:00.000Z',
      staged: false,
    },
  ],
};

const submitted = (
  body: string,
  id = 'submitted-1',
): StoredAnnotationCommentThread['comments'][number] => ({
  id,
  author: 'user',
  body,
  createdAt: '2026-07-26T00:00:30.000Z',
  staged: false,
});

function isConflict(error: unknown): boolean {
  return (
    error instanceof CanopyOperationError &&
    error.payload.kind === 'conflict' &&
    error.payload.code === 'core.annotation.revisionConflict'
  );
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('file annotation engine', () => {
  it('appends annotations and their agent-started comment threads', async () => {
    const document = await engine.appendAnnotations({
      scope: scope('project'),
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [thread],
    });

    expect(document.annotations).toEqual([annotation]);
    expect(document.commentThreads).toEqual([thread]);
    expect(document.revision).toBe(1);
    await expect(
      engine.readDocument(scope('project'), annotation.filePath),
    ).resolves.toEqual(document);
  });

  it('drops invalid appended annotations and comment threads before persistence', async () => {
    const invalidAnnotation = {
      ...annotation,
      id: 'invalid-annotation',
      lineStart: Number.NaN,
    };
    const invalidThread = {
      ...thread,
      id: 'invalid-thread',
      anchor: { ...thread.anchor, lineStart: Number.NaN },
    };

    const document = await engine.appendAnnotations({
      scope: scope('normalized-project', 'normalized-worktree'),
      filePath: annotation.filePath,
      annotations: [annotation, invalidAnnotation],
      commentThreads: [thread, invalidThread],
    });

    expect(document.annotations).toEqual([annotation]);
    expect(document.commentThreads).toEqual([thread]);
  });

  it('posts an agent reply, resolves the thread, and keeps staged drafts', async () => {
    await engine.saveDocument({
      scope: scope('project'),
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [
          {
            ...thread,
            comments: [
              ...thread.comments,
              submitted('Please address this.'),
              {
                id: 'draft-1',
                author: 'user',
                body: 'Private until submitted',
                createdAt: '2026-07-26T00:01:00.000Z',
                staged: true,
              },
            ],
          },
        ],
      },
      baseCommentThreadIds: [thread.id],
    });

    const result = await engine.replyToThread({
      scope: scope('project'),
      threadId: thread.id,
      body: 'Addressed.',
      resolve: true,
    });
    expect(result.resolved).toBe(true);
    expect(result.document.commentThreads[0]).toMatchObject({
      status: 'resolved',
      comments: [
        expect.objectContaining({ author: 'agent' }),
        expect.objectContaining({ author: 'user', staged: false }),
        expect.objectContaining({ author: 'user', staged: true }),
        expect.objectContaining({ author: 'agent', body: 'Addressed.' }),
      ],
    });

    await expect(
      engine.readThread(scope('project'), thread.id),
    ).resolves.toMatchObject({ filePath: annotation.filePath });
  });

  it('rejects agent responses to threads without submitted user feedback', async () => {
    await engine.appendAnnotations({
      scope: scope('staged-project', 'staged-worktree'),
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [
        {
          ...thread,
          anchor: { ...thread.anchor, annotationId: undefined },
          comments: [
            {
              id: 'staged-feedback',
              author: 'user',
              body: 'Do not send this yet.',
              createdAt: '2026-07-26T00:01:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    });

    await expect(
      engine.replyToThread({
        scope: scope('staged-project', 'staged-worktree'),
        threadId: thread.id,
        body: 'Mutated before submission.',
        resolve: true,
      }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'not_found',
        code: 'core.annotation.notFound',
        message: 'File comment thread not found.',
      },
    });

    const stored = await engine.readDocument(
      scope('staged-project', 'staged-worktree'),
      annotation.filePath,
    );
    expect(stored.revision).toBe(1);
    expect(stored.commentThreads[0]).toMatchObject({
      status: 'open',
      comments: [
        expect.objectContaining({ id: 'staged-feedback', staged: true }),
      ],
    });
  });

  it('allows the renderer to delete a thread whose last staged comment was removed', async () => {
    const saved = await engine.saveDocument({
      scope: scope('project'),
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [],
      },
      baseCommentThreadIds: [thread.id],
    });
    expect(saved.commentThreads).toEqual([]);
  });

  it('rebases a stale renderer save over a concurrently appended thread', async () => {
    const concurrentThread = {
      ...thread,
      id: 'concurrent-thread',
      comments: thread.comments.map((comment) => ({
        ...comment,
        id: 'concurrent-comment',
      })),
    };
    await engine.appendAnnotations({
      scope: scope('race-project', 'race-worktree'),
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [concurrentThread],
    });

    const saved = await engine.saveDocument({
      scope: scope('race-project', 'race-worktree'),
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [],
      },
      baseCommentThreadIds: [],
    });

    expect(saved.commentThreads).toEqual([concurrentThread]);
  });

  it('recovers corrupt state with empty defaults during a save', async () => {
    const corrupt = scope('corrupt-project', 'corrupt-worktree');
    const corruptState = '{"version":1,"files":[';
    await writeFile(statePath(corrupt), corruptState, 'utf8');

    const saved = await engine.saveDocument({
      scope: corrupt,
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [thread],
      },
      baseCommentThreadIds: [],
    });

    expect(saved.commentThreads).toEqual([thread]);
    expect(saved.revision).toBe(1);
    await expect(readFile(statePath(corrupt), 'utf8')).resolves.not.toBe(
      corruptState,
    );
    await expect(
      engine.readDocument(corrupt, annotation.filePath),
    ).resolves.toEqual(saved);
  });

  it('hides agent annotation threads until the user submits feedback', async () => {
    const visibility = scope('visibility-project', 'visibility-worktree');
    await engine.appendAnnotations({
      scope: visibility,
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [thread],
    });

    await expect(engine.listOpenThreads(visibility)).resolves.toEqual([]);
    await expect(
      engine.readThread(visibility, thread.id),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });

    await engine.saveDocument({
      scope: visibility,
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [
          {
            ...thread,
            comments: [
              ...thread.comments,
              submitted('Please make this change.', 'submitted-feedback'),
            ],
          },
        ],
      },
      baseCommentThreadIds: [thread.id],
    });

    await expect(
      engine.readThread(visibility, thread.id),
    ).resolves.toMatchObject({ revision: 2, thread: { id: thread.id } });
  });

  it('clears an agent highlight without deleting its comment thread', async () => {
    const dismiss = scope('dismiss-project', 'dismiss-worktree');
    await engine.appendAnnotations({
      scope: dismiss,
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [{ ...thread, status: 'resolved' }],
    });

    const dismissed = await engine.dismissAnnotation({
      scope: dismiss,
      filePath: annotation.filePath,
      annotationId: annotation.id,
    });

    expect(dismissed.annotations).toEqual([]);
    expect(dismissed.commentThreads).toHaveLength(1);
    expect(dismissed.commentThreads[0]?.status).toBe('resolved');
    expect(dismissed.commentThreads[0]?.anchor).toMatchObject({
      lineStart: 2,
      lineEnd: 3,
    });
    expect(dismissed.commentThreads[0]?.anchor.annotationId).toBeUndefined();
  });

  describe('revisions', () => {
    it('reads existing documents without a revision as revision 0', async () => {
      const legacy = scope('legacy-project');
      await writeFile(
        statePath(legacy),
        JSON.stringify({
          version: 1,
          files: [
            {
              filePath: annotation.filePath,
              annotations: [annotation],
              commentThreads: [thread],
            },
          ],
        }),
        'utf8',
      );
      const document = await engine.readDocument(legacy, annotation.filePath);
      expect(document).toEqual({
        filePath: annotation.filePath,
        revision: 0,
        annotations: [annotation],
        commentThreads: [thread],
      });
      const saved = await engine.saveDocument({
        scope: legacy,
        document,
        baseCommentThreadIds: [thread.id],
        expectedRevision: 0,
      });
      expect(saved.revision).toBe(1);
      const written: unknown = JSON.parse(
        await readFile(statePath(legacy), 'utf8'),
      );
      expect(written).toMatchObject({
        version: 1,
        files: [{ filePath: annotation.filePath, revision: 1 }],
      });
    });

    it('treats a malformed stored revision as 0', async () => {
      const malformed = scope('malformed-revision');
      await writeFile(
        statePath(malformed),
        JSON.stringify({
          version: 1,
          files: [{ filePath: annotation.filePath, revision: -3 }],
        }),
        'utf8',
      );
      await expect(
        engine.readDocument(malformed, annotation.filePath),
      ).resolves.toMatchObject({ revision: 0 });
    });

    it('advances only the written document', async () => {
      const revisions = scope('revision-project');
      await engine.appendAnnotations({
        scope: revisions,
        filePath: '/workspace/a.ts',
        annotations: [],
        commentThreads: [],
      });
      await engine.appendAnnotations({
        scope: revisions,
        filePath: '/workspace/b.ts',
        annotations: [],
        commentThreads: [],
      });
      await engine.dismissAnnotation({
        scope: revisions,
        filePath: '/workspace/a.ts',
        annotationId: 'none',
      });
      await expect(
        engine.readDocument(revisions, '/workspace/a.ts'),
      ).resolves.toMatchObject({ revision: 2 });
      await expect(
        engine.readDocument(revisions, '/workspace/b.ts'),
      ).resolves.toMatchObject({ revision: 1 });
    });

    it('refuses a stale expected revision on every write without writing', async () => {
      const cas = scope('cas-project');
      await engine.saveDocument({
        scope: cas,
        document: {
          filePath: annotation.filePath,
          annotations: [annotation],
          commentThreads: [
            { ...thread, comments: [...thread.comments, submitted('Go')] },
          ],
        },
        baseCommentThreadIds: [],
      });
      const before = await readFile(statePath(cas), 'utf8');
      const stale = 0;
      const attempts: Array<() => Promise<unknown>> = [
        (): Promise<unknown> =>
          engine.saveDocument({
            scope: cas,
            document: {
              filePath: annotation.filePath,
              annotations: [],
              commentThreads: [],
            },
            baseCommentThreadIds: [thread.id],
            expectedRevision: stale,
          }),
        (): Promise<unknown> =>
          engine.appendAnnotations({
            scope: cas,
            filePath: annotation.filePath,
            annotations: [{ ...annotation, id: 'new' }],
            commentThreads: [],
            expectedRevision: stale,
          }),
        (): Promise<unknown> =>
          engine.dismissAnnotation({
            scope: cas,
            filePath: annotation.filePath,
            annotationId: annotation.id,
            expectedRevision: stale,
          }),
        (): Promise<unknown> =>
          engine.replyToThread({
            scope: cas,
            threadId: thread.id,
            body: 'Late',
            resolve: true,
            expectedRevision: stale,
          }),
      ];
      for (const attempt of attempts) {
        const error: unknown = await attempt().catch(
          (caught: unknown) => caught,
        );
        expect(isConflict(error)).toBe(true);
        expect(error).toMatchObject({
          payload: {
            details: { reason: 'REVISION_CONFLICT', currentRevision: 1 },
            retry: {
              kind: 'after_refresh',
              resource: 'core.annotation.document',
            },
          },
        });
      }
      await expect(readFile(statePath(cas), 'utf8')).resolves.toBe(before);
      await expect(
        engine.saveDocument({
          scope: cas,
          document: {
            filePath: annotation.filePath,
            annotations: [annotation],
            commentThreads: [],
          },
          baseCommentThreadIds: [thread.id],
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({ revision: 2, commentThreads: [] });
    });

    it('treats a missing document as revision 0 for compare-and-swap', async () => {
      const fresh = scope('fresh-project');
      await expect(
        engine.appendAnnotations({
          scope: fresh,
          filePath: annotation.filePath,
          annotations: [annotation],
          commentThreads: [],
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
      await expect(
        engine.appendAnnotations({
          scope: fresh,
          filePath: annotation.filePath,
          annotations: [annotation],
          commentThreads: [],
          expectedRevision: 0,
        }),
      ).resolves.toMatchObject({ revision: 1 });
    });
  });

  describe('serialization', () => {
    it('serializes concurrent writers so no acknowledged change is lost', async () => {
      const busy = scope('busy-project');
      await engine.saveDocument({
        scope: busy,
        document: {
          filePath: annotation.filePath,
          annotations: [],
          commentThreads: [
            { ...thread, comments: [...thread.comments, submitted('Go')] },
          ],
        },
        baseCommentThreadIds: [],
      });
      const writes = await Promise.all([
        engine.replyToThread({
          scope: busy,
          threadId: thread.id,
          body: 'Reply A',
          resolve: false,
        }),
        engine.appendAnnotations({
          scope: busy,
          filePath: annotation.filePath,
          annotations: [annotation],
          commentThreads: [],
        }),
        engine.replyToThread({
          scope: busy,
          threadId: thread.id,
          body: 'Reply B',
          resolve: true,
        }),
        engine.dismissAnnotation({
          scope: busy,
          filePath: annotation.filePath,
          annotationId: 'missing',
        }),
      ]);
      expect(
        writes
          .map((write) =>
            'revision' in write ? write.revision : write.document.revision,
          )
          .sort(),
      ).toEqual([2, 3, 4, 5]);
      const final = await engine.readDocument(busy, annotation.filePath);
      expect(final.revision).toBe(5);
      expect(final.annotations).toEqual([annotation]);
      expect(final.commentThreads[0]).toMatchObject({ status: 'resolved' });
      expect(
        final.commentThreads[0]?.comments.map((comment) => comment.body),
      ).toEqual(expect.arrayContaining(['Reply A', 'Reply B', 'Go']));
    });

    it('keeps unknown fields of stored entities through a rewrite', async () => {
      const extra = scope('extra-project');
      await writeFile(
        statePath(extra),
        JSON.stringify({
          version: 1,
          files: [
            {
              filePath: annotation.filePath,
              annotations: [{ ...annotation, future: { kept: true } }],
              commentThreads: [
                {
                  ...thread,
                  future: 1,
                  anchor: { ...thread.anchor, futureAnchor: 'a' },
                  comments: [{ ...thread.comments[0], futureComment: [1] }],
                },
              ],
            },
          ],
        }),
        'utf8',
      );
      await engine.dismissAnnotation({
        scope: extra,
        filePath: annotation.filePath,
        annotationId: 'other',
      });
      const written: unknown = JSON.parse(
        await readFile(statePath(extra), 'utf8'),
      );
      expect(written).toMatchObject({
        files: [
          {
            annotations: [{ future: { kept: true } }],
            commentThreads: [
              {
                future: 1,
                anchor: { futureAnchor: 'a' },
                comments: [{ futureComment: [1] }],
              },
            ],
          },
        ],
      });
    });
  });
});
