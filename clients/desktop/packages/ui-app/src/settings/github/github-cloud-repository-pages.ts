// ---------------------------------------------------------------------------
// Reading pages of the repository listing in the browser (REG-3021).
//
// Browser-safe and pure. The listing route searches GitHub's own pages of one
// installation a few at a time (see `cloud-repository-listing-contracts.ts`),
// so the client must be honest about what it has seen:
//
// - offset paging can repeat a row on the next page (or skip one when the
//   installation changes underneath), so pages merge by the immutable
//   `providerRepoId`, first copy kept;
// - an empty answer that still has a cursor is NOT "no matches": only the
//   loaded pages were searched, and Load more stays;
// - a null cursor with pages left means the scan limit was reached, so the
//   way on is the URL source, not another page;
// - only an exhausted listing may say there is no match.
//
// The copy is fixed and carries no product name.
// ---------------------------------------------------------------------------

import {
  GITHUB_CLOUD_REPOSITORY_MAX_CURSOR,
  GITHUB_CLOUD_REPOSITORY_PAGE_SIZE,
  type GitHubCloudRepositoryDto,
  type GitHubCloudRepositoryPageDto,
} from '@canopy/protocol/settings/github-cloud-repository-listing';

/** How long the search waits after the last keystroke before it asks. */
export const GITHUB_CLOUD_REPOSITORY_SEARCH_DEBOUNCE_MS = 300;

export const GITHUB_CLOUD_SELECTED_INSTALL_NOTICE =
  'Only repositories the app was granted show here. Manage access on GitHub to add more.';

export const GITHUB_CLOUD_PARTIAL_NO_MATCH_MESSAGE =
  'No matches in the repositories loaded so far.';

const SEARCH_LIMIT = (
  GITHUB_CLOUD_REPOSITORY_MAX_CURSOR * GITHUB_CLOUD_REPOSITORY_PAGE_SIZE
).toLocaleString('en-US');

export const GITHUB_CLOUD_SEARCH_LIMIT_NOTICE = `Search reached its limit of ${SEARCH_LIMIT} repositories. Use URL to add one it didn't reach.`;

const EXHAUSTED_EMPTY_MESSAGE = 'No repositories returned from GitHub.';

/** Why a listed repository cannot back a cloud project; fixed copy. */
export const GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY = {
  archived: 'Archived on GitHub. Unarchive it to add it.',
  readOnly: 'You can only read this repository. Adding it needs write access.',
} as const;

/**
 * Appends `incoming` to `existing`, dropping every row whose
 * `providerRepoId` is already listed (offset paging may repeat one). The
 * first copy stays, so a row never moves or changes under the pointer.
 */
export function mergeRepositoryPage(
  existing: readonly GitHubCloudRepositoryDto[],
  incoming: readonly GitHubCloudRepositoryDto[],
): readonly GitHubCloudRepositoryDto[] {
  const seen = new Set(existing.map((row) => row.providerRepoId));
  const merged = [...existing];
  for (const row of incoming) {
    if (seen.has(row.providerRepoId)) continue;
    seen.add(row.providerRepoId);
    merged.push(row);
  }
  return merged;
}

/**
 * Why the repository cannot be chosen, or null. The server refuses an
 * archived repository and one the user can only read; `none` may mean GitHub
 * omitted the permission, so it stays available and the server decides.
 */
export function repositoryUnavailableReason(
  repository: GitHubCloudRepositoryDto,
): string | null {
  if (repository.archived) {
    return GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.archived;
  }
  if (repository.permission === 'read') {
    return GITHUB_CLOUD_REPOSITORY_UNAVAILABLE_COPY.readOnly;
  }
  return null;
}

/** The shared picker's row (structurally `GitHubRepositoryPickerRow`). */
export interface RepositoryPickerRowView {
  readonly id: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly private: boolean;
  readonly archived: boolean;
  readonly unavailableReason?: string;
}

export function repositoryPickerRow(
  repository: GitHubCloudRepositoryDto,
): RepositoryPickerRowView {
  const reason = repositoryUnavailableReason(repository);
  return {
    id: repository.providerRepoId,
    fullName: repository.fullName,
    description: repository.description,
    private: repository.private,
    archived: repository.archived,
    ...(reason === null ? {} : { unavailableReason: reason }),
  };
}

export interface RepositoryListingFacts {
  readonly nextCursor: GitHubCloudRepositoryPageDto['nextCursor'];
  readonly searchIncomplete: boolean;
  readonly repositorySelection: GitHubCloudRepositoryPageDto['repositorySelection'];
  /** The query the loaded rows answer (not the text still being typed). */
  readonly query: string;
}

export interface RepositoryListingView {
  /** Another page can be asked for. */
  readonly hasMore: boolean;
  /** What to say when the loaded rows hold no match. */
  readonly noMatchMessage: string;
  /** A state worth knowing while choosing, or undefined. */
  readonly notice: string | undefined;
}

export function describeRepositoryListing({
  nextCursor,
  searchIncomplete,
  repositorySelection,
  query,
}: RepositoryListingFacts): RepositoryListingView {
  const unscanned = nextCursor !== null || searchIncomplete;
  const trimmed = query.trim();
  let noMatchMessage = EXHAUSTED_EMPTY_MESSAGE;
  if (unscanned) noMatchMessage = GITHUB_CLOUD_PARTIAL_NO_MATCH_MESSAGE;
  else if (trimmed !== '') {
    noMatchMessage = `No repositories match “${trimmed}”.`;
  }
  const notices = [
    nextCursor === null && searchIncomplete
      ? GITHUB_CLOUD_SEARCH_LIMIT_NOTICE
      : null,
    repositorySelection === 'selected'
      ? GITHUB_CLOUD_SELECTED_INSTALL_NOTICE
      : null,
  ].filter((entry): entry is string => entry !== null);
  return {
    hasMore: nextCursor !== null,
    noMatchMessage,
    notice: notices.length === 0 ? undefined : notices.join(' '),
  };
}
