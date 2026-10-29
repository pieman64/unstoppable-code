import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomically } from './atomic-file';
import { isErrnoException } from './type-guards';
import { WORKSPACE_INDEX_STORAGE } from './w5-storage';
import { workspaceIndexSeedDocument } from './worktree-record-decision-apply';
import type { WorkspaceIndexSeedDecision } from './worktree-record-decisions';

// The index seed member of `W5RecordDecisionPort` (W5c2). Kept apart so the
// seed keeps its small import graph.

/**
 * Publishes an empty index exclusively, so an existing or unreadable index
 * and a competing seed stay intact; no backup is made.
 */
export async function applyWorkspaceIndexSeed(
  decision: WorkspaceIndexSeedDecision,
): Promise<{ seeded: boolean }> {
  const workspacesDir = join(decision.primaryDataDir, 'workspaces');
  await mkdir(workspacesDir, { recursive: true });
  try {
    await writeFileAtomically(
      join(workspacesDir, 'index.json'),
      workspaceIndexSeedDocument(),
      { overwrite: false, storage: WORKSPACE_INDEX_STORAGE },
    );
    return { seeded: true };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST')
      return { seeded: false };
    throw error;
  }
}
