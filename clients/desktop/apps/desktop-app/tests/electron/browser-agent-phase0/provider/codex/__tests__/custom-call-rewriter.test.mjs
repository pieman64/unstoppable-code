import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { registerScenario, startCapture } from '../../shared/capture.mjs';
import {
  CUSTOM_INPUT_KEY,
  createCustomCallRewriter,
  createSseRewriter,
  rewriteResponsesEvent,
} from '../custom-call-rewriter.mjs';
import { findToolExchanges } from '../followup-analysis.mjs';

const SOURCE = 'text("hello \\n world"); // ü';

function execCall(overrides = {}) {
  return {
    id: 'fc_1',
    type: 'function_call',
    name: 'exec',
    call_id: 'call_1',
    arguments: JSON.stringify({ [CUSTOM_INPUT_KEY]: SOURCE }),
    ...overrides,
  };
}

test('only a marked function_call to a listed tool becomes a custom_tool_call', () => {
  const done = {
    type: 'response.output_item.done',
    output_index: 0,
    item: execCall(),
  };
  const rewritten = rewriteResponsesEvent(done, { toolNames: ['exec'] });
  assert.equal(rewritten.rewritten, 1);
  assert.deepEqual(rewritten.event.item, {
    id: 'fc_1',
    type: 'custom_tool_call',
    name: 'exec',
    call_id: 'call_1',
    input: SOURCE,
  });
  for (const item of [
    execCall({ name: 'observe' }),
    execCall({ arguments: '{}' }),
    execCall({ arguments: 'not json' }),
    execCall({
      arguments: JSON.stringify({ [CUSTOM_INPUT_KEY]: SOURCE, extra: 1 }),
    }),
    execCall({ arguments: JSON.stringify({ [CUSTOM_INPUT_KEY]: 7 }) }),
    { ...execCall(), type: 'message' },
  ]) {
    const untouched = rewriteResponsesEvent(
      { type: 'response.output_item.done', item },
      { toolNames: ['exec'] },
    );
    assert.equal(untouched.rewritten, 0);
    assert.deepEqual(untouched.event.item, item);
  }
});

test('response.completed output items are rewritten and other events are untouched', () => {
  const completed = {
    type: 'response.completed',
    response: { id: 'r', output: [execCall(), { type: 'message', id: 'm' }] },
  };
  const result = rewriteResponsesEvent(completed, { toolNames: ['exec'] });
  assert.equal(result.rewritten, 1);
  assert.equal(result.event.response.output[0].type, 'custom_tool_call');
  assert.equal(result.event.response.output[1].type, 'message');
  const created = { type: 'response.created', response: { id: 'r' } };
  assert.deepEqual(
    rewriteResponsesEvent(created, { toolNames: ['exec'] }).event,
    created,
  );
});

test('SSE rewriting is independent of chunk boundaries and keeps unmatched frames byte-identical', () => {
  const frames = [
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r' } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: execCall() })}\n\n`,
    ': keep-alive comment\n\n',
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', output: [execCall()] } })}\n\n`,
  ];
  const whole = frames.join('');
  const expected = (() => {
    const rewriter = createSseRewriter({ toolNames: ['exec'] });
    return rewriter.push(whole) + rewriter.end();
  })();
  for (const size of [1, 7, 64, whole.length]) {
    const rewriter = createSseRewriter({ toolNames: ['exec'] });
    let out = '';
    for (let index = 0; index < whole.length; index += size)
      out += rewriter.push(whole.slice(index, index + size));
    out += rewriter.end();
    assert.equal(out, expected, `chunk size ${size}`);
    assert.equal(rewriter.stats.rewrittenItems, 2);
  }
  assert.ok(
    expected.startsWith(frames[0]),
    'unmatched frame is byte-identical',
  );
  assert.ok(expected.includes(': keep-alive comment\n\n'));
  assert.ok(!expected.includes(CUSTOM_INPUT_KEY));
  assert.equal(
    JSON.parse(
      expected
        .split('\n')
        .find((l) => l.startsWith('data: ') && l.includes('custom_tool_call'))
        .slice(6),
    ).item.input,
    SOURCE,
  );
});

test('a malformed data frame passes through and is counted, never dropped', () => {
  const rewriter = createSseRewriter({ toolNames: ['exec'] });
  const out = rewriter.push('data: {not json\n\n') + rewriter.end();
  assert.equal(out, 'data: {not json\n\n');
  assert.equal(rewriter.stats.unparsedFrames, 1);
});

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('through the real capture listener: request bytes are recorded verbatim and the scripted exec step arrives as a custom tool call that advances the cursor', async () => {
  const cap = await startCapture();
  const rewriter = createCustomCallRewriter({
    upstreamPort: cap.port,
    toolNames: ['exec'],
  });
  await new Promise((resolve) =>
    rewriter.server.listen(0, '127.0.0.1', resolve),
  );
  const proxyPort = rewriter.server.address().port;
  const marker = 'Canopy-Cbap0-rw-0001';
  registerScenario(marker, {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [{ name: 'exec', input: { [CUSTOM_INPUT_KEY]: SOURCE } }],
          stopReason: 'tool_use',
        },
        { text: 'done', stopReason: 'end_turn' },
      ],
    },
  });
  try {
    const firstBody = JSON.stringify({
      model: 'gpt-6-sol',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[${marker}] go` }],
        },
      ],
    });
    const first = await post(proxyPort, '/v1/responses', firstBody);
    assert.equal(first.status, 200);
    assert.match(first.headers['content-type'], /text\/event-stream/);
    const dataLines = first.body
      .split('\n')
      .filter((line) => line.startsWith('data: '));
    const items = dataLines.map((line) => JSON.parse(line.slice(6)));
    const custom = items.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        e.item?.type === 'custom_tool_call',
    );
    assert.ok(custom, 'custom_tool_call emitted');
    assert.equal(custom.item.input, SOURCE);
    assert.equal(custom.item.name, 'exec');
    assert.ok(!first.body.includes(CUSTOM_INPUT_KEY));
    const completed = items.find((e) => e.type === 'response.completed');
    assert.equal(completed.response.output[0].type, 'custom_tool_call');

    const secondBody = JSON.stringify({
      model: 'gpt-6-sol',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[${marker}] go` }],
        },
        {
          type: 'custom_tool_call',
          call_id: custom.item.call_id,
          name: 'exec',
          input: SOURCE,
        },
        {
          type: 'custom_tool_call_output',
          call_id: custom.item.call_id,
          output: 'BAP0_PROBE_JSON:{}',
        },
      ],
    });
    const second = await post(proxyPort, '/v1/responses', secondBody);
    assert.match(
      second.body,
      /"text":"done"/,
      'cursor advanced past the exec step',
    );

    const snapshot = cap.capture.snapshot();
    const recorded = snapshot.records.filter(
      (record) => record.surface === 'openai-responses',
    );
    assert.equal(recorded.length, 2);
    assert.equal(
      Buffer.from(recorded[0].rawBase64, 'base64').toString('utf8'),
      firstBody,
    );
    assert.equal(
      Buffer.from(recorded[1].rawBase64, 'base64').toString('utf8'),
      secondBody,
    );
    assert.equal(rewriter.stats.requests, 2);
    assert.equal(
      rewriter.stats.requestBodyBytes,
      recorded[0].byteLength + recorded[1].byteLength,
      'every request byte forwarded equals the bytes the recorder retained',
    );
    assert.equal(rewriter.stats.rewrittenItems, 2);
    assert.equal(rewriter.stats.upgrades, 0);
    const exchanges = findToolExchanges(recorded[1].json);
    assert.equal(exchanges[0].callType, 'custom_tool_call');
    assert.equal(exchanges[0].answered, true);
  } finally {
    await rewriter.close();
    await cap.close();
  }
});

test('a non-streaming JSON reply is rewritten with a recomputed length and non-stream paths pass through', async () => {
  const cap = await startCapture();
  const rewriter = createCustomCallRewriter({
    upstreamPort: cap.port,
    toolNames: ['exec'],
  });
  await new Promise((resolve) =>
    rewriter.server.listen(0, '127.0.0.1', resolve),
  );
  const port = rewriter.server.address().port;
  const marker = 'Canopy-Cbap0-rw-0002';
  registerScenario(marker, {
    llm: {
      steps: [
        {
          toolCalls: [{ name: 'exec', input: { [CUSTOM_INPUT_KEY]: SOURCE } }],
        },
      ],
    },
  });
  try {
    const body = JSON.stringify({
      model: 'gpt-6-sol',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[${marker}] go` }],
        },
      ],
    });
    const reply = await post(port, '/v1/responses', body);
    const parsed = JSON.parse(reply.body);
    assert.equal(parsed.output[0].type, 'custom_tool_call');
    assert.equal(
      Number(reply.headers['content-length']),
      Buffer.byteLength(reply.body),
    );
    const missing = await post(port, '/__mock/state', '{}');
    assert.equal(missing.status, 404);
  } finally {
    await rewriter.close();
    await cap.close();
  }
});
