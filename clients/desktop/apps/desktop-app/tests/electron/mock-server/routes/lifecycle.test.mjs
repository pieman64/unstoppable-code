// C1 v2 contract exercised only against local HTTP and WebSocket transports.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { handleControlPlaneRequest, resetAll } from '../control-plane.mjs';
import { guardRequestHandler } from '../request-guard.mjs';
import { handleLlmRequest } from './llm.mjs';
import { attachResponsesWebSocket } from './responsesWs.mjs';

async function fixture(t) {
  resetAll();
  const server = createServer(
    guardRequestHandler(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (await handleControlPlaneRequest(req, res, url)) return;
      if (await handleLlmRequest(req, res, url)) return;
      res.writeHead(404).end();
    }),
  );
  const wss = attachResponsesWebSocket(server);
  t.after(async () => {
    resetAll();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = 'Canopy-CLIFECYCLE';
  const json = async (path, body, method = 'POST') => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  const register = (steps, extra = {}) =>
    json('/__mock/state', {
      key,
      scenario: { ...extra, llm: { steps, ...extra.llm } },
    });
  const get = async (path) =>
    (await json(`${path}?key=${key}`, undefined, 'GET')).body;
  const release = (name) => json('/__mock/barrier', { key, name });
  const request = (route = '/v1/responses', stream = false, text = '') => ({
    stream,
    ...(route === '/v1/responses'
      ? { input: [{ role: 'user', content: `[${key}] ${text}` }] }
      : { messages: [{ role: 'user', content: `[${key}] ${text}` }] }),
  });
  const post = (route = '/v1/responses', body = request(route)) =>
    fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const socket = async () => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/responses`);
    await once(ws, 'open');
    return ws;
  };
  return { key, json, register, get, release, request, post, socket };
}

async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Condition did not become true');
}

function collect(ws, body, { close = false } = {}) {
  const frames = [];
  let firstFrameAt;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WS contract timeout')),
      3000,
    );
    ws.on('message', (data) => {
      firstFrameAt ??= Date.now();
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (
        !close &&
        ['response.completed', 'response.failed'].includes(frame.type)
      ) {
        clearTimeout(timer);
        resolve({ frames, firstFrameAt });
      }
    });
    ws.once('close', () => {
      clearTimeout(timer);
      if (close) resolve({ frames, firstFrameAt });
      else reject(new Error('Unexpected WS close'));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  ws.send(JSON.stringify({ type: 'response.create', ...body }));
  return result;
}

test('barriers gate HTTP JSON, each HTTP SSE dialect and WS; early release persists', async (t) => {
  const f = await fixture(t);
  for (const route of [
    '/v1/messages',
    '/v1/responses',
    '/v1/chat/completions',
  ]) {
    for (const stream of [false, true]) {
      await f.register([{ text: 'released', waitFor: 'gate' }]);
      let answered = false;
      const pending = f
        .post(route, f.request(route, stream))
        .then(async (res) => {
          answered = true;
          assert.equal(res.status, 200);
          assert.match(await res.text(), /released/);
        });
      await until(async () =>
        (await f.get('/__mock/barrier')).barriers.some((b) => b.waiting === 1),
      );
      assert.equal(answered, false);
      await f.release('gate');
      await pending;
      assert.deepEqual((await f.get('/__mock/barrier')).barriers, [
        { name: 'gate', waiting: 0, released: true },
      ]);
    }
  }
  await f.register([{ text: 'early', waitFor: 'gate' }]);
  await f.release('gate');
  assert.equal((await f.post()).status, 200);
  const ws = await f.socket();
  assert.equal(
    (await collect(ws, f.request())).frames.at(-1).type,
    'response.completed',
  );
  ws.terminate();
  await f.register([{ text: 'late', waitFor: 'ws-gate' }]);
  const blockedWs = await f.socket();
  let frames = 0;
  blockedWs.on('message', () => frames++);
  const pendingWs = collect(blockedWs, f.request());
  await until(async () =>
    (await f.get('/__mock/barrier')).barriers.some((b) => b.waiting === 1),
  );
  assert.equal(frames, 0);
  await f.release('ws-gate');
  await pendingWs;
});

test('barrier timeout and scenario replacement/delete/reset reject HTTP and WS waiters', async (t) => {
  const f = await fixture(t);
  await f.register([{ waitFor: 'timeout', barrierTimeoutMs: 15 }]);
  let res = await f.post();
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'mock_barrier_timeout');
  let ws = await f.socket();
  assert.equal(
    (await collect(ws, f.request())).frames.at(-1).response.error.code,
    'mock_barrier_timeout',
  );
  ws.terminate();
  assert.ok(
    (await f.get('/__mock/requests')).requests.every(
      (r) => r.errorClass === 'mock_barrier_timeout',
    ),
  );
  for (const action of ['replace', 'delete', 'reset']) {
    await f.register([
      { waitFor: 'reset', stepId: 'attempt', attempts: [{ text: 'waiting' }] },
    ]);
    const http = f.post();
    ws = await f.socket();
    const socketResult = collect(ws, f.request());
    await until(async () =>
      (await f.get('/__mock/barrier')).barriers.some((b) => b.waiting === 2),
    );
    if (action === 'replace') await f.register([{ text: 'new' }]);
    if (action === 'delete')
      await f.json(`/__mock/state/${f.key}`, undefined, 'DELETE');
    if (action === 'reset') await f.json('/__mock/reset', {});
    res = await http;
    assert.equal((await res.json()).error.code, 'mock_scenario_reset');
    assert.equal(
      (await socketResult).frames.at(-1).response.error.code,
      'mock_scenario_reset',
    );
    assert.deepEqual((await f.get('/__mock/requests')).requests, []);
    assert.deepEqual((await f.get('/__mock/barrier')).barriers, []);
    ws.terminate();
  }
});

test('retry attempts progress across HTTP/WS and last alternative is sticky; reset restarts', async (t) => {
  const f = await fixture(t);
  const steps = [
    {
      stepId: 'retry',
      attempts: [
        { error: { kind: 'status', status: 503 } },
        { text: 'success' },
      ],
    },
  ];
  await f.register(steps);
  assert.equal((await f.post()).status, 503);
  const ws = await f.socket();
  assert.equal(
    (await collect(ws, f.request())).frames.at(-1).type,
    'response.completed',
  );
  assert.match(await (await f.post()).text(), /success/);
  const observations = (await f.get('/__mock/requests')).requests;
  assert.deepEqual(
    observations.map((r) => r.attempt),
    [1, 2, 2],
  );
  assert.ok(observations.every((r) => r.stepId === 'retry'));
  await f.register(steps);
  assert.equal((await f.post()).status, 503);
  assert.equal((await f.get('/__mock/requests')).requests[0].attempt, 1);
});

test('HTTP and WS share content-free observations and request-text observers', async (t) => {
  const f = await fixture(t);
  await f.register([{ text: 'done', stepId: 'parity' }], {
    llm: { requestTextObservers: [{ key: 'canary', text: 'SECRET-CONTENT' }] },
  });
  const body = {
    ...f.request(
      '/v1/responses',
      false,
      '[Canopy-Mock-Request:tag] SECRET-CONTENT',
    ),
    tools: [{ type: 'function', name: 'inspect' }],
    input: [
      ...f.request(
        '/v1/responses',
        false,
        '[Canopy-Mock-Request:tag] SECRET-CONTENT',
      ).input,
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'SECRET-RESULT',
      },
    ],
  };
  await (await f.post('/v1/responses', body)).text();
  const ws = await f.socket();
  await collect(ws, body);
  const { requests } = await f.get('/__mock/requests');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    index: 0,
    transport: 'http',
    route: '/v1/responses',
    stepId: 'parity',
    tag: 'tag',
    toolNames: ['inspect'],
    toolResultIds: ['call_1'],
  });
  assert.deepEqual(requests[1], { ...requests[0], index: 1, transport: 'ws' });
  assert.doesNotMatch(JSON.stringify(requests), /SECRET|CONTENT|RESULT/);
  const activity = await f.json(`/__mock/activity/${f.key}`, undefined, 'GET');
  assert.equal(activity.body.activity['llmObserved:canary'], 2);
});

test('observations list functions nested in namespace tools', async (t) => {
  const f = await fixture(t);
  await f.register([{ text: 'done', stepId: 'namespaced' }]);
  const request = f.request();
  await (
    await f.post('/v1/responses', {
      ...request,
      input: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [
            {
              type: 'namespace',
              name: 'functions',
              tools: [{ type: 'function', name: 'get_goal' }],
            },
          ],
        },
        ...request.input,
      ],
    })
  ).text();
  const [observation] = (await f.get('/__mock/requests')).requests;
  assert.deepEqual(observation.toolNames, ['functions', 'get_goal']);
});

test('strict unmatched fails HTTP and WS but unconfigured requests remain benign', async (t) => {
  const f = await fixture(t);
  await f.json('/__mock/state', { key: f.key, scenario: { strict: true } });
  const res = await f.post();
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'mock_unmatched');
  const ws = await f.socket();
  assert.equal(
    (await collect(ws, f.request())).frames.at(-1).response.error.code,
    'mock_unmatched',
  );
  assert.deepEqual(
    (await f.get('/__mock/requests')).requests.map((r) => r.errorClass),
    ['mock_unmatched', 'mock_unmatched'],
  );
  await f.json(`/__mock/state/${f.key}`, undefined, 'DELETE');
  assert.equal((await f.post()).status, 200);
});

test('WS status, disconnect, midstream frame count and delay', async (t) => {
  const f = await fixture(t);
  await f.register([{ error: { kind: 'status', status: 503 } }]);
  let ws = await f.socket();
  assert.equal(
    (await collect(ws, f.request())).frames.at(-1).type,
    'response.failed',
  );
  ws.terminate();
  for (const [error, count] of [
    [{ kind: 'disconnect' }, 0],
    [{ kind: 'midstream', afterFrames: 0 }, 0],
    [{ kind: 'midstream', afterFrames: 3 }, 3],
  ]) {
    await f.register([{ text: 'stream me', error }]);
    ws = await f.socket();
    assert.equal(
      (await collect(ws, f.request(), { close: true })).frames.length,
      count,
    );
    assert.equal(
      (await f.get('/__mock/requests')).requests[0].errorClass,
      `mock_${error.kind}`,
    );
  }
  await f.register([{ text: 'delayed', delayMs: 80 }]);
  ws = await f.socket();
  const start = Date.now();
  assert.ok((await collect(ws, f.request())).firstFrameAt - start >= 65);
});

test('HTTP disconnect and midstream abort transport instead of returning status JSON', async (t) => {
  const f = await fixture(t);
  for (const error of [
    { kind: 'disconnect' },
    { kind: 'midstream', afterFrames: 2 },
  ]) {
    await f.register([{ text: 'some long text', error }]);
    await assert.rejects(async () => {
      const res = await f.post(
        '/v1/responses',
        f.request('/v1/responses', true),
      );
      await res.text();
    });
    assert.equal(
      (await f.get('/__mock/requests')).requests[0].errorClass,
      `mock_${error.kind}`,
    );
  }
});

test('overlapping HTTP and WS requests consume attempts before waiting independently', async (t) => {
  const f = await fixture(t);
  await f.register([
    {
      stepId: 'parallel',
      attempts: [
        { text: 'first', waitFor: 'one' },
        { text: 'second', waitFor: 'two' },
      ],
    },
  ]);
  let firstAnswered = false;
  const first = f.post().then(async (res) => {
    firstAnswered = true;
    return res.text();
  });
  await until(
    async () => (await f.get('/__mock/requests')).requests.length === 1,
  );
  const ws = await f.socket();
  const second = collect(ws, f.request());
  await until(
    async () =>
      (await f.get('/__mock/barrier')).barriers.reduce(
        (n, b) => n + b.waiting,
        0,
      ) === 2,
  );
  await f.release('two');
  assert.equal((await second).frames.at(-1).type, 'response.completed');
  assert.equal(firstAnswered, false);
  await f.release('one');
  assert.match(await first, /first/);
  assert.deepEqual(
    (await f.get('/__mock/requests')).requests.map((r) => [r.index, r.attempt]),
    [
      [0, 1],
      [1, 2],
    ],
  );
});

test('two response.create requests on one WS resolve before waiting and unblock in reverse order', async (t) => {
  const f = await fixture(t);
  await f.register([
    {
      stepId: 'same-socket',
      attempts: [
        { text: 'first blocked', waitFor: 'one' },
        { text: 'second released', waitFor: 'two' },
      ],
    },
  ]);
  const ws = await f.socket();
  const completed = [];
  ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'response.completed') completed.push(frame);
  });
  ws.send(JSON.stringify({ type: 'response.create', ...f.request() }));
  ws.send(JSON.stringify({ type: 'response.create', ...f.request() }));
  await until(
    async () =>
      (await f.get('/__mock/barrier')).barriers.reduce(
        (n, b) => n + b.waiting,
        0,
      ) === 2,
  );
  await f.release('two');
  await until(() => completed.length === 1);
  assert.match(JSON.stringify(completed[0]), /second released/);
  await f.release('one');
  await until(() => completed.length === 2);
  assert.match(JSON.stringify(completed[1]), /first blocked/);
  assert.deepEqual(
    (await f.get('/__mock/requests')).requests.map((r) => r.attempt),
    [1, 2],
  );
});
