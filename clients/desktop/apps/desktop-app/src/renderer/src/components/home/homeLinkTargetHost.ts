import type { SidebarItem } from '@canopy/desktop-shared/types';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import { useProjectsStore } from '@/stores/projectsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { getHomeScope } from './homeScope';
import type {
  HomeLinkMaterializeDeps,
  HomeLinkResolveContext,
  HomeLinkResolveDeps,
} from './homeLinkTarget';

/** Desktop host adapters for `homeLinkTarget.ts`. */

export function createHomeLinkResolveDeps(): HomeLinkResolveDeps {
  return {
    getRepoSlug: (repoPath) => window.api.getRepoSlug({ repoPath }),
    resolvePullRequest: (repoPath, reference) =>
      window.api.resolvePullRequest({ repoPath, reference }),
    searchLinearIssues: (query) => window.api.searchLinearIssues(query),
    listUserGitHubRepos: () => window.api.listUserGitHubRepos(),
  };
}

/** New link projects are Personal; organization scopes must switch first. */
export function canCreatePersonalLinkProject(): boolean {
  const context = getSidebarScopingContext();
  return context === undefined || context.kind === 'personal';
}

export function homeLinkScopeKey(): string {
  const context = getSidebarScopingContext();
  if (context === undefined) return 'unscoped';
  return context.kind === 'organization'
    ? `org:${context.organizationId}`
    : 'personal';
}

export function splitHomeLinkProjects(): {
  projects: SidebarItem[];
  otherScopeProjects: SidebarItem[];
} {
  const scope = getHomeScope();
  return {
    projects: scope.projects,
    otherScopeProjects: useProjectsStore
      .getState()
      .projects.filter((project) => scope.isOutOfScope(project.id)),
  };
}

export function currentHomeLinkResolveContext(
  workspaceId: string | null,
  workspaceSelectionExplicit: boolean,
): HomeLinkResolveContext {
  return {
    workspaceId,
    workspaceSelectionExplicit,
    ...splitHomeLinkProjects(),
    canCreatePersonalProject: canCreatePersonalLinkProject(),
    chosenAttachmentKey:
      useHomeComposerStore.getState().chosenLinkAttachmentKey,
    chosenAttachmentReferenceKey:
      useHomeComposerStore.getState().chosenLinkAttachmentReferenceKey,
  };
}

export function createHomeLinkMaterializeDeps(
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): HomeLinkMaterializeDeps {
  return {
    ...createHomeLinkResolveDeps(),
    getProjects: () => getHomeScope().projects,
    getOtherScopeProjects: () => splitHomeLinkProjects().otherScopeProjects,
    canCreatePersonalProject: canCreatePersonalLinkProject,
    getDefaultCloneDirectory: () => window.api.getDefaultCloneDirectory(),
    probeCloneDestination: (request) =>
      window.api.probeCloneDestination(request),
    addLocalRepo: async (repoPath): Promise<string | null> => {
      const added = await useProjectsStore
        .getState()
        .addLocalRepo(repoPath, { activate: false });
      return added?.id ?? null;
    },
    addRemoteRepo: (remoteUrl, destinationDir, jobId) =>
      useProjectsStore
        .getState()
        .addRemoteRepo(remoteUrl, destinationDir, { jobId }),
    listBranches: async (workspaceId) =>
      (await window.api.homeListBranchTargets({ workspaceId })).branches,
    createJobId: () => crypto.randomUUID(),
    onProgress,
    signal,
    cancelCloneJob: (jobId) => window.api.cancelCloneJob(jobId),
  };
}
