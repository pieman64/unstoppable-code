import { lstat } from 'node:fs/promises';
import * as path from 'node:path';
import { readMinidumpExecutablePath } from './minidump';

export type CrashDumpVerdict = 'process' | 'discard';

export interface ForeignCrashDumpFilterOptions {
  readonly getCrashDumpsDir: () => string;
  readonly getExePath: () => string;
  readonly platform: NodeJS.Platform;
  readonly readExecutablePath?: typeof readMinidumpExecutablePath;
}

type PlatformPath = typeof path.posix;

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

function hasWin32ShortNameComponent(executablePath: string): boolean {
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

export function createForeignCrashDumpFilter(
  options: ForeignCrashDumpFilterOptions,
): (filePath: string) => Promise<CrashDumpVerdict> {
  let cachedCrashDumpsDir: string | undefined;
  let cachedExePath: string | undefined;
  const readExecutablePath =
    options.readExecutablePath ?? readMinidumpExecutablePath;

  return async (filePath: string): Promise<CrashDumpVerdict> => {
    try {
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
        !isFullyQualifiedPath(cachedExePath, platform) ||
        !isPathWithin(filePath, cachedCrashDumpsDir, platform)
      ) {
        return 'process';
      }

      const newDirectory = pathModule.join(cachedCrashDumpsDir, 'new');
      if (isPathWithin(filePath, newDirectory, platform)) {
        return 'process';
      }

      const fileStat = await lstat(filePath);
      if (!fileStat.isFile()) {
        return 'process';
      }

      const result = await readExecutablePath(filePath);
      if (
        result.status !== 'ok' ||
        !isFullyQualifiedPath(result.executablePath, platform)
      ) {
        return 'process';
      }

      const executablePath = result.executablePath;
      const basename = pathModule.basename(executablePath).toLowerCase();
      if (
        basename !== 'node' &&
        !(platform === 'win32' && basename === 'node.exe')
      ) {
        return 'process';
      }

      if (
        (platform === 'darwin' &&
          hasDarwinAppBundleComponent(executablePath)) ||
        (platform === 'win32' && hasWin32ShortNameComponent(executablePath))
      ) {
        return 'process';
      }

      const appRoot = resolveAppRoot(cachedExePath, platform);
      return isInsideAppRoot(executablePath, appRoot, platform)
        ? 'process'
        : 'discard';
    } catch {
      return 'process';
    }
  };
}
