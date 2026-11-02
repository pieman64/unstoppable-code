import {
  createSharedMultiRepoCoordinator,
  SharedMultiRepoSelectionError,
  type SharedMultiRepoHost,
  type SharedMultiRepoCreationJournal,
  type SharedMultiRepoPorts,
  type SharedMultiRepoCoordinator,
} from '@canopy/core-runtime/node/workspace/org-shared-multi-repo';
import { createSharedMultiRepoJournalStore } from '@canopy/core-runtime/node/workspace/shared-multi-repo-journal';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  isOrgProjectSummary,
  hasCompleteOrgProjectRepositories,
  SHARED_MULTI_REPO_HOSTED_CAPABILITY,
  type PreparedSharedMultiRepo,
  type PrepareSharedMultiRepoParams,
  type OrgProjectSummary,
  type OrgProjectRepository,
  type CreateSharedMultiRepoOrgProjectResponse,
} from '@canopy/protocol/org-projects';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { getDesktopOAuthClientDeviceId } from '../canopy-cloud/oauth-login';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { readAllSidebarItemsSnapshot } from '../lib/sidebar-items';
import { getRemoteUrlStrict } from '../lib/git';
import {
  holdsOrganizationRepository,
  matchOrganizationRepository,
} from '../lib/org-project-relationships';
import { getOrgProjectMaterialization } from '../lib/org-project-materialization';
import { resolveOrgProjectSetupDestination } from '../lib/org-project-setup-destination';
import { getOrgSharedMultiRepoCreationsDir } from '../lib/paths';
import { writeFileAtomically } from '../lib/atomic-file';
import { logMainProcessError } from '../lib/main-process-logging';

function repoIdentity(repository: OrgProjectRepository): string {
  return `${repository.host}/${repository.providerRepoId ?? `${repository.owner}/${repository.name}`}`.toLowerCase();
}
async function identity(
  caller: CanopyCallerDescriptor,
): Promise<{ accountId: string; deviceId: string }> {
  if (
    caller.authorityId !== 'local-desktop' ||
    caller.principalId !== 'local-desktop-user' ||
    (caller.interfaceKind !== 'desktop' && caller.interfaceKind !== 'portal')
  )
    throw new Error('A local or paired desktop session is required');
  if (
    caller.interfaceKind === 'portal' &&
    !caller.clientInstanceId.startsWith('portal-session:')
  )
    throw new Error('A paired session is required');
  const credentials = await getCanopyCloudCredentials();
  if (!credentials.account?.id)
    throw new Error('Sign in to access shared projects');
  return {
    accountId: credentials.account.id,
    deviceId: await getDesktopOAuthClientDeviceId(),
  };
}
async function authorize(
  caller: CanopyCallerDescriptor,
  organizationId: string,
): Promise<void> {
  await identity(caller);
  const credentials = await getCanopyCloudCredentials();
  if (
    !(credentials.organizations ?? []).some((org) => org.id === organizationId)
  )
    throw new Error('Organization access is unavailable');
}
function definitionRepositories(
  project: OrgProjectSummary,
): readonly OrgProjectRepository[] {
  if (project.topology === 'multi-repo') {
    if (!hasCompleteOrgProjectRepositories(project) || !project.repositories)
      throw new SharedMultiRepoSelectionError(
        'stale_selection',
        'The full shared project definition is unavailable',
      );
    return project.repositories;
  }
  if (!project.repository)
    throw new SharedMultiRepoSelectionError(
      'repository_mismatch',
      'A source repository is missing',
    );
  return [project.repository];
}
export async function prepareDesktopSharedMultiRepo(
  caller: CanopyCallerDescriptor,
  params: PrepareSharedMultiRepoParams,
): Promise<PreparedSharedMultiRepo> {
  await identity(caller);
  const inventory = await readAllSidebarItemsSnapshot();
  if (inventory.authority !== 'ok' && inventory.authority !== 'absent')
    throw new Error('Local project identities are unreadable');
  const owners = new Set<string>();
  for (const selection of params.selections) {
    if (selection.kind !== 'workspace') continue;
    const workspace = inventory.file.items.find(
      (item) => item.id === selection.id,
    );
    if (!workspace)
      throw new SharedMultiRepoSelectionError(
        'stale_selection',
        'A selected project is unavailable',
      );
    if (workspace.owner?.type === 'organization')
      owners.add(workspace.owner.organizationId);
  }
  if (owners.size > 1)
    throw new SharedMultiRepoSelectionError(
      'cross_organization',
      'Selected projects belong to different organizations',
    );
  const selectedContext = getWorkspaceContextService().getState().context;
  const organizationId =
    Array.from(owners)[0] ??
    (selectedContext.kind === 'organization'
      ? selectedContext.organizationId
      : undefined);
  if (!organizationId)
    throw new SharedMultiRepoSelectionError(
      'cross_organization',
      'Select an organization for the new shared project',
    );
  await authorize(caller, organizationId);
  const credentials = await getCanopyCloudCredentials();
  const membership = (credentials.organizations ?? []).find(
    (org) => org.id === organizationId,
  );
  // Catalog service merges every page before returning a snapshot.
  const snapshot = await getOrgProjectCatalogService().refresh(
    { kind: 'organization', organizationId },
    { force: true },
  );
  if (snapshot.stale || snapshot.error)
    throw new Error('The organization catalog could not be checked');
  const sources: OrgProjectSummary[] = [];
  const firstSourceIds: string[] = [];
  for (const [index, selection] of Array.from(params.selections.entries())) {
    let projects: OrgProjectSummary[];
    if (selection.kind === 'project') {
      const project = snapshot.projects.find((row) => row.id === selection.id);
      if (!project)
        throw new SharedMultiRepoSelectionError(
          'stale_selection',
          'A selected project is unavailable',
        );
      // Individual additions are held single-repository definitions.
      if (index > 0 && !holdsOrganizationRepository(project))
        throw new SharedMultiRepoSelectionError(
          'repository_mismatch',
          'Add a held single-repository project',
        );
      projects = [project];
    } else {
      const workspace = inventory.file.items.find(
        (item) => item.id === selection.id,
      );
      if (!workspace || workspace.type === 'cowork')
        throw new SharedMultiRepoSelectionError(
          'repository_mismatch',
          'Select code projects',
        );
      if (workspace.owner?.type === 'organization') {
        const project = snapshot.projects.find(
          (row) => row.id === workspace.owner?.projectId,
        );
        if (!project)
          throw new SharedMultiRepoSelectionError(
            'stale_selection',
            'The source binding is no longer authorized',
          );
        projects = [project];
      } else {
        const paths =
          workspace.type === 'single-repo'
            ? [workspace.repoPath]
            : workspace.repos.map((repo) => repo.repoPath);
        if (workspace.type === 'multi-repo' && workspace.sourceRepoPath) {
          const rootRemote = await getRemoteUrlStrict(workspace.sourceRepoPath);
          if (rootRemote) paths.unshift(workspace.sourceRepoPath);
        }
        if (paths.length === 0)
          throw new SharedMultiRepoSelectionError(
            'repository_mismatch',
            'No source repositories were selected',
          );
        projects = [];
        for (const path of paths) {
          const remote = await getRemoteUrlStrict(path);
          if (!remote)
            throw new SharedMultiRepoSelectionError(
              'repository_mismatch',
              'A selected repository has no supported remote',
            );
          const match = matchOrganizationRepository(
            [{ organizationId, projects: snapshot.projects }],
            remote,
            holdsOrganizationRepository,
          );
          if (match.unknown || match.matches.length !== 1)
            throw new SharedMultiRepoSelectionError(
              'repository_mismatch',
              'A repository does not resolve uniquely to a held organization project',
            );
          const project = match.matches[0]?.project;
          if (!project)
            throw new SharedMultiRepoSelectionError(
              'stale_selection',
              'A source repository is unavailable',
            );
          projects.push(project);
        }
      }
    }
    for (const project of projects) {
      if (
        project.organizationId !== organizationId ||
        project.state !== 'ACTIVE' ||
        !project.capabilities.use ||
        project.visibility !== 'organization' ||
        project.kind !== 'CODE' ||
        project.location !== 'LOCAL' ||
        project.purpose !== 'project'
      )
        throw new SharedMultiRepoSelectionError(
          'repository_mismatch',
          'A selected project cannot be shared',
        );
      if (!sources.some((known) => known.id === project.id))
        sources.push(project);
      if (index === 0) firstSourceIds.push(project.id);
    }
  }
  const repositories: OrgProjectRepository[] = [];
  const firstIdentities = new Set<string>();
  for (const source of sources) {
    for (const repository of definitionRepositories(source)) {
      if (firstSourceIds.includes(source.id))
        firstIdentities.add(repoIdentity(repository));
      if (
        !repositories.some(
          (known) => repoIdentity(known) === repoIdentity(repository),
        )
      )
        repositories.push(repository);
    }
  }
  if (
    repositories.length < 1 ||
    repositories.length > 32 ||
    sources.length > 32
  )
    throw new SharedMultiRepoSelectionError(
      'repository_mismatch',
      'Select between 1 and 32 repositories',
    );
  if (
    params.mode === 'add-repositories' &&
    repositories.every((repo) => firstIdentities.has(repoIdentity(repo)))
  )
    throw new SharedMultiRepoSelectionError(
      'repository_mismatch',
      'Select at least one additional repository',
    );
  const suggestion =
    sources.map((project) => project.name).join(' + ') +
    (sources.length === 1 ? ' + repositories' : '');
  let suggestedName = '';
  for (const character of suggestion) {
    if ((suggestedName + character).length > 256) break;
    suggestedName += character;
  }
  return {
    organizationId,
    sourceProjects: sources.map((project) => ({
      projectId: project.id,
      expectedRevision: project.revision,
    })),
    repositories,
    lockedProjectIds: params.mode === 'add-repositories' ? firstSourceIds : [],
    suggestedName,
    canCreate:
      (membership?.role === 'OWNER' || membership?.role === 'ADMIN') &&
      credentials.capabilities.includes(SHARED_MULTI_REPO_HOSTED_CAPABILITY) &&
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      ),
  };
}
async function currentCredentials(
  caller: CanopyCallerDescriptor,
  journal: SharedMultiRepoCreationJournal,
): Promise<Awaited<ReturnType<typeof getCanopyCloudCredentials>>> {
  const current = await identity(caller);
  if (
    current.accountId !== journal.accountId ||
    current.deviceId !== journal.deviceId
  )
    throw new Error('The account or desktop changed');
  await authorize(caller, journal.status.organizationId);
  return getCanopyCloudCredentials();
}

let coordinator:
  | ReturnType<typeof createSharedMultiRepoCoordinator>
  | undefined;
export const desktopSharedMultiRepoHost: SharedMultiRepoHost = {
  load(): Promise<SharedMultiRepoCoordinator> {
    coordinator ??= createSharedMultiRepoCoordinator({
      identity,
      authorize,
      inspect: prepareDesktopSharedMultiRepo,
      journal: createSharedMultiRepoJournalStore({
        rootDir: getOrgSharedMultiRepoCreationsDir,
        writeAtomic: (path, content) =>
          writeFileAtomically(path, content, { mode: 0o600 }),
      }),
      now: (): string => new Date().toISOString(),
      reportError: (error): void =>
        logMainProcessError('Shared multi-repo operation failed', error),
      create: async (
        caller,
        journal,
      ): Promise<CreateSharedMultiRepoOrgProjectResponse> => {
        const credentials = await currentCredentials(caller, journal);
        const response: unknown = await requestCanopyCloudJson(
          '/api/v1/projects/shared/multi-repo',
          {
            method: 'POST',
            body: JSON.stringify(journal.params.request),
            credentialContext: credentials,
          },
        );
        if (
          typeof response !== 'object' ||
          response === null ||
          !('creationKey' in response) ||
          typeof response.creationKey !== 'string' ||
          !('project' in response) ||
          !isOrgProjectSummary(response.project)
        )
          throw new Error('Invalid shared creation response');
        return { creationKey: response.creationKey, project: response.project };
      },
      setup: async (caller, journal) => {
        await currentCredentials(caller, journal);
        const projectId = journal.status.projectId;
        if (!projectId)
          return { state: 'setup-failed', errorCode: 'invalid-destination' };
        const materialization = getOrgProjectMaterialization();
        const destinationRoot = await resolveOrgProjectSetupDestination();
        await currentCredentials(caller, journal);
        return new Promise<Awaited<ReturnType<SharedMultiRepoPorts['setup']>>>(
          (resolve, reject) => {
            const unsubscribe = materialization.subscribe((progress): void => {
              if (
                progress.projectId !== projectId ||
                !['ready', 'failed', 'cancelled'].includes(progress.state)
              )
                return;
              unsubscribe();
              resolve({
                state:
                  progress.state === 'ready'
                    ? 'ready'
                    : progress.state === 'cancelled'
                      ? 'setup-cancelled'
                      : progress.errorCode === 'completion-pending'
                        ? 'completion-pending'
                        : 'setup-failed',
                errorCode: progress.errorCode,
              });
            });
            void materialization
              .startSetup(projectId, destinationRoot, {
                organizationId: journal.status.organizationId,
                accountId: journal.accountId,
                deviceId: journal.deviceId,
              })
              .catch((error: unknown): void => {
                unsubscribe();
                reject(
                  error instanceof Error
                    ? error
                    : new Error('Setup unavailable'),
                );
              });
          },
        );
      },
      refresh: async (organizationId): Promise<void> => {
        await getOrgProjectCatalogService().refresh(
          { kind: 'organization', organizationId },
          { force: true },
        );
      },
    });
    return Promise.resolve(coordinator);
  },
};

/** Startup recovery is a host lifecycle effect, never a status-query effect. */
export async function resumeDesktopSharedMultiRepoCreations(): Promise<void> {
  const credentials = await getCanopyCloudCredentials();
  if (!credentials.account?.id) return;
  const service = await desktopSharedMultiRepoHost.load();
  await service.resumePending({
    principalId: 'local-desktop-user',
    authorityId: 'local-desktop',
    clientInstanceId: 'shared-multi-repo-startup',
    interfaceKind: 'desktop',
    grants: ['core.workspace.read', 'core.workspace.write'],
  });
}
