import { useMemo, type JSX } from 'react';
import {
  ChoiceList,
  ChoiceListRow,
  SearchField,
} from '@canopy/ui-shared/components';
import { WorkspaceBadgeIcon } from '../shared/WorkspaceBadgeIcon';
import { describeWorkspaceSubtitle } from '../shared/workspaceEntry';

/**
 * Neutral, display-only workspace option consumed by
 * {@link WorkspaceMultiSelectPicker}. Deliberately not tied to any one feature
 * (adhoc join, Experiments code-graph selection, …) — every caller maps its own
 * data into this shape. `AdhocMultiRepoJoinOption` is structurally compatible,
 * so the temporary-workspace join modal keeps passing its options unchanged.
 */
export interface WorkspacePickerOption {
  id: string;
  name: string;
  color: string;
  isMultiRepo: boolean;
  repoCount: number;
  temporary: boolean;
  /** Single-repo path used by the canonical project icon. */
  repoPath?: string;
}

interface WorkspaceMultiSelectPickerProps {
  options: WorkspacePickerOption[];
  selectedWorkspaceIds: string[];
  onToggleWorkspace: (workspaceId: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  label?: string;
  emptyMessage?: string;
  testIdPrefix?: string;
  listMaxHeightClassName?: string;
}

function getWorkspaceOptionDisplayName(option: WorkspacePickerOption): string {
  return typeof option.name === 'string' && option.name.trim().length > 0
    ? option.name
    : 'Repository';
}

/**
 * Searchable multi-select list of workspaces: the shared search field over
 * the shared choice list, one row per workspace with its checkbox mark,
 * badge and subtitle; clicking a row toggles its selection. Presentation
 * only — all selection state and the option list are owned by the caller.
 */
export function WorkspaceMultiSelectPicker({
  options,
  selectedWorkspaceIds,
  onToggleWorkspace,
  searchQuery,
  onSearchQueryChange,
  label = 'Project',
  emptyMessage = 'No matching projects',
  testIdPrefix = 'workspace-picker',
  listMaxHeightClassName = 'max-h-48',
}: WorkspaceMultiSelectPickerProps): JSX.Element {
  const selectedWorkspaceIdSet = useMemo(
    () => new Set(selectedWorkspaceIds),
    [selectedWorkspaceIds],
  );
  const filteredOptions = useMemo<WorkspacePickerOption[]>(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      getWorkspaceOptionDisplayName(option).toLowerCase().includes(normalized),
    );
  }, [options, searchQuery]);

  return (
    <div className="space-y-1.5">
      <span className="block text-xs fg-secondary">{label}</span>
      <SearchField
        size="sm"
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search projects"
        aria-label="Search projects"
        data-testid={`${testIdPrefix}-search`}
      />
      {/* The caller caps the list's height; the list scrolls inside it. */}
      <div className={`flex flex-col ${listMaxHeightClassName}`}>
        <ChoiceList
          aria-label={label}
          className="min-h-0"
          data-testid={`${testIdPrefix}-list`}
        >
          {filteredOptions.length === 0 ? (
            <p
              className="px-3 py-4 text-center text-xs fg-secondary"
              data-testid={`${testIdPrefix}-no-matches`}
            >
              {emptyMessage}
            </p>
          ) : (
            filteredOptions.map((option) => {
              const subtitle = describeWorkspaceSubtitle({
                isMultiRepo: option.isMultiRepo,
                repoCount: option.repoCount,
                temporary: option.temporary,
              });
              const optionName = getWorkspaceOptionDisplayName(option);
              return (
                <ChoiceListRow
                  key={option.id}
                  selected={selectedWorkspaceIdSet.has(option.id)}
                  onClick={() => onToggleWorkspace(option.id)}
                  data-testid={`${testIdPrefix}-option-${option.id}`}
                  leading={
                    <WorkspaceBadgeIcon
                      isMultiRepo={option.isMultiRepo}
                      temporary={option.temporary === true}
                      color={option.color}
                      name={optionName}
                      repoPath={option.repoPath}
                    />
                  }
                  trailing={subtitle || undefined}
                >
                  <span className="block truncate font-medium">
                    {optionName}
                  </span>
                </ChoiceListRow>
              );
            })
          )}
        </ChoiceList>
      </div>
    </div>
  );
}
