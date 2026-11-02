import {
  CANOPY_QUERY_DEFINITIONS,
  classifyFileContentKind,
  fileImageMediaType,
  WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
  WORKER_FILESYSTEM_FILE_READ_MAX_RESULT_BYTES,
  WorkerFilesystemFileReadErrorSchema,
  WorkerFilesystemFileReadParamsSchema,
  WorkerFilesystemFileReadResultSchema,
} from '../index';

const params = {
  scope: { workspaceId: 'project', worktreeId: 'task' },
  fileRootId: 'project',
  relativePath: 'src/a.ts',
  maxBytes: 1024,
};

const result = {
  fileRootId: 'project',
  relativePath: 'src/a.ts',
  name: 'a.ts',
  contentKind: 'text',
  encoding: 'utf8',
  content: 'a',
  sizeBytes: 1,
  returnedBytes: 1,
  truncated: false,
  modifiedAt: '2026-10-24T12:00:00.123Z',
  version: '1:1792886400123',
};

describe('worker.filesystem.file.read schemas', () => {
  it('registers a worker-plane query under the read grant', () => {
    expect(
      CANOPY_QUERY_DEFINITIONS['worker.filesystem.file.read'],
    ).toMatchObject({
      kind: 'query',
      plane: 'worker',
      domain: 'filesystem',
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    });
  });

  it('bounds maxBytes at the 5 MiB preview cap and rejects unknown params', () => {
    expect(WorkerFilesystemFileReadParamsSchema.safeParse(params).success).toBe(
      true,
    );
    for (const maxBytes of [0, 1.5, WORKER_FILESYSTEM_FILE_READ_MAX_BYTES + 1])
      expect(
        WorkerFilesystemFileReadParamsSchema.safeParse({ ...params, maxBytes })
          .success,
      ).toBe(false);
    for (const extra of [
      { offset: 0 },
      { encoding: 'utf8' },
      { absolutePath: '/x' },
    ])
      expect(
        WorkerFilesystemFileReadParamsSchema.safeParse({ ...params, ...extra })
          .success,
      ).toBe(false);
  });

  it('accepts a full 5 MiB image preview, far above the 32 KB bounded-JSON cap', () => {
    const content = Buffer.alloc(
      WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
    ).toString('base64');
    const image = {
      ...result,
      contentKind: 'image',
      encoding: 'base64',
      content,
      mediaType: 'image/png',
      sizeBytes: WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
      returnedBytes: WORKER_FILESYSTEM_FILE_READ_MAX_BYTES,
    };
    expect(WorkerFilesystemFileReadResultSchema.safeParse(image).success).toBe(
      true,
    );
    expect(Buffer.byteLength(JSON.stringify(image))).toBeLessThan(
      WORKER_FILESYSTEM_FILE_READ_MAX_RESULT_BYTES,
    );
    expect(
      WorkerFilesystemFileReadResultSchema.safeParse({
        ...image,
        content: `${content}AAAA`,
      }).success,
    ).toBe(false);
  });

  it('keeps host paths out of results and accepts additive fields', () => {
    expect(
      WorkerFilesystemFileReadResultSchema.safeParse({
        ...result,
        absolutePath: '/host/a.ts',
      }).success,
    ).toBe(false);
    expect(
      WorkerFilesystemFileReadResultSchema.safeParse({ ...result, future: 1 })
        .success,
    ).toBe(true);
  });

  it('declares the file error codes and no other namespace', () => {
    for (const code of [
      'worker.filesystem.file.notFound',
      'worker.filesystem.file.outsideRoots',
      'worker.filesystem.file.notRegularFile',
      'worker.filesystem.file.invalidState',
      'worker.filesystem.file.revisionConflict',
      'worker.filesystem.file.tooLarge',
    ])
      expect(
        WorkerFilesystemFileReadErrorSchema.safeParse({
          kind: 'not_found',
          code,
          message: 'x',
          retry: { kind: 'never' },
        }).success,
      ).toBe(true);
    expect(
      WorkerFilesystemFileReadErrorSchema.safeParse({
        kind: 'not_found',
        code: 'worker.filesystem.roots.notFound',
        message: 'x',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});

it('classifies by the lowercase extension, defaulting to text', () => {
  expect(classifyFileContentKind('a.PNG')).toBe('image');
  expect(classifyFileContentKind('a.mdx')).toBe('markdown');
  expect(classifyFileContentKind('a.HTM')).toBe('html');
  expect(classifyFileContentKind('a.sqlite3')).toBe('unsupported');
  expect(classifyFileContentKind('Makefile')).toBe('text');
  expect(classifyFileContentKind('a.toString')).toBe('text');
  expect(classifyFileContentKind('.png')).toBe('text');
  expect(classifyFileContentKind('docs/v1.2/notes')).toBe('text');
  expect(classifyFileContentKind('C:\\a.png\\notes')).toBe('text');
  expect(fileImageMediaType('a.SVG')).toBe('image/svg+xml');
  expect(fileImageMediaType('a.ts')).toBeUndefined();
});
