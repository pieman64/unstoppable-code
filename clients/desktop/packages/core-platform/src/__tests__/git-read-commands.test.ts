import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEnvVars } from '@canopy/desktop-shared/lib/mcp-security';
import { getLinuxProbeEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import {
  bareInitEnvironment,
  type GitReadCommand,
  linuxProbeEnvironment,
  planGitReadCommand,
  windowsChildEnvironment,
} from '../git-read/commands';

const ENV = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/home/u',
  SHELL: '/bin/fish',
  GIT_DIR: '/elsewhere',
  NODE_OPTIONS: '--require x',
  ld_preload: 'x.so',
  DYLD_FALLBACK_LIBRARY_PATH: '/x',
  BASH_FUNC_f: '() { :; }',
  BASH_ENV: '/x',
  Env: '/x',
  shellopts: 'x',
  BASHOPTS: 'x',
  GCONV_PATH: '/x',
  GLIBC_TUNABLES: 'x',
  PYTHONPATH: '/x',
  pythonstartup: '/x',
  NODE_PATH: '/x',
  LANG: 'C',
});
const PROBE_ENV = { PATH: '/usr/bin', HOME: '/home/u', SHELL: '/bin/fish', GIT_DIR: '/elsewhere', LANG: 'C' }; // prettier-ignore
// `PATH` sorts before `Path`, so Node keeps `PATH` and drops `Path`.
const WIN_ENV = Object.freeze({
  SystemRoot: 'C:\\Windows',
  Path: 'C:\\Dropped',
  PATH: 'C:\\Git\\cmd;C:\\Windows\\System32',
  HOME: 'C:\\h',
  TEMP: '',
});
/** libuv's required keys the block lacks are added empty (D1). */
const WIN_CHILD_ENV = {
  SystemRoot: 'C:\\Windows',
  PATH: 'C:\\Git\\cmd;C:\\Windows\\System32',
  HOME: 'C:\\h',
  TEMP: '',
  HOMEDRIVE: '',
  HOMEPATH: '',
  LOGONSERVER: '',
  SYSTEMDRIVE: '',
  USERDOMAIN: '',
  USERNAME: '',
  USERPROFILE: '',
  WINDIR: '',
};
const MiB = 1024 * 1024;
const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};
const git = '/opt/git';

type Row = [
  GitReadCommand,
  file: string,
  args: string[],
  maxBuffer: number,
  timeoutMs: number | undefined,
  killMode: 'graceful' | 'force',
  env: Readonly<Record<string, string>>,
];

/** Desktop's values: git-executable.ts, config-paths.ts and git.ts:1535–1586. */
const input = new Uint8Array([0x61, 0, 0xff, 0]);
const TABLE: Record<'darwin' | 'linux' | 'win32', Row[]> = {
  darwin: [
    [{ kind: 'git-version', executable: git }, git, ['--version'], MiB, 5000, 'graceful', ENV], // prettier-ignore
    [{ kind: 'git-check-ignore', executable: 'git', input }, 'git', ['check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'xcode-select-print-path' }, '/usr/bin/xcode-select', ['--print-path'], 4096, 5000, 'graceful', ENV], // prettier-ignore
    [{ kind: 'macos-login-shell-path' }, '/bin/fish', ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'], MiB, 10_000, 'force', ENV], // prettier-ignore
  ],
  linux: [
    [{ kind: 'git-version', executable: git }, git, ['--version'], MiB, 5000, 'force', PROBE_ENV], // prettier-ignore
    [{ kind: 'git-check-ignore', executable: 'git', input }, 'git', ['check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', ENV], // prettier-ignore
    [{ kind: 'linux-login-shell-path', shell: '/bin/bash' }, '/bin/bash', ['-lic', 'exec /usr/bin/printf \'__CANOPY_LOGIN_PATH__%s\\n\' "$PATH"'], 64 * 1024, 10_000, 'force', PROBE_ENV], // prettier-ignore
    [{ kind: 'getent-passwd', uid: 501 }, '/usr/bin/getent', ['passwd', '501'], 16 * 1024, 1000, 'force', PROBE_ENV], // prettier-ignore
  ],
  win32: [
    [{ kind: 'git-version', executable: 'C:\\Git\\cmd\\git.exe' }, 'C:\\Git\\cmd\\git.exe', ['--version'], MiB, 5000, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    [{ kind: 'git-check-ignore', executable: 'git.exe', input }, 'git.exe', ['check-ignore', '-z', '--stdin'], 8 * MiB, undefined, 'graceful', WIN_CHILD_ENV], // prettier-ignore
    // The runner resolves a bare name through the supplied PATH alone (D2).
    [{ kind: 'where-git' }, 'where.exe', ['git'], MiB, 5000, 'graceful', WIN_CHILD_ENV], // prettier-ignore
  ],
};

describe.each(Object.keys(TABLE) as (keyof typeof TABLE)[])(
  '%s command table',
  (os) => {
    it.each(TABLE[os].map((row) => [row[0].kind, row] as const))(
      '%s',
      (_, [command, file, args, maxBuffer, timeoutMs, killMode, env]) => {
        const plan = planGitReadCommand(
          os,
          command,
          os === 'win32' ? WIN_ENV : ENV,
        );
        expect(plan).toEqual({
          file,
          args,
          env,
          maxBuffer,
          timeoutMs,
          killMode,
          input: command.kind === 'git-check-ignore' ? input : undefined,
        });
        expect(Object.isFrozen(plan.env)).toBe(true);
      },
    );

    it('rejects every command outside its host', () => {
      const listed = new Set(TABLE[os].map(([command]) => command.kind));
      if (os === 'darwin') listed.add('git-bare-init-smoke');
      const all: GitReadCommand[] = [
        { kind: 'git-version', executable: git },
        { kind: 'git-bare-init-smoke', executable: git, temporaryRoot: '/t' },
        { kind: 'git-check-ignore', executable: git, input },
        { kind: 'xcode-select-print-path' },
        { kind: 'macos-login-shell-path' },
        { kind: 'linux-login-shell-path', shell: '/bin/bash' },
        { kind: 'getent-passwd', uid: 1 },
        { kind: 'where-git' },
      ];
      for (const command of all.filter(({ kind }) => !listed.has(kind)))
        expect(
          thrown(
            () =>
            planGitReadCommand(os, command, os === 'win32' ? WIN_ENV : ENV, '/t/x'), // prettier-ignore
          ),
        ).toMatchObject({ code: 'unsupported_command' });
    });
  },
);

describe('command inputs', () => {
  it('builds the macOS bare-init smoke against a scratch directory', () => {
    const command = {
      kind: 'git-bare-init-smoke',
      executable: git,
      temporaryRoot: '/tmp',
    } as const;
    const plan = planGitReadCommand('darwin', command, ENV, '/tmp/git-v-1');
    expect(plan).toMatchObject({
      file: git,
      args: ['-c', 'init.templateDir=', 'init', '--bare', '/tmp/git-v-1'],
      maxBuffer: 8192,
      timeoutMs: 5000,
      killMode: 'graceful',
    });
    expect(plan.env).toEqual(bareInitEnvironment(ENV));
    expect(() => planGitReadCommand('darwin', command, ENV)).toThrow(
      'Git read request is invalid.',
    );
  });

  it('falls back to /bin/zsh for an unset or empty macOS SHELL', () => {
    const command = { kind: 'macos-login-shell-path' } as const;
    const envs: Record<string, string>[] = [{}, { SHELL: '' }];
    for (const env of envs)
      expect(planGitReadCommand('darwin', command, env).file).toBe('/bin/zsh');
  });

  it.each<[string, GitReadCommand]>([
    ['empty executable', { kind: 'git-version', executable: '' }],
    ['NUL executable', { kind: 'git-version', executable: 'g\0it' }],
    ['relative shell', { kind: 'linux-login-shell-path', shell: 'bash' }],
    ['newline shell', { kind: 'linux-login-shell-path', shell: '/bin/b\nsh' }],
    ['negative uid', { kind: 'getent-passwd', uid: -1 }],
    ['fractional uid', { kind: 'getent-passwd', uid: 1.5 }],
  ])('rejects %s', (_, command) => {
    expect(thrown(() => planGitReadCommand('linux', command, ENV))).toMatchObject({ code: 'invalid_request' }); // prettier-ignore
  });
});

// Spawn resolves a relative command against the cwd, and without PATH through
// the host's PATH (Windows) or a fixed default (POSIX). D2: only a bare name,
// searched on the supplied PATH by the runner.
describe('relative command resolution', () => {
  const where = { kind: 'where-git' } as const;
  const relativeGit = (executable: string): GitReadCommand => ({
    kind: 'git-check-ignore',
    executable,
    input,
  });
  const WIN = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' };

  it.each<
    [
      string,
      'darwin' | 'linux' | 'win32',
      GitReadCommand,
      Record<string, string>,
    ]
  >([
    ['bare where.exe without PATH', 'win32', where, { SystemRoot: 'C:\\Windows' }], // prettier-ignore
    ['bare where.exe with an empty PATH', 'win32', where, { SystemRoot: 'C:\\Windows', Path: '' }], // prettier-ignore
    // Node keeps the first key in sort order: `PATH` precedes `Path`.
    ['bare where.exe whose kept PATH is empty', 'win32', where, { SystemRoot: 'C:\\Windows', Path: 'C:\\Git\\cmd', PATH: '' }], // prettier-ignore
    ['bare where.exe whose PATH has only relative entries', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: 'bin;.;C:relative' }], // prettier-ignore
    ['a relative Windows git without PATH', 'win32', relativeGit('git.exe'), { SystemRoot: 'C:\\Windows', HOME: 'C:\\h' }], // prettier-ignore
    ['a drive-relative Windows git', 'win32', relativeGit('C:git.exe'), WIN],
    ['a rooted Windows git without a drive', 'win32', relativeGit('\\Git\\git.exe'), WIN], // prettier-ignore
    ['a dot-relative Windows git', 'win32', relativeGit('.\\git.exe'), WIN],
    ['a Windows git in a subdirectory', 'win32', relativeGit('sub\\git.exe'), WIN], // prettier-ignore
    ['a forward-slash Windows git in a subdirectory', 'win32', relativeGit('sub/git.exe'), WIN], // prettier-ignore
    ['a relative macOS git without PATH', 'darwin', relativeGit('git'), { HOME: '/h' }], // prettier-ignore
    ['a relative Linux git with an empty PATH', 'linux', { kind: 'git-version', executable: 'git' }, { PATH: '' }], // prettier-ignore
    // Empty and relative entries name the cwd.
    ['a relative Linux git whose PATH has only empty and relative entries', 'linux', relativeGit('git'), { PATH: ':bin:.' }], // prettier-ignore
    // POSIX keys are case-sensitive.
    ['a relative Linux git with only a lowercase path', 'linux', relativeGit('git'), { path: '/usr/bin' }], // prettier-ignore
    ['a dot-relative Linux git', 'linux', relativeGit('./git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a Linux git in a subdirectory', 'linux', relativeGit('bin/git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a parent-directory Linux git', 'linux', relativeGit('..'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a relative macOS SHELL without PATH', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'zsh' }], // prettier-ignore
    ['a macOS SHELL in a subdirectory', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'bin/zsh', PATH: '/bin' }], // prettier-ignore
    ['a relative bare-init git without PATH', 'darwin', { kind: 'git-bare-init-smoke', executable: 'git', temporaryRoot: '/t' }, {}], // prettier-ignore
  ])('rejects %s', (_, os, command, env) => {
    expect(
      thrown(() => planGitReadCommand(os, command, env, '/t/x')),
    ).toMatchObject({ code: 'invalid_request' });
  });

  it.each<
    [
      string,
      'darwin' | 'linux' | 'win32',
      GitReadCommand,
      Record<string, string>,
    ]
  >([
    ['bare where.exe with a mixed-case Path', 'win32', where, { SystemRoot: 'C:\\Windows', Path: 'C:\\Git\\cmd' }], // prettier-ignore
    ['bare where.exe whose kept PATH is set', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: 'C:\\Git\\cmd', Path: '' }], // prettier-ignore
    ['bare where.exe on a quoted PATH entry', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: '"C:\\Program Files\\Git\\cmd"' }], // prettier-ignore
    ['bare where.exe on a quoted PATH entry containing ;', 'win32', where, { SystemRoot: 'C:\\Windows', PATH: '"C:\\Git;cmd"' }], // prettier-ignore
    ['a bare Windows git', 'win32', relativeGit('git'), WIN],
    ['an absolute Windows git', 'win32', { kind: 'git-version', executable: 'C:\\Git\\cmd\\git.exe' }, WIN], // prettier-ignore
    ['a UNC Windows git', 'win32', relativeGit('\\\\server\\share\\git.exe'), WIN], // prettier-ignore
    ['an absolute Linux git without PATH', 'linux', { kind: 'git-version', executable: '/usr/bin/git' }, {}], // prettier-ignore
    ['the fixed macOS probes without PATH', 'darwin', { kind: 'xcode-select-print-path' }, {}], // prettier-ignore
    ['getent without PATH', 'linux', { kind: 'getent-passwd', uid: 1 }, {}],
    ['a relative Linux git with PATH', 'linux', relativeGit('git'), { PATH: '/usr/bin' }], // prettier-ignore
    ['a relative Linux git whose PATH has one absolute entry', 'linux', relativeGit('git'), { PATH: ':bin:/usr/bin' }], // prettier-ignore
    ['a bare macOS SHELL with PATH', 'darwin', { kind: 'macos-login-shell-path' }, { SHELL: 'zsh', PATH: '/bin' }], // prettier-ignore
  ])('plans %s', (_, os, command, env) => {
    expect(() => planGitReadCommand(os, command, env, '/t/x')).not.toThrow();
  });
});

// D1: libuv copies each required key a Windows block lacks from the host.
describe('Windows child environment', () => {
  const absoluteGit = {
    kind: 'git-version',
    executable: 'C:\\Git\\cmd\\git.exe',
  } as const;

  it('adds each absent libuv-required key empty and keeps the supplied values', () => {
    expect(windowsChildEnvironment(WIN_ENV)).toEqual(WIN_CHILD_ENV);
    expect(Object.isFrozen(windowsChildEnvironment(WIN_ENV))).toBe(true);
  });

  it('matches keys case-insensitively and keeps the variant Node keeps', () => {
    const child = windowsChildEnvironment({
      systemroot: 'C:\\Win',
      windir: 'C:\\Win',
      Path: 'C:\\Git',
      PATH: 'C:\\Kept',
      temp: 'C:\\b',
      TEMP: 'C:\\a',
    });
    expect(child).toEqual({
      systemroot: 'C:\\Win',
      windir: 'C:\\Win',
      PATH: 'C:\\Kept',
      TEMP: 'C:\\a',
      HOMEDRIVE: '',
      HOMEPATH: '',
      LOGONSERVER: '',
      SYSTEMDRIVE: '',
      USERDOMAIN: '',
      USERNAME: '',
      USERPROFILE: '',
    });
  });

  it.each<[string, Record<string, string>]>([
    ['no PATH', { SystemRoot: 'C:\\Windows' }],
    ['an empty PATH', { SystemRoot: 'C:\\Windows', PATH: '' }],
    ['a PATH of only relative entries', { SystemRoot: 'C:\\Windows', PATH: 'bin;;C:rel' }], // prettier-ignore
    ['an empty kept PATH variant', { SystemRoot: 'C:\\Windows', PATH: '', Path: 'C:\\Git' }], // prettier-ignore
    // libuv reads one relative entry, `bin;C:\Git`, from the quotes.
    ['a PATH whose only absolute text is inside a quoted relative entry', { SystemRoot: 'C:\\Windows', PATH: '"bin;C:\\Git"' }], // prettier-ignore
    ['no SystemRoot', { PATH: 'C:\\Windows\\System32' }],
    ['an empty SystemRoot', { SystemRoot: '', PATH: 'C:\\Windows\\System32' }],
    ['a relative SystemRoot', { SystemRoot: 'Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a forward-slash SystemRoot', { SystemRoot: 'C:/Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a UNC SystemRoot', { SystemRoot: '\\\\server\\Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    ['a SystemRoot with a control character', { SystemRoot: 'C:\\Win\ndows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
    // `SYSTEMROOT` precedes `SystemRoot`: the child would see an empty value.
    ['an empty kept SystemRoot variant', { SYSTEMROOT: '', SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }], // prettier-ignore
  ])('rejects %s, even for an absolute command', (_, env) => {
    expect(thrown(() => windowsChildEnvironment(env))).toMatchObject({
      code: 'invalid_request',
    });
    expect(
      thrown(() => planGitReadCommand('win32', absoluteGit, env)),
    ).toMatchObject({ code: 'invalid_request' });
  });

  it('leaves POSIX environments as supplied', () => {
    const env = { PATH: '/usr/bin' };
    const command = { kind: 'git-version', executable: '/usr/bin/git' } as const; // prettier-ignore
    expect(planGitReadCommand('darwin', command, env).env).toBe(env);
  });
});

describe('environments', () => {
  it('bare-init drops GIT_* and pins isolated config', () => {
    expect(
      bareInitEnvironment({ GIT_DIR: '/x', git_dir: '/y', HOME: '/h' }),
    ).toEqual({
      git_dir: '/y',
      HOME: '/h',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  // Golden (C3): the daemon cannot import desktop-shared, so pin parity here.
  it('matches desktop getLinuxProbeEnv and sanitizeEnvVars', () => {
    const saved = process.env;
    process.env = { ...ENV };
    try {
      expect(linuxProbeEnvironment(ENV)).toEqual(getLinuxProbeEnv());
    } finally {
      process.env = saved;
    }
    expect(linuxProbeEnvironment(ENV)).toEqual(PROBE_ENV);
    const blocked = Object.fromEntries(
      ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'PYTHONSTARTUP', 'PYTHONPATH', 'KEEP'] // prettier-ignore
        .flatMap((key) => [key, key.toLowerCase()])
        .map((key) => [key, 'x']),
    );
    const desktop = sanitizeEnvVars(blocked);
    expect(desktop).toEqual({ KEEP: 'x', keep: 'x' });
    expect(linuxProbeEnvironment(blocked)).toEqual(desktop);
  });

  /** String literals of the first `[...]` after `anchor` in a desktop-shared source. */
  function desktopKeys(file: string, anchor: string): string[] {
    const source = readFileSync(
      join(__dirname, '../../../desktop-shared/src', file),
      'utf8',
    );
    const open = source.indexOf('[', source.indexOf(anchor));
    const list = source.slice(open, source.indexOf(']', open));
    return Array.from(list.matchAll(/'([^']+)'/g), ([, key = '']) => key);
  }

  // A key desktop adds to either list must fail here until it is mirrored.
  it('drops every key desktop drops, read from desktop source', () => {
    const blocked = desktopKeys('lib/mcp-security.ts', 'BLOCKED_ENV_KEYS =');
    const startup = desktopKeys(
      'pipelines/config-paths.ts',
      "startsWith('BASH_FUNC_')",
    );
    expect(blocked).toContain('NODE_OPTIONS');
    expect(startup).toContain('GLIBC_TUNABLES');
    const env = Object.fromEntries(
      [...blocked, ...startup, 'KEEP']
        .flatMap((key) => [key, key.toLowerCase()])
        .map((key) => [key, 'x']),
    );
    const saved = process.env;
    process.env = { ...env };
    try {
      const desktop = getLinuxProbeEnv();
      expect(desktop).toEqual({ KEEP: 'x', keep: 'x' });
      expect(linuxProbeEnvironment(env)).toEqual(desktop);
    } finally {
      process.env = saved;
    }
  });
});
