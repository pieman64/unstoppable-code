/** One github.com account `gh auth status --json hosts` reported. */
export interface GitHubCliHostEntry {
  readonly active: boolean;
  readonly login: string;
  /** The CLI's raw token source; it can name a host path, so it stays host-side. */
  readonly tokenSource: string;
}

/**
 * What one run of the GitHub CLI's status command observed. `hosts` lists the
 * well-formed github.com entries, possibly none; it never carries a token.
 */
export type GitHubCliObservation =
  | { readonly kind: 'not-installed' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'unparseable-output' }
  | { readonly kind: 'hosts'; readonly entries: readonly GitHubCliHostEntry[] };

const GITHUB_HOST = 'github.com';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHostEntry(
  value: unknown,
): value is GitHubCliHostEntry & { host: string } {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.host === 'string' &&
    typeof value.login === 'string' &&
    typeof value.tokenSource === 'string'
  );
}

/**
 * Parses `gh auth status --json hosts` output. Entries lacking a field are
 * dropped; each entry's own `state` (the CLI's validation) is ignored.
 */
export function parseGitHubCliStatusOutput(
  stdout: string,
): GitHubCliObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: 'unparseable-output' };
  }
  if (!isRecord(parsed) || !isRecord(parsed.hosts))
    return { kind: 'hosts', entries: [] };
  const rawEntries = parsed.hosts[GITHUB_HOST];
  if (!Array.isArray(rawEntries)) return { kind: 'hosts', entries: [] };
  return {
    kind: 'hosts',
    entries: rawEntries
      .filter(isHostEntry)
      .map(({ active, login, tokenSource }) => ({
        active,
        login,
        tokenSource,
      })),
  };
}
