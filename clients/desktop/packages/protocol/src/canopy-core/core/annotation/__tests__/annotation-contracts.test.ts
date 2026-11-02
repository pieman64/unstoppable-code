import {
  ANNOTATION_INSTRUCTION_DEFINITIONS,
  ANNOTATION_QUERY_DEFINITIONS,
  AnnotationFileRefSchema,
  AnnotationOperationErrorSchema,
  FileAnnotationDocumentSchema,
  StoredAnnotationCommentThreadSchema,
  StoredFileAnnotationSchema,
} from '..';
import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
} from '../../..';

const scope = { projectId: 'project', worktreeId: 'worktree' };
const file = { kind: 'root', rootId: 'repo', path: 'src/a.ts' } as const;
const thread = {
  id: 'thread-1',
  status: 'open',
  createdAt: '2026-10-01T00:00:00.000Z',
  anchorState: 'matched',
  anchor: { source: 'code', filePath: file, quote: '', lineStart: 2 },
  comments: [
    {
      id: 'c',
      author: 'user',
      body: 'Hi',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ],
};

describe('core.annotation contracts (CAN-4104)', () => {
  it('registers three read queries and four write instructions, core-only', () => {
    expect(Object.keys(ANNOTATION_QUERY_DEFINITIONS)).toEqual([
      'core.annotation.document.get',
      'core.annotation.thread.get',
      'core.annotation.thread.list',
    ]);
    expect(Object.keys(ANNOTATION_INSTRUCTION_DEFINITIONS)).toEqual([
      'core.annotation.document.save',
      'core.annotation.document.append',
      'core.annotation.document.dismiss',
      'core.annotation.thread.reply',
    ]);
    for (const [name, definition] of Object.entries(
      ANNOTATION_QUERY_DEFINITIONS,
    )) {
      expect(CANOPY_QUERY_DEFINITIONS).toHaveProperty([name]);
      expect(definition).toMatchObject({
        placement: 'core-only',
        idempotency: 'inherent',
        requiredGrants: ['core.annotation.read'],
      });
    }
    for (const [name, definition] of Object.entries(
      ANNOTATION_INSTRUCTION_DEFINITIONS,
    )) {
      expect(CANOPY_INSTRUCTION_DEFINITIONS).toHaveProperty([name]);
      expect(definition).toMatchObject({
        placement: 'core-only',
        idempotency:
          name === 'core.annotation.thread.reply' ? 'none' : 'inherent',
        requiredGrants: ['core.annotation.write'],
      });
    }
  });

  it('rejects host paths everywhere a file is named', () => {
    const get = ANNOTATION_QUERY_DEFINITIONS['core.annotation.document.get'];
    expect(get.params.safeParse({ scope, file }).success).toBe(true);
    for (const path of ['/abs/a.ts', 'C:\\repo\\a.ts', 'file:///a.ts']) {
      expect(
        get.params.safeParse({ scope, file: { ...file, path } }).success,
      ).toBe(false);
      expect(get.params.safeParse({ scope, filePath: path }).success).toBe(
        false,
      );
    }
    for (const path of ['../a.ts', 'src/../a.ts', 'src//a.ts', './a.ts', '']) {
      expect(AnnotationFileRefSchema.safeParse({ ...file, path }).success).toBe(
        false,
      );
    }
    expect(
      AnnotationFileRefSchema.safeParse({ kind: 'host', handle: '/tmp/a' })
        .success,
    ).toBe(false);
    const save =
      ANNOTATION_INSTRUCTION_DEFINITIONS['core.annotation.document.save'];
    const document = { file, annotations: [], commentThreads: [thread] };
    expect(
      save.params.safeParse({ scope, document, baseCommentThreadIds: [] })
        .success,
    ).toBe(true);
    expect(
      save.params.safeParse({
        scope,
        document: {
          ...document,
          commentThreads: [
            { ...thread, anchor: { ...thread.anchor, filePath: '/abs/a.ts' } },
          ],
        },
        baseCommentThreadIds: [],
      }).success,
    ).toBe(false);
  });

  it('accepts only slug scope IDs in every operation', () => {
    const unsafe = [
      '..',
      '.',
      '../x',
      'p1/../x',
      'a/b',
      'a\\b',
      '..\\x',
      '%2e%2e',
      '%2F',
      'a%2fb',
      '.hidden',
      '-leading',
      'Upper',
      'a b',
      'a\0b',
      '',
    ];
    const paramsFor = (
      scopeValue: Record<string, string>,
    ): Record<string, Record<string, unknown>> => ({
      'core.annotation.document.get': { scope: scopeValue, file },
      'core.annotation.thread.get': { scope: scopeValue, threadId: 't' },
      'core.annotation.thread.list': { scope: scopeValue },
      'core.annotation.document.save': {
        scope: scopeValue,
        document: { file, annotations: [], commentThreads: [] },
        baseCommentThreadIds: [],
      },
      'core.annotation.document.append': {
        scope: scopeValue,
        file,
        annotations: [],
        commentThreads: [],
      },
      'core.annotation.document.dismiss': {
        scope: scopeValue,
        file,
        annotationId: 'a',
      },
      'core.annotation.thread.reply': {
        scope: scopeValue,
        threadId: 't',
        body: 'b',
        resolve: false,
      },
    });
    const definitions = {
      ...ANNOTATION_QUERY_DEFINITIONS,
      ...ANNOTATION_INSTRUCTION_DEFINITIONS,
    };
    expect(Object.keys(paramsFor(scope)).sort()).toEqual(
      Object.keys(definitions).sort(),
    );
    for (const [name, definition] of Object.entries(definitions)) {
      expect(definition.params.safeParse(paramsFor(scope)[name]).success).toBe(
        true,
      );
      for (const value of unsafe) {
        for (const key of ['projectId', 'worktreeId']) {
          const candidate = paramsFor({ ...scope, [key]: value })[name];
          expect(definition.params.safeParse(candidate).success).toBe(false);
        }
      }
    }
  });

  it('closes params and results but keeps unknown fields of stored entities', () => {
    const reply =
      ANNOTATION_INSTRUCTION_DEFINITIONS['core.annotation.thread.reply'];
    expect(
      reply.params.safeParse({
        scope,
        threadId: 'thread-1',
        body: 'Done',
        resolve: true,
        author: 'user',
      }).success,
    ).toBe(false);
    const parsed = FileAnnotationDocumentSchema.parse({
      file,
      revision: 0,
      annotations: [],
      commentThreads: [{ ...thread, future: { kept: true } }],
    });
    expect(parsed.commentThreads[0]).toHaveProperty('future', { kept: true });
    expect(
      FileAnnotationDocumentSchema.safeParse({
        file,
        revision: 0,
        annotations: [],
        commentThreads: [],
        filePath: '/abs',
      }).success,
    ).toBe(false);
  });

  it('matches the desktop store validators for line ranges and anchors', () => {
    const annotation = {
      id: 'a',
      repoId: 'r',
      filePath: '/abs/a.ts',
      side: 'new',
      lineStart: 2,
      lineEnd: 3,
      kind: 'caution',
      title: 't',
      body: 'b',
    };
    expect(StoredFileAnnotationSchema.safeParse(annotation).success).toBe(true);
    for (const lines of [{ lineStart: 0 }, { lineEnd: 1 }, { lineStart: 1.5 }])
      expect(
        StoredFileAnnotationSchema.safeParse({ ...annotation, ...lines })
          .success,
      ).toBe(false);
    const stored = {
      ...thread,
      anchor: { ...thread.anchor, filePath: '/abs' },
    };
    expect(StoredAnnotationCommentThreadSchema.safeParse(stored).success).toBe(
      true,
    );
    for (const anchor of [
      { unanchored: true },
      { lineStart: undefined, lineEnd: 4 },
      { lineEnd: 1 },
      { view: 'diff' },
    ])
      expect(
        StoredAnnotationCommentThreadSchema.safeParse({
          ...stored,
          anchor: { ...stored.anchor, ...anchor },
        }).success,
      ).toBe(false);
  });

  it('types conflict and not-found errors with their reasons', () => {
    expect(
      AnnotationOperationErrorSchema.safeParse({
        kind: 'conflict',
        code: 'core.annotation.revisionConflict',
        message: 'The file annotations changed.',
        details: { reason: 'REVISION_CONFLICT', currentRevision: 3 },
        retry: { kind: 'after_refresh', resource: 'core.annotation.document' },
      }).success,
    ).toBe(true);
    expect(
      AnnotationOperationErrorSchema.safeParse({
        kind: 'not_found',
        code: 'core.annotation.notFound',
        message: 'File comment thread not found.',
        details: { reason: 'NOT_FOUND', path: '/abs' },
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
