jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  readdir: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/lib/git', () => ({
  getRepoRootFromWorktree: jest.fn(),
}));

import type { ExecFileException, ExecFileOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { getRepoRootFromWorktree } from '@canopy/desktop-shared/lib/git';
import {
  discoverWorkspaceRepos,
  type DiscoveredRepo,
} from '../_lib/repo-discovery';

const mockedExecFile = jest.mocked(execFile);
const mockedReaddir = jest.mocked(readdir);
const mockedGetRepoRootFromWorktree = jest.mocked(getRepoRootFromWorktree);

type ExecFileMockCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileMockArgs = [
  file: string,
  args: readonly string[] | null | undefined,
  options: ExecFileOptions | null | undefined,
  callback: ExecFileMockCallback | null | undefined,
];

function createDirent(name: string): {
  name: string;
  isDirectory: () => boolean;
} {
  return {
    name,
    isDirectory: (): boolean => true,
  };
}

describe('repo-discovery helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetRepoRootFromWorktree.mockResolvedValue('/workspace/root');
  });

  it('discovers the project root repo plus git repos inside repos/', async () => {
    mockedReaddir.mockResolvedValue([
      createDirent('repo-a'),
      createDirent('repo-b'),
    ] as never);

    mockedExecFile.mockImplementation((...args: ExecFileMockArgs) => {
      const options = args[2];
      const callback = args[3];
      const cwd =
        options && typeof options === 'object' && 'cwd' in options
          ? String(options.cwd ?? '')
          : '';
      const cb = callback;
      if (!cb) {
        return {} as never;
      }

      if (
        cwd === '/workspace/root' ||
        cwd === '/workspace/root/repos/repo-a' ||
        cwd === '/workspace/root/repos/repo-b'
      ) {
        cb(null, `${cwd}\n`, '');
        return {} as never;
      }

      cb(new Error('not a git repo'), '', '');
      return {} as never;
    });

    const repos = await discoverWorkspaceRepos('/workspace/root');

    expect(repos).toEqual<DiscoveredRepo[]>([
      {
        repoId: '__workspace_root__',
        repoName: 'Project root',
        repoPath: '/workspace/root',
        relativePath: '.',
      },
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath: '/workspace/root/repos/repo-a',
        relativePath: 'repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'repo-b',
        repoPath: '/workspace/root/repos/repo-b',
        relativePath: 'repos/repo-b',
      },
    ]);
  });

  it('uses the underlying repo name for a single-repo worktree root', async () => {
    mockedReaddir.mockResolvedValue([] as never);
    mockedGetRepoRootFromWorktree.mockResolvedValue('/repos/app');

    mockedExecFile.mockImplementation((...args: ExecFileMockArgs) => {
      const options = args[2];
      const callback = args[3];
      const cwd =
        options && typeof options === 'object' && 'cwd' in options
          ? String(options.cwd ?? '')
          : '';
      if (!callback) {
        return {} as never;
      }

      if (cwd === '/workspace/worktrees/feature-branch') {
        callback(null, `${cwd}\n`, '');
        return {} as never;
      }

      callback(new Error('not a git repo'), '', '');
      return {} as never;
    });

    const repos = await discoverWorkspaceRepos(
      '/workspace/worktrees/feature-branch',
    );

    expect(repos).toEqual<DiscoveredRepo[]>([
      {
        repoId: 'app',
        repoName: 'app',
        repoPath: '/workspace/worktrees/feature-branch',
        relativePath: '.',
      },
    ]);
  });
});
