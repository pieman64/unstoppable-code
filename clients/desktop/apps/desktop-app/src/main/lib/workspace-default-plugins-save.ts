import type { SaveDefaultPluginsRequest } from '@canopy/desktop-shared/types';
import { updateWorkspaceMetadata } from './workspace-metadata';
import {
  updateWorkspacePlugins,
  type WorkspacePluginsSource,
} from './workspace-plugin-defaults';

/**
 * The settings dialogs' save (`workspace:save-default-plugins`,
 * `project:save-default-plugins`). The payload carries two fields with
 * different owners (CAN-3799 field ownership), so it issues two typed
 * commands: the default plugins through `core.workspace.plugins.update`,
 * then Always show through `core.workspace.update`. Each writes only this
 * workspace's manifest; a refused plugins change writes neither.
 */
export async function saveDefaultPluginsAndVisibility(
  request: SaveDefaultPluginsRequest,
  source: Extract<
    WorkspacePluginsSource,
    'workspace_settings' | 'project_settings'
  >,
): Promise<void> {
  await updateWorkspacePlugins({
    workspaceId: request.projectId,
    change: {
      kind: 'setDefaults',
      defaultPluginSelections: request.defaultPluginSelections,
    },
    source,
  });
  if (request.alwaysShow !== undefined) {
    await updateWorkspaceMetadata({
      workspaceId: request.projectId,
      patch: { alwaysShow: request.alwaysShow },
      source: 'desktop_canopy_client',
    });
  }
}
