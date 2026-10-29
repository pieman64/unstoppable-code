import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { normalizeRemoteUrl } from './repo-url-matcher';
import type {
  OrgProjectRelationship,
  SidebarItem,
} from '@canopy/desktop-shared/types';

export interface PersonalRepository extends Pick<
  SidebarItem,
  'id' | 'type' | 'owner'
> {
  remoteUrl: string | null;
}

/**
 * A project whose repository a member's multi-repo project may gather
 * (CAN-3532), which is what the server accepts: an ACTIVE, usable,
 * organization-visible, single-repository local code project.
 */
export function holdsOrganizationRepository(
  project: OrgProjectSummary,
): boolean {
  return (
    project.state === 'ACTIVE' &&
    project.capabilities.use &&
    project.kind === 'CODE' &&
    project.location === 'LOCAL' &&
    project.purpose !== 'default-chats' &&
    project.visibility !== 'private' &&
    project.topology !== 'multi-repo' &&
    project.repository !== null
  );
}

/** Device-only comparison. No filesystem, provider lookup, telemetry or catalog mutation. */
export function computeRelationships(
  allProjects: readonly OrgProjectSummary[],
  sidebarItems: readonly PersonalRepository[],
): OrgProjectRelationship[] {
  // A multi-repository project (CAN-3532) is a member's converted multi-repo
  // project. It copies organization repositories, so it is never what one
  // checkout of them belongs to.
  const catalog = allProjects.filter(
    (project): boolean => project.topology !== 'multi-repo',
  );
  const relationships: OrgProjectRelationship[] = [];
  for (const item of sidebarItems) {
    if (
      item.type === 'single-repo' &&
      item.owner?.type === undefined &&
      item.remoteUrl
    ) {
      const remote = normalizeRemoteUrl(item.remoteUrl, true);
      if (remote === null) continue;
      const aliases = catalog.filter((project): boolean => {
        const repository = project.repository;
        if (repository === null || (repository.provider === 'github') === false)
          return false;
        const identity = normalizeRemoteUrl(
          `https://${repository.host}/${repository.owner}/${repository.name}`,
          true,
        );
        return identity === remote;
      });
      const verified = aliases.filter(
        (project): boolean =>
          project.repository?.verification === 'VERIFIED' &&
          Boolean(project.repository.providerRepoId),
      );
      const ids = new Set(
        verified.map(
          (project): string | null | undefined =>
            project.repository?.providerRepoId,
        ),
      );
      if (ids.size > 1) continue;
      // A verified alias resolves the immutable identity. Other verified
      // catalog definitions of that identity can use its renamed alias.
      // Name-only fallback has no such evidence and must be unambiguous.
      const verifiedId = verified[0]?.repository?.providerRepoId;
      const host = remote.split('/')[0];
      const candidates =
        verified.length > 0
          ? catalog.filter(
              (project): boolean =>
                project.repository?.provider === 'github' &&
                project.repository.host.toLowerCase() === host &&
                project.repository.verification === 'VERIFIED' &&
                project.repository.providerRepoId === verifiedId,
            )
          : aliases.length === 1
            ? aliases
            : [];
      for (const project of candidates) {
        if (project.state === 'ACTIVE' && project.capabilities.use)
          relationships.push({
            projectId: project.id,
            personalWorkspaceId: item.id,
          });
      }
    }
  }
  return relationships;
}

/** One organization's catalog; `null` when it has never been fetched. */
export interface OrganizationCatalog {
  readonly organizationId: string;
  readonly projects: readonly OrgProjectSummary[] | null;
}

export interface OrganizationRepositoryMatch {
  readonly organizationId: string;
  readonly project: OrgProjectSummary;
}

/**
 * The projects, across the member's organizations, whose repository is the one
 * at `remoteUrl`: the same-repository rule ({@link computeRelationships}) over
 * each organization's whole catalog, so a verified identity resolves renamed
 * aliases, keeping only the projects `accepts` takes. `unknown` is set when a
 * catalog has never been fetched, since that organization could hold the
 * repository too.
 */
export function matchOrganizationRepository(
  catalogs: readonly OrganizationCatalog[],
  remoteUrl: string,
  accepts: (project: OrgProjectSummary) => boolean,
): { matches: OrganizationRepositoryMatch[]; unknown: boolean } {
  const matches: OrganizationRepositoryMatch[] = [];
  let unknown = false;
  for (const { organizationId, projects } of catalogs) {
    if (projects === null) {
      unknown = true;
      continue;
    }
    for (const relationship of computeRelationships(projects, [
      { id: 'repository', type: 'single-repo', remoteUrl },
    ])) {
      const project = projects.find(
        (candidate): boolean => candidate.id === relationship.projectId,
      );
      if (project && accepts(project))
        matches.push({ organizationId, project });
    }
  }
  return { matches, unknown };
}
