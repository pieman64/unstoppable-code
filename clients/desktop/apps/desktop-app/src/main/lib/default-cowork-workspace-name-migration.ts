import { DEFAULT_COWORK_WORKSPACE_NAME } from './cowork-workspace-crud';
import { hasMigrationRun, markMigrationRun } from './migrations';
import { renameDefaultCoworkWorkspaceRecord } from './cowork-workspace-records';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  LEGACY_DEFAULT_COWORK_WORKSPACE_NAMES,
} from '@canopy/desktop-shared/types';

const MIGRATION_KEY = 'default_cowork_workspace_chats_name';

/**
 * Renames the default cowork workspace to match the sidebar's Chats section.
 *
 * The section header has rendered the shared "Chats" label since CAN-2363,
 * but every other surface that names a workspace — the New task composer,
 * the chat switcher, App Advisor — reads the stored name, which older
 * installs still hold as `'Personal'` (or `'Default'`, pre-CAN-2672). The two
 * disagreeing made a chat look like it was filed somewhere it never appeared.
 *
 * Only the auto-assigned names are rewritten. A user who renamed the
 * workspace keeps their name, and the marker makes that permanent: the
 * migration never runs twice, so a later rename is never rewritten on disk.
 * The renderer's `isDefaultCoworkWorkspaceName` still declines to *display* a
 * legacy name, since it cannot tell a deliberate rename back to "Personal"
 * from an install this migration has not reached yet.
 *
 * The rename goes through {@link renameDefaultCoworkWorkspaceRecord}, which touches
 * the index entry alone. A full sidebar write would round-trip every
 * workspace's `workspace.json` through a projection that silently drops
 * `recommendedPluginOptOutKeys` and `planDetection` — an unacceptable blast
 * radius for an unattended startup pass that runs once for every upgrading
 * install.
 */
export async function migrateDefaultCoworkWorkspaceName(): Promise<void> {
  if (await hasMigrationRun(MIGRATION_KEY)) return;

  const { authority } = await renameDefaultCoworkWorkspaceRecord({
    source: 'default_cowork_name_migration',
    workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
    name: DEFAULT_COWORK_WORKSPACE_NAME,
    onlyWhenNamed: LEGACY_DEFAULT_COWORK_WORKSPACE_NAMES,
  });

  // A degraded read is indistinguishable here from "already renamed" or
  // "fresh install", so marking would burn the single shot this migration
  // gets and leave that install disagreeing with the sidebar forever.
  if (authority !== 'ok' && authority !== 'absent') return;

  await markMigrationRun(MIGRATION_KEY);
}
