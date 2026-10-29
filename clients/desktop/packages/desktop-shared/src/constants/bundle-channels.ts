// ---------------------------------------------------------------------------
// Deprecated bundle channel constants.
//
// The canonical IPC channels for the renamed Collections surface live in
// `./collection-channels.ts`. This file preserves the original channel names
// so unmigrated renderer/main paths still resolve `BUNDLES_CHANNELS.*` during
// staged migration.
//
// The constant values themselves intentionally still use the `bundles:` IPC
// namespace because they are coupled to persisted main-process handlers and
// to historical channel registrations. Migrating those handlers to the new
// `collections:` namespace happens in the backend phase.
// ---------------------------------------------------------------------------

/** @deprecated Use {@link COLLECTIONS_CHANNELS} from `./collection-channels`. */
export const BUNDLES_CHANNELS = {
  LOAD_INDEX: 'bundles:load-index',
  LOAD_BUNDLE: 'bundles:load-bundle',
  SAVE_BUNDLE: 'bundles:save-bundle',
  DELETE_BUNDLE: 'bundles:delete-bundle',
} as const;
