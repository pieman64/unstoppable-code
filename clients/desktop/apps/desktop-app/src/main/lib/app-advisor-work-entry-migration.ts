/**
 * One-time migration from the legacy flat App Advisor `chats/global.json`
 * file to entry-keyed chat files and a Work Entry registry. Legacy archives,
 * worktree data, and attachments deliberately remain under `global` as a
 * permanent read-only source slot.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { splitFlatChatTabsIntoEntries } from './cowork-work-entry-migration';
import { hasMigrationRun, markMigrationRun } from './migrations';

export const APP_ADVISOR_WORK_ENTRIES_MIGRATION_KEY =
  'app_advisor_work_entries';

export async function migrateAppAdvisorChatsToWorkEntries(): Promise<void> {
  if (await hasMigrationRun(APP_ADVISOR_WORK_ENTRIES_MIGRATION_KEY)) {
    return;
  }

  await splitFlatChatTabsIntoEntries(
    APP_ADVISOR_PROJECT_ID,
    APP_ADVISOR_WORKTREE_ID,
  );
  await markMigrationRun(APP_ADVISOR_WORK_ENTRIES_MIGRATION_KEY);
}
