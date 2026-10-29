import { join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  OrgRepositoryOwnerLookup,
  OrgRepositoryOwnerRequest,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import { ORG_PROJECTS_CAPABILITY_V1 } from '../services/org-project-auto-conversion';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { getCanopyCloudCredentials } from './canopy-cloud-account-store';
import {
  getGitCommonDir,
  getRemoteUrlStrict,
  getWorktreeTopLevel,
  isGitRepo,
} from './git';
import { getOrgMemberFolderInspector } from './org-member-folder-inspection';
import {
  holdsOrganizationRepository,
  matchOrganizationRepository,
  type OrganizationCatalog,
} from './org-project-relationships';
import { getWorkspaceContextService } from './workspace-context-service';

/**
 * The create-time nudge of the hybrid organization-project model: before the
 * Add project dialog adds a folder or clones a URL, it asks which of the
 * member's organizations holds that repository, so it can offer to add it
 * there instead. Projects are never moved between scopes automatically after
 * the one-time migration; this only advises.
 *
 * The answer is advisory and fails open: a flag that is off, a missing
 * capability or account, an unknown catalog, an ambiguous match, any error,
 * and a lookup that runs past its time box all answer `none`, and the dialog
 * adds exactly as it did before.
 */

const NONE: OrgRepositoryOwnerLookup = { kind: 'none' };

/** The lookup runs on a click and never holds the dialog longer than this. */
export const ORG_REPOSITORY_OWNER_TIMEOUT_MS = 3_000;

export interface OrgRepositoryOwnerLookupDeps {
  /** The organization-projects rollout flag. */
  enabled(): boolean;
  access(): Promise<{
    readonly accountId: string | null;
    readonly capabilities: readonly string[];
    readonly organizations: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
    }>;
  }>;
  realpath(path: string): Promise<string>;
  git: {
    /** The checkout's top level, or `null` when the folder is not in one. */
    topLevel(path: string): Promise<string | null>;
    commonDir(path: string): Promise<string>;
    remoteUrl(path: string): Promise<string | null>;
  };
  /** One organization's cached catalog; `null` when it is not known. */
  loadCatalog(
    organizationId: string,
  ): Promise<readonly OrgProjectSummary[] | null>;
  /**
   * Whether an organization's Existing folder could take this folder (the
   * folder check's own placement step): a folder that overlaps another
   * project is refused there, so the nudge must not offer it.
   */
  canPlace(path: string): Promise<boolean>;
  timeoutMs: number;
}

export interface OrgRepositoryOwnerFinder {
  find(request: OrgRepositoryOwnerRequest): Promise<OrgRepositoryOwnerLookup>;
}

/**
 * A project the nudge may name: one whose repository the organization holds
 * for its members (the multi-repo rule, `holdsOrganizationRepository`), and
 * not a member's own private project.
 */
function nudgesTo(project: OrgProjectSummary): boolean {
  return holdsOrganizationRepository(project) && !project.memberOwned;
}

export function createOrgRepositoryOwnerLookup(
  deps: OrgRepositoryOwnerLookupDeps,
): OrgRepositoryOwnerFinder {
  /** A top-level, non-linked-worktree checkout's `origin`; otherwise `null`. */
  async function folderRemote(candidatePath: string): Promise<string | null> {
    const path = await deps.realpath(candidatePath);
    const topLevel = await deps.git.topLevel(path);
    if (topLevel === null) return null;
    if ((await deps.realpath(topLevel)) !== path) return null;
    const commonDir = await deps.git.commonDir(path);
    const ownGitDir = await deps
      .realpath(join(path, '.git'))
      .catch((): string => resolve(path, '.git'));
    if (resolve(commonDir) !== resolve(ownGitDir)) return null;
    return deps.git.remoteUrl(path);
  }

  async function lookup(
    request: OrgRepositoryOwnerRequest,
  ): Promise<OrgRepositoryOwnerLookup> {
    if (!deps.enabled()) return NONE;
    const access = await deps.access();
    if (
      !access.accountId ||
      !access.capabilities.includes(ORG_PROJECTS_CAPABILITY_V1) ||
      access.organizations.length === 0
    )
      return NONE;
    const remoteUrl =
      request.path !== undefined
        ? await folderRemote(request.path)
        : request.remoteUrl;
    if (remoteUrl === null) return NONE;
    const catalogs: OrganizationCatalog[] = [];
    for (const organization of access.organizations)
      catalogs.push({
        organizationId: organization.id,
        projects: await deps.loadCatalog(organization.id),
      });
    const { matches, unknown } = matchOrganizationRepository(
      catalogs,
      remoteUrl,
      nudgesTo,
    );
    // Never guess: several projects, several organizations, or an
    // organization whose catalog is unknown and could hold it too.
    const [match] = matches;
    if (unknown || matches.length !== 1 || match === undefined) return NONE;
    const organization = access.organizations.find(
      (candidate): boolean =>
        candidate.id.toLowerCase() === match.organizationId.toLowerCase(),
    );
    const repository = match.project.repository;
    if (organization === undefined || repository === null) return NONE;
    // "Add to <organization>" continues through that organization's folder
    // check; never offer a folder it would refuse.
    if (request.path !== undefined && !(await deps.canPlace(request.path)))
      return NONE;
    return {
      kind: 'organization',
      organizationId: organization.id,
      organizationName: organization.name,
      projectId: match.project.id,
      projectName: match.project.name,
      repositoryName: `${repository.owner}/${repository.name}`,
    };
  }

  return {
    async find(request): Promise<OrgRepositoryOwnerLookup> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<OrgRepositoryOwnerLookup>((settle): void => {
        timer = setTimeout((): void => settle(NONE), deps.timeoutMs);
      });
      try {
        return await Promise.race([
          lookup(request).catch((): OrgRepositoryOwnerLookup => NONE),
          timedOut,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let finder: OrgRepositoryOwnerFinder | undefined;

export function getOrgRepositoryOwnerLookup(): OrgRepositoryOwnerFinder {
  finder ??= createOrgRepositoryOwnerLookup({
    enabled: (): boolean =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
      ),
    access: async () => {
      const organizations = getWorkspaceContextService()
        .getState()
        .organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
        }));
      try {
        const credentials = await getCanopyCloudCredentials();
        return {
          accountId: credentials.account?.id ?? null,
          capabilities: credentials.capabilities,
          organizations,
        };
      } catch {
        // Signed out or the account store is unreadable: no nudge.
        return { accountId: null, capabilities: [], organizations };
      }
    },
    realpath,
    git: {
      topLevel: async (path): Promise<string | null> =>
        (await isGitRepo(path)) ? getWorktreeTopLevel(path) : null,
      commonDir: getGitCommonDir,
      remoteUrl: getRemoteUrlStrict,
    },
    // The cached catalog (memory or disk); never a forced refresh, since the
    // member is waiting on the click. Only a catalog never fetched is
    // fetched, inside the lookup's time limit. A cached catalog whose latest
    // refresh failed still says which projects exist, as auto-conversion
    // reads it.
    loadCatalog: async (
      organizationId,
    ): Promise<readonly OrgProjectSummary[] | null> => {
      const snapshot = await getOrgProjectCatalogService().list({
        kind: 'organization',
        organizationId,
      });
      if (
        snapshot.error === 'access-changed' ||
        snapshot.error === 'unavailable'
      )
        return [];
      if (snapshot.error !== null && snapshot.revision === '') return null;
      return snapshot.projects.filter(
        (project): boolean =>
          project.organizationId?.toLowerCase() ===
          organizationId.toLowerCase(),
      );
    },
    canPlace: (path) => getOrgMemberFolderInspector().canPlace(path),
    timeoutMs: ORG_REPOSITORY_OWNER_TIMEOUT_MS,
  });
  return finder;
}
