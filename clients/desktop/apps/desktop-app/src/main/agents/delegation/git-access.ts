import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
async function canonicalDirectory(directory: string): Promise<string> {
  const canonical = await realpath(directory);
  const systemPath =
    process.platform === 'darwin'
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
  if (
    !metadataRoots.length ||
    (process.platform !== 'darwin' && process.platform !== 'win32')
  )
    return NO_GIT_ACCESS;
  if (process.platform === 'win32') {
    try {
      return await windowsGitAccess(
        { metadataRoots, privateMetadataRoots },
        resolveGit,
      );
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
