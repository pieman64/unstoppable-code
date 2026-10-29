// Unit tests for the bounded outbound-request recorder (./outbound-capture.mjs).
// They feed the recorder directly through its sink; ./capture-server.test.mjs
// covers the real HTTP and WebSocket listener.
//
// Run:  node --test apps/desktop-app/tests/electron/mock-server/outbound-capture.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  CAPTURE_SNAPSHOT_VERSION,
  CAPTURE_SURFACES,
  DEFAULT_CAPTURE_LIMITS,
  EVIDENCE_GAP_REASONS,
  PARTIAL_PROMPT_REASONS,
  assertSnapshotCanaryAbsent,
  assertSnapshotCanaryPresent,
  assertSnapshotComplete,
  createOutboundCapture,
  findSnapshotCanary,
} from './outbound-capture.mjs';

const HISTORY_CANARY = 'HISTORY_CANARY_5b71c2';
const TOOL_CANARY = 'TOOL_RESULT_CANARY_9d04e8';
const ABSENT_CANARY = 'NEVER_SENT_CANARY_31aa07';

// `body` is a string, a Buffer, an array of body chunks, or a value to send as
// JSON.
function toChunks(body) {
  if (Array.isArray(body)) {
    return body.map((chunk) =>
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    );
  }
  if (Buffer.isBuffer(body)) return [body];
  if (typeof body === 'string') return [Buffer.from(body)];
  return [Buffer.from(JSON.stringify(body))];
}

function recordHttp(sink, body, fields = {}) {
  const item = sink.beginHttp({
    method: 'POST',
    path: '/v1/messages',
    queryKeys: [],
    contentEncoding: null,
    surface: CAPTURE_SURFACES.anthropicMessages,
    ...fields,
  });
  for (const chunk of toChunks(body)) item.push(chunk);
  item.end();
  return item;
}

function openSocket(sink) {
  return sink.recordUpgrade({
    method: 'GET',
    path: '/v1/responses',
    queryKeys: [],
    surface: CAPTURE_SURFACES.openAiResponses,
  });
}

function recordFrame(sink, upgrade, frame, value, { binary = false } = {}) {
  return sink.recordMessage({
    connection: upgrade.connection,
    frame,
    binary,
    data: Buffer.from(
      typeof value === 'string' ? value : JSON.stringify(value),
    ),
    surface: CAPTURE_SURFACES.openAiResponses,
  });
}

function recordBySeq(snapshot, seq) {
  const record = snapshot.records.find((entry) => entry.seq === seq);
  assert.ok(record, `record #${seq} exists`);
  return record;
}

function raw(record) {
  return Buffer.from(record.rawBase64, 'base64');
}

// Invariants every snapshot must satisfy, including "never a silent {}".
function assertAccounting(snapshot) {
  const { counts, bytes, kinds, records } = snapshot;
  assert.equal(snapshot.version, CAPTURE_SNAPSHOT_VERSION);
  assert.equal(counts.received, counts.recorded + counts.dropped);
  assert.equal(counts.recorded, records.length);
  assert.equal(counts.complete + counts.incomplete, counts.recorded);
  assert.equal(kinds.http + kinds.wsUpgrade + kinds.wsMessage, counts.received);
  assert.equal(bytes.received, bytes.retained + bytes.omitted);
  assert.equal(
    records.reduce((sum, record) => sum + record.retainedBytes, 0),
    bytes.retained,
  );
  assert.equal(
    records.filter((record) => record.state === 'pending').length,
    counts.pending,
  );
  assert.ok(snapshot.diagnostics.length <= snapshot.limits.maxDiagnostics);
  for (const record of records) {
    assert.equal(record.complete, record.incomplete.length === 0);
    assert.deepEqual(record.incomplete, [...record.incomplete].sort());
    for (const reason of record.incomplete) {
      assert.ok(
        [...EVIDENCE_GAP_REASONS, ...PARTIAL_PROMPT_REASONS].includes(reason),
        `known reason ${reason}`,
      );
    }
    assert.ok(record.retainedBytes <= record.byteLength);
    assert.equal(raw(record).length, record.retainedBytes);
    if (record.parse === 'ok') {
      assert.deepEqual(record.json, JSON.parse(raw(record).toString('utf8')));
    } else {
      assert.equal(Object.hasOwn(record, 'json'), false);
    }
    if (record.prompt === 'full') assert.equal(record.complete, true);
  }
}

test('limits: defaults, overrides, and rejection of unknown or invalid values', () => {
  assert.deepEqual(createOutboundCapture().capture.snapshot().limits, {
    ...DEFAULT_CAPTURE_LIMITS,
  });
  const { capture } = createOutboundCapture({ maxRecords: 7 });
  assert.deepEqual(capture.snapshot().limits, {
    ...DEFAULT_CAPTURE_LIMITS,
    maxRecords: 7,
  });
  assert.throws(
    () => createOutboundCapture({ maxBodyByte: 10 }),
    /Unknown capture option "maxBodyByte"/,
  );
  for (const value of [0, -1, 1.5, '10', Number.MAX_VALUE, null]) {
    assert.throws(
      () => createOutboundCapture({ maxTotalBytes: value }),
      RangeError,
    );
  }
  assert.throws(() => createOutboundCapture(null), TypeError);
  assert.throws(() => createOutboundCapture([]), TypeError);
});

test('HTTP bodies keep exact bytes with explicit parse status, never a silent {}', () => {
  const { capture, sink } = createOutboundCapture();
  const body = {
    model: 'claude-mock',
    messages: [{ role: 'user', content: `café ${HISTORY_CANARY}` }],
  };
  const text = JSON.stringify(body);
  const utf8Bytes = Buffer.from(text);
  // Split inside the two-byte "é" to prove chunks are reassembled as bytes.
  const split = utf8Bytes.indexOf(0xc3) + 1;
  const ok = recordHttp(sink, [
    utf8Bytes.subarray(0, split),
    utf8Bytes.subarray(split),
  ]);
  const empty = recordHttp(sink, '');
  const blank = recordHttp(sink, ' \n\t ');
  const invalid = recordHttp(sink, '{"messages": [');
  const badUtf8 = recordHttp(sink, Buffer.from([0x7b, 0xff, 0x7d]));
  const bom = recordHttp(
    sink,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8Bytes]),
  );
  const gzip = gzipSync(utf8Bytes);
  const encoded = recordHttp(sink, gzip, { contentEncoding: 'gzip' });
  const identity = recordHttp(sink, text, { contentEncoding: 'identity' });
  const scalar = recordHttp(sink, '42');

  const snapshot = capture.snapshot();
  assertAccounting(snapshot);
  const okRecord = recordBySeq(snapshot, ok.seq);
  assert.equal(okRecord.parse, 'ok');
  assert.deepEqual(okRecord.json, body);
  assert.deepEqual(raw(okRecord), utf8Bytes);
  assert.equal(okRecord.byteLength, utf8Bytes.length);
  assert.equal(okRecord.prompt, 'full');
  assert.equal(okRecord.complete, true);

  for (const item of [empty, blank]) {
    const record = recordBySeq(snapshot, item.seq);
    assert.equal(record.parse, 'empty');
    assert.equal(record.complete, true);
    assert.equal(record.prompt, 'none');
  }
  assert.equal(recordBySeq(snapshot, empty.seq).rawBase64, '');
  assert.deepEqual(
    raw(recordBySeq(snapshot, blank.seq)),
    Buffer.from(' \n\t '),
  );

  for (const item of [invalid, badUtf8, bom]) {
    const record = recordBySeq(snapshot, item.seq);
    assert.equal(record.parse, 'invalid');
    assert.equal(record.prompt, 'none');
    assert.equal(
      record.complete,
      true,
      'invalid bytes are still exact evidence',
    );
  }
  assert.deepEqual(
    raw(recordBySeq(snapshot, badUtf8.seq)),
    Buffer.from([0x7b, 0xff, 0x7d]),
  );

  const encodedRecord = recordBySeq(snapshot, encoded.seq);
  assert.equal(encodedRecord.parse, 'encoded');
  assert.equal(encodedRecord.contentEncoding, 'gzip');
  assert.deepEqual(encodedRecord.incomplete, ['encoded']);
  assert.deepEqual(raw(encodedRecord), gzip);
  assert.equal(encodedRecord.marker, null);

  const identityRecord = recordBySeq(snapshot, identity.seq);
  assert.equal(identityRecord.parse, 'ok');
  assert.equal(identityRecord.contentEncoding, 'identity');
  assert.equal(identityRecord.complete, true);

  const scalarRecord = recordBySeq(snapshot, scalar.seq);
  assert.equal(scalarRecord.parse, 'ok');
  assert.equal(scalarRecord.json, 42);
  assert.equal(scalarRecord.prompt, 'none');
});

test('prompt classification marks Responses deltas and prewarms as partial prompts', () => {
  const { capture, sink } = createOutboundCapture();
  const responses = {
    surface: CAPTURE_SURFACES.openAiResponses,
    path: '/v1/responses',
  };
  const seqs = {
    anthropic: recordHttp(sink, { messages: [] }).seq,
    anthropicNoMessages: recordHttp(sink, { model: 'x' }).seq,
    countTokens: recordHttp(
      sink,
      { messages: [] },
      {
        surface: CAPTURE_SURFACES.anthropicCountTokens,
        path: '/v1/messages/count_tokens',
      },
    ).seq,
    chat: recordHttp(
      sink,
      { messages: [] },
      {
        surface: CAPTURE_SURFACES.openAiChatCompletions,
        path: '/v1/chat/completions',
      },
    ).seq,
    responsesFull: recordHttp(sink, { input: 'hello' }, responses).seq,
    responsesArray: recordHttp(sink, { input: [] }, responses).seq,
    responsesNoInput: recordHttp(sink, { model: 'x' }, responses).seq,
    responsesDelta: recordHttp(
      sink,
      { previous_response_id: 'resp_http_1', input: [] },
      responses,
    ).seq,
    responsesPrewarm: recordHttp(
      sink,
      { generate: false, input: [] },
      responses,
    ).seq,
    unrouted: recordHttp(
      sink,
      { messages: [] },
      { surface: null, path: '/v2/other' },
    ).seq,
    models: recordHttp(sink, '', {
      method: 'GET',
      surface: CAPTURE_SURFACES.models,
      path: '/v1/models',
    }).seq,
  };
  const socket = openSocket(sink);
  seqs.upgrade = socket.seq;
  seqs.wsFull = recordFrame(sink, socket, 1, {
    type: 'response.create',
    input: [],
  }).seq;
  seqs.wsOther = recordFrame(sink, socket, 2, {
    type: 'response.cancel',
    input: [],
  }).seq;
  seqs.wsPrewarmDelta = recordFrame(sink, socket, 3, {
    type: 'response.create',
    generate: false,
    previous_response_id: 'resp_unknown',
    input: [],
  }).seq;

  const snapshot = capture.snapshot();
  assertAccounting(snapshot);
  const prompt = (key) => recordBySeq(snapshot, seqs[key]).prompt;
  const incomplete = (key) => recordBySeq(snapshot, seqs[key]).incomplete;
  assert.equal(prompt('anthropic'), 'full');
  assert.equal(prompt('anthropicNoMessages'), 'none');
  assert.equal(prompt('countTokens'), 'none');
  assert.equal(prompt('chat'), 'full');
  assert.equal(prompt('responsesFull'), 'full');
  assert.equal(prompt('responsesArray'), 'full');
  assert.equal(prompt('responsesNoInput'), 'none');
  assert.equal(prompt('responsesDelta'), 'delta');
  assert.deepEqual(incomplete('responsesDelta'), ['delta', 'unresolved-delta']);
  assert.equal(prompt('responsesPrewarm'), 'prewarm');
  assert.deepEqual(incomplete('responsesPrewarm'), ['prewarm']);
  assert.equal(prompt('unrouted'), 'none');
  assert.equal(prompt('models'), 'none');
  assert.equal(prompt('upgrade'), 'none');
  assert.equal(prompt('wsFull'), 'full');
  assert.equal(prompt('wsOther'), 'none');
  assert.equal(prompt('wsPrewarmDelta'), 'prewarm');
  assert.deepEqual(incomplete('wsPrewarmDelta'), [
    'delta',
    'prewarm',
    'unresolved-delta',
  ]);
  const upgrade = recordBySeq(snapshot, seqs.upgrade);
  assert.equal(upgrade.kind, 'ws-upgrade');
  assert.equal(upgrade.parse, 'empty');
  assert.equal(upgrade.upgrade, 'pending');
  const frame = recordBySeq(snapshot, seqs.wsFull);
  assert.equal(frame.connection, upgrade.connection);
  assert.equal(frame.frame, 1);
  assert.equal(frame.binary, false);
});

test('deltas resolve only against responses answered in the current window', () => {
  const { capture, sink } = createOutboundCapture();
  const socket = openSocket(sink);
  const first = recordFrame(sink, socket, 1, {
    type: 'response.create',
    input: [{ role: 'user', content: HISTORY_CANARY }],
  });
  first.setReply('response', 'resp_mock_first');
  const delta = recordFrame(sink, socket, 2, {
    type: 'response.create',
    previous_response_id: 'resp_mock_first',
    input: [
      { type: 'function_call_output', call_id: 'c1', output: TOOL_CANARY },
    ],
  });
  const unknown = recordFrame(sink, socket, 3, {
    type: 'response.create',
    previous_response_id: 'resp_mock_elsewhere',
    input: [],
  });

  let snapshot = capture.snapshot();
  assertAccounting(snapshot);
  const firstRecord = recordBySeq(snapshot, first.seq);
  assert.equal(firstRecord.responseId, 'resp_mock_first');
  assert.equal(firstRecord.reply, 'response');
  const deltaRecord = recordBySeq(snapshot, delta.seq);
  assert.equal(deltaRecord.prompt, 'delta');
  assert.equal(deltaRecord.previousResponseId, 'resp_mock_first');
  assert.equal(deltaRecord.previousSeq, first.seq);
  assert.deepEqual(deltaRecord.incomplete, ['delta']);
  const unknownRecord = recordBySeq(snapshot, unknown.seq);
  assert.equal(unknownRecord.previousSeq, null);
  assert.deepEqual(unknownRecord.incomplete, ['delta', 'unresolved-delta']);
  assert.ok(
    snapshot.diagnostics.some(
      (entry) => entry.seq === unknown.seq && entry.code === 'unresolved-delta',
    ),
  );

  // After a reset the earlier response is outside the window.
  capture.reset();
  const afterReset = recordFrame(sink, socket, 4, {
    type: 'response.create',
    previous_response_id: 'resp_mock_first',
    input: [],
  });
  snapshot = capture.snapshot();
  assertAccounting(snapshot);
  assert.deepEqual(recordBySeq(snapshot, afterReset.seq).incomplete, [
    'delta',
    'unresolved-delta',
  ]);
  assert.ok(afterReset.seq > unknown.seq, 'seq keeps increasing across reset');
});

test('body, total, record and diagnostic caps are hard and explicitly counted', () => {
  const { capture, sink } = createOutboundCapture({
    maxBodyBytes: 10,
    maxTotalBytes: 16,
    maxRecords: 4,
    maxDiagnostics: 3,
  });
  const first = recordHttp(sink, ['0123456', '789abcdef']); // 16 bytes, keeps 10
  const second = recordHttp(sink, 'ABCDEFGHIJ'); // total room 6
  const third = recordHttp(sink, 'xyz'); // total room 0
  const socket = openSocket(sink); // fourth record, no bytes
  const frameBody = { type: 'response.create', input: [] };
  const frameBytes = Buffer.byteLength(JSON.stringify(frameBody));
  const droppedFrame = recordFrame(sink, socket, 1, frameBody);
  const droppedRequest = recordHttp(sink, '{"messages":[]}'); // 15 bytes

  const snapshot = capture.snapshot();
  assertAccounting(snapshot);
  assert.deepEqual(snapshot.counts, {
    received: 6,
    recorded: 4,
    dropped: 2,
    pending: 0,
    complete: 1,
    incomplete: 3,
  });
  assert.deepEqual(snapshot.kinds, { http: 4, wsUpgrade: 1, wsMessage: 1 });
  assert.equal(droppedFrame.recorded, false);
  assert.equal(droppedRequest.recorded, false);
  assert.ok(droppedRequest.seq > droppedFrame.seq);

  const firstRecord = recordBySeq(snapshot, first.seq);
  assert.equal(firstRecord.byteLength, 16);
  assert.equal(firstRecord.retainedBytes, 10);
  assert.deepEqual(raw(firstRecord), Buffer.from('0123456789'));
  assert.deepEqual(firstRecord.incomplete, ['body-cap']);
  assert.equal(firstRecord.parse, 'truncated');
  assert.equal(firstRecord.prompt, 'none');

  const secondRecord = recordBySeq(snapshot, second.seq);
  assert.deepEqual(raw(secondRecord), Buffer.from('ABCDEF'));
  assert.deepEqual(secondRecord.incomplete, ['total-cap']);

  const thirdRecord = recordBySeq(snapshot, third.seq);
  assert.equal(thirdRecord.retainedBytes, 0);
  assert.equal(thirdRecord.byteLength, 3);
  assert.deepEqual(thirdRecord.incomplete, ['total-cap']);

  assert.deepEqual(snapshot.bytes, {
    received: 16 + 10 + 3 + frameBytes + 15,
    retained: 16,
    omitted: 6 + 4 + 3 + frameBytes + 15,
  });
  assert.deepEqual(snapshot.overflow, {
    bodyCapRecords: 1,
    totalCapRecords: 2,
    droppedDiagnostics: 2,
  });
  assert.deepEqual(
    snapshot.diagnostics.map((entry) => [entry.seq, entry.code]),
    [
      [first.seq, 'body-cap'],
      [second.seq, 'total-cap'],
      [third.seq, 'total-cap'],
    ],
  );
  assert.throws(
    () => capture.assertComplete(),
    (error) =>
      error instanceof assert.AssertionError &&
      /2 of 6 received items were not recorded \(maxRecords 4\)/.test(
        error.message,
      ) &&
      error.message.includes(
        `#${first.seq} http POST /v1/messages [body-cap]`,
      ) &&
      error.message.includes(
        `#${third.seq} http POST /v1/messages [total-cap]`,
      ),
  );
});

test('pending and aborted bodies, and reset isolation of in-flight requests', async () => {
  const { capture, sink } = createOutboundCapture();
  const pending = sink.beginHttp({
    method: 'POST',
    path: '/v1/messages',
    surface: CAPTURE_SURFACES.anthropicMessages,
  });
  pending.push(Buffer.from('{"messages":'));
  let snapshot = capture.snapshot();
  assertAccounting(snapshot);
  assert.equal(snapshot.counts.pending, 1);
  const pendingRecord = recordBySeq(snapshot, pending.seq);
  assert.equal(pendingRecord.state, 'pending');
  assert.equal(pendingRecord.parse, 'pending');
  assert.deepEqual(pendingRecord.incomplete, ['pending']);
  assert.throws(() => capture.assertCanaryAbsent(ABSENT_CANARY), /pending/);

  pending.abort('ECONNRESET');
  assert.equal(await pending.settled, 'aborted');
  pending.push(Buffer.from('ignored after settle'));
  pending.end();
  snapshot = capture.snapshot();
  assertAccounting(snapshot);
  const aborted = recordBySeq(snapshot, pending.seq);
  assert.equal(aborted.state, 'aborted');
  assert.equal(aborted.error, 'ECONNRESET');
  assert.equal(aborted.parse, 'truncated');
  assert.deepEqual(aborted.incomplete, ['aborted']);
  assert.deepEqual(raw(aborted), Buffer.from('{"messages":'));

  // A request still in flight during reset stays in the discarded window.
  const straddling = sink.beginHttp({ method: 'POST', path: '/v1/messages' });
  straddling.push(Buffer.from('{"messages"'));
  capture.reset();
  straddling.push(Buffer.from(':[]}'));
  straddling.end();
  assert.equal(await straddling.settled, 'done');
  snapshot = capture.snapshot();
  assertAccounting(snapshot);
  assert.equal(snapshot.counts.received, 0);
  assert.deepEqual(snapshot.bytes, { received: 0, retained: 0, omitted: 0 });
  assert.deepEqual(snapshot.records, []);
  assert.deepEqual(snapshot.diagnostics, []);
  const next = recordHttp(sink, '{"messages":[]}');
  assert.ok(next.seq > straddling.seq);
  assert.deepEqual(
    capture.snapshot().records.map((record) => record.seq),
    [next.seq],
  );
});

test('malformed requests, rejected frames and refused upgrades are explicit items', () => {
  const { capture, sink } = createOutboundCapture();
  sink.recordMalformedRequest({ code: 'HPE_INVALID_METHOD' });
  const socket = openSocket(sink);
  socket.accept();
  sink.recordMessageError({
    connection: socket.connection,
    frame: 1,
    code: 'WS_ERR_INVALID_UTF8',
    surface: CAPTURE_SURFACES.openAiResponses,
  });
  const refused = sink.recordUpgrade({
    method: 'GET',
    path: '/elsewhere',
    queryKeys: [],
  });
  refused.reject(5);
  const refusedEmpty = sink.recordUpgrade({
    method: 'GET',
    path: '/other',
    queryKeys: [],
  });
  refusedEmpty.reject(0);

  const snapshot = capture.snapshot();
  assertAccounting(snapshot);
  const [
    malformedRequest,
    accepted,
    malformedFrame,
    refusedRecord,
    refusedEmptyRecord,
  ] = snapshot.records;
  assert.equal(malformedRequest.kind, 'http');
  assert.equal(malformedRequest.method, null);
  assert.equal(malformedRequest.error, 'HPE_INVALID_METHOD');
  assert.equal(malformedRequest.parse, 'unavailable');
  assert.deepEqual(malformedRequest.incomplete, ['malformed']);
  assert.equal(accepted.upgrade, 'accepted');
  assert.equal(accepted.complete, true);
  assert.equal(malformedFrame.kind, 'ws-message');
  assert.equal(malformedFrame.connection, socket.connection);
  assert.equal(malformedFrame.error, 'WS_ERR_INVALID_UTF8');
  assert.deepEqual(malformedFrame.incomplete, ['malformed']);
  assert.equal(refusedRecord.upgrade, 'rejected');
  assert.equal(refusedRecord.byteLength, 5);
  assert.equal(refusedRecord.parse, 'unavailable');
  assert.deepEqual(refusedRecord.incomplete, ['discarded-data']);
  assert.notEqual(refusedRecord.connection, accepted.connection);
  assert.equal(refusedEmptyRecord.upgrade, 'rejected');
  assert.equal(refusedEmptyRecord.complete, true);
  assert.deepEqual(snapshot.bytes, { received: 5, retained: 0, omitted: 5 });
  assert.deepEqual(
    snapshot.diagnostics.map((entry) => entry.code),
    ['malformed', 'malformed', 'discarded-data'],
  );
});

test('snapshots are detached from the recorder, each other, and input buffers', () => {
  const { capture, sink } = createOutboundCapture();
  const input = Buffer.from(
    JSON.stringify({ messages: [{ role: 'user', content: 'abc' }] }),
  );
  const item = sink.beginHttp({
    method: 'POST',
    path: '/v1/messages',
    queryKeys: ['beta'],
    surface: CAPTURE_SURFACES.anthropicMessages,
  });
  item.push(input);
  item.end();
  const before = JSON.stringify(capture.snapshot());
  input.fill(0x20); // the transport may reuse its buffer

  const first = capture.snapshot();
  first.records[0].json.messages[0].content = 'mutated';
  first.records[0].queryKeys.push('mutated');
  first.records[0].incomplete.push('mutated');
  first.records.push({ seq: 999 });
  first.counts.received = 999;
  first.limits.maxRecords = 1;
  first.diagnostics.push({ seq: 1, code: 'mutated', detail: '' });

  const second = capture.snapshot();
  assert.equal(JSON.stringify(second), before);
  assert.notEqual(second.records[0].json, first.records[0].json);
  assert.equal(second.records[0].json.messages[0].content, 'abc');
  assert.throws(() => {
    capture.snapshot = () => second;
  }, TypeError);
});

test('canary validation and snapshot shape checks fail loudly', () => {
  const { capture } = createOutboundCapture();
  for (const bad of [
    'short',
    ' LEADING_SPACE_CANARY',
    'QUOTE"CANARY_1234',
    'x'.repeat(257),
    42,
  ]) {
    assert.throws(() => capture.findCanary(bad), TypeError);
  }
  assert.throws(() => capture.assertCanaryAbsent([]), TypeError);
  assert.throws(
    () => capture.assertCanaryPresent(HISTORY_CANARY, { fullprompt: false }),
    /Unknown canary option "fullprompt"/,
  );
  assert.throws(
    () => capture.assertCanaryPresent(HISTORY_CANARY, { toolResult: 'yes' }),
    TypeError,
  );
  assert.throws(
    () => capture.assertCanaryAbsent(HISTORY_CANARY, { filter: true }),
    TypeError,
  );
  assert.throws(
    () => assertSnapshotComplete({ version: 2, records: [] }),
    TypeError,
  );
  assert.throws(() => findSnapshotCanary(null, HISTORY_CANARY), TypeError);
});

test('canary absence is proven only over complete evidence', () => {
  const { capture, sink } = createOutboundCapture({ maxRecords: 6 });
  const clean = recordHttp(sink, {
    messages: [{ role: 'user', content: `hello ${HISTORY_CANARY}` }],
  });
  const socket = openSocket(sink);
  const prewarm = recordFrame(sink, socket, 1, {
    type: 'response.create',
    generate: false,
    input: [],
  });
  prewarm.setReply('response', 'resp_mock_prewarm');
  recordFrame(sink, socket, 2, {
    type: 'response.create',
    previous_response_id: 'resp_mock_prewarm',
    input: [{ role: 'user', content: 'go' }],
  });

  // Resolved deltas and prewarms carry exact bytes, so absence is provable.
  assert.deepEqual(
    capture.assertCanaryAbsent([ABSENT_CANARY, 'SECOND_ABSENT_CANARY']),
    {
      canaries: [ABSENT_CANARY, 'SECOND_ABSENT_CANARY'],
      searched: 4,
    },
  );
  assert.throws(
    () => capture.assertCanaryAbsent([ABSENT_CANARY, HISTORY_CANARY]),
    (error) =>
      error instanceof assert.AssertionError &&
      error.message.startsWith('Canary reached outbound traffic') &&
      error.message.includes(
        `${HISTORY_CANARY} in #${clean.seq} http POST /v1/messages (raw, json)`,
      ),
  );

  const encoded = recordHttp(sink, gzipSync(Buffer.from('{}')), {
    contentEncoding: 'br',
  });
  assert.throws(
    () => capture.assertCanaryAbsent(ABSENT_CANARY),
    (error) =>
      error.message.startsWith('Cannot prove canary absence') &&
      error.message.includes(
        `#${encoded.seq} http POST /v1/messages [encoded]`,
      ),
  );
  // A filter scopes the proof to the records it names.
  assert.equal(
    capture.assertCanaryAbsent(ABSENT_CANARY, {
      filter: (record) => record.seq !== encoded.seq,
    }).searched,
    4,
  );
  recordFrame(sink, socket, 3, {
    type: 'response.create',
    previous_response_id: 'resp_mock_unknown',
    input: [],
  });
  assert.throws(
    () =>
      capture.assertCanaryAbsent(ABSENT_CANARY, {
        filter: (record) => record.seq !== encoded.seq,
      }),
    /unresolved-delta/,
  );

  // Dropped items cannot be filtered out of the proof.
  recordHttp(sink, '{}');
  assert.equal(capture.snapshot().counts.dropped, 1);
  assert.throws(
    () => capture.assertCanaryAbsent(ABSENT_CANARY, { filter: () => false }),
    /1 of 7 received items were not recorded \(maxRecords 6\)/,
  );
});

test('canary presence requires a complete full prompt unless relaxed, and can require a tool result', () => {
  const { capture, sink } = createOutboundCapture();
  const anthropic = recordHttp(sink, {
    messages: [
      { role: 'user', content: `[Canopy-CUNIT] read ${HISTORY_CANARY}` },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: `file says ${TOOL_CANARY}` }],
          },
        ],
      },
    ],
  });
  const responses = recordHttp(
    sink,
    {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'RESPONSES_TOOL_CANARY_1',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'c2',
          output: 'CUSTOM_TOOL_CANARY_2',
        },
      ],
    },
    { surface: CAPTURE_SURFACES.openAiResponses, path: '/v1/responses' },
  );
  const chat = recordHttp(
    sink,
    {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'c1', content: 'CHAT_TOOL_CANARY_3' },
      ],
    },
    {
      surface: CAPTURE_SURFACES.openAiChatCompletions,
      path: '/v1/chat/completions',
    },
  );
  const escaped = recordHttp(
    sink,
    '{"messages":[{"role":"user","content":"\\u0045SCAPED_CANARY_4"}],"metadata":{"KEY_CANARY_5":1}}',
  );
  const socket = openSocket(sink);
  const full = recordFrame(sink, socket, 1, {
    type: 'response.create',
    input: [{ role: 'user', content: `[Canopy-CUNIT] ${HISTORY_CANARY}` }],
  });
  full.setReply('response', 'resp_mock_full');
  const delta = recordFrame(sink, socket, 2, {
    type: 'response.create',
    previous_response_id: 'resp_mock_full',
    input: [
      {
        type: 'function_call_output',
        call_id: 'c9',
        output: 'DELTA_TOOL_CANARY_6',
      },
    ],
  });

  const snapshot = capture.snapshot();
  assertAccounting(snapshot);
  assert.deepEqual(capture.assertCanaryPresent(HISTORY_CANARY), {
    canary: HISTORY_CANARY,
    matches: [anthropic.seq, full.seq],
  });
  assert.deepEqual(
    capture.assertCanaryPresent(TOOL_CANARY, { toolResult: true }).matches,
    [anthropic.seq],
  );
  for (const [canary, seq] of [
    ['RESPONSES_TOOL_CANARY_1', responses.seq],
    ['CUSTOM_TOOL_CANARY_2', responses.seq],
    ['CHAT_TOOL_CANARY_3', chat.seq],
  ]) {
    assert.deepEqual(
      capture.assertCanaryPresent(canary, { toolResult: true }).matches,
      [seq],
    );
  }
  assert.throws(
    () => capture.assertCanaryPresent(HISTORY_CANARY, { toolResult: true }),
    (error) =>
      error.message.startsWith(
        `Canary ${HISTORY_CANARY} was not found in a tool result in a complete full prompt`,
      ) &&
      error.message.includes(
        `#${anthropic.seq} http POST /v1/messages [prompt full; at raw, json]`,
      ),
  );
  // A delta is never treated as the full prompt.
  assert.throws(
    () => capture.assertCanaryPresent('DELTA_TOOL_CANARY_6'),
    (error) =>
      error.message.includes(
        `#${delta.seq} ws-message connection ${socket.connection} frame 2 [prompt delta: not a full prompt; incomplete delta; at raw, json, tool-result]`,
      ),
  );
  assert.deepEqual(
    capture.assertCanaryPresent('DELTA_TOOL_CANARY_6', {
      fullPrompt: false,
      toolResult: true,
    }).matches,
    [delta.seq],
  );
  assert.throws(
    () =>
      capture.assertCanaryPresent(HISTORY_CANARY, {
        fullPrompt: false,
        filter: (record) => record.seq === delta.seq,
      }),
    /was not found in any record \(1 records searched\); it does not occur in any searched record/,
  );
  assert.deepEqual(findSnapshotCanary(snapshot, 'ESCAPED_CANARY_4'), [
    {
      seq: escaped.seq,
      kind: 'http',
      surface: CAPTURE_SURFACES.anthropicMessages,
      prompt: 'full',
      complete: true,
      incomplete: [],
      locations: ['json'],
    },
  ]);
  assert.deepEqual(
    capture.findCanary('KEY_CANARY_5').map((hit) => hit.locations),
    [['raw', 'json']],
  );
  assert.deepEqual(capture.findCanary(ABSENT_CANARY), []);
});

test('helpers accept a JSON round-tripped snapshot, as written to an evidence file', () => {
  const { capture, sink } = createOutboundCapture();
  const item = recordHttp(sink, {
    messages: [{ role: 'user', content: `[Canopy-CUNIT] ${HISTORY_CANARY}` }],
  });
  const evidence = JSON.parse(JSON.stringify(capture.snapshot()));
  assert.equal(assertSnapshotComplete(evidence), evidence);
  assert.deepEqual(
    assertSnapshotCanaryPresent(evidence, HISTORY_CANARY).matches,
    [item.seq],
  );
  assert.equal(assertSnapshotCanaryAbsent(evidence, ABSENT_CANARY).searched, 1);
  assert.equal(evidence.records[0].marker, 'Canopy-CUNIT');
});
