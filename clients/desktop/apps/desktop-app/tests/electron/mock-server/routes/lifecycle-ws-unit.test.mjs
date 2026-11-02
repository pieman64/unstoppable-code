// Exercise the real WS message handlers without opening any listening socket.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import {
  handleControlPlaneRequest,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import { attachResponsesWebSocket } from './responsesWs.mjs';

const key = 'Canopy-CWSUNIT';
const body = {
  type: 'response.create',
  input: [{ role: 'user', content: `[${key}]` }],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function control(path, body) {
  const request = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)],
  );
  request.method = body === undefined ? 'GET' : 'POST';
  let result;
  await handleControlPlaneRequest(
    request,
    {
      writeHead() {},
      end(text) {
        result = JSON.parse(text);
      },
    },
    new URL(path, 'http://127.0.0.1'),
  );
  return result;
}

function fixture(t, step, scenario = {}) {
  resetAll();
  registerScenario(key, {
    ...scenario,
    llm: { steps: [step], ...scenario.llm },
  });
  const server = new EventEmitter();
  const wss = attachResponsesWebSocket(server);
  const ws = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  const frames = [];
  ws.send = (raw) => {
    frames.push(JSON.parse(raw));
    ws.emit('sent');
  };
  ws.close = () => {
    ws.readyState = WebSocket.CLOSED;
    ws.emit('close');
  };
  // Only replace the upgrade handshake. Message parsing and every async
  // response handler are the same production functions as a real connection.
  wss.handleUpgrade = (_req, _socket, _head, connected) => connected(ws);
  server.emit(
    'upgrade',
    { url: '/responses', headers: {} },
    {},
    Buffer.alloc(0),
  );
  t.after(() => {
    ws.close();
    resetAll();
    wss.close();
  });
  return {
    ws,
    frames,
    send: (request = body) =>
      ws.emit('message', Buffer.from(JSON.stringify(request))),
  };
}

async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('WS handler did not settle');
}

test('WS handlers gate frames and release-before-wait persists', async (t) => {
  const f = fixture(t, { text: 'done', waitFor: 'gate' });
  f.send();
  await tick();
  assert.equal(f.frames.length, 0);
  assert.equal(
    (await control(`/__mock/barrier?key=${key}`)).barriers[0].waiting,
    1,
  );
  await control('/__mock/barrier', { key, name: 'gate' });
  await until(() => f.frames.at(-1)?.type === 'response.completed');
  f.frames.length = 0;
  f.send();
  await until(() => f.frames.at(-1)?.type === 'response.completed');
  assert.equal(
    (await control(`/__mock/barrier?key=${key}`)).barriers[0].waiting,
    0,
  );
});

test('WS handlers classify timeout, reset and strict unmatched failures', async (t) => {
  const f = fixture(t, { waitFor: 'timeout', barrierTimeoutMs: 5 });
  f.send();
  await until(() => f.frames.length > 0);
  assert.equal(f.frames[0].response.error.code, 'mock_barrier_timeout');
  assert.equal(
    (await control(`/__mock/requests?key=${key}`)).requests[0].errorClass,
    'mock_barrier_timeout',
  );
  registerScenario(key, { llm: { steps: [{ waitFor: 'reset' }] } });
  f.frames.length = 0;
  f.send();
  await tick();
  resetAll();
  await until(() => f.frames.length > 0);
  assert.equal(f.frames[0].response.error.code, 'mock_scenario_reset');
  assert.deepEqual((await control(`/__mock/requests?key=${key}`)).requests, []);
  registerScenario(key, { strict: true });
  f.frames.length = 0;
  f.send();
  await until(() => f.frames.length > 0);
  assert.equal(f.frames[0].response.error.code, 'mock_unmatched');
});

test('WS handlers support status, disconnect, midstream exact frame count and initial delay', async (t) => {
  for (const [error, count] of [
    [{ kind: 'disconnect' }, 0],
    [{ kind: 'midstream', afterFrames: 0 }, 0],
    [{ kind: 'midstream', afterFrames: 3 }, 3],
  ]) {
    await t.test(`${error.kind} ${count}`, async (t) => {
      const f = fixture(t, { text: 'done', error });
      f.send();
      await until(() => f.ws.readyState === WebSocket.CLOSED);
      assert.equal(f.frames.length, count);
      assert.equal(
        (await control(`/__mock/requests?key=${key}`)).requests[0].errorClass,
        `mock_${error.kind}`,
      );
    });
  }
  await t.test('status then delayed success', async (t) => {
    const f = fixture(t, {
      stepId: 'retry',
      attempts: [
        { error: { kind: 'status', status: 503 } },
        { text: 'done', delayMs: 30 },
      ],
    });
    f.send();
    await until(() => f.frames.length > 0);
    assert.equal(f.frames[0].type, 'response.failed');
    f.frames.length = 0;
    f.send();
    await tick();
    assert.equal(f.frames.length, 0);
    await until(() => f.frames.at(-1)?.type === 'response.completed');
    assert.deepEqual(
      (await control(`/__mock/requests?key=${key}`)).requests.map(
        (r) => r.attempt,
      ),
      [1, 2],
    );
  });
});

test('WS handlers independently resolve overlapping attempts on one connection', async (t) => {
  const f = fixture(t, {
    stepId: 'parallel',
    attempts: [
      { text: 'first', waitFor: 'one' },
      { text: 'second', waitFor: 'two' },
    ],
  });
  f.send();
  f.send();
  await tick();
  assert.equal(
    (await control(`/__mock/barrier?key=${key}`)).barriers.reduce(
      (sum, b) => sum + b.waiting,
      0,
    ),
    2,
  );
  await control('/__mock/barrier', { key, name: 'two' });
  await until(() => f.frames.at(-1)?.type === 'response.completed');
  assert.match(JSON.stringify(f.frames.at(-1)), /second/);
  assert.equal(
    (await control(`/__mock/barrier?key=${key}`)).barriers[0].waiting,
    1,
  );
  f.frames.length = 0;
  await control('/__mock/barrier', { key, name: 'one' });
  await until(() => f.frames.at(-1)?.type === 'response.completed');
  assert.match(JSON.stringify(f.frames.at(-1)), /first/);
});
