import type * as WorktreeDataEnvModule from '../lib/worktree-data-env';

jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
}));

const mockGetEnhancedEnv = jest.fn(() => ({
  PATH: '/mock/bin',
  USER_CONFIGURED_ENV: 'available',
}));

jest.mock('../pipelines/config-paths', () => ({
  getEnhancedEnv: mockGetEnhancedEnv,
}));

import { buildWorktreeDataEnv } from '../lib/worktree-data-env';

afterEach(() => {
  jest.dontMock('@canopy/brand/current');
});

describe('buildWorktreeDataEnv', () => {
  it('keeps runtime-derived worktree vars authoritative', () => {
    const env = buildWorktreeDataEnv('workspace-a', 'gorilla', {
      CANOPY_WORKSPACE_ID: 'spoofed-workspace',
      CANOPY_WORKTREE_NAME: 'spoofed-worktree',
      CONDUCTOR_WORKSPACE_NAME: 'spoofed-alias',
      CANOPY_WORKTREE_DATA_DIR: '/tmp/spoofed',
      CANOPY_WORKSPACE_CHILD_REPO_ID: 'repo-a',
    });

    expect(env.CANOPY_WORKSPACE_ID).toBe('workspace-a');
    expect(env.CANOPY_WORKTREE_NAME).toBe('gorilla');
    expect(env.CONDUCTOR_WORKSPACE_NAME).toBe('gorilla');
    expect(env.CANOPY_WORKTREE_DATA_DIR).toBe(
      '/mock/workspaces/workspace-a/worktree-data/gorilla',
    );
    expect(env.CANOPY_WORKSPACE_CHILD_REPO_ID).toBe('repo-a');
  });

  it('includes user-configured enhanced environment variables', () => {
    const env = buildWorktreeDataEnv('workspace-a', 'gorilla');

    expect(env.PATH).toBe('/mock/bin');
    expect(env.USER_CONFIGURED_ENV).toBe('available');
  });

  it('writes branded primary env vars before preserving non-empty legacy aliases', () => {
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: {
        environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
      },
    }));

    jest.isolateModules(() => {
      const { buildWorktreeDataEnv: buildBrandedWorktreeDataEnv } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../lib/worktree-data-env') as typeof WorktreeDataEnvModule;
      const env = buildBrandedWorktreeDataEnv('workspace-a', 'gorilla', {
        CANOPY_WORKSPACE_ID: 'legacy-workspace',
        CANOPY_WORKTREE_NAME: '',
        CANOPY_WORKTREE_DATA_DIR: 'legacy-data-dir',
        CANOPY_WORKSPACE_CHILD_REPO_ID: 'repo-a',
      });

      expect(env.TESTBRAND_WORKSPACE_ID).toBe('workspace-a');
      expect(env.TESTBRAND_WORKTREE_NAME).toBe('gorilla');
      expect(env.TESTBRAND_WORKTREE_DATA_DIR).toBe(
        '/mock/workspaces/workspace-a/worktree-data/gorilla',
      );
      expect(env.TESTBRAND_WORKSPACE_CHILD_REPO_ID).toBe('repo-a');
      expect(env.CANOPY_WORKSPACE_ID).toBe('legacy-workspace');
      expect(env.CANOPY_WORKTREE_NAME).toBe('gorilla');
      expect(env.CANOPY_WORKTREE_DATA_DIR).toBe('legacy-data-dir');
      expect(env.CANOPY_WORKSPACE_CHILD_REPO_ID).toBe('repo-a');
    });
  });
});
