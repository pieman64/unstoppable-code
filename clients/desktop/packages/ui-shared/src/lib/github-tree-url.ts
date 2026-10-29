/**
 * The one shape a marketplace plugin's provenance link may take: the server
 * builds `sourceUrl` from a validated GitHub owner, repository, commit and
 * root, so anything else (another host, plain http, a non-string relayed by a
 * desktop catalog) renders as text, never as a link. Shared by the cloud
 * plugins picker and the Add marketplace preview so the rule cannot drift
 * between them.
 */
export function isGitHubTreeUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://github.com/');
}
