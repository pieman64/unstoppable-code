/**
 * Transcript reference previews: bounded, display-only provider facts read
 * through a host's existing provider connection. Credentials never cross this
 * contract; `scope` is an opaque identity for cache partitioning.
 */

export type ReferenceEnrichmentMode = 'replace' | 'hover' | 'off';

export interface LinearIssuePreviewRequest {
  /** Uppercase issue identifier, for example `CAN-123`. */
  readonly identifier: string;
  /** Lowercase workspace from a Linear URL; absent for a bare identifier. */
  readonly workspaceSlug?: string;
}

export interface LinearIssuePreview {
  readonly identifier: string;
  readonly title: string;
  /** Canonical issue URL returned by Linear. */
  readonly url: string;
  /** Bounded plain-text excerpt of the description. */
  readonly description: string | null;
  readonly status: string | null;
  readonly assignee: string | null;
  readonly project: string | null;
  /** ISO timestamp of the provider's last update. */
  readonly updatedAt: string;
}

export type LinearIssuePreviewResult =
  | {
      readonly status: 'ok';
      readonly scope: string;
      readonly preview: LinearIssuePreview;
    }
  | { readonly status: 'disconnected' }
  /** Not found, not permitted, or outside the requested workspace. */
  | { readonly status: 'unavailable'; readonly scope: string }
  | { readonly status: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly status: 'failed' };

/**
 * The connection's complete accessible team-key catalog. Bare identifiers are
 * decorated only when their prefix is one of these keys; a failed or partial
 * read publishes no keys.
 */
export type LinearTeamKeysResult =
  | {
      readonly status: 'ok';
      readonly scope: string;
      /** Deduplicated, validated uppercase team keys, for example `CAN`. */
      readonly keys: readonly string[];
      /** Epoch ms the host read the catalog; freshness runs from here. */
      readonly fetchedAt: number;
    }
  | { readonly status: 'disconnected' }
  | {
      readonly status: 'rate-limited';
      readonly scope: string;
      readonly retryAfterMs: number | null;
    }
  | { readonly status: 'failed'; readonly scope: string };

export interface LinearPreviewScope {
  /** Opaque Canopy account and Linear credential identity; `null` when disconnected. */
  readonly scope: string | null;
}

export const LINEAR_TEAM_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,15}$/;
export const LINEAR_ISSUE_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]{0,15}-\d{1,9}$/;
export const LINEAR_WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isLinearIssuePreviewRequest(
  value: unknown,
): value is LinearIssuePreviewRequest {
  if (typeof value !== 'object' || value === null) return false;
  const identifier: unknown = Reflect.get(value, 'identifier');
  const workspaceSlug: unknown = Reflect.get(value, 'workspaceSlug');
  return (
    typeof identifier === 'string' &&
    LINEAR_ISSUE_IDENTIFIER_PATTERN.test(identifier) &&
    (workspaceSlug === undefined ||
      (typeof workspaceSlug === 'string' &&
        LINEAR_WORKSPACE_SLUG_PATTERN.test(workspaceSlug)))
  );
}

/** Bounds a ticket-search query from the renderer, in UTF-16 code units after trimming. */
export const LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH = 256;

/**
 * The trimmed ticket-search query, or `null` when the value is not a string,
 * is empty, contains control characters, or exceeds the length bound.
 */
export function parseLinearIssueSearchQuery(value: unknown): string | null {
  // Bound the raw value too, so padding cannot make trimming the expensive part.
  if (
    typeof value !== 'string' ||
    value.length > LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH * 4
  ) {
    return null;
  }
  const query = value.trim();
  if (
    query.length === 0 ||
    query.length > LINEAR_ISSUE_SEARCH_QUERY_MAX_LENGTH ||
    // eslint-disable-next-line no-control-regex -- matching these is the point
    /[\u0000-\u001F\u007F-\u009F]/.test(query)
  ) {
    return null;
  }
  return query;
}

/** Bounds a provider issue title for display and transport, in code points. */
export const LINEAR_ISSUE_TITLE_MAX_CODE_POINTS = 512;

/** The team key a bare identifier such as `CAN-123` belongs to. */
export function linearTeamKeyOf(identifier: string): string {
  return identifier.slice(0, identifier.lastIndexOf('-'));
}

/**
 * One exact GitHub.com repository or numbered item. `owner` and `repository`
 * are lowercase; GitHub numbers issues and pull requests in one sequence, so
 * an item's kind is metadata returned by the host, never part of its identity.
 */
export type GitHubPreviewTarget =
  | {
      readonly kind: 'repository';
      readonly owner: string;
      readonly repository: string;
    }
  | {
      readonly kind: 'item';
      readonly owner: string;
      readonly repository: string;
      readonly number: number;
    };

/**
 * The transcript's originating context, used only to resolve a bare `#1234`.
 * A cowork chat never resolves one.
 */
export type GitHubReferenceOrigin =
  | {
      readonly kind: 'worktree';
      readonly projectId: string;
      readonly worktreeId: string;
    }
  | { readonly kind: 'cowork' };

export interface GitHubOriginRepository {
  /** The origin's single GitHub.com repository; `null` when none or ambiguous. */
  readonly repository: {
    readonly owner: string;
    readonly repository: string;
  } | null;
}

export type GitHubItemState = 'open' | 'closed' | 'merged';

export interface GitHubItemPreview {
  readonly kind: 'item';
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly itemType: 'pull' | 'issue';
  readonly title: string;
  /** Canonical item URL returned by GitHub. */
  readonly url: string;
  /** Bounded plain-text excerpt of the body. */
  readonly description: string | null;
  readonly state: GitHubItemState;
  /** Pull requests only; issues are never drafts. */
  readonly draft: boolean;
  readonly author: string | null;
  /**
   * The author's GitHub avatar: an https `avatars.githubusercontent.com` URL.
   * Absent from reads made before it was added.
   */
  readonly authorAvatarUrl?: string | null;
  /** ISO timestamp of the provider's last update. */
  readonly updatedAt: string;
  /** Pull requests only: size and readiness, when the host could read them. */
  readonly pull?: GitHubPullPreviewFacts;
}

/** A pull request's size and readiness, from GitHub's pull request read. */
export interface GitHubPullPreviewFacts {
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /** `unknown` while GitHub is still computing mergeability. */
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown';
  /** Aggregated check runs and statuses on the head commit. */
  readonly checks: 'passing' | 'failing' | 'pending' | 'none';
  readonly reviewDecision: 'approved' | 'changes_requested' | null;
  readonly inMergeQueue: boolean;
}

const GITHUB_AVATAR_HOST = 'avatars.githubusercontent.com';
const GITHUB_AVATAR_URL_MAX_LENGTH = 512;

/** An https GitHub avatar URL: the only picture a preview may load. */
export function isGitHubAvatarUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > GITHUB_AVATAR_URL_MAX_LENGTH
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === GITHUB_AVATAR_HOST &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Well-formed pull request facts, or `null`. */
export function parseGitHubPullPreviewFacts(
  value: unknown,
): GitHubPullPreviewFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const field = (name: string): unknown => Reflect.get(value, name);
  const additions = field('additions');
  const deletions = field('deletions');
  const changedFiles = field('changedFiles');
  const mergeable = field('mergeable');
  const checks = field('checks');
  const reviewDecision = field('reviewDecision');
  const inMergeQueue = field('inMergeQueue');
  if (
    !isCount(additions) ||
    !isCount(deletions) ||
    !isCount(changedFiles) ||
    (mergeable !== 'mergeable' &&
      mergeable !== 'conflicting' &&
      mergeable !== 'unknown') ||
    (checks !== 'passing' &&
      checks !== 'failing' &&
      checks !== 'pending' &&
      checks !== 'none') ||
    (reviewDecision !== 'approved' &&
      reviewDecision !== 'changes_requested' &&
      reviewDecision !== null) ||
    typeof inMergeQueue !== 'boolean'
  )
    return null;
  return {
    additions,
    deletions,
    changedFiles,
    mergeable,
    checks,
    reviewDecision,
    inMergeQueue,
  };
}

export interface GitHubRepositoryPreview {
  readonly kind: 'repository';
  readonly owner: string;
  readonly repository: string;
  /** `owner/repo` with GitHub's casing, for display. */
  readonly fullName: string;
  /** Canonical repository URL returned by GitHub. */
  readonly url: string;
  /** Bounded plain-text description. */
  readonly description: string | null;
  readonly private: boolean;
  readonly archived: boolean;
  /** ISO timestamp of the provider's last update. */
  readonly updatedAt: string;
}

export type GitHubPreview = GitHubItemPreview | GitHubRepositoryPreview;

export type GitHubPreviewResult =
  | {
      readonly status: 'ok';
      readonly scope: string;
      readonly preview: GitHubPreview;
      /** Acquisition time for reused tracked facts; absent for a new provider read. */
      readonly fetchedAt?: number;
    }
  | { readonly status: 'disconnected' }
  /** Not found or not permitted for this credential. */
  | { readonly status: 'unavailable'; readonly scope: string }
  | { readonly status: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly status: 'failed' };

export interface GitHubPreviewScope {
  /** Opaque Canopy account and GitHub credential identity; `null` when disconnected. */
  readonly scope: string | null;
  /**
   * Set while `scope` is `null` only because the host is waiting out a
   * credential GitHub rejected: milliseconds until it will try it again.
   */
  readonly retryAfterMs?: number;
}

export const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9_.-]{1,100}$/;
/** GitHub item numbers are positive 32-bit integers. */
export const GITHUB_ITEM_NUMBER_MAX = 2_147_483_647;
/** Bounds a provider title for display and transport, in code points. */
export const GITHUB_TITLE_MAX_CODE_POINTS = 512;
const ORIGIN_ID_MAX_LENGTH = 256;

export function isGitHubRepositoryName(
  owner: unknown,
  repository: unknown,
): boolean {
  return (
    typeof owner === 'string' &&
    typeof repository === 'string' &&
    GITHUB_OWNER_PATTERN.test(owner) &&
    GITHUB_REPOSITORY_PATTERN.test(repository) &&
    repository !== '.' &&
    repository !== '..'
  );
}

export function isGitHubItemNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= GITHUB_ITEM_NUMBER_MAX
  );
}

export function isGitHubPreviewTarget(
  value: unknown,
): value is GitHubPreviewTarget {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = Reflect.get(value, 'kind');
  if (
    !isGitHubRepositoryName(
      Reflect.get(value, 'owner'),
      Reflect.get(value, 'repository'),
    )
  ) {
    return false;
  }
  if (kind === 'repository') return true;
  return kind === 'item' && isGitHubItemNumber(Reflect.get(value, 'number'));
}

function isOriginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ORIGIN_ID_MAX_LENGTH
  );
}

export function isGitHubReferenceOrigin(
  value: unknown,
): value is GitHubReferenceOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = Reflect.get(value, 'kind');
  if (kind === 'cowork') return true;
  return (
    kind === 'worktree' &&
    isOriginId(Reflect.get(value, 'projectId')) &&
    isOriginId(Reflect.get(value, 'worktreeId'))
  );
}

/** Stable cache identity: identical numbers in different repositories never collide. */
export function gitHubPreviewTargetKey(target: GitHubPreviewTarget): string {
  return target.kind === 'repository'
    ? `github.com/${target.owner}/${target.repository}`
    : `github.com/${target.owner}/${target.repository}#${target.number}`;
}
