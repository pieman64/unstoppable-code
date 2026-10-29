import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isSharedContainerForkProvenance,
  type SharedContainerForkProvenance,
} from '@canopy/protocol/shared-containers';
import { getWorktreeDataDir } from '../../lib/paths';

export const SHARED_CONTAINER_FORK_PROVENANCE_FILENAME =
  'shared-container-fork.json';

export function getSharedContainerForkProvenancePath(
  projectId: string,
  worktreeId: string,
): string {
  return join(
    getWorktreeDataDir(projectId, worktreeId),
    SHARED_CONTAINER_FORK_PROVENANCE_FILENAME,
  );
}

export async function writeSharedContainerForkProvenance(
  filePath: string,
  provenance: SharedContainerForkProvenance,
): Promise<void> {
  if (!isSharedContainerForkProvenance(provenance)) {
    throw new Error('Invalid shared-container fork provenance');
  }
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(provenance, null, 2), 'utf8');
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readSharedContainerForkProvenance(
  filePath: string,
): Promise<SharedContainerForkProvenance | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!isSharedContainerForkProvenance(value)) {
    throw new Error('Invalid shared-container fork provenance');
  }
  return value;
}

export function writeForkProvenanceForDestination(
  projectId: string,
  worktreeId: string,
  provenance: SharedContainerForkProvenance,
): Promise<void> {
  return writeSharedContainerForkProvenance(
    getSharedContainerForkProvenancePath(projectId, worktreeId),
    provenance,
  );
}
