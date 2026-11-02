/**
 * Pure Git executable selection and status policy. Hosts own every
 * filesystem, process and environment read, pass the results and their OS
 * and architecture in, and apply every effect; nothing here touches the OS.
 * `@canopy/core-platform`'s daemon selection keeps its own precedence
 * (recorded convergence debt, CAN-5137).
 */

/** Standard system location Linux discovery falls back to. */
export const LINUX_SYSTEM_GIT_PATH = '/usr/bin/git';

export const MAC_COMMAND_LINE_TOOLS_GIT_PATH =
  '/Library/Developer/CommandLineTools/usr/bin/git';

export const MAC_HOMEBREW_GIT_PATHS: readonly [
  '/opt/homebrew/bin/git',
  '/usr/local/bin/git',
] = ['/opt/homebrew/bin/git', '/usr/local/bin/git'];

export interface LinuxGitCandidate {
  path: string;
  source: 'login-path' | 'system';
}

/** Host path operations, so callers choose the POSIX or Windows flavor. */
export interface GitCandidatePaths {
  join(this: void, ...parts: string[]): string;
  isAbsolute(this: void, value: string): boolean;
}

const GIT_VERSION_RE = /\bgit version\s+\S+/i;
const NUMERIC_GIT_VERSION_RE = /\bgit version\s+\d+\.\d+\S*/i;

/**
 * Extract the `git version X` text a probe printed, or null for non-Git
 * output. `numeric` additionally requires an `N.N…` version, so a banner such
 * as `git version banana` is rejected.
 */
export function parseGitVersion(
  output: string,
  options?: { numeric?: boolean },
): string | null {
  const pattern = options?.numeric ? NUMERIC_GIT_VERSION_RE : GIT_VERSION_RE;
  return output.match(pattern)?.[0].trim() ?? null;
}

/**
 * Absolute `git` locations for each directory of a POSIX PATH value, in PATH
 * order. Relative and empty entries resolve against the process directory, so
 * they are never candidates; duplicates are dropped.
 */
function getPathGitCandidates(pathValue: string): string[] {
  const candidates = new Set<string>();
  for (const directory of pathValue.split(':')) {
    if (!directory.startsWith('/')) continue;
    const segments = directory.split('/').filter(Boolean);
    candidates.add(`/${[...segments, 'git'].join('/')}`);
  }
  return Array.from(candidates);
}

/**
 * Linux discovery candidates: the refreshed login PATH in order, then the
 * standard system location unless the PATH already covers it.
 */
export function getLinuxGitCandidates(loginPath: string): LinuxGitCandidate[] {
  const candidates = getPathGitCandidates(loginPath).map(
    (path): LinuxGitCandidate => ({ path, source: 'login-path' }),
  );
  if (!candidates.some(({ path }) => path === LINUX_SYSTEM_GIT_PATH)) {
    candidates.push({ path: LINUX_SYSTEM_GIT_PATH, source: 'system' });
  }
  return candidates;
}

export function isMacGitShim(candidate: string): boolean {
  return (
    candidate === '/usr/bin/git' ||
    candidate === '/usr/bin/xcrun' ||
    candidate.includes('/Library/Homebrew/shims/')
  );
}

/**
 * macOS discovery candidates: each absolute login-PATH directory's `git` (not
 * deduplicated), Command Line Tools, the selected developer directory's Git
 * when it is absolute, then Homebrew. Apple shims are not filtered here.
 */
export function getMacGitCandidates(input: {
  readonly loginPath: string;
  readonly developerDir: string | null;
  readonly paths: GitCandidatePaths;
}): string[] {
  const { join, isAbsolute } = input.paths;
  const candidates = input.loginPath
    .split(':')
    .filter((directory) => isAbsolute(directory))
    .map((directory) => join(directory, 'git'));
  candidates.push(MAC_COMMAND_LINE_TOOLS_GIT_PATH);
  if (input.developerDir !== null && isAbsolute(input.developerDir)) {
    candidates.push(join(input.developerDir, 'usr/bin/git'));
  }
  candidates.push(...MAC_HOMEBREW_GIT_PATHS);
  return candidates;
}

function isNonBlank(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Standard Windows install locations: `Git\cmd` and `Git\bin` under
 * ProgramFiles, then ProgramFiles(x86), then LOCALAPPDATA's per-user and
 * `Programs` installs. Blank bases are skipped; others are joined untrimmed.
 */
export function getWindowsGitCandidates(input: {
  readonly programFiles?: string;
  readonly programFilesX86?: string;
  readonly localAppData?: string;
  readonly join: (this: void, ...parts: string[]) => string;
}): string[] {
  const { join, localAppData } = input;
  const candidates = [input.programFiles, input.programFilesX86]
    .filter(isNonBlank)
    .flatMap((base) => [
      join(base, 'Git', 'cmd', 'git.exe'),
      join(base, 'Git', 'bin', 'git.exe'),
    ]);
  if (isNonBlank(localAppData)) {
    candidates.push(
      join(localAppData, 'Git', 'cmd', 'git.exe'),
      join(localAppData, 'Git', 'bin', 'git.exe'),
      join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
      join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    );
  }
  return candidates;
}

/** Paths `where.exe` printed, one per line, trimmed, without blank lines. */
export function parseWhereExeOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The precedence a host applies when it detects Git:
 * - `linux` (Linux x64/arm64): the explicit choice, reported but never replaced
 *   when it is broken; the revalidated earlier discovery; the refreshed login
 *   PATH in order; then the system location. Only an explicit choice is saved.
 * - `probe` (macOS and Windows): the saved preference, a published override,
 *   then discovered candidates; the first valid one is saved.
 * - `optional` (every other platform): Git is not required; only an override
 *   is validated.
 */
export type GitExecutableDetectionMode = 'linux' | 'probe' | 'optional';

export function getGitExecutableDetectionMode(
  os: string,
  arch: string,
): GitExecutableDetectionMode {
  if (os === 'linux' && (arch === 'x64' || arch === 'arm64')) return 'linux';
  return os === 'darwin' || os === 'win32' ? 'probe' : 'optional';
}

export interface GitExecutableRequirement<Platform extends string> {
  platform: Platform;
  required: boolean;
}

export function getGitExecutableRequirement<Platform extends string>(
  os: Platform,
  arch: string,
): GitExecutableRequirement<Platform> {
  return {
    platform: os,
    required: getGitExecutableDetectionMode(os, arch) !== 'optional',
  };
}

/**
 * Whether a detection request joins the one already running. Unforced
 * requests always do; so does a forced macOS recheck, so overlapping installer
 * checks share one probe.
 */
export function shouldJoinGitExecutableDetection(
  os: string,
  force: boolean,
): boolean {
  return !force || os === 'darwin';
}

/**
 * The Linux explicit choice: the saved selection, else an override the host
 * did not publish from its own discovery.
 */
export function selectLinuxExplicitGitChoice(input: {
  readonly saved: string | null;
  readonly override: string | undefined;
  readonly discovered: string | null;
}): string | null {
  if (input.saved) return input.saved;
  return input.override && input.override !== input.discovered
    ? input.override
    : null;
}

/**
 * macOS and Windows discovery candidates in probe order: Apple and Homebrew
 * shims are dropped on macOS, and repeats are dropped, case-insensitively on
 * Windows.
 */
export function getGitExecutableProbeOrder(
  os: string,
  candidates: readonly string[],
): string[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (os === 'darwin' && isMacGitShim(candidate)) return false;
    const key = os === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A detection status, in the key order hosts report it. */
export interface GitExecutableStatusShape<
  Platform extends string,
  Source extends string,
> {
  platform: Platform;
  required: boolean;
  checkedAt: string;
  ready: boolean;
  path: string | null;
  version: string | null;
  source: Source;
  wingetAvailable: boolean;
  error?: string;
}

/** Shapes a status; an empty `error` is omitted. */
export function shapeGitExecutableStatus<
  Platform extends string,
  Source extends string,
>(
  requirement: GitExecutableRequirement<Platform>,
  checkedAt: string,
  values: {
    readonly ready: boolean;
    readonly path: string | null;
    readonly version: string | null;
    readonly source: Source;
    readonly wingetAvailable: boolean;
    readonly error?: string;
  },
): GitExecutableStatusShape<Platform, Source> {
  return {
    platform: requirement.platform,
    required: requirement.required,
    checkedAt,
    ready: values.ready,
    path: values.path,
    version: values.version,
    source: values.source,
    wingetAvailable: values.wingetAvailable,
    ...(values.error ? { error: values.error } : {}),
  };
}
