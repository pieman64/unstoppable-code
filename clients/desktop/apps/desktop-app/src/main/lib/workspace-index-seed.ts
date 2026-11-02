import { createSerialQueue } from './w5-file-store';
import { registerDesktopW5Root } from './w5-host-admission';
import { WORKSPACE_INDEX_STORAGE, withStorageAdmission } from './w5-storage';
import { applyWorkspaceIndexSeed } from './workspace-index-seed-decision-port';

export interface WorkspaceIndexSeedRequest {
  source: 'preferences_create_primary_data_dir';
  /** The explicit primary directory, never the currently resolved fallback. */
  primaryDataDir: string;
}
export class WorkspaceIndexSeedRefusedError extends Error {
  readonly reason = 'invalid-request';
}
const serialize = createSerialQueue();

/**
 * `internal.workspace.index.seed`: publishes an empty index only if absent.
 * Exclusive publication also keeps an unreadable index and a competing seed
 * intact. It makes no backup and never changes data-root resolution. The
 * caller writes the adoption marker after this succeeds, including a no-op.
 * The decision applies through the record decision port (W5c2).
 */
export async function seedWorkspaceIndex(
  request: WorkspaceIndexSeedRequest,
): Promise<{ seeded: boolean }> {
  if (request.source !== 'preferences_create_primary_data_dir') {
    throw new WorkspaceIndexSeedRefusedError(
      'Unknown workspace index seed source',
    );
  }
  return withStorageAdmission([WORKSPACE_INDEX_STORAGE], async () => {
    // TRANSITIONAL (CAN-3797): the primary folder may not be the resolved
    // data root, so it joins the host cohort for the rest of the process,
    // only once storage admission allows the seed. It is admitted as the
    // commit-log writer is. Remove with the cohort when the W5 rows move to
    // `daemon`.
    const registration = await registerDesktopW5Root(request.primaryDataDir);
    if (registration.kind === 'refused' || registration.kind === 'failed')
      throw registration.error;
    return serialize(() =>
      applyWorkspaceIndexSeed({
        kind: 'index.seed',
        primaryDataDir: request.primaryDataDir,
      }),
    );
  });
}
