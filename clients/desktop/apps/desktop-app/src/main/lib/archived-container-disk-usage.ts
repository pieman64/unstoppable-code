/**
 * Background disk-usage measurement for archived containers.
 *
 * An archive's measured footprint is the files under its container directory plus,
 * for Git-aware (version 2) worktree archives, the Git objects that only the
 * retained snapshot commits keep alive. The measurement runs after the
 * archive commits (and lazily for archives that predate it), then persists
 * into the manifest as `diskUsage` so list reads stay free of directory walks
 * and Git invocations. Git objects can be shared by other refs; callers must
 * not treat `gitBytes` as guaranteed reclaimable space.
 *
 * The walk deliberately runs OUTSIDE the container operation lock: a large
 * captured workspace root can take a while, and holding the lock would block
 * restore / permanent delete on that container. The read-modify-commit that
 * publishes the result takes the lock and re-reads the manifest, so a
 * container purged or restored mid-measurement simply drops the result.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ArchivedContainerDiskUsage,
  ArchivedContainerManifest,
  ArchivedGitRepositoryState,
} from '@canopy/desktop-shared/types';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import {
  broadcastArchivedContainersChanged,
  commitArchivedContainer,
  readArchivedContainerManifest,
  withArchivedContainerOperationLock,
} from './archived-containers';
import { getArchivedContainerDir } from './paths';
import { isErrnoException } from './type-guards';
import { validateId } from './validation';
import { runArchiveIoRequest } from '../archive/archive-io-runner';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 1024 * 1024;

/** Sum of file sizes under `directory` (symlinks count as themselves). */
export async function measureDirectoryBytes(
  directory: string,
): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirectoryBytes(entryPath);
      continue;
    }
    try {
      const info = await lstat(entryPath);
      if (info.isFile() || info.isSymbolicLink()) {
        total += info.size;
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    }
  }
  return total;
}

/**
 * On-disk bytes of Git objects reachable from the retained working-tree
 * snapshot (which chains through the index snapshot and the real HEAD) but
 * not from the archive-time comparison base — the objects that exist only
 * because the archive keeps its snapshot ref alive. Returns `null` when Git
 * cannot report a size (missing repository, pre-2.31 Git, timeout).
 */
export async function measureArchivedRepositoryGitBytes(
  repository: ArchivedGitRepositoryState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      await getResolvedGitExecutableForSpawn(env),
      [
        'rev-list',
        '--disk-usage',
        '--objects',
        repository.worktreeSnapshotCommit,
        '--not',
        repository.comparisonBaseCommit,
      ],
      {
        cwd: repository.referenceRepoPath,
        env: { ...env, LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1' },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: process.platform === 'win32',
      },
    );
    const bytes = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(bytes) && bytes >= 0 ? bytes : null;
  } catch {
    return null;
  }
}

export async function computeArchivedContainerDiskUsage(
  manifest: ArchivedContainerManifest,
  now = Date.now(),
): Promise<ArchivedContainerDiskUsage> {
  const filesBytes = await measureDirectoryBytes(
    getArchivedContainerDir(manifest.projectId, manifest.id),
  );
  let gitBytes = 0;
  let gitBytesComplete = true;
  if (manifest.version === 2) {
    for (const repository of manifest.gitState.repositories) {
      const measuredBytes = await measureArchivedRepositoryGitBytes(repository);
      if (measuredBytes === null) {
        gitBytesComplete = false;
      } else {
        gitBytes += measuredBytes;
      }
    }
  }
  return {
    filesBytes,
    gitBytes,
    gitBytesComplete,
    totalBytes: filesBytes + gitBytes,
    computedAt: new Date(now).toISOString(),
  };
}

/**
 * Measure and persist `diskUsage` for one committed container. Returns the
 * persisted usage, or `null` when the container disappeared before the
 * result could be published.
 */
export async function persistArchivedContainerDiskUsage(
  projectId: string,
  containerId: string,
): Promise<ArchivedContainerDiskUsage | null> {
  validateId(projectId, 'projectId');
  validateId(containerId, 'containerId');
  let manifest: ArchivedContainerManifest;
  try {
    manifest = await readArchivedContainerManifest(projectId, containerId);
  } catch {
    return null;
  }
  const computedAt = new Date().toISOString();
  const diskUsage = await runArchiveIoRequest({
    version: 1,
    type: 'measure-disk-usage',
    requestId: randomUUID(),
    operationId: `archive:${projectId}:${containerId}:measure-disk-usage`,
    projectId,
    containerId,
    expectedCreatedAt: manifest.createdAt,
    input: {
      git: {
        executable: await getResolvedGitExecutableForSpawn(process.env),
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      },
      containerDirectory: getArchivedContainerDir(projectId, containerId),
      repositories:
        manifest.version === 2 ? manifest.gitState.repositories : [],
      computedAt,
    },
  });
  return withArchivedContainerOperationLock(
    projectId,
    containerId,
    async () => {
      let current: ArchivedContainerManifest;
      try {
        current = await readArchivedContainerManifest(projectId, containerId);
      } catch {
        return null;
      }
      if (current.createdAt !== manifest.createdAt) {
        return null;
      }
      const existing = current.diskUsage;
      if (
        existing !== undefined &&
        existing.filesBytes === diskUsage.filesBytes &&
        existing.gitBytes === diskUsage.gitBytes &&
        existing.gitBytesComplete === diskUsage.gitBytesComplete &&
        existing.totalBytes === diskUsage.totalBytes
      ) {
        return existing;
      }
      await commitArchivedContainer({ ...current, diskUsage });
      broadcastArchivedContainersChanged(projectId);
      return diskUsage;
    },
  );
}

const MAX_CONCURRENT_MEASUREMENTS = 2;
const inFlightMeasurements = new Map<string, Promise<void>>();
const queuedMeasurements: Array<{
  key: string;
  projectId: string;
  containerId: string;
}> = [];
const queuedMeasurementKeys = new Set<string>();
const queuedRemeasurements = new Set<string>();
const attemptedIncompleteRetries = new Set<string>();

function drainScheduledMeasurements(): void {
  while (
    inFlightMeasurements.size < MAX_CONCURRENT_MEASUREMENTS &&
    queuedMeasurements.length > 0
  ) {
    const next = queuedMeasurements.shift();
    if (next === undefined) return;
    queuedMeasurementKeys.delete(next.key);
    const pending = persistArchivedContainerDiskUsage(
      next.projectId,
      next.containerId,
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('Failed to measure archived container disk usage.', {
          projectId: next.projectId,
          containerId: next.containerId,
          error,
        });
      })
      .finally(() => {
        if (inFlightMeasurements.get(next.key) === pending) {
          inFlightMeasurements.delete(next.key);
        }
        if (queuedRemeasurements.delete(next.key)) {
          enqueueScheduledMeasurement(
            next.key,
            next.projectId,
            next.containerId,
          );
        }
        drainScheduledMeasurements();
      });
    inFlightMeasurements.set(next.key, pending);
  }
}

function enqueueScheduledMeasurement(
  key: string,
  projectId: string,
  containerId: string,
): void {
  queuedMeasurements.push({ key, projectId, containerId });
  queuedMeasurementKeys.add(key);
  drainScheduledMeasurements();
}

/**
 * Fire-and-forget measurement, deduplicated per container so a burst of list
 * reads (or a commit followed by a list) measures once. Failures are logged
 * and never surface to the caller: a missing size is a cosmetic gap, not an
 * archive integrity problem.
 */
export function scheduleArchivedContainerDiskUsage(
  projectId: string,
  containerId: string,
  options?: { forceAfterCurrent?: boolean; retryIncomplete?: boolean },
): void {
  const key = `${projectId}:${containerId}`;
  if (options?.retryIncomplete === true) {
    if (attemptedIncompleteRetries.has(key)) {
      return;
    }
    attemptedIncompleteRetries.add(key);
  }
  if (inFlightMeasurements.has(key) || queuedMeasurementKeys.has(key)) {
    if (options?.forceAfterCurrent === true) {
      queuedRemeasurements.add(key);
    }
    return;
  }
  enqueueScheduledMeasurement(key, projectId, containerId);
}

/** Test-only: wait for every scheduled measurement to settle. */
export async function waitForScheduledArchivedContainerDiskUsage(): Promise<void> {
  while (inFlightMeasurements.size > 0 || queuedMeasurements.length > 0) {
    await Promise.all(Array.from(inFlightMeasurements.values()));
  }
}
