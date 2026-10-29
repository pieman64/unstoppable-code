import { buildCursorHookCommand } from '../hook-command';

describe('Cursor approval hook command', () => {
  it('single-quotes arguments for POSIX shells', () => {
    expect(
      buildCursorHookCommand(
        ['/runtime/node', '/hooks/approval-hook.cjs', '/hooks/connection.json'],
        'darwin',
      ),
    ).toBe(
      "'/runtime/node' '/hooks/approval-hook.cjs' '/hooks/connection.json'",
    );
  });

  it('escapes embedded single quotes on POSIX', () => {
    expect(buildCursorHookCommand(["/it's/node"], 'darwin')).toBe(
      `'/it'"'"'s/node'`,
    );
  });

  it('double-quotes arguments on Windows, where single quotes are literal', () => {
    // cmd.exe treats ' as an ordinary character, so POSIX quoting would make
    // the hook command unparseable and every tool call would be denied.
    expect(
      buildCursorHookCommand(
        [
          'C:\\Program Files\\cursor\\node.exe',
          'C:\\data\\approval-hook.cjs',
          'C:\\data\\connection.json',
        ],
        'win32',
      ),
    ).toBe(
      '"C:\\Program Files\\cursor\\node.exe" "C:\\data\\approval-hook.cjs" "C:\\data\\connection.json"',
    );
  });

  it.each([
    ['double quote', 'C:\\a"b\\node.exe'],
    // cmd.exe expands %VAR% *inside* double quotes, so quoting does not
    // neutralize it. `%` is legal in a Windows filename, so this is reachable
    // through a username or worktree name rather than only through an attack.
    ['percent expansion', 'C:\\Users\\a%TEMP%b\\node.exe'],
    ['newline', 'C:\\a\nb\\node.exe'],
  ])('refuses a Windows argument containing %s', (_label, value) => {
    // The hook is registered failClosed, so a command cmd.exe mis-parses
    // denies EVERY tool call. Refusing at session start surfaces the problem
    // instead of silently disabling the agent.
    expect(() => buildCursorHookCommand([value], 'win32')).toThrow(
      'Windows cannot quote safely',
    );
  });

  it.each([
    ['ampersand', 'C:\\Users\\R&D\\node.exe'],
    ['caret', 'C:\\Users\\a^b\\node.exe'],
    ['pipe', 'C:\\Users\\a|b\\node.exe'],
    ['redirects', 'C:\\Users\\a<b>c\\node.exe'],
    ['exclamation', 'C:\\Users\\hi!\\node.exe'],
    ['parentheses', 'C:\\Users\\a(b)\\node.exe'],
  ])('accepts %s, which cmd treats literally inside double quotes', (_l, v) => {
    // These are legal in Windows account and folder names, and both hook
    // arguments embed the user profile path. Refusing them would hard-fail
    // every turn for a user whose home directory simply contains one.
    expect(buildCursorHookCommand([v], 'win32')).toBe(`"${v}"`);
  });

  it('still accepts ordinary Windows paths with spaces', () => {
    expect(
      buildCursorHookCommand(['C:\\Program Files\\cursor\\node.exe'], 'win32'),
    ).toBe('"C:\\Program Files\\cursor\\node.exe"');
  });

  it('leaves POSIX arguments alone, where single-quoting is sufficient', () => {
    // Only cmd.exe has this problem; a POSIX path may legitimately contain %.
    expect(buildCursorHookCommand(['/a%b&c/node'], 'darwin')).toBe(
      "'/a%b&c/node'",
    );
  });
});
