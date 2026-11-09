import type * as Runtime from '@canopy/core-runtime';
import { createChildServices } from '../supervision/child';

type Os = Runtime.PlatformOperatingSystem;
type Source = Record<string, string | undefined>;
const OSES = ['darwin', 'linux', 'win32'] as const;
const WINDOWS_PROGRAM_FILES_KEYS = [
  'ProgramFiles',
  'ProgramFiles(x86)',
] as const;
const WINDOWS_GIT_KEYS = [
  ...WINDOWS_PROGRAM_FILES_KEYS,
  'CANOPY_GIT_EXECUTABLE',
] as const;

const POSIX_SYSTEM = '/usr/bin:/bin:/usr/sbin:/sbin';
const WIN = 'C:\\Windows';
const WIN_SYSTEM = `${WIN}\\System32;${WIN};${WIN}\\System32\\WindowsPowerShell\\v1.0`;
const HOSTILE: Source = Object.fromEntries(
  'PATH Path LANG LC_ALL TZ USER LOGNAME USERNAME CANOPY_TOKEN AWS_SECRET_ACCESS_KEY NODE_OPTIONS DYLD_INSERT_LIBRARIES LD_PRELOAD GIT_EXEC_PATH GIT_CONFIG_GLOBAL GIT_CONFIG_COUNT GIT_SSH_COMMAND ComSpec PATHEXT windir'
    .split(' ')
    .map((key) => [key, 'evil-secret']),
);
const POSIX: Source = { ...HOSTILE, HOME: '/h:1', TMPDIR: '/t' };
const LINUX: Source = {
  ...POSIX,
  XDG_DATA_HOME: '/d',
  XDG_CONFIG_HOME: '',
  XDG_RUNTIME_DIR: 'relative',
};
const WINDOWS: Source = {
  ...HOSTILE,
  SYSTEMROOT: WIN,
  SystemRoot: WIN,
  userprofile: '\\\\srv\\share\\u;1',
  AppData: 'C:\\U\\R',
  LOCALAPPDATA: 'C:\\U\\L',
  TEMP: 'C:\\T',
  TMP: '',
};

type Env = Readonly<Record<string, string>>;
const env = (os: Os, source: Source, pathEntries?: readonly string[]): Env =>
  createChildServices(os).childEnvironment({ source, pathEntries });

describe('createChildServices.childProcessOptions', () => {
  it.each([
    ['darwin', 'owned', true, false],
    ['darwin', 'independent', true, false],
    ['linux', 'owned', true, false],
    ['linux', 'independent', true, false],
    ['win32', 'owned', false, true],
    ['win32', 'independent', true, true],
  ] as const)('%s %s', (os, lifetime, detached, windowsHide) => {
    const options = createChildServices(os).childProcessOptions({ lifetime });
    expect(options).toEqual({ detached, windowsHide });
    expect(Object.isFrozen(options)).toBe(true);
  });

  it.each(OSES)('%s rejects an unknown lifetime', (os) => {
    const request: Runtime.PlatformChildProcessRequest = { lifetime: 'owned' };
    Object.assign(request, { lifetime: 'forever' });
    expect(() => createChildServices(os).childProcessOptions(request)).toThrow(
      'Invalid child process lifetime',
    );
  });
});

describe('createChildServices.childEnvironment', () => {
  const darwin = {
    HOME: '/h:1',
    TMPDIR: '/t',
    PATH: `/s1:/s 2:${POSIX_SYSTEM}`,
  };
  const linux = { ...darwin, XDG_DATA_HOME: '/d' };
  const windows = {
    SystemRoot: WIN,
    WINDIR: WIN,
    ComSpec: `${WIN}\\System32\\cmd.exe`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    USERPROFILE: '\\\\srv\\share\\u;1',
    APPDATA: 'C:\\U\\R',
    LOCALAPPDATA: 'C:\\U\\L',
    TEMP: 'C:\\T',
    PATH: `C:\\s1;\\\\srv\\share\\bin;${WIN_SYSTEM}`,
  };
  it.each([
    ['darwin', POSIX, darwin],
    ['linux', LINUX, linux],
    ['win32', WINDOWS, windows],
  ] as const)('%s selects only the allowlist', (os, source, expected) => {
    const input = structuredClone(source);
    const entries =
      os === 'win32' ? ['C:\\s1', '\\\\srv\\share\\bin'] : ['/s1', '/s 2'];
    const result = env(os, Object.freeze(input), Object.freeze(entries));
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(input).toEqual(source);
  });

  const W: Source = { SystemRoot: WIN, USERPROFILE: 'C:\\u', APPDATA: 'C:\\r' };
  it.each(OSES)('%s omits absent optional values', (os) => {
    const result = env(os, os === 'win32' ? W : { HOME: '/h', TMPDIR: '' });
    expect(result.PATH).toBe(os === 'win32' ? WIN_SYSTEM : POSIX_SYSTEM);
    for (const key of ['TMPDIR', 'TEMP', 'TMP'])
      expect(result).not.toHaveProperty(key);
  });

  it.each(WINDOWS_GIT_KEYS)(
    'selects Windows %s without changing PATH',
    (key) => {
      for (const value of [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        '\\\\server\\share\\Git with spaces',
        'D:/Git with spaces',
        'D:\\Git;with semicolon',
      ]) {
        const source = Object.freeze({
          ...W,
          [key]: value,
          [key.toLowerCase()]: value,
          PATH: 'D:\\user-bin',
        });
        const result = env('win32', source);
        expect(result).toEqual({ ...env('win32', W), [key]: value });
        expect(result.PATH).toBe(WIN_SYSTEM);
        expect(Object.isFrozen(result)).toBe(true);
      }
    },
  );

  it.each(WINDOWS_GIT_KEYS)('omits missing or empty Windows %s', (key) => {
    for (const value of [undefined, ''])
      expect(env('win32', { ...W, [key]: value })).toEqual(env('win32', W));
    expect(
      env('win32', { ...W, [key]: undefined, [key.toLowerCase()]: 'D:\\Git' }),
    ).toEqual({ ...env('win32', W), [key]: 'D:\\Git' });
  });

  it.each(WINDOWS_PROGRAM_FILES_KEYS)(
    'omits non-qualified optional Windows %s without preventing startup',
    (key) => {
      for (const value of [
        'relative',
        'C:drive-relative',
        '\\rooted-only',
        '/posix',
        '\\\\server',
        '\\\\?\\C:\\device',
        '\\\\.\\C:\\device',
      ])
        expect(env('win32', { ...W, [key]: value })).toEqual(env('win32', W));
    },
  );

  it.each(WINDOWS_GIT_KEYS)(
    'omits every C0 control and DEL in optional Windows %s',
    (key) => {
      for (const code of [...Array(32).keys(), 127])
        expect(
          env('win32', { ...W, [key]: `C:\\Git${String.fromCharCode(code)}` }),
        ).toEqual(env('win32', W));
    },
  );

  it('preserves nonempty control-free overrides for selector validation without changing PATH', () => {
    for (const value of [
      'git',
      'git.exe',
      '.\\git.exe',
      'C:git.exe',
      '\\git.exe',
      '/git.exe',
      '\\\\server',
      '\\\\?\\C:\\git.exe',
      '\\\\.\\C:\\git.exe',
      '  C:\\Git\\cmd\\git.exe  ',
      'git;other',
      ' ',
    ]) {
      const source = Object.freeze({
        ...W,
        canopy_git_executable: value,
        CANOPY_GIT_EXECUTABLE: value,
        PATH: 'D:\\user-bin',
      });
      expect(env('win32', source)).toEqual({
        ...env('win32', W),
        CANOPY_GIT_EXECUTABLE: value,
      });
    }
  });

  it('drops only the unsafe discovery hint and no validation of existing keys', () => {
    const source = {
      ...WINDOWS,
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      CANOPY_GIT_EXECUTABLE: 'git\n',
    };
    expect(env('win32', source)).toEqual({
      ...env('win32', WINDOWS),
      ProgramFiles: source.ProgramFiles,
      'ProgramFiles(x86)': source['ProgramFiles(x86)'],
    });
    expect(() => env('win32', { ...source, TEMP: 'relative' })).toThrow(
      new Error('Invalid child environment TEMP'),
    );
    expect(() => env('win32', { ...source, appdata: 'D:\\Other' })).toThrow(
      new Error('Invalid child environment APPDATA'),
    );
  });

  it.each(WINDOWS_GIT_KEYS)(
    'omits conflicting case variants of optional Windows %s',
    (key) => {
      for (const value of ['D:\\other', ''])
        expect(
          env('win32', {
            ...W,
            [key]: 'C:\\Git',
            [key.toLowerCase()]: value,
          }),
        ).toEqual(env('win32', W));
    },
  );

  it.each(['darwin', 'linux'] as const)(
    '%s ignores Windows Git inputs',
    (os) => {
      for (const value of ['C:\\Git', 'relative\0']) {
        const source = {
          HOME: '/h',
          ...Object.fromEntries(WINDOWS_GIT_KEYS.map((key) => [key, value])),
        };
        expect(env(os, source)).toEqual({ HOME: '/h', PATH: POSIX_SYSTEM });
      }
    },
  );

  it.each<[Os, Source, string[], RegExp]>([
    ['darwin', {}, [], /HOME/],
    ['darwin', { HOME: '' }, [], /HOME/],
    ['darwin', { HOME: 'h' }, [], /HOME/],
    ['linux', { HOME: '/h\nsecret' }, [], /HOME/],
    ['darwin', { HOME: '/h', TMPDIR: 'tmp' }, [], /TMPDIR/],
    ['linux', { HOME: '/h', XDG_DATA_HOME: '/d\u0007' }, [], /XDG_DATA_HOME/],
    ['darwin', { HOME: '/h' }, ['bin'], /PATH entry/],
    ['linux', { HOME: '/h' }, ['/a:/b'], /PATH entry/],
    ['linux', { HOME: '/h' }, ['/a\tb'], /PATH entry/],
    ['darwin', { HOME: '/h' }, ['/a\0b'], /PATH entry/],
    ['win32', { ...W, SystemRoot: undefined }, [], /SystemRoot/],
    ['win32', { ...W, SystemRoot: '\\\\srv\\win' }, [], /SystemRoot/],
    ['win32', { ...W, SystemRoot: 'C:Windows' }, [], /SystemRoot/],
    ['win32', { ...W, SystemRoot: 'C:\\W;D:\\x' }, [], /SystemRoot/],
    ['win32', { ...W, SYSTEMROOT: 'D:\\Windows' }, [], /SystemRoot/],
    ['win32', { ...W, USERPROFILE: undefined }, [], /USERPROFILE/],
    ['win32', { ...W, USERPROFILE: '\\\\?\\C:\\u' }, [], /USERPROFILE/],
    ['win32', { ...W, APPDATA: 'r' }, [], /APPDATA/],
    ['win32', { ...W, appdata: 'C:\\other' }, [], /APPDATA/],
    ['win32', { ...W, TEMP: 'tmp' }, [], /TEMP/],
    ['win32', { ...W, TMP: 'C:\\t\r' }, [], /TMP/],
    ['win32', { ...W, LOCALAPPDATA: '\\l' }, [], /LOCALAPPDATA/],
    ['win32', W, ['shim'], /PATH entry/],
    ['win32', W, ['/usr/bin'], /PATH entry/],
    ['win32', W, ['C:\\a;C:\\b'], /PATH entry/],
  ])('%s rejects %j %j', (os, source, entries, message) => {
    const run = (): unknown => env(os, source, entries);
    expect(run).toThrow(message);
    expect(run).not.toThrow(/secret|\\\\|\//);
  });
});
