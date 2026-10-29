jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  WorkspaceConfigFile,
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktree,
} from '../lib/workspace-persistence';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import {
  retryWorktreeHealthCheck,
  validateWorktreeHealth,
} from '../lib/worktree-health';
import { recordWorktreeHealth } from '../lib/worktree-repair';

const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);

let tempRoot: string | null = null;
let currentWorktree: WorktreeData | null = null;

function singleRepoConfig(): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repos: [],
  };
}

async function createTempRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), 'canopy-worktree-health-'));
  return tempRoot;
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error('Git command failed'),
        );
        return;
      }
      resolvePromise();
    });
  });
}

async function createRepoWithGitDirectory(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await runGit(['init', '-q'], repoPath);
}

async function createRepoWithGitFile(
  repoPath: string,
  gitDirPath: string,
): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await runGit(['init', '-q'], repoPath);
  await mkdir(dirname(gitDirPath), { recursive: true });
  await rename(join(repoPath, '.git'), gitDirPath);
  await writeFile(join(repoPath, '.git'), `gitdir: ${gitDirPath}\n`, 'utf8');
}

beforeEach(() => {
  jest.clearAllMocks();
  currentWorktree = {
    id: 'wt-1',
    branchName: 'feature/wt-1',
    createdAt: '2026-04-22T00:00:00.000Z',
  };
  mockedReadWorkspaceConfig.mockResolvedValue(singleRepoConfig());
  mockedReadWorkspaceWorktrees.mockImplementation(() =>
    Promise.resolve(currentWorktree ? [currentWorktree] : []),
  );
  mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
  mockedUpdateWorkspaceWorktree.mockImplementation(
    (_workspaceId, worktreeId, updater) => {
      if (!currentWorktree || currentWorktree.id !== worktreeId) {
        return Promise.resolve(false);
      }

      currentWorktree = updater(currentWorktree);
      return Promise.resolve(true);
    },
  );
});

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('worktree-health', () => {
  it('detects a worktree whose .git file points to a missing gitdir', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, '.git'), 'gitdir: ../missing-admin\n');
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    const issue = await validateWorktreeHealth('project-1', 'wt-1');

    expect(issue).toMatchObject({
      status: 'broken',
      code: 'invalid-git-worktree',
      message:
        'Git metadata for this worktree is incomplete or points to a missing location.',
      worktreePath: repoPath,
    });
    expect(issue?.gitError).toContain('Missing gitdir target:');
  });

  it('detects a missing worktree directory', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'missing-repo');
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    const issue = await validateWorktreeHealth('project-1', 'wt-1');

    expect(issue).toMatchObject({
      status: 'broken',
      code: 'missing-worktree-path',
      message: 'Worktree directory does not exist.',
      worktreePath: repoPath,
    });
  });

  it('returns healthy for a valid .git directory', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    await createRepoWithGitDirectory(repoPath);
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    await expect(
      validateWorktreeHealth('project-1', 'wt-1'),
    ).resolves.toBeNull();
  });

  it('detects a present but unreadable .git directory', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    await mkdir(join(repoPath, '.git'), { recursive: true });
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    const issue = await validateWorktreeHealth('project-1', 'wt-1');

    expect(issue).toMatchObject({
      status: 'broken',
      code: 'git-error',
      message: 'Git could not validate this worktree.',
      worktreePath: repoPath,
    });
    expect(issue?.gitError).toContain('not a git repository');
  });

  it('refreshes checkedAt when retry still fails', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'missing-repo');
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    currentWorktree = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt: '2026-04-22T00:00:00.000Z',
      splitRecoveryRequired: true,
      healthIssue: {
        status: 'broken',
        code: 'missing-worktree-path',
        message: 'Worktree directory does not exist.',
        checkedAt: '2026-04-22T00:00:00.000Z',
        worktreePath: repoPath,
      },
    };

    const response = await retryWorktreeHealthCheck('project-1', 'wt-1');

    expect(response.healthy).toBe(false);
    expect(response.worktree.healthIssue?.checkedAt).not.toBe(
      '2026-04-22T00:00:00.000Z',
    );
    expect(response.worktree.healthIssue).toEqual(response.issue);
  });

  it('returns healthy for a valid .git file with an existing target', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    const gitDirPath = join(root, 'admin', 'repo.git');
    await createRepoWithGitFile(repoPath, gitDirPath);
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    await expect(
      validateWorktreeHealth('project-1', 'wt-1'),
    ).resolves.toBeNull();
  });

  it('updates broken repo issue details when repo paths change', async () => {
    const previousIssue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'missing-repository',
      message: 'One or more repositories in this project are missing.',
      checkedAt: '2026-04-22T00:00:00.000Z',
      worktreePath: '/worktrees/project-1/wt-1',
      repoIssues: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          repoPath: '/old/repo-a',
          code: 'missing-repository',
          message: 'Repository directory is missing from this worktree.',
        },
      ],
    };
    const nextIssue: WorktreeHealthIssue = {
      ...previousIssue,
      checkedAt: '2026-04-23T00:00:00.000Z',
      repoIssues: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A Renamed',
          repoPath: '/new/repo-a',
          code: 'missing-repository',
          message: 'Repository directory is missing from this worktree.',
        },
      ],
    };
    currentWorktree = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt: '2026-04-22T00:00:00.000Z',
      healthIssue: previousIssue,
    };

    const response = await recordWorktreeHealth({
      source: 'diff-stats',
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      issue: nextIssue,
    });

    expect(response.status).toBe('recorded');
    expect(response.worktree?.healthIssue?.repoIssues).toEqual(
      nextIssue.repoIssues,
    );
    expect(currentWorktree?.healthIssue?.repoIssues).toEqual(
      nextIssue.repoIssues,
    );
  });

  it('clears a persisted health issue when retry validates successfully', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    await createRepoWithGitDirectory(repoPath);
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    currentWorktree = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt: '2026-04-22T00:00:00.000Z',
      healthIssue: {
        status: 'broken',
        code: 'missing-git-metadata',
        message: 'Git metadata is missing for this worktree.',
        checkedAt: '2026-04-22T00:00:00.000Z',
        worktreePath: repoPath,
      },
    };

    const response = await retryWorktreeHealthCheck('project-1', 'wt-1');

    expect(response.healthy).toBe(true);
    expect(response.worktree.healthIssue).toBeUndefined();
    expect(response.worktree.splitRecoveryRequired).toBeUndefined();
  });

  it('persists a health issue when retry still fails', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'missing-repo');
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);

    const response = await retryWorktreeHealthCheck('project-1', 'wt-1');

    expect(response.healthy).toBe(false);
    expect(response.issue).toMatchObject({
      status: 'broken',
      code: 'missing-worktree-path',
      worktreePath: repoPath,
    });
    expect(response.worktree.healthIssue).toEqual(response.issue);
  });

  it('returns a best-effort broken worktree when persistence misses', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'missing-repo');
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    currentWorktree = null;
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-22T00:00:00.000Z',
      },
    ]);

    const response = await retryWorktreeHealthCheck('project-1', 'wt-1');

    expect(response.healthy).toBe(false);
    expect(response.worktree).toMatchObject({
      id: 'wt-1',
      branchName: 'feature/wt-1',
      healthIssue: response.issue,
    });
  });

  it('returns a healthy best-effort worktree when clearing persistence misses', async () => {
    const root = await createTempRoot();
    const repoPath = join(root, 'repo');
    await createRepoWithGitDirectory(repoPath);
    mockedResolveWorktreeCwd.mockReturnValue(repoPath);
    currentWorktree = null;
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-22T00:00:00.000Z',
        healthIssue: {
          status: 'broken',
          code: 'missing-git-metadata',
          message: 'Git metadata is missing for this worktree.',
          checkedAt: '2026-04-22T00:00:00.000Z',
          worktreePath: repoPath,
        },
      },
    ]);

    const response = await retryWorktreeHealthCheck('project-1', 'wt-1');

    expect(response.healthy).toBe(true);
    expect(response.worktree).toMatchObject({
      id: 'wt-1',
      branchName: 'feature/wt-1',
    });
    expect(response.worktree.healthIssue).toBeUndefined();
  });

  it('detects configured repositories missing from a multi-repo worktree', async () => {
    const root = await createTempRoot();
    const worktreePath = join(root, 'workspace');
    const repoPath = join(worktreePath, 'repos', 'repo-a');
    await createRepoWithGitDirectory(repoPath);
    mockedResolveWorktreeCwd.mockReturnValue(worktreePath);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/source/repo-a',
        },
        {
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/source/repo-b',
        },
      ],
    });
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath,
      },
    ]);

    const issue = await validateWorktreeHealth('project-1', 'wt-1');

    expect(issue).toMatchObject({
      status: 'broken',
      code: 'missing-repository',
      message: 'One or more repositories in this project are missing.',
      worktreePath,
      repoIssues: [
        {
          repoId: 'repo-b',
          repoName: 'Repo B',
          repoPath: join(worktreePath, 'repos', 'repo-b'),
          code: 'missing-repository',
          message: 'Repository directory is missing from this worktree.',
        },
      ],
    });
  });

  it('keeps an explicitly root-only multi-repo worktree healthy', async () => {
    const root = await createTempRoot();
    const unmanagedRepoPath = join(root, 'repos', 'personal-notes');
    await mkdir(unmanagedRepoPath, { recursive: true });
    mockedResolveWorktreeCwd.mockReturnValue(root);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/source/repo-a',
        },
      ],
    });
    currentWorktree = {
      id: 'wt-1',
      branchName: 'feature/root-only',
      createdAt: '2026-08-07T00:00:00.000Z',
      includedRepoIds: [],
    };
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'personal-notes',
        repoName: 'personal-notes',
        repoPath: unmanagedRepoPath,
      },
    ]);

    await expect(
      validateWorktreeHealth('project-1', 'wt-1'),
    ).resolves.toBeNull();
  });
});
