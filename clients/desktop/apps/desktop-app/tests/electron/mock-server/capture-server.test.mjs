// Integration tests for the dedicated outbound-capture listener
// (./capture-server.mjs). Real HTTP, raw-socket and WebSocket clients drive
// scripted conversations; replies are compared with the shared mock's own
// transports (routes/llm.mjs over HTTP, routes/responsesWs.mjs over
// WebSocket) to prove the capture changes no scripted native loop.
//
// Run:  node --test apps/desktop-app/tests/electron/mock-server/capture-server.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createCaptureServer } from './capture-server.mjs';
import { CAPTURE_SURFACES } from './outbound-capture.mjs';
import {
  DEFAULT_SCENARIO,
  getScenario,
  registerScenario,
  resetAll,
} from './control-plane.mjs';
import { handleLlmRequest } from './routes/llm.mjs';
import { attachResponsesWebSocket } from './routes/responsesWs.mjs';

const ABSENT_CANARY = 'NEVER_SENT_CANARY_6e19f0';
const DEFAULT_TEXT = 'Mock response from the Canopy UI-automation LLM surface.';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
  };
}

async function startCapture(options) {
  const capture = createCaptureServer(options);
  return { ...capture, ...(await listen(capture.server)) };
}

// The shared mock's composition (see routes/llm.test.mjs), used as the oracle.
async function startReference() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handleLlmRequest(request, response, url).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  const wss = attachResponsesWebSocket(server);
  const address = await listen(server);
  return {
    ...address,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function post(base, path, body, headers = {}) {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: payload,
  });
  return { status: response.status, text: await response.text() };
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const data = block
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length)
        .trim();
      return data === '[DONE]' ? { done: true } : JSON.parse(data);
    });
}

// Replace generated ids (`msg_mock_…`, `resp_mock_…`, `fc_mock_…`, …).
function withoutIds(value) {
  return JSON.parse(
    JSON.stringify(value).replace(/"[a-z_]*mock_[A-Za-z0-9_-]*"/g, '"<id>"'),
  );
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

function collectTurn(ws) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a terminal response event'));
    }, 3000);
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      if (
        frame.type === 'response.completed' ||
        frame.type === 'response.failed'
      ) {
        cleanup();
        resolve(frames);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before a terminal response event'));
    };
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
    }
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

// Send a string or Buffer as-is and anything else as JSON text.
async function exchange(ws, frame, options = {}) {
  const turn = collectTurn(ws);
  const data =
    typeof frame === 'string' || Buffer.isBuffer(frame)
      ? frame
      : JSON.stringify(frame);
  ws.send(data, options);
  return turn;
}

async function waitFor(predicate, description, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      assert.fail(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A raw HTTP/1.1 request whose body the test finishes (or abandons) later.
function openRawRequest(port, { path, contentLength, initial = '' }) {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => {});
  let received = '';
  socket.on('data', (chunk) => {
    received += chunk.toString();
  });
  const closed = once(socket, 'close').then(() => received);
  socket.write(
    [
      `POST ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
      'Content-Type: application/json',
      `Content-Length: ${contentLength}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n') + initial,
  );
  return { socket, closed };
}

function recordBySeq(snapshot, seq) {
  const record = snapshot.records.find((entry) => entry.seq === seq);
  assert.ok(record, `record #${seq} exists`);
  return record;
}

function httpRecords(snapshot, path) {
  return snapshot.records.filter(
    (record) => record.kind === 'http' && record.path === path,
  );
}

function rawBytes(record) {
  return Buffer.from(record.rawBase64, 'base64');
}

function assertAccounting(snapshot) {
  const { counts, bytes, kinds, records } = snapshot;
  assert.equal(counts.received, counts.recorded + counts.dropped);
  assert.equal(counts.recorded, records.length);
  assert.equal(counts.complete + counts.incomplete, counts.recorded);
  assert.equal(kinds.http + kinds.wsUpgrade + kinds.wsMessage, counts.received);
  assert.equal(bytes.received, bytes.retained + bytes.omitted);
  for (const record of records) {
    assert.equal(record.complete, record.incomplete.length === 0);
    assert.equal(rawBytes(record).length, record.retainedBytes);
    assert.equal(Object.hasOwn(record, 'json'), record.parse === 'ok');
  }
}

test('HTTP scripted loops answer like the shared mock and record full history with tool results', async () => {
  resetAll();
  registerScenario('Canopy-CCAPHTTP', {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'read_file', input: { path: 'notes.txt' } }],
          stopReason: 'tool_use',
        },
        { text: 'Read complete.', stopReason: 'end_turn' },
      ],
    },
  });
  const history = 'HTTP_HISTORY_CANARY_42f1';
  const toolResult = 'HTTP_TOOL_RESULT_CANARY_8c3d';
  const responsesTool = 'RESPONSES_TOOL_RESULT_CANARY_1b9e';
  const secrets = [
    'AUTH_HEADER_SECRET_CANARY_1',
    'API_KEY_SECRET_CANARY_2',
    'QUERY_VALUE_SECRET_CANARY_3',
  ];
  const headers = {
    authorization: `Bearer ${secrets[0]}`,
    'x-api-key': secrets[1],
  };
  const messagesPath = `/v1/messages?beta=true&token=${secrets[2]}`;
  const user = { role: 'user', content: `[Canopy-CCAPHTTP] Read ${history}` };
  const anthropicTurns = [
    { model: 'claude-mock', stream: true, messages: [user] },
    {
      model: 'claude-mock',
      stream: true,
      messages: [
        user,
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mock_0',
              name: 'read_file',
              input: { path: 'notes.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_mock_0',
              content: [{ type: 'text', text: `notes: ${toolResult}` }],
            },
          ],
        },
      ],
    },
  ];
  const responsesTurns = [
    { model: 'gpt-mock', stream: true, input: [user] },
    {
      model: 'gpt-mock',
      stream: true,
      input: [
        user,
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"notes.txt"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: responsesTool,
        },
      ],
    },
  ];

  const capture = await startCapture();
  const reference = await startReference();
  try {
    const replies = [];
    for (const [path, body] of [
      ...anthropicTurns.map((body) => [messagesPath, body]),
      ...responsesTurns.map((body) => ['/v1/responses', body]),
    ]) {
      const captured = await post(capture.base, path, body, headers);
      const expected = await post(reference.base, path, body, headers);
      assert.equal(captured.status, 200);
      assert.equal(captured.status, expected.status);
      assert.deepEqual(
        withoutIds(sseEvents(captured.text)),
        withoutIds(sseEvents(expected.text)),
      );
      replies.push(sseEvents(captured.text));
    }
    // The scripted loop ran: a tool call, then the final text, per provider.
    assert.ok(
      replies[0].some((event) => event.content_block?.name === 'read_file'),
    );
    assert.ok(
      replies[1].some((event) => event.delta?.text?.includes('Read complete.')),
    );
    assert.ok(replies[2].some((event) => event.item?.name === 'read_file'));
    assert.ok(replies[3].some((event) => event.text === 'Read complete.'));

    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.equal(snapshot.counts.received, 4);
    const [first, second, third, fourth] = snapshot.records;
    const bodies = [...anthropicTurns, ...responsesTurns];
    for (const [index, record] of snapshot.records.entries()) {
      assert.equal(record.kind, 'http');
      assert.equal(record.method, 'POST');
      assert.equal(record.handled, true);
      assert.equal(record.status, 200);
      assert.equal(record.prompt, 'full');
      assert.equal(record.complete, true);
      assert.equal(record.marker, 'Canopy-CCAPHTTP');
      assert.deepEqual(
        rawBytes(record),
        Buffer.from(JSON.stringify(bodies[index])),
      );
      assert.deepEqual(record.json, bodies[index]);
    }
    assert.equal(first.path, '/v1/messages');
    assert.deepEqual(first.queryKeys, ['beta', 'token']);
    assert.equal(first.surface, CAPTURE_SURFACES.anthropicMessages);
    assert.equal(third.surface, CAPTURE_SURFACES.openAiResponses);
    for (const secret of secrets) {
      assert.equal(JSON.stringify(snapshot).includes(secret), false, secret);
    }

    // The follow-up requests carry the full history and the tool results.
    capture.capture.assertCanaryPresent(history, {
      filter: (record) => record.seq === second.seq,
    });
    capture.capture.assertCanaryPresent(history, {
      filter: (record) => record.seq === fourth.seq,
    });
    assert.deepEqual(
      capture.capture.assertCanaryPresent(toolResult, { toolResult: true })
        .matches,
      [second.seq],
    );
    assert.deepEqual(
      capture.capture.assertCanaryPresent(responsesTool, { toolResult: true })
        .matches,
      [fourth.seq],
    );
    assert.throws(
      () => capture.capture.assertCanaryPresent(history, { toolResult: true }),
      /was not found in a tool result/,
    );
    capture.capture.assertCanaryAbsent([ABSENT_CANARY, ...secrets]);
    assert.equal(capture.capture.assertComplete().counts.complete, 4);
  } finally {
    await capture.close();
    await reference.close();
  }
});

test('WebSocket frames answer like responsesWs.mjs; delta and prewarm frames are never full prompts', async () => {
  resetAll();
  registerScenario('Canopy-CCAPWS', {
    llm: {
      steps: [
        {
          text: 'Looking it up.',
          toolCalls: [{ name: 'lookup', input: { q: 1 } }],
          stopReason: 'tool_use',
        },
        { text: 'Lookup complete.', stopReason: 'end_turn' },
      ],
    },
  });
  const history = 'WS_HISTORY_CANARY_0a7d';
  const toolResult = 'WS_TOOL_RESULT_CANARY_5e2c';
  const deltaResult = 'WS_DELTA_RESULT_CANARY_91bb';
  const user = { role: 'user', content: `[Canopy-CCAPWS] Find ${history}` };
  const capture = await startCapture();
  const reference = await startReference();
  const sockets = [];
  try {
    const captured = await openWs(`${capture.wsBase}/v1/responses`);
    const expected = await openWs(`${reference.wsBase}/v1/responses`);
    sockets.push(captured, expected);
    const both = async (frame, options) => {
      const [left, right] = await Promise.all([
        exchange(captured, frame, options),
        exchange(expected, frame, options),
      ]);
      assert.deepEqual(withoutIds(left), withoutIds(right));
      return left;
    };

    const firstTurn = await both({
      type: 'response.create',
      model: 'gpt-mock',
      input: [user],
    });
    const call = firstTurn
      .at(-1)
      .response.output.find((item) => item.type === 'function_call');
    assert.equal(call.name, 'lookup');
    const secondTurn = await both({
      type: 'response.create',
      model: 'gpt-mock',
      input: [
        user,
        call,
        {
          type: 'function_call_output',
          call_id: call.call_id,
          output: toolResult,
        },
      ],
    });
    assert.equal(
      secondTurn.find((frame) => frame.type === 'response.output_text.done')
        ?.text,
      'Lookup complete.',
    );
    const secondResponseId = secondTurn.at(-1).response.id;
    // The shared mock answers a prewarm and a delta too; only the evidence
    // labels them as partial prompts.
    await both({
      type: 'response.create',
      model: 'gpt-mock',
      generate: false,
      input: [user],
    });
    await both({
      type: 'response.create',
      model: 'gpt-mock',
      previous_response_id: secondResponseId,
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_2',
          output: deltaResult,
        },
      ],
    });
    // Ignored by both transports: invalid JSON and a non-create event. The
    // next reply belongs to the binary response.create that follows.
    captured.send('not json');
    captured.send(JSON.stringify({ type: 'response.cancel' }));
    const binaryTurn = await exchange(
      captured,
      Buffer.from(
        JSON.stringify({
          type: 'response.create',
          model: 'gpt-mock',
          input: [{ role: 'user', content: 'unmarked binary frame' }],
        }),
      ),
      { binary: true },
    );
    assert.equal(binaryTurn[0].type, 'response.created');
    assert.equal(
      binaryTurn.find((frame) => frame.type === 'response.output_text.done')
        ?.text,
      DEFAULT_TEXT,
    );
    // `/responses` is served too, on its own connection.
    const bare = await openWs(`${capture.wsBase}/responses`);
    sockets.push(bare);
    await exchange(bare, {
      type: 'response.create',
      model: 'gpt-mock',
      previous_response_id: 'resp_from_an_earlier_window',
      input: [],
    });

    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.deepEqual(snapshot.kinds, { http: 0, wsUpgrade: 2, wsMessage: 8 });
    const [
      upgrade,
      full1,
      full2,
      prewarm,
      delta,
      invalid,
      other,
      binary,
      bareUpgrade,
      unresolved,
    ] = snapshot.records;
    assert.equal(upgrade.kind, 'ws-upgrade');
    assert.equal(upgrade.upgrade, 'accepted');
    assert.equal(upgrade.path, '/v1/responses');
    assert.equal(bareUpgrade.path, '/responses');
    assert.notEqual(bareUpgrade.connection, upgrade.connection);
    assert.deepEqual(
      [full1, full2, prewarm, delta, invalid, other, binary].map((record) => [
        record.connection,
        record.frame,
        record.prompt,
        record.parse,
        record.reply,
        record.incomplete.join('|'),
      ]),
      [
        [upgrade.connection, 1, 'full', 'ok', 'response', ''],
        [upgrade.connection, 2, 'full', 'ok', 'response', ''],
        [upgrade.connection, 3, 'prewarm', 'ok', 'response', 'prewarm'],
        [upgrade.connection, 4, 'delta', 'ok', 'response', 'delta'],
        [upgrade.connection, 5, 'none', 'invalid', 'ignored', ''],
        [upgrade.connection, 6, 'none', 'ok', 'ignored', ''],
        [upgrade.connection, 7, 'full', 'ok', 'response', ''],
      ],
    );
    assert.equal(full2.responseId, secondResponseId);
    assert.equal(delta.previousResponseId, secondResponseId);
    assert.equal(delta.previousSeq, full2.seq);
    assert.equal(binary.binary, true);
    assert.equal(binary.marker, null);
    assert.deepEqual(rawBytes(invalid), Buffer.from('not json'));
    assert.deepEqual(unresolved.incomplete, ['delta', 'unresolved-delta']);
    assert.equal(unresolved.connection, bareUpgrade.connection);

    // Full history and tool result in the full follow-up frame.
    capture.capture.assertCanaryPresent(history, {
      filter: (record) => record.seq === full2.seq,
    });
    assert.deepEqual(
      capture.capture.assertCanaryPresent(toolResult, { toolResult: true })
        .matches,
      [full2.seq],
    );
    // A delta carries the new tool result but is not a full prompt.
    assert.throws(
      () => capture.capture.assertCanaryPresent(deltaResult),
      /prompt delta: not a full prompt/,
    );
    assert.deepEqual(
      capture.capture.assertCanaryPresent(deltaResult, {
        fullPrompt: false,
        toolResult: true,
      }).matches,
      [delta.seq],
    );
    assert.throws(
      () =>
        capture.capture.assertCanaryPresent(history, {
          fullPrompt: false,
          filter: (record) => record.seq === delta.seq,
        }),
      /does not occur in any searched record/,
    );
    assert.throws(
      () => capture.capture.assertComplete(),
      (error) =>
        error.message.includes(`#${prewarm.seq} ws-message`) &&
        error.message.includes('[prewarm]') &&
        error.message.includes(`#${delta.seq} ws-message`) &&
        error.message.includes('[delta, unresolved-delta]'),
    );
    // Resolved deltas and prewarms keep absence provable; the unresolved
    // delta on the second connection does not.
    capture.capture.assertCanaryAbsent(ABSENT_CANARY, {
      filter: (record) => record.connection === upgrade.connection,
    });
    assert.throws(
      () => capture.capture.assertCanaryAbsent(ABSENT_CANARY),
      /Cannot prove canary absence: .*\[unresolved-delta\]/,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await capture.close();
    await reference.close();
  }
});

test('every HTTP path is recorded explicitly, with no evidence or control endpoints', async () => {
  resetAll();
  registerScenario('csk_capture_existing', { cloud: {} });
  const capture = await startCapture();
  const gzip = gzipSync(Buffer.from(JSON.stringify({ messages: [] })));
  try {
    const empty = await post(capture.base, '/v1/messages', '');
    const invalid = await post(capture.base, '/v1/messages', '{"messages": [');
    const encoded = await post(capture.base, '/v1/messages', gzip, {
      'content-encoding': 'gzip',
    });
    const unmarked = await post(capture.base, '/v1/messages', {
      messages: [{ role: 'user', content: 'plain question' }],
    });
    const helper = await post(capture.base, '/v1/messages', {
      system: 'You generate git commit messages from the supplied diff.',
      messages: [{ role: 'user', content: 'diff --git a b' }],
    });
    const countTokens = await post(capture.base, '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: 'COUNT_TOKENS_CANARY_77' }],
    });
    const models = await fetch(`${capture.base}/v1/models`);
    const proxied = await post(
      capture.base,
      '/api/v1/llm-proxy/anthropic/v1/messages',
      { messages: [{ role: 'user', content: 'via credits' }] },
    );
    const unrouted = await post(capture.base, '/v2/unknown', { a: 1 });
    const put = await fetch(`${capture.base}/v1/messages`, {
      method: 'PUT',
      body: '{}',
    });
    const control = await post(capture.base, '/__mock/state', {
      key: 'csk_capture_probe',
      scenario: { cloud: {} },
    });
    const controlReset = await post(capture.base, '/__mock/reset', '');
    const evidence = await fetch(`${capture.base}/__mock/activity/Canopy-C1`);
    const health = await fetch(`${capture.base}/healthz`);

    // Replies are the mock's; empty, invalid and encoded bodies reach it as
    // the `{}` fallback, while the evidence below stays exact.
    for (const reply of [empty, invalid, encoded, unmarked, proxied]) {
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.text).content[0].text, DEFAULT_TEXT);
    }
    assert.match(JSON.parse(helper.text).content[0].text, /chore: mock commit/);
    assert.deepEqual(JSON.parse(countTokens.text), { input_tokens: 1200 });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).object, 'list');
    for (const [reply, path] of [
      [unrouted, '/v2/unknown'],
      [control, '/__mock/state'],
      [controlReset, '/__mock/reset'],
    ]) {
      assert.equal(reply.status, 404);
      assert.deepEqual(JSON.parse(reply.text), {
        error: `Unhandled mock route: ${path}`,
      });
    }
    for (const reply of [put, evidence, health]) {
      assert.equal(reply.status, 404);
      await reply.text();
    }
    // Control routes did not reach the control plane.
    assert.equal(getScenario('csk_capture_probe'), DEFAULT_SCENARIO);
    assert.deepEqual(getScenario('csk_capture_existing'), { cloud: {} });

    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.equal(snapshot.counts.received, 14);
    assert.equal(snapshot.counts.dropped, 0);
    const summary = snapshot.records.map((record) => [
      record.method,
      record.path,
      record.surface,
      record.parse,
      record.prompt,
      record.handled,
      record.status,
      record.incomplete.join('|'),
    ]);
    const messages = CAPTURE_SURFACES.anthropicMessages;
    assert.deepEqual(summary, [
      ['POST', '/v1/messages', messages, 'empty', 'none', true, 200, ''],
      ['POST', '/v1/messages', messages, 'invalid', 'none', true, 200, ''],
      [
        'POST',
        '/v1/messages',
        messages,
        'encoded',
        'none',
        true,
        200,
        'encoded',
      ],
      ['POST', '/v1/messages', messages, 'ok', 'full', true, 200, ''],
      ['POST', '/v1/messages', messages, 'ok', 'full', true, 200, ''],
      [
        'POST',
        '/v1/messages/count_tokens',
        CAPTURE_SURFACES.anthropicCountTokens,
        'ok',
        'none',
        true,
        200,
        '',
      ],
      [
        'GET',
        '/v1/models',
        CAPTURE_SURFACES.models,
        'empty',
        'none',
        true,
        200,
        '',
      ],
      [
        'POST',
        '/api/v1/llm-proxy/anthropic/v1/messages',
        messages,
        'ok',
        'full',
        true,
        200,
        '',
      ],
      ['POST', '/v2/unknown', null, 'ok', 'none', false, 404, ''],
      ['PUT', '/v1/messages', null, 'ok', 'none', false, 404, ''],
      ['POST', '/__mock/state', null, 'ok', 'none', false, 404, ''],
      ['POST', '/__mock/reset', null, 'empty', 'none', false, 404, ''],
      [
        'GET',
        '/__mock/activity/Canopy-C1',
        null,
        'empty',
        'none',
        false,
        404,
        '',
      ],
      ['GET', '/healthz', null, 'empty', 'none', false, 404, ''],
    ]);
    const [emptyRecord, invalidRecord, encodedRecord, unmarkedRecord] =
      snapshot.records;
    assert.equal(emptyRecord.rawBase64, '');
    assert.deepEqual(rawBytes(invalidRecord), Buffer.from('{"messages": ['));
    assert.deepEqual(rawBytes(encodedRecord), gzip);
    assert.equal(encodedRecord.contentEncoding, 'gzip');
    assert.equal(unmarkedRecord.marker, null);
    for (const record of [emptyRecord, invalidRecord, encodedRecord]) {
      assert.equal(Object.hasOwn(record, 'json'), false, 'never a silent {}');
    }
    // count_tokens is outbound content but not a generation prompt.
    assert.throws(
      () => capture.capture.assertCanaryPresent('COUNT_TOKENS_CANARY_77'),
      /prompt none/,
    );
    capture.capture.assertCanaryPresent('COUNT_TOKENS_CANARY_77', {
      fullPrompt: false,
    });
    assert.throws(
      () => capture.capture.assertCanaryAbsent(ABSENT_CANARY),
      /Cannot prove canary absence: #3 http POST \/v1\/messages \[encoded\]/,
    );
  } finally {
    await capture.close();
  }
});

test('bodies the mock never reads are drained and recorded in full', async () => {
  resetAll();
  // Larger than the forwarding stream's buffer, so an undrained body stalls.
  const big = Buffer.alloc(200 * 1024, 0x61);
  const capture = await startCapture();
  const agent = new Agent({ keepAlive: true });
  try {
    const unrouted = await post(capture.base, '/v2/unknown', big);
    assert.equal(unrouted.status, 404);
    // GET /v1/models is answered before its (unusual) body is read.
    const models = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${capture.base}/v1/models`,
        { method: 'GET', agent, headers: { 'content-length': big.length } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end(big);
    });
    assert.equal(models, 200);
    await waitFor(
      () => capture.capture.snapshot().counts.pending === 0,
      'both bodies to drain',
    );
    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.deepEqual(
      snapshot.records.map((record) => [
        record.method,
        record.path,
        record.handled,
        record.status,
        record.byteLength,
        record.retainedBytes,
        record.parse,
        record.complete,
      ]),
      [
        [
          'POST',
          '/v2/unknown',
          false,
          404,
          big.length,
          big.length,
          'invalid',
          true,
        ],
        [
          'GET',
          '/v1/models',
          true,
          200,
          big.length,
          big.length,
          'invalid',
          true,
        ],
      ],
    );
  } finally {
    agent.destroy();
    await capture.close();
  }
});

test('aborted, malformed and failing traffic becomes explicit incomplete evidence', async () => {
  resetAll();
  const capture = await startCapture();
  try {
    // A body abandoned mid-stream: Node reports a parser error before the
    // request aborts; it must stay one aborted item, not two.
    const partial = openRawRequest(capture.port, {
      path: '/v1/messages',
      contentLength: 100,
      initial: '{"messages":',
    });
    await waitFor(
      () => capture.capture.snapshot().records[0]?.byteLength === 12,
      'the partial body',
    );
    partial.socket.destroy();
    await waitFor(
      () => capture.capture.snapshot().counts.pending === 0,
      'the aborted body',
    );

    const garbage = connect(capture.port, '127.0.0.1');
    garbage.on('error', () => {});
    garbage.write('GARBAGE\r\n\r\n');
    await once(garbage, 'close');

    const ws = await openWs(`${capture.wsBase}/v1/responses`);
    const closedWith = once(ws, 'close');
    ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
    const [closeCode] = await closedWith;
    assert.equal(closeCode, 1007);

    const failing = await openWs(`${capture.wsBase}/v1/responses`);
    const failingClosed = once(failing, 'close');
    failing.send(JSON.stringify({ type: 'response.create', input: [null] }));
    const [failingCode] = await failingClosed;
    assert.equal(failingCode, 1011);
    const httpFailure = await post(capture.base, '/v1/responses', {
      input: [null],
    });
    assert.equal(httpFailure.status, 500);

    const refused = new WebSocket(`${capture.wsBase}/elsewhere`);
    const [refusal] = await once(refused, 'error');
    assert.match(refusal.message, /404/);

    const badHandshake = connect(capture.port, '127.0.0.1');
    let handshakeReply = '';
    badHandshake.on('data', (chunk) => {
      handshakeReply += chunk.toString();
    });
    badHandshake.on('error', () => {});
    badHandshake.write(
      'GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    await once(badHandshake, 'close');
    assert.match(handshakeReply, /^HTTP\/1\.1 400 /);
    await waitFor(
      () => capture.capture.snapshot().records.at(-1)?.upgrade === 'rejected',
      'the refused handshake',
    );

    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.deepEqual(
      snapshot.records.map((record) => [
        record.kind,
        record.path,
        record.state,
        record.upgrade,
        record.reply,
        record.incomplete.join('|'),
      ]),
      [
        ['http', '/v1/messages', 'aborted', null, null, 'aborted'],
        ['http', null, 'aborted', null, null, 'malformed'],
        ['ws-upgrade', '/v1/responses', 'done', 'accepted', null, ''],
        ['ws-message', null, 'aborted', null, null, 'malformed'],
        ['ws-upgrade', '/v1/responses', 'done', 'accepted', null, ''],
        ['ws-message', null, 'done', null, 'error', ''],
        ['http', '/v1/responses', 'done', null, null, ''],
        ['ws-upgrade', '/elsewhere', 'done', 'rejected', null, ''],
        ['ws-upgrade', '/v1/responses', 'done', 'rejected', null, ''],
      ],
    );
    const [aborted, malformed, , badFrame, , , failedRequest] =
      snapshot.records;
    assert.deepEqual(rawBytes(aborted), Buffer.from('{"messages":'));
    assert.equal(aborted.parse, 'truncated');
    assert.match(aborted.error, /^(HPE_|ECONNRESET|closed)/);
    assert.equal(malformed.error, 'HPE_INVALID_METHOD');
    assert.equal(badFrame.error, 'WS_ERR_INVALID_UTF8');
    assert.equal(failedRequest.handled, false);
    assert.equal(failedRequest.status, 500);
    assert.deepEqual(
      snapshot.diagnostics
        .filter((entry) => entry.code === 'handler-error')
        .map((entry) => entry.detail.endsWith('(TypeError)')),
      [true, true],
    );
    assert.throws(
      () => capture.capture.assertComplete(),
      /aborted[\s\S]*malformed/,
    );
  } finally {
    await capture.close();
  }
});

test('hard caps bound the evidence but never what the mock receives', async () => {
  resetAll();
  registerScenario('Canopy-CCAPCAP', {
    llm: {
      steps: [{ text: 'Scripted despite truncation.', stopReason: 'end_turn' }],
    },
  });
  // The marker sits past every cap, so the mock must see the whole body.
  const body = {
    model: 'claude-mock',
    messages: [
      { role: 'user', content: `${'x'.repeat(1000)} [Canopy-CCAPCAP]` },
    ],
  };
  const bodyBytes = Buffer.byteLength(JSON.stringify(body));
  const frame = {
    type: 'response.create',
    input: [{ role: 'user', content: `${'y'.repeat(1000)} [Canopy-CCAPCAP]` }],
  };
  const capture = await startCapture({
    maxBodyBytes: 256,
    maxTotalBytes: 400,
    maxRecords: 3,
    maxDiagnostics: 2,
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const reply = await post(capture.base, '/v1/messages', body);
      assert.equal(
        JSON.parse(reply.text).content[0].text,
        'Scripted despite truncation.',
      );
    }
    const ws = await openWs(`${capture.wsBase}/v1/responses`);
    const turn = await exchange(ws, frame);
    ws.terminate();
    assert.equal(
      turn.find((event) => event.type === 'response.output_text.done')?.text,
      'Scripted despite truncation.',
    );
    const dropped = await post(capture.base, '/v1/messages', body);
    assert.equal(
      JSON.parse(dropped.text).content[0].text,
      'Scripted despite truncation.',
    );

    const snapshot = capture.capture.snapshot();
    assertAccounting(snapshot);
    assert.deepEqual(snapshot.counts, {
      received: 5,
      recorded: 3,
      dropped: 2,
      pending: 0,
      complete: 1,
      incomplete: 2,
    });
    const [first, second, upgrade] = snapshot.records;
    assert.equal(first.byteLength, bodyBytes);
    assert.equal(first.retainedBytes, 256);
    assert.deepEqual(
      rawBytes(first),
      Buffer.from(JSON.stringify(body)).subarray(0, 256),
    );
    assert.deepEqual(first.incomplete, ['body-cap']);
    assert.equal(first.parse, 'truncated');
    assert.equal(second.retainedBytes, 144);
    assert.deepEqual(second.incomplete, ['total-cap']);
    assert.equal(upgrade.kind, 'ws-upgrade');
    const frameBytes = Buffer.byteLength(JSON.stringify(frame));
    assert.deepEqual(snapshot.bytes, {
      received: 3 * bodyBytes + frameBytes,
      retained: 400,
      omitted: 3 * bodyBytes + frameBytes - 400,
    });
    assert.deepEqual(snapshot.overflow, {
      bodyCapRecords: 1,
      totalCapRecords: 1,
      droppedDiagnostics: 2,
    });
    assert.deepEqual(
      snapshot.diagnostics.map((entry) => entry.code),
      ['body-cap', 'total-cap'],
    );
    assert.throws(
      () => capture.capture.assertCanaryAbsent(ABSENT_CANARY),
      /Cannot prove canary absence: 2 of 5 received items were not recorded \(maxRecords 3\)/,
    );
    assert.throws(() => capture.capture.assertComplete(), /body-cap/);
  } finally {
    await capture.close();
  }
});

test('reset() opens a clean window, snapshots are detached, and an in-flight body keeps its reply', async () => {
  resetAll();
  registerScenario('Canopy-CCAPRESET', {
    llm: { steps: [{ text: 'Reply after reset.', stopReason: 'end_turn' }] },
  });
  const capture = await startCapture();
  try {
    await post(capture.base, '/v1/messages', {
      messages: [{ role: 'user', content: 'before reset' }],
    });
    const first = capture.capture.snapshot();
    const serialized = JSON.stringify(first);
    first.records[0].json.messages[0].content = 'mutated';
    first.records.length = 0;
    first.counts.received = 0;
    assert.equal(JSON.stringify(capture.capture.snapshot()), serialized);

    const body = JSON.stringify({
      messages: [{ role: 'user', content: '[Canopy-CCAPRESET] straddle' }],
    });
    const split = 20;
    const straddling = openRawRequest(capture.port, {
      path: '/v1/messages',
      contentLength: Buffer.byteLength(body),
      initial: body.slice(0, split),
    });
    await waitFor(
      () => capture.capture.snapshot().counts.pending === 1,
      'the in-flight body',
    );
    capture.capture.reset();
    assert.deepEqual(capture.capture.snapshot().counts, {
      received: 0,
      recorded: 0,
      dropped: 0,
      pending: 0,
      complete: 0,
      incomplete: 0,
    });
    straddling.socket.write(body.slice(split));
    const reply = await straddling.closed;
    assert.match(reply, /^HTTP\/1\.1 200 /);
    assert.match(reply, /Reply after reset\./);
    const afterReset = capture.capture.snapshot();
    assert.equal(afterReset.counts.received, 0, 'old window bytes stay out');
    assert.deepEqual(afterReset.bytes, {
      received: 0,
      retained: 0,
      omitted: 0,
    });

    await post(capture.base, '/v1/messages', { messages: [] });
    const next = capture.capture.snapshot();
    assertAccounting(next);
    // seq keeps counting across reset: #1 before, #2 in flight, #3 now.
    assert.deepEqual(
      next.records.map((record) => record.seq),
      [3],
    );
  } finally {
    await capture.close();
  }
});

test(
  'close() stops listening, cancels paced streams and releases every socket',
  { timeout: 15_000 },
  async () => {
    resetAll();
    registerScenario('Canopy-CCAPCLOSE', {
      llm: {
        steps: [
          {
            // 40 paced chunks, 15 seconds apart: a pacing timer that close()
            // failed to clear would outlive the timer check below.
            text: 'z'.repeat(40),
            chunkChars: 1,
            streamMs: 600_000,
            stopReason: 'end_turn',
          },
        ],
      },
    });
    const timeoutsBefore = process
      .getActiveResourcesInfo()
      .filter((type) => type === 'Timeout').length;
    const capture = await startCapture();
    const agent = new Agent({ keepAlive: true });
    try {
      // An idle keep-alive connection.
      await new Promise((resolve, reject) => {
        const request = httpRequest(
          `${capture.base}/v1/models`,
          { agent },
          (response) => {
            response.resume();
            response.on('end', resolve);
          },
        );
        request.on('error', reject);
        request.end();
      });
      // A paced WebSocket stream that would run for a minute.
      const ws = await openWs(`${capture.wsBase}/v1/responses`);
      ws.on('error', () => {});
      const firstDelta = new Promise((resolve) => {
        ws.on('message', (data) => {
          if (
            JSON.parse(data.toString()).type === 'response.output_text.delta'
          ) {
            resolve();
          }
        });
      });
      ws.send(
        JSON.stringify({
          type: 'response.create',
          input: [{ role: 'user', content: '[Canopy-CCAPCLOSE] stream' }],
        }),
      );
      await firstDelta;
      // A request body still in flight.
      const partial = openRawRequest(capture.port, {
        path: '/v1/messages',
        contentLength: 50,
        initial: '{"mess',
      });
      await waitFor(
        () => capture.capture.snapshot().counts.pending === 1,
        'the in-flight body',
      );

      const started = Date.now();
      const closing = capture.close();
      assert.equal(capture.close(), closing, 'close() is idempotent');
      await closing;
      assert.ok(
        Date.now() - started < 2000,
        'close() does not wait for pacing',
      );
      assert.equal(capture.server.listening, false);
      await Promise.all([
        ws.readyState === WebSocket.CLOSED ? undefined : once(ws, 'close'),
        partial.closed,
      ]);

      const snapshot = capture.capture.snapshot();
      assertAccounting(snapshot);
      const inflight = snapshot.records.at(-1);
      assert.equal(inflight.state, 'aborted');
      assert.equal(inflight.error, 'server-closed');
      assert.deepEqual(inflight.incomplete, ['aborted']);
      const deltas = snapshot.records.filter(
        (record) => record.kind === 'ws-message',
      );
      assert.equal(deltas.length, 1);
      assert.equal(deltas[0].reply, 'response');

      agent.destroy();
      await waitFor(
        () =>
          process.getActiveResourcesInfo().filter((type) => type === 'Timeout')
            .length <= timeoutsBefore,
        'the listener timers to clear',
      );
    } finally {
      agent.destroy();
      await capture.close();
    }
  },
);

test('recording is opt-in: the shared server never loads the capture modules', async () => {
  const shared = [
    './start.mjs',
    './control-plane.mjs',
    './routes/llm.mjs',
    './routes/responsesWs.mjs',
  ];
  for (const file of shared) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /outbound-capture|capture-server/, file);
  }
  const { server, capture, close } = createCaptureServer();
  assert.equal(server.listening, false);
  assert.equal(capture.snapshot().counts.received, 0);
  assert.throws(() => createCaptureServer({ maxRecords: 0 }), RangeError);
  await close();
});
