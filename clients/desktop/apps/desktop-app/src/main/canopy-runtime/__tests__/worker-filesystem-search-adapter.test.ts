import { EventEmitter } from 'node:events';
import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  createFilesystemScopeResolver,
  createFilesystemSearchEngine,
  readNativeRootIdentity,
  searchFilesystemScope,
  type FilesystemSearchPage,
} from '@canopy/core-runtime/node';
import {
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
  WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH,
  WorkerFilesystemSearchResultSchema,
  type WorkerFilesystemSearchParams,
  type WorkerFilesystemSearchResult,
} from '@canopy/protocol/canopy-core';
import { createDefaultFileIndexingPreferences } from '@canopy/protocol/file-indexing';
import {
  directoryInputsFor,
  fakeGit,
} from '../../../../../core-daemon/src/__tests__/filesystem-fixtures';
import type {
  FileBrowserRoot,
  FileBrowserRootsResult,
} from '../../lib/file-browser-roots';
import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
} from '../../lib/file-glob-matcher';
import {
  buildFileIndexResult,
  type FileSystemReadBoundary,
} from '../../lib/file-system-listing';
import { readPreferencesFile } from '../../lib/preferences-store';
import { createDesktopRuntime } from '../desktop-runtime';
import { createInterimInMemoryBindingProvider } from '../renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  RENDERER_RELAY_LIMITS,
} from '../renderer-relay/relay';
import {
  createWorkerFilesystemSearchAdapter,
  type WorkerFilesystemSearchServices,
} from '../worker-filesystem-search-adapter';
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
  overrides: Partial<FileBrowserRoot> = {},
): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'standalone',
    gitAware: false,
    excludedDescendantRoots: [],
    ...overrides,
  };
}

function rootsOf(...roots: FileBrowserRoot[]): FileBrowserRootsResult {
  return {
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  };
}

const context: CanopyHandlerContext = {
  requestId: 'search-test',
  caller: localCaller({ id: 1 }),
  metadata: {},
  signal: new AbortController().signal,
};

/** Handlers may answer synchronously; tests always await a promise. */
function search(
  adapter: ReturnType<typeof createWorkerFilesystemSearchAdapter>,
  request: WorkerFilesystemSearchParams,
): Promise<WorkerFilesystemSearchResult> {
  return Promise.resolve(adapter['worker.filesystem.search'](request, context));
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

const params = (
  overrides: Partial<WorkerFilesystemSearchParams> = {},
): WorkerFilesystemSearchParams => ({
  scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
  fileRootId: 'repo',
  query: '',
  mode: 'name',
  ...overrides,
});

describe('createWorkerFilesystemSearchAdapter', () => {
  let base = '';
  let repo = '';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'search-adapter-'));
    repo = join(base, 'repo');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'a.ts'), '');
    await writeFile(join(repo, 'b.log'), '');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function services(
    overrides: Partial<WorkerFilesystemSearchServices> = {},
  ): WorkerFilesystemSearchServices & {
    listed: string[];
    getRoots: jest.Mock;
  } {
    const listed: string[] = [];
    const getRoots = jest.fn(() =>
      Promise.resolve(rootsOf(root('repo', repo, { gitAware: true }))),
    );
    return {
      listed,
      getRoots,
      getFileBrowserRoots: getRoots,
      readFileIndexingPreferences: () =>
        Promise.resolve(createDefaultFileIndexingPreferences()),
      listIgnoredPathEntries: (path): Promise<string[]> => {
        listed.push(path);
        return Promise.resolve(['b.log']);
      },
      readBoundaryForRoot: () => undefined,
      ...overrides,
    };
  }

  it('walks the desktop root with desktop Git ignore marks and captures local paths', async () => {
    const pages: FilesystemSearchPage[] = [];
    const source = services();
    const adapter = createWorkerFilesystemSearchAdapter({
      engine: createFilesystemSearchEngine(),
      services: source,
      projection: { root: () => null, capture: (page) => pages.push(page) },
    });
    const result = await search(adapter, params());
    expect(result).toEqual({
      matches: [
        {
          fileRootId: 'repo',
          path: 'src/a.ts',
          kind: 'file',
          name: 'a.ts',
          isIgnored: false,
        },
        {
          fileRootId: 'repo',
          path: 'b.log',
          kind: 'file',
          name: 'b.log',
          isIgnored: true,
        },
      ],
      nextCursor: null,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(base);
    expect(pages[0]?.files.map((file) => file.absolutePath)).toEqual([
      join(repo, 'src', 'a.ts'),
      join(repo, 'b.log'),
    ]);
    expect(source.listed).toEqual([repo]);
  });

  it('uses the projection root without reading roots or preferences', async () => {
    const readPreferences = jest.fn(() =>
      Promise.resolve(createDefaultFileIndexingPreferences()),
    );
    const source = services({ readFileIndexingPreferences: readPreferences });
    const adapter = createWorkerFilesystemSearchAdapter({
      engine: createFilesystemSearchEngine(),
      services: source,
      projection: {
        root: (projectId, worktreeId, fileRootId) =>
          projectId === 'project-1' &&
          worktreeId === 'wt-1' &&
          fileRootId === 'repo'
            ? {
                root: root('repo', repo),
                fileIndexing: {
                  disabledBuiltinGlobIds: [],
                  customGlobs: [
                    { id: 'src', pattern: 'src/**', enabled: true },
                  ],
                },
              }
            : null,
        capture: () => undefined,
      },
    });
    await expect(search(adapter, params())).resolves.toMatchObject({
      matches: [{ path: 'b.log', isIgnored: false }],
    });
    expect(source.getRoots).not.toHaveBeenCalled();
    expect(readPreferences).not.toHaveBeenCalled();
    // Not Git-aware: no listing.
    expect(source.listed).toEqual([]);
  });

  it('answers an unknown root as notFound and a roots failure as internal with its cause', async () => {
    const engine = createFilesystemSearchEngine();
    const missing = await failure(
      search(
        createWorkerFilesystemSearchAdapter({ engine, services: services() }),
        params({ fileRootId: 'other' }),
      ),
    );
    expect(missing.payload).toMatchObject({
      kind: 'not_found',
      code: 'worker.filesystem.search.notFound',
    });
    const cause = new Error('roots exploded');
    const broken = await failure(
      search(
        createWorkerFilesystemSearchAdapter({
          engine,
          services: services({
            getFileBrowserRoots: () => Promise.reject(cause),
          }),
        }),
        params(),
      ),
    );
    expect(broken.payload.kind).toBe('internal');
    expect(broken.payload.message).not.toContain('exploded');
    expect(broken.runtimeCause).toBe(cause);
  });

  it('refuses a remote target and an invalid id before reading roots', async () => {
    const source = services();
    const adapter = createWorkerFilesystemSearchAdapter({
      engine: createFilesystemSearchEngine(),
      services: source,
    });
    const remote = await failure(
      search(
        adapter,
        params({
          scope: {
            workspaceId: 'project-1',
            worktreeId: 'wt-1',
            targetId: 'elsewhere',
          },
        }),
      ),
    );
    expect(remote.payload.kind).toBe('capability_unavailable');
    const invalid = await failure(
      search(
        adapter,
        params({ scope: { workspaceId: 'Bad Id', worktreeId: 'wt-1' } }),
      ),
    );
    expect(invalid.payload.kind).toBe('invalid_argument');
    expect(source.getRoots).not.toHaveBeenCalled();
  });

  it('reads sealed roots through their no-follow boundary', async () => {
    const assertDirectory = jest.fn(() => Promise.resolve());
    const adapter = createWorkerFilesystemSearchAdapter({
      engine: createFilesystemSearchEngine(),
      services: services({
        readBoundaryForRoot: () => ({
          assertDirectory,
          readDirectory: (_root, target): Promise<Dirent[]> =>
            readdir(target, { withFileTypes: true }),
          lstatEntry: (_root, target): Promise<Stats> => lstat(target),
        }),
      }),
    });
    await expect(search(adapter, params())).resolves.toMatchObject({
      matches: [{ path: 'src/a.ts' }, {}],
    });
    expect(assertDirectory).toHaveBeenCalledWith(repo, repo);
    expect(assertDirectory).toHaveBeenCalledWith(repo, join(repo, 'src'));
  });
});

/**
 * A nested tree of directory names no host filesystem would allow, read
 * through a stub boundary: every path is past the 4,096 and 1,024 bounds an
 * earlier match schema had, and base's index had none.
 */
function longPathTree(rootPath: string): {
  readBoundary: FileSystemReadBoundary;
  relativePaths: string[];
} {
  const levels = 7;
  const segment = (level: number): string =>
    `${String(level)}${'é'.repeat(4_000)}`;
  const fileName = (index: number): string =>
    `${String(index)}${'\u0001'.repeat(1_500)}.ts`;
  const children = new Map<string, Dirent[]>();
  const kinds = new Map<string, 'file' | 'directory'>([
    [rootPath, 'directory'],
  ]);
  const dirent = (
    parentPath: string,
    name: string,
    kind: 'file' | 'directory',
  ): Dirent => ({
    name,
    parentPath,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  });
  const relativePaths: string[] = [];
  let directory = rootPath;
  let relative = '';
  for (let level = 0; level < levels; level += 1) {
    const name = segment(level);
    const child = join(directory, name);
    // Each level holds one file, then the next directory (directories sort first).
    const file = fileName(level);
    kinds.set(child, 'directory');
    kinds.set(join(directory, file), 'file');
    children.set(directory, [
      dirent(directory, name, 'directory'),
      dirent(directory, file, 'file'),
    ]);
    relativePaths.push(`${relative}${file}`);
    directory = child;
    relative = `${relative}${name}/`;
  }
  const leafFile = fileName(levels);
  kinds.set(join(directory, leafFile), 'file');
  children.set(directory, [dirent(directory, leafFile, 'file')]);
  relativePaths.push(`${relative}${leafFile}`);
  // Directories first: each level's file comes after everything below it.
  relativePaths.reverse();
  const stats = (
    target: string,
  ): Awaited<ReturnType<FileSystemReadBoundary['lstatEntry']>> => {
    const kind = kinds.get(target);
    if (!kind) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return {
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'directory',
      isSymbolicLink: () => false,
    };
  };
  return {
    readBoundary: {
      assertDirectory: (_root, target) =>
        stats(target).isDirectory()
          ? Promise.resolve()
          : Promise.reject(new Error('not a directory')),
      readDirectory: (_root, target) =>
        Promise.resolve(children.get(target) ?? []),
      lstatEntry: (_root, target) => Promise.resolve(stats(target)),
    },
    relativePaths,
  };
}

/** `count` files in one `src` directory, read through a stub boundary. */
function flatTree(
  rootPath: string,
  count: number,
): { readBoundary: FileSystemReadBoundary } {
  const src = join(rootPath, 'src');
  const dirent = (
    parentPath: string,
    name: string,
    kind: 'file' | 'directory',
  ): Dirent => ({
    name,
    parentPath,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  });
  const files = Array.from({ length: count }, (_, index) =>
    dirent(src, `file-${String(index).padStart(5, '0')}.ts`, 'file'),
  );
  const stats = (
    target: string,
  ): Awaited<ReturnType<FileSystemReadBoundary['lstatEntry']>> => {
    const kind = target === rootPath || target === src ? 'directory' : 'file';
    return {
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'directory',
      isSymbolicLink: () => false,
    };
  };
  return {
    readBoundary: {
      assertDirectory: (_root, target) =>
        target === rootPath || target === src
          ? Promise.resolve()
          : Promise.reject(new Error('not a directory')),
      readDirectory: (_root, target) =>
        Promise.resolve(
          target === rootPath
            ? [dirent(rootPath, 'src', 'directory')]
            : target === src
              ? files
              : [],
        ),
      lstatEntry: (_root, target) => Promise.resolve(stats(target)),
    },
  };
}

class RelaySender extends EventEmitter {
  readonly mainFrame = {
    url: 'app://renderer/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return this.mainFrame.url;
  }
  isDestroyed(): boolean {
    return false;
  }
}

describe('worker.filesystem.search pages within the renderer relay cap', () => {
  const FILE_COUNT = 25_000;
  const rootPath = resolve(tmpdir(), 'relay-capped-index');
  const tree = flatTree(rootPath, FILE_COUNT);
  const fileIndexing = createDefaultFileIndexingPreferences();
  const searchServices: WorkerFilesystemSearchServices = {
    getFileBrowserRoots: () => Promise.resolve(rootsOf(root('repo', rootPath))),
    readFileIndexingPreferences: () => Promise.resolve(fileIndexing),
    listIgnoredPathEntries: () => Promise.resolve([]),
    readBoundaryForRoot: () => tree.readBoundary,
  };
  const directWalk = (
    purpose: 'mentions' | 'file-explorer',
  ): ReturnType<typeof buildFileIndexResult> =>
    buildFileIndexResult(rootPath, {
      gitAware: false,
      globMatcher:
        purpose === 'file-explorer'
          ? buildFileExplorerGlobMatcher()
          : buildFileGlobMatcher(fileIndexing),
      readBoundary: tree.readBoundary,
    });

  it('splits a 25,000-match page into relay-sized pages that concatenate to the walk', async () => {
    const runtime = createDesktopRuntime({
      fileSearchServices: searchServices,
    });
    const relay = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(runtime),
      resolveSurface: () => ({
        surface: 'main',
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'electron-web-contents:1',
          authorityId: 'local-desktop',
          interfaceKind: 'desktop',
          grants: ['worker.filesystem.read'],
        },
      }),
    });
    const sender = new RelaySender(1);
    try {
      const expected = (await directWalk('mentions')).files.map(
        (file) => file.relativePath,
      );
      expect(expected).toHaveLength(FILE_COUNT);
      // Unbounded, the first page would be the whole walk, well over the cap.
      expect(
        Buffer.byteLength(
          JSON.stringify(
            expected.map((path) => ({
              fileRootId: 'repo',
              path,
              kind: 'file',
              name: basename(path),
              isIgnored: false,
            })),
          ),
        ),
      ).toBeGreaterThan(2 * RENDERER_RELAY_LIMITS.maxFrameBytes);
      const paths: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const reply = await relay.invoke(
          { sender, senderFrame: sender.mainFrame },
          {
            kind: 'request',
            method: 'worker.filesystem.search',
            params: {
              ...params({ limit: WORKER_FILESYSTEM_SEARCH_MAX_LIMIT }),
              ...(cursor !== undefined && { cursor }),
            },
          },
        );
        if (!reply.ok) throw new Error(JSON.stringify(reply.error));
        expect(
          Buffer.byteLength(JSON.stringify(reply.value)),
        ).toBeLessThanOrEqual(RENDERER_RELAY_LIMITS.maxFrameBytes);
        const page = WorkerFilesystemSearchResultSchema.parse(reply.value);
        pages += 1;
        if (pages === 1) {
          expect(page.nextCursor).toEqual(expect.any(String));
          expect(page.truncated).toBe(true);
          expect(page.matches.length).toBeLessThan(FILE_COUNT);
        }
        paths.push(...page.matches.map((match) => match.path));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(pages).toBeGreaterThan(2);
      expect(paths).toEqual(expected);
    } finally {
      relay.dispose();
      await runtime.shutdown();
    }
  }, 120_000);

  it.each(['mentions', 'file-explorer'] as const)(
    'keeps the in-process file-index:get projection one unbounded page (%s)',
    async (purpose) => {
      const pages: FilesystemSearchPage[] = [];
      const indexRoot = root('repo', rootPath);
      const adapter = createWorkerFilesystemSearchAdapter({
        engine: createFilesystemSearchEngine(),
        services: searchServices,
        projection: {
          root: () => ({ root: indexRoot, fileIndexing }),
          capture: (page) => pages.push(page),
        },
      });
      const result = await search(
        adapter,
        params({ purpose, limit: WORKER_FILESYSTEM_SEARCH_MAX_LIMIT }),
      );
      expect(result.matches).toHaveLength(FILE_COUNT);
      expect(result.nextCursor).toBeNull();
      expect(pages).toHaveLength(1);

      const runtime = createDesktopRuntime({
        fileSearchServices: searchServices,
      });
      try {
        const index = await runtime.queryFileIndexForLegacyIpc(
          { projectId: 'project-1', worktreeId: 'wt-1', purpose },
          { caller: localCaller({ id: 1 }) },
        );
        const direct = await directWalk(purpose);
        expect(index.repos[0]?.files).toEqual(direct.files);
        expect(index.repos[0]?.truncated).toBe(direct.truncated);
      } finally {
        await runtime.shutdown();
      }
    },
    120_000,
  );
});

describe('file-index:get over worker.filesystem.search', () => {
  it.each(['mentions', 'file-explorer'] as const)(
    'returns the direct walk for paths past the old match bounds (%s)',
    async (purpose) => {
      const rootPath = resolve(tmpdir(), 'long-path-index');
      const tree = longPathTree(rootPath);
      expect(tree.relativePaths[0]?.length).toBeGreaterThan(28_000);
      for (const path of tree.relativePaths)
        expect(path.length).toBeLessThanOrEqual(
          WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH,
        );
      const indexRoot = root('repo', rootPath);
      const fileIndexing = createDefaultFileIndexingPreferences();
      const runtime = createDesktopRuntime({
        fileSearchServices: {
          getFileBrowserRoots: () => Promise.resolve(rootsOf(indexRoot)),
          readFileIndexingPreferences: () => Promise.resolve(fileIndexing),
          listIgnoredPathEntries: () => Promise.resolve([]),
          readBoundaryForRoot: () => tree.readBoundary,
        },
      });
      const index = await runtime.queryFileIndexForLegacyIpc(
        { projectId: 'project-1', worktreeId: 'wt-1', purpose },
        { caller: localCaller({ id: 1 }) },
      );
      // The retained direct walk, which the golden ties to base.
      const direct = await buildFileIndexResult(rootPath, {
        gitAware: false,
        globMatcher:
          purpose === 'file-explorer'
            ? buildFileExplorerGlobMatcher()
            : buildFileGlobMatcher(fileIndexing),
        readBoundary: tree.readBoundary,
      });
      expect(direct.files.map((file) => file.relativePath)).toEqual(
        tree.relativePaths,
      );
      expect(index.repos).toHaveLength(1);
      expect(index.repos[0]?.files).toEqual(direct.files);
      expect(index.repos[0]?.truncated).toBe(direct.truncated);
    },
  );
});

describe('desktop adapter and daemon handler parity', () => {
  let h: RouteHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  type Outcome =
    | {
        ok: Array<
          Omit<WorkerFilesystemSearchResult, 'nextCursor'> & { more: boolean }
        >;
      }
    | { error: { kind: string; code: string | undefined } };

  /** Every page of one search, without cursors and the daemon's revision. */
  async function outcome(
    page: (cursor: string | undefined) => Promise<WorkerFilesystemSearchResult>,
  ): Promise<Outcome> {
    const pages: Array<
      Omit<WorkerFilesystemSearchResult, 'nextCursor'> & { more: boolean }
    > = [];
    let cursor: string | undefined;
    try {
      for (;;) {
        const result = await page(cursor);
        pages.push({
          matches: result.matches,
          truncated: result.truncated,
          more: result.nextCursor !== null,
        });
        if (result.nextCursor === null) return { ok: pages };
        cursor = result.nextCursor;
      }
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) throw error;
      return {
        error: { kind: error.payload.kind, code: error.payload.code },
      };
    }
  }

  it('returns the same pages or typed failure for the same scope and root', async () => {
    h = await createRouteHarness({ flag: false });
    const harness = h;
    // One ignore listing for both hosts: desktop Git and the daemon's port.
    const listing = (): Promise<string[]> =>
      Promise.resolve(['dist/', 'debug.log']);
    const git = fakeGit(undefined, listing);
    const desktop = createWorkerFilesystemSearchAdapter({
      engine: createFilesystemSearchEngine(),
      services: {
        getFileBrowserRoots,
        readFileIndexingPreferences: async () =>
          (await readPreferencesFile()).fileIndexing,
        listIgnoredPathEntries: listing,
        readBoundaryForRoot: () => undefined,
      },
    });
    const daemonEngine = createFilesystemSearchEngine();
    const inputs = directoryInputsFor(harness.dataRoot, git);
    const resolveScope = await createFilesystemScopeResolver({
      canonicalDataRoot: harness.dataRoot,
      authorityId: AUTHORITY,
      targetId: CANOPY_IN_PROCESS_WORKER_TARGET_ID,
      coworkManagedDirName: COWORK_DIR,
      paths: { join, resolve, isAbsolute, sep, basename },
      rootIdentity: readNativeRootIdentity,
    });
    const cases: WorkerFilesystemSearchParams[] = [];
    for (const purpose of ['mentions', 'file-explorer'] as const)
      for (const [workspaceId, worktreeId, fileRootId] of [
        ['single', 'task', 'single'],
        ['single', 'task', 'attachments'],
        ['single', 'task', 'nope'],
        ['multi', 'task', '__workspace_root__'],
        ['multi', 'task', 'api'],
        ['cowork', 'home', 'workspace'],
        ['cowork', 'home', 'notes'],
        ['cowork', 'home', 'prompts'],
      ] as const)
        cases.push({
          scope: { workspaceId, worktreeId },
          fileRootId,
          query: '',
          mode: 'name',
          purpose,
          limit: 2,
        });
    cases.push({ ...params(), scope: { workspaceId: 'single', worktreeId: 'task' }, fileRootId: 'single', query: 'INDEX' }); // prettier-ignore
    cases.push({ ...params(), scope: { workspaceId: 'single', worktreeId: 'task' }, fileRootId: 'single', mode: 'content' }); // prettier-ignore
    const signal = new AbortController().signal;
    const outcomes: Outcome[] = [];
    for (const request of cases) {
      const fromDesktop = await outcome((cursor) =>
        search(desktop, { ...request, ...(cursor && { cursor }) }),
      );
      const fromDaemon = await outcome(async (cursor) =>
        searchFilesystemScope(
          { ...request, ...(cursor && { cursor }) },
          await resolveScope(request.scope, 'search'),
          {
            engine: daemonEngine,
            inputs: () =>
              inputs.searchOptions(signal, request.purpose ?? 'mentions'),
          },
        ),
      );
      expect({ request, result: fromDesktop }).toEqual({
        request,
        result: fromDaemon,
      });
      outcomes.push(fromDesktop);
    }
    // Every case lists files except the empty prompts root (both purposes)
    // and the three typed failures.
    expect(
      outcomes.filter(
        (entry) =>
          'ok' in entry && entry.ok.some((page) => page.matches.length),
      ),
    ).toHaveLength(cases.length - 5);
    expect(outcomes.filter((entry) => 'error' in entry)).toEqual([
      {
        error: { kind: 'not_found', code: 'worker.filesystem.search.notFound' },
      },
      {
        error: { kind: 'not_found', code: 'worker.filesystem.search.notFound' },
      },
      {
        error: {
          kind: 'capability_unavailable',
          code: 'worker.filesystem.search.modeUnavailable',
        },
      },
    ]);
    expect(harness.daemon.queries).toHaveLength(0);
  });
});
