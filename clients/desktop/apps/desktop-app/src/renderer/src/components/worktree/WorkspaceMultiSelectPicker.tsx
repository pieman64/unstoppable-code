import { useMemo, type JSX } from 'react';
import { SearchIcon } from '../shared/SearchIcon';
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
 * Searchable multi-select list of workspaces. Renders a search box plus a
 * scrollable list of workspace rows with a badge, subtitle, and a checkbox-dot
 * indicator; clicking a row toggles its selection. Presentation only — all
 * selection state and the option list are owned by the caller.
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
  listMaxHeightClassName = 'max-h-[20vh]',
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
      <div className="flex items-center gap-2 rounded-md border bg-base px-2 py-1.5">
        <SearchIcon />
        <input
          type="text"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          placeholder="Search projects"
          className="min-w-0 flex-1 bg-transparent text-s fg-primary outline-none placeholder:fg-secondary"
          data-testid={`${testIdPrefix}-search`}
          aria-label="Search projects"
        />
      </div>
      <ul
        className={`${listMaxHeightClassName} space-y-1 overflow-y-auto rounded-lg border bg-base p-1`}
        data-testid={`${testIdPrefix}-list`}
      >
        {filteredOptions.length === 0 ? (
          <li
            className="px-3 py-4 text-center text-xs fg-secondary"
            data-testid={`${testIdPrefix}-no-matches`}
          >
            {emptyMessage}
          </li>
        ) : (
          filteredOptions.map((option) => {
            const isSelected = selectedWorkspaceIdSet.has(option.id);
            const subtitle = describeWorkspaceSubtitle({
              isMultiRepo: option.isMultiRepo,
              repoCount: option.repoCount,
              temporary: option.temporary,
            });
            const optionName = getWorkspaceOptionDisplayName(option);
            return (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => onToggleWorkspace(option.id)}
                  className={`focus-ring flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-accent-subtle fg-primary'
                      : 'fg-primary hover:bg-secondary/40'
                  }`}
                  data-testid={`${testIdPrefix}-option-${option.id}`}
                  aria-pressed={isSelected}
                >
                  <WorkspaceBadgeIcon
                    isMultiRepo={option.isMultiRepo}
                    temporary={option.temporary === true}
                    color={option.color}
                    name={optionName}
                    repoPath={option.repoPath}
                  />
                  <span className="min-w-0 flex-1 truncate text-s font-medium">
                    {optionName}
                  </span>
                  {subtitle && (
                    <span className="shrink-0 text-xs fg-secondary">
                      {subtitle}
                    </span>
                  )}
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-3xs ${
                      isSelected
                        ? 'border-line-accent bg-accent fg-emphasis'
                        : 'text-transparent'
                    }`}
                    aria-hidden="true"
                  >
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}
