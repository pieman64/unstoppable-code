import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  computeRelationships,
  holdsOrganizationRepository,
} from './org-project-relationships';

/** One checkout of a multi-repo project, as Add project sees it (CAN-3546). */
export interface MultiRepoCheckout {
  /** Names the checkout when the organization does not hold its repository. */
  readonly name: string;
  readonly remoteUrl: string | null;
  /** The project's own root folder. Like any checkout without a remote, it is neutral (CAN-3544). */
  readonly root: boolean;
}

export type MultiRepoRepositoryResolution =
  | { readonly ok: true; readonly repositoryProjectIds: readonly string[] }
  /** No checkout has a remote: nothing could belong to the organization. */
  | { readonly ok: false; readonly reason: 'no-repositories' }
  | {
      readonly ok: false;
      readonly reason: 'outside-organization';
      /** The names of the checkouts no project of the organization holds. */
      readonly outside: readonly string[];
    };

/**
 * Strict eligibility for Add project and newly gained settings repositories:
 * each checkout's repository must be held by an ACTIVE, usable,
 * single-repository project of
 * the organization (provider identity when verified, otherwise one
 * unambiguous remote URL match). Pure: callers read the remotes and refresh
 * the catalog.
 */
export function resolveMultiRepoRepositories(
  catalog: readonly OrgProjectSummary[],
  checkouts: readonly MultiRepoCheckout[],
): MultiRepoRepositoryResolution {
  const repositoryProjectIds: string[] = [];
  const outside: string[] = [];
  for (const checkout of checkouts) {
    // A checkout without a remote holds no repository the organization could
    // hold, root or not, so it is neutral (CAN-3544).
    if (checkout.remoteUrl === null) continue;
    const [holder] = computeRelationships(catalog, [
      {
        id: 'multi-repo-checkout',
        type: 'single-repo',
        remoteUrl: checkout.remoteUrl,
      },
    ])
      .flatMap((relationship): OrgProjectSummary[] =>
        catalog.filter(
          (row): boolean =>
            row.id === relationship.projectId &&
            holdsOrganizationRepository(row),
        ),
      )
      .map((row): string => row.id)
      .sort((left, right): number => left.localeCompare(right));
    if (holder === undefined) {
      if (!outside.includes(checkout.name)) outside.push(checkout.name);
      continue;
    }
    if (!repositoryProjectIds.includes(holder))
      repositoryProjectIds.push(holder);
  }
  if (outside.length > 0)
    return { ok: false, reason: 'outside-organization', outside };
  if (repositoryProjectIds.length === 0)
    return { ok: false, reason: 'no-repositories' };
  return { ok: true, repositoryProjectIds };
}
