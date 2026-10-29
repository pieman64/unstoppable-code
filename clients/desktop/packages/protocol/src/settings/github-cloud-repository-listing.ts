// ---------------------------------------------------------------------------
// Repository listing for cloud projects: browser contract (REG-3021).
//
// Moved verbatim from `apps/web/src/lib/github/cloud-repository-listing-contracts.ts`,
// which re-exports it.
//
// Browser-safe: no server, Node or Prisma imports (a census test enforces the
// import list). The page DTO `GET /api/cloud/github/repositories` returns,
// its runtime guard, and the strict query parsers that route and client
// share.
//
// Paging is honest. Search is local filtering over GitHub's own pages of one
// installation, never GitHub's global search: one request scans at most
// `GITHUB_CLOUD_REPOSITORY_SCAN_MAX_PAGES` upstream pages from its cursor
// (one page without a query) and answers the next unscanned page. A filtered
// page may be empty and still carry a `nextCursor`. `searchIncomplete` is
// true while upstream pages remain that this answer did not scan; with a null
// `nextCursor` that means the page cap was reached (offer URL import), and
// only `nextCursor === null && !searchIncomplete` is an exhausted stream.
// ---------------------------------------------------------------------------

import { isCanonicalGitHubId } from './account-github';
import {
  GITHUB_REPOSITORY_VISIBILITIES,
  type GitHubRepositoryVisibility,
} from './cloud-repository-contracts';
import {
  isGitHubOwnerLogin,
  isGitHubRepositoryName,
} from './github-repository-url';
import { GITHUB_REPOSITORY_QUERY_MAX_LENGTH } from './organization-repositories';

/** Repositories per upstream page (GitHub's maximum). */
export const GITHUB_CLOUD_REPOSITORY_PAGE_SIZE = 100;
/** Upstream pages one request may scan for a query. */
export const GITHUB_CLOUD_REPOSITORY_SCAN_MAX_PAGES = 3;
/** The last page a cursor may name (10,000 repositories). */
export const GITHUB_CLOUD_REPOSITORY_MAX_CURSOR = 100;

export const GITHUB_CLOUD_REPOSITORY_PERMISSIONS = [
  'none',
  'read',
  'write',
  'admin',
] as const;
/**
 * The user's permission as GitHub reported it on the listing row. `none`
 * also covers a row GitHub sent without permissions, so treat it as unknown;
 * the server re-verifies write access on submit either way.
 */
export type GitHubCloudRepositoryPermission =
  (typeof GITHUB_CLOUD_REPOSITORY_PERMISSIONS)[number];

/** One repository the user's token can see in the installation. */
export interface GitHubCloudRepositoryDto {
  /** Immutable GitHub repository id (canonical decimal string). */
  readonly providerRepoId: string;
  readonly ownerLogin: string;
  readonly ownerType: 'User' | 'Organization';
  readonly name: string;
  /** Always `${ownerLogin}/${name}`. */
  readonly fullName: string;
  readonly private: boolean;
  readonly visibility: GitHubRepositoryVisibility;
  readonly archived: boolean;
  readonly permission: GitHubCloudRepositoryPermission;
  readonly description: string | null;
  readonly defaultBranch: string | null;
  /** Last push (or update) as ISO 8601. */
  readonly updatedAt: string | null;
}

export interface GitHubCloudRepositoryPageDto {
  readonly installationId: string;
  /** Matches from the scanned pages, in GitHub's order, without duplicates. */
  readonly repositories: readonly GitHubCloudRepositoryDto[];
  /** `selected`: only repositories granted to the app are listed. */
  readonly repositorySelection: 'all' | 'selected' | null;
  /** GitHub's total for the installation (before any query). */
  readonly totalCount: number;
  /** The next unscanned page, or null when exhausted or at the page cap. */
  readonly nextCursor: number | null;
  /** Upstream pages remain that this answer did not scan. */
  readonly searchIncomplete: boolean;
}

/** A validated listing request. */
export interface GitHubCloudRepositoryListingInput {
  readonly installationId: string;
  /** 1..`GITHUB_CLOUD_REPOSITORY_MAX_CURSOR`. */
  readonly cursor: number;
  /** As typed (at most `GITHUB_REPOSITORY_QUERY_MAX_LENGTH`); '' for none. */
  readonly query: string;
}

export type GitHubCloudRepositoryListingQueryResult =
  | { readonly ok: true; readonly input: GitHubCloudRepositoryListingInput }
  | { readonly ok: false };

export type GitHubCloudInstallationQueryResult =
  | { readonly ok: true; readonly installationId: string }
  | { readonly ok: false };

const CURSOR = /^[1-9][0-9]{0,2}$/;

/** The single value of a parameter; null when absent; undefined when repeated. */
function single(
  params: URLSearchParams,
  name: string,
): string | null | undefined {
  const values = params.getAll(name);
  if (values.length > 1) return undefined;
  return values[0] ?? null;
}

function readInstallationId(params: URLSearchParams): string | null {
  const value = single(params, 'installationId');
  return typeof value === 'string' && isCanonicalGitHubId(value) ? value : null;
}

function readCursor(params: URLSearchParams): number | null {
  const value = single(params, 'cursor');
  if (value === null) return 1;
  if (value === undefined || !CURSOR.test(value)) return null;
  const cursor = Number.parseInt(value, 10);
  return cursor <= GITHUB_CLOUD_REPOSITORY_MAX_CURSOR ? cursor : null;
}

/**
 * `installationId` (required, canonical), `cursor` (optional page 1..100)
 * and `q` (optional, bounded). A repeated parameter is refused, never
 * resolved by picking one; unrelated parameters are ignored.
 */
export function parseGitHubCloudRepositoryListingQuery(
  params: URLSearchParams,
): GitHubCloudRepositoryListingQueryResult {
  const installationId = readInstallationId(params);
  const cursor = readCursor(params);
  const query = single(params, 'q');
  if (
    installationId === null ||
    cursor === null ||
    query === undefined ||
    (query !== null && query.length > GITHUB_REPOSITORY_QUERY_MAX_LENGTH)
  ) {
    return { ok: false };
  }
  return { ok: true, input: { installationId, cursor, query: query ?? '' } };
}

/** Exactly one canonical `installationId`. */
export function parseGitHubCloudInstallationQuery(
  params: URLSearchParams,
): GitHubCloudInstallationQueryResult {
  const installationId = readInstallationId(params);
  return installationId === null ? { ok: false } : { ok: true, installationId };
}

// ---------------------------------------------------------------------------
// Runtime guard
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isIsoTimestampOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isRepository(value: unknown): value is GitHubCloudRepositoryDto {
  if (!isRecord(value)) return false;
  const { ownerLogin, name } = value;
  return (
    isCanonicalGitHubId(value.providerRepoId) &&
    typeof ownerLogin === 'string' &&
    isGitHubOwnerLogin(ownerLogin) &&
    typeof name === 'string' &&
    isGitHubRepositoryName(name) &&
    value.fullName === `${ownerLogin}/${name}` &&
    (value.ownerType === 'User' || value.ownerType === 'Organization') &&
    typeof value.private === 'boolean' &&
    isOneOf(GITHUB_REPOSITORY_VISIBILITIES, value.visibility) &&
    (value.visibility === 'public') === !value.private &&
    typeof value.archived === 'boolean' &&
    isOneOf(GITHUB_CLOUD_REPOSITORY_PERMISSIONS, value.permission) &&
    isNullableString(value.description) &&
    isNullableString(value.defaultBranch) &&
    isIsoTimestampOrNull(value.updatedAt)
  );
}

function areRepositories(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const entries: readonly unknown[] = value;
  return entries.every(isRepository);
}

function isNextCursor(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= GITHUB_CLOUD_REPOSITORY_MAX_CURSOR)
  );
}

/** Validates a listing page; tolerates additive fields. */
export function isGitHubCloudRepositoryPageDto(
  value: unknown,
): value is GitHubCloudRepositoryPageDto {
  return (
    isRecord(value) &&
    isCanonicalGitHubId(value.installationId) &&
    areRepositories(value.repositories) &&
    (value.repositorySelection === null ||
      value.repositorySelection === 'all' ||
      value.repositorySelection === 'selected') &&
    typeof value.totalCount === 'number' &&
    Number.isSafeInteger(value.totalCount) &&
    value.totalCount >= 0 &&
    isNextCursor(value.nextCursor) &&
    typeof value.searchIncomplete === 'boolean'
  );
}
