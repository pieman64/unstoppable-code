// ---------------------------------------------------------------------------
// IPC channels for the Collections surface (local + shared CRUD).
//
// The renderer talks to the main process via these channels for every local
// Collection operation, and uses the `SHARED_*` channels to proxy through the
// singleton build-time Canopy Cloud backend for shared Collection operations.
// ---------------------------------------------------------------------------

export const COLLECTIONS_CHANNELS = {
  // ---- Local CRUD ----------------------------------------------------------
  LOAD_INDEX: 'collections:load-index',
  LOAD_COLLECTION: 'collections:load-collection',
  SAVE_COLLECTION: 'collections:save-collection',
  DELETE_COLLECTION: 'collections:delete-collection',
  DUPLICATE_COLLECTION: 'collections:duplicate-collection',
  APPLY_SHARED_UPDATE: 'collections:apply-shared-update',

  // ---- Shared (Canopy Cloud) CRUD -----------------------------------------
  // Each handler proxies to the singleton build-time Cloud backend; renderer
  // requests do not carry server identity.
  SHARED_LIST: 'collections:shared-list',
  SHARED_GET: 'collections:shared-get',
  SHARED_CREATE: 'collections:shared-create',
  SHARED_UPDATE: 'collections:shared-update',
  SHARED_DELETE: 'collections:shared-delete',
  SHARED_PUBLIC_PUBLISH: 'collections:shared-public-publish',
  SHARED_PUBLIC_REVOKE: 'collections:shared-public-revoke',
  PACKAGE_ANALYZE: 'collections:package-analyze',
  PACKAGE_CANCEL_ANALYSIS: 'collections:package-cancel-analysis',
  PACKAGE_COMMIT: 'collections:package-commit',
  IMPORT_READINESS: 'collections:import-readiness',
  PACKAGE_INSTALL: 'collections:package-install',
} as const;

export type CollectionsChannel =
  (typeof COLLECTIONS_CHANNELS)[keyof typeof COLLECTIONS_CHANNELS];
