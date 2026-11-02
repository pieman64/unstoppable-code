import { execFile } from 'node:child_process';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { constants } from 'node:fs';
import { access, stat, realpath, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import {
  LINUX_SYSTEM_GIT_PATH,
  getGitExecutableDetectionMode,
  getGitExecutableProbeOrder,
  getGitExecutableRequirement,
  getLinuxGitCandidates,
  getMacGitCandidates,
  getWindowsGitCandidates,
  isMacGitShim,
  parseGitVersion,
  parseWhereExeOutput,
  selectLinuxExplicitGitChoice,
  shapeGitExecutableStatus,
  shouldJoinGitExecutableDetection,
} from '@canopy/desktop-shared/lib/git-executable';
import {
  getLinuxProbeEnv,
  getLoginShellPath,
  prewarmLoginShellPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import type {
  GitExecutableInstallProgress,
  GitExecutableSource,
  GitExecutableStatus,
} from '@canopy/desktop-shared/types';
import type { WorkerGitExecutableIssue } from '@canopy/protocol/canopy-core';
import { readPreferencesFile, writePreferencesFile } from './preferences-store';
import { isErrnoException } from './type-guards';

const VALIDATION_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INSTALL_OUTPUT_CHARS = 8 * 1024;
const GIT_INSTALL_ALREADY_RUNNING_ERROR = 'Git installation is already running';

let validatedMacPath: string | null = null;
// Linux keeps discovery in memory: the saved preference holds only an explicit
// user choice, so a discovered path can never outrank or masquerade as one.
let validatedLinuxPath: string | null = null;
let linuxDiscoveredPath: string | null = null;
// Bumped by every Linux detection and explicit cache change; a superseded
// detection must not publish, cache or invalidate anything.
let linuxDetectionGeneration = 0;
let xcodeInstallPromise: Promise<void> | null = null;

/** One detection's status and, when it is not ready, why. */
export interface GitExecutableDetection {
  status: GitExecutableStatus;
  issue: WorkerGitExecutableIssue | null;
}

// The shared live detection. Every caller that changes the preference or the
// environment joins it, so one probe applies its effects exactly once.
let detectionPromise: Promise<GitExecutableDetection> | null = null;
let installPromise: Promise<GitExecutableStatus> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function getEffectivePlatform(): NodeJS.Platform {
  if (
    __CANOPY_E2E__ &&
    (process.env.CANOPY_E2E_PLATFORM === 'win32' ||
      process.env.CANOPY_E2E_PLATFORM === 'linux')
  ) {
    return process.env.CANOPY_E2E_PLATFORM;
  }
  return hostPlatformOperatingSystem();
}

function isWindows(): boolean {
  return getEffectivePlatform() === 'win32';
}

function isLinuxGitSupported(): boolean {
  return (
    getGitExecutableDetectionMode(getEffectivePlatform(), process.arch) ===
    'linux'
  );
}

export function getGitExecutablePlatformStatus(): Pick<
  GitExecutableStatus,
  'platform' | 'required'
> {
  return getGitExecutableRequirement(getEffectivePlatform(), process.arch);
}

function status(
  values: Omit<GitExecutableStatus, 'platform' | 'required' | 'checkedAt'>,
): GitExecutableStatus {
  return shapeGitExecutableStatus(
    getGitExecutablePlatformStatus(),
    nowIso(),
    values,
  );
}

function notFoundStatus(values?: {
  wingetAvailable?: boolean;
  error?: string;
}): GitExecutableStatus {
  return status({
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    wingetAvailable: values?.wingetAvailable ?? false,
    ...(values?.error ? { error: values.error } : {}),
  });
}

function readyStatus(values: {
  path: string;
  version: string;
  source: GitExecutableSource;
  wingetAvailable?: boolean;
}): GitExecutableStatus {
  return status({
    ready: true,
    path: values.path,
    version: values.version,
    source: values.source,
    wingetAvailable: values.wingetAvailable ?? false,
  });
}

function publishGitExecutablePath(path: string): void {
  process.env.CANOPY_GIT_EXECUTABLE = path;
}

function clearPublishedGitExecutablePath(path?: string | null): void {
  if (!path || process.env.CANOPY_GIT_EXECUTABLE === path) {
    delete process.env.CANOPY_GIT_EXECUTABLE;
  }
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk)}`;
  return next.length > MAX_INSTALL_OUTPUT_CHARS
    ? next.slice(-MAX_INSTALL_OUTPUT_CHARS)
    : next;
}

function wingetSilentInstallUnsupported(output: string): boolean {
  return /silent(?:\s+install(?:ation)?)?.{0,80}(?:does not support|not supported|unsupported)|(?:does not support|not supported|unsupported).{0,80}silent/i.test(
    output,
  );
}

function execFileBuffered(
  file: string,
  args: string[],
  options: {
    timeout?: number;
    windowsHide?: boolean;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    killSignal?: NodeJS.Signals;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: hostPlatformOperatingSystem() === 'win32',
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            error instanceof Error
              ? error
              : new Error('Git executable command failed'),
          );
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function emitProgress(
  onProgress: ((progress: GitExecutableInstallProgress) => void) | undefined,
  progress: GitExecutableInstallProgress,
): void {
  onProgress?.(progress);
}

class GitExecutableMissingError extends Error {}

async function pathExistsAsFile(
  candidate: string,
  explainAccessErrors = false,
): Promise<void> {
  let stats;
  try {
    stats = await stat(candidate);
  } catch (error) {
    const code = isErrnoException(error) ? error.code : undefined;
    if (
      explainAccessErrors &&
      code &&
      code !== 'ENOENT' &&
      code !== 'ENOTDIR'
    ) {
      throw new Error(
        `Git executable cannot be accessed (${code}): ${candidate}`,
      );
    }
    throw new GitExecutableMissingError(
      `Git executable does not exist: ${candidate}`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(`Git executable is not a file: ${candidate}`);
  }
}

function assertValidWindowsGitBasename(candidate: string): void {
  if (!isWindows()) {
    return;
  }
  if (win32.basename(candidate).toLowerCase() !== 'git.exe') {
    throw new Error('Selected file must be git.exe');
  }
}

/**
 * What one detection reads and changes. The live state applies a detection's
 * effects to the saved preference, the published environment and the Linux
 * discovery state through this module's writers; a preview reads them but
 * changes only its own overlay.
 */
interface DetectionState {
  readSavedPath(): Promise<string | null>;
  readPublishedPath(): string | undefined;
  readLinuxDiscoveredPath(): string | null;
  /** Starts a Linux detection; the result reports whether it is still current. */
  beginLinuxDetection(): () => boolean;
  publish(path: string): void;
  unpublish(path?: string | null): void;
  save(path: string): Promise<void>;
  /** Clears the saved preference and unpublishes `savedPath`, the value it held. */
  clearSaved(savedPath: string): Promise<void>;
  acceptLinux(path: string, discovered: boolean): void;
  forgetLinuxDiscovery(): void;
  rememberMacValidation(path: string): void;
}

function logGitCacheWriteFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn('Could not save the detected Git executable path:', error);
}

const LIVE_DETECTION_STATE: DetectionState = {
  readSavedPath: () => getCachedGitExecutablePath(),
  readPublishedPath: () => process.env.CANOPY_GIT_EXECUTABLE,
  readLinuxDiscoveredPath: () => linuxDiscoveredPath,
  beginLinuxDetection: () => {
    const generation = ++linuxDetectionGeneration;
    return () => generation === linuxDetectionGeneration;
  },
  publish: (path) => publishGitExecutablePath(path),
  unpublish: (path) => clearPublishedGitExecutablePath(path),
  // Detection's cache writes are best-effort: preferences refuse writes after
  // a failed recovery (CAN-5154), and usable Git must stay usable then.
  save: async (path) => {
    try {
      await setCachedGitExecutablePath(path);
    } catch (error) {
      logGitCacheWriteFailure(error);
      publishGitExecutablePath(path.trim());
    }
  },
  clearSaved: async (savedPath) => {
    try {
      await clearCachedGitExecutablePath();
    } catch (error) {
      logGitCacheWriteFailure(error);
      // Not a reread: a write that installed '' before rejecting reads back
      // null, and unpublishing null removes any override.
      clearPublishedGitExecutablePath(savedPath);
    }
  },
  acceptLinux: (path, discovered) => {
    validatedLinuxPath = path;
    if (discovered) linuxDiscoveredPath = path;
    publishGitExecutablePath(path);
  },
  forgetLinuxDiscovery: () => forgetLinuxDiscoveredPath(),
  rememberMacValidation: (path) => {
    validatedMacPath = path;
  },
};

/**
 * A detection that answers as the live one would without changing anything:
 * its saves, publications and discovery stay in this overlay, so later reads
 * in the same detection see them. It never bumps the Linux generation.
 */
function previewDetectionState(): DetectionState {
  let saved: { value: string | null } | undefined;
  let published: { value: string | undefined } | undefined;
  let discovered: { value: string | null } | undefined;
  const readSavedPath = (): Promise<string | null> =>
    saved ? Promise.resolve(saved.value) : getCachedGitExecutablePath();
  const readPublishedPath = (): string | undefined =>
    published ? published.value : process.env.CANOPY_GIT_EXECUTABLE;
  const readLinuxDiscoveredPath = (): string | null =>
    discovered ? discovered.value : linuxDiscoveredPath;
  const unpublish = (path?: string | null): void => {
    if (!path || readPublishedPath() === path) published = { value: undefined };
  };
  const forgetLinuxDiscovery = (): void => {
    const current = readLinuxDiscoveredPath();
    if (current) unpublish(current);
    discovered = { value: null };
  };
  return {
    readSavedPath,
    readPublishedPath,
    readLinuxDiscoveredPath,
    beginLinuxDetection: () => () => true,
    publish: (path): void => {
      published = { value: path };
    },
    unpublish,
    // Only macOS and Windows detections save or clear the preference.
    save: (path): Promise<void> => {
      const trimmed = path.trim();
      if (!trimmed)
        return Promise.reject(new Error('Git executable path is required'));
      saved = { value: trimmed };
      published = { value: trimmed };
      return Promise.resolve();
    },
    clearSaved: (savedPath): Promise<void> => {
      saved = { value: null };
      unpublish(savedPath);
      return Promise.resolve();
    },
    acceptLinux: (path, isDiscovered): void => {
      if (isDiscovered) discovered = { value: path };
      published = { value: path };
    },
    forgetLinuxDiscovery,
    rememberMacValidation: () => undefined,
  };
}

async function validateAndCache(
  candidate: string,
  source: GitExecutableSource,
  wingetAvailable: boolean,
  state: DetectionState,
): Promise<GitExecutableStatus> {
  const validated = await validateCandidate(candidate, state);
  await state.save(validated.path);
  return readyStatus({
    path: validated.path,
    version: validated.version,
    source,
    wingetAvailable,
  });
}

async function getWhereExeResults(command: string): Promise<string[]> {
  try {
    const { stdout } = await execFileBuffered('where.exe', [command], {
      timeout: VALIDATION_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return parseWhereExeOutput(String(stdout));
  } catch {
    return [];
  }
}

function getCommonWindowsGitPaths(): string[] {
  return getWindowsGitCandidates({
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env['ProgramFiles(x86)'],
    localAppData: process.env.LOCALAPPDATA,
    join,
  });
}

/** Enumerate paths without ever invoking Apple's git/xcrun shims. */
async function getMacGitPaths(): Promise<string[]> {
  const loginPath = getLoginShellPath();
  // This query only reads the selection. A broken/unselected Xcode must not
  // prevent direct use of another installed toolchain.
  let developerDir: string | null = null;
  try {
    const { stdout } = await execFileBuffered(
      '/usr/bin/xcode-select',
      ['--print-path'],
      {
        timeout: VALIDATION_TIMEOUT_MS,
        maxBuffer: 4096,
      },
    );
    developerDir = stdout.trim();
  } catch {
    /* Continue with known installation paths. */
  }
  return getMacGitCandidates({
    loginPath,
    developerDir,
    paths: { join, isAbsolute },
  });
}

/** Explicit user action only. Returning means requested, never installed. */
export async function installGitWithXcode(): Promise<void> {
  if (getEffectivePlatform() !== 'darwin')
    throw new Error(
      'Apple Command Line Tools installation is only supported on macOS',
    );
  if (xcodeInstallPromise) return xcodeInstallPromise;
  xcodeInstallPromise = execFileBuffered(
    '/usr/bin/xcode-select',
    ['--install'],
    {
      timeout: VALIDATION_TIMEOUT_MS,
      maxBuffer: 8192,
    },
  )
    .then(() => undefined)
    .finally(() => {
      xcodeInstallPromise = null;
    });
  return xcodeInstallPromise;
}

/** Drop discovery state; an environment-supplied explicit path is left alone. */
function forgetLinuxDiscoveredPath(): void {
  if (linuxDiscoveredPath) clearPublishedGitExecutablePath(linuxDiscoveredPath);
  linuxDiscoveredPath = null;
  validatedLinuxPath = null;
}

function describeLinuxGitNotFound(unusable: string[]): string {
  const missing = `Git was not found on the login PATH or at ${LINUX_SYSTEM_GIT_PATH}. Install Git with your package manager, then recheck.`;
  return unusable.length > 0
    ? `Git was found but cannot be used: ${unusable.slice(0, 3).join('; ')}. Fix or reinstall Git, then recheck.`
    : missing;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Linux x64/arm64 precedence: explicit choice (reported, never replaced when broken),
 * revalidated discovery cache, refreshed login PATH, then the system location.
 * A superseded detection still returns its own result but never publishes,
 * caches or invalidates shared state.
 */
async function detectLinuxGitExecutable(
  force: boolean,
  state: DetectionState,
): Promise<GitExecutableDetection> {
  const isCurrent = state.beginLinuxDetection();
  const accept = (path: string, discovered: boolean): void => {
    if (!isCurrent()) return;
    state.acceptLinux(path, discovered);
  };

  // The user's explicit choice: the saved selection, else an override the
  // environment supplied (not a path this module published after discovery).
  const saved = await state.readSavedPath();
  const explicit = selectLinuxExplicitGitChoice({
    saved,
    override: state.readPublishedPath()?.trim(),
    discovered: state.readLinuxDiscoveredPath(),
  });
  if (explicit) {
    try {
      const validated = await validateCandidate(explicit, state);
      accept(validated.path, false);
      return ready(readyStatus({ ...validated, source: 'user-selected' }));
    } catch (error) {
      // The broken choice itself stays; nothing discovered may stand in for it.
      if (isCurrent()) state.forgetLinuxDiscovery();
      return {
        status: notFoundStatus({
          error: `Selected Git executable cannot be used. ${errorMessage(error)}`,
        }),
        issue: 'selected-unusable',
      };
    }
  }

  const unusable = new Set<string>();
  const discovered = state.readLinuxDiscoveredPath();
  if (discovered) {
    try {
      const validated = await validateCandidate(discovered, state);
      accept(validated.path, true);
      return ready(readyStatus({ ...validated, source: 'cache' }));
    } catch (error) {
      if (isCurrent()) state.forgetLinuxDiscovery();
      if (!(error instanceof GitExecutableMissingError)) {
        unusable.add(errorMessage(error));
      }
    }
  }

  await prewarmLoginShellPath(force ? { force: true } : undefined);
  for (const { path, source } of getLinuxGitCandidates(getLoginShellPath())) {
    try {
      const validated = await validateCandidate(path, state);
      accept(validated.path, true);
      return ready(readyStatus({ ...validated, source }));
    } catch (error) {
      if (!(error instanceof GitExecutableMissingError)) {
        unusable.add(errorMessage(error));
      }
    }
  }
  return {
    status: notFoundStatus({
      error: describeLinuxGitNotFound(Array.from(unusable)),
    }),
    issue: unusable.size > 0 ? 'candidate-unusable' : 'not-found',
  };
}

function ready(readyGitStatus: GitExecutableStatus): GitExecutableDetection {
  return { status: readyGitStatus, issue: null };
}

async function detectGitExecutableInternal(
  force: boolean,
  state: DetectionState,
): Promise<GitExecutableDetection> {
  const platform = getEffectivePlatform();
  const mode = getGitExecutableDetectionMode(platform, process.arch);
  if (mode === 'linux') {
    return detectLinuxGitExecutable(force, state);
  }
  if (mode === 'optional') {
    const override = state.readPublishedPath()?.trim();
    if (override) {
      try {
        const validated = await validateCandidate(override, state);
        state.publish(validated.path);
        return ready(
          status({
            ready: true,
            path: validated.path,
            version: validated.version,
            source: 'cache',
            wingetAvailable: false,
          }),
        );
      } catch (error) {
        return {
          status: notFoundStatus({
            error: error instanceof Error ? error.message : String(error),
          }),
          issue: 'selected-unusable',
        };
      }
    }
    return ready(
      status({
        ready: true,
        path: null,
        version: null,
        source: 'not-found',
        wingetAvailable: false,
      }),
    );
  }

  const winget = await detectWinget();
  // `candidate-unusable` needs a candidate that exists; missing paths alone
  // are `not-found`.
  let foundUnusable = false;
  const noteFailure = (error: unknown): void => {
    if (!isMissingCandidateError(error)) foundUnusable = true;
  };

  const cached = await state.readSavedPath();
  if (cached) {
    try {
      const validated = await validateCandidate(cached, state);
      state.publish(validated.path);
      return ready(
        readyStatus({
          path: validated.path,
          version: validated.version,
          source: 'cache',
          wingetAvailable: winget.available,
        }),
      );
    } catch (error) {
      noteFailure(error);
      await state.clearSaved(cached);
    }
  }

  // An inherited/published override can outlive its preference (or the file).
  // Validate it as well: clearing only the cached preference leaves background
  // Git operations spawning the stale executable indefinitely.
  const published = state.readPublishedPath()?.trim();
  if (published) {
    try {
      return ready(
        await validateAndCache(
          published,
          'auto-detected',
          winget.available,
          state,
        ),
      );
    } catch (error) {
      noteFailure(error);
      state.unpublish(published);
    }
  }

  const candidates =
    platform === 'win32'
      ? [...(await getWhereExeResults('git')), ...getCommonWindowsGitPaths()]
      : await getMacGitPaths();

  // The legacy message is the last discovery failure, missing or not.
  let lastError: string | undefined;
  for (const candidate of getGitExecutableProbeOrder(platform, candidates)) {
    try {
      return ready(
        await validateAndCache(
          candidate,
          'auto-detected',
          winget.available,
          state,
        ),
      );
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      noteFailure(error);
    }
  }

  return {
    status: notFoundStatus({
      wingetAvailable: winget.available,
      ...(lastError ? { error: lastError } : {}),
    }),
    issue: foundUnusable ? 'candidate-unusable' : 'not-found',
  };
}

/** The candidate path does not exist: a missing file or macOS's dangling resolution. */
function isMissingCandidateError(error: unknown): boolean {
  if (error instanceof GitExecutableMissingError) return true;
  // `validateCandidate` lets macOS's `realpath` rejection through unchanged,
  // since its message is the legacy status text.
  return (
    isErrnoException(error) &&
    error.syscall === 'realpath' &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export async function getCachedGitExecutablePath(): Promise<string | null> {
  const preferences = await readPreferencesFile();
  const cached = preferences.gitExecutablePath.trim();
  return cached.length > 0 ? cached : null;
}

export async function setCachedGitExecutablePath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('Git executable path is required');
  }
  await writePreferencesFile({ gitExecutablePath: trimmed });
  if (isLinuxGitSupported()) {
    linuxDetectionGeneration += 1;
    detectionPromise = null;
    forgetLinuxDiscoveredPath();
  }
  publishGitExecutablePath(trimmed);
}

export async function clearCachedGitExecutablePath(): Promise<void> {
  const cached = await getCachedGitExecutablePath();
  await writePreferencesFile({ gitExecutablePath: '' });
  clearPublishedGitExecutablePath(cached);
  if (isLinuxGitSupported()) {
    linuxDetectionGeneration += 1;
    detectionPromise = null;
    forgetLinuxDiscoveredPath();
  }
}

export async function validateGitExecutable(
  candidate: string,
): Promise<{ path: string; version: string }> {
  return validateCandidate(candidate, LIVE_DETECTION_STATE);
}

async function validateCandidate(
  candidate: string,
  state: DetectionState,
): Promise<{ path: string; version: string }> {
  let trimmed = candidate.trim();
  if (!trimmed) {
    throw new Error('Git executable path is required');
  }
  if (isLinuxGitSupported()) {
    return validateLinuxGitExecutable(trimmed);
  }
  if (getEffectivePlatform() === 'darwin') {
    if (!isAbsolute(trimmed))
      throw new Error('Select an absolute Git executable path');
    if (isMacGitShim(trimmed))
      throw new Error(
        'Select the installed Git binary, not the Apple or Homebrew shim',
      );
    trimmed = await realpath(trimmed);
    if (isMacGitShim(trimmed))
      throw new Error(
        'Select the installed Git binary, not the Apple or Homebrew shim',
      );
  }
  assertValidWindowsGitBasename(trimmed);
  await pathExistsAsFile(trimmed);

  const { stdout, stderr } = await execFileBuffered(trimmed, ['--version'], {
    timeout: VALIDATION_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const version = parseGitVersion(`${String(stdout)}\n${String(stderr)}`);
  if (!version) {
    throw new Error('Selected executable did not report a Git version');
  }
  if (getEffectivePlatform() === 'darwin') {
    const directory = await mkdtemp(join(tmpdir(), 'git-validation-'));
    try {
      await execFileBuffered(
        trimmed,
        ['-c', 'init.templateDir=', 'init', '--bare', directory],
        {
          timeout: VALIDATION_TIMEOUT_MS,
          maxBuffer: 8192,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) => !key.startsWith('GIT_'),
              ),
            ),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_TERMINAL_PROMPT: '0',
          },
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    state.rememberMacValidation(trimmed);
  }
  return { path: trimmed, version };
}

/** Regular file the current user may execute, then a bounded version probe. */
async function validateLinuxGitExecutable(
  candidate: string,
): Promise<{ path: string; version: string }> {
  if (!isAbsolute(candidate)) {
    throw new Error('Select an absolute Git executable path');
  }
  await pathExistsAsFile(candidate, true);
  try {
    await access(candidate, constants.X_OK);
  } catch {
    throw new Error(
      `Git executable ${candidate} is not executable by this user`,
    );
  }
  let output: { stdout: string; stderr: string };
  try {
    output = await execFileBuffered(candidate, ['--version'], {
      timeout: VALIDATION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      env: getLinuxProbeEnv(),
    });
  } catch (error) {
    throw new Error(describeLinuxProbeFailure(candidate, error));
  }
  const version = parseGitVersion(`${output.stdout}\n${output.stderr}`, {
    numeric: true,
  });
  if (!version) {
    throw new Error(
      `Git executable did not report a Git version: ${candidate}`,
    );
  }
  return { path: candidate, version };
}

function describeLinuxProbeFailure(candidate: string, error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'killed' in error &&
    error.killed === true
  ) {
    return `Git executable did not respond within ${VALIDATION_TIMEOUT_MS / 1000} seconds: ${candidate}`;
  }
  const code = isErrnoException(error) ? error.code : undefined;
  return typeof code === 'string'
    ? `Git executable could not be run (${code}): ${candidate}`
    : `Git executable failed when asked for its version: ${candidate}`;
}

/**
 * The shared live detection, with its issue for the `worker.git.executable.get`
 * projection. It applies the preference, environment and Linux effects once
 * per probe for every caller it serves.
 */
export function detectGitExecutableShared(options?: {
  force?: boolean;
}): Promise<GitExecutableDetection> {
  const force = options?.force ?? false;
  // Forced macOS rechecks share an active probe to avoid overlapping installers' checks.
  if (
    detectionPromise &&
    shouldJoinGitExecutableDetection(getEffectivePlatform(), force)
  ) {
    return detectionPromise;
  }

  const detection: Promise<GitExecutableDetection> =
    detectGitExecutableInternal(force, LIVE_DETECTION_STATE).finally(() => {
      // A superseded detection must not clear the newer one other callers share.
      if (detectionPromise === detection) detectionPromise = null;
    });
  detectionPromise = detection;
  return detection;
}

export async function detectGitExecutable(options?: {
  force?: boolean;
}): Promise<GitExecutableStatus> {
  return (await detectGitExecutableShared(options)).status;
}

/**
 * The pure `worker.git.executable.get` answer for callers outside the IPC
 * projections: a running live detection when the sharing rule lets this
 * request join it (that detection applies its effects for the caller that
 * started it), otherwise a preview that changes nothing.
 */
export function previewGitExecutable(options: {
  force: boolean;
}): Promise<GitExecutableDetection> {
  if (
    detectionPromise &&
    shouldJoinGitExecutableDetection(getEffectivePlatform(), options.force)
  ) {
    return detectionPromise;
  }
  return detectGitExecutableInternal(options.force, previewDetectionState());
}

export async function detectWinget(): Promise<{
  available: boolean;
  path: string | null;
}> {
  if (!isWindows()) {
    return { available: false, path: null };
  }
  const results = await getWhereExeResults('winget');
  return { available: results.length > 0, path: results[0] ?? null };
}

export async function installGitWithWinget(
  onProgress?: (progress: GitExecutableInstallProgress) => void,
): Promise<GitExecutableStatus> {
  if (!isWindows()) {
    throw new Error('Winget Git installation is only supported on Windows');
  }
  if (installPromise) {
    throw new Error(GIT_INSTALL_ALREADY_RUNNING_ERROR);
  }

  installPromise = (async (): Promise<GitExecutableStatus> => {
    let output = '';
    try {
      emitProgress(onProgress, {
        phase: 'starting',
        message: 'Starting Git installation...',
      });

      const winget = await detectWinget();
      if (!winget.available || !winget.path) {
        throw new Error('winget is not available on this Windows machine.');
      }
      const wingetPath = winget.path;

      emitProgress(onProgress, {
        phase: 'running',
        message: 'Installing Git with winget...',
      });

      await new Promise<void>((resolve, reject) => {
        const child = execFile(
          wingetPath,
          [
            'install',
            '--id',
            'Git.Git',
            '-e',
            '--source',
            'winget',
            '--silent',
            '--disable-interactivity',
            '--accept-package-agreements',
            '--accept-source-agreements',
          ],
          {
            windowsHide: true,
            timeout: INSTALL_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
          },
          (error: Error | null) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          },
        );
        child.stdout?.on('data', (chunk) => {
          output = appendBoundedOutput(output, chunk);
        });
        child.stderr?.on('data', (chunk) => {
          output = appendBoundedOutput(output, chunk);
        });
      });

      emitProgress(onProgress, {
        phase: 'verifying',
        message: 'Verifying Git installation...',
        ...(output ? { output } : {}),
      });

      const detected = await detectGitExecutable({ force: true });
      if (!detected.ready) {
        throw new Error(
          detected.error ?? 'Git installation could not be verified.',
        );
      }

      const success = readyStatus({
        path: detected.path ?? '',
        version: detected.version ?? '',
        source: 'winget-install',
        wingetAvailable: true,
      });
      emitProgress(onProgress, {
        phase: 'success',
        message: 'Git was installed and detected.',
        path: success.path ?? undefined,
        version: success.version ?? undefined,
        ...(output ? { output } : {}),
      });
      return success;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const baseMessage = wingetSilentInstallUnsupported(output)
        ? 'winget reported that Git cannot be installed silently. Install Git manually, then recheck.'
        : message;
      const detail = output ? `${baseMessage}\n\n${output}` : baseMessage;
      emitProgress(onProgress, {
        phase: 'failure',
        message: 'Git installation could not be completed.',
        error: detail,
        ...(output ? { output } : {}),
      });
      throw new Error(detail);
    }
  })().finally(() => {
    installPromise = null;
  });

  return installPromise;
}

/** Recover an installation removed after the startup Git check. */
export async function getResolvedGitExecutableForSpawn(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  let published = env.CANOPY_GIT_EXECUTABLE?.trim();
  if (!getGitExecutablePlatformStatus().required) return published || 'git';
  const publishedGeneration = linuxDetectionGeneration;
  if (published && isLinuxGitSupported()) {
    // The saved choice outranks whatever an environment publishes, including
    // this module's own earlier publication inherited through a copy.
    const saved = await getCachedGitExecutablePath();
    if (saved && saved !== published) published = undefined;
  }
  if (env !== process.env && published) {
    const validated = await validateGitExecutable(published);
    if (
      isLinuxGitSupported() &&
      publishedGeneration !== linuxDetectionGeneration
    ) {
      return getResolvedGitExecutableForSpawn(env);
    }
    return validated.path;
  }
  if (published) {
    try {
      if (isWindows() && (await stat(published)).isFile()) {
        return published;
      }
      if (isLinuxGitSupported()) {
        if (
          published === validatedLinuxPath &&
          (await stat(published)).isFile()
        ) {
          await access(published, constants.X_OK);
          if (publishedGeneration !== linuxDetectionGeneration) {
            return getResolvedGitExecutableForSpawn(env);
          }
          return published;
        }
      } else if (!isWindows()) {
        const resolved = await realpath(published);
        if (
          !isMacGitShim(resolved) &&
          resolved === validatedMacPath &&
          (await stat(resolved)).isFile()
        ) {
          return resolved;
        }
      }
    } catch (error) {
      // Access errors do not prove that an explicitly selected installation
      // disappeared. Preserve that configuration and surface the real error.
      const code = isErrnoException(error) ? error.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  // Detection is shared by concurrent callers, validates the replacement and
  // updates both preferences and the environment. Never install automatically.
  const detection = detectGitExecutable();
  const generation = linuxDetectionGeneration;
  const detected = await detection;
  if (isLinuxGitSupported() && generation !== linuxDetectionGeneration) {
    return getResolvedGitExecutableForSpawn(env);
  }
  if (!detected.ready || !detected.path) {
    throw new Error(
      detected.error ??
        'Git installation could not be found. Recheck Git in Settings.',
    );
  }
  return detected.path;
}
