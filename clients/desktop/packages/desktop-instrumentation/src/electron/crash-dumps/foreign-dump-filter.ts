import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { readMinidumpExecutablePath } from './minidump';

export type CrashDumpVerdict = 'process' | 'discard';

/** Why the filter returned its verdict; one value per exit of the filter. */
export type CrashDumpVerdictReason =
  | 'unqualified_root'
  | 'outside_crash_dumps'
  | 'new_directory'
  | 'not_regular_file'
  | 'unreadable'
  | 'unqualified_executable'
  | 'not_node'
  | 'app_bundle'
  | 'short_name'
  | 'inside_app_root'
  | 'foreign_node'
  | 'error';

export interface CrashDumpClassification {
  readonly verdict: CrashDumpVerdict;
  readonly reason: CrashDumpVerdictReason;
  /**
   * Report-only: what a rule that discards every executable outside the app
   * root would return. It never changes `verdict`.
   */
  readonly locationVerdict: CrashDumpVerdict;
  /** The executable's base name, only when either verdict discards. */
  readonly executableName?: string;
}

export interface ForeignCrashDumpFilterOptions {
  readonly getCrashDumpsDir: () => string;
  readonly getExePath: () => string;
  readonly platform: NodeJS.Platform;
  readonly readExecutablePath?: typeof readMinidumpExecutablePath;
  /** Receives every classification. A throwing listener never changes it. */
  readonly onClassified?: (classification: CrashDumpClassification) => void;
}

type PlatformPath = typeof path.posix;

const MAX_EXECUTABLE_NAME_LENGTH = 64;

function getPlatformPath(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isFullyQualifiedPath(
  value: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32') {
    return path.posix.isAbsolute(value);
  }

  return (
    /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\?.][^\\]*\\[^\\]+/.test(value)
  );
}

function normalizeForComparison(
  value: string,
  platform: NodeJS.Platform,
): string {
  return platform === 'darwin' || platform === 'win32'
    ? value.toLowerCase()
    : value;
}

function isRelativePathInside(
  relativePath: string,
  pathModule: PlatformPath,
): boolean {
  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${pathModule.sep}`) &&
    !pathModule.isAbsolute(relativePath)
  );
}

function isPathWithin(
  candidate: string,
  root: string,
  platform: NodeJS.Platform,
): boolean {
  if (
    !isFullyQualifiedPath(candidate, platform) ||
    !isFullyQualifiedPath(root, platform)
  ) {
    return false;
  }

  const pathModule = getPlatformPath(platform);
  const relativePath = pathModule.relative(
    normalizeForComparison(root, platform),
    normalizeForComparison(candidate, platform),
  );
  return isRelativePathInside(relativePath, pathModule);
}

function hasDarwinAppBundleComponent(executablePath: string): boolean {
  return executablePath
    .split(path.posix.sep)
    .some((component) => component.toLowerCase().endsWith('.app'));
}

/**
 * A deliberately broad heuristic for a Windows 8.3 short-name component: it
 * also matches long names such as `build~2`. Treat a match as "cannot be
 * compared with the app root".
 */
export function hasWin32ShortNameComponent(executablePath: string): boolean {
  return executablePath
    .split(/[\\/]/)
    .some((component) => /~\d/.test(component));
}

export function resolveAppRoot(
  exePath: string,
  platform: NodeJS.Platform,
): string {
  const pathModule = getPlatformPath(platform);
  const exeDirectory = pathModule.dirname(exePath);
  if (platform !== 'darwin') {
    return exeDirectory;
  }

  let directory = exeDirectory;
  while (true) {
    if (pathModule.basename(directory).toLowerCase().endsWith('.app')) {
      return directory;
    }

    const parent = pathModule.dirname(directory);
    if (parent === directory) {
      return exeDirectory;
    }
    directory = parent;
  }
}

export function isInsideAppRoot(
  candidate: string,
  appRoot: string,
  platform: NodeJS.Platform,
): boolean {
  const pathModule = getPlatformPath(platform);
  const relativePath = pathModule.relative(
    normalizeForComparison(appRoot, platform),
    normalizeForComparison(candidate, platform),
  );
  return isRelativePathInside(relativePath, pathModule);
}

async function realpathOrUndefined(value: string): Promise<string | undefined> {
  try {
    return await realpath(value);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the nearest existing ancestor and rejoins the rest, so an
 * executable deleted since its crash still compares by its resolved parents.
 */
async function resolveExistingPrefix(
  value: string,
  pathModule: PlatformPath,
): Promise<string | undefined> {
  let ancestor = value;
  while (true) {
    const resolved = await realpathOrUndefined(ancestor);
    if (resolved !== undefined) {
      return pathModule.join(resolved, pathModule.relative(ancestor, value));
    }
    const parent = pathModule.dirname(ancestor);
    if (parent === ancestor) {
      return undefined;
    }
    ancestor = parent;
  }
}

/**
 * The location rule: discard only when the recorded executable, and its
 * resolved path when it resolves, are outside the app root and outside its
 * resolved path. Resolution can only add reasons to keep.
 */
async function getLocationVerdict(
  executablePath: string,
  appRoots: readonly string[],
  platform: NodeJS.Platform,
): Promise<CrashDumpVerdict> {
  if (platform === 'win32' && hasWin32ShortNameComponent(executablePath)) {
    return 'process';
  }
  const resolvedExecutablePath = await resolveExistingPrefix(
    executablePath,
    getPlatformPath(platform),
  );
  const candidates =
    resolvedExecutablePath === undefined
      ? [executablePath]
      : [executablePath, resolvedExecutablePath];
  const insideAppRoot = candidates.some((candidate) =>
    appRoots.some((appRoot) => isPathWithin(candidate, appRoot, platform)),
  );
  return insideAppRoot ? 'process' : 'discard';
}

function toExecutableName(
  executablePath: string,
  pathModule: PlatformPath,
): string {
  return pathModule
    .basename(executablePath)
    .replace(/[^\w .+()-]/g, '_')
    .slice(0, MAX_EXECUTABLE_NAME_LENGTH);
}

/** The enforced rule: discard only a foreign `node` outside the app root. */
function getNodeRuleVerdict(
  executablePath: string,
  appRoot: string,
  platform: NodeJS.Platform,
): [CrashDumpVerdict, CrashDumpVerdictReason] {
  const basename = getPlatformPath(platform)
    .basename(executablePath)
    .toLowerCase();
  if (
    basename !== 'node' &&
    !(platform === 'win32' && basename === 'node.exe')
  ) {
    return ['process', 'not_node'];
  }
  if (platform === 'darwin' && hasDarwinAppBundleComponent(executablePath)) {
    return ['process', 'app_bundle'];
  }
  if (platform === 'win32' && hasWin32ShortNameComponent(executablePath)) {
    return ['process', 'short_name'];
  }
  return isInsideAppRoot(executablePath, appRoot, platform)
    ? ['process', 'inside_app_root']
    : ['discard', 'foreign_node'];
}

export function createForeignCrashDumpFilter(
  options: ForeignCrashDumpFilterOptions,
): (filePath: string) => Promise<CrashDumpVerdict> {
  let cachedCrashDumpsDir: string | undefined;
  let cachedExePath: string | undefined;
  let cachedAppRoots: Promise<readonly string[]> | undefined;
  const readExecutablePath =
    options.readExecutablePath ?? readMinidumpExecutablePath;

  function getAppRoots(
    exePath: string,
    platform: NodeJS.Platform,
  ): Promise<readonly string[]> {
    cachedAppRoots ??= (async (): Promise<readonly string[]> => {
      const appRoot = resolveAppRoot(exePath, platform);
      const resolvedAppRoot = await realpathOrUndefined(appRoot);
      return resolvedAppRoot === undefined || resolvedAppRoot === appRoot
        ? [appRoot]
        : [appRoot, resolvedAppRoot];
    })();
    return cachedAppRoots;
  }

  async function classify(filePath: string): Promise<CrashDumpClassification> {
    const keep = (reason: CrashDumpVerdictReason): CrashDumpClassification => ({
      verdict: 'process',
      reason,
      locationVerdict: 'process',
    });

    if (cachedCrashDumpsDir === undefined) {
      cachedCrashDumpsDir = options.getCrashDumpsDir();
    }
    if (cachedExePath === undefined) {
      cachedExePath = options.getExePath();
    }

    const platform = options.platform;
    const pathModule = getPlatformPath(platform);
    if (
      !isFullyQualifiedPath(cachedCrashDumpsDir, platform) ||
      !isFullyQualifiedPath(cachedExePath, platform)
    ) {
      return keep('unqualified_root');
    }
    if (!isPathWithin(filePath, cachedCrashDumpsDir, platform)) {
      return keep('outside_crash_dumps');
    }

    const newDirectory = pathModule.join(cachedCrashDumpsDir, 'new');
    if (isPathWithin(filePath, newDirectory, platform)) {
      return keep('new_directory');
    }

    const fileStat = await lstat(filePath);
    if (!fileStat.isFile()) {
      return keep('not_regular_file');
    }

    const result = await readExecutablePath(filePath);
    if (result.status !== 'ok') {
      return keep('unreadable');
    }
    if (!isFullyQualifiedPath(result.executablePath, platform)) {
      return keep('unqualified_executable');
    }

    const executablePath = result.executablePath;
    const [verdict, reason] = getNodeRuleVerdict(
      executablePath,
      resolveAppRoot(cachedExePath, platform),
      platform,
    );
    const locationVerdict = await getLocationVerdict(
      executablePath,
      await getAppRoots(cachedExePath, platform),
      platform,
    );
    return {
      verdict,
      reason,
      locationVerdict,
      ...(verdict === 'discard' || locationVerdict === 'discard'
        ? { executableName: toExecutableName(executablePath, pathModule) }
        : {}),
    };
  }

  return async (filePath: string): Promise<CrashDumpVerdict> => {
    let classification: CrashDumpClassification;
    try {
      classification = await classify(filePath);
    } catch {
      classification = {
        verdict: 'process',
        reason: 'error',
        locationVerdict: 'process',
      };
    }
    try {
      options.onClassified?.(classification);
    } catch {
      // Reporting is best-effort and must not change the verdict.
    }
    return classification.verdict;
  };
}
