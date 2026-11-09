import { execFile } from 'node:child_process';
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  hostPlatformOperatingSystem,
  PlatformServicesError,
} from '@canopy/core-platform';
import { getCanopyRuntimeMode } from '@canopy/desktop-shared/canopy-paths';
import { BRAND } from '@canopy/brand/current';
import { findExecutableOnPath } from '@canopy/execution-engine/node/lib/path-lookup';
import {
  IPC_CHANNELS,
  type CliInstallResult,
  type CliPathStatus,
  type CliPathUnsupportedReason,
} from '@canopy/desktop-shared/types';
import { getBundledCanopyCliPath } from '../pipelines/config-paths';
import { registerIpcHandler } from './register';
import { createLinuxCliInstaller } from './linux-cli-install';

const execFileAsync = promisify(execFile);
const CLI_LINK_DIR = '/usr/local/bin';
const CLI_LINK_PATH = path.join(CLI_LINK_DIR, BRAND.cliName);
const WINDOWS_ENV_KEY = 'HKCU\\Environment';
const WINDOWS_PATH_VALUE = 'Path';

// Only the E2E bundle may substitute a tiny packaged distribution and an
// isolated home. Status, actions and persistence still use the real installer.
function getE2eLinuxCliRoot(): string | null {
  return typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__
    ? process.env.CANOPY_E2E_LINUX_CLI_ROOT || null
    : null;
}

function getLinuxInstaller(): ReturnType<typeof createLinuxCliInstaller> {
  const root = getE2eLinuxCliRoot();
  return createLinuxCliInstaller(
    root
      ? {
          bundledCliPath: path.join(
            root,
            'package/resources/cli',
            BRAND.cliName,
          ),
          homeDir: path.join(root, 'home'),
          env: {
            XDG_DATA_HOME: path.join(root, 'data'),
            XDG_BIN_HOME: path.join(root, 'bin'),
          },
        }
      : { bundledCliPath: getBundledCanopyCliPath() },
  );
}

function getCliOperatingSystem(): ReturnType<
  typeof hostPlatformOperatingSystem
> | null {
  if (getE2eLinuxCliRoot()) return 'linux';
  try {
    return hostPlatformOperatingSystem();
  } catch (error) {
    if (
      error instanceof PlatformServicesError &&
      error.code === 'unsupported_platform'
    ) {
      return null;
    }
    throw error;
  }
}

function getUnsupportedReason(): CliPathUnsupportedReason | null {
  if (getCanopyRuntimeMode() === 'dev' && !getE2eLinuxCliRoot()) {
    return 'dev';
  }

  if (getCliOperatingSystem() === null) {
    return 'unsupported-platform';
  }

  return null;
}

function getUnsupportedStatus(reason: CliPathUnsupportedReason): CliPathStatus {
  const operatingSystem = getCliOperatingSystem();
  const bundledCliPath =
    operatingSystem === 'darwin' || operatingSystem === 'win32'
      ? getBundledCanopyCliPath()
      : null;

  return {
    state: 'unsupported',
    reason,
    symlinkPath: operatingSystem === 'darwin' ? CLI_LINK_PATH : null,
    symlinkTarget: null,
    bundledCliPath,
    managedPathEntry:
      operatingSystem === 'win32' && bundledCliPath
        ? path.dirname(bundledCliPath)
        : undefined,
  };
}

function normalizeSymlinkTarget(targetPath: string): string {
  return path.normalize(path.resolve(path.dirname(CLI_LINK_PATH), targetPath));
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (Reflect.get(error, 'code') === 'EACCES' ||
      Reflect.get(error, 'code') === 'EPERM')
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return 'Unknown error';
}

async function runPrivilegedShellCommand(command: string): Promise<void> {
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  const shellCommand = `/usr/bin/printf %s ${JSON.stringify(encodedCommand)} | /usr/bin/base64 -D | /bin/bash`;
  const appleScript =
    'do shell script ' +
    JSON.stringify(shellCommand) +
    ' with administrator privileges';

  await execFileAsync('/usr/bin/osascript', ['-e', appleScript], {
    windowsHide: getCliOperatingSystem() === 'win32',
  });
}

function buildInstallShellCommand(bundledCliPath: string): string {
  const quotedBundledCliPath = JSON.stringify(bundledCliPath);
  const quotedLinkPath = JSON.stringify(CLI_LINK_PATH);
  const quotedLinkDir = JSON.stringify(CLI_LINK_DIR);

  return [
    `if [ -L ${quotedLinkPath} ]; then`,
    `  current_target="$(readlink ${quotedLinkPath})"`,
    `  resolved_current="$(cd ${quotedLinkDir} && realpath "$current_target" 2>/dev/null || printf '%s' "$current_target")"`,
    `  resolved_bundled="$(realpath ${quotedBundledCliPath} 2>/dev/null || printf '%s' ${quotedBundledCliPath})"`,
    `  if [ "$resolved_current" != "$resolved_bundled" ]; then`,
    `    echo "Refusing to overwrite existing symlink at ${CLI_LINK_PATH}" >&2`,
    '    exit 1',
    '  fi',
    `elif [ -e ${quotedLinkPath} ]; then`,
    `  echo "Refusing to overwrite existing file at ${CLI_LINK_PATH}" >&2`,
    '  exit 1',
    'fi',
    `mkdir -p ${quotedLinkDir}`,
    `ln -sf ${quotedBundledCliPath} ${quotedLinkPath}`,
  ].join('\n');
}

function buildUninstallShellCommand(bundledCliPath: string): string {
  const quotedBundledCliPath = JSON.stringify(bundledCliPath);
  const quotedLinkPath = JSON.stringify(CLI_LINK_PATH);
  const quotedLinkDir = JSON.stringify(CLI_LINK_DIR);

  return [
    `if [ ! -L ${quotedLinkPath} ]; then`,
    '  exit 0',
    'fi',
    `current_target="$(readlink ${quotedLinkPath})"`,
    `resolved_current="$(cd ${quotedLinkDir} && realpath "$current_target" 2>/dev/null || printf '%s' "$current_target")"`,
    `resolved_bundled="$(realpath ${quotedBundledCliPath} 2>/dev/null || printf '%s' ${quotedBundledCliPath})"`,
    `if [ "$resolved_current" != "$resolved_bundled" ]; then`,
    `  echo "Refusing to remove unmanaged entry at ${CLI_LINK_PATH}" >&2`,
    '  exit 1',
    'fi',
    `rm ${quotedLinkPath}`,
  ].join('\n');
}

function getUnsupportedErrorMessage(reason: CliPathUnsupportedReason): string {
  return reason === 'dev'
    ? 'CLI PATH installation is unavailable in development mode.'
    : 'CLI PATH installation is only available on macOS, Windows, and Linux.';
}

export function splitWindowsPathEntries(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeWindowsPathEntry(value: string): string {
  return path.win32
    .normalize(value.replace(/^"+|"+$/g, ''))
    .replace(/[\\/]+$/g, '')
    .toLowerCase();
}

export function windowsPathContainsEntry(
  pathValue: string,
  entry: string,
): boolean {
  const normalizedEntry = normalizeWindowsPathEntry(entry);
  return splitWindowsPathEntries(pathValue).some(
    (current) => normalizeWindowsPathEntry(current) === normalizedEntry,
  );
}

export function addWindowsPathEntry(pathValue: string, entry: string): string {
  if (windowsPathContainsEntry(pathValue, entry)) {
    return pathValue;
  }
  const entries = splitWindowsPathEntries(pathValue);
  entries.push(entry);
  return entries.join(';');
}

export function removeWindowsPathEntry(
  pathValue: string,
  entry: string,
): string {
  const normalizedEntry = normalizeWindowsPathEntry(entry);
  return splitWindowsPathEntries(pathValue)
    .filter((current) => normalizeWindowsPathEntry(current) !== normalizedEntry)
    .join(';');
}

function getWindowsManagedPathEntry(): string {
  return path.win32.dirname(getBundledCanopyCliPath());
}

function getPowerShellCommand(): string | null {
  return (
    findExecutableOnPath('pwsh.exe') ?? findExecutableOnPath('powershell.exe')
  );
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getRawUserPathPowerShellCommand(): string {
  return [
    '$environment = Get-Item -LiteralPath HKCU:\\Environment',
    `$environment.GetValue(${quotePowerShellString(WINDOWS_PATH_VALUE)}, '', 'DoNotExpandEnvironmentNames')`,
  ].join('; ');
}

function getWriteUserPathPowerShellCommand(nextPath: string): string {
  return [
    'Set-ItemProperty',
    '-LiteralPath HKCU:\\Environment',
    `-Name ${quotePowerShellString(WINDOWS_PATH_VALUE)}`,
    `-Value ${quotePowerShellString(nextPath)}`,
    '-Type ExpandString',
  ].join(' ');
}

function applyManagedEntryToCurrentProcessPath(
  managedEntry: string,
  installed: boolean,
): void {
  const currentPath = process.env.Path ?? process.env.PATH ?? '';
  const nextPath = installed
    ? addWindowsPathEntry(currentPath, managedEntry)
    : removeWindowsPathEntry(currentPath, managedEntry);
  process.env.Path = nextPath;
  process.env.PATH = nextPath;
}

async function broadcastWindowsEnvironmentChange(
  powershell: string | null,
): Promise<void> {
  if (!powershell) {
    return;
  }

  const command = [
    "$signature = @'",
    '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
    'public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.IntPtr lpdwResult);',
    "'@",
    "if (-not ('Win32.NativeMethods' -as [type])) { Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition $signature }",
    '$result = [IntPtr]::Zero',
    '[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result) | Out-Null',
  ].join('; ');

  try {
    await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-Command', command],
      {
        windowsHide: true,
      },
    );
  } catch {
    // PATH writes already succeeded; broadcasting is a best-effort refresh.
  }
}

async function readWindowsUserPath(): Promise<string> {
  const powershell = getPowerShellCommand();
  if (powershell) {
    const { stdout } = await execFileAsync(
      powershell,
      ['-NoLogo', '-NoProfile', '-Command', getRawUserPathPowerShellCommand()],
      {
        windowsHide: true,
      },
    );
    return stdout.trim();
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'reg',
      ['query', WINDOWS_ENV_KEY, '/v', WINDOWS_PATH_VALUE],
      { windowsHide: true },
    ));
  } catch (error) {
    if (isMissingWindowsRegistryValueError(error)) {
      return '';
    }
    throw error;
  }
  const line = stdout
    .split(/\r?\n/)
    .map((segment) => segment.trim())
    .find((segment) => segment.startsWith(WINDOWS_PATH_VALUE));
  if (!line) {
    return '';
  }
  const match = line.match(/^Path\s+REG_\w+\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function isMissingWindowsRegistryValueError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return (
    message.includes('unable to find') ||
    message.includes('the system was unable to find')
  );
}

async function writeWindowsUserPath(nextPath: string): Promise<void> {
  const powershell = getPowerShellCommand();
  if (powershell) {
    await execFileAsync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        getWriteUserPathPowerShellCommand(nextPath),
      ],
      {
        windowsHide: true,
      },
    );
    await broadcastWindowsEnvironmentChange(powershell);
    return;
  }

  await execFileAsync(
    'reg',
    [
      'add',
      WINDOWS_ENV_KEY,
      '/v',
      WINDOWS_PATH_VALUE,
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      nextPath,
      '/f',
    ],
    { windowsHide: true },
  );
  await broadcastWindowsEnvironmentChange(getPowerShellCommand());
}

async function getWindowsCliPathStatus(): Promise<CliPathStatus> {
  const bundledCliPath = getBundledCanopyCliPath();
  const managedPathEntry = getWindowsManagedPathEntry();
  const currentPath = await readWindowsUserPath();

  return {
    state: windowsPathContainsEntry(currentPath, managedPathEntry)
      ? 'installed'
      : 'missing',
    symlinkPath: null,
    symlinkTarget: null,
    bundledCliPath,
    managedPathEntry,
  };
}

export async function getCliPathStatus(): Promise<CliPathStatus> {
  const unsupportedReason = getUnsupportedReason();
  if (unsupportedReason) {
    return getUnsupportedStatus(unsupportedReason);
  }

  if (getCliOperatingSystem() === 'win32') {
    return getWindowsCliPathStatus();
  }

  if (getCliOperatingSystem() === 'linux') {
    return getLinuxInstaller().getStatus();
  }

  const bundledCliPath = getBundledCanopyCliPath();

  try {
    const stat = await lstat(CLI_LINK_PATH);
    if (!stat.isSymbolicLink()) {
      return {
        state: 'regular-file',
        symlinkPath: CLI_LINK_PATH,
        symlinkTarget: null,
        bundledCliPath,
      };
    }

    const symlinkTarget = await readlink(CLI_LINK_PATH);
    const isManagedSymlink =
      normalizeSymlinkTarget(symlinkTarget) === path.normalize(bundledCliPath);

    return {
      state: isManagedSymlink ? 'correct-symlink' : 'foreign-symlink',
      symlinkPath: CLI_LINK_PATH,
      symlinkTarget,
      bundledCliPath,
    };
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      return {
        state: 'missing',
        symlinkPath: CLI_LINK_PATH,
        symlinkTarget: null,
        bundledCliPath,
      };
    }

    throw error;
  }
}

export async function installCliToPath(): Promise<CliInstallResult> {
  const unsupportedReason = getUnsupportedReason();
  if (unsupportedReason) {
    return {
      success: false,
      error: getUnsupportedErrorMessage(unsupportedReason),
    };
  }

  if (getCliOperatingSystem() === 'linux') {
    return getLinuxInstaller().install();
  }

  const status = await getCliPathStatus();
  if (getCliOperatingSystem() === 'win32') {
    if (status.state === 'installed') {
      return { success: true, error: null };
    }
    const managedPathEntry = getWindowsManagedPathEntry();
    try {
      const currentPath = await readWindowsUserPath();
      await writeWindowsUserPath(
        addWindowsPathEntry(currentPath, managedPathEntry),
      );
      applyManagedEntryToCurrentProcessPath(managedPathEntry, true);
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Failed to install ${BRAND.displayName} to PATH: ${getErrorMessage(error)}`,
      };
    }
  }

  if (status.state === 'correct-symlink') {
    return { success: true, error: null };
  }
  if (status.state === 'foreign-symlink' || status.state === 'regular-file') {
    return {
      success: false,
      error: `${CLI_LINK_PATH} is already occupied. Remove it manually before installing ${BRAND.displayName} to PATH.`,
    };
  }

  const bundledCliPath = getBundledCanopyCliPath();

  try {
    await mkdir(CLI_LINK_DIR, { recursive: true });
    await symlink(bundledCliPath, CLI_LINK_PATH);
    return { success: true, error: null };
  } catch (error: unknown) {
    if (!isPermissionError(error)) {
      if (
        typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === 'EEXIST'
      ) {
        const refreshedStatus = await getCliPathStatus();
        if (refreshedStatus.state === 'correct-symlink') {
          return { success: true, error: null };
        }
      }

      return {
        success: false,
        error: `Failed to install ${BRAND.displayName} to PATH: ${getErrorMessage(error)}`,
      };
    }

    try {
      await runPrivilegedShellCommand(buildInstallShellCommand(bundledCliPath));
      return { success: true, error: null };
    } catch (escalationError: unknown) {
      return {
        success: false,
        error: `Failed to install ${BRAND.displayName} to PATH: ${getErrorMessage(escalationError)}`,
      };
    }
  }
}

export async function uninstallCliFromPath(): Promise<CliInstallResult> {
  const unsupportedReason = getUnsupportedReason();
  if (unsupportedReason) {
    return {
      success: false,
      error: getUnsupportedErrorMessage(unsupportedReason),
    };
  }

  if (getCliOperatingSystem() === 'linux') {
    return getLinuxInstaller().uninstall();
  }

  const status = await getCliPathStatus();
  if (getCliOperatingSystem() === 'win32') {
    if (status.state === 'missing') {
      return { success: true, error: null };
    }
    const managedPathEntry = getWindowsManagedPathEntry();
    try {
      const currentPath = await readWindowsUserPath();
      await writeWindowsUserPath(
        removeWindowsPathEntry(currentPath, managedPathEntry),
      );
      applyManagedEntryToCurrentProcessPath(managedPathEntry, false);
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: `Failed to remove ${BRAND.displayName} from PATH: ${getErrorMessage(error)}`,
      };
    }
  }

  if (status.state === 'missing') {
    return { success: true, error: null };
  }
  if (status.state !== 'correct-symlink') {
    return {
      success: false,
      error: `${CLI_LINK_PATH} is not managed by ${BRAND.displayName} and will not be removed automatically.`,
    };
  }

  const bundledCliPath = getBundledCanopyCliPath();

  try {
    await unlink(CLI_LINK_PATH);
    return { success: true, error: null };
  } catch (error: unknown) {
    if (!isPermissionError(error)) {
      if (isMissingPathError(error)) {
        return { success: true, error: null };
      }

      return {
        success: false,
        error: `Failed to remove ${BRAND.displayName} from PATH: ${getErrorMessage(error)}`,
      };
    }

    try {
      await runPrivilegedShellCommand(
        buildUninstallShellCommand(bundledCliPath),
      );
      return { success: true, error: null };
    } catch (escalationError: unknown) {
      return {
        success: false,
        error: `Failed to remove ${BRAND.displayName} from PATH: ${getErrorMessage(escalationError)}`,
      };
    }
  }
}

export function registerCliHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.cliGetStatus,
    async (): Promise<CliPathStatus> => getCliPathStatus(),
  );
  registerIpcHandler(
    IPC_CHANNELS.cliInstallToPath,
    async (): Promise<CliInstallResult> => installCliToPath(),
  );
  registerIpcHandler(
    IPC_CHANNELS.cliUninstallFromPath,
    async (): Promise<CliInstallResult> => uninstallCliFromPath(),
  );
}
