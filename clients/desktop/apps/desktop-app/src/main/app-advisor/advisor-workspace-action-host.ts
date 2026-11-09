import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getActiveDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { getWorkspaceInstructions } from '../canopy-runtime/workspace-instructions-dispatch';
import { listAdhocMultiRepoJoinOptions } from '../lib/adhoc-multi-repo-workspaces';
import { listExistingWorktreeJoinOptions } from '../lib/adhoc-existing-worktree-join';
import { disabledOrgProjectCatalog } from '../lib/org-project-catalog-gate';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveProjectStartPage } from '../lib/project-start-page';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToAllWindows } from '../lib/window-send';
import { isStartPageFeatureEnabled } from '../lib/start-page-feature-flag';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { computeWorkspaceReadinessAudit } from '../lib/workspace-readiness';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { readWorkspaceSettingsData } from '../lib/workspace-source';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import {
  listTrackedPlanData,
  readTrackedPlanData,
} from '../services/plans-service';
import { sidebarItemGroupsService } from '../services/sidebar-item-groups-service';
import type { AdvisorWorkspaceActionHost } from './advisor-workspace-actions';

/**
 * App Advisor's identity for the core reads its moved workspace actions
 * make. It carries no grant itself: getWorkspaceInstructions adds only
 * core.workspace.instructions.read to its one call.
 */
export function advisorWorkspaceCaller(chatId: string): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-user',
    clientInstanceId: `agent-action:${chatId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'mcp',
    grants: [],
  };
}

/**
 * The main owners behind App Advisor's moved workspace actions (CAN-5998),
 * the same ones the window's IPC handlers call. The sidebar group service
 * announces its group changes to every window.
 */
export function mainAdvisorWorkspaceActionHost(options: {
  chatId: string;
}): AdvisorWorkspaceActionHost {
  return {
    readItems: async () => (await readAllSidebarItems()).items,
    announceWorktrees: (workspaceId) => {
      sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, { workspaceId });
    },
    readGroupChildBranchesWithBase: async () =>
      (await readPreferencesFile()).groupChildBranchesWithBase,
    readSettingsData: readWorkspaceSettingsData,
    readInstructions: (workspaceId) =>
      getWorkspaceInstructions(
        getActiveDesktopRuntime(),
        advisorWorkspaceCaller(options.chatId),
        workspaceId,
      ),
    isStartPageEnabled: isStartPageFeatureEnabled,
    resolveStartPage: resolveProjectStartPage,
    readReadiness: (workspaceId, worktreeId) =>
      computeWorkspaceReadinessAudit(workspaceId, worktreeId),
    listJoinOptions: listAdhocMultiRepoJoinOptions,
    listExistingWorktreeJoinOptions,
    readWorkspaceContext: async () => {
      const service = getWorkspaceContextService();
      await service.initialize();
      return service.getState();
    },
    listOrgProjects: (context) =>
      Promise.resolve(
        disabledOrgProjectCatalog(context) ??
          getOrgProjectCatalogService().list(context),
      ),
    // A Cowork project has no tracked plans, as the window's list shows.
    listTrackedPlans: async (request) =>
      isCoworkWorkspace(request.projectId) ? [] : listTrackedPlanData(request),
    readTrackedPlan: readTrackedPlanData,
    sidebarGroups: {
      describe: (scope) => sidebarItemGroupsService.describe(scope),
      list: (scope) => sidebarItemGroupsService.list(scope),
      listItems: (request) => sidebarItemGroupsService.listItems(request),
      create: (request) => sidebarItemGroupsService.create(request),
      update: (request) => sidebarItemGroupsService.update(request),
      ungroup: (request) => sidebarItemGroupsService.ungroup(request),
      moveItem: (request) => sidebarItemGroupsService.moveItem(request),
      moveGroup: (request) => sidebarItemGroupsService.moveGroup(request),
    },
  };
}
