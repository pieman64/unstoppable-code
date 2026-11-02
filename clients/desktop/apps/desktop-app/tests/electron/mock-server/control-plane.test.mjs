import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  clearScenario,
  getScenario,
  handleControlPlaneRequest,
  recordRequest,
  registerScenario,
  resetAll,
  resolveStepAttempt,
  waitForBarrier,
} from './control-plane.mjs';

function errorHasCode(code) {
  return (error) => error?.code === code;
}

function makeRequest(method, body) {
  const request = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)],
  );
  request.method = method;
  request.headers = {};
  return request;
}

function makeResponse() {
  const response = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
  return response;
}

async function callControlPlane(method, url, body) {
  const request = makeRequest(method, body);
  const response = makeResponse();
  const handled = await handleControlPlaneRequest(
    request,
    response,
    new URL(url, 'http://localhost'),
  );
  return { handled, response };
}

test('resolveStepAttempt selects sticky per-key alternatives and inherits base fields', () => {
  resetAll();
  const step = {
    stepId: 'assistant-turn',
    model: 'base-model',
    text: 'base text',
    attempts: [
      { text: 'first alternative' },
      { model: 'second-model', text: 'second alternative' },
    ],
  };

  assert.deepEqual(resolveStepAttempt('attempts-a', step), {
    step: {
      stepId: 'assistant-turn',
      model: 'base-model',
      text: 'first alternative',
    },
    attempt: 1,
  });
  assert.deepEqual(resolveStepAttempt('attempts-a', step), {
    step: {
      stepId: 'assistant-turn',
      model: 'second-model',
      text: 'second alternative',
    },
    attempt: 2,
  });
  assert.deepEqual(resolveStepAttempt('attempts-a', step), {
    step: {
      stepId: 'assistant-turn',
      model: 'second-model',
      text: 'second alternative',
    },
    attempt: 2,
  });
  assert.deepEqual(resolveStepAttempt('attempts-b', step), {
    step: {
      stepId: 'assistant-turn',
      model: 'base-model',
      text: 'first alternative',
    },
    attempt: 1,
  });

  const unchanged = { text: 'no attempts' };
  assert.deepEqual(resolveStepAttempt('attempts-a', unchanged), {
    step: unchanged,
  });
});

test('resolveStepAttempt rejects malformed attempt scripts with mock_invalid_step', async () => {
  resetAll();
  const invalidSteps = [
    { attempts: [], stepId: 'empty' },
    { attempts: [{ text: 'ok' }] },
    { attempts: 'not-an-array', stepId: 'wrong-shape' },
    { attempts: [null], stepId: 'bad-alternative' },
  ];

  for (const step of invalidSteps) {
    await assert.rejects(
      Promise.resolve().then(() => resolveStepAttempt('invalid', step)),
      errorHasCode('mock_invalid_step'),
    );
  }
});

test('waitForBarrier reports live waiters, persists releases, and times out with a class code', async () => {
  resetAll();
  const waiting = waitForBarrier('barrier-key', 'provider-ready', 1000);

  const beforeRelease = await callControlPlane(
    'GET',
    '/__mock/barrier?key=barrier-key',
  );
  assert.deepEqual(beforeRelease.response.json(), {
    barriers: [{ name: 'provider-ready', waiting: 1, released: false }],
  });

  const released = await callControlPlane('POST', '/__mock/barrier', {
    key: 'barrier-key',
    name: 'provider-ready',
  });
  assert.equal(released.response.status, 200);
  await waiting;

  const afterRelease = await callControlPlane(
    'GET',
    '/__mock/barrier?key=barrier-key',
  );
  assert.deepEqual(afterRelease.response.json(), {
    barriers: [{ name: 'provider-ready', waiting: 0, released: true }],
  });
  await waitForBarrier('barrier-key', 'provider-ready');

  await assert.rejects(
    waitForBarrier('barrier-key', 'never-released', 5),
    errorHasCode('mock_barrier_timeout'),
  );
});

test('registerScenario replacement rejects waiters and clears runtime state', async () => {
  resetAll();
  registerScenario('replace-key', { version: 1 });
  const attemptScript = {
    stepId: 'turn',
    attempts: [{ text: 'first' }, { text: 'second' }],
  };
  assert.equal(resolveStepAttempt('replace-key', attemptScript).attempt, 1);
  assert.equal(resolveStepAttempt('replace-key', attemptScript).attempt, 2);
  const pending = waitForBarrier('replace-key', 'gate', 1000);
  recordRequest('replace-key', { transport: 'http', route: '/v1/chat' });

  const pendingRejection = assert.rejects(
    pending,
    errorHasCode('mock_scenario_reset'),
  );
  registerScenario('replace-key', { version: 2 });
  await pendingRejection;

  assert.deepEqual(getScenario('replace-key'), { version: 2 });
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/barrier?key=replace-key')
    ).response.json(),
    { barriers: [] },
  );
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/requests?key=replace-key')
    ).response.json(),
    { requests: [] },
  );
  assert.deepEqual(resolveStepAttempt('replace-key', attemptScript), {
    step: { stepId: 'turn', text: 'first' },
    attempt: 1,
  });
});

test('clearScenario and resetAll reject their pending waiters and discard observations', async () => {
  resetAll();
  registerScenario('clear-key', {});
  const attemptScript = {
    stepId: 'turn',
    attempts: [{ text: 'first' }, { text: 'second' }],
  };
  assert.equal(resolveStepAttempt('clear-key', attemptScript).attempt, 1);
  assert.equal(resolveStepAttempt('clear-key', attemptScript).attempt, 2);
  const clearPending = waitForBarrier('clear-key', 'gate', 1000);
  recordRequest('clear-key', { route: '/first' });
  const clearRejection = assert.rejects(
    clearPending,
    errorHasCode('mock_scenario_reset'),
  );
  assert.equal(clearScenario('clear-key'), true);
  await clearRejection;
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/requests?key=clear-key')
    ).response.json(),
    { requests: [] },
  );
  assert.equal(resolveStepAttempt('clear-key', attemptScript).attempt, 1);

  assert.equal(resolveStepAttempt('reset-key', attemptScript).attempt, 1);
  assert.equal(resolveStepAttempt('reset-key', attemptScript).attempt, 2);
  const resetPending = waitForBarrier('reset-key', 'gate', 1000);
  recordRequest('reset-key', { route: '/second' });
  const resetRejection = assert.rejects(
    resetPending,
    errorHasCode('mock_scenario_reset'),
  );
  resetAll();
  await resetRejection;
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/barrier?key=reset-key')
    ).response.json(),
    { barriers: [] },
  );
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/requests?key=reset-key')
    ).response.json(),
    { requests: [] },
  );
  assert.equal(resolveStepAttempt('reset-key', attemptScript).attempt, 1);
});

test('recordRequest returns a live observation but exposes only detached, content-free snapshots', async () => {
  resetAll();
  const first = recordRequest('unregistered-key', {
    transport: 'http',
    route: '/v1/messages',
    stepId: 'step-1',
    attempt: 2,
    tag: 'retry',
    toolNames: ['search', 'write'],
    toolResultIds: ['result-1'],
    errorClass: 'mock_provider_error',
    body: 'must not be exposed',
    prompt: 'private prompt',
  });
  assert.equal(first.index, 0);
  first.errorClass = 'mock_rate_limited';

  const second = recordRequest('unregistered-key', {
    route: '/v1/responses',
    body: { private: true },
  });
  assert.equal(second.index, 1);
  assert.deepEqual(second.toolNames, []);
  assert.deepEqual(second.toolResultIds, []);

  const fetched = await callControlPlane(
    'GET',
    '/__mock/requests?key=unregistered-key',
  );
  const { requests } = fetched.response.json();
  assert.deepEqual(requests, [
    {
      index: 0,
      transport: 'http',
      route: '/v1/messages',
      stepId: 'step-1',
      attempt: 2,
      tag: 'retry',
      toolNames: ['search', 'write'],
      toolResultIds: ['result-1'],
      errorClass: 'mock_rate_limited',
    },
    {
      index: 1,
      route: '/v1/responses',
      toolNames: [],
      toolResultIds: [],
    },
  ]);

  requests[0].toolNames.push('changed-snapshot');
  requests[0].errorClass = 'changed-snapshot';
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/requests?key=unregistered-key')
    ).response.json(),
    {
      requests: [
        {
          index: 0,
          transport: 'http',
          route: '/v1/messages',
          stepId: 'step-1',
          attempt: 2,
          tag: 'retry',
          toolNames: ['search', 'write'],
          toolResultIds: ['result-1'],
          errorClass: 'mock_rate_limited',
        },
        {
          index: 1,
          route: '/v1/responses',
          toolNames: [],
          toolResultIds: [],
        },
      ],
    },
  );
});

test('control endpoints validate inputs and serve keyed barrier and request state', async () => {
  resetAll();

  for (const [method, url, body] of [
    ['POST', '/__mock/barrier', { name: 'missing-key' }],
    ['POST', '/__mock/barrier', { key: 'key', name: '' }],
    ['GET', '/__mock/barrier', undefined],
    ['GET', '/__mock/requests', undefined],
  ]) {
    const { response } = await callControlPlane(method, url, body);
    assert.equal(response.status, 400);
  }

  const released = await callControlPlane('POST', '/__mock/barrier', {
    key: 'endpoint-key',
    name: 'already-open',
  });
  assert.equal(released.response.status, 200);
  assert.deepEqual(
    (
      await callControlPlane('GET', '/__mock/barrier?key=endpoint-key')
    ).response.json(),
    { barriers: [{ name: 'already-open', waiting: 0, released: true }] },
  );
  assert.equal(
    (await callControlPlane('GET', '/__mock/requests?key=endpoint-key'))
      .response.status,
    200,
  );

  registerScenario('delete-key', {});
  const deletePending = waitForBarrier('delete-key', 'gate', 1000);
  recordRequest('delete-key', { route: '/before-delete' });
  const deleteRejection = assert.rejects(
    deletePending,
    errorHasCode('mock_scenario_reset'),
  );
  const deleted = await callControlPlane('DELETE', '/__mock/state/delete-key');
  assert.deepEqual(deleted.response.json(), { ok: true, cleared: true });
  await deleteRejection;

  const resetPending = waitForBarrier('endpoint-reset-key', 'gate', 1000);
  const resetRejection = assert.rejects(
    resetPending,
    errorHasCode('mock_scenario_reset'),
  );
  const reset = await callControlPlane('POST', '/__mock/reset');
  assert.deepEqual(reset.response.json(), { ok: true });
  await resetRejection;
});
