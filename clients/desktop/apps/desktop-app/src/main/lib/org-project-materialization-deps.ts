import { hasPersonalOrgProjectRelationship } from '../services/org-project-relationship-service';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { readPersonalProjectConversionPolicy } from '../canopy-cloud/personal-organization-upgrade';
import {
  isOrgProjectSummary,
  type OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import { getFeatureFlagService } from '../feature-flags';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { getDesktopOAuthClientDeviceId } from '../canopy-cloud/oauth-login';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';
import { getWorkspaceContextService } from './workspace-context-service';
import {
  readPreferencesFile,
  readPreferencesFileDetailed,
} from './preferences-store';
import { readInstallationGeneration } from './installation-generation';
import {
  coworkWorkspaceRootDirFor,
  getActivityScopeRepairFilePath,
  getOrgProjectSetupsDir,
} from './paths';
import {
  enforcementForOrganization,
  resolveEffectiveTelemetrySharing,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { loadStoredTelemetryEnforcementByOrganization } from './telemetry-enforcement-state';
import { createActivityRepairLedger } from './activity-scope-repair';
import {
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
} from './sidebar-items';
import { resolveGitHubTokenWithSource } from './github-auth';
import { cloneRepoWithProgress, getRemoteUrlStrict } from './git';
import { readWorkspaceOwnership } from './workspace-persistence';
import {
  recordWorkspaceOwner,
  releaseAdoptedWorkspace,
} from './workspace-ownership';
import { recordOrganizationPrivateMemory } from './workspace-private-memory';
import {
  buildWorkspaceId,
  findOrCreateSingleRepoWorkspaceForRepo,
} from './workspace-service';
import type { OrgProjectMaterializationDeps } from './org-project-materialization';
import { getOrgCoworkCreator } from './org-cowork-create-deps';
import type { TelemetrySharingPreferences } from '@canopy/desktop-shared/types';
import { getBackgroundExecutionContextRebinder } from '../services/background-execution-rebinding';
import {
  logMainProcessError,
  logMainProcessInfo,
} from './main-process-logging';
import { app } from 'electron';
import { parseOrgProjectSetupPause } from './org-project-setup-journal';
import { reportActivityMove } from './org-project-activity-move-report';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

/** Bounded well inside the server's 15-minute claim lease (see below). */
export const ORG_PROJECT_CLONE_TIMEOUT_MS = 12 * 60 * 1000;

export function createProductionDeps(): OrgProjectMaterializationDeps {
  return {
    catalog: getOrgProjectCatalogService(),
    cowork: {
      setUp: (input) => getOrgCoworkCreator().setUp(input),
    },
    cloud: {
      claim: async (projectId, request, credentialContext) =>
        requestCanopyCloudJson(
          `/api/v1/projects/${projectId}/instances/claim`,
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        ),
      complete: async (instanceId, request, credentialContext) =>
        requestCanopyCloudJson(
          `/api/v1/projects/instances/${instanceId}/complete`,
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        ),
      detach: async (instanceId, credentialContext) =>
        requestCanopyCloudJson(
          `/api/v1/projects/instances/${instanceId}/detach`,
          {
            method: 'POST',
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        ),
      createMemberMultiRepoProject: async (
        request,
        credentialContext,
      ): Promise<OrgProjectSummary> => {
        const project: unknown = await requestCanopyCloudJson(
          '/api/v1/projects/member/multi-repo',
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        );
        if (!isOrgProjectSummary(project))
          throw new Error('Invalid member multi-repo project response');
        return project;
      },
      createMemberCoworkProject: async (
        request,
      ): Promise<OrgProjectSummary> => {
        const project: unknown = await requestCanopyCloudJson(
          '/api/v1/projects/member',
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext: await getCanopyCloudCredentials(),
          },
        );
        if (!isOrgProjectSummary(project))
          throw new Error('Invalid member Cowork project response');
        return project;
      },
      moveActivity: async (projectId, request, credentialContext) =>
        requestCanopyCloudJson(
          `/api/v1/projects/${projectId}/activity-transfer`,
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        ),
      returnActivity: async (projectId, request, credentialContext) =>
        requestCanopyCloudJson(
          `/api/v1/projects/${projectId}/activity-transfer/reverse`,
          {
            method: 'POST',
            body: JSON.stringify(request),
            credentialContext:
              credentialContext ?? (await getCanopyCloudCredentials()),
          },
        ),
      returnPersonalActivity: async (request) =>
        requestCanopyCloudJson('/api/v1/projects/personal/activity-return', {
          method: 'POST',
          body: JSON.stringify(request),
          credentialContext: await getCanopyCloudCredentials(),
        }),
    },
    activityRepair: {
      // The member's own choice with the organization's policy pinned over
      // it, read from disk like the sync service reads it. An unreadable
      // account defers the repair to the next launch.
      sharingFor: async (
        organizationId,
      ): Promise<TelemetrySharingPreferences | null> => {
        try {
          const [read, byOrganization] = await settleAll([
            readPreferencesFileDetailed(),
            loadStoredTelemetryEnforcementByOrganization(),
          ]);
          // Never decide "private" from a preferences file nobody can read.
          if (read.authority === 'unreadable') return null;
          // Feature opt-ins never authorize the automatic historical ownership
          // repair, even after restart or for other organization memberships.
          if (
            read.preferences.dataSharingOptInHistory?.some(
              (entry) => entry.sharing.metadata !== 'organization',
            )
          ) {
            return {
              ...read.preferences.telemetrySharing,
              metadata: 'private',
            };
          }
          return resolveEffectiveTelemetrySharing(
            read.preferences.telemetrySharing,
            enforcementForOrganization(byOrganization, organizationId),
          );
        } catch {
          return null;
        }
      },
      ledger: createActivityRepairLedger(getActivityScopeRepairFilePath),
    },
    git: {
      clone: (url, destination, options) =>
        cloneRepoWithProgress(url, destination, {
          ...options,
          nonInteractive: true,
          // The server's claim lease is 15 minutes and starts at the claim,
          // before this clone does; completion still needs an access check, a
          // rename and a workspace write afterwards. Timing the clone out at
          // the full lease would let a slow clone succeed locally and then
          // lose the race to complete, stranding a promoted checkout as
          // superseded. Leave the lease three minutes of headroom.
          timeoutMs: ORG_PROJECT_CLONE_TIMEOUT_MS,
        }),
    },
    workspace: {
      buildLocalWorkspaceId: buildWorkspaceId,
      applyManagedPrivateMemory: async (input): Promise<void> => {
        await recordOrganizationPrivateMemory(input);
      },
      createBoundWorkspace: async (
        path,
        localWorkspaceId,
        owner,
        preferredName,
      ): Promise<void> => {
        await findOrCreateSingleRepoWorkspaceForRepo(path, preferredName, {
          owner,
          localWorkspaceId,
        });
      },
      removeBoundWorkspace: (localWorkspaceId, instanceId): Promise<boolean> =>
        releaseAdoptedWorkspace({
          workspaceId: localWorkspaceId,
          source: 'org_project_adoption_rollback',
          instanceId,
        }),
      readOwnership: readWorkspaceOwnership,
      updateOwnership: (workspaceId, update) =>
        recordWorkspaceOwner({
          workspaceId,
          source: 'org_project_materialization',
          update,
        }),
      readRemoteUrl: getRemoteUrlStrict,
    },
    backgroundExecution: {
      ownershipChanged: async (change): Promise<void> => {
        await getBackgroundExecutionContextRebinder()
          .rebindWorkspace(change, 'ownership-change')
          .catch((error: unknown): void => {
            logMainProcessError(
              'Failed to move background items with a project that changed owner:',
              error,
            );
          });
      },
    },
    reportActivityMove,
    resolveDeviceId: getDesktopOAuthClientDeviceId,
    readInstallationGeneration,
    now: (): string => new Date().toISOString(),
    paths: {
      setupsDir: getOrgProjectSetupsDir,
      coworkRootDir: coworkWorkspaceRootDirFor,
    },
    automaticConversionAllowed: async (
      organizationId,
      accountId,
    ): Promise<boolean> => {
      const policy = await readPersonalProjectConversionPolicy(accountId);
      return (
        policy.organizationIds.includes(organizationId) &&
        !policy.excludedOrganizationIds.includes(organizationId)
      );
    },
    access: async (): Promise<
      Awaited<ReturnType<OrgProjectMaterializationDeps['access']>>
    > => {
      const credentials = await getCanopyCloudCredentials();
      return {
        context: getWorkspaceContextService().getState().context,
        accountId: credentials.account?.id ?? '',
        enabled: getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        ),
        capabilities: credentials.capabilities,
      };
    },
    preferences: readPreferencesFile,
    readItems: async () => (await readAllSidebarItems()).items,
    readItemsSnapshot: async (): Promise<
      Awaited<ReturnType<OrgProjectMaterializationDeps['readItemsSnapshot']>>
    > => {
      const snapshot = await readAllSidebarItemsSnapshot();
      return { items: snapshot.file.items, authority: snapshot.authority };
    },
    hasPersonalRelationship: hasPersonalOrgProjectRelationship,
    resolveTokenSource: async () =>
      (await resolveGitHubTokenWithSource()).source,
    cloneBase: __CANOPY_E2E__
      ? process.env.CANOPY_E2E_ORG_PROJECT_CLONE_BASE
      : undefined,
    // Every checkpoint is logged, so a phase can be found in the main log
    // and an interruption placed after it.
    checkpointed: async (journal, phase): Promise<void> => {
      logMainProcessInfo(
        `[org-project-setup] journal=${journal.journalId} project=${journal.projectId} phase=${phase}`,
      );
      const pause = app.isPackaged
        ? null
        : parseOrgProjectSetupPause(
            process.env.CANOPY_DEV_ORG_PROJECT_SETUP_PAUSE,
          );
      if (pause?.phase !== phase) return;
      logMainProcessInfo(
        `[org-project-setup] pausing ${pause.ms / 1000}s after phase=${phase}`,
      );
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, pause.ms);
      });
    },
  };
}
