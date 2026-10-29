import type { PrMergeQueueHistory } from '@canopy/desktop-shared/types/github';
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
const CHECKS_ERROR_PATH = ['repository', 'pullRequest', 'commits'];

const PULL_REQUEST_STATUS_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        state
        merged
        mergedAt
        closedAt
        url
        title
        isDraft
        baseRefName
        headRefName
        headRefOid
        headRepository { nameWithOwner }
        mergeable
        reviewDecision
        mergeCommit { oid }
        isInMergeQueue
        mergeQueueEntry { id enqueuedAt state position }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: ${CHECK_CONTEXTS_PAGE_SIZE}) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, last: ${QUEUE_EVENTS_PAGE_SIZE}) {${QUEUE_EVENTS_FIELDS}
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
  return {
    view: {
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
    },
    watcher,
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
