import { useMemo, type JSX } from 'react';
import type { GitHubRepoSummary } from '@canopy/desktop-shared/types';
import {
  GitHubRepositoryPicker,
  type GitHubRepositoryPickerRow,
} from '@canopy/ui-shared/components';

interface GitHubRepoPickerProps {
  repos: GitHubRepoSummary[];
  totalCount: number;
  loading: boolean;
  error: string;
  search: string;
  onSearchChange: (value: string) => void;
  selectedFullName: string | null;
  onSelect: (fullName: string) => void;
  onRetry: () => void;
  testId?: string;
}

/**
 * Desktop mount of the shared repository picker. The desktop listing has no
 * stable repository id, so a row's identity is its full name, and the picker
 * reports a selection as that name.
 */
export function GitHubRepoPicker({
  repos,
  totalCount,
  loading,
  error,
  search,
  onSearchChange,
  selectedFullName,
  onSelect,
  onRetry,
  testId,
}: GitHubRepoPickerProps): JSX.Element {
  const repositories = useMemo(
    (): GitHubRepositoryPickerRow[] =>
      repos.map(
        (repo): GitHubRepositoryPickerRow => ({
          id: repo.fullName,
          fullName: repo.fullName,
          description: repo.description,
          private: repo.isPrivate,
          archived: repo.isArchived,
        }),
      ),
    [repos],
  );

  return (
    <GitHubRepositoryPicker
      repositories={repositories}
      totalCount={totalCount}
      loading={loading}
      error={error}
      search={search}
      onSearchChange={onSearchChange}
      selectedId={selectedFullName}
      onSelect={onSelect}
      onRetry={onRetry}
      testId={testId}
    />
  );
}
