import { basename } from 'node:path';
import { normalizeRemoteUrl } from './repo-url-matcher';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgMultiRepoRepositoryCheckRequest,
  OrgMultiRepoRepositoryCheckResult,
  OrgMultiRepoRepositoryEligibility,
  WorkspaceApplySourceChangesRequest,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import {
  orgOutsideRepositoriesText,
  orgRepositoriesSyncFailedText,
  orgRepositoryCheckFailedText,
  orgRepositoryRemoteUnreadableText,
} from '@canopy/desktop-shared/lib/org-multi-repo-copy';
import {
  resolveMultiRepoRepositories,
  type MultiRepoCheckout,
} from './org-member-multi-repo-repositories';

/** What the organization said to a new repository list. */
export type OrgMultiRepoRepositoriesUpdate =
  | 'updated'
  /** A repository is not one the organization holds (a stale catalog). */
  | 'repository-mismatch'
  | 'failed';

export interface OrgMemberMultiRepoSyncDeps {
  readConfig(workspaceId: string): Promise<WorkspaceConfigFile>;
  /** `null` when the repository has no origin; throws when Git cannot answer. */
  readRemoteUrl(path: string): Promise<string | null>;
  catalog: {
    refresh(organizationId: string): Promise<DesktopOrgProjectCatalogSnapshot>;
  };
  /** The organization's display name, when this account knows it. */
  organizationName(organizationId: string): string | null;
  /** Replace the server project's repositories with these projects'. */
  updateRepositories(
    projectId: string,
    repositoryProjectIds: string[],
  ): Promise<OrgMultiRepoRepositoriesUpdate>;
  /** Undo a local change the organization did not take. */
  revert: {
    removeRepo(workspaceId: string, repoId: string): Promise<void>;
    restoreRepo(
      workspaceId: string,
      repo: WorkspaceRepoData,
      index: number,
    ): Promise<void>;
  };
}

/**
 * Keeps an organization-owned multi-repo project's repositories on the
 * organization (CAN-3546). Its settings add and remove repositories exactly
 * as for a Personal project. Newly gained repositories are validated strictly,
 * by name before any write; retained unheld checkouts remain local and are
 * omitted from the server list. Only held IDs replace the server definition.
 * A change the organization does not take is undone. A repository without a remote is
 * neutral (CAN-3544): it is never refused and never changes the list. A
 * Personal project is passed straight through.
 */
export interface OrgMemberMultiRepoSync {
  /**
   * Which repositories the project could take, before one is chosen: the
   * same catalog and rule `addRepo` refuses by, which stays the authority.
   */
  checkRepositories(
    request: OrgMultiRepoRepositoryCheckRequest,
  ): Promise<OrgMultiRepoRepositoryCheckResult>;
  addRepo(
    workspaceId: string,
    repoPath: string,
    add: () => Promise<WorkspaceRepoData>,
  ): Promise<WorkspaceRepoData>;
  removeRepo(
    workspaceId: string,
    repoId: string,
    remove: () => Promise<void>,
  ): Promise<void>;
  /**
   * Source-controlled additions from settings (`canopy.json` in a worktree).
   * The organization takes the new list first, since the worktree change
   * cannot be undone like a config write; a failed apply restores the list.
   */
  applySourceChanges<T>(
    workspaceId: string,
    request: WorkspaceApplySourceChangesRequest,
    apply: () => Promise<T>,
  ): Promise<T>;
}

interface OrganizationBinding {
  readonly organizationId: string;
  readonly projectId: string;
  readonly organizationName: string;
}

/** Project held checkouts without weakening strict validation of new additions. */
function heldRepositoryProjectIds(
  catalog: readonly OrgProjectSummary[],
  checkouts: readonly MultiRepoCheckout[],
): string[] {
  const ids = new Set<string>();
  for (const checkout of checkouts) {
    const resolution = resolveMultiRepoRepositories(catalog, [checkout]);
    if (resolution.ok)
      for (const id of resolution.repositoryProjectIds) ids.add(id);
    // The resolver's only refusals are understood repository ineligibility.
    // Catalog and Git failures are handled by the calling reads, never omitted here.
  }
  return Array.from(ids);
}

export function createOrgMemberMultiRepoSync(
  deps: OrgMemberMultiRepoSyncDeps,
): OrgMemberMultiRepoSync {
  function bindingOf(config: WorkspaceConfigFile): OrganizationBinding | null {
    if (config.type !== 'multi-repo' || config.owner?.type !== 'organization')
      return null;
    const { organizationId, projectId } = config.owner;
    return {
      organizationId,
      projectId,
      organizationName:
        deps.organizationName(organizationId) ?? 'your organization',
    };
  }

  async function organizationCatalog(
    binding: OrganizationBinding,
  ): Promise<OrgProjectSummary[]> {
    const snapshot = await deps.catalog
      .refresh(binding.organizationId)
      .catch((): null => null);
    // A catalog that could not be refreshed proves nothing either way.
    if (snapshot === null || snapshot.stale || snapshot.error)
      throw new Error(orgRepositoryCheckFailedText(binding.organizationName));
    const organizationId = binding.organizationId.toLowerCase();
    return snapshot.projects.filter(
      (row): boolean => row.organizationId?.toLowerCase() === organizationId,
    );
  }

  /** A checkout with a remote, or `null` for a neutral one. */
  async function checkoutOf(
    name: string,
    path: string,
  ): Promise<MultiRepoCheckout | null> {
    let remoteUrl: string | null;
    try {
      remoteUrl = await deps.readRemoteUrl(path);
    } catch {
      throw new Error(orgRepositoryRemoteUnreadableText(name));
    }
    return remoteUrl === null ? null : { name, remoteUrl, root: false };
  }

  /** The project's checkouts with a remote: its root, then each repository. */
  async function projectCheckouts(
    config: WorkspaceConfigFile,
    repos: readonly WorkspaceRepoData[],
  ): Promise<MultiRepoCheckout[]> {
    const checkouts: MultiRepoCheckout[] = [];
    const paths = [
      ...(config.sourceRepoPath
        ? [
            {
              name: basename(config.sourceRepoPath),
              path: config.sourceRepoPath,
            },
          ]
        : []),
      ...repos.map((repo) => ({ name: repo.name, path: repo.repoPath })),
    ];
    for (const { name, path } of paths) {
      const checkout = await checkoutOf(name, path);
      if (checkout !== null) checkouts.push(checkout);
    }
    return checkouts;
  }

  /** The organization projects these checkouts gather, or a refusal naming them. */
  function repositoryProjectIds(
    catalog: readonly OrgProjectSummary[],
    checkouts: readonly MultiRepoCheckout[],
    binding: OrganizationBinding,
  ): string[] {
    const resolution = resolveMultiRepoRepositories(catalog, checkouts);
    if (resolution.ok) return [...resolution.repositoryProjectIds];
    if (resolution.reason === 'no-repositories') return [];
    throw new Error(
      orgOutsideRepositoriesText(resolution.outside, binding.organizationName),
    );
  }

  async function push(
    binding: OrganizationBinding,
    ids: string[],
  ): Promise<string | null> {
    const outcome = await deps
      .updateRepositories(binding.projectId, ids)
      .catch((): OrgMultiRepoRepositoriesUpdate => 'failed');
    if (outcome === 'updated') return null;
    return outcome === 'repository-mismatch'
      ? orgOutsideRepositoriesText([], binding.organizationName)
      : orgRepositoriesSyncFailedText(binding.organizationName);
  }

  function eligibilityOf(
    catalog: readonly OrgProjectSummary[],
    checkout: MultiRepoCheckout,
  ): OrgMultiRepoRepositoryEligibility {
    return resolveMultiRepoRepositories(catalog, [checkout]).ok
      ? 'eligible'
      : 'outside';
  }

  return {
    async checkRepositories(
      request,
    ): Promise<OrgMultiRepoRepositoryCheckResult> {
      const binding = bindingOf(await deps.readConfig(request.workspaceId));
      if (binding === null) return { kind: 'not-organization' };
      const repositories: Record<string, OrgMultiRepoRepositoryEligibility> =
        {};
      const candidates: { key: string; checkout: MultiRepoCheckout }[] = [];
      for (const repoPath of request.repoPaths ?? []) {
        let checkout: MultiRepoCheckout | null;
        try {
          checkout = await checkoutOf(basename(repoPath), repoPath);
        } catch {
          // Unreadable: left out, so adding it says why.
          continue;
        }
        if (checkout === null) repositories[repoPath] = 'neutral';
        else candidates.push({ key: repoPath, checkout });
      }
      for (const url of request.remoteUrls ?? []) {
        const remoteUrl = url.trim();
        if (remoteUrl) {
          candidates.push({
            key: url,
            checkout: { name: remoteUrl, remoteUrl, root: false },
          });
        } else repositories[url] = 'neutral';
      }
      if (candidates.length > 0) {
        let catalog: OrgProjectSummary[];
        try {
          catalog = await organizationCatalog(binding);
        } catch (error) {
          return {
            kind: 'failed',
            message:
              error instanceof Error
                ? error.message
                : orgRepositoryCheckFailedText(binding.organizationName),
          };
        }
        for (const { key, checkout } of candidates)
          repositories[key] = eligibilityOf(catalog, checkout);
      }
      return {
        kind: 'checked',
        organizationName: binding.organizationName,
        repositories,
      };
    },

    async addRepo(workspaceId, repoPath, add): Promise<WorkspaceRepoData> {
      const config = await deps.readConfig(workspaceId);
      const binding = bindingOf(config);
      if (binding === null) return add();
      const candidate = await checkoutOf(basename(repoPath), repoPath);
      // No remote: nothing the organization could hold, nothing to sync.
      if (candidate === null) return add();
      const catalog = await organizationCatalog(binding);
      // The new repository is refused by name before anything is written.
      repositoryProjectIds(catalog, [candidate], binding);
      const ids = heldRepositoryProjectIds(catalog, [
        ...(await projectCheckouts(config, config.repos)),
        candidate,
      ]);
      const repo = await add();
      const failure = await push(binding, ids);
      if (failure !== null) {
        await deps.revert
          .removeRepo(workspaceId, repo.id)
          .catch((): void => {});
        throw new Error(failure);
      }
      return repo;
    },

    async removeRepo(workspaceId, repoId, remove): Promise<void> {
      const config = await deps.readConfig(workspaceId);
      const binding = bindingOf(config);
      const index = config.repos.findIndex((repo) => repo.id === repoId);
      const removed = config.repos[index];
      if (binding === null || removed === undefined) return remove();
      // A repository without a remote never was on the organization's list.
      // One whose folder can't be read is still removable (CAN-3546).
      const removedCheckout = await checkoutOf(
        removed.name,
        removed.repoPath,
      ).catch((): undefined => undefined);
      if (removedCheckout === null) return remove();
      // A repository left behind that can't be read keeps the server list as
      // it is; the next change that can read them all brings it up to date.
      const remaining = await projectCheckouts(
        config,
        config.repos.filter((repo) => repo.id !== repoId),
      ).catch((): null => null);
      if (remaining === null) return remove();
      const catalog = await organizationCatalog(binding);
      const ids = heldRepositoryProjectIds(catalog, remaining);
      await remove();
      const failure = await push(binding, ids);
      if (failure !== null) {
        await deps.revert
          .restoreRepo(workspaceId, removed, index)
          .catch((): void => {});
        throw new Error(failure);
      }
    },

    async applySourceChanges<T>(
      workspaceId: string,
      request: WorkspaceApplySourceChangesRequest,
      apply: () => Promise<T>,
    ): Promise<T> {
      const additions = request.repoAdds ?? [];
      // Removing a repository from source control keeps it in the project.
      if (additions.length === 0) return apply();
      const config = await deps.readConfig(workspaceId);
      const binding = bindingOf(config);
      if (binding === null) return apply();
      const candidates = additions.flatMap((addition): MultiRepoCheckout[] => {
        const remoteUrl = addition.remoteUrl.trim();
        return remoteUrl
          ? [{ name: addition.repoName, remoteUrl, root: false }]
          : [];
      });
      if (candidates.length === 0) return apply();
      const catalog = await organizationCatalog(binding);
      const current = await projectCheckouts(config, config.repos);
      const knownRemotes = new Set(
        current.flatMap((checkout): string[] =>
          checkout.remoteUrl === null ? [] : [checkout.remoteUrl.trim()],
        ),
      );
      const knownIdentities = new Set(
        current.flatMap((checkout): string[] => {
          const identity =
            checkout.remoteUrl === null
              ? null
              : normalizeRemoteUrl(checkout.remoteUrl, true);
          return identity === null ? [] : [identity];
        }),
      );
      const gained = candidates.filter((candidate): boolean => {
        const identity =
          candidate.remoteUrl === null
            ? null
            : normalizeRemoteUrl(candidate.remoteUrl, true);
        // A retained remote unsupported by canonical matching is still the
        // same repository when its exact remote is unchanged.
        return identity === null
          ? !knownRemotes.has(candidate.remoteUrl ?? '')
          : !knownIdentities.has(identity);
      });
      // An unrelated source edit cannot smuggle in an unheld repository.
      repositoryProjectIds(catalog, gained, binding);
      const gainedCheckouts = gained.filter((candidate): boolean =>
        additions.some(
          (addition) =>
            addition.repoPath !== undefined &&
            addition.repoName === candidate.name &&
            addition.remoteUrl.trim() === candidate.remoteUrl,
        ),
      );
      if (gainedCheckouts.length === 0) return apply();
      const before = heldRepositoryProjectIds(catalog, current);
      const after = heldRepositoryProjectIds(catalog, [
        ...current,
        ...gainedCheckouts,
      ]);
      const failure = await push(binding, after);
      if (failure !== null) throw new Error(failure);
      try {
        return await apply();
      } catch (error) {
        await push(binding, before);
        throw error;
      }
    },
  };
}
