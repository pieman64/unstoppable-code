import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANNOTATION_INSTRUCTION_DEFINITIONS,
  ANNOTATION_QUERY_DEFINITIONS,
  hasHostAbsolutePath,
  type AnnotationScope,
  type AnnotationCommentThread,
  type FileAnnotation,
} from '@canopy/protocol/canopy-core';
import { createFileAnnotationEngine } from '../engine';
import { createAnnotationOperations } from '../operations';

const tempDir = mkdtempSync(join(tmpdir(), 'file-annotation-operations-'));
const statePath = (scope: AnnotationScope): string =>
  join(tempDir, `${scope.projectId}-${scope.worktreeId}.json`);
const roots = [{ id: 'repo', absolutePath: '/work/repo' }];
const READ_ONLY_PROJECT = 'read-only-project';
const operations = createAnnotationOperations({
  engine: createFileAnnotationEngine({
    statePath,
    now: () => new Date('2026-10-22T00:00:00.000Z'),
    randomId: () => 'reply-id',
  }),
  roots: () => Promise.resolve(roots),
  isWritable: (target) => target.projectId !== READ_ONLY_PROJECT,
});
const scope = { projectId: 'project', worktreeId: 'worktree' };
const file = { kind: 'root' as const, rootId: 'repo', path: 'src/a.ts' };

const annotation: FileAnnotation = {
  id: 'ann-1',
  repoId: 'repo',
  filePath: file,
  side: 'new',
  lineStart: 1,
  lineEnd: 2,
  kind: 'caution',
  title: 'Title',
  body: 'Body',
};

const thread: AnnotationCommentThread = {
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  anchorState: 'matched',
  anchor: { source: 'code', filePath: file, quote: 'one', lineStart: 1 },
  comments: [
    {
      id: 'c-1',
      author: 'user',
      body: 'Please fix.',
      createdAt: '2026-10-01T00:00:00.000Z',
      staged: false,
    },
  ],
};

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('core.annotation operations', () => {
  it('stores host paths and answers with portable references only', async () => {
    const appended = await operations.appendAnnotations({
      scope,
      file,
      annotations: [annotation],
      commentThreads: [thread],
    });
    expect(appended.document).toMatchObject({ file, revision: 1 });
    expect(hasHostAbsolutePath(appended)).toBe(false);
    expect(
      ANNOTATION_INSTRUCTION_DEFINITIONS[
        'core.annotation.document.append'
      ].result.safeParse(appended).success,
    ).toBe(true);

    const stored: unknown = JSON.parse(
      await readFile(statePath(scope), 'utf8'),
    );
    expect(stored).toMatchObject({
      files: [
        {
          filePath: '/work/repo/src/a.ts',
          annotations: [{ filePath: '/work/repo/src/a.ts' }],
          commentThreads: [{ anchor: { filePath: '/work/repo/src/a.ts' } }],
        },
      ],
    });

    const read = await operations.getDocument({ scope, file });
    expect(read).toEqual(appended);
    expect(
      ANNOTATION_QUERY_DEFINITIONS[
        'core.annotation.document.get'
      ].result.safeParse(read).success,
    ).toBe(true);
  });

  it('lists, reads and replies to threads with their file references', async () => {
    await expect(operations.listThreads({ scope })).resolves.toEqual({
      threads: [{ file, revision: 1, thread }],
    });
    await expect(
      operations.getThread({ scope, threadId: thread.id }),
    ).resolves.toEqual({ file, revision: 1, thread });

    const reply = await operations.replyToThread({
      scope,
      threadId: thread.id,
      body: 'Done.',
      resolve: true,
      expectedRevision: 1,
    });
    expect(reply.resolved).toBe(true);
    expect(reply.document.revision).toBe(2);
    expect(reply.document.commentThreads[0]).toMatchObject({
      status: 'resolved',
      comments: [
        { id: 'c-1' },
        {
          id: 'reply-id',
          author: 'agent',
          body: 'Done.',
          createdAt: '2026-10-22T00:00:00.000Z',
          staged: false,
        },
      ],
    });
    expect(hasHostAbsolutePath(reply)).toBe(false);
  });

  it('saves a document by reference and keeps relative recorded paths', async () => {
    const saved = await operations.saveDocument({
      scope,
      document: {
        file,
        annotations: [{ ...annotation, filePath: 'src/a.ts' }],
        commentThreads: [],
      },
      baseCommentThreadIds: [thread.id],
      expectedRevision: 2,
    });
    expect(saved.document.revision).toBe(3);
    expect(saved.document.commentThreads).toEqual([]);
    expect(saved.document.annotations[0]?.filePath).toBe('src/a.ts');
  });

  it('dismisses through a host handle for a file outside every root', async () => {
    const outside = createAnnotationOperations({
      engine: createFileAnnotationEngine({ statePath }),
      roots: () => Promise.resolve([]),
      isWritable: () => true,
    });
    // A file outside every root reaches the document by the handle the host
    // projection issued for it.
    const { createAnnotationPathProjection } = await import('../paths');
    const handle = createAnnotationPathProjection(scope, []).fileRef(
      '/tmp/outside.md',
    );
    const result = await outside.dismissAnnotation({
      scope,
      file: handle,
      annotationId: 'missing',
    });
    expect(result.document).toMatchObject({ file: handle, revision: 1 });
    expect(hasHostAbsolutePath(result)).toBe(false);
  });

  it('refuses an unknown root before writing anything', async () => {
    const before = await readFile(statePath(scope), 'utf8');
    await expect(
      operations.appendAnnotations({
        scope,
        file: { kind: 'root', rootId: 'gone', path: 'a.ts' },
        annotations: [],
        commentThreads: [],
      }),
    ).rejects.toMatchObject({
      payload: { kind: 'not_found', code: 'core.annotation.notFound' },
    });
    await expect(
      operations.saveDocument({
        scope,
        document: {
          file,
          annotations: [
            {
              ...annotation,
              filePath: {
                kind: 'host',
                handle: 'h-11111111111111111111111111111111',
              },
            },
          ],
          commentThreads: [],
        },
        baseCommentThreadIds: [],
      }),
    ).rejects.toMatchObject({ payload: { kind: 'not_found' } });
    await expect(readFile(statePath(scope), 'utf8')).resolves.toBe(before);
  });

  it('refuses every write to a scope the host keeps read-only', async () => {
    const readOnly = { projectId: READ_ONLY_PROJECT, worktreeId: 'worktree' };
    const refused = {
      payload: {
        kind: 'permission_denied',
        code: 'core.annotation.readOnlyScope',
        details: { reason: 'READ_ONLY_SCOPE' },
      },
    };
    await expect(
      operations.saveDocument({
        scope: readOnly,
        document: { file, annotations: [annotation], commentThreads: [] },
        baseCommentThreadIds: [],
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      operations.appendAnnotations({
        scope: readOnly,
        file,
        annotations: [annotation],
        commentThreads: [thread],
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      operations.dismissAnnotation({
        scope: readOnly,
        file,
        annotationId: annotation.id,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      operations.replyToThread({
        scope: readOnly,
        threadId: thread.id,
        body: 'Done.',
        resolve: true,
      }),
    ).rejects.toMatchObject(refused);
    await expect(readFile(statePath(readOnly), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Reads stay available.
    await expect(
      operations.getDocument({ scope: readOnly, file }),
    ).resolves.toMatchObject({ document: { revision: 0 } });
  });
});
