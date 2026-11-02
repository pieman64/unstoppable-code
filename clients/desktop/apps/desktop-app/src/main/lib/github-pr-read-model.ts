import type { PrMergeQueueHistory } from '@canopy/desktop-shared/types/github';
import type {
  CorePullRequestCheck,
  CorePullRequestState,
} from '@canopy/protocol/canopy-core';
import { isGitHubRepositoryName } from '@canopy/protocol/reference-previews';
import {
  getGitHubBroker,
  GitHubBrokerCredentialResetError,
  GitHubBrokerError,
  isGitHubBrokerError,
  type GitHubBrokerRequestOptions,
  type GitHubRawResponse,
} from './github-broker';
import { GitHubGraphQlRateLimitError } from './github-broker/errors';
import {
  fetchGitHubPullRequest,
  normalizeGitHubPullRequestRead,
  QUEUE_EVENT_ITEM_TYPES,
  QUEUE_EVENTS_FIELDS,
  QUEUE_EVENTS_PAGE_SIZE,
  type GitHubPullRequestFetchResult,
  type GitHubPullRequestRead,
} from './github-broker/pull-requests';
import type { GitHubRequestPriority } from './github-broker/scheduler';
import { onPullRequestSwept } from './github-pr-sweep';

export interface GitHubPullRequestRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubPullRequestChecksSummary {
  state: 'success' | 'failure' | 'pending' | 'none';
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failedNames: string[];
  /** False when GitHub withheld the checks from this credential. */
  available: boolean;
}

export interface GitHubPullRequestStatusView {
  ref: GitHubPullRequestRef;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** `owner/name` the head branch lives in; null when that fork is gone. */
  headRepository: string | null;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: GitHubPullRequestChecksSummary;
  mergeQueue: { inQueue: boolean; position: number | null };
  fetchedAt: string;
}

/**
 * What a read adds for the canonical `core.pullRequest.*` projection, beside
 * the view: GitHub's own values, with continuations while checks or review
 * threads have pages left. Kept apart from the view, so the view's callers
 * see exactly what they saw before.
 */
export interface GitHubPullRequestDetail {
  /** GitHub's title, unnormalized. */
  readonly title: string;
  /** Empty when GitHub has none. */
  readonly body: string;
  readonly baseSha: string | null;
  readonly updatedAt: string;
  readonly commentCount: number;
  readonly checks: readonly CorePullRequestCheck[];
  /** GitHub's continuation past `checks`; `null` once every context is read. */
  readonly checksAfter: string | null;
  readonly reviewThreadCount: number;
  readonly unresolvedReviewThreadCount: number;
  /** GitHub's continuation past the counted threads; `null` once all are. */
  readonly reviewThreadsAfter: string | null;
}

/** A view with its detail, every check and thread read. */
export interface GitHubPullRequestProjection {
  readonly view: GitHubPullRequestStatusView;
  readonly detail: GitHubPullRequestDetail;
}

export interface GitHubPullRequestStatusOptions {
  priority?: GitHubRequestPriority;
  signal?: AbortSignal;
  maxAgeMs?: number;
  /** Spend-summary label for the broker. */
  caller?: string;
}

export interface GitHubPullRequestWatcherReadOptions {
  repository: string;
  number: number;
  priority: 'interactive' | 'watcher';
  signal?: AbortSignal;
  /** Filtered timeline index the caller still needs; omit for the newest page. */
  queueHistoryFrom?: number;
  maxAgeMs?: number;
  /** Spend-summary label for the broker. */
  caller?: string;
}

export const GITHUB_PULL_REQUEST_PENDING_CHECKS_TTL_MS = 15_000;
export const GITHUB_PULL_REQUEST_TTL_MS = 60_000;
export const GITHUB_PULL_REQUEST_MERGED_TTL_MS = 10 * 60_000;
/** Newest a watcher read accepts from the cache, so watchers stay close to live. */
export const GITHUB_PULL_REQUEST_WATCHER_MAX_AGE_MS = 15_000;

const READ_TIMEOUT_MS = 20_000;
const MAX_ENTRIES = 500;
const MAX_TITLE_LENGTH = 1_024;
const MAX_REF_NAME_LENGTH = 255;
const MAX_REPOSITORY_NAME_LENGTH = 201;
const MAX_CHECK_NAME_LENGTH = 200;
const MAX_FAILED_NAMES = 20;
const CHECK_CONTEXTS_PAGE_SIZE = 100;
const REVIEW_THREADS_PAGE_SIZE = 100;
// Follow-up pages per list, so a pathological pull request cannot loop.
const MAX_FOLLOW_UP_PAGES = 50;
const CHECKS_ERROR_PATH = ['repository', 'pullRequest', 'commits'];

const CHECK_CONTEXT_FIELDS = `
                    __typename
                    ... on CheckRun { id name status conclusion detailsUrl completedAt }
                    ... on StatusContext { id context state targetUrl createdAt }`;

// One pull request's fields: the shared status view's, plus the canonical
// `core.pullRequest.*` projection's (body, base commit, update time, check
// context ids, URLs and times, thread and comment counts) with continuations
// for checks and review threads past their first page.
const PULL_REQUEST_FIELDS = `
        id
        number
        state
        merged
        mergedAt
        closedAt
        updatedAt
        url
        title
        body
        isDraft
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        headRepository { nameWithOwner }
        mergeable
        reviewDecision
        mergeCommit { oid }
        isInMergeQueue
        mergeQueueEntry { id enqueuedAt state position }
        comments { totalCount }
        reviewThreads(first: ${REVIEW_THREADS_PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { isResolved }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: ${CHECK_CONTEXTS_PAGE_SIZE}) {
                  totalCount
                  pageInfo { hasNextPage endCursor }
                  nodes {${CHECK_CONTEXT_FIELDS}
                  }
                }
              }
            }
          }
        }`;

const PULL_REQUEST_STATUS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {${PULL_REQUEST_FIELDS}
        queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, last: ${QUEUE_EVENTS_PAGE_SIZE}) {${QUEUE_EVENTS_FIELDS}
        }
      }
    }
  }
`;

const PULL_REQUEST_LIST_QUERY = `
  query ($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: $states, first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes {${PULL_REQUEST_FIELDS}
        }
      }
    }
  }
`;

const CHECK_CONTEXTS_PAGE_QUERY = `
  query ($owner: String!, $name: String!, $oid: GitObjectID!, $after: String!) {
    repository(owner: $owner, name: $name) {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup {
            contexts(first: ${CHECK_CONTEXTS_PAGE_SIZE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {${CHECK_CONTEXT_FIELDS}
              }
            }
          }
        }
      }
    }
  }
`;

const REVIEW_THREADS_PAGE_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: ${REVIEW_THREADS_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved }
        }
      }
    }
  }
`;

interface PullRequestRecord {
  view: GitHubPullRequestStatusView;
  /** Absent for seeded views, which carry no lifecycle times or timeline. */
  watcher?: GitHubPullRequestRead;
}

interface CacheEntry {
  view: GitHubPullRequestStatusView;
  viewAtMs: number;
  watcher?: { read: GitHubPullRequestRead; atMs: number };
}

interface InFlightRead {
  key: string;
  rank: number;
  controller: AbortController;
  promise: Promise<PullRequestRecord>;
  subscribers: number;
  settled: boolean;
  stale: boolean;
}

const PRIORITY_RANK: Record<GitHubRequestPriority, number> = {
  background: 0,
  watcher: 1,
  interactive: 2,
};

let generation = 0;
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightRead>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cacheKey(ref: GitHubPullRequestRef): string {
  return `${generation}:${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

function isRepositoryName(owner: unknown, repo: unknown): boolean {
  return (
    typeof owner === 'string' &&
    typeof repo === 'string' &&
    isGitHubRepositoryName(owner.toLowerCase(), repo.toLowerCase())
  );
}

function assertValidRef(ref: GitHubPullRequestRef): void {
  if (
    !isRepositoryName(ref.owner, ref.repo) ||
    !Number.isSafeInteger(ref.number) ||
    ref.number <= 0
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub pull request request was malformed.',
    );
  }
}

function cancelledError(): GitHubBrokerError {
  return new GitHubBrokerError('cancelled', 'GitHub request was cancelled.');
}

/** How long a view stays fresh: merged PRs cannot change, pending checks do. */
export function githubPullRequestTtlMs(
  view: Pick<GitHubPullRequestStatusView, 'state' | 'checks'>,
): number {
  if (view.state === 'merged') return GITHUB_PULL_REQUEST_MERGED_TTL_MS;
  if (view.state === 'open' && view.checks.state === 'pending') {
    return GITHUB_PULL_REQUEST_PENDING_CHECKS_TTL_MS;
  }
  return GITHUB_PULL_REQUEST_TTL_MS;
}

function allowedAgeMs(
  view: GitHubPullRequestStatusView,
  maxAgeMs: number | undefined,
): number {
  const ttl = githubPullRequestTtlMs(view);
  return typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs)
    ? Math.min(ttl, Math.max(0, maxAgeMs))
    : ttl;
}

function isFresh(atMs: number, allowedMs: number, now: number): boolean {
  return now - atMs <= allowedMs;
}

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function storeRecord(key: string, record: PullRequestRecord): void {
  const atMs = Date.parse(record.view.fetchedAt);
  const existing = cache.get(key);
  const entry: CacheEntry =
    existing && existing.viewAtMs > atMs
      ? existing
      : { ...existing, view: record.view, viewAtMs: atMs };
  if (record.watcher && (!existing?.watcher || existing.watcher.atMs <= atMs)) {
    entry.watcher = { read: record.watcher, atMs };
  }
  touch(key, entry);
}

function bumpGeneration(): void {
  generation += 1;
  cache.clear();
  for (const read of Array.from(inFlight.values())) read.stale = true;
  inFlight.clear();
}

function isCredentialFailure(error: unknown): boolean {
  return (
    error instanceof GitHubBrokerCredentialResetError ||
    (isGitHubBrokerError(error) && error.code === 'not_authenticated')
  );
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : null;
}

function viewTitle(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
    : '';
}

function headRepositoryName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = boundedString(value.nameWithOwner, MAX_REPOSITORY_NAME_LENGTH);
  if (!name) return null;
  const [owner, repo, extra] = name.split('/');
  return extra === undefined && isRepositoryName(owner, repo) ? name : null;
}

function toMergeable(value: unknown): GitHubPullRequestStatusView['mergeable'] {
  if (value === 'MERGEABLE') return 'mergeable';
  if (value === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

function toReviewDecision(
  value: unknown,
): GitHubPullRequestStatusView['reviewDecision'] {
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'REVIEW_REQUIRED') return 'review_required';
  return null;
}

type CheckOutcome = 'passed' | 'failed' | 'pending';

const PASSED_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

function checkOutcome(
  node: Record<string, unknown>,
): { outcome: CheckOutcome; name: string | null } | null {
  if (node.__typename === 'CheckRun') {
    const name = boundedString(node.name, MAX_CHECK_NAME_LENGTH);
    if (node.status !== 'COMPLETED') return { outcome: 'pending', name };
    return {
      outcome:
        typeof node.conclusion === 'string' &&
        PASSED_CHECK_CONCLUSIONS.has(node.conclusion)
          ? 'passed'
          : 'failed',
      name,
    };
  }
  if (node.__typename === 'StatusContext') {
    const name = boundedString(node.context, MAX_CHECK_NAME_LENGTH);
    if (node.state === 'SUCCESS') return { outcome: 'passed', name };
    if (node.state === 'PENDING' || node.state === 'EXPECTED') {
      return { outcome: 'pending', name };
    }
    return { outcome: 'failed', name };
  }
  return null;
}

function rollupState(
  value: unknown,
): GitHubPullRequestChecksSummary['state'] | null {
  if (value === 'SUCCESS') return 'success';
  if (value === 'FAILURE' || value === 'ERROR') return 'failure';
  if (value === 'PENDING' || value === 'EXPECTED') return 'pending';
  return null;
}

function noChecks(available: boolean): GitHubPullRequestChecksSummary {
  return {
    state: 'none',
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    failedNames: [],
    available,
  };
}

/** Head commit checks; counts cover the first page of contexts. */
function checksSummary(
  pullRequest: Record<string, unknown>,
  available: boolean,
): GitHubPullRequestChecksSummary {
  if (!available) return noChecks(false);
  const commits = isRecord(pullRequest.commits) ? pullRequest.commits : null;
  const nodes = Array.isArray(commits?.nodes) ? commits.nodes : [];
  const head: unknown = nodes[nodes.length - 1];
  const commit = isRecord(head) && isRecord(head.commit) ? head.commit : null;
  const rollup =
    commit && isRecord(commit.statusCheckRollup)
      ? commit.statusCheckRollup
      : null;
  if (!rollup) return noChecks(true);
  const contexts = isRecord(rollup.contexts) ? rollup.contexts : null;
  const contextNodes = Array.isArray(contexts?.nodes) ? contexts.nodes : [];
  const counts: Record<CheckOutcome, number> = {
    passed: 0,
    failed: 0,
    pending: 0,
  };
  const failedNames: string[] = [];
  for (const node of contextNodes) {
    const check = isRecord(node) ? checkOutcome(node) : null;
    if (!check) continue;
    counts[check.outcome] += 1;
    if (
      check.outcome === 'failed' &&
      check.name &&
      failedNames.length < MAX_FAILED_NAMES &&
      !failedNames.includes(check.name)
    ) {
      failedNames.push(check.name);
    }
  }
  const counted = counts.passed + counts.failed + counts.pending;
  const totalCount = contexts?.totalCount;
  const total =
    typeof totalCount === 'number' &&
    Number.isSafeInteger(totalCount) &&
    totalCount >= counted
      ? totalCount
      : counted;
  const derived: GitHubPullRequestChecksSummary['state'] =
    counts.failed > 0
      ? 'failure'
      : counts.pending > 0
        ? 'pending'
        : counts.passed > 0
          ? 'success'
          : 'none';
  return {
    state: rollupState(rollup.state) ?? derived,
    total,
    ...counts,
    failedNames,
    available: true,
  };
}

function isChecksError(error: unknown): boolean {
  if (!isRecord(error) || !Array.isArray(error.path)) return false;
  const path: unknown[] = error.path;
  return CHECKS_ERROR_PATH.every((segment, index) => path[index] === segment);
}

/**
 * Drop GraphQL errors confined to the head commit's checks, which a token
 * without checks access gets, so the lifecycle read still classifies cleanly.
 */
function withoutChecksErrors(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  checksAvailable: boolean;
} {
  const { errors } = body;
  if (!Array.isArray(errors) || !errors.some(isChecksError)) {
    return { body, checksAvailable: true };
  }
  const remaining = errors.filter((error: unknown) => !isChecksError(error));
  const rest = Object.fromEntries(
    Object.entries(body).filter(([field]) => field !== 'errors'),
  );
  return {
    body: remaining.length > 0 ? { ...rest, errors: remaining } : rest,
    checksAvailable: false,
  };
}

const CHECK_RUN_STATUSES: Readonly<
  Record<string, CorePullRequestCheck['status']>
> = {
  QUEUED: 'queued',
  WAITING: 'queued',
  PENDING: 'queued',
  REQUESTED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
};

const CHECK_RUN_CONCLUSIONS: Readonly<
  Record<string, NonNullable<CorePullRequestCheck['conclusion']>>
> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  ACTION_REQUIRED: 'action_required',
  NEUTRAL: 'neutral',
  SKIPPED: 'skipped',
  STALE: 'neutral',
  STARTUP_FAILURE: 'failure',
};

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function checkRunRow(
  node: Record<string, unknown>,
  checkId: string,
): CorePullRequestCheck | null {
  if (typeof node.name !== 'string') return null;
  // A status GitHub adds later reads as queued: never as completed.
  const status =
    (typeof node.status === 'string'
      ? CHECK_RUN_STATUSES[node.status]
      : undefined) ?? 'queued';
  const completed = status === 'completed';
  const conclusion =
    completed && typeof node.conclusion === 'string'
      ? (CHECK_RUN_CONCLUSIONS[node.conclusion] ?? null)
      : null;
  return {
    checkId,
    name: node.name,
    status,
    conclusion,
    url: nullableString(node.detailsUrl),
    completedAt: completed ? nullableString(node.completedAt) : null,
  };
}

function statusContextRow(
  node: Record<string, unknown>,
  checkId: string,
): CorePullRequestCheck | null {
  if (typeof node.context !== 'string') return null;
  const pending = node.state === 'PENDING' || node.state === 'EXPECTED';
  if (pending)
    return {
      checkId,
      name: node.context,
      status: 'queued',
      conclusion: null,
      url: nullableString(node.targetUrl),
      completedAt: null,
    };
  return {
    checkId,
    name: node.context,
    status: 'completed',
    conclusion: node.state === 'SUCCESS' ? 'success' : 'failure',
    url: nullableString(node.targetUrl),
    completedAt: nullableString(node.createdAt),
  };
}

/** One status rollup context as a canonical check row; `null` when malformed. */
function checkRow(node: unknown): CorePullRequestCheck | null {
  if (!isRecord(node) || typeof node.id !== 'string' || node.id === '')
    return null;
  if (node.__typename === 'CheckRun') return checkRunRow(node, node.id);
  if (node.__typename === 'StatusContext')
    return statusContextRow(node, node.id);
  return null;
}

/** A connection's page: rows, and the continuation while pages remain. */
function connectionPage<T>(
  connection: unknown,
  row: (node: unknown) => T | null,
): { rows: T[]; after: string | null } | null {
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) return null;
  const rows: T[] = [];
  for (const node of connection.nodes) {
    const mapped = row(node);
    if (mapped === null) return null;
    rows.push(mapped);
  }
  const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : null;
  if (!pageInfo || typeof pageInfo.hasNextPage !== 'boolean') return null;
  if (!pageInfo.hasNextPage) return { rows, after: null };
  const after = nullableString(pageInfo.endCursor);
  return after === null ? null : { rows, after };
}

function headRollupContexts(pullRequest: Record<string, unknown>): unknown {
  const commits = isRecord(pullRequest.commits) ? pullRequest.commits : null;
  const nodes = Array.isArray(commits?.nodes) ? commits.nodes : [];
  const head: unknown = nodes[nodes.length - 1];
  const commit = isRecord(head) && isRecord(head.commit) ? head.commit : null;
  const rollup =
    commit && isRecord(commit.statusCheckRollup)
      ? commit.statusCheckRollup
      : null;
  return rollup ? rollup.contexts : undefined;
}

function threadResolution(node: unknown): { resolved: boolean } | null {
  return isRecord(node) && typeof node.isResolved === 'boolean'
    ? { resolved: node.isResolved }
    : null;
}

/**
 * The canonical detail of one pull request's fields, or `null` when GitHub
 * omitted any of them: a partial read never fills placeholder values.
 */
function pullRequestDetail(
  pullRequest: Record<string, unknown>,
  checksAvailable: boolean,
): GitHubPullRequestDetail | null {
  const updatedAt = nullableString(pullRequest.updatedAt);
  const comments = isRecord(pullRequest.comments)
    ? count(pullRequest.comments.totalCount)
    : null;
  const threads = isRecord(pullRequest.reviewThreads)
    ? pullRequest.reviewThreads
    : null;
  const threadCount = threads ? count(threads.totalCount) : null;
  const threadPage = connectionPage(threads, threadResolution);
  const { title, body, baseRefOid } = pullRequest;
  if (
    updatedAt === null ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    comments === null ||
    threadCount === null ||
    threadPage === null ||
    typeof title !== 'string' ||
    !(typeof body === 'string' || body === null) ||
    !(typeof baseRefOid === 'string' || baseRefOid === null)
  )
    return null;
  let checks: { rows: CorePullRequestCheck[]; after: string | null } = {
    rows: [],
    after: null,
  };
  // Withheld checks, or a head commit without a rollup, list none.
  const contexts = checksAvailable
    ? headRollupContexts(pullRequest)
    : undefined;
  if (contexts !== undefined) {
    const page = connectionPage(contexts, checkRow);
    if (page === null) return null;
    checks = page;
  }
  return {
    title,
    body: body ?? '',
    baseSha: nullableString(baseRefOid),
    updatedAt,
    commentCount: comments,
    checks: checks.rows,
    checksAfter: checks.after,
    reviewThreadCount: threadCount,
    unresolvedReviewThreadCount: threadPage.rows.filter(
      (thread) => !thread.resolved,
    ).length,
    reviewThreadsAfter: threadPage.after,
  };
}

// The detail each read produced, keyed by its view, so views stay exactly
// what their callers saw before; a seeded view has none.
const detailByView = new WeakMap<
  GitHubPullRequestStatusView,
  GitHubPullRequestDetail
>();

/** The canonical detail the read behind this view produced, if any. */
export function githubPullRequestDetailOf(
  view: GitHubPullRequestStatusView,
): GitHubPullRequestDetail | undefined {
  return detailByView.get(view);
}

/** Whether every check and review thread of the detail has been read. */
export function isCompleteGitHubPullRequestDetail(
  detail: GitHubPullRequestDetail,
): boolean {
  return detail.checksAfter === null && detail.reviewThreadsAfter === null;
}

/**
 * Map one status query body to the shared view and the watcher's read. The
 * lifecycle fields classify exactly as {@link normalizeGitHubPullRequestRead}
 * does; view-only fields fall back to neutral values when absent.
 */
export function normalizeGitHubPullRequestStatus(
  body: unknown,
  ref: GitHubPullRequestRef,
  observedAt = new Date().toISOString(),
): { view: GitHubPullRequestStatusView; watcher: GitHubPullRequestRead } {
  const filtered = isRecord(body)
    ? withoutChecksErrors(body)
    : { body, checksAvailable: true };
  const watcher = normalizeGitHubPullRequestRead(
    filtered.body,
    ref.number,
    observedAt,
  );
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const repository = data && isRecord(data.repository) ? data.repository : null;
  const pullRequest =
    repository && isRecord(repository.pullRequest)
      ? repository.pullRequest
      : {};
  const { snapshot } = watcher;
  const view: GitHubPullRequestStatusView = {
    ref: { owner: ref.owner, repo: ref.repo, number: ref.number },
    url: snapshot.url,
    title: viewTitle(pullRequest.title),
    state: snapshot.state,
    isDraft: pullRequest.isDraft === true,
    headBranch:
      boundedString(pullRequest.headRefName, MAX_REF_NAME_LENGTH) ?? '',
    baseBranch: snapshot.baseRefName,
    headSha: snapshot.headSha,
    headRepository: headRepositoryName(pullRequest.headRepository),
    mergeable: toMergeable(pullRequest.mergeable),
    reviewDecision: toReviewDecision(pullRequest.reviewDecision),
    checks: checksSummary(pullRequest, filtered.checksAvailable),
    mergeQueue: {
      inQueue: snapshot.queue !== null,
      position: snapshot.queue?.position ?? null,
    },
    fetchedAt: observedAt,
  };
  const detail = pullRequestDetail(pullRequest, filtered.checksAvailable);
  if (detail) detailByView.set(view, detail);
  return { view, watcher };
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

function statusReadOptions(
  priority: GitHubRequestPriority,
  signal: AbortSignal,
  caller: string | undefined,
): GitHubBrokerRequestOptions<PullRequestRecord> {
  return {
    priority,
    operation: 'read',
    idempotency: 'safe',
    timeoutMs: READ_TIMEOUT_MS,
    signal,
    resource: 'graphql',
    ...(caller ? { caller } : {}),
  };
}

async function fetchRecord(
  ref: GitHubPullRequestRef,
  priority: GitHubRequestPriority,
  signal: AbortSignal,
  caller: string | undefined,
): Promise<PullRequestRecord> {
  const result = await getGitHubBroker().execute<PullRequestRecord>(
    async (octokit): Promise<GitHubRawResponse<PullRequestRecord>> => {
      const route: string = 'POST /graphql';
      const response = await octokit.request(route, {
        query: PULL_REQUEST_STATUS_QUERY,
        variables: { owner: ref.owner, name: ref.repo, number: ref.number },
      });
      const body: unknown = response.data;
      if (isGraphQlRateLimited(body)) {
        throw new GitHubGraphQlRateLimitError(response.headers);
      }
      return {
        status: response.status,
        headers: response.headers,
        data: normalizeGitHubPullRequestStatus(body, ref),
      };
    },
    statusReadOptions(priority, signal, caller),
  );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub pull request read returned a mutation result.',
    );
  }
  return result.data;
}

function startRead(
  key: string,
  ref: GitHubPullRequestRef,
  priority: GitHubRequestPriority,
  caller: string | undefined,
): InFlightRead {
  const controller = new AbortController();
  const startedGeneration = generation;
  const read: InFlightRead = {
    key,
    rank: PRIORITY_RANK[priority],
    controller,
    subscribers: 0,
    settled: false,
    stale: false,
    promise: fetchRecord(ref, priority, controller.signal, caller),
  };
  read.promise = read.promise.then(
    (record) => {
      read.settled = true;
      if (inFlight.get(key) === read) inFlight.delete(key);
      if (!read.stale && startedGeneration === generation) {
        storeRecord(key, record);
      }
      return record;
    },
    (error: unknown) => {
      read.settled = true;
      if (inFlight.get(key) === read) inFlight.delete(key);
      if (startedGeneration === generation && isCredentialFailure(error)) {
        bumpGeneration();
      }
      throw error;
    },
  );
  read.promise.catch(() => undefined);
  inFlight.set(key, read);
  return read;
}

/** Join a shared read; each caller keeps its own cancellation. */
function joinRead(
  read: InFlightRead,
  signal: AbortSignal | undefined,
): Promise<PullRequestRecord> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  read.subscribers += 1;
  return new Promise<PullRequestRecord>((resolve, reject) => {
    let done = false;
    const leave = (): void => {
      done = true;
      signal?.removeEventListener('abort', onAbort);
      read.subscribers -= 1;
      if (read.subscribers === 0 && !read.settled) {
        read.stale = true;
        if (inFlight.get(read.key) === read) inFlight.delete(read.key);
        read.controller.abort(cancelledError());
      }
    };
    const onAbort = (): void => {
      if (done) return;
      leave();
      reject(cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    read.promise.then(
      (record) => {
        if (done) return;
        leave();
        resolve(record);
      },
      (error: unknown) => {
        if (done) return;
        leave();
        reject(
          error instanceof Error
            ? error
            : new GitHubBrokerError(
                'network',
                'GitHub request failed without an Error response.',
                { retriable: true },
              ),
        );
      },
    );
  });
}

function sharedRead(
  ref: GitHubPullRequestRef,
  priority: GitHubRequestPriority,
  signal: AbortSignal | undefined,
  caller?: string,
): Promise<PullRequestRecord> {
  const key = cacheKey(ref);
  const existing = inFlight.get(key);
  const read =
    existing && existing.rank >= PRIORITY_RANK[priority]
      ? existing
      : startRead(key, ref, priority, caller);
  return joinRead(read, signal);
}

/**
 * One pull request's status from the shared read model. A cached view
 * younger than its state's TTL (and `maxAgeMs`, when given) answers without
 * a request; otherwise concurrent callers share one GraphQL read through the
 * broker at the highest priority among them.
 */
export async function getGitHubPullRequestStatus(
  ref: GitHubPullRequestRef,
  options: GitHubPullRequestStatusOptions = {},
): Promise<GitHubPullRequestStatusView> {
  assertValidRef(ref);
  if (options.signal?.aborted) throw cancelledError();
  const key = cacheKey(ref);
  const cached = cache.get(key);
  if (
    cached &&
    isFresh(
      cached.viewAtMs,
      allowedAgeMs(cached.view, options.maxAgeMs),
      Date.now(),
    )
  ) {
    touch(key, cached);
    return cached.view;
  }
  const record = await sharedRead(
    ref,
    options.priority ?? 'interactive',
    options.signal,
    options.caller,
  );
  return record.view;
}

export interface GitHubPullRequestProjectionOptions {
  /** `true` reads GitHub; `false` may answer from a fresh cached read. */
  refresh: boolean;
  signal?: AbortSignal;
  /** Spend-summary label for the broker. */
  caller?: string;
}

interface GraphQlReadOptions {
  priority: GitHubRequestPriority;
  signal?: AbortSignal;
  caller?: string;
}

function malformedRead(message: string): GitHubBrokerError {
  return new GitHubBrokerError('invalid_response', message);
}

/** One GraphQL read through the broker, mapped while the response is held. */
async function graphQlRead<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GraphQlReadOptions,
  map: (body: unknown) => T,
): Promise<T> {
  const result = await getGitHubBroker().execute<T>(
    async (octokit): Promise<GitHubRawResponse<T>> => {
      const route: string = 'POST /graphql';
      const response = await octokit.request(route, { query, variables });
      const body: unknown = response.data;
      if (isGraphQlRateLimited(body)) {
        throw new GitHubGraphQlRateLimitError(response.headers);
      }
      return {
        status: response.status,
        headers: response.headers,
        data: map(body),
      };
    },
    {
      priority: options.priority,
      operation: 'read',
      idempotency: 'safe',
      timeoutMs: READ_TIMEOUT_MS,
      resource: 'graphql',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.caller ? { caller: options.caller } : {}),
    },
  );
  if (result.kind !== 'read') {
    throw malformedRead('GitHub pull request read returned a mutation result.');
  }
  return result.data;
}

/** A follow-up page's data; any GraphQL error fails the whole projection. */
function followUpData(body: unknown): Record<string, unknown> {
  if (
    !isRecord(body) ||
    (body.errors !== undefined &&
      (!Array.isArray(body.errors) || body.errors.length > 0)) ||
    !isRecord(body.data)
  ) {
    throw malformedRead('GitHub returned errors for a pull request page.');
  }
  return body.data;
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Reads the check and review-thread pages past the first, so the detail
 * lists every check of the head commit and counts every unresolved thread.
 */
async function completeDetail(
  ref: GitHubPullRequestRef,
  view: GitHubPullRequestStatusView,
  detail: GitHubPullRequestDetail,
  options: GraphQlReadOptions,
): Promise<GitHubPullRequestDetail> {
  if (isCompleteGitHubPullRequestDetail(detail)) return detail;
  const checks = [...detail.checks];
  let checksAfter = detail.checksAfter;
  for (let pages = 0; checksAfter !== null; pages += 1) {
    if (pages >= MAX_FOLLOW_UP_PAGES || !view.headSha)
      throw malformedRead('GitHub reported more checks than the host reads.');
    const page = await graphQlRead(
      CHECK_CONTEXTS_PAGE_QUERY,
      {
        owner: ref.owner,
        name: ref.repo,
        oid: view.headSha,
        after: checksAfter,
      },
      options,
      (body) =>
        connectionPage(
          nested(
            followUpData(body),
            'repository',
            'object',
            'statusCheckRollup',
            'contexts',
          ),
          checkRow,
        ),
    );
    if (!page) throw malformedRead('GitHub returned a malformed checks page.');
    checks.push(...page.rows);
    checksAfter = page.after;
  }
  let unresolved = detail.unresolvedReviewThreadCount;
  let threadsAfter = detail.reviewThreadsAfter;
  for (let pages = 0; threadsAfter !== null; pages += 1) {
    if (pages >= MAX_FOLLOW_UP_PAGES)
      throw malformedRead(
        'GitHub reported more review threads than the host reads.',
      );
    const page = await graphQlRead(
      REVIEW_THREADS_PAGE_QUERY,
      {
        owner: ref.owner,
        name: ref.repo,
        number: ref.number,
        after: threadsAfter,
      },
      options,
      (body) =>
        connectionPage(
          nested(
            followUpData(body),
            'repository',
            'pullRequest',
            'reviewThreads',
          ),
          threadResolution,
        ),
    );
    if (!page)
      throw malformedRead('GitHub returned a malformed review threads page.');
    unresolved += page.rows.filter((thread) => !thread.resolved).length;
    threadsAfter = page.after;
  }
  return {
    ...detail,
    checks,
    checksAfter: null,
    unresolvedReviewThreadCount: unresolved,
    reviewThreadsAfter: null,
  };
}

/**
 * One pull request for `core.pullRequest.get`: the shared read model's view
 * and its detail, every check and review thread read. With `refresh` false a
 * fresh cached read that carries detail answers; otherwise it joins or starts
 * the shared read, as {@link getGitHubPullRequestStatus} does.
 */
export async function readGitHubPullRequestProjection(
  ref: GitHubPullRequestRef,
  options: GitHubPullRequestProjectionOptions,
): Promise<GitHubPullRequestProjection> {
  assertValidRef(ref);
  if (options.signal?.aborted) throw cancelledError();
  const key = cacheKey(ref);
  const cached = cache.get(key);
  let view: GitHubPullRequestStatusView | undefined;
  if (
    !options.refresh &&
    cached &&
    detailByView.has(cached.view) &&
    isFresh(cached.viewAtMs, githubPullRequestTtlMs(cached.view), Date.now())
  ) {
    touch(key, cached);
    view = cached.view;
  }
  view ??= (
    await sharedRead(ref, 'interactive', options.signal, options.caller)
  ).view;
  const detail = detailByView.get(view);
  if (!detail) {
    throw malformedRead('GitHub omitted pull request projection fields.');
  }
  const complete = await completeDetail(ref, view, detail, {
    priority: 'interactive',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.caller ? { caller: options.caller } : {}),
  });
  if (complete !== detail) detailByView.set(view, complete);
  return { view, detail: complete };
}

const GRAPHQL_STATES: Readonly<Record<CorePullRequestState, string>> = {
  open: 'OPEN',
  closed: 'CLOSED',
  merged: 'MERGED',
};

export interface GitHubPullRequestListPage {
  states: readonly CorePullRequestState[];
  first: number;
  after: string | null;
}

/** Every listed node's errors, rebased onto the single-read path. */
function nodeErrors(body: Record<string, unknown>): {
  byNode: Map<number, unknown[]>;
  other: boolean;
} {
  const byNode = new Map<number, unknown[]>();
  let other = false;
  const errors: unknown[] = Array.isArray(body.errors) ? body.errors : [];
  for (const error of errors) {
    const path: unknown[] | null =
      isRecord(error) && Array.isArray(error.path) ? error.path : null;
    const node = path?.[3];
    if (
      isRecord(error) &&
      path &&
      path[0] === 'repository' &&
      path[1] === 'pullRequests' &&
      path[2] === 'nodes' &&
      typeof node === 'number' &&
      path[4] === 'commits'
    ) {
      const rebased: Record<string, unknown> = {
        ...error,
        path: ['repository', 'pullRequest', ...path.slice(4)],
      };
      byNode.set(node, [...(byNode.get(node) ?? []), rebased]);
    } else {
      other = true;
    }
  }
  return { byNode, other };
}

/**
 * One page of a repository's pull requests for `core.pullRequest.list`, each
 * mapped as a single read is, with every check and review thread read. The
 * page is not stored in the shared read model: its views are what this call
 * read, and other readers keep their own reads.
 */
export async function listGitHubPullRequestProjections(
  repository: { owner: string; repo: string },
  page: GitHubPullRequestListPage,
  options: { signal?: AbortSignal; caller?: string },
): Promise<{
  pullRequests: GitHubPullRequestProjection[];
  endCursor: string | null;
}> {
  assertValidRef({ ...repository, number: 1 });
  if (options.signal?.aborted) throw cancelledError();
  const readOptions: GraphQlReadOptions = {
    priority: 'interactive',
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.caller ? { caller: options.caller } : {}),
  };
  const observedAt = new Date().toISOString();
  const listed = await graphQlRead(
    PULL_REQUEST_LIST_QUERY,
    {
      owner: repository.owner,
      name: repository.repo,
      states: page.states.map((state) => GRAPHQL_STATES[state]),
      first: page.first,
      after: page.after,
    },
    readOptions,
    (body) => {
      if (!isRecord(body)) throw malformedRead('GitHub returned no data.');
      const errors = nodeErrors(body);
      const connection = nested(body, 'data', 'repository', 'pullRequests');
      if (nested(body, 'data', 'repository') === null) {
        throw new GitHubBrokerError(
          'not_found',
          'GitHub repository was not found.',
        );
      }
      if (errors.other || !isRecord(connection)) {
        throw malformedRead(
          'GitHub returned errors for the pull request list.',
        );
      }
      const nodes = Array.isArray(connection.nodes) ? connection.nodes : null;
      const pageInfo = isRecord(connection.pageInfo)
        ? connection.pageInfo
        : null;
      if (!nodes || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
        throw malformedRead('GitHub returned a malformed pull request list.');
      }
      const endCursor = pageInfo.hasNextPage
        ? nullableString(pageInfo.endCursor)
        : null;
      if (pageInfo.hasNextPage && endCursor === null) {
        throw malformedRead('GitHub returned a list page without a cursor.');
      }
      return {
        endCursor,
        items: nodes.map((node: unknown, index) => {
          const number = isRecord(node) ? node.number : undefined;
          if (typeof number !== 'number') {
            throw malformedRead(
              'GitHub returned a pull request without a number.',
            );
          }
          const ref = { ...repository, number };
          assertValidRef(ref);
          const nodeErrorList = errors.byNode.get(index);
          const { view } = normalizeGitHubPullRequestStatus(
            {
              data: { repository: { pullRequest: node } },
              ...(nodeErrorList ? { errors: nodeErrorList } : {}),
            },
            ref,
            observedAt,
          );
          const detail = detailByView.get(view);
          if (!detail) {
            throw malformedRead(
              'GitHub omitted pull request projection fields.',
            );
          }
          return { ref, view, detail };
        }),
      };
    },
  );
  const pullRequests: GitHubPullRequestProjection[] = [];
  for (const item of listed.items) {
    const detail = await completeDetail(
      item.ref,
      item.view,
      item.detail,
      readOptions,
    );
    pullRequests.push({ view: item.view, detail });
  }
  return { pullRequests, endCursor: listed.endCursor };
}

function queueHistoryOf(
  read: GitHubPullRequestRead,
  from: number | undefined,
): PrMergeQueueHistory | null {
  const timeline = read.queueTimeline;
  if (!timeline) return { status: 'unavailable' };
  const firstIndex = timeline.filteredCount - timeline.events.length;
  if (
    typeof from === 'number' &&
    Number.isSafeInteger(from) &&
    from >= 0 &&
    from < firstIndex
  ) {
    return null;
  }
  return {
    status: 'complete',
    filteredCount: timeline.filteredCount,
    firstIndex,
    events: timeline.events,
  };
}

/**
 * The pull request watcher's read, served from the shared read model. A
 * cursor older than the newest timeline page falls back to the paged
 * {@link fetchGitHubPullRequest} read, which is fresh by construction.
 */
export async function readGitHubPullRequestForWatcher(
  options: GitHubPullRequestWatcherReadOptions,
): Promise<GitHubPullRequestFetchResult> {
  const [owner = '', repo = '', extra] = options.repository.split('/');
  const ref: GitHubPullRequestRef = {
    owner,
    repo: extra === undefined ? repo : '',
    number: options.number,
  };
  assertValidRef(ref);
  if (options.signal?.aborted) throw cancelledError();
  const key = cacheKey(ref);
  const entry = cache.get(key);
  const allowedMs = Math.min(
    GITHUB_PULL_REQUEST_WATCHER_MAX_AGE_MS,
    Math.max(0, options.maxAgeMs ?? GITHUB_PULL_REQUEST_WATCHER_MAX_AGE_MS),
  );
  let read: GitHubPullRequestRead | undefined;
  if (entry?.watcher && isFresh(entry.watcher.atMs, allowedMs, Date.now())) {
    touch(key, entry);
    read = entry.watcher.read;
  }
  read ??= (
    await sharedRead(ref, options.priority, options.signal, options.caller)
  ).watcher;
  if (!read) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub pull request read returned no lifecycle fields.',
    );
  }
  const queueHistory = queueHistoryOf(read, options.queueHistoryFrom);
  if (queueHistory) return { snapshot: read.snapshot, queueHistory };
  return fetchGitHubPullRequest({
    repository: options.repository,
    number: options.number,
    priority: options.priority,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.caller ? { caller: options.caller } : {}),
    ...(options.queueHistoryFrom === undefined
      ? {}
      : { queueHistoryFrom: options.queueHistoryFrom }),
  });
}

/** Record a view another reader already fetched, unless the cache is newer. */
export function seedGitHubPullRequestStatus(
  view: GitHubPullRequestStatusView,
): void {
  try {
    assertValidRef(view.ref);
  } catch {
    return;
  }
  const fetchedAtMs = Date.parse(view.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return;
  const atMs = Math.min(fetchedAtMs, Date.now());
  const key = cacheKey(view.ref);
  const existing = cache.get(key);
  if (existing && existing.viewAtMs >= atMs) return;
  touch(key, { ...existing, view, viewAtMs: atMs });
}

/** Drop a pull request's cached status, and keep an older read from refilling it. */
export function invalidateGitHubPullRequest(ref: GitHubPullRequestRef): void {
  const key = cacheKey(ref);
  cache.delete(key);
  const read = inFlight.get(key);
  if (read) {
    read.stale = true;
    inFlight.delete(key);
  }
}

const sweptFingerprints = new Map<string, string>();

onPullRequestSwept((event) => {
  const ref = { owner: event.owner, repo: event.repo, number: event.number };
  const key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  const fingerprint = `${event.fingerprint.status}\n${event.fingerprint.remarks}`;
  const previous = sweptFingerprints.get(key);
  sweptFingerprints.delete(key);
  sweptFingerprints.set(key, fingerprint);
  while (sweptFingerprints.size > MAX_ENTRIES) {
    const oldest = sweptFingerprints.keys().next().value;
    if (oldest === undefined) break;
    sweptFingerprints.delete(oldest);
  }
  if (previous !== undefined && previous !== fingerprint) {
    invalidateGitHubPullRequest(ref);
  }
});

/** Forget every cached status; call when GitHub credentials change. */
export function resetGitHubPullRequestReadModel(): void {
  bumpGeneration();
}
