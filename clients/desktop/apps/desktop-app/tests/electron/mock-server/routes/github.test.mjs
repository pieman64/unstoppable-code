import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  getScenarioActivity,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import {
  GITHUB_FALLBACK_SCENARIO_KEY,
  handleGithubRequest,
} from './github.mjs';
import { handleLinearRequest } from './linear.mjs';

function startServer({ linearFallback = false } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void Promise.resolve(handleGithubRequest(request, response, url)).then(
      async (handled) => {
        if (!handled && linearFallback) {
          handled = await handleLinearRequest(request, response, url);
        }
        if (!handled) response.writeHead(404).end('not handled');
      },
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('GitHub mock server did not bind a TCP port.');
      }
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function workflowRun(overrides = {}) {
  return {
    status: 'queued',
    conclusion: null,
    run_attempt: 1,
    html_url: 'https://github.com/acme/api/actions/runs/123',
    name: 'CI',
    run_number: 8,
    ...overrides,
  };
}

test('commit mock distinguishes a configured pushed commit from a missing one', async () => {
  resetAll();
  const token = 'ghp_commit_mock';
  const sha = 'a'.repeat(40);
  registerScenario(token, {
    github: { commits: { [`acme/api/${sha}`]: { sha } } },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  try {
    const pushed = await fetch(`${base}/repos/acme/api/commits/${sha}`, {
      headers,
    });
    assert.equal(pushed.status, 200);
    assert.equal((await pushed.json()).sha, sha);

    const missing = await fetch(
      `${base}/repos/acme/api/commits/${'b'.repeat(40)}`,
      { headers },
    );
    assert.equal(missing.status, 404);

    registerScenario(token, { github: { commits: true } });
    const anyPushed = await fetch(
      `${base}/repos/acme/api/commits/${'c'.repeat(40)}`,
      { headers },
    );
    assert.equal(anyPushed.status, 200);
  } finally {
    server.close();
  }
});

test('workflow-run mock supports conditional 200 → 304 → changed 200', async () => {
  resetAll();
  const token = 'ghp_workflow_mock';
  registerScenario(token, {
    github: {
      workflowRuns: {
        'acme/api/123': workflowRun({
          responseHeaders: { etag: '"queued"', 'x-poll-interval': '7' },
        }),
      },
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  try {
    const first = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers,
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('etag'), '"queued"');
    assert.equal(first.headers.get('x-poll-interval'), '7');
    assert.equal((await first.json()).status, 'queued');

    const unchanged = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers: { ...headers, 'if-none-match': '"queued"' },
    });
    assert.equal(unchanged.status, 304);

    registerScenario(token, {
      github: {
        workflowRuns: {
          'acme/api/123': workflowRun({
            status: 'completed',
            conclusion: 'failure',
            responseHeaders: { etag: '"failure"' },
          }),
        },
      },
    });
    const changed = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers: { ...headers, 'if-none-match': '"queued"' },
    });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).conclusion, 'failure');
  } finally {
    server.close();
  }
});

test('workflow-run mock exposes error status and rate-limit headers', async () => {
  resetAll();
  const token = 'ghp_workflow_errors';
  registerScenario(token, {
    github: {
      workflowRuns: {
        'acme/api/123': workflowRun({
          responseStatus: 403,
          responseHeaders: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '2000000000',
          },
          message: 'API rate limit exceeded',
        }),
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
    assert.equal((await response.json()).message, 'API rate limit exceeded');

    const missing = await fetch(`${base}/repos/acme/api/actions/runs/999`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('workflow-run mock supports explicit attempts and job parent resolution', async () => {
  resetAll();
  const token = 'ghp_workflow_attempt_job';
  registerScenario(token, {
    github: {
      workflowRuns: {
        'acme/api/123/2': workflowRun({
          run_attempt: 2,
          status: 'in_progress',
          responseHeaders: { etag: '"attempt-2"' },
        }),
      },
      workflowJobs: {
        'acme/api/456': {
          id: 456,
          run_id: 123,
          run_url: 'https://api.github.com/repos/acme/api/actions/runs/123',
        },
      },
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  try {
    const attempt = await fetch(
      `${base}/repos/acme/api/actions/runs/123/attempts/2`,
      { headers },
    );
    assert.equal(attempt.status, 200);
    assert.equal(attempt.headers.get('etag'), '"attempt-2"');
    assert.equal((await attempt.json()).run_attempt, 2);

    const job = await fetch(`${base}/repos/acme/api/actions/jobs/456`, {
      headers,
    });
    assert.equal(job.status, 200);
    assert.deepEqual(await job.json(), {
      id: 456,
      run_id: 123,
      run_url: 'https://api.github.com/repos/acme/api/actions/runs/123',
    });
  } finally {
    server.close();
  }
});

test('workflow-run mock supports exact-attempt job pages and conditional reads', async () => {
  resetAll();
  const token = 'ghp_workflow_run_jobs';
  registerScenario(token, {
    github: {
      workflowRunJobs: {
        'acme/api/123/2': {
          jobs: [
            { id: 1, name: 'Build', status: 'completed' },
            { id: 2, name: 'Test', status: 'in_progress' },
          ],
          responseHeaders: { etag: '"jobs-2"' },
        },
      },
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  const url = `${base}/repos/acme/api/actions/runs/123/attempts/2/jobs?per_page=1&page=2`;
  try {
    const first = await fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('etag'), '"jobs-2"');
    assert.deepEqual(await first.json(), {
      total_count: 2,
      jobs: [{ id: 2, name: 'Test', status: 'in_progress' }],
    });

    const unchanged = await fetch(url, {
      headers: { ...headers, 'if-none-match': '"jobs-2"' },
    });
    assert.equal(unchanged.status, 304);
  } finally {
    server.close();
  }
});

test('workflow-run mock uses the opt-in fallback without overriding a keyed scenario', async () => {
  resetAll();
  registerScenario(GITHUB_FALLBACK_SCENARIO_KEY, {
    github: {
      workflowRuns: {
        'acme/api/123': workflowRun({ status: 'in_progress' }),
      },
    },
  });
  registerScenario('keyed-token', {
    github: {
      workflowRuns: {
        'acme/api/123': workflowRun({
          status: 'completed',
          conclusion: 'success',
        }),
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const fallback = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers: { authorization: 'token opaque-safe-storage-value' },
    });
    assert.equal((await fallback.json()).status, 'in_progress');

    const keyed = await fetch(`${base}/repos/acme/api/actions/runs/123`, {
      headers: { authorization: 'token keyed-token' },
    });
    const keyedBody = await keyed.json();
    assert.equal(keyedBody.status, 'completed');
    assert.equal(keyedBody.conclusion, 'success');
  } finally {
    server.close();
  }
});

test('repository contents mock serves pinned workflow files as base64 and records reads', async () => {
  resetAll();
  const { server, base } = await startServer();
  try {
    const sha = 'a'.repeat(40);
    registerScenario('ghp_contents', {
      github: {
        repositoryContents: {
          [`acme/api/.github/workflows/ci.yml@${sha}`]: {
            content: 'jobs:\n  build:\n    steps: []\n',
            responseHeaders: { etag: '"ci"' },
          },
        },
      },
    });
    const headers = { authorization: 'Bearer ghp_contents' };
    const encodedPath = encodeURIComponent('.github/workflows/ci.yml');
    const first = await fetch(
      `${base}/repos/acme/api/contents/${encodedPath}?ref=${sha}`,
      { headers },
    );
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.type, 'file');
    assert.equal(body.encoding, 'base64');
    assert.equal(
      Buffer.from(body.content, 'base64').toString('utf8'),
      'jobs:\n  build:\n    steps: []\n',
    );
    const cached = await fetch(
      `${base}/repos/acme/api/contents/.github/workflows/ci.yml?ref=${sha}`,
      { headers: { ...headers, 'if-none-match': '"ci"' } },
    );
    assert.equal(cached.status, 304);
    const missing = await fetch(
      `${base}/repos/acme/api/contents/.github/workflows/other.yml?ref=${sha}`,
      { headers },
    );
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

async function postForm(base, path, fields) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(fields).toString(),
  });
  return response.json();
}

test('device flow stays pending until approved, then issues the scenario key as the token', async () => {
  const { server, base } = await startServer();
  try {
    const started = await postForm(base, '/login/device/code', {
      client_id: 'Iv23test',
    });
    assert.match(started.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(started.verification_uri, `${base}/login/device`);
    const poll = {
      client_id: 'Iv23test',
      device_code: started.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    assert.deepEqual(await postForm(base, '/login/oauth/access_token', poll), {
      error: 'authorization_pending',
    });
    const approve = await fetch(`${base}/__mock/github/device/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_code: started.user_code,
        key: 'ghu_e2e_copilot-fixture',
      }),
    });
    assert.equal(approve.status, 200);
    const granted = await postForm(base, '/login/oauth/access_token', poll);
    assert.equal(granted.access_token, 'ghu_e2e_copilot-fixture');
    assert.equal(granted.refresh_token, 'ghr_e2e_ghu_e2e_copilot-fixture');
    const refreshed = await postForm(base, '/login/oauth/access_token', {
      client_id: 'Iv23test',
      grant_type: 'refresh_token',
      refresh_token: granted.refresh_token,
    });
    assert.equal(refreshed.access_token, 'ghu_e2e_copilot-fixture');
    const rejected = await postForm(base, '/login/oauth/access_token', {
      client_id: 'Iv23test',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_bad',
    });
    assert.deepEqual(rejected, { error: 'bad_refresh_token' });
  } finally {
    server.close();
  }
});

test('device flow reports denial and unknown codes', async () => {
  const { server, base } = await startServer();
  try {
    const started = await postForm(base, '/login/device/code', {
      client_id: 'Iv23test',
    });
    await fetch(`${base}/__mock/github/device/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_code: started.user_code }),
    });
    const poll = {
      client_id: 'Iv23test',
      device_code: started.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    assert.deepEqual(await postForm(base, '/login/oauth/access_token', poll), {
      error: 'access_denied',
    });
    assert.deepEqual(
      await postForm(base, '/login/oauth/access_token', {
        ...poll,
        device_code: 'nope',
      }),
      { error: 'expired_token' },
    );
  } finally {
    server.close();
  }
});

test('external-open capture records and lists URLs', async () => {
  const { server, base } = await startServer();
  try {
    await fetch(`${base}/__mock/github/external-open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/login/device' }),
    });
    const listed = await (
      await fetch(`${base}/__mock/github/external-open`)
    ).json();
    assert.ok(listed.urls.includes('https://example.test/login/device'));
  } finally {
    server.close();
  }
});

test('graphql mock answers the merge queue query only for opted-in Octokit requests', async () => {
  resetAll();
  const token = 'ghp_merge_queue_mock';
  const { server, base } = await startServer();
  const post = (headers) =>
    fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query: 'query { repository { id } }' }),
    });
  const octokitHeaders = {
    authorization: `token ${token}`,
    'user-agent': 'octokit-rest.js/22.0.0',
  };
  try {
    // No `mergeQueue` in the scenario: left unhandled, as before.
    registerScenario(token, { github: { variant: 'open-pr' } });
    assert.equal((await post(octokitHeaders)).status, 404);

    registerScenario(token, {
      github: {
        variant: 'open-pr',
        mergeQueue: { enabled: true, inQueue: true, position: 3 },
      },
    });
    // Linear shares the `/graphql` path; a non-Octokit client is left alone.
    assert.equal(
      (await post({ authorization: `token ${token}`, 'user-agent': 'linear' }))
        .status,
      404,
    );

    const queued = await post(octokitHeaders);
    assert.equal(queued.status, 200);
    assert.deepEqual((await queued.json()).data.repository.pullRequest, {
      id: 'PR_mock_merge_queue',
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: { position: 3, state: 'QUEUED' },
      reviewThreads: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    registerScenario(token, {
      github: { variant: 'open-pr', mergeQueue: { enabled: true } },
    });
    const notQueued = await (await post(octokitHeaders)).json();
    assert.equal(notQueued.data.repository.pullRequest.isInMergeQueue, false);
    assert.equal(notQueued.data.repository.pullRequest.mergeQueueEntry, null);
  } finally {
    server.close();
  }
});

// Mirrors `WATCHED_PULL_REQUEST_QUERY` in
// src/main/lib/github-broker/pull-requests.ts.
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
        queueEvents: timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 10) {
          filteredCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { id createdAt }
            ... on RemovedFromMergeQueueEvent { id createdAt reason }
          }
        }
      }
    }
  }
`;

// Mirrors `PULL_REQUEST_QUEUE_HISTORY_QUERY` in
// src/main/lib/github-broker/pull-requests.ts.
const PULL_REQUEST_QUEUE_HISTORY_QUERY = `
  query ($owner: String!, $name: String!, $number: Int!, $before: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        queueEvents: timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT], last: 50, before: $before) {
          filteredCount
          pageInfo { hasPreviousPage startCursor }
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { id createdAt }
            ... on RemovedFromMergeQueueEvent { id createdAt reason }
          }
        }
      }
    }
  }
`;

// Mirrors the PR status poller's `REVIEW_THREADS_QUERY` in
// src/main/lib/github-pr.ts.
const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        isMergeQueueEnabled
        isInMergeQueue
        mergeQueueEntry { position state }
        reviewThreads(first: 100, after: $cursor) {
          nodes { isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function graphqlPost(base, token, query, variables) {
  return fetch(`${base}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `token ${token}`,
      'user-agent': 'octokit-core.js/7.0.0',
    },
    body: JSON.stringify({ query, variables }),
  });
}

function watchedRead(base, token, number, repository = 'acme/api') {
  const [owner, name] = repository.split('/');
  return graphqlPost(base, token, WATCHED_PULL_REQUEST_QUERY, {
    owner,
    name,
    number,
  });
}

test('graphql mock answers the pull request watcher query from `pullRequests`', async () => {
  resetAll();
  const token = 'ghp_pull_request_watcher_mock';
  const scenario = {
    github: {
      pullRequests: {
        'acme/api/7': { title: 'Open change' },
        'acme/api/8': { state: 'MERGED', baseRefName: 'develop' },
        'acme/api/9': { state: 'CLOSED', closedAt: '2026-07-20T00:09:00Z' },
      },
    },
  };
  registerScenario(token, scenario);
  const { server, base } = await startServer();
  try {
    const open = await watchedRead(base, token, 7);
    assert.equal(open.status, 200);
    assert.deepEqual(await open.json(), {
      data: {
        repository: {
          pullRequest: {
            id: 'PR_watched_7',
            state: 'OPEN',
            merged: false,
            mergedAt: null,
            closedAt: null,
            url: 'https://github.com/acme/api/pull/7',
            title: 'Open change',
            baseRefName: 'main',
            headRefOid: 'a'.repeat(40),
            mergeCommit: null,
            isInMergeQueue: false,
            mergeQueueEntry: null,
            queueEvents: {
              filteredCount: 0,
              pageInfo: { hasPreviousPage: false, startCursor: null },
              nodes: [],
            },
          },
        },
      },
    });

    const merged = (await (await watchedRead(base, token, 8)).json()).data
      .repository.pullRequest;
    assert.equal(merged.state, 'MERGED');
    assert.equal(merged.merged, true);
    assert.equal(merged.mergedAt, '2026-07-20T00:05:00Z');
    assert.equal(merged.closedAt, '2026-07-20T00:05:00Z');
    assert.deepEqual(merged.mergeCommit, { oid: 'c'.repeat(40) });
    assert.equal(merged.baseRefName, 'develop');

    const closed = (await (await watchedRead(base, token, 9)).json()).data
      .repository.pullRequest;
    assert.equal(closed.state, 'CLOSED');
    assert.equal(closed.merged, false);
    assert.equal(closed.mergedAt, null);
    assert.equal(closed.closedAt, '2026-07-20T00:09:00Z');
    assert.equal(closed.mergeCommit, null);

    // An unconfigured number answers as GitHub does: null data, NOT_FOUND.
    const unknown = await watchedRead(base, token, 404);
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.data.repository.pullRequest, null);
    assert.equal(unknownBody.errors[0].type, 'NOT_FOUND');

    assert.deepEqual(
      scenario.github.pullRequestRequests.map((entry) => entry.key),
      ['acme/api/7', 'acme/api/8', 'acme/api/9', 'acme/api/404'],
    );
  } finally {
    server.close();
  }
});

test('graphql mock serves watcher errors, partial data, omissions, and delays', async () => {
  resetAll();
  const token = 'ghp_pull_request_watcher_errors';
  registerScenario(token, {
    github: {
      pullRequests: {
        // Partial data: a merge alongside a GraphQL error.
        'acme/api/1': {
          state: 'MERGED',
          errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Try again' }],
        },
        // A required non-null field is missing.
        'acme/api/2': { state: 'MERGED', omit: ['merged', 'mergeCommit'] },
        // No data at all, with a transient error.
        'acme/api/3': {
          missing: true,
          errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'Try again' }],
        },
        'acme/api/4': { missing: true },
        'acme/api/5': {
          responseStatus: 502,
          responseHeaders: { 'x-github-request-id': 'mock-502' },
        },
        'acme/api/6': { responseDelayMs: 150 },
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const partial = await (await watchedRead(base, token, 1)).json();
    assert.equal(partial.data.repository.pullRequest.state, 'MERGED');
    assert.deepEqual(partial.errors, [
      { type: 'SERVICE_UNAVAILABLE', message: 'Try again' },
    ]);

    const omitted = (await (await watchedRead(base, token, 2)).json()).data
      .repository.pullRequest;
    assert.equal(omitted.state, 'MERGED');
    assert.equal('merged' in omitted, false);
    assert.equal('mergeCommit' in omitted, false);

    const dataless = await (await watchedRead(base, token, 3)).json();
    assert.equal(dataless.data.repository.pullRequest, null);
    assert.equal(dataless.errors[0].type, 'SERVICE_UNAVAILABLE');

    const missing = await (await watchedRead(base, token, 4)).json();
    assert.equal(missing.data.repository.pullRequest, null);
    assert.equal(missing.errors[0].type, 'NOT_FOUND');

    const unavailable = await watchedRead(base, token, 5);
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.headers.get('x-github-request-id'), 'mock-502');

    const startedAt = Date.now();
    const delayed = await watchedRead(base, token, 6);
    assert.equal(delayed.status, 200);
    assert.ok(Date.now() - startedAt >= 140);
  } finally {
    server.close();
  }
});

test('graphql mock keeps the status poller query on its merge-queue path', async () => {
  resetAll();
  const token = 'ghp_pull_request_watcher_status_poller';
  const variables = { owner: 'acme', repo: 'api', number: 7, cursor: null };
  const { server, base } = await startServer();
  try {
    // Without `pullRequests`, both queries behave exactly as before.
    registerScenario(token, { github: { variant: 'open-pr' } });
    assert.equal((await watchedRead(base, token, 7)).status, 404);
    registerScenario(token, {
      github: { mergeQueue: { enabled: true, inQueue: true, position: 2 } },
    });
    const legacyWatcherRead = await (await watchedRead(base, token, 7)).json();
    assert.equal(
      legacyWatcherRead.data.repository.pullRequest.id,
      'PR_mock_merge_queue',
    );

    // With `pullRequests`, the status poller query keeps its merge-queue
    // answer and is not recorded as a watcher read.
    const scenario = {
      github: {
        mergeQueue: { enabled: true, inQueue: true, position: 2 },
        pullRequests: { 'acme/api/7': { state: 'OPEN' } },
      },
    };
    registerScenario(token, scenario);
    const poller = await graphqlPost(
      base,
      token,
      REVIEW_THREADS_QUERY,
      variables,
    );
    assert.equal(poller.status, 200);
    assert.deepEqual((await poller.json()).data.repository.pullRequest, {
      id: 'PR_mock_merge_queue',
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: { position: 2, state: 'QUEUED' },
      reviewThreads: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    assert.equal(scenario.github.pullRequestRequests, undefined);

    // Without `mergeQueue`, the consumed poller body gets the same empty
    // answer the Linear fallthrough gives an anonymous query.
    registerScenario(token, {
      github: { pullRequests: { 'acme/api/7': { state: 'OPEN' } } },
    });
    const fallthrough = await graphqlPost(
      base,
      token,
      REVIEW_THREADS_QUERY,
      variables,
    );
    assert.equal(fallthrough.status, 200);
    assert.deepEqual(await fallthrough.json(), { data: {} });

    // Linear shares `/graphql`; a non-Octokit client is still left alone.
    const linear = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `token ${token}`,
        'user-agent': 'linear',
      },
      body: JSON.stringify({
        query: WATCHED_PULL_REQUEST_QUERY,
        variables: { owner: 'acme', name: 'api', number: 7 },
      }),
    });
    assert.equal(linear.status, 404);
  } finally {
    server.close();
  }
});

function historyRead(base, token, number, before, repository = 'acme/api') {
  const [owner, name] = repository.split('/');
  return graphqlPost(base, token, PULL_REQUEST_QUEUE_HISTORY_QUERY, {
    owner,
    name,
    number,
    before,
  });
}

function queueTimeline(count) {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 2 === 0 ? 'added' : 'removed',
    id: `${index % 2 === 0 ? 'ATMQE' : 'RFMQE'}_${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(),
    ...(index % 2 === 1 && index > 1 ? { reason: 'failed_checks' } : {}),
  }));
}

test('graphql mock serves merge queue timeline windows and history pages', async () => {
  resetAll();
  const token = 'ghp_pull_request_queue_timeline';
  const scenario = {
    github: {
      pullRequests: {
        'acme/api/7': {},
        'acme/api/8': { queueTimeline: queueTimeline(13) },
        'acme/api/9': { queueTimeline: queueTimeline(120) },
      },
    },
  };
  registerScenario(token, scenario);
  const { server, base } = await startServer();
  try {
    // No timeline configured: an empty, complete timeline.
    const empty = (await (await watchedRead(base, token, 7)).json()).data
      .repository.pullRequest.queueEvents;
    assert.deepEqual(empty, {
      filteredCount: 0,
      pageInfo: { hasPreviousPage: false, startCursor: null },
      nodes: [],
    });

    // The newest `last: 10` window, with GitHub-shaped nodes.
    const window = (await (await watchedRead(base, token, 8)).json()).data
      .repository.pullRequest.queueEvents;
    assert.equal(window.filteredCount, 13);
    assert.deepEqual(window.pageInfo, {
      hasPreviousPage: true,
      startCursor: 'mq-cursor:3',
    });
    assert.equal(window.nodes.length, 10);
    assert.deepEqual(window.nodes[0], {
      __typename: 'RemovedFromMergeQueueEvent',
      id: 'RFMQE_3',
      createdAt: '2026-10-01T00:03:00.000Z',
      reason: 'failed_checks',
    });
    assert.deepEqual(window.nodes[9], {
      __typename: 'AddedToMergeQueueEvent',
      id: 'ATMQE_12',
      createdAt: '2026-10-01T00:12:00.000Z',
    });

    // A `before:` page counts only the items before its cursor.
    const head = (
      await (await historyRead(base, token, 8, 'mq-cursor:3')).json()
    ).data.repository.pullRequest;
    assert.deepEqual(Object.keys(head), ['queueEvents']);
    assert.equal(head.queueEvents.filteredCount, 3);
    assert.deepEqual(head.queueEvents.pageInfo, {
      hasPreviousPage: false,
      startCursor: 'mq-cursor:0',
    });
    assert.deepEqual(
      head.queueEvents.nodes.map((node) => [node.id, node.reason]),
      [
        ['ATMQE_0', undefined],
        ['RFMQE_1', null],
        ['ATMQE_2', undefined],
      ],
    );

    const long = (await (await watchedRead(base, token, 9)).json()).data
      .repository.pullRequest.queueEvents;
    assert.equal(long.pageInfo.startCursor, 'mq-cursor:110');
    const older = (
      await (await historyRead(base, token, 9, 'mq-cursor:110')).json()
    ).data.repository.pullRequest.queueEvents;
    assert.equal(older.filteredCount, 110);
    assert.equal(older.nodes.length, 50);
    assert.equal(older.nodes[0].id, 'ATMQE_60');
    assert.equal(older.nodes[49].id, 'RFMQE_109');
    assert.deepEqual(older.pageInfo, {
      hasPreviousPage: true,
      startCursor: 'mq-cursor:60',
    });
    const exhausted = (
      await (await historyRead(base, token, 9, 'mq-cursor:0')).json()
    ).data.repository.pullRequest.queueEvents;
    assert.deepEqual(exhausted, {
      filteredCount: 0,
      pageInfo: { hasPreviousPage: false, startCursor: null },
      nodes: [],
    });

    // History pages are recorded apart from lifecycle reads.
    assert.deepEqual(
      scenario.github.pullRequestRequests.map((entry) => entry.key),
      ['acme/api/7', 'acme/api/8', 'acme/api/9'],
    );
    assert.deepEqual(
      scenario.github.pullRequestHistoryRequests.map((entry) => [
        entry.key,
        entry.before,
      ]),
      [
        ['acme/api/8', 'mq-cursor:3'],
        ['acme/api/9', 'mq-cursor:110'],
        ['acme/api/9', 'mq-cursor:0'],
      ],
    );
  } finally {
    server.close();
  }
});

test('graphql mock serves merge queue timeline omissions and errors', async () => {
  resetAll();
  const token = 'ghp_pull_request_queue_timeline_errors';
  const timelineError = {
    type: 'SERVICE_UNAVAILABLE',
    path: ['repository', 'pullRequest', 'queueEvents'],
    message: 'Timeline unavailable',
  };
  const titleError = {
    type: 'SERVICE_UNAVAILABLE',
    path: ['repository', 'pullRequest', 'title'],
    message: 'Try again',
  };
  registerScenario(token, {
    github: {
      pullRequests: {
        'acme/api/1': {
          queueTimeline: queueTimeline(3),
          queueTimelineOmit: true,
        },
        'acme/api/2': {
          state: 'MERGED',
          queueTimeline: queueTimeline(3),
          queueTimelineErrors: [timelineError],
        },
        'acme/api/3': {
          errors: [titleError],
          queueTimelineErrors: [timelineError],
        },
        'acme/api/4': { queueTimeline: queueTimeline(3) },
        'acme/api/5': { missing: true },
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const omitted = (await (await watchedRead(base, token, 1)).json()).data
      .repository.pullRequest;
    assert.equal('queueEvents' in omitted, false);
    assert.equal(omitted.mergeQueueEntry, null);
    const omittedHistory = await (
      await historyRead(base, token, 1, 'mq-cursor:1')
    ).json();
    assert.deepEqual(omittedHistory, {
      data: { repository: { pullRequest: {} } },
    });

    const errored = await (await watchedRead(base, token, 2)).json();
    assert.equal(errored.data.repository.pullRequest.state, 'MERGED');
    assert.equal(errored.data.repository.pullRequest.queueEvents, null);
    assert.deepEqual(errored.errors, [timelineError]);
    const erroredHistory = await (
      await historyRead(base, token, 2, 'mq-cursor:1')
    ).json();
    assert.deepEqual(erroredHistory, {
      data: { repository: { pullRequest: { queueEvents: null } } },
      errors: [timelineError],
    });

    const mixed = await (await watchedRead(base, token, 3)).json();
    assert.deepEqual(mixed.errors, [titleError, timelineError]);

    const badCursor = await (
      await historyRead(base, token, 4, 'not-a-cursor')
    ).json();
    assert.equal(badCursor.data.repository.pullRequest.queueEvents, null);
    assert.equal(badCursor.errors[0].type, 'INVALID_CURSOR_ARGUMENTS');
    assert.deepEqual(badCursor.errors[0].path, timelineError.path);

    for (const number of [5, 404]) {
      const missing = await (
        await historyRead(base, token, number, 'mq-cursor:0')
      ).json();
      assert.equal(missing.data.repository.pullRequest, null);
      assert.equal(missing.errors[0].type, 'NOT_FOUND');
    }
  } finally {
    server.close();
  }
});

test('graphql mock keeps a query without the timeline byte-for-byte', async () => {
  resetAll();
  const token = 'ghp_pull_request_queue_timeline_legacy';
  registerScenario(token, {
    github: {
      pullRequests: { 'acme/api/7': { queueTimeline: queueTimeline(3) } },
    },
  });
  const { server, base } = await startServer();
  try {
    const legacy = await graphqlPost(
      base,
      token,
      WATCHED_PULL_REQUEST_QUERY.replace(
        /\n\s*queueEvents:[\s\S]*?\n {8}\}\n/,
        '\n',
      ),
      { owner: 'acme', name: 'api', number: 7 },
    );
    assert.equal(
      await legacy.text(),
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: 'PR_watched_7',
              state: 'OPEN',
              merged: false,
              mergedAt: null,
              closedAt: null,
              url: 'https://github.com/acme/api/pull/7',
              title: 'Mock pull request #7',
              baseRefName: 'main',
              headRefOid: 'a'.repeat(40),
              mergeCommit: null,
              isInMergeQueue: false,
              mergeQueueEntry: null,
            },
          },
        },
      }),
    );
  } finally {
    server.close();
  }
});

test('per-PR GraphQL scenarios isolate PATs and verify repository and PR identity', async () => {
  resetAll();
  const scenario = {
    github: {
      variant: 'open-pr',
      graphqlPullRequests: {
        101: {
          isMergeQueueEnabled: true,
          isInMergeQueue: false,
          reviewThreads: {
            nodes: [{ isResolved: false }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
  registerScenario('queue-pat', scenario);
  registerScenario('standard-pat', {
    github: { variant: 'open-pr', graphqlPullRequests: {} },
  });
  const { server, base } = await startServer();
  const post = async (token, number = 101, repo = 'api') => {
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `token ${token}`,
        'user-agent': 'octokit-rest.js/22',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'query PullRequest { repository { pullRequest { reviewThreads } } }',
        variables: { owner: 'acme', repo, number },
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data.repository.pullRequest;
  };
  try {
    const queued = await post('queue-pat');
    assert.equal(queued.isMergeQueueEnabled, true);
    assert.deepEqual(queued.reviewThreads.nodes, [{ isResolved: false }]);
    const standard = await post('standard-pat');
    assert.equal(standard.isMergeQueueEnabled, false);
    assert.equal(standard.isInMergeQueue, false);
    assert.deepEqual(standard.reviewThreads.nodes, []);
    assert.equal(await post('queue-pat', 999), null);
    registerScenario('identified-pat', {
      github: {
        pulls: [
          { number: 101, html_url: 'https://github.com/acme/api/pull/101' },
        ],
        graphqlPullRequests: {},
      },
    });
    assert.equal(await post('identified-pat', 101, 'other-repo'), null);
  } finally {
    server.close();
  }
});

test('direct merge endpoint records attempts and enforces the verified head SHA', async () => {
  resetAll();
  const scenario = { github: { variant: 'open-pr', mergeRequests: [] } };
  registerScenario('merge-pat', scenario);
  registerScenario('other-pat', {
    github: { variant: 'open-pr', mergeRequests: [] },
  });
  const { server, base } = await startServer();
  const merge = (sha) =>
    fetch(`${base}/repos/acme/api/pulls/101/merge`, {
      method: 'PUT',
      headers: {
        authorization: 'token merge-pat',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sha, merge_method: 'squash' }),
    });
  try {
    assert.equal((await merge('stale-head')).status, 409);
    const response = await merge('a'.repeat(40));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).merged, true);
    assert.equal(scenario.github.mergeRequests.length, 2);
    assert.equal(scenario.github.mergeRequests[1].sha, 'a'.repeat(40));
    assert.equal(scenario.github.mergeRequests[1].repo, 'api');
    const refreshed = await fetch(`${base}/repos/acme/api/pulls/101`, {
      headers: { authorization: 'token merge-pat' },
    });
    const mergedPr = await refreshed.json();
    assert.ok(mergedPr.merged_at);
    assert.equal(mergedPr.merged, true);
    assert.equal(
      (await import('../control-plane.mjs')).getScenario('other-pat').github
        .mergeRequests.length,
      0,
    );
  } finally {
    server.close();
  }
});

test('enqueue fixture observes the upstream baseline mutation and verifies its head', async () => {
  resetAll();
  const scenario = {
    github: {
      variant: 'open-pr',
      graphqlPullRequests: { 101: { isMergeQueueEnabled: true } },
    },
  };
  registerScenario('enqueue-pat', scenario);
  const { server, base } = await startServer();
  const enqueue = async (expectedHeadOid) => {
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        authorization: 'token enqueue-pat',
        'user-agent': 'octokit-rest.js/22',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query:
          'mutation { enqueuePullRequest(input: $input) { mergeQueueEntry { position } } }',
        variables: { pullRequestId: 'PR_open_101', expectedHeadOid },
      }),
    });
    return response.json();
  };
  try {
    {
      const rejected = await enqueue('stale');
      assert.ok(rejected.errors?.length);
    }
    const result = await enqueue('a'.repeat(40));
    assert.equal(result.data.enqueuePullRequest.mergeQueueEntry.position, 1);
    assert.equal(scenario.github.enqueueRequests.length, 2);
    assert.equal(scenario.github.graphqlPullRequests[101].isInMergeQueue, true);
  } finally {
    server.close();
  }
});

test('merge fixtures serve repository merge method capabilities', async () => {
  resetAll();
  registerScenario('settings-pat', { github: { variant: 'open-pr' } });
  const { server, base } = await startServer();
  try {
    const response = await fetch(`${base}/repos/acme/api`, {
      headers: { authorization: 'token settings-pat' },
    });
    assert.equal(response.status, 200);
    const repo = await response.json();
    assert.equal(repo.allow_merge_commit, true);
    assert.equal(repo.allow_squash_merge, true);
    assert.equal(repo.full_name, 'acme/api');
  } finally {
    server.close();
  }
});

test('reference preview reads serve issues and repositories, record activity, and honor holds', async () => {
  resetAll();
  const token = 'ghp_reference_previews';
  registerScenario(token, {
    github: {
      issues: {
        'acme/app/12': {
          title: 'Twelve',
          state: 'open',
          html_url: 'https://github.com/acme/app/issues/12',
          updated_at: '2026-10-01T00:00:00Z',
        },
      },
      repositories: {
        'acme/app': {
          description: 'The app',
          html_url: 'https://github.com/acme/app',
          private: false,
          archived: false,
          updated_at: '2026-10-01T00:00:00Z',
        },
      },
    },
  });
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  const hold = (held) =>
    fetch(`${base}/__mock/github/reference-holds/${token}`, {
      method: 'POST',
      body: JSON.stringify({ held }),
    }).then((response) => response.json());
  const holdState = () =>
    fetch(`${base}/__mock/github/reference-holds/${token}`).then((response) =>
      response.json(),
    );
  try {
    const issue = await fetch(`${base}/repos/acme/app/issues/12`, { headers });
    assert.equal(issue.status, 200);
    assert.deepEqual(await issue.json(), {
      number: 12,
      title: 'Twelve',
      state: 'open',
      html_url: 'https://github.com/acme/app/issues/12',
      updated_at: '2026-10-01T00:00:00Z',
    });
    const missing = await fetch(`${base}/repos/acme/app/issues/13`, {
      headers,
    });
    assert.equal(missing.status, 404);

    const repository = await (
      await fetch(`${base}/repos/acme/app`, { headers })
    ).json();
    assert.equal(repository.description, 'The app');
    assert.equal(repository.allow_merge_commit, true);
    // An unconfigured repository keeps the merge-capability default.
    const other = await (
      await fetch(`${base}/repos/acme/other`, { headers })
    ).json();
    assert.equal(other.description, undefined);

    assert.deepEqual(await hold(true), {
      ok: true,
      key: token,
      held: true,
      released: 0,
    });
    let settled = false;
    const held = fetch(`${base}/repos/acme/app/issues/12`, { headers }).then(
      (response) => {
        settled = true;
        return response;
      },
    );
    for (let attempt = 0; (await holdState()).waiting < 1; attempt += 1) {
      assert.ok(attempt < 50, 'the held read never arrived');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(settled, false);
    assert.equal((await hold(false)).released, 1);
    assert.equal((await held).status, 200);
    assert.deepEqual(await holdState(), {
      key: token,
      held: false,
      waiting: 0,
    });

    assert.deepEqual(getScenarioActivity(token), {
      'githubIssue:acme/app/12': 2,
      'githubIssue:acme/app/13': 1,
      'githubRepository:acme/app': 1,
    });
  } finally {
    await hold(false);
    server.close();
  }
});

test('PR picker search finds an older PR outside the first page with repository/open/title scope', async () => {
  resetAll();
  const token = 'ghp_pr_picker_search';
  const makePr = (number, title, repo = 'acme/api', state = 'open') => ({
    number,
    title,
    state,
    updated_at: new Date(Date.UTC(2025, 0, number)).toISOString(),
    html_url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    head: { ref: `branch-${number}`, repo: { full_name: repo } },
    base: { ref: 'main', repo: { full_name: repo } },
    user: null,
  });
  const scenario = {
    github: {
      pulls: [
        makePr(1, 'Older needle title'),
        ...Array.from({ length: 50 }, (_, i) => makePr(i + 2, 'Recent filler')),
        makePr(52, 'needle', 'other/repo'),
        makePr(53, 'needle', 'acme/api', 'closed'),
      ],
    },
  };
  registerScenario(token, scenario);
  const { server, base } = await startServer();
  const headers = { authorization: `token ${token}` };
  try {
    const first = await (
      await fetch(
        `${base}/repos/acme/api/pulls?sort=updated&direction=desc&per_page=50&page=1&state=open`,
        { headers },
      )
    ).json();
    assert.equal(first.length, 50);
    assert.ok(first.every((pr) => pr.number !== 1));
    const second = await (
      await fetch(
        `${base}/repos/acme/api/pulls?sort=updated&direction=desc&per_page=50&page=2&state=open`,
        { headers },
      )
    ).json();
    assert.deepEqual(
      second.map((pr) => pr.number),
      [1],
    );
    const search = async (q, first = 20) =>
      (
        await graphqlPost(
          base,
          token,
          `query PrPickerSearch($q: String!) { search(type: ISSUE, first: ${first}, query: $q) { nodes { __typename } } }`,
          { q },
        )
      ).json();
    const result = await search(
      'repo:acme/api is:pr is:open in:title "needle" "title"',
    );
    assert.deepEqual(result.data.search.nodes, [
      {
        __typename: 'PullRequest',
        number: 1,
        title: 'Older needle title',
        url: 'https://github.com/acme/api/pull/1',
        headRefName: 'branch-1',
        baseRefName: 'main',
        isDraft: false,
        author: null,
        headRepository: { nameWithOwner: 'acme/api' },
      },
    ]);
    assert.equal(
      (await search('repo:acme/api is:pr is:open in:title "missing"')).data
        .search.nodes.length,
      0,
    );
    assert.equal(
      (await search('repo:acme/api is:pr is:open in:title "filler"')).data
        .search.nodes.length,
      20,
    );
    assert.equal(
      (await search('repo:acme/api is:pr is:open in:title "filler"', 3)).data
        .search.nodes.length,
      3,
    );
    assert.equal(
      (await search('repo:other/repo is:pr is:open in:title "needle"')).data
        .search.nodes[0].number,
      52,
    );
    assert.equal(scenario.github.prPickerSearchRequests.length, 5);
    assert.equal(
      scenario.github.prPickerSearchRequests[0].q,
      'repo:acme/api is:pr is:open in:title "needle" "title"',
    );
    // Another ISSUE operation keeps the existing handler/fallthrough behavior.
    assert.equal(
      (
        await graphqlPost(
          base,
          token,
          'query Viewer { search(type: ISSUE, first: 20, query: "x") { nodes { __typename } } }',
          {},
        )
      ).status,
      404,
    );
  } finally {
    server.close();
  }
});

test('unhandled GitHub GraphQL operations preserve the body for the next route', async () => {
  resetAll();
  const token = 'ghp_graphql_fallthrough';
  registerScenario(token, { github: { pulls: [] } });
  const { server, base } = await startServer({ linearFallback: true });
  try {
    const result = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `token ${token}`,
        'user-agent': 'octokit',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: 'query Viewer { viewer { id } }' }),
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { data: {} });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
