// Lifecycle route checks that require no network/listening permission.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  handleControlPlaneRequest,
  registerScenario,
  resetAll,
} from '../control-plane.mjs';
import { handleLlmRequest, resolveResponsesReply } from './llm.mjs';

function invoke(handler, pathname, body, headers = {}) {
  const request = Readable.from(
    body === undefined ? [] : [JSON.stringify(body)],
  );
  request.method = body === undefined ? 'GET' : 'POST';
  request.headers = headers;
  const response = new EventEmitter();
  response.parts = [];
  response.headersSent = false;
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = (status) => {
    response.status = status;
    response.headersSent = true;
    return response;
  };
  response.write = (chunk) => {
    response.parts.push(String(chunk));
    return true;
  };
  response.end = (chunk) => {
    if (chunk !== undefined) response.write(chunk);
    response.writableEnded = true;
    return response;
  };
  response.destroy = () => {
    response.destroyed = true;
    response.emit('close');
  };
  response.flushHeaders = () => {};
  const done = handler(
    request,
    response,
    new URL(pathname, 'http://127.0.0.1'),
  );
  return { response, done };
}

async function control(path, body) {
  const { response, done } = invoke(handleControlPlaneRequest, path, body);
  await done;
  return JSON.parse(response.parts.join(''));
}

const key = 'Canopy-CUNITLIFECYCLE';
const body = { input: [{ role: 'user', content: `[${key}]` }] };
const register = (step) => registerScenario(key, { llm: { steps: [step] } });
const observations = () => control(`/__mock/requests?key=${key}`);

test('in-process HTTP lifecycle: barrier gates all renderers; release-before-wait persists', async () => {
  resetAll();
  for (const route of [
    '/v1/messages',
    '/v1/responses',
    '/v1/chat/completions',
  ]) {
    for (const stream of [false, true]) {
      register({ text: 'gate passed', waitFor: 'gate' });
      const input =
        route === '/v1/responses'
          ? body
          : { messages: [{ role: 'user', content: `[${key}]` }] };
      const pending = invoke(handleLlmRequest, route, { ...input, stream });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(pending.response.headersSent, false);
      assert.deepEqual((await control(`/__mock/barrier?key=${key}`)).barriers, [
        { name: 'gate', waiting: 1, released: false },
      ]);
      await control('/__mock/barrier', { key, name: 'gate' });
      await pending.done;
      assert.equal(pending.response.status, 200);
      assert.match(pending.response.parts.join(''), /gate passed/);
      const early = invoke(handleLlmRequest, route, { ...input, stream });
      await early.done;
      assert.equal(early.response.status, 200);
    }
  }
  resetAll();
});

test('in-process HTTP lifecycle: timeout and reset failures are observed without headers escaping', async () => {
  resetAll();
  register({ waitFor: 'timeout', barrierTimeoutMs: 5 });
  const timed = invoke(handleLlmRequest, '/v1/responses', body);
  await timed.done;
  assert.equal(timed.response.status, 500);
  assert.equal(
    JSON.parse(timed.response.parts.join('')).error.code,
    'mock_barrier_timeout',
  );
  assert.equal(
    (await observations()).requests[0].errorClass,
    'mock_barrier_timeout',
  );
  register({ waitFor: 'reset' });
  const pending = invoke(handleLlmRequest, '/v1/responses', body);
  await new Promise((resolve) => setImmediate(resolve));
  resetAll();
  await pending.done;
  assert.equal(
    JSON.parse(pending.response.parts.join('')).error.code,
    'mock_scenario_reset',
  );
  assert.deepEqual((await observations()).requests, []);
});

test('in-process lifecycle: attempt usage, sticky alternatives, HTTP/WS observation parity and strict credentials', async () => {
  resetAll();
  register({
    stepId: 'retry',
    attempts: [
      { error: { kind: 'status', status: 503 } },
      { text: 'done', usage: { outputTokens: 17 } },
    ],
  });
  const first = invoke(handleLlmRequest, '/v1/responses', body);
  await first.done;
  assert.equal(first.response.status, 503);
  const second = resolveResponsesReply(body, {
    transport: 'ws',
    route: '/v1/responses',
  });
  assert.equal(second.step.text, 'done');
  assert.equal(second.usage.outputTokens, 17);
  const third = invoke(handleLlmRequest, '/v1/responses', body);
  await third.done;
  const entries = (await observations()).requests;
  assert.deepEqual(
    entries.map((entry) => entry.attempt),
    [1, 2, 2],
  );
  assert.deepEqual(entries[1], { ...entries[2], index: 1, transport: 'ws' });
  registerScenario('credential', { strict: true });
  const strict = invoke(
    handleLlmRequest,
    '/v1/responses',
    { input: 'not scripted SECRET' },
    { authorization: 'Bearer credential' },
  );
  await strict.done;
  assert.equal(strict.response.status, 500);
  assert.equal(
    JSON.parse(strict.response.parts.join('')).error.code,
    'mock_unmatched',
  );
  const ws = resolveResponsesReply(
    { input: 'not scripted SECRET' },
    { key: 'credential', transport: 'ws', route: '/v1/responses' },
  );
  assert.equal(ws.step.error.code, 'mock_unmatched');
  assert.doesNotMatch(
    JSON.stringify(await control('/__mock/requests?key=credential')),
    /SECRET/,
  );
  resetAll();
});

test('in-process HTTP lifecycle: delay precedes JSON/SSE headers; close directives match WS error classes', async () => {
  resetAll();
  for (const stream of [false, true]) {
    register({ text: 'delayed', delayMs: 30 });
    const pending = invoke(handleLlmRequest, '/v1/responses', {
      ...body,
      stream,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.response.headersSent, false);
    await pending.done;
    assert.equal(pending.response.status, 200);
  }
  for (const kind of ['disconnect', 'midstream']) {
    register({ text: 'abort', error: { kind, afterFrames: 2 } });
    const pending = invoke(handleLlmRequest, '/v1/responses', {
      ...body,
      stream: true,
    });
    await pending.done;
    assert.equal(pending.response.destroyed, true);
    assert.equal((await observations()).requests[0].errorClass, `mock_${kind}`);
  }
  resetAll();
});

test('in-process lifecycle: bare key runtime state, helper attempts and request tags remain isolated', async () => {
  resetAll();
  registerScenario('CBARE', {
    strict: true,
    llm: {
      steps: [{ stepId: 'bare', attempts: [{ text: 'one' }, { text: 'two' }] }],
    },
  });
  const bareBody = { input: [{ role: 'user', content: '[Canopy-CBARE]' }] };
  const first = resolveResponsesReply(bareBody, {
    transport: 'ws',
    route: '/responses',
  });
  assert.equal(first.scenarioKey, 'CBARE');
  assert.equal(
    (await control('/__mock/requests?key=CBARE')).requests[0].attempt,
    1,
  );
  registerScenario('CBARE', {
    strict: true,
    llm: { steps: [{ stepId: 'bare', attempts: [{ text: 'new' }] }] },
  });
  assert.equal(
    resolveResponsesReply(bareBody, { transport: 'ws', route: '/responses' })
      .step.text,
    'new',
  );
  registerScenario(key, {
    llm: {
      steps: [{ text: 'history fallback' }],
      helperStepsById: {
        'branch-naming': {
          stepId: 'helper',
          attempts: [{ text: 'helper one' }, { text: 'helper two' }],
        },
      },
      stepsByRequestTag: {
        tagged: {
          stepId: 'tagged',
          attempts: [{ text: 'tag one' }, { text: 'tag two' }],
        },
      },
    },
  });
  const context = { transport: 'ws', route: '/v1/responses' };
  const helper = {
    ...body,
    instructions: 'You are an expert at generating concise git branch names',
  };
  assert.equal(resolveResponsesReply(helper, context).step.text, 'helper one');
  assert.equal(resolveResponsesReply(helper, context).step.text, 'helper two');
  const tagged = {
    input: [{ role: 'user', content: `[${key}] [Canopy-Mock-Request:tagged]` }],
  };
  assert.equal(resolveResponsesReply(tagged, context).step.text, 'tag one');
  assert.equal(resolveResponsesReply(tagged, context).step.text, 'tag two');
  assert.deepEqual(
    (await observations()).requests.map((r) => r.attempt),
    [1, 2, 1, 2],
  );
  resetAll();
});
