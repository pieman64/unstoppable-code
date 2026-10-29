/**
 * Copy for a member's multi-repo organization project (CAN-3546). Pure and
 * browser-safe, so the Add project dialog and the main-process settings
 * check that refuse a repository share their wording.
 *
 * `organizationName` is a display name; callers fall back to
 * `your organization` when it is unknown.
 */

/**
 * Names the repositories an organization does not hold and what to do: for
 * example `web3swift doesn't belong to Acme. Choose repositories that belong
 * to Acme.`
 */
export function orgOutsideRepositoriesText(
  repositories: readonly string[],
  organizationName: string,
): string {
  return `${outsideRepositories(repositories, organizationName)} Choose repositories that belong to ${organizationName}.`;
}

function outsideRepositories(
  repositories: readonly string[],
  organizationName: string,
): string {
  const [first, second] = repositories;
  if (first === undefined)
    return `Some repositories don't belong to ${organizationName}.`;
  if (repositories.length === 1)
    return `${first} doesn't belong to ${organizationName}.`;
  const listed =
    repositories.length === 2 && second !== undefined
      ? `${first} and ${second}`
      : `${repositories.slice(0, -1).join(', ')}, and ${repositories[repositories.length - 1] ?? ''}`;
  return `${listed} don't belong to ${organizationName}.`;
}

/**
 * Tooltip on a repository settings cannot add to an organization's
 * multi-repo project, before it is chosen.
 */
export function orgOutsideRepositoryTooltipText(
  repository: string,
  organizationName: string,
): string {
  return `${repository} doesn't belong to ${organizationName}.`;
}

/** The organization's projects could not be read to check a repository. */
export function orgRepositoryCheckFailedText(organizationName: string): string {
  return `Couldn't check this repository with ${organizationName}. Try again.`;
}

/** A repository's git remote could not be read to check it. */
export function orgRepositoryRemoteUnreadableText(repository: string): string {
  return `Couldn't read the git remote of ${repository}. Try again.`;
}

/** The organization did not take the project's new repositories; nothing changed. */
export function orgRepositoriesSyncFailedText(
  organizationName: string,
): string {
  return `Couldn't update this project in ${organizationName}. Try again.`;
}
