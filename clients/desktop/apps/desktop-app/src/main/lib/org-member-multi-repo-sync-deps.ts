import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';
import { getRemoteUrlStrict } from './git';
import {
  createOrgMemberMultiRepoSync,
  type OrgMemberMultiRepoSync,
  type OrgMultiRepoRepositoriesUpdate,
} from './org-member-multi-repo-sync';
import { getWorkspaceContextService } from './workspace-context-service';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  addWorkspaceRepository,
  removeWorkspaceRepository,
} from './workspace-repositories';

let sync: OrgMemberMultiRepoSync | undefined;

export function getOrgMemberMultiRepoSync(): OrgMemberMultiRepoSync {
  sync ??= createOrgMemberMultiRepoSync({
    readConfig: readWorkspaceConfig,
    readRemoteUrl: getRemoteUrlStrict,
    catalog: {
      refresh: (organizationId) =>
        getOrgProjectCatalogService().refresh(
          { kind: 'organization', organizationId },
          { force: true },
        ),
    },
    organizationName: (organizationId) =>
      getWorkspaceContextService()
        .getState()
        .organizations.find(
          (organization) =>
            organization.id.toLowerCase() === organizationId.toLowerCase(),
        )?.name ?? null,
    async updateRepositories(
      projectId,
      repositoryProjectIds,
    ): Promise<OrgMultiRepoRepositoriesUpdate> {
      try {
        await requestCanopyCloudJson(
          `/api/v1/projects/member/multi-repo/${encodeURIComponent(projectId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ repositoryProjectIds }),
            credentialContext: await getCanopyCloudCredentials(),
          },
        );
        return 'updated';
      } catch (error) {
        return error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          error.serverCode === 'repository_mismatch'
          ? 'repository-mismatch'
          : 'failed';
      }
    },
    revert: {
      async removeRepo(workspaceId, repoId): Promise<void> {
        await removeWorkspaceRepository({
          workspaceId,
          repoId,
          source: 'organization_sync_revert',
        });
      },
      async restoreRepo(workspaceId, repo, index): Promise<void> {
        await addWorkspaceRepository({
          workspaceId,
          source: 'organization_sync_revert',
          restore: { repository: repo, index },
        });
      },
    },
  });
  return sync;
}
