import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  createFilesystemScopeResolver,
  readFilesystemScopeFile,
  readNativeRootIdentity,
  resolveFilesystemScopeLink,
  type FilesystemFileRead,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  type WorkerFilesystemFileReadParams,
  type WorkerFilesystemLinkResolveParams,
} from '@canopy/protocol/canopy-core';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import type {
  FileBrowserRoot,
  FileBrowserRootsResult,
} from '../../lib/file-browser-roots';
import {
  createWorkerFilesystemReadAdapter,
  projectLegacyFileContent,
  resolveLegacyFileReadIdentity,
} from '../worker-filesystem-read-adapter';
import {
  AUTHORITY,
  COWORK_DIR,
  createRouteHarness,
  localCaller,
  type RouteHarness,
} from './daemon-files-route-harness';

function root(
  repoId: string,
  absolutePath: string,
  rootKind: FileBrowserRoot['rootKind'] = 'standalone',
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind,
    gitAware: false,
    excludedDescendantRoots: [],
  };
}

function rootsOf(...roots: FileBrowserRoot[]): FileBrowserRootsResult {
  return {
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  };
}

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a typed failure, got ${String(error)}`);
  return error;
}

describe('resolveLegacyFileReadIdentity', () => {
  let base = '';
  let workspace = '';
  let api = '';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'read-identity-'));
    workspace = join(base, 'root');
    api = join(workspace, 'repos', 'api');
    await mkdir(api, { recursive: true });
    await writeFile(join(api, 'a.ts'), 'a');
    await writeFile(join(workspace, 'b.md'), 'b');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const roots = (): FileBrowserRootsResult =>
    rootsOf(root('__workspace_root__', workspace), root('api', api));

  it('assigns a path to the deepest root that contains it', async () => {
    await expect(
      resolveLegacyFileReadIdentity(roots(), join(api, 'a.ts')),
    ).resolves.toEqual({ fileRootId: 'api', relativePath: 'a.ts' });
    await expect(
      resolveLegacyFileReadIdentity(roots(), join(workspace, 'b.md')),
    ).resolves.toEqual({
      fileRootId: '__workspace_root__',
      relativePath: 'b.md',
    });
  });

  it('resolves through a symlinked spelling of the root', async () => {
    const alias = join(base, 'alias');
    await symlink(workspace, alias);
    await expect(
      resolveLegacyFileReadIdentity(roots(), join(alias, 'b.md')),
    ).resolves.toEqual({
      fileRootId: '__workspace_root__',
      relativePath: 'b.md',
    });
  });

  it('answers a missing path with null and keeps other resolution errors', async () => {
    await expect(
      resolveLegacyFileReadIdentity(roots(), join(api, 'gone.ts')),
    ).resolves.toBeNull();
    await expect(
      resolveLegacyFileReadIdentity(roots(), join(api, 'a.ts', 'child')),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('refuses a root directory and a path outside every root', async () => {
    expect(
      (await failure(resolveLegacyFileReadIdentity(roots(), workspace))).payload
        .code,
    ).toBe('worker.filesystem.file.notRegularFile');
    // A nested root's own directory is a directory of its parent root.
    await expect(resolveLegacyFileReadIdentity(roots(), api)).resolves.toEqual({
      fileRootId: '__workspace_root__',
      relativePath: 'repos/api',
    });
    await writeFile(join(base, 'outside.txt'), 'x');
    expect(
      (
        await failure(
          resolveLegacyFileReadIdentity(roots(), join(base, 'outside.txt')),
        )
      ).payload.code,
    ).toBe('worker.filesystem.file.outsideRoots');
  });
});

describe('createWorkerFilesystemReadAdapter', () => {
  const params = (
    overrides: Partial<WorkerFilesystemFileReadParams> = {},
  ): WorkerFilesystemFileReadParams => ({
    scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
    fileRootId: 'repo',
    relativePath: 'a.txt',
    maxBytes: 1024,
    ...overrides,
  });

  it('refuses the sealed viewer scope before reading roots', async () => {
    const getFileBrowserRoots = jest.fn();
    const adapter = createWorkerFilesystemReadAdapter({
      services: { getFileBrowserRoots },
    });
    const error = await failure(
      Promise.resolve(
        adapter['worker.filesystem.file.read'](
          params({
            scope: {
              workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
              worktreeId: 'wt-1',
            },
          }),
          undefined,
        ),
      ),
    );
    expect(error.payload.kind).toBe('capability_unavailable');
    expect(getFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('keeps a roots failure as the runtime cause of an internal error', async () => {
    const cause = new Error('Project project-1 not found');
    const adapter = createWorkerFilesystemReadAdapter({
      services: { getFileBrowserRoots: () => Promise.reject(cause) },
    });
    const error = await failure(
      Promise.resolve(
        adapter['worker.filesystem.file.read'](params(), undefined),
      ),
    );
    expect(error.payload).toMatchObject({ kind: 'internal' });
    expect(error.runtimeCause).toBe(cause);
  });

  it('refuses a remote target as capability_unavailable', async () => {
    const adapter = createWorkerFilesystemReadAdapter({
      services: { getFileBrowserRoots: jest.fn() },
    });
    const error = await failure(
      Promise.resolve(
        adapter['worker.filesystem.file.read'](
          params({
            scope: {
              workspaceId: 'project-1',
              worktreeId: 'wt-1',
              targetId: 'remote',
            },
          }),
          undefined,
        ),
      ),
    );
    expect(error.payload.kind).toBe('capability_unavailable');
  });
});

describe('projectLegacyFileContent', () => {
  const read = (
    result: Partial<FilesystemFileRead['result']>,
  ): FilesystemFileRead => ({
    modifiedAtMs: 1700000000000.25,
    result: {
      fileRootId: 'repo',
      relativePath: 'a',
      name: 'a',
      contentKind: 'text',
      encoding: 'utf8',
      content: 'x',
      sizeBytes: 1,
      returnedBytes: 1,
      truncated: false,
      modifiedAt: '2023-11-14T22:13:20.000Z',
      version: '1:1700000000000',
      ...result,
    },
  });

  it('builds the data URL, the unsupported shape and text with the exact mtime', () => {
    expect(
      projectLegacyFileContent(
        read({
          name: 'a.png',
          contentKind: 'image',
          encoding: 'base64',
          content: 'eHk=',
          mediaType: 'image/png',
        }),
      ),
    ).toEqual({
      kind: 'image',
      content: 'data:image/png;base64,eHk=',
      filename: 'a.png',
      sizeBytes: 1,
      truncated: false,
      modifiedAtMs: 1700000000000.25,
    });
    expect(
      projectLegacyFileContent(
        read({ contentKind: 'unsupported', content: '' }),
      ),
    ).toMatchObject({ kind: 'unsupported', content: '', truncated: false });
    expect(
      projectLegacyFileContent(read({ contentKind: 'html', truncated: true })),
    ).toMatchObject({ kind: 'html', content: 'x', truncated: true });
  });
});

describe('desktop adapter and daemon handler parity', () => {
  let h: RouteHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  type Outcome =
    | { ok: Record<string, unknown> }
    | { error: { kind: string; code: string | undefined } };

  /** A result without its catalog revision, which only the daemon computes. */
  async function outcome(read: () => Promise<object>): Promise<Outcome> {
    try {
      const value = await read();
      return {
        ok: Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'catalogRevision'),
        ),
      };
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) throw error;
      return {
        error: { kind: error.payload.kind, code: error.payload.code },
      };
    }
  }

  it('returns the same result or typed failure for the same scope and path', async () => {
    h = await createRouteHarness({ flag: false });
    const harness = h;
    const resolveScope = await createFilesystemScopeResolver({
      canonicalDataRoot: harness.dataRoot,
      authorityId: AUTHORITY,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      coworkManagedDirName: COWORK_DIR,
      paths: { join, resolve, isAbsolute, sep, basename },
      rootIdentity: readNativeRootIdentity,
    });
    const cases: WorkerFilesystemFileReadParams[] = [
      ['single', 'task', 'single', 'README.md'],
      ['single', 'task', 'single', 'src/index.ts'],
      ['single', 'task', 'single', 'inside/index.ts'],
      ['single', 'task', 'single', 'escape/secret'],
      ['single', 'task', 'single', '.git/HEAD'],
      ['single', 'task', 'single', 'src'],
      ['single', 'task', 'single', 'missing.txt'],
      ['single', 'task', 'single', '../single/README.md'],
      ['single', 'task', 'attachments', 'image.png'],
      ['single', 'task', 'nope', 'README.md'],
      ['multi', 'task', 'api', 'index.ts'],
      ['multi', 'task', '__workspace_root__', 'repos/api/index.ts'],
      ['cowork', 'home', 'workspace', 'doc.md'],
      ['cowork', 'home', 'notes', 'note.md'],
    ].map(([workspaceId, worktreeId, fileRootId, relativePath]) => ({
      scope: { workspaceId, worktreeId },
      fileRootId,
      relativePath,
      maxBytes: 1024,
    }));
    const caller = localCaller({ id: 1 });
    for (const params of cases) {
      const desktop = await outcome(() =>
        harness.runtime.query('worker.filesystem.file.read', params, {
          caller,
        }),
      );
      const daemon = await outcome(async () =>
        readFilesystemScopeFile(
          params,
          await resolveScope(params.scope, 'file'),
        ),
      );
      expect({ params, result: desktop }).toEqual({ params, result: daemon });
    }
  });

  it('resolves the same link identity or typed failure for the same scope', async () => {
    h = await createRouteHarness({ flag: false });
    const harness = h;
    const resolveScope = await createFilesystemScopeResolver({
      canonicalDataRoot: harness.dataRoot,
      authorityId: AUTHORITY,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      coworkManagedDirName: COWORK_DIR,
      paths: { join, resolve, isAbsolute, sep, basename },
      rootIdentity: readNativeRootIdentity,
    });
    const single = { workspaceId: 'single', worktreeId: 'task' };
    const readme = { fileRootId: 'single', relativePath: 'README.md' };
    const cases: WorkerFilesystemLinkResolveParams[] = [
      { scope: single, mode: 'markdown', href: 'src/index.ts', base: readme },
      {
        scope: single,
        mode: 'markdown',
        href: 'inside/index.ts',
        base: readme,
      },
      { scope: single, mode: 'markdown', href: 'src', base: readme },
      { scope: single, mode: 'markdown', href: 'escape/secret', base: readme },
      { scope: single, mode: 'markdown', href: '.git/HEAD', base: readme },
      { scope: single, mode: 'markdown', href: '../x/README.md', base: readme },
      { scope: single, mode: 'markdown', href: 'missing.md', base: readme },
      { scope: single, mode: 'markdown', href: 'https://x.test', base: readme },
      { scope: single, mode: 'markdown', href: 'README.md' },
      {
        scope: single,
        mode: 'markdown',
        href: 'README.md',
        base: { fileRootId: 'nope', relativePath: 'a.md' },
      },
      { scope: single, mode: 'transcript', href: 'src/index.ts#L1' },
      { scope: single, mode: 'transcript', href: 'escape/secret' },
      { scope: single, mode: 'transcript', href: 'src' },
      { scope: single, mode: 'transcript', href: '../README.md' },
      {
        scope: { workspaceId: 'multi', worktreeId: 'task' },
        mode: 'transcript',
        href: 'index.ts',
      },
      {
        scope: { workspaceId: 'multi', worktreeId: 'task' },
        mode: 'markdown',
        href: 'API/index.ts',
        base: { fileRootId: '__workspace_root__', relativePath: 'README.md' },
      },
      {
        scope: { workspaceId: 'cowork', worktreeId: 'home' },
        mode: 'transcript',
        href: 'note.md',
      },
    ];
    const caller = localCaller({ id: 1 });
    for (const params of cases) {
      const desktop = await outcome(() =>
        harness.runtime.query('worker.filesystem.link.resolve', params, {
          caller,
        }),
      );
      const daemon = await outcome(async () =>
        resolveFilesystemScopeLink(
          params,
          await resolveScope(params.scope, 'link'),
        ),
      );
      expect({ params, result: desktop }).toEqual({ params, result: daemon });
    }
  });
});
