import type { Dirent } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
  WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH,
  WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
  WorkerFilesystemSearchResultSchema,
  type WorkerFilesystemSearchParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import type { FileSystemReadBoundary } from '../directory-reader';
import {
  buildFileExplorerGlobMatcher,
  buildFileGlobMatcher,
  createFileIndexWalk,
  createFilesystemSearchEngine,
  readIgnoredPathMatcher,
  walkFileIndex,
  type FileIndexMatcher,
  type FilesystemSearchHost,
  type FilesystemSearchInputs,
  type FilesystemSearchRoot,
} from '../../index';

const POLICY = { caseSensitive: true };
const MENTIONS = buildFileGlobMatcher(
  { disabledBuiltinGlobIds: [], customGlobs: [] },
  POLICY,
);
const EXPLORER = buildFileExplorerGlobMatcher(POLICY);

let base = '';
let rootPath = '';

async function put(relativePath: string, content = ''): Promise<void> {
  const target = join(rootPath, ...relativePath.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'file-search-'));
  rootPath = join(base, 'root');
  await mkdir(rootPath);
  await put('b.txt');
  await put('A.md');
  await put('src/index.ts');
  await put('src/lib/util.ts');
  await put('node_modules/pkg/a.js');
  await put('node_modules/pkg/b.js');
  await put('target/out.bin');
  await put('.git/HEAD');
  await mkdir(join(rootPath, 'empty'));
  await put('../outside.txt');
  await symlink(join(rootPath, 'src'), join(rootPath, 'src-link'));
  await symlink(join(rootPath, 'b.txt'), join(rootPath, 'b-link.txt'));
  await symlink(join(base, 'outside.txt'), join(rootPath, 'escape.txt'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const ROOT = (): FilesystemSearchRoot => ({
  id: 'repo',
  absolutePath: rootPath,
  gitAware: true,
  excludedDescendantRoots: [],
});

const EXPLORER_ORDER = [
  'src/lib/util.ts',
  'src/index.ts',
  'A.md',
  'b-link.txt',
  'b.txt',
  'node_modules/pkg/a.js',
  'node_modules/pkg/b.js',
  'target/out.bin',
];

async function pagedPaths(
  matcher: FileIndexMatcher,
  limit: number,
): Promise<{ pages: string[][]; exhausted: boolean[] }> {
  const walk = createFileIndexWalk(ROOT(), { matcher });
  const pages: string[][] = [];
  const exhausted: boolean[] = [];
  for (;;) {
    const page = await walk.next(limit);
    pages.push(page.files.map((file) => file.relativePath));
    exhausted.push(page.exhausted);
    if (page.exhausted) return { pages, exhausted };
  }
}

describe('createFileIndexWalk', () => {
  it('walks directories first, defers dependency trees and skips links out', async () => {
    const { files, truncated } = await walkFileIndex(ROOT(), {
      matcher: EXPLORER,
    });
    expect(files.map((file) => file.relativePath)).toEqual(EXPLORER_ORDER);
    expect(truncated).toBe(false);
    expect(files.find((file) => file.relativePath === 'b-link.txt')).toEqual({
      relativePath: 'b-link.txt',
      filename: 'b-link.txt',
      absolutePath: join(rootPath, 'b-link.txt'),
    });
    const mentions = await walkFileIndex(ROOT(), { matcher: MENTIONS });
    expect(mentions.files.map((file) => file.relativePath)).toEqual([
      'src/lib/util.ts',
      'src/index.ts',
      'A.md',
      'b-link.txt',
      'b.txt',
    ]);
  });

  it.each([1, 2, 3, 5, 7, 8, 9])(
    'concatenates pages of %i into the uninterrupted walk',
    async (limit) => {
      const { pages, exhausted } = await pagedPaths(EXPLORER, limit);
      expect(pages.flat()).toEqual(EXPLORER_ORDER);
      expect(pages.slice(0, -1).every((page) => page.length === limit)).toBe(
        true,
      );
      expect(exhausted.filter(Boolean)).toHaveLength(1);
    },
  );

  it('reports a remainder for any unvisited entry, even one with no file', async () => {
    // Eight files, then the pending deferred directories.
    const capped = await walkFileIndex(ROOT(), { matcher: EXPLORER }, 5);
    expect(capped.truncated).toBe(true);
    // At exactly the last file nothing is left.
    const exact = await walkFileIndex(ROOT(), { matcher: EXPLORER }, 8);
    expect(exact.files).toHaveLength(8);
    expect(exact.truncated).toBe(false);
    // An unvisited deferred directory is a remainder even when it is empty,
    // so a full page can be followed by an empty last page.
    const tail = join(base, 'tail');
    await mkdir(join(tail, 'node_modules'), { recursive: true });
    await writeFile(join(tail, 'a.txt'), '');
    const walk = createFileIndexWalk(
      { absolutePath: tail, excludedDescendantRoots: [] },
      { matcher: EXPLORER },
    );
    const first = await walk.next(1);
    expect(first.files.map((file) => file.relativePath)).toEqual(['a.txt']);
    expect(first.exhausted).toBe(false);
    await expect(walk.next(1)).resolves.toEqual({
      files: [],
      exhausted: true,
    });
  });

  it('starts the next page at a file that does not fit', async () => {
    const walk = createFileIndexWalk(ROOT(), { matcher: MENTIONS });
    let room = 2;
    const fits = (): boolean => (room -= 1) >= 0;
    const first = await walk.next(10, { fits });
    expect(first.files.map((file) => file.relativePath)).toEqual([
      'src/lib/util.ts',
      'src/index.ts',
    ]);
    expect(first.exhausted).toBe(false);
    const second = await walk.next(10);
    expect(second.files[0]?.relativePath).toBe('A.md');
    // A file always fits an empty page, so a page never stalls.
    const stalled = createFileIndexWalk(ROOT(), { matcher: MENTIONS });
    const page = await stalled.next(10, { fits: () => false });
    expect(page.files).toHaveLength(1);
  });

  it('stops before the next directory once aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(
      createFileIndexWalk(ROOT(), { matcher: MENTIONS }).next(10, {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe('readIgnoredPathMatcher', () => {
  it('marks listed paths and files under listed directories', async () => {
    const isIgnored = await readIgnoredPathMatcher(() =>
      Promise.resolve(['dist/', 'a/b/', 'debug.log']),
    );
    expect(isIgnored('dist/out.js')).toBe(true);
    expect(isIgnored('a/b/c/d.ts')).toBe(true);
    expect(isIgnored('a/bc.ts')).toBe(false);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('src/debug.log')).toBe(false);
  });

  it('marks nothing without a listing or when it fails', async () => {
    expect((await readIgnoredPathMatcher(null))('x')).toBe(false);
    const failed = await readIgnoredPathMatcher(() =>
      Promise.reject(new Error('git failed')),
    );
    expect(failed('dist/out.js')).toBe(false);
  });
});

describe('createFilesystemSearchEngine', () => {
  const params = (
    overrides: Partial<WorkerFilesystemSearchParams> = {},
  ): WorkerFilesystemSearchParams => ({
    scope: { workspaceId: 'w', worktreeId: 't' },
    fileRootId: 'repo',
    query: '',
    mode: 'name',
    ...overrides,
  });

  function host(
    overrides: Partial<FilesystemSearchInputs> = {},
    extra: Partial<Omit<FilesystemSearchHost, 'resolve'>> = {},
  ): FilesystemSearchHost & { resolves: number; listings: string[] } {
    const record = { resolves: 0, listings: [] as string[] };
    return Object.assign(record, {
      resolve: () => {
        record.resolves += 1;
        return Promise.resolve({
          root: ROOT(),
          inputs: {
            matcher: EXPLORER,
            policy: POLICY,
            listIgnoredPathEntries: (root: string) => {
              record.listings.push(root);
              return Promise.resolve(['node_modules/', 'b.txt']);
            },
            ...overrides,
          },
        });
      },
      ...extra,
    });
  }

  it('pages one walk with single-use cursors and one ignored listing', async () => {
    const engine = createFilesystemSearchEngine();
    const source = host();
    const paths: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { result, files } = await engine.search(
        params({
          purpose: 'file-explorer',
          limit: 3,
          ...(cursor && { cursor }),
        }),
        source,
      );
      expect(files.map((file) => file.relativePath)).toEqual(
        result.matches.map((match) => match.path),
      );
      for (const match of result.matches) {
        expect(Object.keys(match).sort()).toEqual([
          'fileRootId',
          'isIgnored',
          'kind',
          'name',
          'path',
        ]);
        expect(match.isIgnored).toBe(
          match.path === 'b.txt' || match.path.startsWith('node_modules/'),
        );
      }
      paths.push(...result.matches.map((match) => match.path));
      expect(result.truncated).toBe(result.nextCursor !== null);
      if (result.nextCursor === null) break;
      const used = cursor;
      cursor = result.nextCursor;
      if (used)
        await expect(
          engine.search(
            params({ purpose: 'file-explorer', cursor: used }),
            source,
          ),
        ).rejects.toMatchObject({
          payload: { code: 'worker.filesystem.search.cursorExpired' },
        });
    }
    expect(paths).toEqual(EXPLORER_ORDER);
    expect(source.resolves).toBe(1);
    expect(source.listings).toEqual([rootPath]);
  });

  it('refuses content and symbol modes before resolving a root', async () => {
    const engine = createFilesystemSearchEngine();
    const source = host();
    for (const mode of ['content', 'symbol'] as const)
      await expect(
        engine.search(params({ mode }), source),
      ).rejects.toMatchObject({
        payload: {
          kind: 'capability_unavailable',
          code: 'worker.filesystem.search.modeUnavailable',
        },
      });
    expect(source.resolves).toBe(0);
  });

  it('filters by a case-insensitive path query and include/exclude globs', async () => {
    const engine = createFilesystemSearchEngine();
    const search = async (
      overrides: Partial<WorkerFilesystemSearchParams>,
    ): Promise<string[]> =>
      (
        await engine.search(
          params({ purpose: 'file-explorer', ...overrides }),
          host(),
        )
      ).result.matches.map((match) => match.path);
    await expect(search({ query: 'SRC/' })).resolves.toEqual([
      'src/lib/util.ts',
      'src/index.ts',
    ]);
    await expect(search({ include: ['**/*.js'] })).resolves.toEqual([
      'node_modules/pkg/a.js',
      'node_modules/pkg/b.js',
    ]);
    await expect(
      search({ include: ['src/**', '*.md'], exclude: ['**/lib/**'] }),
    ).resolves.toEqual(['src/index.ts', 'A.md']);
    // The limit counts matches, not walked files.
    const limited = await engine.search(
      params({ purpose: 'file-explorer', query: '.js', limit: 1 }),
      host(),
    );
    expect(limited.result.matches.map((match) => match.path)).toEqual([
      'node_modules/pkg/a.js',
    ]);
    expect(limited.result.truncated).toBe(true);
  });

  it('binds a cursor to its search and its catalog revision', async () => {
    const engine = createFilesystemSearchEngine();
    const first = await engine.search(
      params({ limit: 1 }),
      host({}, { revision: 'r1' }),
    );
    const cursor = first.result.nextCursor;
    if (!cursor) throw new Error('Expected a cursor.');
    await expect(
      engine.search(
        params({ limit: 1, cursor, query: 'x' }),
        host({}, { revision: 'r1' }),
      ),
    ).rejects.toMatchObject({
      payload: {
        kind: 'invalid_argument',
        code: 'worker.filesystem.search.cursorMismatch',
      },
    });
    // A mismatched request leaves the cursor usable; a new revision does not.
    await expect(
      engine.search(params({ limit: 1, cursor }), host({}, { revision: 'r2' })),
    ).rejects.toMatchObject({
      payload: {
        kind: 'conflict',
        code: 'worker.filesystem.search.revisionConflict',
      },
    });
    await expect(
      engine.search(params({ limit: 1, cursor }), host({}, { revision: 'r1' })),
    ).rejects.toMatchObject({
      payload: { code: 'worker.filesystem.search.cursorExpired' },
    });
  });

  it('expires idle cursors, evicts the least recently used and honors release', async () => {
    let now = 0;
    const engine = createFilesystemSearchEngine({
      maxOpenWalks: 2,
      cursorIdleMs: 100,
      now: () => now,
    });
    const open = async (): Promise<string> => {
      const { result } = await engine.search(params({ limit: 1 }), host());
      if (!result.nextCursor) throw new Error('Expected a cursor.');
      return result.nextCursor;
    };
    const expiredError = {
      payload: {
        kind: 'not_found',
        code: 'worker.filesystem.search.cursorExpired',
      },
    };
    const idle = await open();
    now = 101;
    await expect(
      engine.search(params({ limit: 1, cursor: idle }), host()),
    ).rejects.toMatchObject(expiredError);
    const oldest = await open();
    const kept = await open();
    const newest = await open();
    await expect(
      engine.search(params({ limit: 1, cursor: oldest }), host()),
    ).rejects.toMatchObject(expiredError);
    await expect(
      engine.search(params({ limit: 1, cursor: kept }), host()),
    ).resolves.toBeDefined();
    engine.release(newest);
    await expect(
      engine.search(params({ limit: 1, cursor: newest }), host()),
    ).rejects.toMatchObject(expiredError);
  });

  it('ends a page within a framed byte budget and continues it', async () => {
    const engine = createFilesystemSearchEngine();
    // Room for the envelope and about two short matches.
    const budget = 4 * 1024 + 2 * 140;
    const paths: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const { result } = await engine.search(
        params({ purpose: 'file-explorer', ...(cursor && { cursor }) }),
        host({}, { maxResultBytes: budget }),
      );
      pages += 1;
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(budget);
      paths.push(...result.matches.map((match) => match.path));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(paths).toEqual(EXPLORER_ORDER);
    expect(pages).toBeGreaterThan(2);
  });

  it('pages paths past the old 4,096/1,024 bounds within the daemon budget', async () => {
    // Synthetic nested tree: no host filesystem allows these lengths.
    const levels = 19;
    const segment = '\u0001'.repeat(1_600);
    const fileCount = 60;
    const fileName = (index: number): string =>
      `${'\u0001'.repeat(2_000)}${String(index).padStart(2, '0')}.ts`;
    const syntheticRoot = join(base, 'synthetic');
    const children = new Map<string, Dirent[]>();
    const kinds = new Map<string, 'file' | 'directory'>();
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
    let directory = syntheticRoot;
    kinds.set(directory, 'directory');
    for (let level = 0; level < levels; level += 1) {
      const child = join(directory, segment);
      children.set(directory, [dirent(directory, segment, 'directory')]);
      kinds.set(child, 'directory');
      directory = child;
    }
    const leaf = directory;
    children.set(
      leaf,
      Array.from({ length: fileCount }, (_, index) => {
        kinds.set(join(leaf, fileName(index)), 'file');
        return dirent(leaf, fileName(index), 'file');
      }),
    );
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
    const readBoundary: FileSystemReadBoundary = {
      assertDirectory: (_root, target) =>
        stats(target).isDirectory()
          ? Promise.resolve()
          : Promise.reject(new Error('not a directory')),
      readDirectory: (_root, target) =>
        Promise.resolve(children.get(target) ?? []),
      lstatEntry: (_root, target) => Promise.resolve(stats(target)),
    };
    const prefix = `${Array.from({ length: levels }, () => segment).join('/')}/`;
    const expected = Array.from(
      { length: fileCount },
      (_, index) => `${prefix}${fileName(index)}`,
    );
    expect(expected[0]?.length).toBeGreaterThan(30_000);
    expect(expected[0]?.length).toBeLessThanOrEqual(
      WORKER_FILESYSTEM_SEARCH_MAX_PATH_LENGTH,
    );

    const engine = createFilesystemSearchEngine();
    const resolveSynthetic: FilesystemSearchHost['resolve'] = () =>
      Promise.resolve({
        root: {
          id: 'repo',
          absolutePath: syntheticRoot,
          gitAware: false,
          excludedDescendantRoots: [],
        },
        inputs: { matcher: EXPLORER, policy: POLICY, readBoundary },
      });
    const paths: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { result } = await engine.search(
        params({
          purpose: 'file-explorer',
          limit: WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
          ...(cursor && { cursor }),
        }),
        {
          resolve: resolveSynthetic,
          maxResultBytes: WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
        },
      );
      expect(WorkerFilesystemSearchResultSchema.safeParse(result).success).toBe(
        true,
      );
      expect(result.matches.length).toBeGreaterThan(0);
      sizes.push(Buffer.byteLength(JSON.stringify(result), 'utf8'));
      paths.push(...result.matches.map((match) => match.path));
      for (const match of result.matches)
        expect(match.name).toBe(match.path.slice(prefix.length));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(paths).toEqual(expected);
    // 60 escaped matches of about 200 KB exceed 7.5 MiB: the budget splits the walk.
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    for (const size of sizes)
      expect(size).toBeLessThanOrEqual(
        WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
      );
    // In process there is no budget: one page, as `file-index:get` reads it.
    const whole = await engine.search(
      params({
        purpose: 'file-explorer',
        limit: WORKER_FILESYSTEM_SEARCH_MAX_LIMIT,
      }),
      { resolve: resolveSynthetic },
    );
    expect(whole.result.matches.map((match) => match.path)).toEqual(expected);
    expect(whole.result.nextCursor).toBeNull();
    expect(
      WorkerFilesystemSearchResultSchema.safeParse(whole.result).success,
    ).toBe(true);
  });

  it('marks nothing for a root that is not Git-aware', async () => {
    const engine = createFilesystemSearchEngine();
    const listings: string[] = [];
    const page = await engine.search(params(), {
      resolve: () =>
        Promise.resolve({
          root: { ...ROOT(), gitAware: false },
          inputs: {
            matcher: MENTIONS,
            policy: POLICY,
            listIgnoredPathEntries: (root) => {
              listings.push(root);
              return Promise.resolve(['b.txt']);
            },
          },
        }),
    });
    expect(page.result.matches.some((match) => match.isIgnored)).toBe(false);
    expect(listings).toEqual([]);
  });

  it('keeps a typed failure from resolving the root', async () => {
    const engine = createFilesystemSearchEngine();
    const failure = new CanopyOperationError({
      kind: 'not_found',
      code: 'worker.filesystem.search.notFound',
      message: 'missing',
      retry: { kind: 'never' },
    });
    await expect(
      engine.search(params(), { resolve: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
  });
});
