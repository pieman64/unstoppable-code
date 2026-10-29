import {
  getCommonWindowsGitBashPaths,
  resolveGitBashFromGitExecutable,
  resolveWindowsGitBash,
} from '../lib/windows-git-bash';

describe('windows-git-bash', () => {
  it('derives Git Bash from CANOPY_GIT_EXECUTABLE under Git cmd', () => {
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';

    expect(
      resolveGitBashFromGitExecutable(
        'C:\\Program Files\\Git\\cmd\\git.exe',
        (filePath) => filePath === bashPath,
      ),
    ).toBe(bashPath);
  });

  it('derives Git Bash from CANOPY_GIT_EXECUTABLE under Git bin', () => {
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';

    expect(
      resolveGitBashFromGitExecutable(
        'C:\\Program Files\\Git\\bin\\git.exe',
        (filePath) => filePath === bashPath,
      ),
    ).toBe(bashPath);
  });

  it('ignores git executables outside a Git cmd or bin directory', () => {
    expect(
      resolveGitBashFromGitExecutable('C:\\Tools\\git.exe', () => true),
    ).toBeNull();
  });

  it('checks common Git Bash install paths', () => {
    expect(
      getCommonWindowsGitBashPaths({
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
      }),
    ).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Programs\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Programs\\Git\\bin\\bash.exe',
      'C:\\Users\\Ada\\AppData\\Local\\Git\\bin\\bash.exe',
      'C:\\Users\\Ada\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    ]);
  });

  it('prefers Git executable-derived bash before common paths', () => {
    const fromGitExecutable = 'C:\\Git\\bin\\bash.exe';
    const fromCommonPath = 'C:\\Program Files\\Git\\bin\\bash.exe';

    expect(
      resolveWindowsGitBash(
        {
          CANOPY_GIT_EXECUTABLE: 'C:\\Git\\cmd\\git.exe',
          ProgramFiles: 'C:\\Program Files',
        },
        (filePath) =>
          filePath === fromGitExecutable || filePath === fromCommonPath,
      ),
    ).toBe(fromGitExecutable);
  });
});
