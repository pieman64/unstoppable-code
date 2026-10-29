jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchesForWorktree: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

import {
  CANOPY_BASE_BRANCH_BY_REPO_ENV,
  CANOPY_BASE_BRANCH_ENV,
  CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO_ENV,
  CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV,
} from '@canopy/desktop-shared/pipelines/base-branch-env';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { resolveEffectiveBaseBranchesForWorktree } from '../lib/worktree-base-branches';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { buildPipelineBaseBranchEnv } from '../pipelines/worktree-base-branch-env';

const mockedResolveEffectiveBaseBranchesForWorktree = jest.mocked(
  resolveEffectiveBaseBranchesForWorktree,
);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);

describe('buildPipelineBaseBranchEnv', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repo',
      repos: [],
    });
  });

  it('builds singular and repo maps for a single-repo tracked remote base branch', async () => {
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({
      repo: {
        branch: 'develop',
        existsLocally: true,
        existsInRemote: true,
      },
    });

    const env = await buildPipelineBaseBranchEnv({
      cwd: '/repo',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(env).toMatchObject({
      [CANOPY_BASE_BRANCH_ENV]: 'develop',
      [CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV]: 'true',
      [CANOPY_BASE_BRANCH_BY_REPO_ENV]: JSON.stringify({ repo: 'develop' }),
      [CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO_ENV]: JSON.stringify({
        repo: 'true',
      }),
    });
  });

  it('marks a single-repo local-only tracked base branch as not remote-backed', async () => {
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({
      repo: {
        branch: 'release/1.2',
        existsLocally: true,
        existsInRemote: false,
      },
    });

    const env = await buildPipelineBaseBranchEnv({
      cwd: '/repo',
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(env[CANOPY_BASE_BRANCH_ENV]).toBe('release/1.2');
    expect(env[CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV]).toBe('false');
  });

  it('uses the project root repo as the singular env source for source-backed projects', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: '/workspace-source',
    });
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({
      [WORKSPACE_ROOT_REPO_ID]: {
        branch: 'main',
        existsLocally: true,
        existsInRemote: true,
      },
      'repo-a': {
        branch: 'develop',
        existsLocally: true,
        existsInRemote: false,
      },
    });

    const env = await buildPipelineBaseBranchEnv({
      cwd: '/workspace',
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(env[CANOPY_BASE_BRANCH_ENV]).toBe('main');
    expect(env[CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV]).toBe('true');
    expect(env[CANOPY_BASE_BRANCH_BY_REPO_ENV]).toBe(
      JSON.stringify({
        [WORKSPACE_ROOT_REPO_ID]: 'main',
        'repo-a': 'develop',
      }),
    );
    expect(env[CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO_ENV]).toBe(
      JSON.stringify({
        [WORKSPACE_ROOT_REPO_ID]: 'true',
        'repo-a': 'false',
      }),
    );
  });

  it('omits singular env vars for local-only multi-repo projects without a root repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/workspace/repos/repo-a',
        },
      ],
    });
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({
      'repo-a': {
        branch: 'develop',
        existsLocally: false,
        existsInRemote: true,
      },
    });

    const env = await buildPipelineBaseBranchEnv({
      cwd: '/workspace',
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
    });

    expect(env[CANOPY_BASE_BRANCH_ENV]).toBeUndefined();
    expect(env[CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV]).toBeUndefined();
    expect(env[CANOPY_BASE_BRANCH_BY_REPO_ENV]).toBe(
      JSON.stringify({
        'repo-a': 'develop',
      }),
    );
  });
});
