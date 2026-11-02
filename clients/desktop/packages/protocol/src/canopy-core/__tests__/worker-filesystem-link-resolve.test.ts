import {
  CANOPY_QUERY_DEFINITIONS,
  WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH,
  WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH,
  WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES,
  WorkerFilesystemLinkResolveErrorSchema,
  WorkerFilesystemLinkResolveParamsSchema,
  WorkerFilesystemLinkResolveResultSchema,
} from '../index';

const params = {
  scope: { workspaceId: 'project', worktreeId: 'task' },
  mode: 'markdown',
  href: '../README.md',
  base: { fileRootId: 'project', relativePath: 'docs/guide.md' },
};

const result = {
  fileRootId: 'project',
  relativePath: 'README.md',
  name: 'README.md',
  kind: 'file',
};

describe('worker.filesystem.link.resolve schemas', () => {
  it('registers a worker-plane query under the read grant', () => {
    expect(
      CANOPY_QUERY_DEFINITIONS['worker.filesystem.link.resolve'],
    ).toMatchObject({
      kind: 'query',
      plane: 'worker',
      domain: 'filesystem',
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    });
  });

  it('accepts both modes, an optional base and a bounded href', () => {
    expect(
      WorkerFilesystemLinkResolveParamsSchema.safeParse(params).success,
    ).toBe(true);
    expect(
      WorkerFilesystemLinkResolveParamsSchema.safeParse({
        scope: params.scope,
        mode: 'transcript',
        href: 'src/a.ts#L2',
      }).success,
    ).toBe(true);
    expect(
      WorkerFilesystemLinkResolveParamsSchema.safeParse({
        ...params,
        href: 'a'.repeat(WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    for (const extra of [
      { mode: 'search' },
      { baseFilePath: '/repo/docs/guide.md' },
      { base: { ...params.base, absolutePath: '/repo/docs/guide.md' } },
    ])
      expect(
        WorkerFilesystemLinkResolveParamsSchema.safeParse({
          ...params,
          ...extra,
        }).success,
      ).toBe(false);
  });

  it('bounds paths at the Windows extended path limit, and links above it', () => {
    expect(WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH).toBe(32_767);
    // A fully percent-encoded `file:` URL of the longest path still fits.
    expect(WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH).toBeGreaterThanOrEqual(
      9 * WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH + 'file:///'.length,
    );
    const longPath = 'a/'.repeat(16_383) + 'b'; // 32,767 characters
    expect(longPath).toHaveLength(WORKER_FILESYSTEM_LINK_MAX_PATH_LENGTH);
    const parses = (value: object): boolean =>
      WorkerFilesystemLinkResolveParamsSchema.safeParse({
        ...params,
        ...value,
      }).success;
    expect(
      parses({ href: 'a'.repeat(WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH) }),
    ).toBe(true);
    expect(parses({ base: { ...params.base, relativePath: longPath } })).toBe(
      true,
    );
    expect(
      parses({ base: { ...params.base, relativePath: `${longPath}c` } }),
    ).toBe(false);
    const parsesResult = (relativePath: string): boolean =>
      WorkerFilesystemLinkResolveResultSchema.safeParse({
        ...result,
        relativePath,
        name: 'n'.repeat(1024),
        catalogRevision: 'r'.repeat(128),
      }).success;
    expect(parsesResult(longPath)).toBe(true);
    expect(parsesResult(`${longPath}c`)).toBe(false);
  });

  it('carries identities only, never a host path', () => {
    expect(
      WorkerFilesystemLinkResolveResultSchema.safeParse(result).success,
    ).toBe(true);
    // A root directory resolves with an empty relative path.
    expect(
      WorkerFilesystemLinkResolveResultSchema.safeParse({
        ...result,
        relativePath: '',
        name: 'project',
        kind: 'directory',
      }).success,
    ).toBe(true);
    for (const extra of [
      { absolutePath: '/repo/README.md' },
      { hostPath: '/repo/README.md' },
      { kind: 'symlink' },
    ])
      expect(
        WorkerFilesystemLinkResolveResultSchema.safeParse({
          ...result,
          ...extra,
        }).success,
      ).toBe(false);
  });

  it('types every failure under worker.filesystem.link', () => {
    expect(WORKER_FILESYSTEM_LINK_RESOLVE_ERROR_CODES).toEqual([
      'worker.filesystem.link.invalidState',
      'worker.filesystem.link.revisionConflict',
      'worker.filesystem.link.notFound',
      'worker.filesystem.link.ambiguous',
      'worker.filesystem.link.outsideRoots',
      'worker.filesystem.link.symlinkEscape',
      'worker.filesystem.link.unsupported',
    ]);
    expect(
      WorkerFilesystemLinkResolveErrorSchema.safeParse({
        kind: 'not_found',
        code: 'worker.filesystem.link.symlinkEscape',
        message: 'The link target is a symlink that leaves its root.',
        retry: { kind: 'never' },
      }).success,
    ).toBe(true);
    expect(
      WorkerFilesystemLinkResolveErrorSchema.safeParse({
        kind: 'not_found',
        code: 'worker.filesystem.file.notFound',
        message: 'x',
        retry: { kind: 'never' },
      }).success,
    ).toBe(false);
  });
});
