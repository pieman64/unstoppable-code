import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasGitPathSegment,
  readFilesystemDirectory,
  type DirectoryReadOptions,
} from '../directory-reader';
import { createFilesystemRoot, type FilesystemRoot } from '../root-catalog';

let temporary = '';
let rootPath = '';
const options: DirectoryReadOptions = {
  matchingRules: { isIndexExcluded: (path) => path === 'alpha.txt' },
};
const root = (gitAware = false): FilesystemRoot =>
  createFilesystemRoot({
    id: 'test',
    name: 'Test',
    kind: 'git-repo',
    absolutePath: rootPath,
    gitAware,
  });
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'can-4070-read-'));
  rootPath = join(temporary, 'root');
  await mkdir(rootPath);
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

it('returns directory-first Unicode metadata while keeping ignored and index-excluded entries visible', async () => {
  await mkdir(join(rootPath, 'z-dir'));
  await mkdir(join(rootPath, '.git'));
  await writeFile(join(rootPath, 'éclair.txt'), '');
  await writeFile(join(rootPath, 'alpha.txt'), '');
  await symlink(join(rootPath, 'z-dir'), join(rootPath, 'a-link'));
  const checkIgnoredPaths = jest.fn(() =>
    Promise.resolve(new Set(['éclair.txt'])),
  );
  const entries = await readFilesystemDirectory(root(true), '', {
    ...options,
    gitIgnore: { checkIgnoredPaths },
  });
  expect(
    entries.map(({ absolutePath, ...entry }) => ({
      ...entry,
      localPath: absolutePath === join(rootPath, entry.name),
    })),
  ).toEqual([
    {
      name: 'a-link',
      relativePath: 'a-link',
      kind: 'directory',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: true,
      hasChildren: false,
      localPath: true,
    },
    {
      name: 'z-dir',
      relativePath: 'z-dir',
      kind: 'directory',
      isIgnored: false,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: true,
      localPath: true,
    },
    {
      name: 'alpha.txt',
      relativePath: 'alpha.txt',
      kind: 'file',
      isIgnored: false,
      isIndexExcluded: true,
      isSymlink: false,
      hasChildren: false,
      localPath: true,
    },
    {
      name: 'éclair.txt',
      relativePath: 'éclair.txt',
      kind: 'file',
      isIgnored: true,
      isIndexExcluded: false,
      isSymlink: false,
      hasChildren: false,
      localPath: true,
    },
  ]);
  expect(checkIgnoredPaths).toHaveBeenCalledWith(
    rootPath,
    expect.arrayContaining(['alpha.txt', 'éclair.txt', 'a-link', 'z-dir']),
  );
});

it('reads nested canonical paths and skips exact managed descendants', async () => {
  await mkdir(join(rootPath, 'managed', 'notes'), { recursive: true });
  await writeFile(join(rootPath, 'managed', 'visible.txt'), '');
  const catalogRoot = {
    ...root(),
    excludedDescendantRoots: [join(rootPath, 'managed', 'notes')],
  };
  expect(
    (await readFilesystemDirectory(catalogRoot, 'managed', options)).map(
      (entry) => entry.relativePath,
    ),
  ).toEqual(['managed/visible.txt']);
  expect(
    await readFilesystemDirectory(catalogRoot, 'missing', options),
  ).toEqual([]);
  expect(
    await readFilesystemDirectory(catalogRoot, 'managed/notes', options),
  ).toEqual([]);
});

it('preserves literal backslashes in POSIX names', async () => {
  await writeFile(join(rootPath, '\\file.txt'), '');
  expect(
    (await readFilesystemDirectory(root(), '', options))[0]?.relativePath,
  ).toBe('\\file.txt');
});

it('contains symlink targets, filters dangling and .git links, and retains safe file links', async () => {
  const outside = join(temporary, 'root-sibling');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), '');
  await writeFile(join(rootPath, 'safe.txt'), '');
  await mkdir(join(rootPath, '.git'));
  await symlink(outside, join(rootPath, 'escape'));
  await symlink(join(rootPath, 'absent'), join(rootPath, 'dangling'));
  await symlink(join(rootPath, '.git'), join(rootPath, 'git-link'));
  await symlink(join(rootPath, 'safe.txt'), join(rootPath, 'safe-link'));
  expect(
    (await readFilesystemDirectory(root(), '', options)).map((entry) => [
      entry.name,
      entry.isSymlink,
      entry.hasChildren,
    ]),
  ).toEqual([
    ['safe-link', true, false],
    ['safe.txt', false, false],
  ]);
  await expect(
    readFilesystemDirectory(root(), 'escape', options),
  ).rejects.toThrow('outside the file tree root');
  await expect(
    readFilesystemDirectory(root(), '../root-sibling', options),
  ).rejects.toThrow('outside the file tree root');
});

it('leaves entries unmarked on git failure and does not call git for standalone or empty trees', async () => {
  const checkIgnoredPaths = jest.fn(() =>
    Promise.reject(new Error('Git unavailable')),
  );
  const configured = { ...options, gitIgnore: { checkIgnoredPaths } };
  expect(await readFilesystemDirectory(root(true), '', configured)).toEqual([]);
  expect(checkIgnoredPaths).not.toHaveBeenCalled();
  await writeFile(join(rootPath, 'alpha.txt'), '');
  expect(
    (await readFilesystemDirectory(root(), '', configured))[0]?.isIgnored,
  ).toBe(false);
  expect(checkIgnoredPaths).not.toHaveBeenCalled();
  expect(
    (await readFilesystemDirectory(root(true), '', configured))[0]?.isIgnored,
  ).toBe(false);
  expect(checkIgnoredPaths).toHaveBeenCalledTimes(1);
});

it('uses sealed no-follow reads and propagates boundary failures', async () => {
  await writeFile(join(rootPath, 'safe.txt'), '');
  await symlink(join(rootPath, 'safe.txt'), join(rootPath, 'safe-link'));
  const readBoundary = {
    assertDirectory: jest.fn(() => Promise.resolve()),
    readDirectory: jest.fn(async (_root: string, target: string) =>
      readdir(target, { withFileTypes: true }),
    ),
    lstatEntry: jest.fn(async (_root: string, target: string) => lstat(target)),
  };
  expect(
    (
      await readFilesystemDirectory(root(), '', { ...options, readBoundary })
    ).map((entry) => entry.name),
  ).toEqual(['safe.txt']);
  expect(readBoundary.assertDirectory).toHaveBeenCalledWith(rootPath, rootPath);
  readBoundary.assertDirectory.mockRejectedValueOnce(
    new Error('sealed path rejected'),
  );
  await expect(
    readFilesystemDirectory(root(), '', { ...options, readBoundary }),
  ).rejects.toThrow('sealed path rejected');
});

it.each<[string, boolean]>([
  ['C:\\repo\\.git\\config', true],
  ['/repo/.git/config', true],
  ['a/.github/file', false],
  ['.GIT/config', false],
  ['a\\b.txt', false],
])('recognizes Git path segments deterministically: %s', (value, expected) => {
  expect(hasGitPathSegment(value)).toBe(expected);
});
