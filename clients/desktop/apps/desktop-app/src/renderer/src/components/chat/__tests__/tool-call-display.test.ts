import { unwrapShellWrappedCommand } from '../tool-call-display';

describe('tool-call-display', () => {
  describe('unwrapShellWrappedCommand', () => {
    it('unwraps single-quoted login-shell commands', () => {
      expect(
        unwrapShellWrappedCommand("/bin/zsh -lc 'printf hello && pwd'"),
      ).toBe('printf hello && pwd');
    });

    it('unwraps double-quoted login-shell commands', () => {
      expect(
        unwrapShellWrappedCommand('/bin/zsh -lc "printf hello && pwd"'),
      ).toBe('printf hello && pwd');
    });

    it('unwraps double-quoted commands with escaped double quotes', () => {
      expect(
        unwrapShellWrappedCommand('/bin/zsh -lc "printf \\"hello\\" && pwd"'),
      ).toBe('printf \\"hello\\" && pwd');
    });

    it('unwraps single-quoted commands with escaped single quotes', () => {
      expect(
        unwrapShellWrappedCommand("/bin/zsh -lc 'printf \\'hello\\' && pwd'"),
      ).toBe("printf \\'hello\\' && pwd");
    });

    it('unwraps single-quoted Windows shell -Command wrappers', () => {
      expect(
        unwrapShellWrappedCommand(
          String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-ChildItem -Force'`,
        ),
      ).toBe('Get-ChildItem -Force');
    });

    it('unwraps double-quoted Windows shell -Command wrappers', () => {
      expect(
        unwrapShellWrappedCommand(
          String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Write-Output \"hello\""`,
        ),
      ).toBe(String.raw`Write-Output \"hello\"`);
    });

    it('leaves non-wrapped commands unchanged', () => {
      expect(unwrapShellWrappedCommand('printf hello && pwd')).toBe(
        'printf hello && pwd',
      );
    });

    it('does not unwrap login shell commands when trailing text appears after the closing quote', () => {
      expect(
        unwrapShellWrappedCommand(
          '/bin/zsh -lc "printf hello && pwd" trailing',
        ),
      ).toBe('/bin/zsh -lc "printf hello && pwd" trailing');
    });

    it('strips Windows shell -Command prefixes when trailing text follows the payload', () => {
      expect(
        unwrapShellWrappedCommand(
          String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "pwd" trailing`,
        ),
      ).toBe(String.raw`"pwd" trailing`);
    });

    it('strips Windows shell -Command prefixes from complex PowerShell payloads', () => {
      expect(
        unwrapShellWrappedCommand(
          String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '$p='"'C:\Users\Tommy\.canopy-dev\codex-capabilities\roots'; if (Test-Path -LiteralPath "'$p) { Get-ChildItem -LiteralPath $p -Force | Select-Object Mode,Attributes,Name,LinkType,Target | Format-Table -AutoSize } else { '"'parent missing' }"`,
        ),
      ).toBe(
        String.raw`'$p='"'C:\Users\Tommy\.canopy-dev\codex-capabilities\roots'; if (Test-Path -LiteralPath "'$p) { Get-ChildItem -LiteralPath $p -Force | Select-Object Mode,Attributes,Name,LinkType,Target | Format-Table -AutoSize } else { '"'parent missing' }"`,
      );
    });

    it('does not unwrap when the quoted payload contains an unescaped delimiter quote', () => {
      expect(
        unwrapShellWrappedCommand(`/bin/zsh -lc 'printf 'hello' && pwd'`),
      ).toBe(`/bin/zsh -lc 'printf 'hello' && pwd'`);
      expect(
        unwrapShellWrappedCommand('/bin/zsh -lc "printf "hello" && pwd"'),
      ).toBe('/bin/zsh -lc "printf "hello" && pwd"');
      expect(
        unwrapShellWrappedCommand(
          String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Write-Output "hello""`,
        ),
      ).toBe(String.raw`Write-Output "hello"`);
    });
  });
});
