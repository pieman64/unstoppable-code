import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { GitHubRepoSummary } from '@canopy/desktop-shared/types';
import { getGitHubClient } from './github-client';

const MAX_REPOS = 300;
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 30_000;

type ListUserReposResponse =
  RestEndpointMethodTypes['repos']['listForAuthenticatedUser']['response'];
type RepoListItem = ListUserReposResponse['data'][number];

/** What `core.integration.resource.list` reads beside each legacy row. */
export interface GitHubRepoAccess {
  fullName: string;
  htmlUrl: string;
  permissions: { pull: boolean; push: boolean; admin: boolean };
  updatedAt: string | null;
}

/** One cached listing: the legacy rows and their access, in one order. */
export interface GitHubRepoSnapshot {
  /** Changes whenever the listing is re-read. */
  id: string;
  repos: GitHubRepoSummary[];
  access: GitHubRepoAccess[];
}

/** The 30-second whole-lookup timeout; its message is the legacy one. */
export class GitHubRepoListTimeoutError extends Error {}

let cachedSnapshot: GitHubRepoSnapshot | null = null;
let cachedAt = 0;
let pendingLookup: Promise<GitHubRepoSnapshot> | null = null;
let cacheGeneration = 0;
let snapshotSequence = 0;

function mapAccess(repo: RepoListItem): GitHubRepoAccess {
  return {
    fullName: repo.full_name,
    htmlUrl: repo.html_url,
    permissions: {
      pull: repo.permissions?.pull === true,
      push: repo.permissions?.push === true,
      admin: repo.permissions?.admin === true,
    },
    updatedAt: repo.updated_at ?? null,
  };
}

function mapRepo(repo: RepoListItem): GitHubRepoSummary {
  return {
    fullName: repo.full_name,
    ownerLogin: repo.owner.login,
    name: repo.name,
    description: repo.description,
    cloneUrl: repo.clone_url,
    sshUrl: repo.ssh_url,
    htmlUrl: repo.html_url,
    isPrivate: repo.private,
    isFork: repo.fork,
    isArchived: repo.archived,
    defaultBranch: repo.default_branch,
    updatedAt: repo.updated_at,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new GitHubRepoListTimeoutError(message));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
    });
  });
}

async function fetchUserRepos(): Promise<RepoListItem[]> {
  const client = getGitHubClient();
  const results: RepoListItem[] = [];

  for (let page = 1; results.length < MAX_REPOS; page += 1) {
    const response = await client.enqueue(
      (octokit): Promise<ListUserReposResponse> =>
        octokit.repos.listForAuthenticatedUser({
          affiliation: 'owner,collaborator,organization_member',
          sort: 'updated',
          per_page: PAGE_SIZE,
          page,
          request: {
            timeout: REQUEST_TIMEOUT_MS,
          },
        }),
      'high',
      {
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
    );

    const batch = response.data;
    if (batch.length === 0) {
      break;
    }

    for (const repo of batch) {
      results.push(repo);
      if (results.length >= MAX_REPOS) {
        break;
      }
    }

    if (batch.length < PAGE_SIZE) {
      break;
    }
  }

  return results;
}

export function invalidateGitHubRepoListCache(): void {
  cacheGeneration += 1;
  cachedSnapshot = null;
  cachedAt = 0;
  pendingLookup = null;
}

/**
 * The listing as one snapshot, cached for 60 seconds; concurrent callers
 * share one read, and a credential reset discards the snapshot and any read
 * in flight.
 */
export async function listUserRepoSnapshot(): Promise<GitHubRepoSnapshot> {
  if (cachedSnapshot && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedSnapshot;
  }

  if (pendingLookup) {
    return pendingLookup;
  }

  const lookupGeneration = cacheGeneration;
  const fetchPromise = fetchUserRepos();
  void fetchPromise.catch(() => undefined);

  pendingLookup = withTimeout(
    fetchPromise,
    LOOKUP_TIMEOUT_MS,
    'Timed out while loading repositories from GitHub.',
  )
    .then((items): GitHubRepoSnapshot => {
      snapshotSequence += 1;
      const snapshot: GitHubRepoSnapshot = {
        id: `${lookupGeneration}.${snapshotSequence}`,
        repos: items.map(mapRepo),
        access: items.map(mapAccess),
      };
      if (cacheGeneration === lookupGeneration) {
        cachedSnapshot = snapshot;
        cachedAt = Date.now();
      }
      return snapshot;
    })
    .finally(() => {
      if (cacheGeneration === lookupGeneration) {
        pendingLookup = null;
      }
    });

  return pendingLookup;
}

export async function listUserRepos(): Promise<GitHubRepoSummary[]> {
  return (await listUserRepoSnapshot()).repos;
}
