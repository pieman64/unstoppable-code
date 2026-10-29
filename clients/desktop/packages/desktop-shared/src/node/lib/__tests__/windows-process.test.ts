import {
  buildCmdCommandLine,
  quoteCmdArgument,
  wrapWindowsCommandShim,
} from '../windows-process';

describe('windows-process', () => {
  it('wraps cmd and bat shims through cmd.exe on Windows', () => {
    expect(
      wrapWindowsCommandShim(
        {
          command: 'C:\\Program Files\\node\\tsx.cmd',
          args: ['script.ts', 'C:\\work tree'],
        },
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"C:\\Program Files\\node\\tsx.cmd" script.ts "C:\\work tree"',
      ],
    });
  });

  it('leaves non-Windows and non-shim commands unchanged', () => {
    const exeSpec = { command: 'Code.exe', args: ['C:\\repo'] };
    const nonWindowsSpec = { command: 'tsx.cmd', args: ['script.ts'] };

    expect(wrapWindowsCommandShim(exeSpec, 'win32')).toBe(exeSpec);
    expect(wrapWindowsCommandShim(nonWindowsSpec, 'darwin')).toBe(
      nonWindowsSpec,
    );
  });

  it('quotes spaces and cmd metacharacters', () => {
    expect(quoteCmdArgument('plain')).toBe('plain');
    expect(quoteCmdArgument('has space')).toBe('"has space"');
    expect(quoteCmdArgument('a&b')).toBe('"a&b"');
    expect(quoteCmdArgument('a|b')).toBe('"a|b"');
    expect(quoteCmdArgument('a<b')).toBe('"a<b"');
    expect(quoteCmdArgument('a>b')).toBe('"a>b"');
    expect(quoteCmdArgument('a^b')).toBe('"a^b"');
    expect(quoteCmdArgument('a(b)')).toBe('"a(b)"');
    expect(quoteCmdArgument('a"b')).toBe('"a""b"');
  });

  it('builds a single cmd.exe command line with quoted command and args', () => {
    expect(
      buildCmdCommandLine('C:\\Program Files\\node\\tsx.cmd', [
        'script.ts',
        'C:\\work tree',
      ]),
    ).toBe('"C:\\Program Files\\node\\tsx.cmd" script.ts "C:\\work tree"');
  });

  it('rejects percent expansion in command paths and args', () => {
    expect(() =>
      wrapWindowsCommandShim(
        { command: 'C:\\%TEMP%\\tsx.cmd', args: ['script.ts'] },
        'win32',
      ),
    ).toThrow(/% through cmd\.exe/);
    expect(() =>
      wrapWindowsCommandShim(
        { command: 'tsx.cmd', args: ['C:\\%FOO%\\repo'] },
        'win32',
      ),
    ).toThrow(/% through cmd\.exe/);
  });

  it('treats exclamation marks as literals without enabling delayed expansion', () => {
    expect(quoteCmdArgument('set!name=value')).toBe('set!name=value');
    expect(quoteCmdArgument('dir!name!')).toBe('dir!name!');
    expect(quoteCmdArgument('dir !name!')).toBe('"dir !name!"');

    const wrapped = wrapWindowsCommandShim(
      { command: 'tsx.cmd', args: ['dir !name!'] },
      'win32',
    );
    expect(wrapped.args).not.toContain('/v:on');
  });
});
