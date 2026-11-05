import {
  createPreferenceFormatMigrations,
  type ChatSummaryModelSelectionMigrationSnapshot,
  type LocalMemoryModelMigrationSnapshot,
  type PreferenceMigrationSnapshots,
} from '@canopy/desktop-shared/node/preferences/preference-format-migrations';
import { hasMigrationRun, markMigrationRun } from './migrations';
import {
  readPreferencesFile,
  updatePreferencesFile,
  peekPreferencesLoadError,
  hasPersistedPreferencesFile,
  readStoredPreferencesPayload,
} from './preferences-store';
export {
  APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY,
  CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY,
  SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY,
  SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY,
  CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY,
  LOCAL_MEMORY_DEFAULT_ON_MIGRATION_KEY,
  SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY,
  OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
  LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY,
} from '@canopy/desktop-shared/node/preferences/preference-format-migrations';
export type {
  ChatSummaryModelSelectionMigrationSnapshot,
  LocalMemoryModelMigrationSnapshot,
  PreferenceMigrationSnapshots,
} from '@canopy/desktop-shared/node/preferences/preference-format-migrations';
const migrations = createPreferenceFormatMigrations({
  ledger: {
    hasRun: (key) => hasMigrationRun(key),
    markRun: (key) => markMigrationRun(key),
  },
  store: {
    read: () => readPreferencesFile(),
    update: (updater) => updatePreferencesFile(updater),
    peekLoadError: () => peekPreferencesLoadError(),
    hasPersistedState: () => hasPersistedPreferencesFile(),
    readStoredPayload: () => readStoredPreferencesPayload(),
  },
});
export const captureChatSummaryModelSelectionMigrationSnapshot =
  (): Promise<ChatSummaryModelSelectionMigrationSnapshot> =>
    migrations.captureChatSummaryModelSelectionMigrationSnapshot();

export const migrateChatSummaryModelSelection = (
  capturedSnapshot?: ChatSummaryModelSelectionMigrationSnapshot,
): Promise<void> =>
  migrations.migrateChatSummaryModelSelection(capturedSnapshot);

export const migrateApprovalDefaultsToFullAccess = (
  hadPersistedPreferencesAtStartup?: boolean,
): Promise<void> =>
  migrations.migrateApprovalDefaultsToFullAccess(
    hadPersistedPreferencesAtStartup,
  );

export const migrateClaudeWorkerModesToCanopy = (): Promise<void> =>
  migrations.migrateClaudeWorkerModesToCanopy();

export const migrateSidebarRemoteControlVisible = (): Promise<void> =>
  migrations.migrateSidebarRemoteControlVisible();

export const migrateSidebarMorePagesToMain = (): Promise<void> =>
  migrations.migrateSidebarMorePagesToMain();

export const migrateLocalMemoryDefaultOn = (): Promise<void> =>
  migrations.migrateLocalMemoryDefaultOn();

export const migrateSidebarManualSortDefault = (): Promise<void> =>
  migrations.migrateSidebarManualSortDefault();

export const migrateOpenAppLinksInBuiltInBrowserDefault = (): Promise<void> =>
  migrations.migrateOpenAppLinksInBuiltInBrowserDefault();

export const captureLocalMemoryModelMigrationSnapshot =
  (): Promise<LocalMemoryModelMigrationSnapshot> =>
    migrations.captureLocalMemoryModelMigrationSnapshot();

export const capturePreferenceMigrationSnapshots =
  (): Promise<PreferenceMigrationSnapshots> =>
    migrations.capturePreferenceMigrationSnapshots();

export const migrateLocalMemoryModelFromSummary = (
  capturedSnapshot?: LocalMemoryModelMigrationSnapshot,
): Promise<void> =>
  migrations.migrateLocalMemoryModelFromSummary(capturedSnapshot);
