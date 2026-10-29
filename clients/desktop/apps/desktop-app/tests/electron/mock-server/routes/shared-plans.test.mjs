import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  getScenarioActivity,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import {
  buildSharedPlanDetail,
  formatPlanDetailFrame,
  handleSharedPlansRequest,
  mergeWireCommentThreads,
  parseStreamCursor,
  SHARED_PLAN_MOCK_TEAM_OWNER,
} from './shared-plans.mjs';

const REMOTE_ID = '66666666-6666-4666-8666-000000000101';
const SEEDED_HASH = 'e2e-seeded-shared-plan-snapshot';
const CONTENT = '# Mock plan\n\n- Share through the tracked plan UI.';
const ADA = {
  userId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Ada Lovelace',
};

function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handled = await handleSharedPlansRequest(request, response, url);
    if (!handled) {
      response.writeHead(418).end('not handled');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Shared-plan mock server did not bind a TCP port.');
      }
      resolve({ server, base: `http://127.0.0.1:${address.port}` });
    });
  });
}

function stopServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function planSeed(overrides = {}) {
  return {
    id: REMOTE_ID,
    title: 'Mock plan',
    content: CONTENT,
    snapshotHash: SEEDED_HASH,
    ...overrides,
  };
}

function wireThread(id, comments, overrides = {}) {
  return {
    id,
    status: 'open',
    createdAt: '2026-06-11T12:10:00.000Z',
    anchor: {
      quote: '- Share through the tracked plan UI.',
      renderedText: 'Share through the tracked plan UI.',
    },
    anchorState: 'matched',
    comments,
    ...overrides,
  };
}

function remoteComment(id, body, createdAt = '2026-06-11T12:30:00.000Z') {
  return { id, author: 'remote', remoteAuthor: ADA, body, createdAt };
}

function register(key, sharedPlans = {}) {
  registerScenario(key, {
    sharedPlans: { plans: [planSeed()], ...sharedPlans },
  });
}

function planFetch(base, key, suffix = '', init = {}) {
  return fetch(`${base}/api/v1/desktop-app/plans/${REMOTE_ID}${suffix}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function control(base, key, suffix = '', body) {
  return fetch(
    `${base}/__mock/shared-plans/${encodeURIComponent(key)}/${REMOTE_ID}${suffix}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
}

function updateBody(overrides = {}) {
  return {
    clientLocalPlanId: 'plan-mock',
    workspaceLocalId: 'demo-ts-pnpm-vite',
    worktreeLocalId: 'demo-main',
    title: 'Mock plan',
    content: CONTENT,
    source: 'claude',
    reviewStatus: 'pending',
    localRevisionNumber: 1,
    localCreatedAt: '2026-06-11T12:00:00.000Z',
    localUpdatedAt: '2026-06-11T12:00:00.000Z',
    repositories: [],
    snapshotHash: SEEDED_HASH,
    expectedSnapshotHash: SEEDED_HASH,
    ...overrides,
  };
}

/** Accumulates SSE text until `predicate(text)` holds or the read times out. */
function streamReader(response) {
  const reader = response.body?.getReader();
  assert.ok(reader, 'stream response has a body');
  const decoder = new TextDecoder();
  let text = '';
  return {
    get text() {
      return text;
    },
    async until(predicate, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for SSE text; saw: ${text}`);
        }
        let timer;
        const chunk = await Promise.race([
          reader.read(),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timeout: true }), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
        if (chunk.timeout) continue;
        if (chunk.done) {
          throw new Error(`SSE stream ended early; saw: ${text}`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
  };
}

function frames(text) {
  return text
    .split('\n\n')
    .filter((frame) => frame.includes('event: plan.detail'));
}

test('serves a full team-owned detail under any API namespace', async () => {
  resetAll();
  const key = 'csk_shared_plans_detail';
  register(key);
  const { server, base } = await startServer();
  try {
    for (const namespace of ['desktop-app', 'canopy']) {
      const response = await fetch(
        `${base}/api/v1/${namespace}/plans/${encodeURIComponent(REMOTE_ID)}`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      assert.equal(response.status, 200);
      const detail = await response.json();
      assert.equal(detail.id, REMOTE_ID);
      assert.equal(detail.shareScope, 'team');
      assert.deepEqual(detail.owner, SHARED_PLAN_MOCK_TEAM_OWNER);
      assert.equal(detail.snapshotHash, SEEDED_HASH);
      assert.equal(
        detail.contentHash,
        createHash('sha256').update(CONTENT).digest('hex'),
      );
      assert.equal(detail.remoteRevisionNumber, 1);
      assert.deepEqual(detail.commentThreads, []);
      assert.equal(detail.content, CONTENT);
    }
    assert.equal(getScenarioActivity(key).sharedPlanGet, 2);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('rejects requests without a csk bearer credential', async () => {
  resetAll();
  register('csk_shared_plans_auth');
  const { server, base } = await startServer();
  try {
    const anonymous = await fetch(
      `${base}/api/v1/desktop-app/plans/${REMOTE_ID}`,
    );
    assert.equal(anonymous.status, 401);
    const wrongPrefix = await fetch(
      `${base}/api/v1/desktop-app/plans/${REMOTE_ID}/stream`,
      { headers: { authorization: 'Bearer not-a-cloud-key' } },
    );
    assert.equal(wrongPrefix.status, 401);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('answers 404 for unregistered keys, slices, and plans without touching other routes', async () => {
  resetAll();
  registerScenario('csk_shared_plans_no_slice', { cloud: {} });
  register('csk_shared_plans_known');
  const { server, base } = await startServer();
  try {
    assert.equal(
      (await planFetch(base, 'csk_shared_plans_unregistered')).status,
      404,
    );
    assert.equal(
      (await planFetch(base, 'csk_shared_plans_no_slice')).status,
      404,
    );
    const unknown = await fetch(
      `${base}/api/v1/desktop-app/plans/66666666-6666-4666-8666-999999999999`,
      { headers: { authorization: 'Bearer csk_shared_plans_known' } },
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'Plan not found' });
    assert.equal(
      (await planFetch(base, 'csk_shared_plans_unregistered', '/stream'))
        .status,
      404,
    );
    // Plan creation and deletion stay with the rest of the cloud surface.
    const create = await fetch(`${base}/api/v1/desktop-app/plans`, {
      method: 'POST',
      headers: { authorization: 'Bearer csk_shared_plans_known' },
      body: '{}',
    });
    assert.equal(create.status, 418);
    const remove = await planFetch(base, 'csk_shared_plans_known', '', {
      method: 'DELETE',
    });
    assert.equal(remove.status, 418);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('PUT merges threads, keeps server-only threads, and bumps the revision only on snapshot change', async () => {
  resetAll();
  const key = 'csk_shared_plans_put';
  registerScenario(key, {
    sharedPlans: {
      plans: [
        planSeed({
          commentThreads: [
            wireThread('server-thread', [
              remoteComment('server-comment', 'Server only.'),
            ]),
          ],
        }),
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    const localThread = wireThread('local-thread', [
      {
        id: 'local-comment',
        author: 'user',
        body: 'Owner note.',
        createdAt: '2026-06-11T12:05:00.000Z',
      },
    ]);
    const first = await planFetch(base, key, '', {
      method: 'PUT',
      body: JSON.stringify(
        updateBody({
          snapshotHash: 'desktop-snapshot-1',
          content: `${CONTENT}\n- Added locally.`,
          commentThreads: [localThread],
        }),
      ),
    });
    assert.equal(first.status, 200);
    const firstDetail = await first.json();
    assert.equal(firstDetail.snapshotHash, 'desktop-snapshot-1');
    assert.equal(firstDetail.remoteRevisionNumber, 2);
    assert.equal(firstDetail.content, `${CONTENT}\n- Added locally.`);
    assert.deepEqual(
      firstDetail.commentThreads.map((thread) => thread.id),
      ['server-thread', 'local-thread'],
    );

    // A comment-only update carries the unchanged snapshot: comments merge,
    // the revision stays put, and a new reply appends to the existing thread.
    const second = await planFetch(base, key, '', {
      method: 'PUT',
      body: JSON.stringify(
        updateBody({
          snapshotHash: 'desktop-snapshot-1',
          expectedSnapshotHash: 'desktop-snapshot-1',
          content: `${CONTENT}\n- Added locally.`,
          commentThreads: [
            {
              ...localThread,
              status: 'resolved',
              comments: [
                ...localThread.comments,
                {
                  id: 'agent-comment',
                  author: 'agent',
                  body: 'Done.',
                  createdAt: '2026-06-11T12:06:00.000Z',
                },
              ],
            },
          ],
        }),
      ),
    });
    assert.equal(second.status, 200);
    const secondDetail = await second.json();
    assert.equal(secondDetail.remoteRevisionNumber, 2);
    const merged = secondDetail.commentThreads.find(
      (thread) => thread.id === 'local-thread',
    );
    assert.equal(merged.status, 'resolved');
    assert.deepEqual(
      merged.comments.map((comment) => comment.id),
      ['local-comment', 'agent-comment'],
    );
    assert.ok(
      secondDetail.commentThreads.some(
        (thread) => thread.id === 'server-thread',
      ),
    );

    const requests = await (await control(base, key, '/requests')).json();
    assert.equal(requests.puts.length, 2);
    assert.equal(requests.puts[0].body.expectedSnapshotHash, SEEDED_HASH);
    assert.equal(requests.puts[0].expectedSnapshotHashMatched, true);
    assert.deepEqual(requests.puts[0].body.commentThreads, [localThread]);
    assert.deepEqual(requests.events, []);
    assert.equal(getScenarioActivity(key).sharedPlanPut, 2);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('PUT with a stale expected snapshot hash is recorded and rejected with 409', async () => {
  resetAll();
  const key = 'csk_shared_plans_conflict';
  register(key);
  const { server, base } = await startServer();
  try {
    const response = await planFetch(base, key, '', {
      method: 'PUT',
      body: JSON.stringify(
        updateBody({
          expectedSnapshotHash: 'stale',
          snapshotHash: 'desktop-snapshot-2',
        }),
      ),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Plan has changed since it was loaded',
    });
    const requests = await (await control(base, key, '/requests')).json();
    assert.equal(requests.puts.length, 1);
    assert.equal(requests.puts[0].expectedSnapshotHashMatched, false);
    const detail = await (await control(base, key)).json();
    assert.equal(detail.snapshotHash, SEEDED_HASH);
    assert.equal(detail.remoteRevisionNumber, 1);

    const malformed = await planFetch(base, key, '', {
      method: 'PUT',
      body: '{',
    });
    assert.equal(malformed.status, 400);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('scripted GET/PUT failures and signalOnPut are honored', async () => {
  resetAll();
  const failing = 'csk_shared_plans_failing';
  const signalling = 'csk_shared_plans_signal_on_put';
  register(failing, {
    getError: { status: 503 },
    putError: { status: 500, body: { error: 'boom' } },
  });
  register(signalling, { signalOnPut: true });
  const { server, base } = await startServer();
  try {
    assert.equal((await planFetch(base, failing)).status, 503);
    const put = await planFetch(base, failing, '', {
      method: 'PUT',
      body: JSON.stringify(updateBody()),
    });
    assert.equal(put.status, 500);
    assert.deepEqual(await put.json(), { error: 'boom' });

    const signalled = await planFetch(base, signalling, '', {
      method: 'PUT',
      body: JSON.stringify(updateBody({ snapshotHash: 'next' })),
    });
    assert.equal(signalled.status, 200);
    const requests = await (
      await control(base, signalling, '/requests')
    ).json();
    assert.deepEqual(
      requests.events.map(({ id, revision }) => ({ id, revision })),
      [{ id: 1, revision: 2 }],
    );
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('the stream primes, then emits one plan.detail frame per signalled change', async () => {
  resetAll();
  const key = 'csk_shared_plans_stream';
  registerScenario(key, {
    sharedPlans: {
      plans: [
        planSeed({
          commentThreads: [
            wireThread('thread-1', [remoteComment('comment-1', 'First.')]),
          ],
        }),
      ],
    },
  });
  const { server, base } = await startServer();
  const abort = new AbortController();
  try {
    const response = await planFetch(base, key, '/stream', {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('content-type'),
      'text/event-stream; charset=utf-8',
    );
    assert.equal(
      response.headers.get('cache-control'),
      'no-cache, no-transform',
    );
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = streamReader(response);
    await reader.until((text) => text.includes(': connected\n\n'));
    assert.match(reader.text, /^retry: 3000\n: connected\n\n/);

    // A silent change (e.g. a comment the owner should only see on pull)
    // writes nothing and does not consume an event id.
    const silent = await control(base, key, '/threads', {
      thread: wireThread('thread-silent', [
        remoteComment('comment-silent', 'Silent.'),
      ]),
      signal: false,
    });
    assert.equal(silent.status, 200);
    assert.equal((await silent.json()).eventId, null);

    const reply = await control(base, key, '/threads/thread-1/comments', {
      comment: remoteComment(
        'comment-2',
        'Second.',
        '2026-06-11T12:45:00.000Z',
      ),
    });
    assert.equal(reply.status, 200);
    const replyResult = await reply.json();
    assert.equal(replyResult.eventId, 1);
    assert.deepEqual(
      replyResult.detail.commentThreads[0].comments.map(
        (comment) => comment.id,
      ),
      ['comment-1', 'comment-2'],
    );

    await reader.until((text) => frames(text).length >= 1);
    const [frame] = frames(reader.text);
    assert.match(frame, /^id: 1\nevent: plan\.detail\ndata: /);
    const envelope = JSON.parse(frame.split('\ndata: ')[1]);
    assert.equal(envelope.type, 'plan.detail');
    assert.equal(envelope.eventId, 'mock-plan-event-1');
    assert.equal(envelope.sequence, 1);
    assert.equal(typeof envelope.occurredAt, 'string');
    // Web comments do not bump the remote revision.
    assert.deepEqual(envelope.payload, { planId: REMOTE_ID, revision: 1 });

    const status = await control(base, key, '/threads/thread-1/status', {
      status: 'resolved',
    });
    assert.equal(
      (await status.json()).detail.commentThreads[0].status,
      'resolved',
    );
    await reader.until((text) => frames(text).length >= 2);
    assert.match(frames(reader.text)[1], /^id: 2\n/);

    const requests = await (await control(base, key, '/requests')).json();
    assert.equal(requests.streamConnections, 1);
    assert.equal(requests.openStreams, 1);
    assert.equal(requests.events.length, 2);
    assert.equal(getScenarioActivity(key).sharedPlanStreamOpen, 1);
  } finally {
    abort.abort();
    await stopServer(server);
    resetAll();
  }
});

test('reconnects replay after Last-Event-ID while a fresh stream starts at head', async () => {
  resetAll();
  const key = 'csk_shared_plans_replay';
  register(key);
  const { server, base } = await startServer();
  const replayAbort = new AbortController();
  const headAbort = new AbortController();
  try {
    await control(base, key, '/signal', {});
    await control(base, key, '/signal', {});

    const replay = await planFetch(base, key, '/stream', {
      headers: { 'last-event-id': '0' },
      signal: replayAbort.signal,
    });
    const replayReader = streamReader(replay);
    await replayReader.until((text) => frames(text).length >= 2);
    assert.deepEqual(
      frames(replayReader.text).map((frame) => frame.split('\n')[0]),
      ['id: 1', 'id: 2'],
    );

    const afterOne = await planFetch(base, key, '/stream?after=1', {
      signal: replayAbort.signal,
    });
    const afterOneReader = streamReader(afterOne);
    await afterOneReader.until((text) => frames(text).length >= 1);
    assert.deepEqual(
      frames(afterOneReader.text).map((frame) => frame.split('\n')[0]),
      ['id: 2'],
    );

    const head = await planFetch(base, key, '/stream', {
      signal: headAbort.signal,
    });
    const headReader = streamReader(head);
    await headReader.until((text) => text.includes(': connected'));
    await control(base, key, '/signal', {});
    await headReader.until((text) => frames(text).length >= 1);
    assert.deepEqual(
      frames(headReader.text).map((frame) => frame.split('\n')[0]),
      ['id: 3'],
    );

    headAbort.abort();
    await waitFor(async () => {
      const requests = await (await control(base, key, '/requests')).json();
      return requests.openStreams === 2 && requests.streamConnections === 3;
    });
  } finally {
    replayAbort.abort();
    headAbort.abort();
    await stopServer(server);
    resetAll();
  }
});

test('a disabled stream answers 404 so the desktop stops quietly', async () => {
  resetAll();
  const key = 'csk_shared_plans_stream_disabled';
  register(key, { stream: 'disabled' });
  const { server, base } = await startServer();
  try {
    assert.equal((await planFetch(base, key, '/stream')).status, 404);
    assert.equal((await planFetch(base, key)).status, 200);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('runtime faults fail and restore one plan GET without resetting state', async () => {
  resetAll();
  const key = 'csk_shared_plans_runtime_faults';
  register(key, { getError: { status: 503 } });
  const { server, base } = await startServer();
  try {
    // The runtime fault wins over the scenario's, and `null` falls back to
    // the scenario again.
    const fault = await control(base, key, '/faults', {
      getError: { status: 401, body: { error: 'Invalid API key.' } },
    });
    assert.equal(fault.status, 200);
    const unauthorized = await planFetch(base, key);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: 'Invalid API key.' });
    await control(base, key, '/faults', { getError: null });
    assert.equal((await planFetch(base, key)).status, 503);

    const healthy = 'csk_shared_plans_runtime_faults_healthy';
    register(healthy);
    await control(base, healthy, '/signal', {});
    await control(base, healthy, '/faults', { getError: { status: 503 } });
    assert.equal((await planFetch(base, healthy)).status, 503);
    await control(base, healthy, '/faults', { getError: null });
    const restored = await planFetch(base, healthy);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).id, REMOTE_ID);
    const requests = await (await control(base, healthy, '/requests')).json();
    assert.equal(requests.gets, 2);
    assert.equal(requests.events.length, 1);

    const invalid = await control(base, healthy, '/faults', {
      getError: 'nope',
    });
    assert.equal(invalid.status, 400);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('closing streams ends them and a reconnect replays what it missed', async () => {
  resetAll();
  const key = 'csk_shared_plans_close_streams';
  register(key);
  const { server, base } = await startServer();
  const abort = new AbortController();
  try {
    const first = await planFetch(base, key, '/stream', {
      signal: abort.signal,
    });
    const firstReader = streamReader(first);
    await firstReader.until((text) => text.includes(': connected'));
    await control(base, key, '/signal', {});
    await firstReader.until((text) => frames(text).length >= 1);

    const closed = await control(base, key, '/streams/close', {});
    assert.deepEqual(await closed.json(), { ok: true, closed: 1 });
    await assert.rejects(
      firstReader.until(() => false),
      /SSE stream ended early/,
    );
    await waitFor(async () => {
      const requests = await (await control(base, key, '/requests')).json();
      return requests.openStreams === 0;
    });

    // A change while disconnected replays after the last seen event.
    await control(base, key, '/signal', {});
    const second = await planFetch(base, key, '/stream', {
      headers: { 'last-event-id': '1' },
      signal: abort.signal,
    });
    const secondReader = streamReader(second);
    await secondReader.until((text) => frames(text).length >= 1);
    assert.deepEqual(
      frames(secondReader.text).map((frame) => frame.split('\n')[0]),
      ['id: 2'],
    );
    const requests = await (await control(base, key, '/requests')).json();
    assert.equal(requests.streamConnections, 2);
    assert.equal(requests.openStreams, 1);
  } finally {
    abort.abort();
    await stopServer(server);
    resetAll();
  }
});

test('keeps concurrent keys isolated', async () => {
  resetAll();
  const first = 'csk_shared_plans_worker_1';
  const second = 'csk_shared_plans_worker_2';
  register(first);
  register(second);
  const { server, base } = await startServer();
  try {
    await control(base, first, '/threads', {
      thread: wireThread('only-first', [remoteComment('c', 'Only first.')]),
    });
    const firstDetail = await (await planFetch(base, first)).json();
    const secondDetail = await (await planFetch(base, second)).json();
    assert.deepEqual(
      firstDetail.commentThreads.map((thread) => thread.id),
      ['only-first'],
    );
    assert.deepEqual(secondDetail.commentThreads, []);
    const secondRequests = await (
      await control(base, second, '/requests')
    ).json();
    assert.equal(secondRequests.gets, 1);
    assert.deepEqual(secondRequests.events, []);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('control routes validate their targets', async () => {
  resetAll();
  const key = 'csk_shared_plans_control';
  registerScenario(key, {
    sharedPlans: {
      plans: [
        planSeed({
          commentThreads: [
            wireThread('thread-1', [remoteComment('comment-1', 'First.')]),
          ],
        }),
      ],
    },
  });
  const { server, base } = await startServer();
  try {
    assert.equal(
      (
        await control(base, key, '/threads/missing/comments', {
          comment: remoteComment('x', 'x'),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await control(base, key, '/threads/thread-1/comments', {
          comment: remoteComment('comment-1', 'Duplicate.'),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await control(base, key, '/threads', {
          thread: wireThread('thread-1', []),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await control(base, key, '/threads/thread-1/status', {
          status: 'archived',
        })
      ).status,
      400,
    );
    assert.equal(
      (await control(base, key, '/threads', { thread: { id: 'bad' } })).status,
      400,
    );
    const unknownKey = await fetch(
      `${base}/__mock/shared-plans/csk_nobody/${REMOTE_ID}/requests`,
    );
    assert.equal(unknownKey.status, 404);
    const requests = await (await control(base, key, '/requests')).json();
    assert.deepEqual(requests.events, []);
  } finally {
    await stopServer(server);
    resetAll();
  }
});

test('pure helpers build, merge, frame, and parse like the web service', () => {
  assert.throws(() => buildSharedPlanDetail({ content: 'x' }), /remote id/);
  assert.throws(
    () => buildSharedPlanDetail({ id: 'plan', content: 'x' }),
    /snapshotHash/,
  );
  const detail = buildSharedPlanDetail(
    planSeed({ diagrams: { sequence: undefined } }),
  );
  assert.deepEqual(Object.keys(detail).sort(), [
    'canDelete',
    'canUpdate',
    'commentThreads',
    'content',
    'contentHash',
    'createdAt',
    'createdBy',
    'diagrams',
    'diagramsHash',
    'id',
    'localRevisionNumber',
    'owner',
    'remoteRevisionNumber',
    'repositories',
    'shareScope',
    'snapshotHash',
    'title',
    'updatedAt',
  ]);

  const existing = [
    wireThread('a', [remoteComment('a-1', 'A.')]),
    wireThread('server-only', [remoteComment('s-1', 'S.')]),
  ];
  const merged = mergeWireCommentThreads(existing, [
    wireThread(
      'a',
      [
        { ...remoteComment('a-1', 'A edited.') },
        remoteComment('a-2', 'A2.', '2026-06-11T13:00:00.000Z'),
      ],
      { status: 'resolved', anchorState: 'outdated' },
    ),
    wireThread('b', [remoteComment('b-1', 'B.')]),
  ]);
  assert.deepEqual(
    merged.map((thread) => [
      thread.id,
      thread.status,
      thread.anchorState,
      thread.comments.map((comment) => `${comment.id}:${comment.body}`),
    ]),
    [
      // An existing comment keeps its stored body, as on the web.
      ['a', 'resolved', 'outdated', ['a-1:A.', 'a-2:A2.']],
      ['server-only', 'open', 'matched', ['s-1:S.']],
      ['b', 'open', 'matched', ['b-1:B.']],
    ],
  );
  // The input is not mutated.
  assert.equal(existing[0].comments.length, 1);

  assert.equal(
    formatPlanDetailFrame(
      { id: 7, revision: 3, occurredAt: '2026-06-11T12:00:00.000Z' },
      REMOTE_ID,
    ),
    `id: 7\nevent: plan.detail\ndata: {"type":"plan.detail","eventId":"mock-plan-event-7","occurredAt":"2026-06-11T12:00:00.000Z","sequence":7,"payload":{"planId":"${REMOTE_ID}","revision":3}}\n\n`,
  );

  const url = (query = '') => new URL(`http://127.0.0.1/stream${query}`);
  assert.equal(parseStreamCursor({ headers: {} }, url()), null);
  assert.equal(parseStreamCursor({ headers: {} }, url('?after=4')), 4);
  assert.equal(
    parseStreamCursor({ headers: { 'last-event-id': '9' } }, url('?after=4')),
    9,
  );
  assert.equal(
    parseStreamCursor({ headers: { 'last-event-id': 'mock-1' } }, url()),
    null,
  );
  assert.equal(parseStreamCursor({ headers: {} }, url('?after=-1')), null);
});

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition did not hold before the timeout');
}
