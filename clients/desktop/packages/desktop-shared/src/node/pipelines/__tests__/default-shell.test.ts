import { getDefaultShellTypeForPlatform } from '../default-shell';

describe('getDefaultShellTypeForPlatform', () => {
  it('uses Windows PowerShell as the implicit Windows default', () => {
    expect(getDefaultShellTypeForPlatform('win32')).toBe('powershell');
  });

  it('uses bash outside Windows', () => {
    expect(getDefaultShellTypeForPlatform('darwin')).toBe('bash');
    expect(getDefaultShellTypeForPlatform('linux')).toBe('bash');
  });
});
