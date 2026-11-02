jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  listFileRoots,
  readPortalFilePreview,
  resolvePortalFileLink,
  resolvePortalChatAssetFileTarget,
} from '../files-service';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);

describe('Portal files service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const root = {
      repoId: 'repo-1',
      repoName: 'Repo One',
      absolutePath: '/repo',
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [],
    };
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [root],
      rootMap: new Map([[root.repoId, root]]),
    });
  });

  it.each([
    ['workspace', 'standalone'],
    ['notes', 'standalone'],
    ['prompts', 'standalone'],
    ['attachments', 'attachments'],
    ['workspace', 'git-repo'],
    ['__workspace_root__', 'workspace-root'],
    ['unknown', 'standalone'],
  ] as const)(
    'projects Portal root %s with kind %s independently of its display label',
    async (repoId, rootKind) => {
      const root = {
        repoId,
        repoName: 'Same title / 支出',
        absolutePath: '/repo',
        rootKind,
        gitAware: rootKind === 'git-repo',
        excludedDescendantRoots: [],
      };
      mockedGetFileBrowserRoots.mockResolvedValue({
        roots: [root],
        rootMap: new Map([[repoId, root]]),
      });
      expect(
        await listFileRoots({ projectId: 'project', worktreeId: 'task' }),
      ).toEqual([
        {
          workspaceLocalId: 'project',
          worktreeLocalId: 'task',
          fileRootLocalId: repoId,
          label: root.repoName,
          absolutePath: '/repo',
          rootKind,
        },
      ]);
    },
  );

  it('uses the explicit authorized descendant instead of an excluded parent for canonical assets', async () => {
    const parent = {
      repoId: 'workspace',
      repoName: 'Workspace',
      absolutePath: '/workspace',
      rootKind: 'git-repo' as const,
      gitAware: true,
      excludedDescendantRoots: [
        '/workspace/repos/repo',
        '/workspace/.attachments',
      ],
    };
    const repo = {
      ...parent,
      repoId: 'repo',
      absolutePath: '/workspace/repos/repo',
      excludedDescendantRoots: [],
    };
    const attachments = {
      ...parent,
      repoId: 'attachments',
      absolutePath: '/workspace/.attachments',
      excludedDescendantRoots: [],
    };
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [parent, repo, attachments],
      rootMap: new Map(),
    });
    expect(
      await resolvePortalChatAssetFileTarget({
        projectId: 'workspace',
        worktreeId: 'worktree',
        path: '/workspace/repos/repo/chart.png',
      }),
    ).toEqual(repo);
    expect(
      await resolvePortalChatAssetFileTarget({
        projectId: 'workspace',
        worktreeId: 'worktree',
        path: '/workspace/.attachments/file.pdf',
      }),
    ).toEqual(attachments);
    expect(
      await resolvePortalChatAssetFileTarget({
        projectId: 'workspace',
        worktreeId: 'worktree',
        path: '/elsewhere/file.pdf',
      }),
    ).toBeNull();
    mockedGetFileBrowserRoots.mockResolvedValue({
      roots: [parent],
      rootMap: new Map(),
    });
    expect(
      await resolvePortalChatAssetFileTarget({
        projectId: 'workspace',
        worktreeId: 'worktree',
        path: '/workspace/repos/repo/chart.png',
      }),
    ).toBeNull();
  });

  it('rejects Windows absolute file paths instead of treating them as repo-relative', async () => {
    await expect(
      readPortalFilePreview({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'C:\\Users\\test\\repo\\README.md',
      }),
    ).rejects.toThrow('Path must be relative.');
  });

  describe('resolvePortalFileLink', () => {
    let directory = '';

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'portal-file-link-'));
      const first = join(directory, 'first');
      const second = join(directory, 'second');
      await Promise.all([
        mkdir(join(first, 'src'), { recursive: true }),
        mkdir(join(second, 'src'), { recursive: true }),
      ]);
      await writeFile(join(first, 'src', 'only.ts'), 'first');
      await writeFile(join(first, 'src', 'shared.ts'), 'first');
      await writeFile(join(second, 'src', 'shared.ts'), 'second');
      const roots = [
        {
          repoId: 'repo-1',
          repoName: 'First',
          absolutePath: first,
          rootKind: 'git-repo' as const,
          gitAware: true,
          excludedDescendantRoots: [],
        },
        {
          repoId: 'repo-2',
          repoName: 'Second',
          absolutePath: second,
          rootKind: 'git-repo' as const,
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ];
      mockedGetFileBrowserRoots.mockResolvedValue({
        roots,
        rootMap: new Map(roots.map((root) => [root.repoId, root])),
      });
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it.each([
      ['src/only.ts#L12', 'repo-1', 'src/only.ts'],
      ['./src/only.ts?raw=1', 'repo-1', 'src/only.ts'],
    ])('resolves the relative link %s uniquely', async (href, rootId, path) => {
      await expect(
        resolvePortalFileLink({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          href,
        }),
      ).resolves.toEqual({ fileRootLocalId: rootId, relativePath: path });
    });

    it('resolves absolute paths and local file URLs inside a root', async () => {
      const absolutePath = join(directory, 'first', 'src', 'only.ts');
      for (const href of [
        absolutePath,
        `${pathToFileURL(absolutePath).href}#L2`,
      ]) {
        await expect(
          resolvePortalFileLink({
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            href,
          }),
        ).resolves.toEqual({
          fileRootLocalId: 'repo-1',
          relativePath: 'src/only.ts',
        });
      }
    });

    it('leaves an absolute file unresolved when overlapping roots contain it', async () => {
      const first = join(directory, 'first');
      const nested = join(first, 'src');
      const roots = [
        {
          repoId: 'repo-1',
          repoName: 'First',
          absolutePath: first,
          rootKind: 'git-repo' as const,
          gitAware: true,
          excludedDescendantRoots: [],
        },
        {
          repoId: 'repo-nested',
          repoName: 'Nested',
          absolutePath: nested,
          rootKind: 'git-repo' as const,
          gitAware: true,
          excludedDescendantRoots: [],
        },
      ];
      mockedGetFileBrowserRoots.mockResolvedValue({
        roots,
        rootMap: new Map(roots.map((root) => [root.repoId, root])),
      });

      await expect(
        resolvePortalFileLink({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          href: join(nested, 'only.ts'),
        }),
      ).resolves.toBeNull();
    });

    it('leaves absolute paths and file URLs outside every root unresolved', async () => {
      const outsidePath = join(directory, 'outside.ts');
      await writeFile(outsidePath, 'outside');

      for (const href of [outsidePath, pathToFileURL(outsidePath).href]) {
        await expect(
          resolvePortalFileLink({
            projectId: 'workspace-1',
            worktreeId: 'worktree-1',
            href,
          }),
        ).resolves.toBeNull();
      }
    });

    it.each([
      ['missing file', 'src/missing.ts'],
      ['ambiguous relative file', 'src/shared.ts'],
      ['directory', 'src'],
      ['outside traversal', '../outside.ts'],
      ['remote URL', 'https://example.com/src/only.ts'],
    ])('leaves a %s unresolved', async (_label, href) => {
      await expect(
        resolvePortalFileLink({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
          href,
        }),
      ).resolves.toBeNull();
    });
  });
});
