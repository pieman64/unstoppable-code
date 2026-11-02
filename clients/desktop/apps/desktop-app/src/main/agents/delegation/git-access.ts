import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { delegationToolchainReadRoots } from '@canopy/desktop-shared/node/delegation/command-environment';
import {
  getCanopyDataDir,
  getCanopySecureDataDir,
} from '@canopy/desktop-shared/canopy-paths';
import { getResolvedGitExecutableForSpawn } from '../../lib/git-executable';

const execute = promisify(execFile);
const LINKED_COMMON_METADATA_NAMES = [
  'HEAD',
  'branches',
  'config',
  'config.worktree',
  'description',
  'hooks',
  'info',
  'logs',
  'objects',
  'packed-refs',
  'refs',
  'rr-cache',
  'shallow',
] as const;
export interface DelegationGitAccess {
  readonly metadataRoots: readonly string[];
  readonly privateMetadataRoots: readonly string[];
  readonly runtimeRoots: readonly string[];
  readonly commandDirectories: readonly string[];
}
async function smallFile(file: string): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw new Error('Invalid Git metadata pointer');
  return (await readFile(file, 'utf8')).trim();
}
/** Windows paths compare case-insensitively; POSIX paths compare exactly. */
function samePath(left: string, right: string): boolean {
  return hostOperatingSystem() === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
async function canonicalDirectory(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  const systemPath =
    hostOperatingSystem() === 'darwin'
      ? directory.replace(/^\/(var|tmp|etc)(?=\/|$)/, '/private/$1')
      : directory;
  if (
    !samePath(canonical, systemPath) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error('Git metadata must use a canonical directory');
  return canonical;
}
/** Resolve metadata without executing repository-controlled Git configuration. */
export async function delegationGitMetadata(
  cwd: string,
): Promise<
  Pick<DelegationGitAccess, 'metadataRoots' | 'privateMetadataRoots'>
> {
  const root = await realpath(cwd);
  const dotGit = path.join(root, '.git');
  try {
    const stat = await lstat(dotGit);
    if (stat.isSymbolicLink())
      return { metadataRoots: [], privateMetadataRoots: [] };
    let common: string;
    let selectedWorktreeMetadata: string | undefined;
    if (stat.isDirectory()) common = await canonicalDirectory(dotGit);
    else {
      const pointer = await smallFile(dotGit);
      if (!pointer.startsWith('gitdir: '))
        return { metadataRoots: [], privateMetadataRoots: [] };
      const directory = await canonicalDirectory(
        path.resolve(root, pointer.slice(8)),
      );
      selectedWorktreeMetadata = directory;
      common = await canonicalDirectory(
        path.resolve(
          directory,
          await smallFile(path.join(directory, 'commondir')),
        ),
      );
      if (
        path.basename(common) !== '.git' ||
        path.dirname(directory) !== path.join(common, 'worktrees') ||
        !samePath(
          await realpath(
            path.resolve(
              directory,
              await smallFile(path.join(directory, 'gitdir')),
            ),
          ),
          dotGit,
        )
      )
        return { metadataRoots: [], privateMetadataRoots: [] };
    }
    for (const name of ['objects', 'refs'])
      await canonicalDirectory(path.join(common, name));
    const metadataRoots = [dotGit];
    if (selectedWorktreeMetadata) {
      metadataRoots.push(selectedWorktreeMetadata);
      // Never grant the common directory itself from a linked checkout: doing
      // so would also grant linked-worktree admin directories created after
      // this snapshot. Grant the stable non-worktree Git namespaces instead.
      metadataRoots.push(
        ...LINKED_COMMON_METADATA_NAMES.map((name) => path.join(common, name)),
      );
    } else {
      metadataRoots.push(common);
    }
    const privateMetadataRoots: string[] = [];
    const worktrees = path.join(common, 'worktrees');
    // A primary checkout inherits its own `.git` tree through the workspace
    // read grant, so deny the collection root itself. This also covers sibling
    // admin directories created after delegated thread preparation. A linked
    // checkout receives no common-root grant and needs no overlapping deny.
    if (!selectedWorktreeMetadata) privateMetadataRoots.push(worktrees);
    let worktreesPresent = true;
    try {
      const worktreesStat = await lstat(worktrees);
      if (!worktreesStat.isDirectory() || worktreesStat.isSymbolicLink())
        throw new Error('Invalid linked-worktree collection');
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        worktreesPresent = false;
      else throw error;
    }
    if (worktreesPresent) {
      for (const entry of await readdir(worktrees, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new Error('Invalid linked-worktree metadata');
        await canonicalDirectory(path.join(worktrees, entry.name));
      }
    }
    return {
      metadataRoots: Array.from(new Set(metadataRoots)),
      privateMetadataRoots,
    };
  } catch {
    return { metadataRoots: [], privateMetadataRoots: [] };
  }
}
const NO_GIT_ACCESS: DelegationGitAccess = {
  metadataRoots: [],
  privateMetadataRoots: [],
  runtimeRoots: [],
  commandDirectories: [],
};

/** Git for Windows layout for the app's validated `git.exe`: the command
 * directory holding it (`cmd` or `bin`), and the installation root that its
 * launcher reaches (`mingw64`/`clangarm64`, `usr`, `libexec`). */
export function windowsGitRuntime(
  executable: string,
): { runtimeRoot: string; commandDirectory: string } | undefined {
  const win = path.win32;
  // Local drive paths only: no UNC, device or drive-relative locations.
  if (
    !/^[A-Za-z]:\\/.test(executable) ||
    win.basename(executable).toLowerCase() !== 'git.exe'
  )
    return undefined;
  const commandDirectory = win.dirname(executable);
  const leaf = win.basename(commandDirectory).toLowerCase();
  if (leaf !== 'cmd' && leaf !== 'bin') return undefined;
  let runtimeRoot = win.dirname(commandDirectory);
  // <root>\mingw64\bin\git.exe is the real binary behind <root>\cmd\git.exe.
  if (
    leaf === 'bin' &&
    ['mingw64', 'mingw32', 'clangarm64'].includes(
      win.basename(runtimeRoot).toLowerCase(),
    )
  )
    runtimeRoot = win.dirname(runtimeRoot);
  if (
    runtimeRoot === commandDirectory ||
    win.dirname(runtimeRoot) === runtimeRoot
  )
    return undefined;
  return { runtimeRoot, commandDirectory };
}

export type PathKind = 'file' | 'directory' | 'other' | undefined;

async function pathKind(file: string): Promise<PathKind> {
  try {
    const stat = await lstat(file);
    return stat.isSymbolicLink()
      ? 'other'
      : stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'other';
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return undefined;
    throw error;
  }
}

/** Read grants for a Git for Windows installation, or undefined when the root
 * is not one. Only the runtime directories the launcher needs are granted,
 * never the root: MSYS2 and Cygwin also ship `usr`, `bin` and a `git.exe`, but
 * keep users' homes (with `.ssh`, `.git-credentials`, `.netrc`) under
 * `<root>\home`, so a root carrying `home` is refused. Git for Windows is
 * identified by its `cmd\git.exe` launcher plus a MinGW runtime. */
export async function windowsGitRuntimeRoots(
  runtimeRoot: string,
  kind: (file: string) => Promise<PathKind> = pathKind,
): Promise<string[] | undefined> {
  const win = path.win32;
  const at = (...parts: string[]): string => win.join(runtimeRoot, ...parts);
  const mingw: string[] = [];
  for (const name of ['mingw64', 'clangarm64', 'mingw32'])
    if ((await kind(at(name))) === 'directory') mingw.push(at(name));
  if (
    (await kind(at('cmd', 'git.exe'))) !== 'file' ||
    (await kind(at('usr'))) !== 'directory' ||
    !mingw.length ||
    (await kind(at('home'))) !== undefined
  )
    return undefined;
  const roots = [at('cmd'), at('usr'), ...mingw];
  for (const name of ['bin', 'etc'])
    if ((await kind(at(name))) === 'directory') roots.push(at(name));
  return roots;
}

/** POSIX roots too broad to grant as a Git runtime read: the filesystem root,
 * a single top-level directory (`/usr`, `/lib`, `/opt`, `/home`), or a bare
 * home directory (`/home/<user>`, `/root`). The delegate must receive the
 * exact git-core helper directory, never an install prefix or a home. */
function linuxGrantTooBroad(directory: string): boolean {
  const segments = directory.split('/').filter(Boolean);
  if (segments.length < 2) return true;
  if (segments[0] === 'home' && segments.length < 3) return true;
  return false;
}

/** Read grants for a resolved Linux `git` binary: the exact binary file, its
 * command directory (used only for PATH), and the git-core helper directory
 * reported by a bounded `git --exec-path`. The helper directory must be the
 * binary's own `<prefix>/{lib,libexec}/git-core`, or the distro's fixed `/usr`
 * helper directory for `/usr/local/bin/git`, so a repository-controlled
 * probe cannot expand reads into an arbitrary folder, a private directory, a
 * metadata root, or an install prefix. Apart from that fixed system layout,
 * the binary is either in `<prefix>/bin` alongside the helper directory, or
 * inside the helper directory itself.
 * Undefined for anything else. */
export async function linuxGitRuntime(
  executable: string,
  execPath: string,
  kind: (file: string) => Promise<PathKind> = pathKind,
): Promise<{ runtimeRoots: string[]; commandDirectory: string } | undefined> {
  const posix = path.posix;
  if (
    !posix.isAbsolute(executable) ||
    !posix.isAbsolute(execPath) ||
    posix.basename(executable) !== 'git' ||
    posix.basename(execPath) !== 'git-core' ||
    linuxGrantTooBroad(execPath)
  )
    return undefined;
  // The helper directory is <prefix>/lib/git-core or <prefix>/libexec/git-core.
  const helperParent = posix.dirname(execPath);
  const helperParentName = posix.basename(helperParent);
  if (helperParentName !== 'lib' && helperParentName !== 'libexec')
    return undefined;
  // The binary sits in <prefix>/bin beside that helper directory, or is one of
  // the helper programs inside it. Either way it shares the install prefix, so
  // the grant cannot be redirected to an unrelated git-core-named directory.
  const commandDirectory = posix.dirname(executable);
  const binaryInsideHelper = commandDirectory === execPath;
  const binaryBesideHelper =
    posix.basename(commandDirectory) === 'bin' &&
    posix.dirname(commandDirectory) === posix.dirname(helperParent);
  // Hosted Ubuntu runners also install Git in /usr/local/bin while keeping
  // the distro's fixed /usr helper path. Admit only those exact system paths,
  // without granting either installation prefix or arbitrary cross-prefixes.
  const localSystemBinaryWithDistroHelpers =
    executable === '/usr/local/bin/git' &&
    (execPath === '/usr/lib/git-core' || execPath === '/usr/libexec/git-core');
  if (
    !binaryInsideHelper &&
    !binaryBesideHelper &&
    !localSystemBinaryWithDistroHelpers
  )
    return undefined;
  const dataRoots = [getCanopyDataDir(), getCanopySecureDataDir()];
  const safeRoots = delegationToolchainReadRoots(
    [
      commandDirectory,
      execPath,
      posix.join(posix.dirname(helperParent), 'bin'),
    ],
    {
      platform: 'linux',
      home: homedir(),
      excludedRoots: [
        ...dataRoots,
        ...(await Promise.all(
          dataRoots.map((root) => realpath(root).catch(() => root)),
        )),
      ],
    },
  );
  // Reuse the command environment's private-directory and app-data policy as
  // validation only. The returned grants remain the exact binary and helper.
  if (
    ![executable, execPath].every((entry) =>
      safeRoots.some((root) => {
        const relative = posix.relative(root, entry);
        return (
          relative !== '..' &&
          !relative.startsWith('../') &&
          !posix.isAbsolute(relative)
        );
      }),
    )
  )
    return undefined;
  if (
    (await kind(executable)) !== 'file' ||
    (await kind(execPath)) !== 'directory'
  )
    return undefined;
  return {
    runtimeRoots: Array.from(new Set([executable, execPath])),
    commandDirectory,
  };
}

/** Resolve the Linux git runtime, or undefined when it is unsupported. The
 * `git --exec-path` probe runs under a bounded, clean environment: it inherits
 * no ambient `GIT_EXEC_PATH`, `GIT_CONFIG*` or repository variables, disables
 * system and global configuration, and runs outside the repository so it
 * cannot execute repository-controlled configuration or hooks. */
async function linuxGitAccess(
  resolveGit: () => Promise<string>,
  signal: AbortSignal | undefined,
): Promise<{ runtimeRoots: string[]; commandDirectory: string } | undefined> {
  const executable = await realpath(await resolveGit());
  if ((await pathKind(executable)) !== 'file') return undefined;
  const { stdout } = await execute(executable, ['--exec-path'], {
    env: {
      PATH: '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    cwd: '/',
    timeout: 5000,
    maxBuffer: 4096,
    killSignal: 'SIGKILL',
    signal,
  });
  const execPath = await realpath(stdout.trim());
  return linuxGitRuntime(executable, execPath);
}

async function windowsGitAccess(
  metadata: Pick<DelegationGitAccess, 'metadataRoots' | 'privateMetadataRoots'>,
  resolveGit: () => Promise<string>,
): Promise<DelegationGitAccess> {
  const executable = await realpath(await resolveGit());
  const runtime = windowsGitRuntime(executable);
  if (!runtime || (await pathKind(executable)) !== 'file')
    throw new Error('Unsupported Git runtime');
  const runtimeRoots = await windowsGitRuntimeRoots(runtime.runtimeRoot);
  if (!runtimeRoots) throw new Error('Unsupported Git runtime');
  return {
    ...metadata,
    runtimeRoots,
    commandDirectories: [runtime.commandDirectory],
  };
}

export async function resolveDelegationGitAccess(
  cwd: string,
  signal?: AbortSignal,
  resolveGit: () => Promise<string> = () => getResolvedGitExecutableForSpawn(),
): Promise<DelegationGitAccess> {
  const { metadataRoots, privateMetadataRoots } =
    await delegationGitMetadata(cwd);
  const os = hostOperatingSystem();
  if (
    !metadataRoots.length ||
    (os !== 'darwin' && os !== 'win32' && os !== 'linux')
  )
    return NO_GIT_ACCESS;
  if (os === 'win32') {
    try {
      return await windowsGitAccess(
        { metadataRoots, privateMetadataRoots },
        resolveGit,
      );
    } catch {
      return NO_GIT_ACCESS;
    }
  }
  if (os === 'linux') {
    try {
      const runtime = await linuxGitAccess(resolveGit, signal);
      if (!runtime) return NO_GIT_ACCESS;
      return {
        metadataRoots,
        privateMetadataRoots,
        runtimeRoots: runtime.runtimeRoots,
        commandDirectories: [runtime.commandDirectory],
      };
    } catch {
      return NO_GIT_ACCESS;
    }
  }
  try {
    const { stdout } = await execute('/usr/bin/xcrun', ['--find', 'git'], {
      env: { PATH: '/usr/bin:/bin' },
      timeout: 5000,
      maxBuffer: 4096,
      signal,
    });
    const executable = await realpath(stdout.trim());
    const match = executable.match(
      /^(\/Library\/Developer\/CommandLineTools|\/Applications\/[^/]+\.app\/Contents\/Developer)\/usr\/bin\/git$/,
    );
    if (!match || !(await lstat(executable)).isFile())
      throw new Error('Unsupported Git runtime');
    return {
      metadataRoots,
      privateMetadataRoots,
      runtimeRoots: [match[1]],
      commandDirectories: [path.dirname(executable)],
    };
  } catch {
    return {
      metadataRoots: [],
      privateMetadataRoots: [],
      runtimeRoots: [],
      commandDirectories: [],
    };
  }
}
