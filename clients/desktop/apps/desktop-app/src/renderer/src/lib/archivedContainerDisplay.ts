/**
 * Display-name rule for archived worktree containers, matching live worktree
 * rows (`WorktreeItem`): an explicit user label wins; otherwise the recorded
 * branch name runs through the branch display-name mapper (default generated
 * branches render as the shared default worktree display name).
 */
import type {
  ArchivedContainerPullRequestRepoStatus,
  ArchivedContainerSummary,
  ArchivedPullRequestMetadata,
  ArchivedPullRequestState,
} from '@canopy/desktop-shared/types';
import type { PrStatusData } from '@canopy/desktop-shared/types/github';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';

export function getArchivedContainerDisplayName(
  summary: Pick<
    ArchivedContainerSummary,
    'id' | 'kind' | 'name' | 'label' | 'branchName'
  >,
  getBranchDisplayName: (branchName: string) => string,
): string {
  if (summary.kind !== 'worktree') {
    return summary.name;
  }
  // Manifests written before `label` existed stored the label into `name`;
  // a `name` that differs from the recorded branch can only be a label.
  const label =
    summary.label?.trim() ||
    (summary.branchName !== undefined && summary.name !== summary.branchName
      ? summary.name
      : undefined);
  if (label) {
    return label;
  }
  return getWorktreeBranchDisplayName({
    rawBranch: summary.branchName ?? summary.name,
    worktreeId: summary.id,
    hasMultipleBranches: false,
    getBranchDisplayName,
  });
}

/** Aggregate stats shown on archived-worktree sidebar rows / viewer header. */
export interface ArchivedGitChangesBadgeInfo {
  fileCount: number;
  insertions: number;
  deletions: number;
}

/**
 * Captured aggregate Git statistics eligible for badge display: version-2
 * worktree summaries whose capture completed with at least one changed file.
 * Clean, stats-unavailable, legacy (version-1), and work-entry archives get
 * no badge. Reads only the manifest aggregate — never triggers list work.
 */
export function getArchivedGitChangesBadge(
  summary: ArchivedContainerSummary,
): ArchivedGitChangesBadgeInfo | null {
  if (summary.version !== 2) {
    return null;
  }
  const gitChanges = summary.gitChanges;
  if (gitChanges.status !== 'complete' || gitChanges.fileCount === 0) {
    return null;
  }
  return {
    fileCount: gitChanges.fileCount,
    insertions: gitChanges.insertions,
    deletions: gitChanges.deletions,
  };
}

export function getArchivedGitChangesTooltip(
  badge: ArchivedGitChangesBadgeInfo,
): string {
  const files = `${badge.fileCount} changed file${
    badge.fileCount === 1 ? '' : 's'
  }`;
  return badge.insertions === 0 && badge.deletions === 0
    ? `${files}\nSome changes do not affect line totals.`
    : files;
}

/** One confirmed archive-time PR association for a single repository. */
export interface ArchivedPullRequestAssociation {
  repoId: string;
  repoName: string;
  pullRequest: ArchivedPullRequestMetadata;
}

const PULL_REQUEST_STATE_LABELS: Record<ArchivedPullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  closed: 'Closed',
  merged: 'Merged',
};

/** Human display label (`Open` / `Draft` / `Closed` / `Merged`). */
export function getArchivedPullRequestStateLabel(
  state: ArchivedPullRequestState,
): string {
  return PULL_REQUEST_STATE_LABELS[state];
}

/**
 * Confirmed archive-time PR associations from the immutable capture, in the
 * capture's repository order. Only `status: 'complete'` entries with a
 * non-null `pullRequest` qualify — confirmed-none (`pullRequest: null`) and
 * `unavailable` lookups, legacy (version-1), and work-entry archives return
 * an empty list. Pure projection of the archived summary: never infers a PR
 * from cached live state and never issues a backend or GitHub request.
 */
export function getArchivedPullRequestAssociations(
  summary: ArchivedContainerSummary,
): ArchivedPullRequestAssociation[] {
  if (summary.version !== 2 || summary.kind !== 'worktree') {
    return [];
  }
  const associations: ArchivedPullRequestAssociation[] = [];
  for (const repository of summary.pullRequestMetadata.repositories) {
    if (repository.status === 'complete' && repository.pullRequest !== null) {
      associations.push({
        repoId: repository.repoId,
        repoName: repository.repoName,
        pullRequest: repository.pullRequest,
      });
    }
  }
  return associations;
}

/**
 * Sidebar-row pull-request indicator: a plain icon plus its hover text. The
 * sidebar deliberately shows no state color or number chip — just "this
 * archive had a PR" — so the row stays readable and rendering it never costs
 * a Git, GitHub, or changed-file lookup.
 */
export interface ArchivedPullRequestIndicatorInfo {
  /** Hover/accessible text, e.g. `PR #123`. */
  tooltip: string;
}

/**
 * Hover text for the archived sidebar-row PR icon: `PR #123` for a single
 * confirmed association, one `{repo}: PR #123` line per repository when an
 * archive captured several. No confirmed association yields no indicator.
 */
export function getArchivedPullRequestIndicator(
  summary: ArchivedContainerSummary,
): ArchivedPullRequestIndicatorInfo | null {
  const associations = getArchivedPullRequestAssociations(summary);
  if (associations.length === 0) {
    return null;
  }
  if (associations.length === 1) {
    return { tooltip: `PR #${associations[0].pullRequest.number}` };
  }
  return {
    tooltip: associations
      .map(
        ({ repoName, pullRequest }) => `${repoName}: PR #${pullRequest.number}`,
      )
      .join('\n'),
  };
}

/**
 * One repository's pull request as the archive viewer header renders it: the
 * live GitHub status when an on-demand refresh resolved one, plus the
 * immutable archive-time capture. At least one side is always present.
 *
 * A `null` live status is never treated as "the PR is gone" — the refresh
 * cannot distinguish that from a failed lookup, a missing token, or a
 * non-GitHub remote — so the captured state remains the fallback.
 */
export interface ArchivedPullRequestDisplayEntry {
  repoId: string;
  repoName: string;
  live: PrStatusData | null;
  captured: ArchivedPullRequestMetadata | null;
}

/**
 * Merge the immutable capture with an optional live refresh, in capture order
 * followed by any repository the refresh newly resolved a PR for. Repositories
 * with neither a captured nor a live pull request are omitted.
 */
export function getArchivedPullRequestDisplayEntries(
  summary: ArchivedContainerSummary,
  liveRepos: readonly ArchivedContainerPullRequestRepoStatus[] = [],
): ArchivedPullRequestDisplayEntry[] {
  const liveByRepoId = new Map(liveRepos.map((repo) => [repo.repoId, repo]));
  const entries: ArchivedPullRequestDisplayEntry[] = [];
  const seen = new Set<string>();
  for (const association of getArchivedPullRequestAssociations(summary)) {
    seen.add(association.repoId);
    entries.push({
      repoId: association.repoId,
      repoName: association.repoName,
      live: liveByRepoId.get(association.repoId)?.status ?? null,
      captured: association.pullRequest,
    });
  }
  for (const repo of liveRepos) {
    if (seen.has(repo.repoId) || repo.status === null) {
      continue;
    }
    entries.push({
      repoId: repo.repoId,
      repoName: repo.repoName,
      live: repo.status,
      captured: null,
    });
  }
  return entries;
}

/**
 * Whether opening this archive should spend a live GitHub lookup. Archives
 * whose capture confirmed "no pull request" for every repository are skipped;
 * an `unavailable` capture is exactly the case a refresh can repair.
 */
export function shouldRefreshArchivedPullRequests(
  summary: ArchivedContainerSummary,
): boolean {
  if (summary.version !== 2 || summary.kind !== 'worktree') {
    return false;
  }
  return summary.pullRequestMetadata.repositories.some(
    (repository) =>
      repository.status === 'unavailable' || repository.pullRequest !== null,
  );
}

/**
 * Viewer-row tooltip/accessibility copy for one confirmed association:
 * `{State} — captured when archived on {formatted capturedAt}`. The caller
 * supplies the already-formatted capture date so this stays a pure string
 * projection.
 */
export function getArchivedPullRequestRowDescription(
  state: ArchivedPullRequestState,
  formattedCapturedAt: string,
): string {
  return `${getArchivedPullRequestStateLabel(state)} — captured when archived on ${formattedCapturedAt}`;
}

/**
 * User-facing state of a retained container. A locked container (`lockedAt`
 * set) is an "Archived" item kept until the user deletes it; an unlocked one
 * is a "Deleted" item the retention sweep removes at `expiresAt`.
 */
import type { ArchivedContainerState } from '@canopy/ui-shared/lib';
export {
  getArchivedContainerStateLabel,
  getArchivedContainerStateDescription,
  type ArchivedContainerState,
} from '@canopy/ui-shared/lib';

export function getArchivedContainerState(
  summary: Pick<ArchivedContainerSummary, 'lockedAt'>,
): ArchivedContainerState {
  return summary.lockedAt !== undefined ? 'archived' : 'deleted';
}

/**
 * Whether the container's measured footprint is available. Fresh archives
 * (and archives created before measurement existed) report their size once
 * the background measurement lands; until then callers show a placeholder.
 */
export function getArchivedContainerDiskUsageBytes(
  summary: Pick<ArchivedContainerSummary, 'diskUsage'>,
): number | null {
  return summary.diskUsage?.totalBytes ?? null;
}

/**
 * Bytes guaranteed to be released by permanent deletion. Git objects are
 * excluded because another ref or archive may retain the same objects.
 */
export function getArchivedContainerGuaranteedReclaimableBytes(
  summary: Pick<ArchivedContainerSummary, 'diskUsage'>,
): number | null {
  return summary.diskUsage?.filesBytes ?? null;
}

/** Whether a displayed total is exact rather than a lower bound. */
export function isArchivedContainerDiskUsageComplete(
  summary: Pick<ArchivedContainerSummary, 'version' | 'diskUsage'>,
): boolean {
  if (summary.diskUsage === undefined) return false;
  return summary.version === 1 || summary.diskUsage.gitBytesComplete === true;
}
