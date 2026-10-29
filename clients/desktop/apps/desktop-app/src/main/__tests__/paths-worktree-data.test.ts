jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock-data'),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  getAppAdvisorChatTabsFilePath,
  getAppAdvisorHomeDir,
  getGitHubPrStateDir,
  getHookInvocationDir,
  getWorktreeAttachmentsDir,
  getWorktreeDataDir,
  getWorktreeDataRootDir,
  getWorktreeTerminalStateFilePath,
} from '../lib/paths';
import { resolveChatTabsFilePath } from '../lib/resolve-worktree';
import { getWorkspaceType } from '../lib/workspace-registry';

const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);

describe('worktree-data paths', () => {
  beforeEach(() => {
    mockedGetWorkspaceType.mockReturnValue(null);
  });

  it('stores per-worktree data outside the git checkout', () => {
    expect(getWorktreeDataRootDir('workspace-1')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data',
    );
    expect(getWorktreeDataDir('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data/wt-1',
    );
  });

  it('nests GitHub PR tracking state under the worktree data directory', () => {
    expect(getGitHubPrStateDir('workspace-1', 'wt-1', 'repo-a')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data/wt-1/github-pr/repo-a',
    );
  });

  it('allocates immutable hook invocation scratch space per run', () => {
    expect(getHookInvocationDir('workspace-1', 'wt-1', 'run-1')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data/wt-1/hook-invocations/run-1',
    );
  });

  it('stores persisted terminal drawer state under worktree metadata', () => {
    expect(getWorktreeTerminalStateFilePath('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data/wt-1/terminal-state.json',
    );
  });

  it('stores app-managed chat projects outside the user project root', () => {
    expect(getAppAdvisorHomeDir()).toBe(
      '/mock-data/app-workspaces/app-advisor/home',
    );
    expect(
      getWorktreeDataDir(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).toBe('/mock-data/app-workspaces/app-advisor/worktree-data/global');
    expect(getAppAdvisorChatTabsFilePath(APP_ADVISOR_WORKTREE_ID)).toBe(
      '/mock-data/app-workspaces/app-advisor/chats/global.json',
    );
    expect(
      resolveChatTabsFilePath(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).toBe('/mock-data/app-workspaces/app-advisor/chats/global.json');
    expect(getWorktreeDataRootDir(PLAN_EXPLORE_CHAT_PROJECT_ID)).toBe(
      '/mock-data/app-workspaces/plan-explore-chat/worktree-data',
    );
    expect(
      getWorktreeAttachmentsDir(PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-1'),
    ).toBe('/mock-data/app-workspaces/plan-explore-chat/attachments/plan-1');
  });

  it('routes shared-container recipient view state outside the user project root despite a registry collision', () => {
    mockedGetWorkspaceType.mockReturnValue('single-repo');

    // The recipient surface keys panel layout on
    // (SHARED_CONTAINER_VIEWER_PROJECT_ID, containerId). Without the
    // app-managed registration this lands in `workspaces/`, which is reserved
    // for user-visible sidebar workspaces.
    expect(getWorktreeDataRootDir(SHARED_CONTAINER_VIEWER_PROJECT_ID)).toBe(
      '/mock-data/app-workspaces/shared-container-viewer/worktree-data',
    );
    expect(
      getWorktreeDataDir(SHARED_CONTAINER_VIEWER_PROJECT_ID, 'container-1'),
    ).toBe(
      '/mock-data/app-workspaces/shared-container-viewer/worktree-data/container-1',
    );
  });

  it('never routes App Advisor data through the indexed-workspace tree', () => {
    mockedGetWorkspaceType.mockReturnValue('single-repo');

    expect(getWorktreeDataRootDir(APP_ADVISOR_PROJECT_ID)).toBe(
      '/mock-data/app-workspaces/app-advisor/worktree-data',
    );
    expect(getWorktreeAttachmentsDir(APP_ADVISOR_PROJECT_ID, 'entry-1')).toBe(
      '/mock-data/app-workspaces/app-advisor/attachments/entry-1',
    );
  });

  it('keeps a registered plan-explore collision under the user project root', () => {
    const workspaceId = PLAN_EXPLORE_CHAT_PROJECT_ID;
    mockedGetWorkspaceType.mockReturnValue('single-repo');

    expect(getWorktreeDataRootDir(workspaceId)).toBe(
      `/mock-data/workspaces/${workspaceId}/worktree-data`,
    );
    expect(getWorktreeDataDir(workspaceId, 'wt-1')).toBe(
      `/mock-data/workspaces/${workspaceId}/worktree-data/wt-1`,
    );
    expect(getWorktreeAttachmentsDir(workspaceId, 'wt-1')).toBe(
      `/mock-data/workspaces/${workspaceId}/attachments/wt-1`,
    );
  });
});
