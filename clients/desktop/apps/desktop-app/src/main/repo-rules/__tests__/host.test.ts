import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { resolveRepoRuleCheckouts, composeWorktreeRepoRules } from '../host';

let config: WorkspaceConfigFile;
let authority = 'ok';
const readConfig = jest.fn(() => Promise.resolve({ config, authority }));
const readWorktrees = jest.fn(() => Promise.resolve([{ id: 'wt-1' }]));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (): ReturnType<typeof readConfig> =>
    readConfig(),
  readWorkspaceWorktrees: (): ReturnType<typeof readWorktrees> =>
    readWorktrees(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: (
    _workspace: string,
    worktree: string,
    repo?: string,
  ): string => `/checkouts/${worktree}${repo ? `/repos/${repo}` : ''}`,
}));
beforeEach(() => {
  jest.clearAllMocks();
  config = { version: 1, type: 'single-repo', repoPath: '/source', repos: [] };
  authority = 'ok';
  readWorktrees.mockResolvedValue([{ id: 'wt-1' }]);
});
it('resolves source and selected worktree from trusted records with the same stable identity', async () => {
  expect(await resolveRepoRuleCheckouts({ workspaceId: 'w' })).toEqual([
    { repoId: SINGLE_REPO_USAGE_REPO_ID, root: '/source', prefix: '' },
  ]);
  expect(
    await resolveRepoRuleCheckouts({ workspaceId: 'w', worktreeId: 'wt-1' }),
  ).toEqual([
    { repoId: SINGLE_REPO_USAGE_REPO_ID, root: '/checkouts/wt-1', prefix: '' },
  ]);
});
it('resolves configured multi-repo members and their root without enumerating arbitrary directories', async () => {
  config = {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/source',
    repos: [{ id: 'a', name: 'a', repoPath: '/a' }],
  };
  expect(
    await resolveRepoRuleCheckouts({ workspaceId: 'w', worktreeId: 'wt-1' }),
  ).toEqual([
    { repoId: WORKSPACE_ROOT_REPO_ID, root: '/checkouts/wt-1', prefix: '' },
    { repoId: 'a', root: '/checkouts/wt-1/repos/a', prefix: 'repos/a' },
  ]);
});
it('refuses unavailable/cowork workspaces, invalid identifiers and unknown worktrees', async () => {
  await expect(
    resolveRepoRuleCheckouts({ workspaceId: '../escape' }),
  ).rejects.toThrow();
  await expect(
    resolveRepoRuleCheckouts({ workspaceId: 'w', worktreeId: 'unknown' }),
  ).rejects.toThrow('checkout');
  authority = 'unreadable';
  await expect(resolveRepoRuleCheckouts({ workspaceId: 'w' })).rejects.toThrow(
    'unavailable',
  );
  authority = 'ok';
  config.type = 'cowork';
  await expect(resolveRepoRuleCheckouts({ workspaceId: 'w' })).rejects.toThrow(
    'unavailable',
  );
});
it('does not resolve checkout configuration when workspace policy is disabled', async () => {
  expect(
    await composeWorktreeRepoRules(
      'disabled-workspace',
      'wt-1',
      '/checkouts/wt-1',
    ),
  ).toBe('');
  expect(readConfig).not.toHaveBeenCalled();
  expect(readWorktrees).not.toHaveBeenCalled();
});
