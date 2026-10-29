jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock-data'),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));

import {
  getWorktreeScriptRunDir,
  getWorkspaceScriptRunDir,
  resolveScriptRunDir,
} from '../lib/paths';
import { getWorkspaceType } from '../lib/workspace-registry';

const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);

describe('script log paths', () => {
  beforeEach(() => {
    mockedGetWorkspaceType.mockReset();
    mockedGetWorkspaceType.mockReturnValue(null);
  });

  it('stores single-repo worktree logs in the project metadata directory', () => {
    expect(getWorktreeScriptRunDir('project-1', 'wt-1')).toBe(
      '/mock-data/workspaces/project-1/script-runs/wt-1',
    );
    expect(getWorktreeScriptRunDir('project-1', 'wt-1')).not.toContain(
      '/worktrees/wt-1',
    );
  });

  it('stores multi-repo worktree logs in the project metadata directory', () => {
    expect(getWorkspaceScriptRunDir('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/script-runs/wt-1',
    );
    expect(getWorkspaceScriptRunDir('workspace-1', 'wt-1')).not.toContain(
      '/worktrees/wt-1',
    );
  });

  it('resolves script-run storage based on project type', () => {
    expect(resolveScriptRunDir('project-1', 'wt-1')).toBe(
      '/mock-data/workspaces/project-1/script-runs/wt-1',
    );

    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    expect(resolveScriptRunDir('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/script-runs/wt-1',
    );
  });
});
