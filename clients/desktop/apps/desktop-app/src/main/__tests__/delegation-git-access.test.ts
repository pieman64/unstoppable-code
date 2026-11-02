import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  delegationGitMetadata,
  resolveDelegationGitAccess,
  type PathKind,
  linuxGitRuntime,
  windowsGitRuntime,
  windowsGitRuntimeRoots,
} from '../agents/delegation/git-access';

let fixture: string;
let cwd: string;
let common: string;
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'delegation-git-')),
  );
  cwd = path.join(fixture, 'checkout');
  common = path.join(cwd, '.git');
  await mkdir(path.join(common, 'objects'), { recursive: true });
  await mkdir(path.join(common, 'refs'));
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});
it('denies linked-worktree metadata from a normal repository checkout', async () => {
  const siblingMetadata = path.join(common, 'worktrees', 'sibling');
  await mkdir(siblingMetadata, { recursive: true });
  expect(await delegationGitMetadata(cwd)).toEqual({
    metadataRoots: [common],
    privateMetadataRoots: [path.join(common, 'worktrees')],
  });
});
it('validates a linked worktree backlink and shared metadata', async () => {
  const linked = path.join(fixture, 'linked');
  const metadata = path.join(common, 'worktrees', 'linked');
  const siblingMetadata = path.join(common, 'worktrees', 'sibling');
  await mkdir(linked);
  await mkdir(metadata, { recursive: true });
  await mkdir(siblingMetadata);
  await writeFile(path.join(linked, '.git'), `gitdir: ${metadata}\n`);
  await writeFile(path.join(metadata, 'gitdir'), path.join(linked, '.git'));
  await writeFile(path.join(metadata, 'commondir'), '../..\n');
  const resolved = await delegationGitMetadata(linked);
  expect(resolved.metadataRoots).toEqual(
    expect.arrayContaining([
      path.join(linked, '.git'),
      metadata,
      path.join(common, 'config'),
      path.join(common, 'objects'),
      path.join(common, 'refs'),
    ]),
  );
  expect(resolved.privateMetadataRoots).toEqual([]);
  expect(resolved.metadataRoots).not.toContain(common);
  if (process.platform === 'darwin' && fixture.startsWith('/private/var/')) {
    await writeFile(
      path.join(linked, '.git'),
      `gitdir: ${metadata.replace('/private/var/', '/var/')}\n`,
    );
    await writeFile(
      path.join(metadata, 'gitdir'),
      path.join(linked, '.git').replace('/private/var/', '/var/'),
    );
    const aliased = await delegationGitMetadata(linked);
    expect(aliased.metadataRoots).toEqual(
      expect.arrayContaining([
        path.join(linked, '.git'),
        metadata,
        path.join(common, 'config'),
        path.join(common, 'objects'),
        path.join(common, 'refs'),
      ]),
    );
    expect(aliased.privateMetadataRoots).toEqual([]);
  }
  await symlink(common, path.join(common, 'worktrees', 'linked-alias'));
  expect(await delegationGitMetadata(linked)).toEqual({
    metadataRoots: [],
    privateMetadataRoots: [],
  });
  await rm(path.join(common, 'worktrees', 'linked-alias'));
  await writeFile(path.join(metadata, 'gitdir'), path.join(cwd, '.git'));
  expect(await delegationGitMetadata(linked)).toEqual({
    metadataRoots: [],
    privateMetadataRoots: [],
  });
});
it('does not follow arbitrary pointers or symbolic links', async () => {
  const linked = path.join(fixture, 'linked');
  await mkdir(linked);
  await symlink(common, path.join(linked, '.git'));
  expect(await delegationGitMetadata(linked)).toEqual({
    metadataRoots: [],
    privateMetadataRoots: [],
  });
  await rm(path.join(linked, '.git'));
  await writeFile(path.join(linked, '.git'), `gitdir: ${fixture}`);
  expect(await delegationGitMetadata(linked)).toEqual({
    metadataRoots: [],
    privateMetadataRoots: [],
  });
});

describe('windowsGitRuntime', () => {
  it('maps the app-validated git.exe to its command directory and install root', () => {
    expect(windowsGitRuntime('C:\\Program Files\\Git\\cmd\\git.exe')).toEqual({
      runtimeRoot: 'C:\\Program Files\\Git',
      commandDirectory: 'C:\\Program Files\\Git\\cmd',
    });
    expect(windowsGitRuntime('C:\\Program Files\\Git\\bin\\git.exe')).toEqual({
      runtimeRoot: 'C:\\Program Files\\Git',
      commandDirectory: 'C:\\Program Files\\Git\\bin',
    });
    expect(
      windowsGitRuntime('C:\\Program Files\\Git\\mingw64\\bin\\git.exe'),
    ).toEqual({
      runtimeRoot: 'C:\\Program Files\\Git',
      commandDirectory: 'C:\\Program Files\\Git\\mingw64\\bin',
    });
  });

  it('refuses executables outside a Git for Windows layout', () => {
    for (const executable of [
      'git.exe',
      'C:\\tools\\git.exe',
      'C:\\Program Files\\Git\\cmd\\git-wrapper.exe',
      'C:\\cmd\\git.exe',
      '\\\\server\\share\\Git\\cmd\\git.exe',
      '\\Git\\cmd\\git.exe',
    ])
      expect(windowsGitRuntime(executable)).toBeUndefined();
  });
});

describe('windowsGitRuntimeRoots', () => {
  const layout =
    (entries: Record<string, PathKind>) =>
    (file: string): Promise<PathKind> =>
      Promise.resolve(entries[file.toLowerCase()]);

  it('grants a Git for Windows installation its runtime directories only', async () => {
    const root = 'C:\\Program Files\\Git';
    expect(
      await windowsGitRuntimeRoots(
        root,
        layout({
          'c:\\program files\\git\\cmd\\git.exe': 'file',
          'c:\\program files\\git\\usr': 'directory',
          'c:\\program files\\git\\mingw64': 'directory',
          'c:\\program files\\git\\bin': 'directory',
          'c:\\program files\\git\\etc': 'directory',
        }),
      ),
    ).toEqual([
      'C:\\Program Files\\Git\\cmd',
      'C:\\Program Files\\Git\\usr',
      'C:\\Program Files\\Git\\mingw64',
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\etc',
    ]);
  });

  it('refuses MSYS2 and Cygwin roots, whose home directories hold credentials', async () => {
    // C:\msys64\mingw64\bin\git.exe: MinGW runtime and usr, homes under home.
    expect(
      await windowsGitRuntimeRoots(
        'C:\\msys64',
        layout({
          'c:\\msys64\\usr': 'directory',
          'c:\\msys64\\mingw64': 'directory',
          'c:\\msys64\\home': 'directory',
        }),
      ),
    ).toBeUndefined();
    // Even with a cmd launcher, a root carrying home is refused.
    expect(
      await windowsGitRuntimeRoots(
        'C:\\msys64',
        layout({
          'c:\\msys64\\cmd\\git.exe': 'file',
          'c:\\msys64\\usr': 'directory',
          'c:\\msys64\\mingw64': 'directory',
          'c:\\msys64\\home': 'directory',
        }),
      ),
    ).toBeUndefined();
    // C:\cygwin64\bin\git.exe: no MinGW runtime and no cmd launcher.
    expect(
      await windowsGitRuntimeRoots(
        'C:\\cygwin64',
        layout({
          'c:\\cygwin64\\bin': 'directory',
          'c:\\cygwin64\\usr': 'directory',
          'c:\\cygwin64\\home': 'directory',
        }),
      ),
    ).toBeUndefined();
  });
});

describe('linuxGitRuntime', () => {
  it('accepts a locally installed system Git using the distro git-core directory', async () => {
    const binary = '/usr/local/bin/git';
    const helpers = '/usr/lib/git-core';
    expect(
      await linuxGitRuntime(
        binary,
        helpers,
        layout({
          [binary]: 'file',
          [helpers]: 'directory',
        }),
      ),
    ).toEqual({
      runtimeRoots: [binary, helpers],
      commandDirectory: '/usr/local/bin',
    });
  });

  const layout =
    (entries: Record<string, PathKind>) =>
    (file: string): Promise<PathKind> =>
      Promise.resolve(entries[file]);

  it('grants the resolved git binary and its git-core helper directory only', async () => {
    expect(
      await linuxGitRuntime(
        '/usr/bin/git',
        '/usr/lib/git-core',
        layout({
          '/usr/bin/git': 'file',
          '/usr/lib/git-core': 'directory',
        }),
      ),
    ).toEqual({
      runtimeRoots: ['/usr/bin/git', '/usr/lib/git-core'],
      commandDirectory: '/usr/bin',
    });
    // A libexec layout (e.g. Git built under /usr/libexec) is equally exact.
    expect(
      await linuxGitRuntime(
        '/usr/libexec/git-core/git',
        '/usr/libexec/git-core',
        layout({
          '/usr/libexec/git-core/git': 'file',
          '/usr/libexec/git-core': 'directory',
        }),
      ),
    ).toEqual({
      runtimeRoots: ['/usr/libexec/git-core/git', '/usr/libexec/git-core'],
      commandDirectory: '/usr/libexec/git-core',
    });
  });

  it('refuses anything that is not an exact git binary and helper directory', async () => {
    // Not an absolute POSIX path, or not named git.
    expect(
      await linuxGitRuntime('git', '/usr/lib/git-core', layout({})),
    ).toBeUndefined();
    expect(
      await linuxGitRuntime(
        '/usr/bin/git-wrapper',
        '/usr/lib/git-core',
        layout({
          '/usr/bin/git-wrapper': 'file',
          '/usr/lib/git-core': 'directory',
        }),
      ),
    ).toBeUndefined();
    // The binary must be a regular file and the exec path a directory.
    expect(
      await linuxGitRuntime(
        '/usr/bin/git',
        '/usr/lib/git-core',
        layout({
          '/usr/bin/git': 'other',
          '/usr/lib/git-core': 'directory',
        }),
      ),
    ).toBeUndefined();
    expect(
      await linuxGitRuntime(
        '/usr/bin/git',
        '/usr/lib/git-core',
        layout({
          '/usr/bin/git': 'file',
          '/usr/lib/git-core': 'file',
        }),
      ),
    ).toBeUndefined();
  });

  it('never grants a broad install prefix or a home directory', async () => {
    for (const execPath of ['/', '/usr', '/lib', '/home', '/home/dev', '/root'])
      expect(
        await linuxGitRuntime(
          '/usr/bin/git',
          execPath,
          layout({ '/usr/bin/git': 'file', [execPath]: 'directory' }),
        ),
      ).toBeUndefined();
  });

  it.each(['.ssh', '.git', '.config', '.canopy'])(
    'refuses a Git installation inside the private %s directory',
    async (privateName) => {
      const prefix = `/home/delegate/${privateName}`;
      const executable = `${prefix}/bin/git`;
      const execPath = `${prefix}/libexec/git-core`;
      expect(
        await linuxGitRuntime(
          executable,
          execPath,
          layout({ [executable]: 'file', [execPath]: 'directory' }),
        ),
      ).toBeUndefined();
    },
  );

  it('constrains the helper directory to the resolved binary installation', async () => {
    // A `<prefix>/bin/git` under /usr/local resolves to its own git-core.
    expect(
      await linuxGitRuntime(
        '/usr/local/bin/git',
        '/usr/local/lib/git-core',
        layout({
          '/usr/local/bin/git': 'file',
          '/usr/local/lib/git-core': 'directory',
        }),
      ),
    ).toEqual({
      runtimeRoots: ['/usr/local/bin/git', '/usr/local/lib/git-core'],
      commandDirectory: '/usr/local/bin',
    });
    // The exec path must be named git-core: a provider probe cannot point it
    // at an arbitrary readable folder, a private directory, or an install
    // prefix whose segment count alone would otherwise pass.
    for (const execPath of [
      '/usr/local',
      '/home/dev/.ssh',
      '/home/dev/project/.git',
      '/usr/lib',
      '/usr/lib/git-core/templates',
    ])
      expect(
        await linuxGitRuntime(
          '/usr/bin/git',
          execPath,
          layout({ '/usr/bin/git': 'file', [execPath]: 'directory' }),
        ),
      ).toBeUndefined();
    // git-core, but not under lib/libexec, and not tied to the binary prefix.
    expect(
      await linuxGitRuntime(
        '/usr/bin/git',
        '/home/dev/git-core',
        layout({ '/usr/bin/git': 'file', '/home/dev/git-core': 'directory' }),
      ),
    ).toBeUndefined();
    expect(
      await linuxGitRuntime(
        '/usr/bin/git',
        '/opt/lib/git-core',
        layout({ '/usr/bin/git': 'file', '/opt/lib/git-core': 'directory' }),
      ),
    ).toBeUndefined();
  });
});

// Always exercises Linux resolution on supported test hosts, without needing
// a Linux binary. Regression: the former platform exclusion skipped the
// canonical executable resolver entirely.
describe('resolveDelegationGitAccess on a simulated Linux host', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
  });
  afterEach(() => {
    if (originalPlatform)
      Object.defineProperty(process, 'platform', originalPlatform);
  });
  (hostOperatingSystem() === 'win32' ? it.skip : it)(
    'resolves a validated Linux installation through its clean probe',
    async () => {
      const binary = path.join(fixture, 'installation', 'bin', 'git');
      const helpers = path.join(fixture, 'installation', 'lib', 'git-core');
      await mkdir(path.dirname(binary), { recursive: true });
      await mkdir(helpers, { recursive: true });
      await writeFile(
        binary,
        [
          '#!/bin/sh',
          '[ "$1" = "--exec-path" ] && [ "$#" -eq 1 ] || exit 7',
          '[ "$PWD" = "/" ] || exit 7',
          '[ -z "${GIT_EXEC_PATH-}" ] && [ -z "${GIT_CONFIG_SYSTEM-}" ] || exit 7',
          '[ "${GIT_CONFIG_GLOBAL-}" = "/dev/null" ] && [ "${GIT_CONFIG_NOSYSTEM-}" = "1" ] || exit 7',
          'cd "$(dirname "$0")/../lib/git-core" || exit 7',
          'pwd -P',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      expect(await linuxGitRuntime(binary, helpers)).toEqual({
        runtimeRoots: [binary, helpers],
        commandDirectory: path.dirname(binary),
      });
      const ambient = {
        GIT_EXEC_PATH: process.env.GIT_EXEC_PATH,
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      };
      try {
        process.env.GIT_EXEC_PATH = '/hostile/git-core';
        process.env.GIT_CONFIG_GLOBAL = '/hostile/gitconfig';
        process.env.GIT_CONFIG_SYSTEM = '/hostile/gitconfig';
        const access = await resolveDelegationGitAccess(cwd, undefined, () =>
          Promise.resolve(binary),
        );
        expect(access.runtimeRoots).toEqual([binary, helpers]);
        expect(access.metadataRoots).toContain(common);
      } finally {
        for (const [key, value] of Object.entries(ambient))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    },
  );
  it('routes Linux through the canonical git executable resolver', async () => {
    const resolveGit = jest.fn(() => Promise.resolve('/missing/validated/git'));
    const access = await resolveDelegationGitAccess(cwd, undefined, resolveGit);
    // Linux must reach the canonical resolver before validating the binary.
    expect(resolveGit).toHaveBeenCalled();
    // An absent validated binary still fails closed to no runtime access.
    expect(access.runtimeRoots).toEqual([]);
    expect(access.commandDirectories).toEqual([]);
  });
});

const onWindows = hostOperatingSystem() === 'win32' ? it : it.skip;
onWindows(
  'grants the Codex worker the resolved Git for Windows installation',
  async () => {
    const executable = (
      await promisify(execFile)('where.exe', ['git'], { timeout: 10_000 })
    ).stdout
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().endsWith('git.exe'));
    if (!executable) throw new Error('Git for Windows is required on Windows');
    const access = await resolveDelegationGitAccess(cwd, undefined, () =>
      Promise.resolve(executable),
    );
    const runtime = windowsGitRuntime(await realpath(executable));
    expect(access.metadataRoots).toContain(common);
    expect(access.commandDirectories).toEqual([runtime?.commandDirectory]);
    // Runtime subdirectories only: never the installation root or a home.
    expect(access.runtimeRoots).toContain(
      path.join(runtime?.runtimeRoot ?? '', 'usr'),
    );
    expect(access.runtimeRoots).not.toContain(runtime?.runtimeRoot);
    expect(
      access.runtimeRoots.some((root) => /[\\/]home([\\/]|$)/i.test(root)),
    ).toBe(false);
  },
);

const onLinux = hostOperatingSystem() === 'linux' ? it : it.skip;
onLinux(
  'grants the Codex worker the resolved git binary and its git-core helpers',
  async () => {
    const execute = promisify(execFile);
    // Resolve the real binary and git-core helper directory under a clean env
    // first, so the probe-security check below compares against the truth.
    const binary = await realpath(
      (
        await execute('/usr/bin/env', ['which', 'git'], { timeout: 10_000 })
      ).stdout.trim(),
    );
    const execPath = await realpath(
      (
        await execute(binary, ['--exec-path'], { timeout: 10_000 })
      ).stdout.trim(),
    );
    const access = await resolveDelegationGitAccess(cwd, undefined, () =>
      Promise.resolve(binary),
    );
    expect(access.metadataRoots).toContain(common);
    expect(access.commandDirectories).toEqual([path.dirname(binary)]);
    // Exact binary and helper directory only: never the install prefix.
    expect(access.runtimeRoots).toEqual(
      expect.arrayContaining([binary, execPath]),
    );
    expect(access.runtimeRoots).not.toContain('/usr');
    expect(access.runtimeRoots).not.toContain('/');
    expect(
      access.runtimeRoots.some((root) => /^\/home(\/|$)|^\/root$/.test(root)),
    ).toBe(false);
  },
);
onLinux(
  'resolves git-core with a bounded clean env, ignoring a hostile ambient one',
  async () => {
    const execute = promisify(execFile);
    const binary = await realpath(
      (
        await execute('/usr/bin/env', ['which', 'git'], { timeout: 10_000 })
      ).stdout.trim(),
    );
    const execPath = await realpath(
      (
        await execute(binary, ['--exec-path'], { timeout: 10_000 })
      ).stdout.trim(),
    );
    const saved = {
      GIT_EXEC_PATH: process.env.GIT_EXEC_PATH,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
    };
    try {
      // A hostile ambient environment must not steer the probe: a forged
      // GIT_EXEC_PATH would otherwise make `git --exec-path` echo it back,
      // and a planted config could run arbitrary commands.
      process.env.GIT_EXEC_PATH = '/tmp/evil-git-core';
      process.env.GIT_CONFIG_GLOBAL = '/tmp/evil-gitconfig';
      process.env.GIT_CONFIG_SYSTEM = '/tmp/evil-gitconfig';
      const access = await resolveDelegationGitAccess(cwd, undefined, () =>
        Promise.resolve(binary),
      );
      expect(access.runtimeRoots).toContain(execPath);
      expect(access.runtimeRoots).not.toContain('/tmp/evil-git-core');
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  },
);
