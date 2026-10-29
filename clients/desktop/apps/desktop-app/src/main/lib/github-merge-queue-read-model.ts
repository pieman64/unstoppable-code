import {
  toPrMergeQueuePhase,
  type GitHubMergeQueueEntry,
  type GitHubMergeQueueRequest,
  type GitHubMergeQueueResponse,
} from '@canopy/desktop-shared/types/github';
import { readMergeQueueEstimatedSeconds } from '@canopy/desktop-shared/lib/pr-merge-queue';
import { isGitHubRepositoryName } from '@canopy/protocol/reference-previews';
import {
  getGitHubBroker,
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  isGitHubBrokerError,
  type GitHubRawResponse,
} from './github-broker';
import { GitHubGraphQlRateLimitError } from './github-broker/errors';

/**
 * On-demand read of one branch's merge queue for the PR bar's queue popover.
 * The popover asks while it is open, so answers are cached briefly and
 * concurrent asks for the same queue share one GraphQL read.
 */

export const GITHUB_MERGE_QUEUE_TTL_MS = 20_000;
export const GITHUB_MERGE_QUEUE_PAGE_SIZE = 50;

const READ_TIMEOUT_MS = 20_000;
const MAX_CACHED_QUEUES = 50;
const MAX_BRANCH_LENGTH = 255;
const MAX_TITLE_LENGTH = 1_024;
const MAX_URL_LENGTH = 2_048;
const MAX_TIMESTAMP_LENGTH = 64;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/;

const MERGE_QUEUE_QUERY = `
  query ($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      mergeQueue(branch: $branch) {
        url
        configuration { maximumEntriesToBuild }
        entries(first: ${GITHUB_MERGE_QUEUE_PAGE_SIZE}) {
          totalCount
          nodes {
            position
            state
            estimatedTimeToMerge
            enqueuedAt
            pullRequest { number title url author { login } }
          }
        }
      }
    }
  }
`;

interface QueueRef {
  owner: string;
  repo: string;
  baseBranch: string;
}

interface CacheEntry {
  response: GitHubMergeQueueResponse;
  atMs: number;
}

let generation = 0;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GitHubMergeQueueResponse>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): GitHubBrokerError {
  return new GitHubBrokerError(
    'invalid_response',
    'GitHub merge queue request was malformed.',
  );
}

function isBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_BRANCH_LENGTH &&
    !value.startsWith('-') &&
    !/[\s~^:?*[\\]/.test(value) &&
    !value.includes('..')
  );
}

function toQueueRef(request: GitHubMergeQueueRequest): QueueRef {
  const repository = isRecord(request) ? request.repository : undefined;
  const baseBranch = isRecord(request) ? request.baseBranch : undefined;
  if (typeof repository !== 'string' || typeof baseBranch !== 'string') {
    throw malformed();
  }
  const [owner = '', repo = '', extra] = repository.split('/');
  if (
    extra !== undefined ||
    !isGitHubRepositoryName(owner.toLowerCase(), repo.toLowerCase()) ||
    !isBranchName(baseBranch)
  ) {
    throw malformed();
  }
  return { owner, repo, baseBranch };
}

function cacheKey(ref: QueueRef): string {
  return `${generation}:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}@${ref.baseBranch}`;
}

function githubUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_TIMESTAMP_LENGTH) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function readEntry(node: unknown): GitHubMergeQueueEntry | null {
  if (!isRecord(node) || !isRecord(node.pullRequest)) return null;
  const position = nonNegativeIntegerOrNull(node.position);
  const number = nonNegativeIntegerOrNull(node.pullRequest.number);
  const url = githubUrlOrNull(node.pullRequest.url);
  if (position === null || number === null || number === 0 || url === null) {
    return null;
  }
  const title =
    typeof node.pullRequest.title === 'string'
      ? node.pullRequest.title
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_TITLE_LENGTH)
      : '';
  const author = isRecord(node.pullRequest.author)
    ? node.pullRequest.author.login
    : null;
  return {
    position,
    phase: toPrMergeQueuePhase(node.state),
    estimatedSecondsToMerge: readMergeQueueEstimatedSeconds(
      node.estimatedTimeToMerge,
    ),
    enqueuedAt: isoTimestampOrNull(node.enqueuedAt),
    pullRequest: {
      number,
      title,
      url,
      author:
        typeof author === 'string' && LOGIN_PATTERN.test(author)
          ? author
          : null,
    },
  };
}

function repositoryOf(body: unknown): Record<string, unknown> {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const repository =
    data && isRecord(data.repository) ? data.repository : undefined;
  if (repository) return repository;
  const missing =
    isRecord(body) &&
    Array.isArray(body.errors) &&
    body.errors.some(
      (error: unknown) => isRecord(error) && error.type === 'NOT_FOUND',
    );
  throw missing
    ? new GitHubBrokerError('not_found', 'GitHub repository was not found.')
    : new GitHubBrokerError(
        'invalid_response',
        'GitHub merge queue read returned no repository.',
      );
}

/**
 * Map a merge queue query body to the display view. Entries that are not a
 * well-formed pull request are dropped, the rest are bounded and sorted by
 * position. Throws when the body names no repository.
 */
export function readGitHubMergeQueue(
  body: unknown,
  baseBranch: string,
  fetchedAt: string,
): GitHubMergeQueueResponse {
  const repository = repositoryOf(body);
  const queue = repository.mergeQueue;
  if (!isRecord(queue)) return { queue: null };
  const entries = isRecord(queue.entries) ? queue.entries : {};
  const nodes = Array.isArray(entries.nodes)
    ? entries.nodes.slice(0, GITHUB_MERGE_QUEUE_PAGE_SIZE)
    : [];
  const parsed = nodes
    .map(readEntry)
    .filter((entry): entry is GitHubMergeQueueEntry => entry !== null)
    .sort((left, right) => left.position - right.position);
  const totalCount = nonNegativeIntegerOrNull(entries.totalCount);
  const configuration = isRecord(queue.configuration)
    ? queue.configuration
    : {};
  const buildCount = nonNegativeIntegerOrNull(
    configuration.maximumEntriesToBuild,
  );
  return {
    queue: {
      url: githubUrlOrNull(queue.url),
      baseBranch,
      totalCount:
        totalCount !== null && totalCount >= parsed.length
          ? totalCount
          : parsed.length,
      maximumEntriesToBuild:
        buildCount !== null && buildCount > 0 ? buildCount : null,
      entries: parsed,
      fetchedAt,
    },
  };
}

function isGraphQlRateLimited(body: unknown): boolean {
  return (
    isRecord(body) &&
    Array.isArray(body.errors) &&
    body.errors.some(
      (error: unknown) => isRecord(error) && error.type === 'RATE_LIMITED',
    )
  );
}

async function fetchQueue(ref: QueueRef): Promise<GitHubMergeQueueResponse> {
  const result = await getGitHubBroker().execute<GitHubMergeQueueResponse>(
    async (octokit): Promise<GitHubRawResponse<GitHubMergeQueueResponse>> => {
      const route: string = 'POST /graphql';
      const response = await octokit.request(route, {
        query: MERGE_QUEUE_QUERY,
        variables: { owner: ref.owner, name: ref.repo, branch: ref.baseBranch },
      });
      const body: unknown = response.data;
      if (isGraphQlRateLimited(body)) {
        throw new GitHubGraphQlRateLimitError(response.headers);
      }
      return {
        status: response.status,
        headers: response.headers,
        data: readGitHubMergeQueue(
          body,
          ref.baseBranch,
          new Date().toISOString(),
        ),
      };
    },
    {
      priority: 'interactive',
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: READ_TIMEOUT_MS,
      resource: 'graphql',
      caller: 'merge-queue-popover',
    },
  );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub merge queue read returned a mutation result.',
    );
  }
  return result.data;
}

function store(key: string, response: GitHubMergeQueueResponse): void {
  cache.delete(key);
  cache.set(key, { response, atMs: Date.now() });
  while (cache.size > MAX_CACHED_QUEUES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof GitHubBrokerCredentialResetError ||
    (isGitHubBrokerError(error) && error.code === 'not_authenticated')
  );
}

/**
 * One branch's merge queue. A cached answer younger than
 * {@link GITHUB_MERGE_QUEUE_TTL_MS} returns without a request; otherwise
 * concurrent callers share one read.
 */
export async function getGitHubMergeQueue(
  request: GitHubMergeQueueRequest,
): Promise<GitHubMergeQueueResponse> {
  const ref = toQueueRef(request);
  const key = cacheKey(ref);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.atMs <= GITHUB_MERGE_QUEUE_TTL_MS) {
    return cached.response;
  }
  const existing = inFlight.get(key);
  if (existing) return existing;
  const startedGeneration = generation;
  const read = fetchQueue(ref).then(
    (response) => {
      if (inFlight.get(key) === read) inFlight.delete(key);
      if (startedGeneration === generation) store(key, response);
      return response;
    },
    (error: unknown) => {
      if (inFlight.get(key) === read) inFlight.delete(key);
      if (startedGeneration === generation && isCredentialFailure(error)) {
        resetGitHubMergeQueueReadModel();
      }
      throw error;
    },
  );
  inFlight.set(key, read);
  return read;
}

/** Forget every cached queue; call when GitHub credentials change. */
export function resetGitHubMergeQueueReadModel(): void {
  generation += 1;
  cache.clear();
  inFlight.clear();
}
