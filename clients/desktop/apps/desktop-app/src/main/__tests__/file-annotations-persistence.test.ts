import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PathsModule from '../lib/paths';
import type {
  ReviewAnnotation,
  ReviewCommentThread,
} from '@canopy/desktop-shared/types';

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotations-'));

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return {
    ...actual,
    getFileAnnotationsStateFilePath: (
      projectId: string,
      worktreeId: string,
    ): string => join(tempDir, `${projectId}-${worktreeId}.json`),
  };
});

import {
  appendFileAnnotations,
  dismissFileAnnotation,
  readFileAnnotationDocument,
  readFileCommentThreads,
  respondToFileComment,
  saveFileAnnotationDocument,
} from '../lib/file-annotations-persistence';

const annotation: ReviewAnnotation = {
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

const thread: ReviewCommentThread = {
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

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('file annotation persistence', () => {
  it('appends annotations and their agent-started comment threads', async () => {
    const document = await appendFileAnnotations({
      projectId: 'project',
      worktreeId: 'worktree',
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [thread],
    });

    expect(document.annotations).toEqual([annotation]);
    expect(document.commentThreads).toEqual([thread]);
    await expect(
      readFileAnnotationDocument('project', 'worktree', annotation.filePath),
    ).resolves.toEqual(document);
  });

  it('drops invalid appended annotations and comment threads before persistence', async () => {
    const invalidAnnotation: ReviewAnnotation = {
      ...annotation,
      id: 'invalid-annotation',
      lineStart: Number.NaN,
    };
    const invalidThread: ReviewCommentThread = {
      ...thread,
      id: 'invalid-thread',
      anchor: { ...thread.anchor, lineStart: Number.NaN },
    };

    const document = await appendFileAnnotations({
      projectId: 'normalized-project',
      worktreeId: 'normalized-worktree',
      filePath: annotation.filePath,
      annotations: [annotation, invalidAnnotation],
      commentThreads: [thread, invalidThread],
    });

    expect(document.annotations).toEqual([annotation]);
    expect(document.commentThreads).toEqual([thread]);
  });

  it('posts an agent reply, resolves the thread, and redacts staged drafts when read', async () => {
    await saveFileAnnotationDocument({
      projectId: 'project',
      worktreeId: 'worktree',
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [
          {
            ...thread,
            comments: [
              ...thread.comments,
              {
                id: 'submitted-1',
                author: 'user',
                body: 'Please address this.',
                createdAt: '2026-07-26T00:00:30.000Z',
                staged: false,
              },
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

    const result = await respondToFileComment({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: thread.id,
      body: 'Addressed.',
      resolve: true,
    });
    expect(result.ok).toBe(true);
    expect(result.document?.commentThreads[0]).toMatchObject({
      status: 'resolved',
      comments: [
        expect.objectContaining({ author: 'agent' }),
        expect.objectContaining({ author: 'user', staged: false }),
        expect.objectContaining({ author: 'user', staged: true }),
        expect.objectContaining({ author: 'agent', body: 'Addressed.' }),
      ],
    });

    const read = await readFileCommentThreads({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: thread.id,
    });
    expect(read.ok).toBe(true);
  });

  it('rejects agent responses to threads without submitted user feedback', async () => {
    await appendFileAnnotations({
      projectId: 'staged-project',
      worktreeId: 'staged-worktree',
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
      respondToFileComment({
        projectId: 'staged-project',
        worktreeId: 'staged-worktree',
        threadId: thread.id,
        body: 'Mutated before submission.',
        resolve: true,
      }),
    ).resolves.toEqual({
      ok: false,
      resolved: false,
      error: 'File comment thread not found.',
    });

    const stored = await readFileAnnotationDocument(
      'staged-project',
      'staged-worktree',
      annotation.filePath,
    );
    expect(stored.commentThreads[0]).toMatchObject({
      status: 'open',
      comments: [
        expect.objectContaining({
          id: 'staged-feedback',
          staged: true,
        }),
      ],
    });
  });

  it('allows the renderer to delete a thread whose last staged comment was removed', async () => {
    const saved = await saveFileAnnotationDocument({
      projectId: 'project',
      worktreeId: 'worktree',
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
    await appendFileAnnotations({
      projectId: 'race-project',
      worktreeId: 'race-worktree',
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [concurrentThread],
    });

    const saved = await saveFileAnnotationDocument({
      projectId: 'race-project',
      worktreeId: 'race-worktree',
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
    const filePath = join(tempDir, 'corrupt-project-corrupt-worktree.json');
    const corruptState = '{"version":1,"files":[';
    await writeFile(filePath, corruptState, 'utf8');

    const saved = await saveFileAnnotationDocument({
      projectId: 'corrupt-project',
      worktreeId: 'corrupt-worktree',
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [thread],
      },
      baseCommentThreadIds: [],
    });

    expect(saved.commentThreads).toEqual([thread]);
    await expect(readFile(filePath, 'utf8')).resolves.not.toBe(corruptState);
    await expect(
      readFileAnnotationDocument(
        'corrupt-project',
        'corrupt-worktree',
        annotation.filePath,
      ),
    ).resolves.toEqual(saved);
  });

  it('hides agent annotation threads until the user submits feedback', async () => {
    await appendFileAnnotations({
      projectId: 'visibility-project',
      worktreeId: 'visibility-worktree',
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [thread],
    });

    await expect(
      readFileCommentThreads({
        projectId: 'visibility-project',
        worktreeId: 'visibility-worktree',
      }),
    ).resolves.toEqual({ ok: true, mode: 'all', threads: [] });
    await expect(
      readFileCommentThreads({
        projectId: 'visibility-project',
        worktreeId: 'visibility-worktree',
        threadId: thread.id,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'File comment thread not found.',
    });

    const submittedThread: ReviewCommentThread = {
      ...thread,
      comments: [
        ...thread.comments,
        {
          id: 'submitted-feedback',
          author: 'user',
          body: 'Please make this change.',
          createdAt: '2026-07-26T00:01:00.000Z',
          staged: false,
        },
      ],
    };
    await saveFileAnnotationDocument({
      projectId: 'visibility-project',
      worktreeId: 'visibility-worktree',
      document: {
        filePath: annotation.filePath,
        annotations: [annotation],
        commentThreads: [submittedThread],
      },
      baseCommentThreadIds: [thread.id],
    });

    const visible = await readFileCommentThreads({
      projectId: 'visibility-project',
      worktreeId: 'visibility-worktree',
      threadId: thread.id,
    });
    expect(visible).toMatchObject({
      ok: true,
      mode: 'single',
      thread: { id: thread.id },
    });
  });

  it('clears an agent highlight without deleting its comment thread', async () => {
    await appendFileAnnotations({
      projectId: 'dismiss-project',
      worktreeId: 'dismiss-worktree',
      filePath: annotation.filePath,
      annotations: [annotation],
      commentThreads: [{ ...thread, status: 'resolved' }],
    });

    const dismissed = await dismissFileAnnotation({
      projectId: 'dismiss-project',
      worktreeId: 'dismiss-worktree',
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
});
