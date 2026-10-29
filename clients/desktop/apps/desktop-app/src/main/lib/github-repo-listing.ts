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

let cachedRepos: GitHubRepoSummary[] | null = null;
let cachedAt = 0;
let pendingLookup: Promise<GitHubRepoSummary[]> | null = null;
let cacheGeneration = 0;

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
      reject(new Error(message));
    }, timeoutMs);

    promise.then(resolve, reject).finally(() => {
      clearTimeout(timeout);
    });
  });
}

async function fetchUserRepos(): Promise<GitHubRepoSummary[]> {
  const client = getGitHubClient();
  const results: GitHubRepoSummary[] = [];

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
      results.push(mapRepo(repo));
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
  cachedRepos = null;
  cachedAt = 0;
  pendingLookup = null;
}

export async function listUserRepos(): Promise<GitHubRepoSummary[]> {
  if (cachedRepos && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedRepos;
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
    .then((repos): GitHubRepoSummary[] => {
      if (cacheGeneration === lookupGeneration) {
        cachedRepos = repos;
        cachedAt = Date.now();
      }
      return repos;
    })
    .finally(() => {
      if (cacheGeneration === lookupGeneration) {
        pendingLookup = null;
      }
    });

  return pendingLookup;
}
