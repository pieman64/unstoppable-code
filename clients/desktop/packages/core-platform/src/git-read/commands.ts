import path from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { windowsExecutable } from '../supervision/shared';

/** Always caller-supplied; the runner never reads ambient `process.env`. */
export type GitReadEnvironment = Readonly<Record<string, string>>;

/** The fixed command set. Nothing else can be expressed. */
export type GitReadCommand =
  | { readonly kind: 'git-version'; readonly executable: string }
  /** macOS only: `init --bare` into a fresh directory under `temporaryRoot`. */
  | {
      readonly kind: 'git-bare-init-smoke';
      readonly executable: string;
      readonly temporaryRoot: string;
    }
  | {
      readonly kind: 'git-check-ignore';
      readonly executable: string;
      readonly input: Uint8Array;
    }
  | { readonly kind: 'xcode-select-print-path' }
  /** macOS: `$SHELL || /bin/zsh` from the supplied environment. */
  | { readonly kind: 'macos-login-shell-path' }
  /** Linux: one already-selected candidate shell. */
  | { readonly kind: 'linux-login-shell-path'; readonly shell: string }
  | { readonly kind: 'getent-passwd'; readonly uid: number }
  /** Windows: `where.exe`, resolved through the supplied PATH only. */
  | { readonly kind: 'where-git' };

export type GitReadCommandKind = GitReadCommand['kind'];

/** How one command runs. `maxBuffer` limits each stream separately (C7). */
export interface GitReadPlan {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: GitReadEnvironment;
  readonly maxBuffer: number;
  /** Per-probe cap; `undefined` leaves only the request deadline. */
  readonly timeoutMs: number | undefined;
  readonly killMode: 'graceful' | 'force';
  readonly input: Uint8Array | undefined;
}

export type GitReadErrorCode =
  | 'invalid_request'
  | 'unsupported_command'
  | 'command_not_found'
  | 'timeout'
  | 'deadline_exceeded'
  | 'output_limit'
  | 'exit_status'
  | 'cleanup_unconfirmed';

const MESSAGES: Readonly<Record<GitReadErrorCode, string>> = {
  invalid_request: 'Git read request is invalid.',
  unsupported_command: 'Git read command is unavailable on this host.',
  command_not_found: 'Git read command was not found on the supplied PATH.',
  timeout: 'Git read command timed out.',
  deadline_exceeded: 'Git read request deadline exceeded.',
  output_limit: 'Git read command output exceeded its limit.',
  exit_status: 'Git read command failed.',
  cleanup_unconfirmed: 'Git read command cleanup did not complete.',
};

/** Fixed messages only: no paths, arguments, environment, or output. */
export class GitReadError extends Error {
  override readonly name = 'GitReadError';
  readonly code: GitReadErrorCode;
  readonly stream: 'stdout' | 'stderr' | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  /** Behind `cleanup_unconfirmed`: the kill failure, else the first failure or abort reason. */
  readonly failure: unknown;

  constructor(
    code: GitReadErrorCode,
    detail: {
      readonly stream?: 'stdout' | 'stderr';
      readonly exitCode?: number | null;
      readonly signal?: string | null;
      readonly failure?: unknown;
    } = {},
  ) {
    super(MESSAGES[code]);
    this.code = code;
    this.failure = detail.failure;
    this.stream = detail.stream;
    this.exitCode = detail.exitCode;
    this.signal = detail.signal;
  }
}

// Desktop's values (git-executable.ts, config-paths.ts, git.ts).
const VALIDATION_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_TIMEOUT_MS = 10_000;
const GETENT_TIMEOUT_MS = 1_000;
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';

/** Pinned against desktop-shared's `sanitizeEnvVars` by a golden test (C3). */
const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
]);
const LINUX_STARTUP_KEYS = new Set([
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'GCONV_PATH',
  'GLIBC_TUNABLES',
]);

/** Desktop's `getLinuxProbeEnv`, applied to the supplied environment. */
export function linuxProbeEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  const kept = Object.entries(environment).filter(([key]) => {
    const name = key.toUpperCase();
    return (
      !name.startsWith('LD_') &&
      !name.startsWith('DYLD_') &&
      !name.startsWith('BASH_FUNC_') &&
      !LINUX_STARTUP_KEYS.has(name) &&
      !BLOCKED_ENV_KEYS.has(name)
    );
  });
  return Object.freeze(Object.fromEntries(kept));
}

/** The bare-init smoke's environment: no `GIT_*`, no system or global config. */
export function bareInitEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
    ),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
}

const AVAILABLE: Readonly<
  Record<GitReadCommandKind, readonly PlatformOperatingSystem[]>
> = {
  'git-version': ['darwin', 'linux', 'win32'],
  'git-bare-init-smoke': ['darwin'],
  'git-check-ignore': ['darwin', 'linux', 'win32'],
  'xcode-select-print-path': ['darwin'],
  'macos-login-shell-path': ['darwin'],
  'linux-login-shell-path': ['linux'],
  'getent-passwd': ['linux'],
  'where-git': ['win32'],
};

const hasNul = (value: string): boolean => value.includes('\0');
const invalid = (): GitReadError => new GitReadError('invalid_request');

function executable(value: unknown): string {
  if (typeof value !== 'string' || value === '' || hasNul(value))
    throw invalid();
  return value;
}

function scratchDirectory(
  os: PlatformOperatingSystem,
  scratch: string | undefined,
): string {
  if (scratch === undefined || !isHostAbsolute(os, scratch)) throw invalid();
  return scratch;
}

function inputBytes(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array)) throw invalid();
  return input;
}

function linuxShell(shell: unknown): string {
  if (
    typeof shell !== 'string' ||
    !path.posix.isAbsolute(shell) ||
    /[\0\r\n]/.test(shell)
  )
    throw invalid();
  return shell;
}

function accountUid(uid: unknown): string {
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0)
    throw invalid();
  return String(uid);
}

/** Absolute for the host; Windows requires a drive or UNC path. */
export function isHostAbsolute(
  os: PlatformOperatingSystem,
  value: string,
): boolean {
  if (hasNul(value)) return false;
  return os === 'win32'
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}(?![?.][\\/])[^\\/])/.test(value)
    : path.posix.isAbsolute(value);
}

/**
 * The value a Windows child sees. Keys are case-insensitive, and Node keeps
 * the first variant in sort order.
 */
export function windowsEnvironmentValue(
  environment: GitReadEnvironment,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  const [key] = Object.keys(environment)
    .filter((candidate) => candidate.toUpperCase() === upper)
    .sort();
  return key === undefined ? undefined : environment[key];
}

/** The PATH the child receives. */
export function searchPath(
  os: PlatformOperatingSystem,
  environment: GitReadEnvironment,
): string | undefined {
  return os === 'win32'
    ? windowsEnvironmentValue(environment, 'PATH')
    : environment.PATH;
}

/** A command name with no directory part, which only a PATH search resolves. */
export function isBareCommand(
  os: PlatformOperatingSystem,
  file: string,
): boolean {
  if (file === '' || file === '.' || file === '..' || hasNul(file))
    return false;
  return os === 'win32' ? !/[\\/:]/.test(file) : !file.includes('/');
}

/**
 * libuv v1.51 `src/win/process.c` `search_path`: an entry starting with a
 * quote runs to the matching quote (or the end), then to the next `;`, so it
 * may contain `;`. Zero-length slices are skipped; one leading quote and one
 * trailing `"` or `'` are then removed.
 */
function windowsPathEntries(value: string): string[] {
  const entries: string[] = [];
  let end = 0;
  while (end < value.length) {
    if (end !== 0 || value.startsWith(';')) end += 1;
    const start = end;
    const quote = value.charAt(start);
    let from = start;
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, start + 1);
      from = close === -1 ? value.length : close;
    }
    const separator = value.indexOf(';', from);
    end = separator === -1 ? value.length : separator;
    if (end === start) continue;
    let entry = value.slice(start, end);
    if (/^["']/.test(entry)) entry = entry.slice(1);
    if (/["']$/.test(entry)) entry = entry.slice(0, -1);
    entries.push(entry);
  }
  return entries;
}

/**
 * The absolute directories of `value`. Empty and relative entries, which
 * libuv and execvp resolve against the cwd, are skipped. Windows entries are
 * split and unquoted as libuv does.
 */
export function searchDirectories(
  os: PlatformOperatingSystem,
  value: string | undefined,
): string[] {
  if (!value) return [];
  const entries = os === 'win32' ? windowsPathEntries(value) : value.split(':');
  return entries.filter((entry) => isHostAbsolute(os, entry));
}

/**
 * Spawn would resolve a relative command through the cwd, and without a PATH
 * through the host's PATH (Windows) or a built-in default (POSIX). The runner
 * resolves a bare name through the supplied PATH instead; anything else
 * relative is refused.
 */
function requireResolvable(
  os: PlatformOperatingSystem,
  plan: GitReadPlan,
): GitReadPlan {
  if (isHostAbsolute(os, plan.file)) return plan;
  if (
    !isBareCommand(os, plan.file) ||
    searchDirectories(os, searchPath(os, plan.env)).length === 0
  )
    throw invalid();
  return plan;
}

/** libuv v1.51 `src/win/process.c` `required_vars`. */
const LIBUV_REQUIRED_KEYS = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;

function usableSystemRoot(value: string): boolean {
  try {
    windowsExecutable(value, 'taskkill.exe');
    return true;
  } catch {
    return false;
  }
}

/**
 * The block a Windows child receives. Node keeps only the first case variant
 * of a key in sort order, so the others are dropped here. libuv copies each
 * required key the block lacks from the host, so each is added empty. PATH
 * must name an absolute directory and SystemRoot must be a drive path:
 * without them the child, or taskkill, cannot run.
 */
export function windowsChildEnvironment(
  environment: GitReadEnvironment,
): GitReadEnvironment {
  const kept = new Map<string, readonly [string, string]>();
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of entries)
    if (!kept.has(key.toUpperCase())) kept.set(key.toUpperCase(), [key, value]);
  for (const key of LIBUV_REQUIRED_KEYS)
    if (!kept.has(key)) kept.set(key, [key, '']);
  const value = (key: string): string => kept.get(key)?.[1] ?? '';
  if (
    searchDirectories('win32', value('PATH')).length === 0 ||
    !usableSystemRoot(value('SYSTEMROOT'))
  )
    throw invalid();
  return Object.freeze(Object.fromEntries(kept.values()));
}

/** Rejects anything spawn would reject, before any process starts. */
export function validateEnvironment(environment: unknown): GitReadEnvironment {
  if (typeof environment !== 'object' || environment === null) throw invalid();
  const entries = Object.entries(environment);
  for (const [key, value] of entries)
    if (typeof value !== 'string' || key === '' || hasNul(key) || hasNul(value))
      throw invalid();
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Maps a command to desktop's file, arguments, environment, limits and kill
 * signal. `scratch` is the bare-init directory the runner created.
 */
export function planGitReadCommand(
  os: PlatformOperatingSystem,
  command: GitReadCommand,
  environment: GitReadEnvironment,
  scratch?: string,
): GitReadPlan {
  if (!AVAILABLE[command.kind]?.includes(os))
    throw new GitReadError('unsupported_command');
  const linux = os === 'linux';
  const plan = (
    file: string,
    args: readonly string[],
    { env = environment, ...fields }: Partial<GitReadPlan> = {},
  ): GitReadPlan =>
    requireResolvable(
      os,
      Object.freeze({
        file,
        args: Object.freeze([...args]),
        env: os === 'win32' ? windowsChildEnvironment(env) : env,
        maxBuffer: NODE_DEFAULT_MAX_BUFFER,
        timeoutMs: VALIDATION_TIMEOUT_MS,
        killMode: 'graceful',
        input: undefined,
        ...fields,
      }),
    );
  switch (command.kind) {
    case 'git-version':
      // Linux validation runs with the probe environment and SIGKILL.
      return plan(
        executable(command.executable),
        ['--version'],
        linux
          ? { env: linuxProbeEnvironment(environment), killMode: 'force' }
          : {},
      );
    case 'git-bare-init-smoke':
      return plan(
        executable(command.executable),
        [
          '-c',
          'init.templateDir=',
          'init',
          '--bare',
          scratchDirectory(os, scratch),
        ],
        { env: bareInitEnvironment(environment), maxBuffer: 8192 },
      );
    case 'git-check-ignore':
      return plan(
        executable(command.executable),
        ['check-ignore', '-z', '--stdin'],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeoutMs: undefined,
          input: inputBytes(command.input),
        },
      );
    case 'xcode-select-print-path':
      return plan('/usr/bin/xcode-select', ['--print-path'], {
        maxBuffer: 4096,
      });
    case 'macos-login-shell-path':
      return plan(
        environment.SHELL || '/bin/zsh',
        ['-lic', 'exec /usr/bin/printf \'%s\\n\' "$PATH"'],
        { timeoutMs: LOGIN_SHELL_TIMEOUT_MS, killMode: 'force' },
      );
    case 'linux-login-shell-path':
      return plan(
        linuxShell(command.shell),
        ['-lic', `exec /usr/bin/printf '${LINUX_PATH_MARKER}%s\\n' "$PATH"`],
        {
          env: linuxProbeEnvironment(environment),
          maxBuffer: 64 * 1024,
          timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
          killMode: 'force',
        },
      );
    case 'getent-passwd':
      return plan('/usr/bin/getent', ['passwd', accountUid(command.uid)], {
        env: linuxProbeEnvironment(environment),
        maxBuffer: 16 * 1024,
        timeoutMs: GETENT_TIMEOUT_MS,
        killMode: 'force',
      });
    case 'where-git':
      return plan('where.exe', ['git']);
  }
}
