// ---------------------------------------------------------------------------
// GitHub repository URL parsing and identity grammars (REG-3021).
//
// Moved verbatim from `apps/web/src/lib/github/repository-url.ts`, which
// re-exports it.
//
// Browser-safe: no imports. The URL import source accepts exactly one shape,
// an HTTPS github.com (or www.github.com) address naming owner/repo, with an
// optional `.git` suffix and trailing slash. Everything is decided on the raw
// text before any URL normalization could hide it: userinfo, ports, queries,
// fragments, extra or dot segments, percent-encoding, backslashes, controls,
// whitespace and non-ASCII are refused, never repaired.
//
// A parsed URL is request input, not a remote: clone and browse URLs are
// derived only from the identity GitHub resolved (`deriveGitHubRepositoryUrls`),
// so a user-typed string never becomes a remote the server fetches.
// ---------------------------------------------------------------------------

/** Generous for the longest valid address (about 170 characters). */
export const GITHUB_REPOSITORY_URL_MAX_LENGTH = 256;
/** GitHub's username and organization name limit. */
export const GITHUB_OWNER_LOGIN_MAX_LENGTH = 39;
/** GitHub's repository name limit. */
export const GITHUB_REPOSITORY_NAME_MAX_LENGTH = 100;

export type GitHubRepositoryUrlRejection =
  | 'empty'
  | 'too-long'
  | 'invalid-characters'
  | 'encoded-characters'
  | 'not-https'
  | 'userinfo'
  | 'port'
  | 'unsupported-host'
  | 'query'
  | 'fragment'
  | 'invalid-path'
  | 'dot-segment'
  | 'invalid-owner'
  | 'invalid-repository';

export type GitHubRepositoryUrlParseResult =
  | {
      readonly ok: true;
      /** Owner and repository as typed (GitHub resolves them case-insensitively). */
      readonly owner: string;
      readonly repo: string;
      /**
       * `https://github.com/<owner>/<repo>`, case-folded, without `.git` or a
       * trailing slash. Request identity only: never displayed or fetched.
       */
      readonly normalizedUrl: string;
    }
  | { readonly ok: false; readonly reason: GitHubRepositoryUrlRejection };

export interface GitHubRepositoryUrls {
  readonly htmlUrl: string;
  readonly cloneUrl: string;
}

const HTTPS_PREFIX = 'https://';
const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'www.github.com',
]);
const GIT_SUFFIX = '.git';
/** Visible ASCII only: excludes whitespace, controls, DEL and non-ASCII. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
/**
 * Starts alphanumeric; letters, digits and hyphens after it. Underscores are
 * admitted for Enterprise Managed User logins (`name_shortcode`); legacy
 * logins may also hold repeated or trailing hyphens.
 */
const OWNER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const ENDS_WITH_GIT_SUFFIX = /\.git$/i;

export function isGitHubOwnerLogin(value: string): boolean {
  return OWNER_LOGIN.test(value);
}

/**
 * GitHub's repository-name alphabet, without `.` / `..` (path traversal) or
 * a `.git` suffix in any case (ambiguous with the clone URL form).
 */
export function isGitHubRepositoryName(value: string): boolean {
  return (
    REPOSITORY_NAME.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !ENDS_WITH_GIT_SUFFIX.test(value)
  );
}

/** Exactly `owner/repo`, each part valid in its own grammar. */
export function isGitHubRepositoryFullName(value: string): boolean {
  const parts = value.split('/');
  return (
    parts.length === 2 &&
    isGitHubOwnerLogin(parts[0]) &&
    isGitHubRepositoryName(parts[1])
  );
}

/**
 * Browse and clone URLs derived from a GitHub-resolved identity, keeping its
 * case. Null when the identity does not satisfy the grammars, so a malformed
 * value can never be assembled into a remote.
 */
export function deriveGitHubRepositoryUrls(
  ownerLogin: string,
  repoName: string,
): GitHubRepositoryUrls | null {
  if (!isGitHubOwnerLogin(ownerLogin) || !isGitHubRepositoryName(repoName)) {
    return null;
  }
  const htmlUrl = `https://github.com/${ownerLogin}/${repoName}`;
  return { htmlUrl, cloneUrl: `${htmlUrl}${GIT_SUFFIX}` };
}

function rejectRawText(value: string): GitHubRepositoryUrlRejection | null {
  if (value.length === 0) return 'empty';
  if (value.length > GITHUB_REPOSITORY_URL_MAX_LENGTH) return 'too-long';
  if (!VISIBLE_ASCII.test(value) || value.includes('\\')) {
    return 'invalid-characters';
  }
  if (value.includes('%')) return 'encoded-characters';
  if (!value.toLowerCase().startsWith(HTTPS_PREFIX)) return 'not-https';
  return null;
}

function rejectAuthority(
  authority: string,
): GitHubRepositoryUrlRejection | null {
  if (authority.includes('@')) return 'userinfo';
  if (authority.includes(':')) return 'port';
  return GITHUB_HOSTS.has(authority.toLowerCase()) ? null : 'unsupported-host';
}

type PathSegments =
  | { readonly ok: true; readonly owner: string; readonly repo: string }
  | { readonly ok: false; readonly reason: GitHubRepositoryUrlRejection };

function splitPath(remainder: string): PathSegments {
  if (remainder.includes('?')) return { ok: false, reason: 'query' };
  if (remainder.includes('#')) return { ok: false, reason: 'fragment' };
  if (!remainder.startsWith('/')) return { ok: false, reason: 'invalid-path' };
  const path = remainder.endsWith('/') ? remainder.slice(0, -1) : remainder;
  const segments = path.slice(1).split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, reason: 'dot-segment' };
  }
  if (segments.length !== 2 || segments.some((segment) => segment === '')) {
    return { ok: false, reason: 'invalid-path' };
  }
  const [owner, repo] = segments;
  return { ok: true, owner, repo };
}

function stripGitSuffix(segment: string): string {
  return segment.endsWith(GIT_SUFFIX)
    ? segment.slice(0, -GIT_SUFFIX.length)
    : segment;
}

/**
 * Parses a user-typed GitHub repository URL. Surrounding whitespace is
 * trimmed; everything else must already be in the one accepted shape.
 */
export function parseGitHubRepositoryUrl(
  input: string,
): GitHubRepositoryUrlParseResult {
  const value = input.trim();
  const rawRejection = rejectRawText(value);
  if (rawRejection !== null) return { ok: false, reason: rawRejection };

  const rest = value.slice(HTTPS_PREFIX.length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const authorityRejection = rejectAuthority(authority);
  if (authorityRejection !== null) {
    return { ok: false, reason: authorityRejection };
  }

  const path = splitPath(authorityEnd === -1 ? '' : rest.slice(authorityEnd));
  if (!path.ok) return path;
  const repo = stripGitSuffix(path.repo);
  if (!isGitHubOwnerLogin(path.owner)) {
    return { ok: false, reason: 'invalid-owner' };
  }
  if (!isGitHubRepositoryName(repo)) {
    return { ok: false, reason: 'invalid-repository' };
  }
  return {
    ok: true,
    owner: path.owner,
    repo,
    normalizedUrl: `https://github.com/${path.owner.toLowerCase()}/${repo.toLowerCase()}`,
  };
}
