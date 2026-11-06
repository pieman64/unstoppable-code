import path from 'node:path';

/** Shared namespaces, never automatic PATH grants. Explicit task grants differ. */
export const DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS: readonly string[] =
  Object.freeze(['/private/tmp', '/tmp', '/private/var/tmp', '/var/tmp']);

export interface DelegationCommandEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  /** Required on Windows: the host's absolute %SystemRoot%. */
  readonly systemRoot?: string;
  /**
   * The host's captured login-shell PATH, the same PATH a delegated Claude
   * child's Bash receives. Its absolute entries follow the host-selected
   * directories, so the validated Git executable keeps precedence.
   */
  readonly commandPath?: string;
  /** A private, writable per-run directory for TMPDIR, TMP and TEMP. */
  readonly temporaryDirectory?: string;
}

/**
 * Host-selected executables first, then the host's captured login-shell PATH,
 * then the platform system directories. Git configuration stays isolated.
 */
export function delegationCommandEnvironment(
  directories: readonly string[],
  options: DelegationCommandEnvironmentOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (
    directories.some(
      (directory) =>
        !pathApi.isAbsolute(directory) ||
        directory.includes(pathApi.delimiter) ||
        directory.includes('\0'),
    )
  )
    throw new Error('Invalid delegated command directory');
  const captured = commandPathEntries(options.commandPath, platform);
  const temporary: Record<string, string> =
    options.temporaryDirectory &&
    pathApi.isAbsolute(options.temporaryDirectory) &&
    !options.temporaryDirectory.includes('\0')
      ? {
          TMPDIR: options.temporaryDirectory,
          TMP: options.temporaryDirectory,
          TEMP: options.temporaryDirectory,
        }
      : {};
  if (platform === 'win32') {
    const systemRoot = options.systemRoot;
    if (
      !systemRoot ||
      !pathApi.isAbsolute(systemRoot) ||
      systemRoot.includes(pathApi.delimiter) ||
      systemRoot.includes('\0')
    )
      throw new Error('Windows system directory is unavailable');
    const system32 = pathApi.join(systemRoot, 'System32');
    return {
      PATH: uniqueEntries([
        ...directories,
        ...captured,
        system32,
        systemRoot,
        pathApi.join(system32, 'WindowsPowerShell', 'v1.0'),
      ]).join(pathApi.delimiter),
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: pathApi.join(system32, 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      ...temporary,
      ...gitIsolation('NUL'),
    };
  }
  return {
    PATH: uniqueEntries([
      ...directories,
      ...captured,
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]).join(pathApi.delimiter),
    ...temporary,
    ...gitIsolation('/dev/null'),
  };
}

/**
 * System locations a delegated command needs to start common runtimes on
 * macOS: Node reads the OpenSSL configuration under /System/Library at
 * startup, TLS clients read CA certificates under /private/etc, and compilers
 * and Git resolve through the Command Line Tools or Xcode. The system
 * directories under /usr are listed one by one so /usr/local, where users
 * install software, is granted only as a checked PATH prefix.
 */
export const DARWIN_DELEGATION_RUNTIME_READ_ROOTS: readonly string[] =
  Object.freeze([
    '/System/Library',
    '/usr/bin',
    '/usr/lib',
    '/usr/libexec',
    '/usr/sbin',
    '/usr/share',
    '/usr/standalone',
    '/private/etc',
    '/etc',
    '/private/var/db/timezone',
    '/Library/Developer',
    '/Library/Frameworks',
    '/Applications/Xcode.app',
  ]);

/**
 * Directory names whose contents are private wherever they appear: the names
 * the delegated native file policy denies, plus the GnuPG and Docker homes. A
 * PATH directory inside one of them grants nothing.
 */
const PRIVATE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.codex',
  '.claude',
  '.ssh',
  '.aws',
  '.kube',
  '.config',
  '.canopy',
  '.gnupg',
  '.docker',
]);

/**
 * The directories beside a `bin` or `sbin` directory inside the home directory
 * that its tools run from: libraries, private executables, headers and
 * version-manager installs. Tool managers there keep access tokens,
 * configuration and keys beside their binaries (Pulumi, flyctl, OrbStack), so
 * the rest of such a folder is never granted.
 */
const HOME_PREFIX_RUNTIME_DIRECTORIES: readonly string[] = [
  'lib',
  'libexec',
  'include',
  'versions',
];

/**
 * The only PATH directories granted inside the home directory: the ones that
 * hold executables by convention. Any other folder on PATH there, such as a
 * tool manager's own folder, grants nothing, so a new tool manager's tokens
 * stay private by default.
 */
const HOME_EXECUTABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  'bin',
  'sbin',
  'shims',
]);

export interface DelegationToolchainReadRootOptions {
  readonly home: string;
  readonly platform?: NodeJS.Platform;
  /** Directories no read root may contain or sit inside, such as app data. */
  readonly excludedRoots?: readonly string[];
}

/**
 * Read access a sandboxed delegated command needs to run the tools on its
 * PATH: each PATH directory, plus the install prefix of a `bin` or `sbin`
 * directory (where a tool's own `lib`, `libexec` and `share` files live), and
 * on macOS the system runtime locations. Inside the home directory only a
 * `bin`, `sbin` or `shims` PATH directory is granted, and beside a `bin` or
 * `sbin` directory only its prefix's runtime directories. Nothing is granted
 * that is the filesystem root, the user's home directory or an ancestor of
 * it, that sits inside a private directory, or that contains or sits inside
 * an excluded root; a refused prefix leaves the directory itself granted.
 * macOS shared-temporary prefixes get only named runtime siblings; an exact
 * shared-namespace PATH entry grants nothing. The caller reports that conflict.
 * Runtime directories are named, not observed: the caller grants each only where it
 * resolves to itself.
 */
export function delegationToolchainReadRoots(
  entries: readonly string[],
  options: DelegationToolchainReadRootOptions,
): string[] {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const home = pathApi.resolve(options.home);
  const sharedTemporaryRoots =
    platform === 'darwin' ? DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS : [];
  const excluded = (options.excludedRoots ?? [])
    .filter((root) => pathApi.isAbsolute(root))
    .map((root) => pathApi.resolve(root));
  const grantable = (candidate: string): boolean =>
    candidate !== pathApi.parse(candidate).root &&
    !within(pathApi, candidate, home) &&
    !candidate
      .split(pathApi.sep)
      .some((segment) => PRIVATE_DIRECTORY_NAMES.has(segment.toLowerCase())) &&
    !excluded.some(
      (root) =>
        within(pathApi, candidate, root) || within(pathApi, root, candidate),
    );
  const roots: string[] = [];
  for (const raw of entries) {
    if (!raw || !pathApi.isAbsolute(raw) || raw.includes('\0')) continue;
    const directory = pathApi.resolve(raw);
    if (sharedTemporaryRoots.includes(directory)) continue;
    if (!grantable(directory)) continue;
    const name = pathApi.basename(directory).toLowerCase();
    if (
      within(pathApi, home, directory) &&
      !HOME_EXECUTABLE_DIRECTORIES.has(name)
    )
      continue;
    roots.push(directory);
    if (name !== 'bin' && name !== 'sbin') continue;
    const prefix = pathApi.dirname(directory);
    if (!grantable(prefix)) continue;
    if (
      !within(pathApi, home, prefix) &&
      !sharedTemporaryRoots.includes(prefix)
    )
      roots.push(prefix);
    else
      roots.push(
        ...[
          ...HOME_PREFIX_RUNTIME_DIRECTORIES,
          ...(sharedTemporaryRoots.includes(prefix) ? ['share'] : []),
        ]
          .map((name) => pathApi.join(prefix, name))
          .filter(grantable),
      );
  }
  if (platform === 'darwin')
    roots.push(...DARWIN_DELEGATION_RUNTIME_READ_ROOTS.filter(grantable));
  return uniqueEntries(roots);
}

/**
 * The given read roots without those inside another of them, in their
 * original order, retaining child grants across macOS shared-temporary denies.
 * Otherwise a nested root adds no access, and on macOS every Codex
 * read root enlarges a sandbox profile that must stay within the argument
 * limit.
 */
export function delegationOutermostRoots(
  roots: readonly string[],
  options: { readonly platform?: NodeJS.Platform } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const absolute = uniqueEntries(
    roots
      .filter((root) => pathApi.isAbsolute(root))
      .map((root) => pathApi.resolve(root)),
  );
  const fences =
    platform === 'darwin' ? DARWIN_DELEGATION_SHARED_TEMPORARY_ROOTS : [];
  return absolute.filter(
    (root) =>
      !absolute.some(
        (other) =>
          other !== root &&
          within(pathApi, other, root) &&
          !fences.some(
            (fence) =>
              within(pathApi, other, fence) && within(pathApi, fence, root),
          ),
      ),
  );
}

/** Whether `candidate` is `root` or a descendant of it. */
function within(
  pathApi: typeof path.posix,
  root: string,
  candidate: string,
): boolean {
  const relative = pathApi.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
  );
}

function commandPathEntries(
  commandPath: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (!commandPath) return [];
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return commandPath
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter(
      (entry) => entry && pathApi.isAbsolute(entry) && !entry.includes('\0'),
    );
}

function uniqueEntries(entries: readonly string[]): string[] {
  return Array.from(new Set(entries));
}

/** Git reads no user, system, hook, exclude or attribute files, and takes no
 * optional locks, whichever null device the platform names. */
function gitIsolation(nullDevice: string): Record<string, string> {
  return {
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: nullDevice,
    GIT_CONFIG_KEY_2: 'core.excludesFile',
    GIT_CONFIG_VALUE_2: nullDevice,
    GIT_CONFIG_KEY_3: 'core.attributesFile',
    GIT_CONFIG_VALUE_3: nullDevice,
  };
}
