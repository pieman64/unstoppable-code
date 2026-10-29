import { useEffect, useState } from 'react';
import type { OrgMultiRepoRepositoryEligibility } from '@canopy/desktop-shared/types';
import { orgOutsideRepositoriesText } from '@canopy/desktop-shared/lib/org-multi-repo-copy';

/**
 * Which repositories an organization's multi-repo project can take, as main
 * decides it (CAN-3546). Main's refusal when a repository is added stays the
 * authority; this only spares the member choosing one it will refuse.
 */
export interface OrgRepositoryEligibility {
  organizationName: string;
  repositories: Readonly<Record<string, OrgMultiRepoRepositoryEligibility>>;
}

/**
 * Checks the Existing choices of an organization's project while `active`.
 * `null` until checked, and for a Personal project: every choice is enabled.
 */
export function useOrgRepositoryEligibility(
  workspaceId: string,
  organizationOwned: boolean,
  repoPaths: readonly string[],
  active: boolean,
): OrgRepositoryEligibility | null {
  const [eligibility, setEligibility] =
    useState<OrgRepositoryEligibility | null>(null);
  const pathsKey = repoPaths.join('\n');

  useEffect(() => {
    if (!organizationOwned || !active || pathsKey === '') return;
    let cancelled = false;
    window.api.orgProjects
      .checkRepositories({ workspaceId, repoPaths: pathsKey.split('\n') })
      .then((result): void => {
        if (cancelled || result.kind !== 'checked') return;
        setEligibility({
          organizationName: result.organizationName,
          repositories: result.repositories,
        });
      })
      // Unchecked choices stay enabled; adding one is still checked.
      .catch((): void => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, organizationOwned, active, pathsKey]);

  return organizationOwned ? eligibility : null;
}

export type OrgRepositoryCandidate =
  | { kind: 'folder'; repoPath: string; name: string }
  | { kind: 'remote'; remoteUrl: string; name: string };

/**
 * Why an organization's project refuses a chosen folder or clone URL, said
 * before it is staged, or `null` when it may be staged.
 */
export async function orgRepositoryRefusal(
  workspaceId: string,
  candidate: OrgRepositoryCandidate,
): Promise<string | null> {
  const key =
    candidate.kind === 'folder' ? candidate.repoPath : candidate.remoteUrl;
  try {
    const result = await window.api.orgProjects.checkRepositories(
      candidate.kind === 'folder'
        ? { workspaceId, repoPaths: [key] }
        : { workspaceId, remoteUrls: [key] },
    );
    if (result.kind === 'not-organization') return null;
    if (result.kind === 'failed') return result.message;
    return result.repositories[key] === 'outside'
      ? orgOutsideRepositoriesText([candidate.name], result.organizationName)
      : null;
  } catch {
    // Saving checks it again and says why.
    return null;
  }
}

/** The repository name a clone URL names, for a refusal. */
export function repositoryNameFromUrl(remoteUrl: string): string {
  const last = remoteUrl.trim().split(/[/:]/).filter(Boolean).pop();
  return last ? last.replace(/\.git$/, '') : remoteUrl;
}
