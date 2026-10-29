import type { AtomicFileStorage } from './atomic-file';

export { withStorageAdmission } from '@canopy/desktop-shared/node/lib/storage-admission';

// Desktop main's W5 writer principal (CAN-3880).
export const WORKSPACE_INDEX_STORAGE: AtomicFileStorage = {
  namespace: 'workspace_index',
  writer: 'electron_main',
};
export const WORKSPACE_MANIFEST_STORAGE: AtomicFileStorage = {
  namespace: 'workspace_manifest',
  writer: 'electron_main',
};
export const WORKTREE_LIST_STORAGE: AtomicFileStorage = {
  namespace: 'worktree_list',
  writer: 'electron_main',
};

/**
 * Every W5 namespace. Cowork operations admit it too: the sidebar writer
 * rewrites each repository sibling's worktree list.
 */
export const PROJECT_W5_STORAGE = [
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
];
