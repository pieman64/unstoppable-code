// ---------------------------------------------------------------------------
// IPC channels for the Skills surface (local + shared CRUD).
//
// The renderer talks to the main process via these channels for local
// custom-skill operations and uses the `SHARED_*` channels to proxy through
// the singleton build-time Canopy Cloud backend for shared skill operations.
// ---------------------------------------------------------------------------

export const SKILLS_CHANNELS = {
  MARKETPLACE_LIST: 'skills:marketplace-list',
  LOAD: 'skills:load',
  FETCH_AVAILABLE: 'skills:fetch-available',
  INSTALL: 'skills:install',
  REMOVE: 'skills:remove',
  UPDATE: 'skills:update',
  CHECK_UPDATES: 'skills:check-updates',
  UPDATE_PROGRESS: 'skills:update-progress',
  READ_CONTENT: 'skills:read-content',
  LIST_FILES: 'skills:list-files',
  READ_FILE: 'skills:read-file',
  SAVE_CUSTOM: 'skills:save-custom',

  // ---- Raw SKILL.md helpers (used by the share/import flow) ---------------
  READ_RAW: 'skills:read-raw',
  WRITE_RAW: 'skills:write-raw',

  // ---- Shared (Canopy Cloud) CRUD -----------------------------------------
  SHARED_LIST: 'skills:shared-list',
  SHARED_GET: 'skills:shared-get',
  SHARED_CREATE: 'skills:shared-create',
  SHARED_UPDATE: 'skills:shared-update',
  SHARED_DELETE: 'skills:shared-delete',
  SHARED_PUBLISH_PUBLIC: 'skills:shared-publish-public',
  SHARED_REVOKE_PUBLIC: 'skills:shared-revoke-public',

  // ---- Capability package (what travels with a shared skill) --------------
  PACKAGE_ANALYZE: 'skills:package-analyze',
  PACKAGE_CANCEL_ANALYSIS: 'skills:package-cancel-analysis',
  PACKAGE_COMMIT: 'skills:package-commit',
  PACKAGE_INSTALL: 'skills:package-install',
  RECORD_SHARE_ORIGIN: 'skills:record-share-origin',
  DEPENDENCY_READINESS: 'skills:dependency-readiness',
} as const;

export type SkillsChannel =
  (typeof SKILLS_CHANNELS)[keyof typeof SKILLS_CHANNELS];
