jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock-data'),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
}));

import { join } from 'node:path';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { getBrowserTaskFilesDir, getWorktreeDataDir } from '../lib/paths';
import { getWorkspaceType } from '../lib/workspace-registry';

describe('browser task files paths', () => {
  beforeEach(() => {
    jest.mocked(getCanopyDataDir).mockReturnValue('/mock-data');
    jest.mocked(getWorkspaceType).mockReturnValue(null);
  });

  it('stores browser files under canonical worktree metadata, outside the checkout', () => {
    expect(getBrowserTaskFilesDir('workspace-1', 'wt-1')).toBe(
      '/mock-data/workspaces/workspace-1/worktree-data/wt-1/browser-files',
    );
    expect(getBrowserTaskFilesDir('workspace-1', 'wt-1')).toBe(
      join(getWorktreeDataDir('workspace-1', 'wt-1'), 'browser-files'),
    );
  });

  it('keeps projects and task scopes isolated', () => {
    const paths = [
      getBrowserTaskFilesDir('workspace-1', 'wt-1'),
      getBrowserTaskFilesDir('workspace-1', 'wt-2'),
      getBrowserTaskFilesDir('workspace-2', 'wt-1'),
    ];
    expect(new Set(paths).size).toBe(3);
  });

  it('uses the resolved data root', () => {
    jest.mocked(getCanopyDataDir).mockReturnValue('/custom/data-root');
    expect(getBrowserTaskFilesDir('workspace-1', 'wt-1')).toBe(
      '/custom/data-root/workspaces/workspace-1/worktree-data/wt-1/browser-files',
    );
  });

  it('routes App Advisor through its app-managed worktree data root despite a registry collision', () => {
    jest.mocked(getWorkspaceType).mockReturnValue('single-repo');
    expect(
      getBrowserTaskFilesDir(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).toBe(
      '/mock-data/app-workspaces/app-advisor/worktree-data/global/browser-files',
    );
  });

  it('uses the Cowork Work Entry task scope', () => {
    jest.mocked(getWorkspaceType).mockReturnValue('cowork');
    expect(getBrowserTaskFilesDir('cowork-1', 'entry-1')).toBe(
      '/mock-data/workspaces/cowork-1/worktree-data/entry-1/browser-files',
    );
  });
});
