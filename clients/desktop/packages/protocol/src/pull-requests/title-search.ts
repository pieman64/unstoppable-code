/** Title-query eligibility shared by the picker and core hosts. */
export const PR_TITLE_SEARCH_MAX_INPUT_LENGTH = 100;
export const PR_TITLE_SEARCH_MAX_QUERY_LENGTH = 256;

/** Return individually quoted title tokens; never interpret user qualifiers. */
export function normalizePullRequestTitleQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PullRequestTitleQueryError(
      'Enter a pull request title to search.',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > PR_TITLE_SEARCH_MAX_INPUT_LENGTH) {
    throw new PullRequestTitleQueryError(
      'Shorten the pull request search to 100 characters or fewer.',
    );
  }
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/["\\]/g, ''))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new PullRequestTitleQueryError(
      'Enter a pull request title to search.',
    );
  }
  return tokens.map((token) => `"${token}"`).join(' ');
}

/** Validation errors keep Error's legacy name and message across IPC. */
export class PullRequestTitleQueryError extends Error {}

/** Apply GitHub's limit after quoting and repository scoping, before I/O. */
export function scopePullRequestTitleQuery(
  repository: { owner: string; repo: string },
  normalizedQuery: string,
): string {
  const query = `repo:${repository.owner}/${repository.repo} is:pr is:open in:title ${normalizedQuery}`;
  if (query.length > PR_TITLE_SEARCH_MAX_QUERY_LENGTH) {
    throw new PullRequestTitleQueryError(
      'Shorten the pull request search to fit the GitHub query limit.',
    );
  }
  return query;
}
