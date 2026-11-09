import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertOwnedStorageDirectory } from './build-storage-startup';
import { BuildStorageStartupRefused } from '@canopy/core-runtime/node/build-storage-startup';

function directory(path: string): Stats | undefined {
  return assertOwnedStorageDirectory(path).stat;
}

function assertUnchangedDirectory(
  path: string,
  before: Stats | undefined,
): void {
  const after = directory(path);
  if (before?.dev !== after?.dev || before?.ino !== after?.ino)
    throw new BuildStorageStartupRefused(
      'secure-relocation-unsafe',
      'Secure storage changed during startup. Quit all app, CLI and daemon processes, then start the app or CLI again.',
    );
}

async function verifyTree(path: string): Promise<void> {
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const info = await lstat(child);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new BuildStorageStartupRefused(
        'secure-relocation-unsafe',
        'Secure storage contains an alias or unsupported file. Resolve it explicitly before starting.',
      );
    if (info.isDirectory()) await verifyTree(child);
  }
}

/**
 * Caller holds its startup exclusion and proves the daemon is not accepting.
 * Internal migration supplies its transaction's cold proof through the same port.
 * A single rename preserves ciphertext, inode permissions and every SQLite member.
 */
export async function relocateSecureStorage(options: {
  readonly historical: string;
  readonly dataRoot: string;
  readonly assertCold: () => Promise<void>;
}): Promise<'absent' | 'current' | 'moved'> {
  const source = resolve(options.historical);
  const root = resolve(options.dataRoot);
  const destination = join(root, 'secure-storage');
  if (source === root || dirname(source) !== dirname(root))
    throw new BuildStorageStartupRefused(
      'secure-relocation-unsafe',
      'Secure storage is not a same-build sibling. Resolve it explicitly before starting.',
    );
  const sourcePresent = directory(source);
  const rootPresent = directory(root);
  const destinationPresent = rootPresent ? directory(destination) : undefined;
  if (!sourcePresent) return destinationPresent ? 'current' : 'absent';
  if (destinationPresent && (await readdir(destination)).length > 0)
    throw new BuildStorageStartupRefused(
      'secure-relocation-conflict',
      'Both secure folders contain data. Resolve the conflict explicitly; neither folder was changed.',
    );
  await options.assertCold();
  await verifyTree(source);
  // The cold probe and tree walk yield: do not adopt paths exchanged meanwhile.
  assertUnchangedDirectory(source, sourcePresent);
  assertUnchangedDirectory(root, rootPresent);
  assertUnchangedDirectory(destination, destinationPresent);
  // Reject aliased parents even on a fresh installation, before mkdir.
  directory(dirname(root));
  try {
    if (!rootPresent) await mkdir(root, { mode: 0o700 });
    if (destinationPresent) await rmdir(destination);
    await rename(source, destination);
  } catch {
    throw new BuildStorageStartupRefused(
      'secure-relocation-unsafe',
      'Secure storage could not move atomically. Quit all app, CLI and daemon processes and resolve the filesystem conflict; copying is not supported.',
    );
  }
  return 'moved';
}
