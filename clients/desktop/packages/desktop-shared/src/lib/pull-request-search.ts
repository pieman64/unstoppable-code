/** Shared by the host and picker so title-query eligibility uses one policy. */
export const PR_TITLE_SEARCH_MAX_INPUT_LENGTH = 100;
export const PR_TITLE_SEARCH_MAX_QUERY_LENGTH = 256;

/** Return individually quoted title tokens; never interpret user qualifiers. */
export function normalizePullRequestTitleQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter a pull request title to search.');
  }
  const trimmed = value.trim();
  if (trimmed.length > PR_TITLE_SEARCH_MAX_INPUT_LENGTH) {
    throw new Error(
      'Shorten the pull request search to 100 characters or fewer.',
    );
  }
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/["\\]/g, ''))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error('Enter a pull request title to search.');
  }
  return tokens.map((token) => `"${token}"`).join(' ');
}
