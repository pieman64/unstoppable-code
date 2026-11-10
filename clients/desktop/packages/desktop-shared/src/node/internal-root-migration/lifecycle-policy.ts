import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isArchivedContainerManifest } from '../../lib/archived-container-contracts';
import {
  isArchiveCleanupPhase,
  type DestructiveRecoveryRecord,
} from '../w5-destructive-journal';
import { statIfPresent } from './filesystem';

export type InertArchiveGroup = 'pre-quarantine' | 'committed-cleanup-tail';

export function isInertArchiveCandidate(
  record: DestructiveRecoveryRecord,
): boolean {
  return (
    record.state === 'recovery-required' &&
    record.operation === 'worktree-archive' &&
    record.parentOperation === undefined &&
    !!record.worktreeId &&
    !!record.createdAt &&
    /^[A-Za-z0-9_-]+$/.test(record.workspaceId) &&
    /^[A-Za-z0-9_-]+$/.test(record.worktreeId)
  );
}

/** Cold classification only: never replay or finish the stranded archive. */
export async function inertArchiveGroup(
  root: string,
  record: DestructiveRecoveryRecord,
): Promise<InertArchiveGroup | null> {
  if (!isInertArchiveCandidate(record) || !record.worktreeId) return null;
  try {
    let path = root;
    for (const part of [
      'workspaces',
      record.workspaceId,
      'archived-containers',
      record.worktreeId,
    ]) {
      path = join(path, part);
      const stat = await statIfPresent(path);
      if (!stat) break;
      if (!stat.isDirectory() || (await realpath(path)) !== path) return null;
    }
    const manifestPath = join(
      root,
      'workspaces',
      record.workspaceId,
      'archived-containers',
      record.worktreeId,
      'container.json',
    );
    const manifestStat = await statIfPresent(manifestPath);
    if (manifestStat) {
      if (
        !manifestStat.isFile() ||
        manifestStat.nlink !== 1 ||
        (await realpath(manifestPath)) !== manifestPath
      )
        return null;
      const manifest: unknown = JSON.parse(
        await readFile(manifestPath, 'utf8'),
      );
      return isArchivedContainerManifest(manifest) &&
        (manifest.version === 2 || manifest.version === 3) &&
        manifest.projectId === record.workspaceId &&
        manifest.id === record.worktreeId &&
        manifest.originalWorktree.createdAt === record.createdAt &&
        record.steps.every(
          (step) => step.state === 'done' || isArchiveCleanupPhase(step.phase),
        )
        ? 'committed-cleanup-tail'
        : null;
    }
    return record.steps.every(
      (step) =>
        [
          'live-state-teardown',
          'retained-payload-capture',
          'git-capture',
          'provider-capture',
        ].includes(step.phase) ||
        (step.phase === 'teardown-script' && step.state === 'done'),
    )
      ? 'pre-quarantine'
      : null;
  } catch {
    return null;
  }
}
