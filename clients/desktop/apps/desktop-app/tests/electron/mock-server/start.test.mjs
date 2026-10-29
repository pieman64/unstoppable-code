// Tests for the shared UI-automation mock server entrypoint.
//
// Run: node --test apps/desktop-app/tests/electron/mock-server/start.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { guardRequestHandler } from './request-guard.mjs';

const START_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'start.mjs',
);

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

async function startGuardedServer(handler, log) {
  const server = createServer(guardRequestHandler(handler, log));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function waitForHealth(base, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'mock server exited during startup');
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('mock server did not become healthy');
}

test('a throwing route answers 500 and the server keeps serving', async () => {
  const logged = [];
  let calls = 0;
  const { server, base } = await startGuardedServer(
    (request, response) => {
      calls += 1;
      if (request.url === '/async') {
        return Promise.reject(new TypeError('async failure'));
      }
      // A non-async handler throws synchronously here.
      if (request.url === '/sync') throw new Error('sync failure');
      response.writeHead(200).end('ok');
      return undefined;
    },
    (...args) => logged.push(args),
  );
  try {
    const asyncFailure = await fetch(`${base}/async`);
    assert.equal(asyncFailure.status, 500);
    assert.deepEqual(await asyncFailure.json(), {
      error: 'Mock server route failed: async failure',
    });
    assert.equal((await fetch(`${base}/sync`)).status, 500);
    const healthy = await fetch(`${base}/ok`);
    assert.equal(healthy.status, 200);
    assert.equal(await healthy.text(), 'ok');
    assert.equal(calls, 3);
    assert.equal(logged.length, 2);
    assert.match(String(logged[0][0]), /GET \/async/);
  } finally {
    server.close();
  }
});

test('a route that fails after streaming headers closes only its connection', async () => {
  const logged = [];
  const { server, base } = await startGuardedServer(
    async (request, response) => {
      if (request.url === '/stream') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': connected\n\n');
        throw new Error('stream failure');
      }
      response.writeHead(200).end('ok');
    },
    (message) => logged.push(message),
  );
  try {
    // The socket may close before or after the client sees the headers.
    await assert.rejects(
      fetch(`${base}/stream`).then((response) => response.text()),
    );
    assert.equal((await fetch(`${base}/ok`)).status, 200);
    assert.match(logged[0], /after sending headers; closing it/);
  } finally {
    server.close();
  }
});

// Once #4229 lands, the CAN-3459 request below succeeds, so the deliberate
// failure route proves the real entrypoint still uses the guard.
test('the shared mock server answers 500 for a failing route and keeps serving', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [START_ENTRY], {
    env: { ...process.env, CANOPY_E2E_MOCK_BASE_URL: base },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForHealth(base, child);
    const authLink = await fetch(`${base}/api/v1/canopy/auth-link`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer csk_can3597_mock_origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        redirectPath: '/organization/11111111-1111-4111-8111-111111111111',
      }),
    });
    assert.equal(authLink.status, 200);
    assert.equal(new URL((await authLink.json()).url).origin, base);

    const failure = await fetch(`${base}/__mock/route-error`, {
      method: 'POST',
    }).catch((error) => error);
    assert.ok(
      !(failure instanceof Error),
      `failing route dropped the request: ${failure?.message}\n${stderr}`,
    );
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), {
      error: 'Mock server route failed: Deliberate mock-server route failure',
    });
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    // CAN-3459's locked-telemetry spec signs in with a credential that never
    // registers a scenario, then its org switch fires this ensure request.
    const ensure = await fetch(`${base}/api/v1/projects/default-chats`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer csk_unregistered_start_test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: '11111111-1111-4111-8111-111111111111',
      }),
    }).catch((error) => error);
    assert.ok(
      !(ensure instanceof Error),
      `ensure request failed: ${ensure?.message}\n${stderr}`,
    );
    // 500 while the route writes into the frozen default; 200 after #4229.
    assert.ok([200, 500].includes(ensure.status), `status ${ensure.status}`);
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(child.exitCode, null, stderr);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, 'exit');
    }
  }
});

test('a failing recovery closes the connection instead of escaping', async () => {
  const { server, base } = await startGuardedServer(
    () => {
      throw new Error('route failure');
    },
    () => {
      throw new Error('log failure');
    },
  );
  try {
    await assert.rejects(fetch(`${base}/any`));
    // Still serving: the second request reaches the handler again.
    await assert.rejects(fetch(`${base}/again`));
    assert.equal(server.listening, true);
  } finally {
    server.close();
  }
});
