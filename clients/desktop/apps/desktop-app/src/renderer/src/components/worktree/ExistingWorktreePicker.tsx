import { useMemo, useState, type JSX } from 'react';
import type {
  ExistingWorktreeJoinCandidate,
  ExistingWorktreeJoinWorkspaceGroup,
} from '@canopy/desktop-shared/types';
import { Tooltip } from '@canopy/ui-shared';
import { ChevronDownIcon, ChevronRightIcon } from '@canopy/ui-shared/icons';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { SearchIcon } from '../shared/SearchIcon';
import { WorkspaceBadgeIcon } from '../shared/WorkspaceBadgeIcon';
import { describeWorkspaceSubtitle } from '../shared/workspaceEntry';
import { DiffBadge } from './DiffBadge';
import { getWorktreeRecordKey } from './worktree-record-key';

export interface ExistingWorktreeSelection {
  workspaceId: string;
  worktreeId: string;
}

interface ExistingWorktreePickerProps {
  groups: ExistingWorktreeJoinWorkspaceGroup[];
  selected: ExistingWorktreeSelection | null;
  onSelect: (candidate: ExistingWorktreeJoinCandidate) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
}

/**
 * `busyReason` covers main-process-detectable states; the both-dirty overlap
 * conflict is derived here so the same payload also feeds the warning area
 * for one-side-dirty overlaps.
 */
export function getCandidateDisabledReason(
  candidate: ExistingWorktreeJoinCandidate,
): string | null {
  switch (candidate.busyReason) {
    case 'active-chat':
      return 'This worktree has an active chat session.';
    case 'running-pipeline':
      return 'This worktree has a running pipeline execution.';
    case 'setup-pending':
      return 'This worktree is still being set up.';
    case 'health-issue':
      return 'This worktree has a health issue.';
    case undefined:
      break;
  }
  const conflicted = candidate.repoOverlaps.filter(
    (overlap) => overlap.sourceHasChanges && overlap.targetHasChanges,
  );
  if (conflicted.length > 0) {
    return `Both worktrees have changes in ${conflicted
      .map((overlap) => overlap.repoName)
      .join(', ')}. Commit or discard changes on one side first.`;
  }
  // No-op join: the target brings in no new repos and loses every overlap
  // (its checkouts are all clean and left behind), so nothing would merge.
  if (
    !candidate.addsNewRepo &&
    candidate.repoOverlaps.length > 0 &&
    candidate.repoOverlaps.every((overlap) => !overlap.targetHasChanges)
  ) {
    return 'Joining this worktree would make no changes: its repos are already here with no changes to bring over.';
  }
  return null;
}

/**
 * Per-repo warnings for a joinable candidate: which side's changes will be
 * kept when exactly one side is dirty, or which clean branch is left behind
 * when both sides are clean but on different branches. Both-dirty overlaps
 * are covered by `getCandidateDisabledReason` and emit no warning here.
 */
export function getCandidateWarnings(
  candidate: ExistingWorktreeJoinCandidate,
): string[] {
  const warnings: string[] = [];
  for (const overlap of candidate.repoOverlaps) {
    if (overlap.sourceHasChanges && overlap.targetHasChanges) {
      continue;
    }
    if (overlap.sourceHasChanges) {
      warnings.push(
        `${overlap.repoName}: changes from this worktree will be kept.`,
      );
    } else if (overlap.targetHasChanges) {
      warnings.push(
        `${overlap.repoName}: changes from the selected worktree will be kept.`,
      );
    } else if (overlap.sourceBranch !== overlap.targetBranch) {
      warnings.push(
        `${overlap.repoName} stays on ${overlap.sourceBranch}; ${overlap.targetBranch} from the selected worktree is left behind.`,
      );
    }
  }
  return warnings;
}

/**
 * Condensed joinable-worktree picker: candidates grouped under non-selectable
 * workspace headers, exactly one selectable at a time. Selection and search
 * are fully controlled by the parent modal. Busy/conflicted rows are disabled
 * with a tooltip explaining why.
 */
export function ExistingWorktreePicker({
  groups,
  selected,
  onSelect,
  searchQuery,
  onSearchQueryChange,
}: ExistingWorktreePickerProps): JSX.Element {
  const getDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  // Subscribe to version so we re-render when mappings change
  // (getDisplayName is a stable function ref on its own)
  const mappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  // Diff stats for candidate worktrees are already computed and cached by the
  // sidebar (these worktrees render there too), keyed by `${projectId}/${id}`.
  // Reuse that cache instead of recomputing per-candidate git stats backend-side.
  const diffStats = useProjectsStore((s) => s.diffStats);
  // Per-workspace expand/collapse state; all groups start expanded.
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleWorkspaceCollapsed = (workspaceId: string): void => {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  const filteredGroups = useMemo((): ExistingWorktreeJoinWorkspaceGroup[] => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return groups;
    const result: ExistingWorktreeJoinWorkspaceGroup[] = [];
    for (const group of groups) {
      // A workspace-name match keeps the whole group.
      if (group.workspaceName.toLowerCase().includes(normalized)) {
        result.push(group);
        continue;
      }
      const candidates = group.candidates.filter(
        (candidate) =>
          candidate.branchName.toLowerCase().includes(normalized) ||
          candidate.worktreeId.toLowerCase().includes(normalized) ||
          getDisplayName(candidate.branchName)
            .toLowerCase()
            .includes(normalized),
      );
      if (candidates.length > 0) {
        result.push({ ...group, candidates });
      }
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mappingsVersion invalidates the display-name cache
  }, [groups, searchQuery, getDisplayName, mappingsVersion]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-md border bg-base px-2 py-1.5">
        <SearchIcon />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search worktrees"
          className="min-w-0 flex-1 bg-transparent text-s fg-primary outline-none placeholder:fg-secondary"
          data-testid="existing-worktree-picker-search"
          aria-label="Search worktrees"
        />
      </div>
      <ul
        className="max-h-[32vh] space-y-1 overflow-y-auto rounded-lg border bg-base p-1"
        data-testid="existing-worktree-picker-list"
      >
        {filteredGroups.length === 0 ? (
          <li
            className="px-3 py-4 text-center text-xs fg-secondary"
            data-testid="existing-worktree-picker-no-matches"
          >
            No matching worktrees
          </li>
        ) : (
          filteredGroups.map((group) => {
            const isCollapsed = collapsedWorkspaceIds.has(group.workspaceId);
            const subtitle = describeWorkspaceSubtitle({
              isMultiRepo: group.isMultiRepo,
              repoCount: group.repoCount,
              temporary: group.temporary,
            });
            return (
              <li key={group.workspaceId}>
                <button
                  type="button"
                  onClick={() => toggleWorkspaceCollapsed(group.workspaceId)}
                  aria-expanded={!isCollapsed}
                  className="focus-ring flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition hover:bg-secondary/30"
                  data-testid={`existing-worktree-picker-group-${group.workspaceId}`}
                >
                  <WorkspaceBadgeIcon
                    isMultiRepo={group.isMultiRepo}
                    temporary={group.temporary}
                    color={group.color}
                    name={group.workspaceName}
                    repoPath={group.repoPath}
                  />
                  <span className="min-w-0 flex-1 truncate text-s font-medium">
                    {group.workspaceName}
                  </span>
                  {subtitle && (
                    <span className="shrink-0 text-xs fg-secondary">
                      {subtitle}
                    </span>
                  )}
                  {isCollapsed ? (
                    <ChevronRightIcon className="shrink-0 fg-secondary" />
                  ) : (
                    <ChevronDownIcon className="shrink-0 fg-secondary" />
                  )}
                </button>
                {!isCollapsed && (
                  <ul className="space-y-0.5 pl-3">
                    {group.candidates.map((candidate) => {
                      const disabledReason =
                        getCandidateDisabledReason(candidate);
                      const candidateStats =
                        diffStats[
                          getWorktreeRecordKey(
                            candidate.workspaceId,
                            candidate.worktreeId,
                          )
                        ];
                      // Match the main worktree list: hide the badge entirely when
                      // there are no line changes instead of showing "+0 -0".
                      const hasLineChanges =
                        candidateStats !== undefined &&
                        candidateStats.insertions + candidateStats.deletions >
                          0;
                      const isSelected =
                        selected !== null &&
                        selected.workspaceId === candidate.workspaceId &&
                        selected.worktreeId === candidate.worktreeId;
                      const rowButton = (
                        <button
                          type="button"
                          onClick={() => onSelect(candidate)}
                          disabled={disabledReason !== null}
                          className={`focus-ring flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition ${
                            disabledReason !== null
                              ? 'cursor-not-allowed fg-secondary/60'
                              : isSelected
                                ? 'bg-accent-subtle fg-primary'
                                : 'fg-primary hover:bg-secondary/40'
                          }`}
                          data-testid={`existing-worktree-picker-option-${candidate.workspaceId}-${candidate.worktreeId}`}
                          aria-pressed={isSelected}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-s font-medium">
                              {getDisplayName(candidate.branchName)}
                            </span>
                            <span className="block truncate text-xs fg-secondary">
                              {candidate.worktreeId}
                            </span>
                          </span>
                          {hasLineChanges && (
                            <DiffBadge stats={candidateStats} compact />
                          )}
                        </button>
                      );
                      return (
                        <li key={candidate.worktreeId}>
                          {disabledReason !== null ? (
                            <Tooltip label={disabledReason} className="w-full">
                              {rowButton}
                            </Tooltip>
                          ) : (
                            rowButton
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
