import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoFileIndex } from '@canopy/desktop-shared/types';
import { listDirectory } from '../../lib/file-system-listing';
import { buildFileGlobMatcher } from '../../lib/file-glob-matcher';
import { listFileTreeDirectory } from '../../services/files-service';
import { selectPortalFileReference } from '../portal-file-reference-selection';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';

jest.mock('../../lib/git', () => ({
  checkIgnoredPaths: jest.fn(() => Promise.resolve(new Set<string>())),
}));
jest.mock('../../services/files-service', () => ({
  listFileTreeDirectory: jest.fn(),
}));

describe('canonical Portal file selectors', () => {
  let temporary = '';
  let root = '';
  let outside = '';
  let repo: RepoFileIndex;
  const scope = {
    sessionId: 'session',
    projectId: 'workspace',
    worktreeId: 'worktree',
    canRead: (): boolean => true,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    setDesktopCanopyRuntime(
      createDesktopRuntime({
        services: {
          listFileTreeRoots: () => Promise.resolve({ roots: [] }),
          listFileTreeDirectory,
        },
      }),
    );
    temporary = await mkdtemp(join(tmpdir(), 'portal-selectors-'));
    root = join(temporary, 'root');
    outside = join(temporary, 'outside');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'empty'));
    await mkdir(join(root, 'excluded'));
    await mkdir(outside);
    await writeFile(join(root, 'src', 'file.ts'), 'public');
    await writeFile(join(outside, 'secret.txt'), 'private');
    repo = {
      repoId: 'repo',
      repoName: 'Repository',
      absolutePath: root,
      rootKind: 'git-repo',
      files: [],
    };
    jest.mocked(listFileTreeDirectory).mockImplementation(async (request) => ({
      entries: await listDirectory(root, request.relativeDir, {
        gitAware: false,
        globMatcher: buildFileGlobMatcher({
          disabledBuiltinGlobIds: [],
          customGlobs: [
            { id: 'excluded', pattern: 'excluded/**', enabled: true },
          ],
        }),
        excludedDescendantRoots: [join(root, 'hidden')],
      }),
    }));
  });
  afterEach(async () => {
    setDesktopCanopyRuntime(null);
    await rm(temporary, { recursive: true, force: true });
  });

  it.each(['', 'empty', 'src'])(
    'selects actual root/empty/nonempty directories: %j',
    async (relativePath) => {
      const result = await selectPortalFileReference({
        scope,
        repo,
        relativePath,
        kind: 'directory',
      });
      expect(result).toEqual({
        repoId: 'repo',
        repoName: 'Repository',
        relativePath,
        filename: relativePath || 'Repository',
        absolutePath: join(root, relativePath),
        kind: 'directory',
      });
      expect((await lstat(result.absolutePath)).isDirectory()).toBe(true);
    },
  );

  it('selects a canonical regular file and rejects a mismatched selector kind', async () => {
    await expect(
      selectPortalFileReference({
        scope,
        repo,
        relativePath: 'src/file.ts',
        kind: 'file',
      }),
    ).resolves.toMatchObject({
      absolutePath: join(root, 'src/file.ts'),
      kind: 'file',
    });
    await expect(
      selectPortalFileReference({
        scope,
        repo,
        relativePath: 'src/file.ts',
        kind: 'directory',
      }),
    ).rejects.toThrow('catalog');
    await expect(
      selectPortalFileReference({
        scope,
        repo,
        relativePath: 'src',
        kind: 'file',
      }),
    ).rejects.toThrow('catalog');
  });

  it.each([
    '../outside',
    '/outside',
    'src/../file.ts',
    './src',
    'src//file.ts',
    'src\\file.ts',
    'C:outside',
    '//server/share',
    'src\0file.ts',
    'src/',
  ])(
    'rejects noncanonical selector paths before listing: %j',
    async (relativePath) => {
      await expect(
        selectPortalFileReference({
          scope,
          repo,
          relativePath,
          kind: 'directory',
        }),
      ).rejects.toThrow('relative');
      expect(listFileTreeDirectory).not.toHaveBeenCalled();
    },
  );

  it('rejects a file root, absent directories, symlink escapes, and excluded descendants', async () => {
    await mkdir(join(root, 'hidden'));
    await symlink(outside, join(root, 'linked'));
    await expect(
      selectPortalFileReference({
        scope,
        repo,
        relativePath: '',
        kind: 'file',
      }),
    ).rejects.toThrow('relative');
    for (const relativePath of ['absent', 'linked', 'excluded', 'hidden']) {
      await expect(
        selectPortalFileReference({
          scope,
          repo,
          relativePath,
          kind: 'directory',
        }),
      ).rejects.toThrow('catalog');
    }
    await symlink(join(root, 'src'), join(root, 'internal-link'));
    await expect(
      selectPortalFileReference({
        scope,
        repo,
        relativePath: 'internal-link',
        kind: 'directory',
      }),
    ).rejects.toThrow('catalog');
  });
});
