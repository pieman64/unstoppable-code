import type { GitHubPullRequestSnapshot } from '@canopy/desktop-shared/types/github-watchers';
import {
  toPrMergeQueuePhase,
  type PrMergeQueueHistory,
  type PrMergeQueueTimelineEvent,
} from '@canopy/desktop-shared/types/github';
import {
  getGitHubBroker,
  GitHubBrokerError,
  type GitHubRawResponse,
} from './index';
import { GitHubGraphQlRateLimitError } from './errors';

export interface GitHubPullRequestFetchResult {
  snapshot: GitHubPullRequestSnapshot;
  queueHistory: PrMergeQueueHistory;
}

/** One normalized read; `queueTimeline` is null when the timeline is unusable. */
export interface GitHubPullRequestRead {
  snapshot: GitHubPullRequestSnapshot;
  queueTimeline: GitHubQueueTimelinePage | null;
}

/** Filtered timeline indices `[filteredCount - events.length, filteredCount)`. */
export interface GitHubQueueTimelinePage {
  filteredCount: number;
  startCursor: string | null;
  events: PrMergeQueueTimelineEvent[];
}

export const QUEUE_EVENTS_PAGE_SIZE = 10;
const QUEUE_HISTORY_PAGE_SIZE = 50;
const MAX_QUEUE_HISTORY_PAGES = 2;

export const QUEUE_EVENT_ITEM_TYPES =
  '[ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]';

export const QUEUE_EVENTS_FIELDS = `
          filteredCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { id createdAt }
            ... on RemovedFromMergeQueueEvent { id createdAt reason }
          }`;

const WATCHED_PULL_REQUEST_QUERY = `
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
        baseRefName
        headRefOid
        mergeCommit { oid }
        isInMergeQueue
        mergeQueueEntry { id enqueuedAt state position }
        queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, last: ${QUEUE_EVENTS_PAGE_SIZE}) {${QUEUE_EVENTS_FIELDS}
        }
      }
    }
  }
`;

/** Older merge queue timeline pages; no lifecycle fields. */
const PULL_REQUEST_QUEUE_HISTORY_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $before: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        queueEvents: timelineItems(itemTypes: ${QUEUE_EVENT_ITEM_TYPES}, last: ${QUEUE_HISTORY_PAGE_SIZE}, before: $before) {${QUEUE_EVENTS_FIELDS}
        }
      }
    }
  }
`;

const MAX_PULL_REQUEST_TITLE_LENGTH = 200;
const MAX_PULL_REQUEST_URL_LENGTH = 512;
const MAX_REF_NAME_LENGTH = 255;
const MAX_NODE_ID_LENGTH = 128;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): GitHubBrokerError {
  return new GitHubBrokerError(
    'invalid_response',
    'GitHub pull request response was malformed.',
  );
}

/** Retriable GitHub-side inconsistency; never a terminal observation. */
function incomplete(message: string): GitHubBrokerError {
  return new GitHubBrokerError('server_error', message, { retriable: true });
}

function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function commitShaOrNull(value: unknown): string | null {
  return typeof value === 'string' && COMMIT_SHA_PATTERN.test(value)
    ? value
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : null;
}

function boundedTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = Array.from(value, (character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized
    ? normalized.slice(0, MAX_PULL_REQUEST_TITLE_LENGTH)
    : undefined;
}

/** GitHub's own PR URL; the repository segment may differ after a rename. */
function pullRequestUrl(value: unknown, number: number): string | null {
  if (typeof value !== 'string' || value.length > MAX_PULL_REQUEST_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'github.com' &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.port.length === 0 &&
      new RegExp(`^/[^/]+/[^/]+/pull/${number}$`).test(parsed.pathname)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function graphQlErrorTypes(body: Record<string, unknown>): string[] | null {
  if (body.errors === undefined || body.errors === null) return null;
  if (!Array.isArray(body.errors)) return [''];
  return body.errors.map((error) =>
    isRecord(error) && typeof error.type === 'string' ? error.type : '',
  );
}

const QUEUE_EVENTS_ERROR_PATH = ['repository', 'pullRequest', 'queueEvents'];

/** Every GraphQL error is confined to the merge queue timeline field. */
export function hasOnlyQueueEventsErrors(
  body: Record<string, unknown>,
): boolean {
  const { errors } = body;
  return (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((error: unknown) => {
      if (!isRecord(error) || !Array.isArray(error.path)) return false;
      const path: unknown[] = error.path;
      return QUEUE_EVENTS_ERROR_PATH.every(
        (segment, index) => path[index] === segment,
      );
    })
  );
}

const QUEUE_REMOVAL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_CURSOR_LENGTH = 512;

function queueTimelineEvent(node: unknown): PrMergeQueueTimelineEvent | null {
  if (!isRecord(node)) return null;
  const id = node.id;
  const createdAt = isoTimestampOrNull(node.createdAt);
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAX_NODE_ID_LENGTH ||
    !createdAt
  ) {
    return null;
  }
  if (node.__typename === 'AddedToMergeQueueEvent') {
    return { type: 'added', id, createdAt };
  }
  if (node.__typename !== 'RemovedFromMergeQueueEvent') return null;
  const reason =
    typeof node.reason === 'string' &&
    QUEUE_REMOVAL_REASON_PATTERN.test(node.reason)
      ? node.reason
      : null;
  return { type: 'removed', id, createdAt, reason };
}

/**
 * Parse one `queueEvents` connection read with `last: pageSize`. Returns null
 * for any partial or inconsistent page: indices derive from `filteredCount`,
 * so a short page would misplace every event. `expectedFilteredCount` pins a
 * `before:` page, whose `filteredCount` counts only the items before its
 * cursor.
 */
export function parseQueueTimelinePage(
  connection: unknown,
  pageSize: number,
  expectedFilteredCount?: number,
): GitHubQueueTimelinePage | null {
  if (!isRecord(connection) || !isRecord(connection.pageInfo)) return null;
  const { filteredCount, nodes } = connection;
  const { hasPreviousPage, startCursor } = connection.pageInfo;
  if (
    typeof filteredCount !== 'number' ||
    !Number.isSafeInteger(filteredCount) ||
    filteredCount < 0 ||
    (expectedFilteredCount !== undefined &&
      filteredCount !== expectedFilteredCount) ||
    !Array.isArray(nodes) ||
    nodes.length !== Math.min(pageSize, filteredCount) ||
    hasPreviousPage !== filteredCount > nodes.length
  ) {
    return null;
  }
  let cursor: string | null = null;
  if (startCursor !== null) {
    if (
      typeof startCursor !== 'string' ||
      startCursor.length === 0 ||
      startCursor.length > MAX_CURSOR_LENGTH
    ) {
      return null;
    }
    cursor = startCursor;
  }
  const events: PrMergeQueueTimelineEvent[] = [];
  for (const node of nodes) {
    const event = queueTimelineEvent(node);
    const previous: PrMergeQueueTimelineEvent | undefined =
      events[events.length - 1];
    if (
      !event ||
      (previous && Date.parse(event.createdAt) < Date.parse(previous.createdAt))
    ) {
      return null;
    }
    events.push(event);
  }
  return { filteredCount, startCursor: cursor, events };
}

/** Map one watcher read to its snapshot; see {@link normalizeGitHubPullRequestRead}. */
export function normalizeGitHubPullRequestResponse(
  body: unknown,
  pullRequestNumber: number,
  observedAt = new Date().toISOString(),
): GitHubPullRequestSnapshot {
  return normalizeGitHubPullRequestRead(body, pullRequestNumber, observedAt)
    .snapshot;
}

/**
 * Map one GraphQL response body to a bounded snapshot and its newest merge
 * queue timeline page. A missing pull request is permanent; GraphQL `errors`
 * otherwise (including partial data) and inconsistent terminal fields are
 * retriable, so neither can ever report a merge or close. Errors confined to
 * the timeline, or a partial timeline, only drop the timeline.
 */
export function normalizeGitHubPullRequestRead(
  body: unknown,
  pullRequestNumber: number,
  observedAt = new Date().toISOString(),
): GitHubPullRequestRead {
  if (!isRecord(body)) throw malformed();
  const data = isRecord(body.data) ? body.data : null;
  const repository = data && isRecord(data.repository) ? data.repository : null;
  const pullRequest =
    repository && isRecord(repository.pullRequest)
      ? repository.pullRequest
      : null;
  const errorTypes = graphQlErrorTypes(body);
  if (!pullRequest) {
    if (errorTypes?.includes('FORBIDDEN')) {
      throw new GitHubBrokerError(
        'permission_denied',
        'GitHub pull request is not accessible.',
      );
    }
    if (!errorTypes || errorTypes.includes('NOT_FOUND')) {
      throw new GitHubBrokerError(
        'not_found',
        'GitHub pull request was not found.',
      );
    }
  }
  if (errorTypes) {
    if (errorTypes.includes('RATE_LIMITED')) {
      throw new GitHubBrokerError(
        'rate_limited',
        'GitHub rate limited the pull request read.',
        { retriable: true },
      );
    }
    if (!pullRequest || !hasOnlyQueueEventsErrors(body)) {
      throw incomplete('GitHub returned errors for the pull request read.');
    }
  }
  if (!pullRequest) throw malformed();

  const url = pullRequestUrl(pullRequest.url, pullRequestNumber);
  const baseRefName = boundedString(
    pullRequest.baseRefName,
    MAX_REF_NAME_LENGTH,
  );
  const headSha = commitShaOrNull(pullRequest.headRefOid);
  const rawState = pullRequest.state;
  if (
    !url ||
    !baseRefName ||
    !headSha ||
    (rawState !== 'OPEN' && rawState !== 'CLOSED' && rawState !== 'MERGED')
  ) {
    throw malformed();
  }
  // Both flags are non-null in the schema, and the entry is null or an object;
  // a missing one is a partial read, never "not merged" or "not queued".
  if (
    typeof pullRequest.merged !== 'boolean' ||
    typeof pullRequest.isInMergeQueue !== 'boolean' ||
    !(
      pullRequest.mergeQueueEntry === null ||
      isRecord(pullRequest.mergeQueueEntry)
    )
  ) {
    throw incomplete('GitHub omitted pull request merge or queue fields.');
  }
  // GraphQL reports MERGED exactly when `merged` is true; a mismatch is an
  // inconsistent read, never a merge.
  if ((rawState === 'MERGED') !== pullRequest.merged) {
    throw incomplete('GitHub reported conflicting pull request merge fields.');
  }
  const mergedAt = isoTimestampOrNull(pullRequest.mergedAt);
  const closedAt = isoTimestampOrNull(pullRequest.closedAt);
  const state =
    rawState === 'MERGED'
      ? 'merged'
      : rawState === 'CLOSED'
        ? 'closed'
        : 'open';
  if (state === 'merged' && !mergedAt) {
    throw incomplete('GitHub reported a merge without its merge time.');
  }
  if (state === 'closed' && !closedAt) {
    throw incomplete('GitHub reported a close without its close time.');
  }
  const mergeCommitSha =
    state === 'merged' && isRecord(pullRequest.mergeCommit)
      ? commitShaOrNull(pullRequest.mergeCommit.oid)
      : null;
  if (state === 'merged' && !mergeCommitSha) {
    throw incomplete('GitHub reported a merge without its merge commit.');
  }
  const entry = isRecord(pullRequest.mergeQueueEntry)
    ? pullRequest.mergeQueueEntry
    : null;
  const position = entry?.position;
  const title = boundedTitle(pullRequest.title);
  const snapshot: GitHubPullRequestSnapshot = {
    state,
    url,
    ...(title ? { title } : {}),
    baseRefName,
    headSha,
    mergedAt: state === 'merged' ? mergedAt : null,
    mergeCommitSha,
    closedAt,
    queue:
      entry || pullRequest.isInMergeQueue
        ? {
            entryId: boundedString(entry?.id, MAX_NODE_ID_LENGTH),
            enqueuedAt: isoTimestampOrNull(entry?.enqueuedAt),
            phase: toPrMergeQueuePhase(entry?.state),
            position:
              typeof position === 'number' &&
              Number.isSafeInteger(position) &&
              position >= 0
                ? position
                : null,
          }
        : null,
    observedAt,
  };
  return {
    snapshot,
    queueTimeline: errorTypes
      ? null
      : parseQueueTimelinePage(pullRequest.queueEvents, QUEUE_EVENTS_PAGE_SIZE),
  };
}

/**
 * Map one older timeline page read `before` the cursor at filtered index
 * `firstIndex`. Errors confined to the timeline, or a partial page, return
 * null; other GraphQL errors are retriable like the main read.
 */
export function normalizeGitHubQueueHistoryPage(
  body: unknown,
  firstIndex: number,
): GitHubQueueTimelinePage | null {
  if (!isRecord(body)) return null;
  const errorTypes = graphQlErrorTypes(body);
  if (errorTypes) {
    if (errorTypes.includes('RATE_LIMITED')) {
      throw new GitHubBrokerError(
        'rate_limited',
        'GitHub rate limited the pull request read.',
        { retriable: true },
      );
    }
    if (hasOnlyQueueEventsErrors(body)) return null;
    throw incomplete('GitHub returned errors for the pull request read.');
  }
  const data = isRecord(body.data) ? body.data : null;
  const repository = data && isRecord(data.repository) ? data.repository : null;
  const pullRequest =
    repository && isRecord(repository.pullRequest)
      ? repository.pullRequest
      : null;
  return pullRequest
    ? parseQueueTimelinePage(
        pullRequest.queueEvents,
        QUEUE_HISTORY_PAGE_SIZE,
        firstIndex,
      )
    : null;
}

function isGraphQlRateLimited(body: unknown): boolean {
  return (
    isRecord(body) &&
    (graphQlErrorTypes(body)?.includes('RATE_LIMITED') ?? false)
  );
}

interface PullRequestReadOptions {
  priority: 'interactive' | 'watcher';
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Spend-summary label for the broker. */
  caller?: string;
}

/** One raw GraphQL read through the broker as a safe read. */
async function executePullRequestGraphQl<T>(
  options: PullRequestReadOptions,
  query: string,
  variables: Record<string, string | number>,
  normalize: (body: unknown) => T,
): Promise<T> {
  const result = await getGitHubBroker().execute<T>(
    async (octokit): Promise<GitHubRawResponse<T>> => {
      // GraphQL `errors` arrive with HTTP 200, so read the raw body instead
      // of `octokit.graphql`, which would hide them behind a generic error.
      const route: string = 'POST /graphql';
      const response = await octokit.request(route, { query, variables });
      const body: unknown = response.data;
      if (isGraphQlRateLimited(body)) {
        throw new GitHubGraphQlRateLimitError(response.headers);
      }
      return {
        status: response.status,
        headers: response.headers,
        data: normalize(body),
      };
    },
    {
      priority: options.priority,
      operation: 'read',
      idempotency: 'safe',
      resource: 'graphql',
      ...(options.caller ? { caller: options.caller } : {}),
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub pull request read returned a mutation result.',
    );
  }
  return result.data;
}

const UNAVAILABLE_QUEUE_HISTORY: PrMergeQueueHistory = {
  status: 'unavailable',
};

/** An older page ends no later than the newer one starts and shares no id. */
function continuesTimeline(
  older: PrMergeQueueTimelineEvent[],
  newer: PrMergeQueueTimelineEvent[],
): boolean {
  const last: PrMergeQueueTimelineEvent | undefined = older[older.length - 1];
  const first: PrMergeQueueTimelineEvent | undefined = newer[0];
  if (
    last &&
    first &&
    Date.parse(last.createdAt) > Date.parse(first.createdAt)
  ) {
    return false;
  }
  const newerIds = new Set(newer.map((event) => event.id));
  return older.every((event) => !newerIds.has(event.id));
}

/**
 * Read one pull request's lifecycle, merge-queue state, and merge queue
 * timeline through the broker. With `queueHistoryFrom`, older timeline pages
 * are read until that filtered index is covered, at most
 * {@link MAX_QUEUE_HISTORY_PAGES} extra reads; a history that still starts
 * later is returned as is, and the caller treats the uncovered range as a gap.
 * A failed history page fails the whole read; an unusable one only makes the
 * history `unavailable`.
 */
export async function fetchGitHubPullRequest(
  options: PullRequestReadOptions & {
    repository: string;
    number: number;
    /** Filtered timeline index the caller still needs; omit for the newest page. */
    queueHistoryFrom?: number;
  },
): Promise<GitHubPullRequestFetchResult> {
  const [owner, name, extra] = options.repository.split('/');
  if (
    !owner ||
    !name ||
    extra !== undefined ||
    !Number.isSafeInteger(options.number) ||
    options.number <= 0
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub pull request request was malformed.',
    );
  }
  const variables = { owner, name, number: options.number };
  const { snapshot, queueTimeline } = await executePullRequestGraphQl(
    options,
    WATCHED_PULL_REQUEST_QUERY,
    variables,
    (body) => normalizeGitHubPullRequestRead(body, options.number),
  );
  if (!queueTimeline) {
    return { snapshot, queueHistory: UNAVAILABLE_QUEUE_HISTORY };
  }
  const { filteredCount } = queueTimeline;
  let { events, startCursor } = queueTimeline;
  let firstIndex = filteredCount - events.length;
  const from = options.queueHistoryFrom;
  for (
    let page = 0;
    page < MAX_QUEUE_HISTORY_PAGES &&
    typeof from === 'number' &&
    Number.isSafeInteger(from) &&
    from >= 0 &&
    from < firstIndex;
    page += 1
  ) {
    if (!startCursor) {
      return { snapshot, queueHistory: UNAVAILABLE_QUEUE_HISTORY };
    }
    const pageFirstIndex = firstIndex;
    const older = await executePullRequestGraphQl(
      { ...options, priority: 'watcher' },
      PULL_REQUEST_QUEUE_HISTORY_QUERY,
      { ...variables, before: startCursor },
      (body) => normalizeGitHubQueueHistoryPage(body, pageFirstIndex),
    );
    if (!older || !continuesTimeline(older.events, events)) {
      return { snapshot, queueHistory: UNAVAILABLE_QUEUE_HISTORY };
    }
    events = [...older.events, ...events];
    firstIndex -= older.events.length;
    startCursor = older.startCursor;
  }
  return {
    snapshot,
    queueHistory: { status: 'complete', filteredCount, firstIndex, events },
  };
}
