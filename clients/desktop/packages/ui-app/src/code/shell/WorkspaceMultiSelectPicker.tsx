'use client';

import { useMemo, type JSX, type ReactNode } from 'react';
import {
  ChoiceList,
  ChoiceListRow,
  ProjectAvatarBadge,
  SearchEmptyState,
  SearchField,
} from '@canopy/ui-shared/components';

/**
 * Neutral, display-only project option for {@link WorkspaceMultiSelectPicker}.
 * Every caller maps its own data into this shape.
 */
export interface WorkspacePickerOption {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly isMultiRepo: boolean;
  readonly repoCount: number;
  readonly temporary: boolean;
  /** GitHub owner avatar for a single-repo project, when the host has it. */
  readonly avatarUrl?: string;
}

/**
 * Subtitle for a project entry in the worktree-join pickers. Multi-repo
 * projects show "N repos" (with "• Temporary" appended for temporary ones);
 * single-repo projects have no subtitle.
 */
export function describeWorkspaceSubtitle({
  isMultiRepo,
  repoCount,
  temporary,
}: {
  readonly isMultiRepo: boolean;
  readonly repoCount: number;
  readonly temporary: boolean;
}): string | null {
  if (!isMultiRepo) {
    return null;
  }
  const baseLabel = `${repoCount} ${repoCount === 1 ? 'repo' : 'repos'}`;
  return temporary ? `${baseLabel} • Temporary` : baseLabel;
}

export interface WorkspaceMultiSelectPickerProps<
  TOption extends WorkspacePickerOption,
> {
  readonly options: readonly TOption[];
  readonly selectedWorkspaceIds: readonly string[];
  readonly onToggleWorkspace: (workspaceId: string) => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (value: string) => void;
  readonly label?: string;
  readonly emptyMessage?: string;
  readonly testIdPrefix?: string;
  /** The list's height cap; the list scrolls inside it. */
  readonly listHeight?: WorkspacePickerListHeight;
  /** The row's project icon; defaults to the shared project avatar badge. */
  readonly renderOptionIcon?: (option: TOption) => ReactNode;
}

export type WorkspacePickerListHeight = 'compact' | 'medium' | 'viewport';

const LIST_HEIGHT_CLASS: Readonly<Record<WorkspacePickerListHeight, string>> = {
  compact: 'max-h-48',
  medium: 'max-h-72',
  viewport: 'max-h-[40vh]',
};

function getWorkspaceOptionDisplayName(option: WorkspacePickerOption): string {
  return typeof option.name === 'string' && option.name.trim().length > 0
    ? option.name
    : 'Repository';
}

/**
 * Searchable multi-select list of projects: the shared search field over the
 * shared choice list, one row per project with its checkbox mark, icon and
 * subtitle; clicking a row toggles its selection. Presentation only: the
 * caller owns the selection and the options.
 */
export function WorkspaceMultiSelectPicker<
  TOption extends WorkspacePickerOption,
>({
  options,
  selectedWorkspaceIds,
  onToggleWorkspace,
  searchQuery,
  onSearchQueryChange,
  label = 'Project',
  emptyMessage = 'No projects match your search.',
  testIdPrefix = 'workspace-picker',
  listHeight = 'compact',
  renderOptionIcon,
}: WorkspaceMultiSelectPickerProps<TOption>): JSX.Element {
  const selectedWorkspaceIdSet = useMemo(
    () => new Set(selectedWorkspaceIds),
    [selectedWorkspaceIds],
  );
  const filteredOptions = useMemo<readonly TOption[]>(() => {
    const normalized = searchQuery.trim().toLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      getWorkspaceOptionDisplayName(option).toLowerCase().includes(normalized),
    );
  }, [options, searchQuery]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="block text-xs fg-secondary">{label}</span>
      <SearchField
        size="sm"
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder="Search projects"
        aria-label="Search projects"
        data-testid={`${testIdPrefix}-search`}
      />
      {filteredOptions.length === 0 ? (
        <SearchEmptyState
          testId={`${testIdPrefix}-no-matches`}
          title={emptyMessage}
          {...(searchQuery.trim() === ''
            ? {}
            : {
                actionLabel: 'Clear search',
                onAction: () => onSearchQueryChange(''),
                actionTestId: `${testIdPrefix}-clear-search`,
              })}
        />
      ) : (
        <div className={`flex flex-col ${LIST_HEIGHT_CLASS[listHeight]}`}>
          <ChoiceList
            aria-label={label}
            className="min-h-0"
            data-testid={`${testIdPrefix}-list`}
          >
            {filteredOptions.map((option) => {
              const subtitle = describeWorkspaceSubtitle(option);
              const optionName = getWorkspaceOptionDisplayName(option);
              return (
                <ChoiceListRow
                  key={option.id}
                  selected={selectedWorkspaceIdSet.has(option.id)}
                  onClick={() => onToggleWorkspace(option.id)}
                  data-testid={`${testIdPrefix}-option-${option.id}`}
                  leading={
                    renderOptionIcon ? (
                      renderOptionIcon(option)
                    ) : (
                      <ProjectAvatarBadge
                        kind={option.isMultiRepo ? 'multi-repo' : 'single-repo'}
                        temporary={option.temporary}
                        color={option.color}
                        avatarUrl={option.avatarUrl}
                      />
                    )
                  }
                  trailing={subtitle || undefined}
                >
                  <span className="block truncate font-medium">
                    {optionName}
                  </span>
                </ChoiceListRow>
              );
            })}
          </ChoiceList>
        </div>
      )}
    </div>
  );
}
