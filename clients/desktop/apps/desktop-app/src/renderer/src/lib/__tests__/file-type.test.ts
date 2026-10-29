import { getFilenameFromPath } from '../file-type';

describe('file-type', () => {
  it('extracts filenames from POSIX paths', () => {
    expect(getFilenameFromPath('/Users/tommy/workspace/src/app.ts')).toBe(
      'app.ts',
    );
  });

  it('extracts filenames from Windows paths', () => {
    const windowsPath = [
      'C:',
      'Users',
      'Tommy',
      '.canopy',
      'workspaces',
      'canopy',
      'worktrees',
      'python',
      'apps',
      'desktop-app',
      'src',
      'renderer',
      'src',
      'components',
      'worktree',
      'WorkspaceSettingsModal.tsx',
    ].join('\\');

    expect(getFilenameFromPath(windowsPath)).toBe('WorkspaceSettingsModal.tsx');
  });
});
