jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock-data'),
}));

import {
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeSummaryFilePath,
} from '../lib/paths';

describe('worktree summary paths', () => {
  it('stores single-repo summaries in the project summaries directory', () => {
    expect(getWorktreeSummaryFilePath('project-1', 'wt-1')).toBe(
      '/mock-data/workspaces/project-1/summaries/wt-1.json',
    );
  });

  it('stores multi-repo summaries in the project summaries directory', () => {
    expect(getWorkspaceWorktreeSummaryFilePath('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/summaries/wt-1.json',
    );
  });
});
