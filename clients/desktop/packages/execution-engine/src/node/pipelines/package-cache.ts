import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import { assertValidPipelinePackage } from './package-contract';

const SENTINEL = '.pipeline-package-digest';
const STAGING_PREFIX = '.staging-';
// Far longer than any install takes, so an install still downloading in
// another call keeps its staging directory.
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

function digestDirectoryName(digest: string): string {
  return digest.slice('pp:v1:'.length);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Removes staging directories that an install interrupted by an exit left. */
async function sweepStaleStaging(packageRoot: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(packageRoot);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const staging = path.join(packageRoot, name);
    try {
      const stats = await fs.lstat(staging);
      if (stats.isDirectory() && stats.mtimeMs < cutoff)
        await fs.rm(staging, { recursive: true, force: true });
    } catch {
      // Best effort: the next install sweeps again.
    }
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  // Windows requires write access for fsync; r+ preserves the written bytes.
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validDestination(
  destination: string,
  digest: string,
): Promise<boolean> {
  try {
    return (
      (await fs.readFile(path.join(destination, SENTINEL), 'utf8')) === digest
    );
  } catch {
    return false;
  }
}

/**
 * Package directories in use by an install that has not recorded them yet,
 * and the queue each directory's publication and removal run through. Both
 * are per process: Electron's single-instance lock keeps other writers out.
 */
const packageLeases = new Map<string, Set<symbol>>();
const packageQueues = new Map<string, Promise<void>>();

function packageDestination(packagesRoot: string, digest: string): string {
  return path.resolve(packagesRoot, 'packages', digestDirectoryName(digest));
}

async function withPackageQueue<T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = packageQueues.get(destination) ?? Promise.resolve();
  const run = previous.then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  packageQueues.set(destination, settled);
  try {
    return await run;
  } finally {
    if (packageQueues.get(destination) === settled)
      packageQueues.delete(destination);
  }
}

export interface PipelinePackageLease {
  release(): void;
}

/**
 * Keeps a package directory from being removed by another install's
 * rollback until this install has recorded it (or given up). Take it before
 * installing or verifying the package; release it once the install record is
 * written or the install is rolled back.
 */
export function leasePipelinePackage(
  packagesRoot: string,
  digest: string,
): PipelinePackageLease {
  const destination = packageDestination(packagesRoot, digest);
  const token = Symbol(destination);
  const leases = packageLeases.get(destination) ?? new Set<symbol>();
  leases.add(token);
  packageLeases.set(destination, leases);
  return {
    release(): void {
      const current = packageLeases.get(destination);
      current?.delete(token);
      if (current?.size === 0) packageLeases.delete(destination);
    },
  };
}

/**
 * A rollback's removal of the package directory it created at
 * `destination` (as `onCreated` reported it). The directory stays when an
 * install record names it (`isRecorded`) or another install holds a lease on
 * it; the check and the removal run in the directory's queue, so no install
 * verifies the directory while it is being removed. `lease` is the caller's
 * own, which does not count. True when removed.
 */
export async function removePipelinePackageUnlessRetained(input: {
  destination: string;
  lease?: PipelinePackageLease;
  isRecorded(): Promise<boolean>;
}): Promise<boolean> {
  const destination = path.resolve(input.destination);
  input.lease?.release();
  const leased = (): boolean => (packageLeases.get(destination)?.size ?? 0) > 0;
  return withPackageQueue(destination, async () => {
    if (leased() || (await input.isRecorded())) return false;
    // A lease taken while the record lookup ran also keeps it.
    if (leased()) return false;
    await fs.rm(destination, { recursive: true, force: true });
    return true;
  });
}

export interface InstallPipelinePackageInput {
  packagesRoot: string;
  digest: string;
  manifest: PipelinePackageManifestV1;
  fetchBlob(sha256: string): Promise<Uint8Array>;
  beforeCommit?(): Promise<void>;
  onCreated?(destination: string): void;
}

export async function installPipelinePackageAtomically(
  input: InstallPipelinePackageInput,
): Promise<string> {
  assertValidPipelinePackage(input.manifest, input.digest);
  const destination = packageDestination(input.packagesRoot, input.digest);
  return withPackageQueue(destination, () =>
    installPackageDirectory(input, destination),
  );
}

async function installPackageDirectory(
  input: InstallPipelinePackageInput,
  destination: string,
): Promise<string> {
  const packageRoot = path.dirname(destination);
  if (await exists(destination)) {
    if (await verifyPackageDirectory(destination, input.digest)) {
      return destination;
    }
    await fs.rm(destination, { recursive: true, force: true });
  }
  await fs.mkdir(packageRoot, { recursive: true });
  await sweepStaleStaging(packageRoot);
  const staging = path.join(packageRoot, `${STAGING_PREFIX}${randomUUID()}`);
  await fs.mkdir(path.join(staging, 'blobs'), { recursive: true });
  try {
    const entriesByHash = new Map<string, number>();
    for (const resource of input.manifest.resources) {
      for (const tree of resource.trees) {
        for (const entry of tree.entries) {
          entriesByHash.set(entry.sha256, entry.size);
        }
      }
    }
    for (const [sha256, size] of Array.from(entriesByHash.entries())) {
      const bytes = await input.fetchBlob(sha256);
      if (bytes.byteLength !== size)
        throw new Error(`Pipeline package blob ${sha256} has the wrong size`);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new Error(`Pipeline package blob ${sha256} failed verification`);
      const blobPath = path.join(staging, 'blobs', sha256);
      await fs.writeFile(blobPath, bytes, { flag: 'wx' });
      await fsyncFile(blobPath);
    }
    for (const resource of input.manifest.resources) {
      for (const tree of resource.trees) {
        const treeRoot = path.join(
          staging,
          'materialized',
          resource.id,
          tree.provider,
          tree.rootName,
        );
        for (const entry of tree.entries) {
          const destinationPath = path.join(treeRoot, ...entry.path.split('/'));
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await fs.copyFile(
            path.join(staging, 'blobs', entry.sha256),
            destinationPath,
          );
          await fs.chmod(
            destinationPath,
            entry.mode === 'execute' ? 0o700 : 0o600,
          );
        }
      }
    }
    const manifestPath = path.join(staging, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(input.manifest), 'utf8');
    await fsyncFile(manifestPath);
    const sentinelPath = path.join(staging, SENTINEL);
    await fs.writeFile(sentinelPath, input.digest, 'utf8');
    await fsyncFile(sentinelPath);
    if (await exists(destination)) {
      if (await verifyPackageDirectory(destination, input.digest)) {
        return destination;
      }
      await fs.rm(destination, { recursive: true, force: true });
    }
    await input.beforeCommit?.();
    try {
      await fs.rename(staging, destination);
      input.onCreated?.(destination);
    } catch (error) {
      if (await verifyPackageDirectory(destination, input.digest)) {
        return destination;
      }
      throw error;
    }
    return destination;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/**
 * The verified manifest of a cached package directory, or null. It runs in
 * the directory's queue, so it never verifies a directory a rollback is
 * removing or an install is still publishing.
 */
export async function verifyCachedPipelinePackage(
  packagePath: string,
  digest: string,
): Promise<PipelinePackageManifestV1 | null> {
  return withPackageQueue(path.resolve(packagePath), () =>
    verifyPackageDirectory(packagePath, digest),
  );
}

async function verifyPackageDirectory(
  packagePath: string,
  digest: string,
): Promise<PipelinePackageManifestV1 | null> {
  if (!(await validDestination(packagePath, digest))) return null;
  try {
    const manifest: unknown = JSON.parse(
      await fs.readFile(path.join(packagePath, 'manifest.json'), 'utf8'),
    );
    assertValidPipelinePackage(manifest, digest);
    const verifiedHashes = new Set<string>();
    for (const resource of manifest.resources) {
      for (const tree of resource.trees) {
        for (const entry of tree.entries) {
          if (!verifiedHashes.has(entry.sha256)) {
            const blob = await fs.readFile(
              path.join(packagePath, 'blobs', entry.sha256),
            );
            if (
              blob.byteLength !== entry.size ||
              createHash('sha256').update(blob).digest('hex') !== entry.sha256
            ) {
              return null;
            }
            verifiedHashes.add(entry.sha256);
          }
          const materialized = await fs.readFile(
            path.join(
              packagePath,
              'materialized',
              resource.id,
              tree.provider,
              tree.rootName,
              ...entry.path.split('/'),
            ),
          );
          if (
            materialized.byteLength !== entry.size ||
            createHash('sha256').update(materialized).digest('hex') !==
              entry.sha256
          ) {
            return null;
          }
        }
      }
    }
    return manifest;
  } catch {
    return null;
  }
}
