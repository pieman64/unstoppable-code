import { useMemo, useState, type JSX } from 'react';
import type {
  ExistingWorktreeJoinCandidate,
  ExistingWorktreeJoinWorkspaceGroup,
} from '@canopy/desktop-shared/types';
import {
  ListRow,
  SearchEmptyState,
  SearchField,
  Surface,
  Tooltip,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon, ChevronRightIcon } from '@canopy/ui-shared/icons';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { WorkspaceBadgeIcon } from '../shared/WorkspaceBadgeIcon';
import { describeWorkspaceSubtitle } from '@canopy/ui-app/code/shell/WorkspaceMultiSelectPicker';
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
      return 'This worktree has a running workflow execution.';
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
    <div className="flex flex-col gap-1.5">
      <SearchField
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search worktrees"
        data-testid="existing-worktree-picker-search"
        aria-label="Search worktrees"
      />
      {filteredGroups.length === 0 ? (
        <SearchEmptyState
          testId="existing-worktree-picker-no-matches"
          title="No worktrees match your search."
          {...(searchQuery.trim() === ''
            ? {}
            : {
                actionLabel: 'Clear search',
                onAction: () => onSearchQueryChange(''),
                actionTestId: 'existing-worktree-picker-clear-search',
              })}
        />
      ) : (
        <Surface variant="inset" className="overflow-hidden">
          <ul
            className="flex flex-col max-h-[32vh] overflow-y-auto p-1 gap-1 [&>*]:shrink-0"
            data-testid="existing-worktree-picker-list"
          >
            {filteredGroups.map((group) => {
              const isCollapsed = collapsedWorkspaceIds.has(group.workspaceId);
              const subtitle = describeWorkspaceSubtitle({
                isMultiRepo: group.isMultiRepo,
                repoCount: group.repoCount,
                temporary: group.temporary,
              });
              return (
                <li key={group.workspaceId}>
                  <ListRow
                    onClick={() => toggleWorkspaceCollapsed(group.workspaceId)}
                    aria-expanded={!isCollapsed}
                    data-testid={`existing-worktree-picker-group-${group.workspaceId}`}
                    icon={
                      <WorkspaceBadgeIcon
                        isMultiRepo={group.isMultiRepo}
                        temporary={group.temporary}
                        color={group.color}
                        name={group.workspaceName}
                        repoPath={group.repoPath}
                      />
                    }
                    trailing={
                      <span className="flex items-center gap-2">
                        {subtitle && <span>{subtitle}</span>}
                        {isCollapsed ? (
                          <ChevronRightIcon className="shrink-0 fg-secondary" />
                        ) : (
                          <ChevronDownIcon className="shrink-0 fg-secondary" />
                        )}
                      </span>
                    }
                  >
                    {group.workspaceName}
                  </ListRow>
                  {!isCollapsed && (
                    <ul className="flex flex-col pl-3 gap-0.5">
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
                          <ListRow
                            onClick={() => onSelect(candidate)}
                            disabled={disabledReason !== null}
                            selected={isSelected}
                            data-testid={`existing-worktree-picker-option-${candidate.workspaceId}-${candidate.worktreeId}`}
                            aria-pressed={isSelected}
                            description={candidate.worktreeId}
                            trailing={
                              hasLineChanges ? (
                                <DiffBadge stats={candidateStats} compact />
                              ) : undefined
                            }
                          >
                            {getDisplayName(candidate.branchName)}
                          </ListRow>
                        );
                        return (
                          <li key={candidate.worktreeId}>
                            {disabledReason !== null ? (
                              <Tooltip
                                label={disabledReason}
                                className="w-full"
                              >
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
            })}
          </ul>
        </Surface>
      )}
    </div>
  );
}
