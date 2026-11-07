import type { RestEndpointMethodTypes } from '@octokit/rest';
import type {
  PullRequestSummary,
  RepoSlug,
} from '@canopy/desktop-shared/types';
import {
  normalizePullRequestTitleQuery,
  scopePullRequestTitleQuery,
} from '@canopy/protocol/pull-requests';
import { validateAbsolutePath } from './validation';
import { getRemoteUrl } from './git';
import { getGitHubClient } from './github-client';
import { parseGitHubRemote } from './github-pr';

const CACHE_TTL_MS = 60_000;
const REPO_SLUG_CACHE_TTL_MS = 5 * 60_000;
const PAGE_SIZE = 50;

type ListPullRequestsApiResponse =
  RestEndpointMethodTypes['pulls']['list']['response'];
type PullRequestListItem = ListPullRequestsApiResponse['data'][number];

interface CacheEntry {
  data: PullRequestSummary[];
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();
const pendingLookups = new Map<string, Promise<PullRequestSummary[]>>();
let cacheGeneration = 0;

function mapPullRequest(
  pr: PullRequestListItem,
  owner: string,
  repo: string,
): PullRequestSummary {
  const headRepoFullName = pr.head.repo?.full_name ?? null;
  const expectedFullName = `${owner}/${repo}`;
  const isCrossRepo =
    headRepoFullName === null ||
    headRepoFullName.toLowerCase() !== expectedFullName.toLowerCase();

  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    url: pr.html_url,
    authorLogin: pr.user?.login ?? '',
    isDraft: pr.draft === true,
    isCrossRepo,
  };
}

/** Local origin resolution shared by listing, title search, and slug lookup. */
async function resolveGitHubOrigin(repoPath: string): Promise<RepoSlug | null> {
  const remoteUrl = await getRemoteUrl(repoPath);
  return remoteUrl ? parseGitHubRemote(remoteUrl) : null;
}

async function fetchOpenPullRequests(
  repoPath: string,
  origin: RepoSlug | undefined,
): Promise<PullRequestSummary[]> {
  const remote = origin ?? (await resolveGitHubOrigin(repoPath));
  if (!remote) {
    throw new Error(
      'This repository has no GitHub origin remote, so pull requests cannot be listed.',
    );
  }

  const client = getGitHubClient();
  const response = await client.enqueue(
    (octokit): Promise<ListPullRequestsApiResponse> =>
      octokit.pulls.list({
        owner: remote.owner,
        repo: remote.repo,
        state: 'open',
        per_page: PAGE_SIZE,
        sort: 'updated',
        direction: 'desc',
      }),
    'high',
  );

  return response.data.map((pr) =>
    mapPullRequest(pr, remote.owner, remote.repo),
  );
}

/**
 * Invalidate cached and in-flight pull request listings after credentials
 * change so the next lookup cannot reuse data from the previous account.
 */
export function invalidatePullRequestListingCache(): void {
  cacheGeneration += 1;
  cache.clear();
  searchCache.clear();
  pendingSearches.clear();
  pendingLookups.clear();
}

/** Test-only alias retained for descriptive setup in the listing tests. */
export const __resetPullRequestListingCacheForTests =
  invalidatePullRequestListingCache;

/**
 * List open pull requests for a repo's GitHub origin remote, mapped to the
 * fields the create-from dropdown needs. Results are cached per repo path for
 * `CACHE_TTL_MS` and concurrent lookups for the same repo share one in-flight
 * request, mirroring `github-repo-listing.ts`. A caller that already read the
 * origin passes it, so a lookup reads it once.
 */
export async function listOpenPullRequestsForRepo(
  repoPath: string,
  origin?: RepoSlug,
): Promise<PullRequestSummary[]> {
  const cached = cache.get(repoPath);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const pending = pendingLookups.get(repoPath);
  if (pending) {
    return pending;
  }

  const lookupGeneration = cacheGeneration;
  const fetchPromise = fetchOpenPullRequests(repoPath, origin);
  void fetchPromise.catch(() => undefined);

  const trackedLookup = fetchPromise
    .then((pullRequests): PullRequestSummary[] => {
      if (cacheGeneration === lookupGeneration) {
        cache.set(repoPath, {
          data: pullRequests,
          cachedAt: Date.now(),
        });
      }
      return pullRequests;
    })
    .finally(() => {
      if (cacheGeneration === lookupGeneration) {
        pendingLookups.delete(repoPath);
      }
    });

  pendingLookups.set(repoPath, trackedLookup);

  return trackedLookup;
}

interface RepoSlugCacheEntry {
  slug: RepoSlug | null;
  cachedAt: number;
}

const repoSlugCache = new Map<string, RepoSlugCacheEntry>();

/** Test-only hook to reset the repo-slug TTL cache between tests. */
export function __resetRepoSlugCacheForTests(): void {
  repoSlugCache.clear();
}

/**
 * Resolve a repo's GitHub origin `{ owner, repo }` slug from its local git
 * config. Returns `null` when the repo has no origin remote or the remote is
 * not a GitHub remote (never throws — a missing/foreign remote is a normal,
 * expected result the caller acts on). This is a purely local `git config`
 * read plus a pure parse, so no GitHub broker/API call is involved; results
 * are cached per repo path for `REPO_SLUG_CACHE_TTL_MS`. `readRemoteUrl`
 * reads `origin` on a miss; it answers `null` for an absent origin or any
 * failure, as the direct read does.
 */
export async function getRepoSlugForRepoPath(
  repoPath: string,
  readRemoteUrl: (repoPath: string) => Promise<string | null> = getRemoteUrl,
): Promise<RepoSlug | null> {
  const cached = repoSlugCache.get(repoPath);
  if (cached && Date.now() - cached.cachedAt < REPO_SLUG_CACHE_TTL_MS) {
    return cached.slug;
  }

  const remoteUrl = await readRemoteUrl(repoPath);
  const remote = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  const slug: RepoSlug | null = remote
    ? { owner: remote.owner, repo: remote.repo }
    : null;

  repoSlugCache.set(repoPath, { slug, cachedAt: Date.now() });
  return slug;
}

const SEARCH_CACHE_LIMIT = 100;
const searchCache = new Map<string, CacheEntry>();
const pendingSearches = new Map<string, Promise<PullRequestSummary[]>>();

const PR_PICKER_SEARCH_QUERY = `
  query PrPickerSearch($q: String!) {
    search(type: ISSUE, first: 20, query: $q) {
      nodes {
        __typename
        ... on PullRequest {
          number title url headRefName baseRefName isDraft
          author { login }
          headRepository { nameWithOwner }
        }
      }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapSearchPullRequest(
  value: unknown,
  remote: RepoSlug,
): PullRequestSummary | null {
  if (
    !isRecord(value) ||
    value.__typename !== 'PullRequest' ||
    typeof value.number !== 'number' ||
    !Number.isSafeInteger(value.number) ||
    value.number <= 0 ||
    typeof value.title !== 'string' ||
    !value.title ||
    typeof value.url !== 'string' ||
    !value.url ||
    typeof value.headRefName !== 'string' ||
    !value.headRefName ||
    typeof value.baseRefName !== 'string' ||
    !value.baseRefName ||
    typeof value.isDraft !== 'boolean'
  )
    return null;

  const headRepoName =
    isRecord(value.headRepository) &&
    typeof value.headRepository.nameWithOwner === 'string'
      ? value.headRepository.nameWithOwner
      : null;
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    isDraft: value.isDraft,
    authorLogin:
      isRecord(value.author) && typeof value.author.login === 'string'
        ? value.author.login
        : '',
    isCrossRepo:
      headRepoName === null ||
      headRepoName.toLowerCase() !==
        `${remote.owner}/${remote.repo}`.toLowerCase(),
  };
}

async function fetchSearchPullRequests(
  remote: { owner: string; repo: string },
  normalizedQuery: string,
  signal?: AbortSignal,
): Promise<PullRequestSummary[]> {
  const q = scopePullRequestTitleQuery(remote, normalizedQuery);
  const response = await getGitHubClient().enqueue(
    (octokit) => octokit.graphql<unknown>(PR_PICKER_SEARCH_QUERY, { q }),
    'high',
    {
      operation: 'read',
      idempotency: 'safe',
      resource: 'graphql',
      caller: 'pr-picker-search',
      ...(signal ? { signal } : {}),
    },
  );
  // Octokit normally throws on GraphQL errors. Also reject malformed/partial
  // envelopes so custom transports cannot cache a failure as an empty result.
  if (
    !isRecord(response) ||
    (response.errors !== undefined &&
      (!Array.isArray(response.errors) || response.errors.length > 0)) ||
    !isRecord(response.search) ||
    !Array.isArray(response.search.nodes)
  ) {
    throw new Error(
      'GitHub could not complete the pull request search. Try again.',
    );
  }
  return response.search.nodes
    .flatMap((node: unknown): PullRequestSummary[] => {
      const mapped = mapSearchPullRequest(node, remote);
      return mapped ? [mapped] : [];
    })
    .slice(0, 20);
}

/** Canonical search binds the GitHub repository, not the legacy path cache. */
export async function searchOpenPullRequestsForRepository(
  repository: { owner: string; repo: string },
  query: string,
  signal?: AbortSignal,
): Promise<PullRequestSummary[]> {
  return fetchSearchPullRequests(
    repository,
    normalizePullRequestTitleQuery(query),
    signal,
  );
}

/** Bounded title search, separate from the initial 50-row listing cache. */
export async function searchOpenPullRequestsForRepo(
  repoPath: unknown,
  query: unknown,
): Promise<PullRequestSummary[]> {
  if (typeof repoPath !== 'string') {
    throw new Error('Invalid repoPath: must be an absolute path');
  }
  validateAbsolutePath(repoPath, 'repoPath');
  const normalizedQuery = normalizePullRequestTitleQuery(query);
  const key = JSON.stringify([repoPath, normalizedQuery]);
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.data;
  const pending = pendingSearches.get(key);
  if (pending) return pending;

  const generation = cacheGeneration;
  const lookup = resolveGitHubOrigin(repoPath)
    .then((remote) => {
      if (!remote)
        throw new Error(
          'This repository has no GitHub origin remote, so pull requests cannot be searched.',
        );
      return fetchSearchPullRequests(remote, normalizedQuery);
    })
    .then((data): PullRequestSummary[] => {
      if (generation === cacheGeneration) {
        searchCache.delete(key);
        if (searchCache.size >= SEARCH_CACHE_LIMIT) {
          const oldest = searchCache.keys().next();
          if (!oldest.done) searchCache.delete(oldest.value);
        }
        searchCache.set(key, { data, cachedAt: Date.now() });
      }
      return data;
    })
    .finally(() => {
      if (generation === cacheGeneration) pendingSearches.delete(key);
    });
  pendingSearches.set(key, lookup);
  return lookup;
}
