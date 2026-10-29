import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { useSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';

/**
 * Desktop loaders for the shared team/organization pickers. Every share modal
 * passes these to `useShareTargetSearch` so the IPC call, the query shape and
 * the failure handling stay identical across surfaces. A failed IPC result
 * rejects, so the hook's error slot is the single place failures surface.
 */

// Failure copy, not empty-state copy: the picker renders a rejection in its
// error slot, so it must not read like "No teams found." (the empty state).
export const TEAMS_LOAD_FAILED = "Couldn't load teams. Try again.";
export const ORGANIZATIONS_LOAD_FAILED =
  "Couldn't load organizations. Try again.";

export async function loadSharedTeams(
  query?: string,
): Promise<readonly CanopyTeamSummary[]> {
  const result = await window.pipelines.listSharedTeams(
    query ? { q: query } : {},
  );
  if (!result.success || !result.data) {
    throw new Error(result.error ?? TEAMS_LOAD_FAILED);
  }
  return result.data.data;
}

export async function loadSharedOrganizations(
  query?: string,
): Promise<readonly CanopyOrganizationSummary[]> {
  const result = await window.pipelines.listSharedOrganizations(
    query ? { q: query } : {},
  );
  if (!result.success || !result.data) {
    throw new Error(result.error ?? ORGANIZATIONS_LOAD_FAILED);
  }
  return result.data.data;
}

/** Maps a rejected loader to the canonical shared-resource error copy. */
export function formatShareTargetError(error: unknown): string {
  return resolveSharedResourceErrorMessage(error);
}

/** Personal has no Team/Organization destination for a brand-new share. */
export function teamOrgShareEntryVisible(
  context: WorkspaceContext | undefined,
  hasExistingShare: boolean,
): boolean {
  return context?.kind !== 'personal' || hasExistingShare;
}

/** Apply the selected-context entry-point rule in renderer components. */
export function useTeamOrgShareEntryVisible(
  hasExistingShare: boolean,
): boolean {
  return teamOrgShareEntryVisible(useSidebarScopingContext(), hasExistingShare);
}
