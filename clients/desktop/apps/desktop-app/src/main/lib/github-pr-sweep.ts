import type { PrStatusData } from '@canopy/desktop-shared/types/github';
import {
  type GitHubBrokerError,
  GitHubGraphQlRateLimitError,
  isGitHubBrokerError,
} from './github-broker/errors';
import { QUEUE_EVENT_ITEM_TYPES } from './github-broker/pull-requests';
import type { GitHubHeaders } from './github-broker/rate-limit';
import type { GitHubClient } from './github-client';
import { isRecord } from './type-guards';

/** Branches per GraphQL document; GitHub prices 25 fingerprints at about 2 points. */
export const PULL_REQUEST_SWEEP_CHUNK_SIZE = 25;
/** Fingerprints miss edits inside review threads and to older reviews. */
export const PULL_REQUEST_FULL_READ_INTERVAL_MS = 30 * 60_000;

/**
 * What a sweep compares between reads. `status` covers what the PR status bar
 * and check, conflict, label, and merge queue hooks read; `remarks` covers
 * what the comment and review hooks read.
 */
export interface PullRequestFingerprint {
  status: string;
  remarks: string;
}

export interface SweptPullRequest {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headSha: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  checksInFlight: boolean;
  fingerprint: PullRequestFingerprint;
}

/**
 * `unresolved` means the sweep could not tell which pull request the REST
 * lookup would pick, so the caller reads that branch per pull request.
 */
export type BranchPullRequestLookup =
  | { kind: 'none' }
  | { kind: 'found'; pullRequest: SweptPullRequest }
  | { kind: 'unresolved' };

export interface PullRequestSweepDocument {
  query: string;
  variables: Record<string, string>;
  branches: string[];
}

export interface PullRequestSweepRemote {
  owner: string;
  repo: string;
}

const CREATED_DESC = 'orderBy: { field: CREATED_AT, direction: DESC }';
const EDITS = 'totalCount nodes { lastEditedAt }';
const CHECK_COUNTS =
  'checkRunCountsByState { state count } statusContextCountsByState { state count }';
const LATEST_PULL_REQUEST_FIELDS =
  'number url title state isDraft createdAt updatedAt mergedAt headRefOid baseRefName headRepositoryOwner { login }';
const OPEN_PULL_REQUEST_FIELDS =
  `${LATEST_PULL_REQUEST_FIELDS} mergeable reviewDecision isInMergeQueue ` +
  'mergeQueueEntry { id state position } ' +
  `comments(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { ${EDITS} } ` +
  `reviews(last: 100) { ${EDITS} } ` +
  'reviewThreads(first: 100) { totalCount nodes { isResolved } } ' +
  `queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, first: 1) { filteredCount } ` +
  `commits(last: 1) { nodes { commit { statusCheckRollup { contexts { ${CHECK_COUNTS} } } } } }`;

const IN_FLIGHT_CHECK_RUN_STATES = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'WAITING',
  'PENDING',
  'REQUESTED',
]);
const IN_FLIGHT_STATUS_CONTEXT_STATES = new Set(['PENDING', 'EXPECTED']);

function branchAlias(index: number): string {
  return `b${index}`;
}

function latestAlias(index: number): string {
  return `${branchAlias(index)}_latest`;
}

/**
 * One aliased document per chunk of branches in one repository. Branch names
 * travel only as variables; aliases come from the branch's index.
 */
export function buildPullRequestSweepDocuments(
  remote: PullRequestSweepRemote,
  branches: readonly string[],
): PullRequestSweepDocument[] {
  const unique = Array.from(new Set(branches));
  const documents: PullRequestSweepDocument[] = [];
  for (
    let start = 0;
    start < unique.length;
    start += PULL_REQUEST_SWEEP_CHUNK_SIZE
  ) {
    const chunk = unique.slice(start, start + PULL_REQUEST_SWEEP_CHUNK_SIZE);
    const variables: Record<string, string> = {
      owner: remote.owner,
      name: remote.repo,
    };
    const declarations = ['$owner: String!', '$name: String!'];
    const fields = chunk.map((branch, index) => {
      const variable = `${branchAlias(index)}_head`;
      variables[variable] = branch;
      declarations.push(`$${variable}: String!`);
      return [
        `    ${branchAlias(index)}: pullRequests(headRefName: $${variable}, states: [OPEN], first: 1, ${CREATED_DESC}) { nodes { ${OPEN_PULL_REQUEST_FIELDS} } }`,
        `    ${latestAlias(index)}: pullRequests(headRefName: $${variable}, first: 1, ${CREATED_DESC}) { nodes { ${LATEST_PULL_REQUEST_FIELDS} } }`,
      ].join('\n');
    });
    documents.push({
      query: `query PullRequestSweep(${declarations.join(', ')}) {\n  repository(owner: $owner, name: $name) {\n${fields.join('\n')}\n  }\n}`,
      variables,
      branches: chunk,
    });
  }
  return documents;
}

/** A document GitHub answered without a usable repository. */
export class PullRequestSweepBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PullRequestSweepBatchError';
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNodes(connection: unknown): unknown[] | null {
  return isRecord(connection) && Array.isArray(connection.nodes)
    ? connection.nodes
    : null;
}

function readTotalCount(connection: unknown): number | null {
  return isRecord(connection) && typeof connection.totalCount === 'number'
    ? connection.totalCount
    : null;
}

function newestEdit(nodes: unknown[]): string {
  let newest = '';
  for (const node of nodes) {
    const editedAt = isRecord(node) ? readString(node.lastEditedAt) : null;
    if (editedAt !== null && editedAt > newest) newest = editedAt;
  }
  return newest;
}

function readStateCounts(value: unknown): Array<[string, number]> | null {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const counts: Array<[string, number]> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.state !== 'string' ||
      typeof entry.count !== 'number'
    ) {
      return null;
    }
    if (entry.count > 0) counts.push([entry.state, entry.count]);
  }
  return counts.sort(([left], [right]) => left.localeCompare(right));
}

interface CheckStateCounts {
  checkRuns: Array<[string, number]>;
  contexts: Array<[string, number]>;
}

function readCheckContexts(commits: unknown): CheckStateCounts | null {
  const nodes = readNodes(commits);
  if (nodes === null) return null;
  const node: unknown = nodes[0];
  if (node === undefined || node === null) {
    return { checkRuns: [], contexts: [] };
  }
  const commit = isRecord(node) ? node.commit : null;
  if (!isRecord(commit)) return null;
  const rollup = commit.statusCheckRollup;
  if (rollup === null || rollup === undefined) {
    return { checkRuns: [], contexts: [] };
  }
  const contexts = isRecord(rollup) ? rollup.contexts : null;
  if (!isRecord(contexts)) return null;
  const checkRuns = readStateCounts(contexts.checkRunCountsByState);
  const statusContexts = readStateCounts(contexts.statusContextCountsByState);
  return checkRuns && statusContexts
    ? { checkRuns, contexts: statusContexts }
    : null;
}

function toSweptState(value: unknown): SweptPullRequest['state'] | null {
  switch (value) {
    case 'OPEN':
      return 'open';
    case 'CLOSED':
      return 'closed';
    case 'MERGED':
      return 'merged';
    default:
      return null;
  }
}

interface PullRequestIdentity {
  headOwner: string | null;
  pullRequest: Omit<SweptPullRequest, 'checksInFlight' | 'fingerprint'>;
}

function decodeIdentity(node: unknown): PullRequestIdentity | null {
  if (!isRecord(node)) return null;
  const state = toSweptState(node.state);
  const url = readString(node.url);
  const title = readString(node.title);
  const headSha = readString(node.headRefOid);
  const baseRefName = readString(node.baseRefName);
  const createdAt = readString(node.createdAt);
  const updatedAt = readString(node.updatedAt);
  if (
    typeof node.number !== 'number' ||
    state === null ||
    url === null ||
    title === null ||
    typeof node.isDraft !== 'boolean' ||
    headSha === null ||
    baseRefName === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  const owner = isRecord(node.headRepositoryOwner)
    ? readString(node.headRepositoryOwner.login)
    : null;
  return {
    headOwner: owner,
    pullRequest: {
      number: node.number,
      url,
      title,
      state,
      isDraft: node.isDraft,
      headSha,
      baseRefName,
      createdAt,
      updatedAt,
      mergedAt: readString(node.mergedAt),
    },
  };
}

function decodeOpenPullRequest(
  node: unknown,
): { headOwner: string | null; pullRequest: SweptPullRequest } | null {
  const identity = decodeIdentity(node);
  if (!identity || !isRecord(node)) return null;
  const comments = readNodes(node.comments);
  const reviews = readNodes(node.reviews);
  const threads = readNodes(node.reviewThreads);
  const commentCount = readTotalCount(node.comments);
  const reviewCount = readTotalCount(node.reviews);
  const threadCount = readTotalCount(node.reviewThreads);
  const queueEvents = isRecord(node.queueEvents)
    ? node.queueEvents.filteredCount
    : undefined;
  const checks = readCheckContexts(node.commits);
  const entry = node.mergeQueueEntry;
  if (
    comments === null ||
    reviews === null ||
    threads === null ||
    commentCount === null ||
    reviewCount === null ||
    threadCount === null ||
    typeof queueEvents !== 'number' ||
    checks === null ||
    typeof node.isInMergeQueue !== 'boolean' ||
    !(entry === null || isRecord(entry))
  ) {
    return null;
  }
  const unresolvedThreads = threads.filter(
    (thread) => isRecord(thread) && thread.isResolved === false,
  ).length;
  const { pullRequest } = identity;
  return {
    headOwner: identity.headOwner,
    pullRequest: {
      ...pullRequest,
      checksInFlight:
        checks.checkRuns.some(([state]) =>
          IN_FLIGHT_CHECK_RUN_STATES.has(state),
        ) ||
        checks.contexts.some(([state]) =>
          IN_FLIGHT_STATUS_CONTEXT_STATES.has(state),
        ),
      fingerprint: {
        status: JSON.stringify([
          pullRequest.state,
          pullRequest.isDraft,
          readString(node.mergeable),
          pullRequest.headSha,
          pullRequest.baseRefName,
          pullRequest.updatedAt,
          readString(node.reviewDecision),
          node.isInMergeQueue,
          entry ? readString(entry.id) : null,
          entry ? readString(entry.state) : null,
          entry && typeof entry.position === 'number' ? entry.position : null,
          queueEvents,
          checks.checkRuns,
          checks.contexts,
        ]),
        remarks: JSON.stringify([
          commentCount,
          newestEdit(comments),
          reviewCount,
          newestEdit(reviews),
          threadCount,
          unresolvedThreads,
        ]),
      },
    },
  };
}

/**
 * A branch with no open pull request reads its newest one with identity
 * fields only, so any update to it moves both fingerprint parts.
 */
function decodeLatestPullRequest(
  node: unknown,
): { headOwner: string | null; pullRequest: SweptPullRequest } | null {
  const identity = decodeIdentity(node);
  if (!identity || identity.pullRequest.state === 'open') return null;
  const { pullRequest } = identity;
  return {
    headOwner: identity.headOwner,
    pullRequest: {
      ...pullRequest,
      checksInFlight: false,
      fingerprint: {
        status: JSON.stringify([
          pullRequest.state,
          pullRequest.isDraft,
          pullRequest.headSha,
          pullRequest.baseRefName,
          pullRequest.updatedAt,
          pullRequest.mergedAt,
        ]),
        remarks: JSON.stringify([pullRequest.updatedAt]),
      },
    },
  };
}

function erroredAliases(errors: unknown): Set<string> | null {
  const aliases = new Set<string>();
  if (errors === undefined || errors === null) return aliases;
  if (!Array.isArray(errors)) return null;
  for (const error of errors) {
    const path = isRecord(error) ? error.path : undefined;
    const alias =
      Array.isArray(path) && path[0] === 'repository'
        ? readString(path[1])
        : null;
    if (alias === null) return null;
    aliases.add(alias);
  }
  return aliases;
}

function matchesOwner(headOwner: string | null, owner: string): boolean {
  return headOwner !== null && headOwner.toLowerCase() === owner.toLowerCase();
}

/**
 * Picks each branch's pull request the way the REST lookup does: the newest
 * open one from the repository owner, else the newest of any state. A newest
 * pull request from another owner (a fork with the same branch name) leaves
 * the branch `unresolved`, since an older one might match.
 */
export function decodePullRequestSweepResponse(
  body: unknown,
  document: PullRequestSweepDocument,
  owner: string,
): Map<string, BranchPullRequestLookup> {
  const data = isRecord(body) ? body.data : undefined;
  const repository = isRecord(data) ? data.repository : undefined;
  const failedAliases = isRecord(body) ? erroredAliases(body.errors) : null;
  if (!isRecord(repository) || failedAliases === null) {
    throw new PullRequestSweepBatchError(
      'GitHub returned no usable repository for the pull request sweep.',
    );
  }
  const lookups = new Map<string, BranchPullRequestLookup>();
  document.branches.forEach((branch, index) => {
    const open = branchAlias(index);
    const latest = latestAlias(index);
    if (failedAliases.has(open) || failedAliases.has(latest)) {
      lookups.set(branch, { kind: 'unresolved' });
      return;
    }
    const openNodes = readNodes(repository[open]);
    const latestNodes = readNodes(repository[latest]);
    if (openNodes === null || latestNodes === null) {
      lookups.set(branch, { kind: 'unresolved' });
      return;
    }
    const openNode: unknown = openNodes[0];
    const latestNode: unknown = latestNodes[0];
    if (openNode === undefined && latestNode === undefined) {
      lookups.set(branch, { kind: 'none' });
      return;
    }
    const decoded =
      openNode !== undefined
        ? decodeOpenPullRequest(openNode)
        : decodeLatestPullRequest(latestNode);
    lookups.set(
      branch,
      decoded && matchesOwner(decoded.headOwner, owner)
        ? { kind: 'found', pullRequest: decoded.pullRequest }
        : { kind: 'unresolved' },
    );
  });
  return lookups;
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

export function isGitHubRateLimitError(
  error: unknown,
): error is GitHubBrokerError {
  return isGitHubBrokerError(error) && error.code === 'rate_limited';
}

/**
 * Look up the pull request for each branch of one repository, one document
 * per chunk. A chunk that fails for any reason but a rate limit leaves its
 * branches `unresolved`; a rate limit rejects so the caller backs off instead
 * of falling back to per-pull-request reads.
 */
export async function fetchPullRequestSweep(
  client: GitHubClient,
  remote: PullRequestSweepRemote,
  branches: readonly string[],
  priority: 'high' | 'normal' = 'normal',
): Promise<Map<string, BranchPullRequestLookup>> {
  const lookups = new Map<string, BranchPullRequestLookup>();
  for (const document of buildPullRequestSweepDocuments(remote, branches)) {
    try {
      const response = await client.enqueue(
        async (
          octokit,
        ): Promise<{
          status: number;
          headers: GitHubHeaders;
          data: unknown;
        }> => {
          const route: string = 'POST /graphql';
          const raw = await octokit.request(route, {
            query: document.query,
            variables: document.variables,
          });
          const body: unknown = raw.data;
          if (isGraphQlRateLimited(body)) {
            throw new GitHubGraphQlRateLimitError(raw.headers);
          }
          return { status: raw.status, headers: raw.headers, data: body };
        },
        priority,
        {
          operation: 'read',
          idempotency: 'safe',
          resource: 'graphql',
          caller: 'pr-poller',
        },
      );
      decodePullRequestSweepResponse(
        response.data,
        document,
        remote.owner,
      ).forEach((lookup, branch) => lookups.set(branch, lookup));
    } catch (error) {
      if (isGitHubRateLimitError(error)) throw error;
      for (const branch of document.branches) {
        lookups.set(branch, { kind: 'unresolved' });
      }
    }
  }
  return lookups;
}

export interface PreviousPullRequestRead {
  number: number;
  fingerprint: PullRequestFingerprint | null;
  checksInFlight: boolean;
  lastFullReadAt: number;
  includesComments: boolean;
}

/**
 * `read` covers detail, checks, and reviews (conditional REST reads);
 * `graphQl` adds the review-thread and merge queue query; `comments` adds the
 * comment and review collections the comment hooks diff.
 */
export interface PullRequestReadPlan {
  read: boolean;
  graphQl: boolean;
  comments: boolean;
  full: boolean;
}

export function planPullRequestRead(args: {
  previous: PreviousPullRequestRead | null;
  current: SweptPullRequest;
  needsComments: boolean;
  now: number;
}): PullRequestReadPlan {
  const { previous, current } = args;
  const full =
    previous === null ||
    previous.number !== current.number ||
    args.now - previous.lastFullReadAt >= PULL_REQUEST_FULL_READ_INTERVAL_MS;
  const statusMoved =
    full || previous?.fingerprint?.status !== current.fingerprint.status;
  const remarksMoved =
    full || previous?.fingerprint?.remarks !== current.fingerprint.remarks;
  const inFlight =
    current.checksInFlight || (previous?.checksInFlight ?? false);
  const moved = statusMoved || remarksMoved;
  const comments =
    args.needsComments &&
    (remarksMoved || !(previous?.includesComments ?? false));
  return {
    read: moved || inFlight || comments,
    graphQl: moved,
    comments,
    full,
  };
}

export interface PullRequestSweptEvent {
  owner: string;
  repo: string;
  number: number;
  fingerprint: PullRequestFingerprint;
  status?: PrStatusData;
}

const sweptListeners = new Set<(event: PullRequestSweptEvent) => void>();

/** Observe every pull request a sweep resolves, for the shared read model. */
export function onPullRequestSwept(
  listener: (event: PullRequestSweptEvent) => void,
): () => void {
  sweptListeners.add(listener);
  return () => {
    sweptListeners.delete(listener);
  };
}

export function emitPullRequestSwept(event: PullRequestSweptEvent): void {
  for (const listener of Array.from(sweptListeners)) {
    try {
      listener(event);
    } catch {
      // A failing observer must not break the sweep.
    }
  }
}
