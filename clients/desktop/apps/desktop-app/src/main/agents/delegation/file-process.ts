import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  DELEGATION_FILE_DEFAULT_BYTES,
  NativeDelegationFiles,
  validDelegationFileBytes,
  type DelegationFileLimits,
} from '@canopy/desktop-shared/node/delegation/file-access';
import { getBundledDelegationFileBrokerPath } from '../../pipelines/config-paths';
import { spawnClaudeCodeProcessOffMain } from '../claude-process-host-runner';
import { delegationStopSignal } from './stop-signal';

export function delegationFileBinary(): string {
  return getBundledDelegationFileBrokerPath();
}

export async function delegationFileBoundaryAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'win32')
    return false;
  try {
    const stat = await fs.lstat(delegationFileBinary());
    return stat.isFile() && stat.nlink === 1 && stat.size > 0;
  } catch {
    return false;
  }
}

/** The filesystem calls root canonicalization needs; injectable for tests. */
export interface DelegationRootFileSystem {
  realpath(directory: string): Promise<string>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean }>;
}

/** Resolve a delegation root, refusing one that traverses a link. POSIX roots
 * must equal their realpath (after macOS /var and /tmp aliases). Windows
 * realpath also expands 8.3 short names and normalizes case, so a Windows root
 * is instead checked component by component: no symlink or junction from the
 * drive root down. The native broker repeats this per component. */
export async function canonicalDelegationRoot(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  fsApi: DelegationRootFileSystem = fs,
  pathApi: Pick<typeof path, 'resolve' | 'dirname'> = path,
): Promise<string> {
  const canonical = await fsApi.realpath(directory);
  const absolute = pathApi.resolve(directory);
  if (platform === 'win32') {
    for (let current = absolute; ; current = pathApi.dirname(current)) {
      if ((await fsApi.lstat(current)).isSymbolicLink())
        throw new Error('Delegation roots cannot traverse symbolic links');
      if (pathApi.dirname(current) === current) break;
    }
    return canonical;
  }
  const expected =
    platform === 'darwin'
      ? absolute.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1')
      : absolute;
  if (canonical !== expected)
    throw new Error('Delegation roots cannot traverse symbolic links');
  return canonical;
}

/** Fixed packaged helper, launched through the existing off-main process host.
 * The helper enforces the same per-file bound as the returned client. */
export async function openDelegationFiles(
  directory: string,
  signal: AbortSignal,
  limits: DelegationFileLimits = {},
): Promise<NativeDelegationFiles> {
  if (!validDelegationFileBytes(limits.fileBytes))
    throw new Error('Invalid delegated file bound.');
  return openNativeFiles(directory, signal, limits);
}

export async function openPortalAssetFiles(
  directory: string,
  signal: AbortSignal,
): Promise<NativeDelegationFiles> {
  return openNativeFiles(
    directory,
    signal,
    { fileBytes: 197_632, totalBytes: 104_857_600 + 197_632 },
    true,
  );
}

async function openNativeFiles(
  directory: string,
  signal: AbortSignal,
  limits: DelegationFileLimits,
  assetReadonly = false,
): Promise<NativeDelegationFiles> {
  const canonical = await canonicalDelegationRoot(directory);
  if (signal.aborted || !(await delegationFileBoundaryAvailable()))
    throw new Error('The delegated file boundary is unavailable');
  // Host selection goes through core-platform (platform boundary check).
  const hostOs = hostPlatformOperatingSystem();
  const environment: Record<string, string> = {
    PATH: '',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    TMP: os.tmpdir(),
    TEMP: os.tmpdir(),
  };
  if (hostOs === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot))
      throw new Error('Windows system directory is unavailable');
    environment.SystemRoot = systemRoot;
    environment.WINDIR = systemRoot;
  }
  const child = spawnClaudeCodeProcessOffMain({
    command: delegationFileBinary(),
    args: assetReadonly
      ? [canonical, '--asset-readonly']
      : limits.fileBytes === undefined ||
          limits.fileBytes === DELEGATION_FILE_DEFAULT_BYTES
        ? [canonical]
        : [canonical, String(limits.fileBytes)],
    cwd: canonical,
    env: environment,
    signal,
  });
  child.stdin.on('error', () => undefined);
  child.on('error', () => undefined);
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  return NativeDelegationFiles.open(
    {
      stdin: child.stdin,
      stdout: child.stdout,
      exited,
      terminate: () => {
        child.kill(delegationStopSignal());
      },
    },
    signal,
    limits,
    hostOs,
  );
}
