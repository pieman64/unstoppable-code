// GitHub REST surface for the shared UI-automation mock server (WP-MOCK-GITHUB,
// per Doc 8 `08-github-api-mocking-options.md`).
//
// The Canopy desktop app's real GitHub API traffic (Channel B in Doc 8) runs
// through Octokit at `github-client.ts` and `github-permissions.ts`. Under an
// E2E build those constructors honor `CANOPY_GITHUB_API_BASE_URL` (the literal
// `if (__CANOPY_E2E__)` seam) and point here. This module answers the
// GitHub-REST-compatible routes the app actually calls so the auto-firing PR
// poller and the Settings permissions probe render deterministic state with no
// live GitHub.
//
// The shared server (see ../start.mjs) runs ONCE for the whole Playwright suite
// (Doc 4 §0) under `--workers=2`, so every response is keyed off the request's
// Authorization token (Bearer or Octokit's classic-PAT `token` scheme: the mock
// GH token a test registers its scenario under) to keep concurrent tests from
// colliding. An unregistered key resolves to the benign default scenario, which
// behaves as "no PR / empty" so untouched surfaces stay inert.
//
// Scenario slice shape (`scenario.github`), all optional:
//   {
//     // One of the named presets below, applied when the explicit fields are
//     // absent. Defaults to 'no-pr'.
//     variant?: 'open-pr' | 'merged' | 'checks-failing' | 'no-pr',
//     // Explicit overrides (take precedence over `variant`):
//     pulls?:      object[],                 // GET .../pulls   + GET .../pulls/:n
//     checkRuns?:  object[],                 // GET .../commits/:sha/check-runs
//     reviews?:    object[],                 // GET .../pulls/:n/reviews
//     comments?:   object[],                 // GET .../pulls/:n/comments (review comments)
//     issueComments?: object[],              // GET .../issues/:n/comments
//     user?:       object,                   // GET /user
//     userScopes?: string,                   // x-oauth-scopes header for GET /user
//     repos?:      object[],                 // GET /user/repos
//     workflowRuns?: {                       // GET .../actions/runs/:id
//       'owner/repo/runId': {
//         status: string,
//         conclusion: string | null,
//         run_attempt: number,
//         html_url: string,
//         name?: string,
//         run_number?: number,
//         responseStatus?: number,            // HTTP status, defaults to 200
//         responseHeaders?: object,           // ETag/rate/poll headers
//         responseDelayMs?: number,            // deterministic in-flight test
//       }
//     },
//     workflowJobs?: {                       // GET .../actions/jobs/:id
//       'owner/repo/jobId': { id, run_id, run_url, ... }
//     },
//     workflowRunJobs?: {                    // GET .../runs/:id/attempts/:n/jobs
//       'owner/repo/runId/attempt': {
//         jobs: object[],
//         total_count?: number,
//         responseStatus?: number,
//         responseHeaders?: object,
//       }
//     },
//     repositoryContents?: {                 // GET /repos/:owner/:repo/contents/:path?ref=
//       'owner/repo/path@ref': {
//         content: string,                    // raw file text; served base64
//         responseStatus?: number,
//         responseHeaders?: object,
//       }
//     },
//     commits?: {                            // GET /repos/:owner/:repo/commits/:sha
//       'owner/repo/sha': {
//         sha?: string,
//         responseStatus?: number,
//         responseHeaders?: object,
//       }
//     },
//     mergeQueue?: {                         // POST /graphql pull-request fields
//       enabled: boolean,                     //   isMergeQueueEnabled
//       inQueue?: boolean,                    //   isInMergeQueue
//       position?: number,                    //   mergeQueueEntry.position
//       state?: string,                       //   mergeQueueEntry.state
//     },
//     graphqlPullRequests?: {                 // POST /graphql, keyed by PR number
//       '101': { isMergeQueueEnabled?: boolean, isInMergeQueue?: boolean,
//                mergeQueueEntry?: object | null, reviewThreads?: object }
//     },                                      // defaults: empty threads, false flags
//     mergeRequests?: object[],                // populated by PUT .../pulls/:n/merge
//     workflowRunRequests?: object[],          // populated by this mock
//     workflowRunJobRequests?: object[],       // populated by this mock
//     contentsRequests?: object[],             // populated by this mock
//     issues?: {                             // GET /repos/:owner/:repo/issues/:n
//       'owner/repo/number': { title, state, html_url, updated_at, ...,
//         responseStatus?: number, responseHeaders?: object }
//     },                                      // unlisted: 404
//     repositories?: {                       // GET /repos/:owner/:repo, merged
//       'owner/repo': { description, html_url, private, archived, ... }
//     },                                      // over the merge-capability body
//   }
//
// Reference preview reads (issues and configured repositories) record
// `githubIssue:<owner>/<repo>/<n>` or `githubRepository:<owner>/<repo>`
// scenario activity on arrival. `POST /__mock/github/reference-holds/:key`
// with `{ held: true }` makes that key's reference reads wait until
// `{ held: false }` releases them; `GET` on the same path reports
// `{ held, waiting }`, so a spec can observe an in-flight read without timing.

import { randomBytes } from 'node:crypto';
import {
  getScenario,
  keyFromBearer,
  readJsonBody,
  recordScenarioActivity,
} from '../control-plane.mjs';

// ── GitHub App device flow (Copilot sign-in) ───────────────────────────────
//
// Per-flow state lives in these maps keyed by device code, never in the
// frozen default scenario. The access token issued on approval is the
// scenario `key` the test chose (`ghu_e2e_<login>`), so later `GET /user`
// calls resolve the same scenario and the fake Copilot CLI can derive the
// login from the token without any shared state.
const deviceFlows = new Map(); // deviceCode -> { userCode, status, key }
const deviceFlowsByUserCode = new Map(); // userCode -> deviceCode
const externalOpens = [];

function userCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const text = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function readFormBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => resolve(new URLSearchParams(raw)));
    request.on('error', () => resolve(new URLSearchParams()));
  });
}

function grantFor(key) {
  return {
    access_token: key,
    token_type: 'bearer',
    expires_in: 28_800,
    refresh_token: `ghr_e2e_${key}`,
    refresh_token_expires_in: 15_724_800,
  };
}

// Opt-in rotation controls leave the default device-flow fixture stateless.
// Retirement happens on arrival, so killing a held response models I1b rather
// than pretending GitHub undid the rotation when the client disappeared.
const refreshControls = new Map(); // scenario key -> rotation state
const refreshTokens = new Map(); // issued refresh token -> rotation state

async function handleRefreshControl(request, response, url) {
  const match = /^\/__mock\/github\/refresh\/(.+)$/.exec(url.pathname);
  if (!match) return false;
  const key = decodeURIComponent(match[1]);
  let state = refreshControls.get(key);
  if (request.method === 'POST') {
    const body = (await readJsonBody(request)) ?? {};
    if (typeof body.held !== 'boolean') {
      jsonResponse(response, 400, { error: '`held` must be a boolean' });
      return true;
    }
    if (!state) {
      state = {
        key,
        held: false,
        current: `ghr_e2e_${key}`,
        presentations: [],
        delivered: 0,
        waiters: new Set(),
        observers: new Set(),
      };
      refreshControls.set(key, state);
      refreshTokens.set(state.current, state);
    }
    state.held = body.held;
    if (!state.held) for (const release of state.waiters) release();
    jsonResponse(response, 200, { ok: true });
    return true;
  }
  if (request.method !== 'GET') return false;
  if (!state) {
    jsonResponse(response, 404, { error: 'unknown refresh control' });
    return true;
  }
  const expected = Number(url.searchParams.get('presentations') ?? 0);
  if (state.presentations.length < expected) {
    const current = state;
    await new Promise((resolve) => {
      const changed = () => {
        if (current.presentations.length >= expected || response.destroyed) {
          current.observers.delete(changed);
          response.off('close', changed);
          resolve();
        }
      };
      current.observers.add(changed);
      response.once('close', changed);
    });
  }
  if (!response.destroyed)
    jsonResponse(response, 200, {
      held: state.held,
      waiting: state.waiters.size,
      presentations: state.presentations,
      delivered: state.delivered,
    });
  return true;
}

async function controlledRefresh(response, token, state) {
  state.presentations.push(token);
  const accepted = token === state.current;
  const successor = `ghr_e2e_${state.key}_${randomBytes(16).toString('hex')}`;
  if (accepted) {
    state.current = successor;
    refreshTokens.set(successor, state);
  }
  let pending;
  if (accepted && state.held) {
    pending = new Promise((resolve) => {
      const release = () => {
        state.waiters.delete(release);
        response.off('close', release);
        resolve();
      };
      state.waiters.add(release);
      response.once('close', release);
    });
  }
  for (const changed of state.observers) changed();
  await pending;
  if (response.destroyed) return;
  if (!accepted) {
    jsonResponse(response, 200, { error: 'bad_refresh_token' });
    return;
  }
  response.once('finish', () => state.delivered++);
  jsonResponse(response, 200, {
    ...grantFor(state.key),
    refresh_token: successor,
  });
}

async function handleDeviceFlow(request, response, url) {
  const { pathname } = url;
  const base = `http://${request.headers.host}`;
  if (request.method === 'GET' && pathname === '/login/device') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>Mock GitHub device login</title><p>Enter your code.</p>',
    );
    return true;
  }
  if (request.method === 'POST' && pathname === '/login/device/code') {
    const form = await readFormBody(request);
    if (!form.get('client_id')) {
      jsonResponse(response, 400, { error: 'invalid_request' });
      return true;
    }
    const deviceCode = randomBytes(16).toString('hex');
    const code = userCode();
    deviceFlows.set(deviceCode, {
      userCode: code,
      status: 'pending',
      key: null,
    });
    deviceFlowsByUserCode.set(code, deviceCode);
    jsonResponse(response, 200, {
      device_code: deviceCode,
      user_code: code,
      verification_uri: `${base}/login/device`,
      expires_in: 900,
      interval: 1,
    });
    return true;
  }
  if (request.method === 'POST' && pathname === '/login/oauth/access_token') {
    const form = await readFormBody(request);
    if (form.get('grant_type') === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? '';
      const controlled = refreshTokens.get(refreshToken);
      if (controlled) {
        await controlledRefresh(response, refreshToken, controlled);
        return true;
      }
      if (!refreshToken.startsWith('ghr_e2e_')) {
        jsonResponse(response, 200, { error: 'bad_refresh_token' });
        return true;
      }
      jsonResponse(
        response,
        200,
        grantFor(refreshToken.slice('ghr_e2e_'.length)),
      );
      return true;
    }
    const flow = deviceFlows.get(form.get('device_code') ?? '');
    if (!flow) {
      jsonResponse(response, 200, { error: 'expired_token' });
      return true;
    }
    if (flow.status === 'pending') {
      jsonResponse(response, 200, { error: 'authorization_pending' });
      return true;
    }
    if (flow.status === 'denied') {
      jsonResponse(response, 200, { error: 'access_denied' });
      return true;
    }
    jsonResponse(response, 200, grantFor(flow.key));
    return true;
  }
  if (
    request.method === 'POST' &&
    (pathname === '/__mock/github/device/approve' ||
      pathname === '/__mock/github/device/deny')
  ) {
    const body = (await readJsonBody(request)) ?? {};
    const deviceCode = deviceFlowsByUserCode.get(String(body.user_code ?? ''));
    const flow = deviceCode ? deviceFlows.get(deviceCode) : undefined;
    if (!flow) {
      jsonResponse(response, 404, { error: 'unknown user_code' });
      return true;
    }
    if (pathname.endsWith('/approve')) {
      if (typeof body.key !== 'string' || !body.key) {
        jsonResponse(response, 400, { error: 'key required' });
        return true;
      }
      flow.status = 'approved';
      flow.key = body.key;
    } else {
      flow.status = 'denied';
    }
    jsonResponse(response, 200, { ok: true });
    return true;
  }
  if (pathname === '/__mock/github/external-open') {
    if (request.method === 'POST') {
      const body = (await readJsonBody(request)) ?? {};
      if (typeof body.url === 'string') externalOpens.push(body.url);
      jsonResponse(response, 200, { ok: true });
      return true;
    }
    if (request.method === 'GET') {
      jsonResponse(response, 200, { urls: [...externalOpens] });
      return true;
    }
  }
  return false;
}

// Opt-in key for specs that relaunch Electron after storing a PAT. macOS
// safeStorage keeps the credential opaque to the Node-side test driver, so
// those specs cannot reliably register under the exact Authorization value.
// The fallback is inert unless a test explicitly registers this key.
export const GITHUB_FALLBACK_SCENARIO_KEY = '__github-rest-fallback__';

const DEFAULT_USER = Object.freeze({
  login: 'canopy-e2e',
  id: 4242,
  node_id: 'U_canopy_e2e',
  type: 'User',
  html_url: 'https://github.com/canopy-e2e',
  url: 'https://api.github.com/users/canopy-e2e',
});

const DEFAULT_USER_SCOPES = 'repo, read:org, workflow';

// ── Canned PR/check/review building blocks ──────────────────────────────────

function actor(login) {
  return {
    login,
    id: 7,
    node_id: `U_${login}`,
    type: 'User',
    html_url: `https://github.com/${login}`,
    url: `https://api.github.com/users/${login}`,
  };
}

function openPr(owner, repo, number) {
  const sha = 'a'.repeat(40);
  return {
    id: 1_000 + number,
    number,
    node_id: `PR_open_${number}`,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    title: 'Add E2E mock PR',
    body: 'Seeded open PR for UI automation.',
    state: 'open',
    draft: false,
    merged_at: null,
    closed_at: null,
    merge_commit_sha: null,
    merged_by: null,
    mergeable: true,
    mergeable_state: 'clean',
    comments: 1,
    review_comments: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    user: actor('canopy-e2e'),
    labels: [
      {
        id: 501,
        node_id: 'LA_bug',
        name: 'bug',
        color: 'd73a4a',
        description: "Something isn't working",
      },
      {
        id: 502,
        node_id: 'LA_enhancement',
        name: 'enhancement',
        color: 'a2eeef',
        description: null,
      },
    ],
    assignees: [],
    requested_reviewers: [],
    head: {
      ref: 'feature/mock',
      sha,
      repo: { full_name: `${owner}/${repo}` },
    },
    base: {
      ref: 'main',
      sha: 'b'.repeat(40),
      repo: { full_name: `${owner}/${repo}` },
    },
  };
}

function mergedPr(owner, repo, number) {
  return {
    ...openPr(owner, repo, number),
    id: 2_000 + number,
    node_id: `PR_merged_${number}`,
    title: 'Merged E2E mock PR',
    body: 'Seeded merged PR for UI automation.',
    state: 'closed',
    merged_at: '2024-01-03T00:00:00Z',
    closed_at: '2024-01-03T00:00:00Z',
    merge_commit_sha: 'c'.repeat(40),
    merged_by: actor('canopy-e2e'),
    updated_at: '2024-01-03T00:00:00Z',
  };
}

function checkRun(name, status, conclusion, headSha) {
  return {
    id: Math.abs(hashString(`${name}:${status}:${conclusion}`)),
    name,
    status,
    conclusion,
    head_sha: headSha,
    details_url: `https://github.com/checks/${encodeURIComponent(name)}`,
    html_url: `https://github.com/checks/${encodeURIComponent(name)}`,
    started_at: '2024-01-02T00:00:00Z',
    completed_at: status === 'completed' ? '2024-01-02T00:05:00Z' : null,
    app: { slug: 'github-actions', name: 'GitHub Actions' },
  };
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function passingCheckRuns(headSha) {
  return [
    checkRun('build', 'completed', 'success', headSha),
    checkRun('test', 'completed', 'success', headSha),
  ];
}

function failingCheckRuns(headSha) {
  return [
    checkRun('build', 'completed', 'success', headSha),
    checkRun('test', 'completed', 'failure', headSha),
  ];
}

function approvedReview() {
  return {
    id: 9_001,
    node_id: 'PRR_approved',
    html_url: 'https://github.com/review/9001',
    user: actor('reviewer-bot'),
    state: 'APPROVED',
    body: 'LGTM',
    commit_id: 'a'.repeat(40),
    submitted_at: '2024-01-02T01:00:00Z',
  };
}

// ── Scenario resolution ─────────────────────────────────────────────────────

function resolveGithubSlice(request) {
  const key = keyFromBearer(request);
  const scenario = getScenario(key);
  return (
    scenario.github ?? getScenario(GITHUB_FALLBACK_SCENARIO_KEY).github ?? {}
  );
}

// Resolve the PR list for a repo from the slice (explicit `pulls` win, else the
// named variant). Returns `[]` for the default / no-pr cases.
function resolvePulls(slice, owner, repo) {
  if (Array.isArray(slice.pulls)) {
    return slice.pulls;
  }
  switch (slice.variant) {
    case 'open-pr':
    case 'checks-failing':
      return [openPr(owner, repo, 101)];
    case 'merged':
      return [mergedPr(owner, repo, 102)];
    case 'no-pr':
    default:
      return [];
  }
}

function pullBelongsToRepository(pr, owner, repo) {
  const repository = pr.base?.repo?.full_name;
  // Older fixtures omit base.repo and are scoped by their requested route.
  return (
    !repository || repository.toLowerCase() === `${owner}/${repo}`.toLowerCase()
  );
}

function resolveCheckRuns(slice, headSha) {
  if (Array.isArray(slice.checkRuns)) {
    return slice.checkRuns;
  }
  switch (slice.variant) {
    case 'checks-failing':
      return failingCheckRuns(headSha);
    case 'open-pr':
    case 'merged':
      return passingCheckRuns(headSha);
    case 'no-pr':
    default:
      return [];
  }
}

function resolveReviews(slice) {
  if (Array.isArray(slice.reviews)) {
    return slice.reviews;
  }
  switch (slice.variant) {
    case 'open-pr':
    case 'merged':
      return [approvedReview()];
    default:
      return [];
  }
}

// GraphQL `pullRequest` fields the PR status poller reads: merge queue state
// plus an empty, fully resolved review-thread page.
function graphqlPullRequest(slice, overrides = {}) {
  const queue = slice.mergeQueue ?? { enabled: false };
  const inQueue = queue.inQueue === true;
  return {
    id: 'PR_mock_merge_queue',
    isMergeQueueEnabled: queue.enabled === true,
    isInMergeQueue: inQueue,
    mergeQueueEntry: inQueue
      ? { position: queue.position ?? 1, state: queue.state ?? 'QUEUED' }
      : null,
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    ...overrides,
  };
}

function identifiedPull(slice, owner, repo, number) {
  return resolvePulls(slice, owner, repo).find(
    (pr) =>
      pr.number === number &&
      pr.html_url === `https://github.com/${owner}/${repo}/pull/${number}`,
  );
}

// The pull request watcher's query (`WATCHED_PULL_REQUEST_QUERY`) reads the
// head commit; the PR status poller's query reads review threads instead.
function isWatchedPullRequestQuery(query) {
  return (
    typeof query === 'string' &&
    /\bheadRefOid\b/.test(query) &&
    !/\breviewThreads\b/.test(query)
  );
}

// Older merge queue timeline pages (`PULL_REQUEST_QUEUE_HISTORY_QUERY`): a
// `before:` timeline page without the lifecycle fields.
function isQueueHistoryQuery(query) {
  return (
    typeof query === 'string' &&
    /\btimelineItems\b/.test(query) &&
    /\bbefore\s*:/.test(query) &&
    !/\bheadRefOid\b/.test(query)
  );
}

function requestsQueueEvents(query) {
  return /\bqueueEvents\s*:\s*timelineItems\b/.test(query);
}

function queueEventsPageSize(query, fallback) {
  const match = /\btimelineItems\s*\([^)]*\blast\s*:\s*(\d+)/.exec(query);
  return match ? Number(match[1]) : fallback;
}

const QUEUE_CURSOR_PREFIX = 'mq-cursor:';

function queueTimelineNode(event) {
  return event.type === 'removed'
    ? {
        __typename: 'RemovedFromMergeQueueEvent',
        id: event.id,
        createdAt: event.createdAt,
        reason: event.reason ?? null,
      }
    : {
        __typename: 'AddedToMergeQueueEvent',
        id: event.id,
        createdAt: event.createdAt,
      };
}

// GitHub's `last: pageSize, before:` semantics: `filteredCount` counts the
// items before the cursor, and `startCursor` names the first returned item.
function queueEventsConnection(timeline, end, pageSize) {
  const start = Math.max(0, end - pageSize);
  return {
    filteredCount: end,
    pageInfo: {
      hasPreviousPage: start > 0,
      startCursor: end > start ? `${QUEUE_CURSOR_PREFIX}${start}` : null,
    },
    nodes: timeline.slice(start, end).map(queueTimelineNode),
  };
}

/**
 * The `queueEvents` field for one read: `{ omit }`, `{ value }`, and any
 * field errors. `before` is undefined for the newest window.
 */
function queueEventsField(config, before, pageSize) {
  if (config.queueTimelineOmit === true) return { omit: true, errors: [] };
  if (Array.isArray(config.queueTimelineErrors)) {
    return { value: null, errors: config.queueTimelineErrors };
  }
  const timeline = Array.isArray(config.queueTimeline)
    ? config.queueTimeline
    : [];
  let end = timeline.length;
  if (before !== undefined) {
    const index =
      typeof before === 'string' && before.startsWith(QUEUE_CURSOR_PREFIX)
        ? Number(before.slice(QUEUE_CURSOR_PREFIX.length))
        : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index > timeline.length) {
      return {
        value: null,
        errors: [
          {
            type: 'INVALID_CURSOR_ARGUMENTS',
            path: ['repository', 'pullRequest', 'queueEvents'],
            message: `\`${before}\` does not appear to be a valid cursor.`,
          },
        ],
      };
    }
    end = index;
  }
  return {
    value: queueEventsConnection(timeline, end, pageSize),
    errors: [],
  };
}

const WATCHED_PULL_REQUEST_TERMINAL_AT = '2026-07-20T00:05:00Z';

// A GitHub-shaped `pullRequest` node whose lifecycle fields agree with `state`
// unless the configured fields override them.
function watchedPullRequestNode(owner, repo, number, fields) {
  const state = fields.state ?? 'OPEN';
  const merged = state === 'MERGED';
  const terminal = state !== 'OPEN';
  return {
    id: `PR_watched_${number}`,
    state,
    merged,
    mergedAt: merged ? WATCHED_PULL_REQUEST_TERMINAL_AT : null,
    closedAt: terminal ? WATCHED_PULL_REQUEST_TERMINAL_AT : null,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `Mock pull request #${number}`,
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    mergeCommit: merged ? { oid: 'c'.repeat(40) } : null,
    isInMergeQueue: false,
    mergeQueueEntry: null,
    ...fields,
  };
}

/**
 * Response for one watcher PR read. Unconfigured PRs answer as GitHub does for
 * a missing number: `pullRequest: null` plus a NOT_FOUND error, with HTTP 200.
 */
function watchedPullRequestResponse(slice, variables, query) {
  const owner = String(variables?.owner ?? '');
  const repo = String(variables?.name ?? '');
  const number = Number(variables?.number);
  const key = `${owner}/${repo}/${variables?.number}`;
  const configured = slice.pullRequests?.[key];
  const notFound = {
    type: 'NOT_FOUND',
    path: ['repository', 'pullRequest'],
    message: `Could not resolve to a PullRequest with the number of ${number}.`,
  };
  if (
    !configured ||
    typeof configured !== 'object' ||
    Array.isArray(configured)
  ) {
    return {
      key,
      responseStatus: 200,
      responseHeaders: {},
      responseDelayMs: 0,
      body: { data: { repository: { pullRequest: null } }, errors: [notFound] },
    };
  }
  const {
    responseStatus = 200,
    responseHeaders = {},
    responseDelayMs = 0,
    errors,
    missing = false,
    omit = [],
    queueTimeline,
    queueTimelineOmit,
    queueTimelineErrors,
    ...fields
  } = configured;
  let pullRequest = null;
  let queueErrors = [];
  if (!missing) {
    pullRequest = watchedPullRequestNode(owner, repo, number, fields);
    if (requestsQueueEvents(query)) {
      const queueEvents = queueEventsField(
        { queueTimeline, queueTimelineOmit, queueTimelineErrors },
        undefined,
        queueEventsPageSize(query, 10),
      );
      if (!queueEvents.omit) pullRequest.queueEvents = queueEvents.value;
      queueErrors = queueEvents.errors;
    }
    for (const field of omit) delete pullRequest[field];
  }
  const responseErrors =
    errors || queueErrors.length > 0
      ? [...(errors ?? []), ...queueErrors]
      : missing
        ? [notFound]
        : undefined;
  return {
    key,
    responseStatus,
    responseHeaders,
    responseDelayMs,
    body: {
      data: { repository: { pullRequest } },
      ...(responseErrors ? { errors: responseErrors } : {}),
    },
  };
}

/**
 * Response for one older-timeline page read. Unconfigured or missing PRs
 * answer like the watcher read; the lifecycle fields are never included.
 */
function queueHistoryResponse(slice, variables, query) {
  const owner = String(variables?.owner ?? '');
  const repo = String(variables?.name ?? '');
  const key = `${owner}/${repo}/${variables?.number}`;
  const configured = slice.pullRequests?.[key];
  if (
    !configured ||
    typeof configured !== 'object' ||
    Array.isArray(configured) ||
    configured.missing === true
  ) {
    const notFoundResponse = watchedPullRequestResponse(
      slice,
      variables,
      query,
    );
    return { ...notFoundResponse, before: variables?.before };
  }
  const {
    responseStatus = 200,
    responseHeaders = {},
    responseDelayMs = 0,
    errors,
  } = configured;
  const queueEvents = queueEventsField(
    configured,
    variables?.before,
    queueEventsPageSize(query, 50),
  );
  const pullRequest = queueEvents.omit
    ? {}
    : { queueEvents: queueEvents.value };
  const responseErrors = [...(errors ?? []), ...queueEvents.errors];
  return {
    key,
    before: variables?.before,
    responseStatus,
    responseHeaders,
    responseDelayMs,
    body: {
      data: { repository: { pullRequest } },
      ...(responseErrors.length > 0 ? { errors: responseErrors } : {}),
    },
  };
}

async function respondConfigured(response, configured) {
  if (configured.responseDelayMs > 0) {
    await new Promise((resolve) =>
      setTimeout(resolve, configured.responseDelayMs),
    );
  }
  jsonResponse(
    response,
    configured.responseStatus,
    configured.body,
    configured.responseHeaders,
  );
}

// ── Reference preview reads ────────────────────────────────────────────────

const referenceHolds = new Map(); // key -> Set of release callbacks

function waitWhileHeld(key) {
  const waiters = key ? referenceHolds.get(key) : undefined;
  if (!waiters) return Promise.resolve();
  return new Promise((resolve) => waiters.add(resolve));
}

async function handleReferenceHoldControl(request, response, url) {
  const match = /^\/__mock\/github\/reference-holds\/(.+)$/.exec(url.pathname);
  if (!match) return false;
  const key = decodeURIComponent(match[1]);
  if (request.method === 'GET') {
    const waiters = referenceHolds.get(key);
    jsonResponse(response, 200, {
      key,
      held: waiters !== undefined,
      waiting: waiters?.size ?? 0,
    });
    return true;
  }
  if (request.method !== 'POST') return false;
  const body = (await readJsonBody(request)) ?? {};
  if (typeof body.held !== 'boolean') {
    jsonResponse(response, 400, { error: '`held` must be a boolean' });
    return true;
  }
  const waiters = referenceHolds.get(key);
  let released = 0;
  if (body.held) {
    if (!waiters) referenceHolds.set(key, new Set());
  } else if (waiters) {
    referenceHolds.delete(key);
    released = waiters.size;
    for (const release of waiters) release();
  }
  jsonResponse(response, 200, { ok: true, key, held: body.held, released });
  return true;
}

/** Answers once the key's hold lifts; a client that gave up gets nothing. */
async function respondReference(request, response, activity, configured) {
  const key = keyFromBearer(request);
  recordScenarioActivity(key, activity);
  await waitWhileHeld(key);
  if (response.destroyed || response.writableEnded) return;
  if (!configured) {
    jsonResponse(response, 404, { message: 'Not Found' });
    return;
  }
  const { responseStatus = 200, responseHeaders = {}, ...body } = configured;
  jsonResponse(response, responseStatus, body, responseHeaders);
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function jsonResponse(response, status, body, extraHeaders) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function workflowRunResponse(slice, owner, repo, runId, attempt) {
  const baseKey = `${owner}/${repo}/${runId}`;
  const key = attempt ? `${baseKey}/${attempt}` : baseKey;
  const configured = slice.workflowRuns?.[key] ?? slice.workflowRuns?.[baseKey];
  if (
    !configured ||
    typeof configured !== 'object' ||
    Array.isArray(configured)
  ) {
    return null;
  }
  const {
    responseStatus = 200,
    responseHeaders = {},
    responseDelayMs = 0,
    ...body
  } = configured;
  return { key, responseStatus, responseHeaders, responseDelayMs, body };
}

// ── Router ──────────────────────────────────────────────────────────────────

/**
 * Handle a GitHub REST request. Returns `true` if the request matched a GitHub
 * route (and a response was written), `false` otherwise.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {boolean}
 */
export async function handleGithubRequest(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  if (await handleRefreshControl(request, response, url)) return true;
  if (await handleDeviceFlow(request, response, url)) {
    return true;
  }
  if (await handleReferenceHoldControl(request, response, url)) {
    return true;
  }

  // POST /graphql — the PR status poller's review-thread + merge queue query.
  // Answers only Octokit requests (Linear shares the path) and only when the
  // scenario opts in with `mergeQueue`, `graphqlPullRequests`, or watcher `pullRequests`.
  if (
    method === 'POST' &&
    pathname === '/graphql' &&
    /octokit/i.test(request.headers['user-agent'] ?? '')
  ) {
    const slice = resolveGithubSlice(request);
    const body = (await readJsonBody(request)) ?? {};
    // Match only this operation; viewer and reconcile ISSUE searches retain
    // their own routing and response shapes.
    if (/\bquery\s+PrPickerSearch\b/.test(body.query ?? '')) {
      const q = body.variables?.q ?? '';
      slice.prPickerSearchRequests ??= [];
      slice.prPickerSearchRequests.push({ q });
      const scope = /^repo:([^/\s]+)\/(\S+) is:pr is:open in:title (.+)$/.exec(
        q,
      );
      const first = /\bfirst:\s*(\d+)/.exec(body.query)?.[1] ?? '20';
      if (!scope) {
        jsonResponse(response, 200, {
          errors: [{ message: 'Invalid PR picker search scope' }],
        });
        return true;
      }
      const [, owner, repo, titleQuery] = scope;
      const tokens = Array.from(titleQuery.matchAll(/"([^"\\]+)"/g), (match) =>
        match[1].toLowerCase(),
      );
      const nodes = resolvePulls(slice, owner, repo)
        .filter(
          (pr) =>
            pullBelongsToRepository(pr, owner, repo) &&
            pr.state === 'open' &&
            tokens.every((token) => pr.title.toLowerCase().includes(token)),
        )
        .slice(0, Math.min(20, Number(first)))
        .map((pr) => ({
          __typename: 'PullRequest',
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          headRefName: pr.head?.ref,
          baseRefName: pr.base?.ref,
          isDraft: pr.draft === true,
          author: pr.user ? { login: pr.user.login } : null,
          headRepository: pr.head?.repo
            ? { nameWithOwner: pr.head.repo.full_name }
            : null,
        }));
      jsonResponse(response, 200, { data: { search: { nodes } } });
      return true;
    }
    if (
      !slice.mergeQueue &&
      !slice.graphqlPullRequests &&
      !slice.pullRequests
    ) {
      return false;
    }
    if (
      slice.pullRequests &&
      (isWatchedPullRequestQuery(body.query) || isQueueHistoryQuery(body.query))
    ) {
      const configured = isQueueHistoryQuery(body.query)
        ? queueHistoryResponse(slice, body.variables, body.query)
        : watchedPullRequestResponse(slice, body.variables, body.query);
      if (isQueueHistoryQuery(body.query)) {
        slice.pullRequestHistoryRequests ??= [];
        slice.pullRequestHistoryRequests.push({
          key: configured.key,
          before: configured.before ?? null,
          requestedAt: new Date().toISOString(),
        });
      } else {
        slice.pullRequestRequests ??= [];
        slice.pullRequestRequests.push({
          key: configured.key,
          requestedAt: new Date().toISOString(),
        });
      }
      await respondConfigured(response, configured);
      return true;
    }
    if (/\benqueuePullRequest\b/.test(body.query ?? '')) {
      const { pullRequestId, expectedHeadOid } = body.variables ?? {};
      slice.enqueueRequests ??= [];
      slice.enqueueRequests.push({ pullRequestId, expectedHeadOid });
      const pr = resolvePulls(slice, 'canopy-e2e', 'ts-pnpm-vite').find(
        (entry) => entry.node_id === pullRequestId,
      );
      if (!pr || pr.head?.sha !== expectedHeadOid) {
        jsonResponse(response, 200, {
          errors: [
            { message: 'expectedHeadOid does not match the pull request head' },
          ],
        });
      } else {
        slice.graphqlPullRequests ??= {};
        slice.graphqlPullRequests[pr.number] = {
          ...slice.graphqlPullRequests[pr.number],
          isInMergeQueue: true,
          mergeQueueEntry: { position: 1, state: 'QUEUED' },
        };
        jsonResponse(response, 200, {
          data: {
            enqueuePullRequest: {
              mergeQueueEntry: { position: 1, state: 'QUEUED' },
            },
          },
        });
      }
      return true;
    }
    if (slice.pullRequests && !slice.mergeQueue && !slice.graphqlPullRequests) {
      jsonResponse(response, 200, { data: {} });
      return true;
    }
    let pullRequest;
    if (slice.graphqlPullRequests) {
      const { owner, repo, number } = body.variables ?? {};
      const pr = identifiedPull(slice, owner, repo, Number(number));
      pullRequest = pr
        ? graphqlPullRequest(slice, {
            id: pr.node_id,
            ...slice.graphqlPullRequests[number],
          })
        : null;
    } else {
      // Compatibility for pre-existing queue scenarios.
      pullRequest = graphqlPullRequest(slice);
    }
    jsonResponse(response, 200, {
      data: { repository: { pullRequest } },
    });
    return true;
  }

  const mergeMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(
    pathname,
  );
  if (method === 'PUT' && mergeMatch) {
    const slice = resolveGithubSlice(request);
    const [, owner, repo, rawNumber] = mergeMatch;
    const number = Number(rawNumber);
    const body = (await readJsonBody(request)) ?? {};
    if (!Object.isFrozen(slice)) {
      slice.mergeRequests ??= [];
      slice.mergeRequests.push({ ...body, owner, repo, number });
    }
    const pr = identifiedPull(slice, owner, repo, number);
    if (!pr) {
      jsonResponse(response, 404, { message: 'Not Found' });
    } else if (body.sha !== pr.head?.sha) {
      jsonResponse(response, 409, {
        message: 'Head branch was modified. Review and try the merge again.',
      });
    } else {
      const sha = 'c'.repeat(40);
      const mergedAt = '2024-01-03T00:00:00Z';
      slice.pulls = resolvePulls(slice, owner, repo).map((entry) =>
        entry.number === number && entry.html_url === pr.html_url
          ? {
              ...entry,
              state: 'closed',
              merged: true,
              merged_at: mergedAt,
              closed_at: mergedAt,
              merge_commit_sha: sha,
            }
          : entry,
      );
      jsonResponse(response, 200, {
        merged: true,
        sha,
        message: 'Pull Request successfully merged',
      });
    }
    return true;
  }

  const repositoryMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && repositoryMatch) {
    const [, owner, repo] = repositoryMatch;
    const configured =
      resolveGithubSlice(request).repositories?.[`${owner}/${repo}`];
    if (configured) {
      await respondReference(
        request,
        response,
        `githubRepository:${owner}/${repo}`,
        {
          full_name: `${owner}/${repo}`,
          default_branch: 'main',
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          ...configured,
        },
      );
      return true;
    }
    jsonResponse(response, 200, {
      full_name: `${owner}/${repo}`,
      default_branch: 'main',
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    });
    return true;
  }

  if (method !== 'GET') {
    return false;
  }

  const slice = resolveGithubSlice(request);

  // GET /user
  if (pathname === '/user') {
    const user = slice.user ?? DEFAULT_USER;
    const scopes = slice.userScopes ?? DEFAULT_USER_SCOPES;
    jsonResponse(response, 200, user, { 'x-oauth-scopes': scopes });
    return true;
  }

  // GET /user/repos
  if (pathname === '/user/repos') {
    jsonResponse(response, 200, slice.repos ?? []);
    return true;
  }

  // GET /repos/:owner/:repo/actions/jobs/:jobId
  const workflowJobMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/jobs\/(\d+)$/.exec(pathname);
  if (workflowJobMatch) {
    const [, owner, repo, jobId] = workflowJobMatch;
    const key = `${owner}/${repo}/${jobId}`;
    const configured = slice.workflowJobs?.[key];
    slice.workflowJobRequests ??= [];
    slice.workflowJobRequests.push({
      key,
      requestedAt: new Date().toISOString(),
    });
    if (!configured) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    jsonResponse(response, 200, configured);
    return true;
  }

  // GET /repos/:owner/:repo/contents/:path?ref=
  const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(
    pathname,
  );
  if (contentsMatch) {
    const [, owner, repo, rawPath] = contentsMatch;
    let filePath = rawPath;
    try {
      filePath = decodeURIComponent(rawPath);
    } catch {
      // Keep the raw path; the lookup below simply misses.
    }
    const ref = url.searchParams.get('ref') ?? '';
    const key = `${owner}/${repo}/${filePath}@${ref}`;
    slice.contentsRequests ??= [];
    slice.contentsRequests.push({
      key,
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      requestedAt: new Date().toISOString(),
    });
    const configured = slice.repositoryContents?.[key];
    if (!configured || typeof configured.content !== 'string') {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    const { responseStatus = 200, responseHeaders = {}, content } = configured;
    const etag = responseHeaders.etag;
    if (etag && request.headers['if-none-match'] === etag) {
      response.writeHead(304, responseHeaders);
      response.end();
      return true;
    }
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    jsonResponse(
      response,
      responseStatus,
      {
        type: 'file',
        encoding: 'base64',
        size: Buffer.byteLength(content, 'utf8'),
        name: filePath.split('/').pop(),
        path: filePath,
        sha: ref,
        content: encoded,
      },
      responseHeaders,
    );
    return true;
  }

  // GET /repos/:owner/:repo/actions/runs/:runId/attempts/:attempt/jobs
  const workflowRunJobsMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(
      pathname,
    );
  if (workflowRunJobsMatch) {
    const [, owner, repo, runId, attempt] = workflowRunJobsMatch;
    const key = `${owner}/${repo}/${runId}/${attempt}`;
    const configured = slice.workflowRunJobs?.[key];
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const perPage = Math.max(
      1,
      Math.min(100, Number(url.searchParams.get('per_page') ?? '30')),
    );
    slice.workflowRunJobRequests ??= [];
    slice.workflowRunJobRequests.push({
      key,
      page,
      perPage,
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      requestedAt: new Date().toISOString(),
    });
    if (!configured || !Array.isArray(configured.jobs)) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    const {
      responseStatus = 200,
      responseHeaders = {},
      total_count: totalCount = configured.jobs.length,
      jobs,
    } = configured;
    const etag = responseHeaders.etag;
    if (etag && request.headers['if-none-match'] === etag) {
      response.writeHead(304, responseHeaders);
      response.end();
      return true;
    }
    const offset = (page - 1) * perPage;
    jsonResponse(
      response,
      responseStatus,
      {
        total_count: totalCount,
        jobs: jobs.slice(offset, offset + perPage),
      },
      responseHeaders,
    );
    return true;
  }

  // GET /repos/:owner/:repo/actions/runs/:runId/attempts/:attempt
  const workflowRunAttemptMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(
      pathname,
    );
  if (workflowRunAttemptMatch) {
    const [, owner, repo, runId, attempt] = workflowRunAttemptMatch;
    const configured = workflowRunResponse(slice, owner, repo, runId, attempt);
    if (!configured) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    slice.workflowRunRequests ??= [];
    slice.workflowRunRequests.push({
      key: configured.key,
      attempt: Number(attempt),
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      requestedAt: new Date().toISOString(),
    });
    const etag = configured.responseHeaders.etag;
    if (etag && request.headers['if-none-match'] === etag) {
      response.writeHead(304, configured.responseHeaders);
      response.end();
      return true;
    }
    jsonResponse(
      response,
      configured.responseStatus,
      configured.body,
      configured.responseHeaders,
    );
    return true;
  }

  // GET /repos/:owner/:repo/actions/runs/:runId
  const workflowRunMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/.exec(pathname);
  if (workflowRunMatch) {
    const [, owner, repo, runId] = workflowRunMatch;
    const configured = workflowRunResponse(slice, owner, repo, runId);
    if (!configured) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    slice.workflowRunRequests ??= [];
    slice.workflowRunRequests.push({
      key: configured.key,
      ifNoneMatch: request.headers['if-none-match'] ?? null,
      requestedAt: new Date().toISOString(),
    });
    if (configured.responseDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, configured.responseDelayMs),
      );
    }
    const etag = configured.responseHeaders.etag;
    if (etag && request.headers['if-none-match'] === etag) {
      response.writeHead(304, configured.responseHeaders);
      response.end();
      return true;
    }
    jsonResponse(
      response,
      configured.responseStatus,
      configured.body,
      configured.responseHeaders,
    );
    return true;
  }

  // GET /repos/:owner/:repo/commits/:sha
  const commitMatch = /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)$/.exec(
    pathname,
  );
  if (commitMatch) {
    const [, owner, repo, sha] = commitMatch;
    const key = `${owner}/${repo}/${sha}`;
    slice.commitRequests ??= [];
    slice.commitRequests.push({ key, requestedAt: new Date().toISOString() });
    const configured = slice.commits === true ? { sha } : slice.commits?.[key];
    if (!configured) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    const { responseStatus = 200, responseHeaders = {}, ...body } = configured;
    jsonResponse(response, responseStatus, { sha, ...body }, responseHeaders);
    return true;
  }

  // GET /repos/:owner/:repo/commits/:sha/check-runs
  const checkRunsMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/check-runs$/.exec(pathname);
  if (checkRunsMatch) {
    const headSha = checkRunsMatch[3];
    const checkRuns = resolveCheckRuns(slice, headSha);
    jsonResponse(response, 200, {
      total_count: checkRuns.length,
      check_runs: checkRuns,
    });
    return true;
  }

  // GET /repos/:owner/:repo/pulls/:number/reviews
  const reviewsMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/.exec(pathname);
  if (reviewsMatch) {
    jsonResponse(response, 200, resolveReviews(slice));
    return true;
  }

  // GET /repos/:owner/:repo/pulls/:number/comments  (review comments)
  const reviewCommentsMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments$/.exec(pathname);
  if (reviewCommentsMatch) {
    jsonResponse(response, 200, slice.comments ?? []);
    return true;
  }

  // GET /repos/:owner/:repo/issues/:number/comments  (issue comments on the PR)
  const issueCommentsMatch =
    /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(pathname);
  if (issueCommentsMatch) {
    jsonResponse(response, 200, slice.issueComments ?? []);
    return true;
  }

  // GET /repos/:owner/:repo/issues/:number  (issues and pull requests)
  const issueMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(
    pathname,
  );
  if (issueMatch) {
    const [, owner, repo, number] = issueMatch;
    const target = `${owner}/${repo}/${number}`;
    const configured = slice.issues?.[target];
    await respondReference(
      request,
      response,
      `githubIssue:${target}`,
      configured ? { number: Number(number), ...configured } : null,
    );
    return true;
  }

  // GET /repos/:owner/:repo/pulls/:number
  const pullMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(pathname);
  if (pullMatch) {
    const owner = pullMatch[1];
    const repo = pullMatch[2];
    const number = Number(pullMatch[3]);
    const pulls = resolvePulls(slice, owner, repo);
    const pr = pulls.find((entry) => entry.number === number);
    if (!pr) {
      jsonResponse(response, 404, { message: 'Not Found' });
      return true;
    }
    jsonResponse(response, 200, pr);
    return true;
  }

  // GET /repos/:owner/:repo/pulls
  const pullsMatch = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(pathname);
  if (pullsMatch) {
    const owner = pullsMatch[1];
    const repo = pullsMatch[2];
    let pulls = resolvePulls(slice, owner, repo).filter((pr) =>
      pullBelongsToRepository(pr, owner, repo),
    );
    const state = url.searchParams.get('state');
    if (state && state !== 'all')
      pulls = pulls.filter((pr) => pr.state === state);
    if (url.searchParams.get('sort') === 'updated') {
      const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
      pulls = [...pulls].sort(
        (a, b) =>
          direction * (Date.parse(a.updated_at) - Date.parse(b.updated_at)),
      );
    }
    if (url.searchParams.has('per_page') || url.searchParams.has('page')) {
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
      const perPage = Math.max(
        1,
        Math.min(100, Number(url.searchParams.get('per_page') ?? '30')),
      );
      pulls = pulls.slice((page - 1) * perPage, page * perPage);
    }
    jsonResponse(response, 200, pulls);
    return true;
  }

  return false;
}
