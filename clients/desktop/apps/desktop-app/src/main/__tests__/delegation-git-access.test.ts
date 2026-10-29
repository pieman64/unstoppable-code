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
import {
  delegationGitMetadata,
  resolveDelegationGitAccess,
  type PathKind,
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

const onWindows = process.platform === 'win32' ? it : it.skip;
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
