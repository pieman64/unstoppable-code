import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type GuardedStorageNamespace,
  type StorageOwnershipRow,
} from '@canopy/core-runtime/storage';

/*
 * W6h0 (CAN-5554) C1: how a CLI or headless built-in W5 write runs. It routes
 * through the core daemon only once the compiled ownership table admits the
 * daemon for every W5 record namespace, the gate the record authority and
 * the daemon's metadata commands (`assertW5DaemonHostingAdmitted`, W7a-3)
 * apply. Until then nothing here contacts or starts a
 * daemon, and a partial flip stays on the legacy writers, whose admission
 * refuses each daemon-owned row before writing. The routed path never falls
 * back to a direct write.
 */

export const W5_RECORD_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const satisfies readonly GuardedStorageNamespace[];

export type W5WritePath = 'routed' | 'legacy';

export function selectW5WritePath(
  rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
): W5WritePath {
  return W5_RECORD_NAMESPACES.every(
    (namespace) => evaluateStorageWrite(namespace, 'daemon', rows).allowed,
  )
    ? 'routed'
    : 'legacy';
}
