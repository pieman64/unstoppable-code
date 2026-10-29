// Bounded outbound-request recorder for provider isolation probes.
//
// Managed browser delegation spike S0.1 (promoted as Phase A item 4, see
// docs/planning/2026-09-24-managed-browser-delegation/05-implementation-readiness.md)
// runs the real Claude and Codex binaries against scripted inference and must
// prove what they sent: complete prompts, tool results, and the absence of
// synthetic canaries. The shared mock cannot answer that. `routes/llm.mjs`
// keeps no request bodies and turns an empty or invalid body into `{}`, and the
// control plane records only counters. This module keeps exact, bounded
// evidence instead.
//
// It is transport-agnostic. The dedicated listener in ./capture-server.mjs
// feeds it through `sink`, and tests read evidence only in-process through
// `capture`. Recording is opt-in: ./start.mjs never imports this module, and
// there is no HTTP evidence or control endpoint.
//
// Evidence model
// - Every received item gets a `seq` and is counted in `counts.received`: each
//   HTTP request of any method or path (including `GET /v1/models`,
//   count_tokens, helper prompts, unmarked or invalid bodies and unrouted
//   paths), each WebSocket upgrade request, each WebSocket message, and each
//   request or frame the transport rejected as malformed. Recording never
//   depends on a `[Canopy-C…]` marker; `marker` is only a label.
// - Below `maxRecords`, an item becomes a record. Later items are counted in
//   `counts.dropped` with a diagnostic, so `counts.received` always equals
//   `counts.recorded + counts.dropped`.
// - A record keeps an exact prefix of its body or frame bytes (`rawBase64`),
//   bounded by `maxBodyBytes` per item and `maxTotalBytes` per window, so
//   `bytes.received` always equals `bytes.retained + bytes.omitted`.
// - `json` exists only when the complete, unencoded bytes are valid UTF-8 JSON
//   (`parse: 'ok'`). An empty or invalid body is reported as such, never as
//   `{}`. Each snapshot parses the retained bytes again, so snapshots share no
//   objects with each other or with the recorder.
// - A record is `complete` only when `incomplete` is empty. Evidence gaps
//   (EVIDENCE_GAP_REASONS) mean the retained bytes do not show everything that
//   was sent. Partial prompts (PARTIAL_PROMPT_REASONS) are exact bytes that are
//   not a full prompt: a Responses `previous_response_id` delta carries only
//   new input, and a `generate: false` prewarm is not a generation request.
// - Only the `content-encoding` request header is retained, and only query
//   parameter names. Authorization and every other header are never stored.
//   Canary helpers therefore cover paths, bodies and frames, not headers or
//   query values.
// - Node's HTTP parser bounds each request line and header block (16 KiB by
//   default), which bounds per-record metadata. Values copied from bodies
//   (`previousResponseId`, `marker`) and error codes are truncated to 256
//   characters.

import assert from 'node:assert/strict';
import { markerFromText } from './control-plane.mjs';

/** Version of the snapshot shape returned by `capture.snapshot()`. */
export const CAPTURE_SNAPSHOT_VERSION = 1;

/**
 * Default bounds. Each limit must be a positive safe integer. Pass any subset
 * to `createOutboundCapture()` or `createCaptureServer()`; unknown keys throw.
 */
export const DEFAULT_CAPTURE_LIMITS = Object.freeze({
  /** Bytes retained per HTTP body or WebSocket message, as a prefix. */
  maxBodyBytes: 4 * 1024 * 1024,
  /** Records per window. Later items only increment `counts.dropped`. */
  maxRecords: 1000,
  /** Bytes retained across all records of one window. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Diagnostics per window. Later ones only increment `overflow.droppedDiagnostics`. */
  maxDiagnostics: 100,
});

/**
 * `surface` labels. HTTP routes mirror `handleLlmRequest` in routes/llm.mjs,
 * after its AI Credits proxy-prefix normalization; a WebSocket upgrade or
 * message on the Responses socket is `openAiResponses`. Anything else is
 * `null`.
 */
export const CAPTURE_SURFACES = Object.freeze({
  anthropicMessages: 'anthropic-messages',
  anthropicCountTokens: 'anthropic-count-tokens',
  openAiResponses: 'openai-responses',
  openAiChatCompletions: 'openai-chat-completions',
  models: 'models',
});

/**
 * Reasons meaning the retained bytes do not show everything that was sent.
 * Canary absence cannot be proven while any of them applies.
 *
 * - `pending`: bytes are still arriving.
 * - `aborted`: the sender, transport or listener ended the item early.
 * - `body-cap`: `maxBodyBytes` was reached; only a prefix is retained.
 * - `total-cap`: `maxTotalBytes` was reached; only a prefix, possibly empty.
 * - `encoded`: `content-encoding` is set; bytes are retained but not decoded.
 * - `malformed`: the transport rejected the request or frame; no bytes exist.
 * - `discarded-data`: bytes sent with a rejected upgrade were discarded.
 * - `unresolved-delta`: the `previous_response_id` was not answered in this
 *   window, so the effective prompt depends on content outside the capture.
 */
export const EVIDENCE_GAP_REASONS = Object.freeze([
  'pending',
  'aborted',
  'body-cap',
  'total-cap',
  'encoded',
  'malformed',
  'discarded-data',
  'unresolved-delta',
]);

/**
 * Reasons meaning exact bytes are not a full prompt.
 *
 * - `delta`: a Responses body with `previous_response_id`; it carries only
 *   new input, and the earlier context lives in the referenced response.
 * - `prewarm`: a Responses body with `generate: false`; it warms a connection
 *   and asks for no generation.
 */
export const PARTIAL_PROMPT_REASONS = Object.freeze(['delta', 'prewarm']);

const LIMIT_KEYS = Object.keys(DEFAULT_CAPTURE_LIMITS);
const TRUNCATING_REASONS = ['aborted', 'body-cap', 'total-cap'];
const MAX_LABEL_CHARS = 256;
const MAX_REPORTED_RECORDS = 20;
// Canaries are plain tokens that JSON serializers never escape, so a byte
// search is exact. The minimum length keeps a presence check from passing on
// incidental text.
const CANARY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,255}$/;
// `ignoreBOM` keeps a byte-order mark in the decoded text, so a BOM-prefixed
// body is invalid JSON here exactly as it is for `JSON.parse` in the mock.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * @typedef {typeof DEFAULT_CAPTURE_LIMITS} CaptureLimits
 */

/**
 * One received item in a snapshot. Every field is always present except
 * `json`, which exists only when `parse === 'ok'`.
 *
 * @typedef {object} CaptureRecord
 * @property {number} seq Unique and increasing for the life of the capture,
 *   including across `reset()`. A gap is a dropped item.
 * @property {'http' | 'ws-upgrade' | 'ws-message'} kind
 * @property {string | null} surface One of `CAPTURE_SURFACES`, or `null`.
 * @property {string | null} method HTTP method (`http`, `ws-upgrade`).
 * @property {string | null} path URL pathname. Query values are never kept.
 * @property {string[]} queryKeys Distinct query parameter names, in order.
 * @property {string | null} contentEncoding The only retained header (`http`).
 * @property {number | null} connection WebSocket connection id, shared by an
 *   upgrade and its messages.
 * @property {number | null} frame 1-based message index on its connection.
 * @property {boolean | null} binary Whether the message was a binary frame.
 * @property {'pending' | 'done' | 'aborted'} state
 * @property {number} byteLength Body or frame bytes received for the item.
 * @property {number} retainedBytes Bytes kept in `rawBase64`, a prefix.
 * @property {string} rawBase64 The exact retained bytes, base64-encoded.
 * @property {'ok' | 'empty' | 'invalid' | 'encoded' | 'truncated' | 'pending' | 'unavailable'} parse
 *   `ok`: complete, unencoded, valid UTF-8 JSON. `empty`: no bytes, or only
 *   whitespace (the mock treats both as an empty body). `invalid`: not UTF-8
 *   JSON. `encoded`: `content-encoding` is set, so nothing was decoded.
 *   `truncated`: only a prefix exists. `pending`: still arriving.
 *   `unavailable`: no bytes exist (malformed or discarded input).
 * @property {unknown} [json] A fresh parse of the retained bytes.
 * @property {'full' | 'delta' | 'prewarm' | 'none'} prompt `full`: a generation
 *   request carrying its whole prompt (Anthropic `messages`, Chat Completions
 *   `messages`, or Responses `input` without `previous_response_id`). `delta`
 *   and `prewarm` are partial prompts. `none`: anything else, including any
 *   body that is not `parse: 'ok'`.
 * @property {string | null} previousResponseId The referenced response.
 * @property {number | null} previousSeq The record answered with that
 *   response in this window, or `null` (`unresolved-delta`).
 * @property {string | null} responseId The response id the capture listener
 *   answered a WebSocket message with. The HTTP route does not expose it.
 * @property {string | null} marker First `[Canopy-C…]` marker in the retained
 *   text, as a label only.
 * @property {boolean | null} handled Whether routes/llm.mjs handled a request.
 * @property {number | null} status HTTP response status the listener sent.
 * @property {'pending' | 'accepted' | 'rejected' | null} upgrade Upgrade outcome.
 * @property {'response' | 'failed' | 'ignored' | 'error' | null} reply What the
 *   listener did with a WebSocket message: streamed `response.*` events, sent
 *   `response.failed`, ignored a non-`response.create` frame (as the shared
 *   mock does), or failed in the scripted resolver.
 * @property {string | null} error Error code for an aborted or malformed item.
 * @property {boolean} complete `true` exactly when `incomplete` is empty.
 * @property {string[]} incomplete Sorted reasons from `EVIDENCE_GAP_REASONS`
 *   and `PARTIAL_PROMPT_REASONS`.
 */

/**
 * A detached, JSON-serializable view of the current window.
 *
 * Invariants: `counts.received === counts.recorded + counts.dropped`,
 * `counts.recorded === records.length === counts.complete + counts.incomplete`,
 * `bytes.received === bytes.retained + bytes.omitted`, and the `kinds` counts
 * sum to `counts.received`.
 *
 * @typedef {object} CaptureSnapshot
 * @property {1} version
 * @property {CaptureLimits} limits
 * @property {{ received: number, recorded: number, dropped: number, pending: number, complete: number, incomplete: number }} counts
 * @property {{ http: number, wsUpgrade: number, wsMessage: number }} kinds
 *   Received items by kind, including dropped ones.
 * @property {{ received: number, retained: number, omitted: number }} bytes
 * @property {{ bodyCapRecords: number, totalCapRecords: number, droppedDiagnostics: number }} overflow
 *   Records truncated by each byte cap, and diagnostics beyond `maxDiagnostics`.
 *   Items beyond `maxRecords` are `counts.dropped`.
 * @property {CaptureRecord[]} records In `seq` order.
 * @property {{ seq: number | null, code: string, detail: string }[]} diagnostics
 *   At most `maxDiagnostics`, never containing body content.
 */

/**
 * The read-only evidence API returned by `createCaptureServer()`.
 *
 * @typedef {object} OutboundCapture
 * @property {() => CaptureSnapshot} snapshot A detached copy of the window.
 * @property {() => void} reset Start a new, empty window. `seq` keeps
 *   increasing. Bytes of a request still in flight belong to the discarded
 *   window, and a later delta that continues a discarded response is
 *   `unresolved-delta`.
 * @property {() => CaptureSnapshot} assertComplete Throws an AssertionError
 *   unless nothing was dropped and every record is complete, including no
 *   delta or prewarm messages; returns the snapshot it checked.
 * @property {(canaries: string | string[], options?: CanaryAbsentOptions) => { canaries: string[], searched: number }} assertCanaryAbsent
 *   See `assertSnapshotCanaryAbsent`.
 * @property {(canary: string, options?: CanaryPresentOptions) => { canary: string, matches: number[] }} assertCanaryPresent
 *   See `assertSnapshotCanaryPresent`.
 * @property {(canary: string) => CanaryHit[]} findCanary
 *   See `findSnapshotCanary`.
 */

/**
 * @typedef {object} CanaryAbsentOptions
 * @property {(record: CaptureRecord) => boolean} [filter] Records to search.
 *   Dropped items cannot be filtered and always block the proof.
 */

/**
 * @typedef {object} CanaryPresentOptions
 * @property {boolean} [fullPrompt=true] Require a complete record whose
 *   `prompt` is `full`. Set `false` to accept any record, such as a delta that
 *   carries a new tool result.
 * @property {boolean} [toolResult=false] Require the canary inside a tool
 *   result: an Anthropic `*tool_result` content block, an OpenAI Responses
 *   `*_output` input item (`function_call_output`, `custom_tool_call_output`,
 *   `tool_search_output`, …), or a Chat Completions `role: 'tool'` message.
 * @property {(record: CaptureRecord) => boolean} [filter] Records to search.
 */

/**
 * @typedef {object} CanaryHit
 * @property {number} seq
 * @property {CaptureRecord['kind']} kind
 * @property {string | null} surface
 * @property {CaptureRecord['prompt']} prompt
 * @property {boolean} complete
 * @property {string[]} incomplete
 * @property {('path' | 'raw' | 'json' | 'tool-result')[]} locations `raw`
 *   searches the retained bytes; `json` searches decoded strings and keys,
 *   which also finds `\u`-escaped text.
 */

/**
 * Create a recorder. `capture` is the read-only evidence API. `sink` is the
 * feed used by ./capture-server.mjs and by unit tests; do not hand it to code
 * under test.
 *
 * @param {Partial<CaptureLimits>} [options]
 * @returns {{ capture: OutboundCapture, sink: ReturnType<typeof createSink> }}
 */
export function createOutboundCapture(options = {}) {
  const limits = Object.freeze(resolveLimits(options));
  const state = { current: createWindow(), nextSeq: 1, nextConnection: 1 };

  function snapshot() {
    const win = state.current;
    const records = win.records.map(projectRecord);
    const complete = records.filter((record) => record.complete).length;
    return {
      version: CAPTURE_SNAPSHOT_VERSION,
      limits: { ...limits },
      counts: {
        received: win.counts.received,
        recorded: records.length,
        dropped: win.counts.dropped,
        pending: win.counts.pending,
        complete,
        incomplete: records.length - complete,
      },
      kinds: { ...win.kinds },
      bytes: { ...win.bytes },
      overflow: { ...win.overflow },
      records,
      diagnostics: win.diagnostics.map((entry) => ({ ...entry })),
    };
  }

  /** @type {OutboundCapture} */
  const capture = Object.freeze({
    snapshot,
    reset() {
      state.current = createWindow();
    },
    assertComplete: () => assertSnapshotComplete(snapshot()),
    assertCanaryAbsent: (canaries, canaryOptions) =>
      assertSnapshotCanaryAbsent(snapshot(), canaries, canaryOptions),
    assertCanaryPresent: (canary, canaryOptions) =>
      assertSnapshotCanaryPresent(snapshot(), canary, canaryOptions),
    findCanary: (canary) => findSnapshotCanary(snapshot(), canary),
  });

  return { capture, sink: createSink(limits, state) };
}

/**
 * Throw an AssertionError unless the snapshot proves a complete capture: no
 * dropped item and no incomplete record, including partial prompts.
 *
 * @param {CaptureSnapshot} snapshot
 * @returns {CaptureSnapshot}
 */
export function assertSnapshotComplete(snapshot) {
  checkSnapshot(snapshot);
  const problems = [...droppedProblem(snapshot)];
  problems.push(
    ...listRecords(
      snapshot.records.filter((record) => record.incomplete.length > 0),
      (record) => record.incomplete.join(', '),
    ),
  );
  if (problems.length > 0) {
    assert.fail(`Outbound capture is incomplete: ${problems.join('; ')}`);
  }
  return snapshot;
}

/**
 * Throw an AssertionError if any canary appears in a searched record, or if
 * absence cannot be proven because an item was dropped or a searched record
 * has an evidence gap. Delta and prewarm messages are searched and do not
 * block the proof: their bytes are exact, and a resolved delta's earlier
 * context is another record in the same window.
 *
 * @param {CaptureSnapshot} snapshot
 * @param {string | string[]} canaries
 * @param {CanaryAbsentOptions} [options]
 * @returns {{ canaries: string[], searched: number }}
 */
export function assertSnapshotCanaryAbsent(snapshot, canaries, options = {}) {
  checkSnapshot(snapshot);
  const list = checkCanaries(canaries);
  const records = selectRecords(snapshot, options, ['filter']);
  const leaks = [];
  for (const canary of list) {
    for (const record of records) {
      const locations = locateCanary(record, canary);
      if (locations.length > 0) {
        leaks.push(
          `${canary} in ${describeRecord(record)} (${locations.join(', ')})`,
        );
      }
    }
  }
  const gaps = [
    ...droppedProblem(snapshot),
    ...listRecords(records.filter(hasEvidenceGap), (record) =>
      record.incomplete
        .filter((reason) => EVIDENCE_GAP_REASONS.includes(reason))
        .join(', '),
    ),
  ];
  if (leaks.length > 0) {
    const shown = leaks.slice(0, MAX_REPORTED_RECORDS);
    if (leaks.length > shown.length) {
      shown.push(`${leaks.length - shown.length} more`);
    }
    const suffix = gaps.length > 0 ? `; evidence gaps: ${gaps.join('; ')}` : '';
    assert.fail(
      `Canary reached outbound traffic: ${shown.join('; ')}${suffix}`,
    );
  }
  if (gaps.length > 0) {
    assert.fail(`Cannot prove canary absence: ${gaps.join('; ')}`);
  }
  return { canaries: list, searched: records.length };
}

/**
 * Throw an AssertionError unless the canary appears in a qualifying record.
 * By default only a complete full prompt qualifies, so a delta or prewarm
 * message never stands in for the full history. The error names near misses.
 *
 * @param {CaptureSnapshot} snapshot
 * @param {string} canary
 * @param {CanaryPresentOptions} [options]
 * @returns {{ canary: string, matches: number[] }} Matching `seq` values.
 */
export function assertSnapshotCanaryPresent(snapshot, canary, options = {}) {
  checkSnapshot(snapshot);
  checkCanary(canary);
  const records = selectRecords(snapshot, options, [
    'filter',
    'fullPrompt',
    'toolResult',
  ]);
  const fullPrompt = booleanOption(options, 'fullPrompt', true);
  const toolResult = booleanOption(options, 'toolResult', false);
  const found = [];
  for (const record of records) {
    const locations = locateCanary(record, canary);
    if (locations.length > 0) found.push({ record, locations });
  }
  const matches = found.filter(
    ({ record, locations }) =>
      (!toolResult || locations.includes('tool-result')) &&
      (!fullPrompt || (record.prompt === 'full' && record.complete)),
  );
  if (matches.length > 0) {
    return { canary, matches: matches.map(({ record }) => record.seq) };
  }
  const scope = `${toolResult ? 'a tool result in ' : ''}${
    fullPrompt ? 'a complete full prompt' : 'any record'
  }`;
  const nearMisses = listRecords(
    found.map(({ record }) => record),
    (record) => {
      const { locations } = found.find((entry) => entry.record === record);
      const partial = PARTIAL_PROMPT_REASONS.includes(record.prompt)
        ? ': not a full prompt'
        : '';
      const reasons =
        record.incomplete.length > 0
          ? `; incomplete ${record.incomplete.join(', ')}`
          : '';
      return `prompt ${record.prompt}${partial}${reasons}; at ${locations.join(', ')}`;
    },
  );
  const detail =
    nearMisses.length > 0
      ? `; found only in ${nearMisses.join('; ')}`
      : '; it does not occur in any searched record';
  assert.fail(
    `Canary ${canary} was not found in ${scope} (${records.length} records searched)${detail}`,
  );
}

/**
 * Locate a canary in every record of a snapshot.
 *
 * @param {CaptureSnapshot} snapshot
 * @param {string} canary
 * @returns {CanaryHit[]}
 */
export function findSnapshotCanary(snapshot, canary) {
  checkSnapshot(snapshot);
  checkCanary(canary);
  const hits = [];
  for (const record of snapshot.records) {
    const locations = locateCanary(record, canary);
    if (locations.length === 0) continue;
    hits.push({
      seq: record.seq,
      kind: record.kind,
      surface: record.surface,
      prompt: record.prompt,
      complete: record.complete,
      incomplete: [...record.incomplete],
      locations,
    });
  }
  return hits;
}

// ── Recorder internals ──────────────────────────────────────────────────────

function resolveLimits(options) {
  if (options === undefined) return { ...DEFAULT_CAPTURE_LIMITS };
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Capture options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!LIMIT_KEYS.includes(key)) {
      throw new TypeError(
        `Unknown capture option "${key}". Expected ${LIMIT_KEYS.join(', ')}.`,
      );
    }
  }
  const limits = { ...DEFAULT_CAPTURE_LIMITS };
  for (const key of LIMIT_KEYS) {
    const value = options[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(
        `Capture option ${key} must be a positive safe integer; received ${String(value)}.`,
      );
    }
    limits[key] = value;
  }
  return limits;
}

function createWindow() {
  return {
    records: [],
    counts: { received: 0, dropped: 0, pending: 0 },
    kinds: { http: 0, wsUpgrade: 0, wsMessage: 0 },
    bytes: { received: 0, retained: 0, omitted: 0 },
    overflow: { bodyCapRecords: 0, totalCapRecords: 0, droppedDiagnostics: 0 },
    diagnostics: [],
    // Response id → seq of the WebSocket message answered with it.
    responseSeqs: new Map(),
  };
}

function createSink(limits, state) {
  function diagnose(win, seq, code, detail) {
    if (win.diagnostics.length < limits.maxDiagnostics) {
      win.diagnostics.push({ seq, code, detail });
    } else {
      win.overflow.droppedDiagnostics += 1;
    }
  }

  // Count one received item in the current window and record it while below
  // maxRecords. Updates to a pending item keep going to the window that
  // admitted it, so a reset never mixes old bytes into the new window.
  function admit(kindKey, fields, label) {
    const win = state.current;
    const seq = state.nextSeq;
    state.nextSeq += 1;
    win.counts.received += 1;
    win.kinds[kindKey] += 1;
    if (win.records.length >= limits.maxRecords) {
      win.counts.dropped += 1;
      diagnose(
        win,
        seq,
        'record-cap',
        `${label} was not recorded: maxRecords (${limits.maxRecords}) reached`,
      );
      return { win, seq, record: null };
    }
    const record = newRecord(seq, fields);
    win.records.push(record);
    win.counts.pending += 1;
    return { win, seq, record };
  }

  function retain(win, record, input) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    win.bytes.received += chunk.length;
    if (!record) {
      win.bytes.omitted += chunk.length;
      return;
    }
    record.byteLength += chunk.length;
    const bodyRoom = limits.maxBodyBytes - record.retainedBytes;
    const totalRoom = limits.maxTotalBytes - win.bytes.retained;
    const take = Math.max(0, Math.min(chunk.length, bodyRoom, totalRoom));
    if (take > 0) {
      // Copy, so the record neither aliases nor pins the transport's buffer.
      record.chunks.push(Buffer.from(chunk.subarray(0, take)));
      record.retainedBytes += take;
      win.bytes.retained += take;
    }
    if (take === chunk.length) return;
    win.bytes.omitted += chunk.length - take;
    const reason = bodyRoom <= totalRoom ? 'body-cap' : 'total-cap';
    if (record.reasons.has(reason)) return;
    record.reasons.add(reason);
    if (reason === 'body-cap') {
      win.overflow.bodyCapRecords += 1;
    } else {
      win.overflow.totalCapRecords += 1;
    }
    const limit =
      reason === 'body-cap'
        ? `maxBodyBytes (${limits.maxBodyBytes})`
        : `maxTotalBytes (${limits.maxTotalBytes})`;
    diagnose(
      win,
      record.seq,
      reason,
      `${describeRecord(record)} exceeded ${limit}`,
    );
  }

  function finish(win, record, outcome, code) {
    if (!record || record.state !== 'pending') return;
    record.state = outcome;
    record.reasons.delete('pending');
    win.counts.pending -= 1;
    record.buffer = Buffer.concat(record.chunks, record.retainedBytes);
    record.chunks = null;
    if (outcome === 'aborted') {
      record.reasons.add('aborted');
      record.error = boundLabel(code) ?? 'aborted';
      diagnose(
        win,
        record.seq,
        'aborted',
        `${describeRecord(record)} ended after ${record.byteLength} bytes (${record.error})`,
      );
    }
    classify(win, record);
  }

  function markMalformed(win, record, code) {
    record.state = 'aborted';
    record.reasons.delete('pending');
    record.reasons.add('malformed');
    win.counts.pending -= 1;
    record.buffer = Buffer.alloc(0);
    record.chunks = null;
    record.parse = 'unavailable';
    record.error = boundLabel(code) ?? 'malformed';
    diagnose(
      win,
      record.seq,
      'malformed',
      `${describeRecord(record)} was rejected by the transport (${record.error})`,
    );
  }

  function classify(win, record) {
    if (isContentEncoded(record.contentEncoding)) {
      record.reasons.add('encoded');
      record.parse = 'encoded';
      return;
    }
    record.marker = boundLabel(markerFromText(record.buffer.toString('utf8')));
    if (TRUNCATING_REASONS.some((reason) => record.reasons.has(reason))) {
      record.parse = 'truncated';
      return;
    }
    const parsed = parseJson(record.buffer);
    record.parse = parsed.status;
    if (parsed.status !== 'ok') return;
    const shape = promptShape(record, parsed.value);
    record.prompt = shape.prompt;
    if (shape.prompt === 'prewarm') record.reasons.add('prewarm');
    if (shape.previousResponseId === null) return;
    record.reasons.add('delta');
    record.previousResponseId = shape.previousResponseId;
    record.previousSeq = win.responseSeqs.get(shape.previousResponseId) ?? null;
    if (record.previousSeq !== null) return;
    record.reasons.add('unresolved-delta');
    diagnose(
      win,
      record.seq,
      'unresolved-delta',
      `${describeRecord(record)} continues ${record.previousResponseId}, which this window did not answer`,
    );
  }

  return Object.freeze({
    /**
     * Start an HTTP request record. Call `push` for each body chunk, then
     * exactly one of `end` or `abort`; `settled` resolves to the outcome.
     *
     * @param {{ method?: string, path?: string, queryKeys?: string[], contentEncoding?: string | null, surface?: string | null }} fields
     */
    beginHttp(fields) {
      const { win, seq, record } = admit(
        'http',
        { ...fields, kind: 'http' },
        `http ${fields.method ?? '?'} ${fields.path ?? '?'}`,
      );
      let settle;
      /** @type {Promise<'done' | 'aborted'>} */
      const settled = new Promise((resolve) => {
        settle = resolve;
      });
      let open = true;
      const close = (outcome, code) => {
        if (!open) return;
        open = false;
        finish(win, record, outcome, code);
        settle(outcome);
      };
      return Object.freeze({
        seq,
        recorded: record !== null,
        settled,
        push(chunk) {
          if (open) retain(win, record, chunk);
        },
        end() {
          close('done');
        },
        abort(code) {
          close('aborted', code);
        },
        setOutcome(handled, status) {
          if (!record) return;
          record.handled = handled;
          record.status = status;
        },
        noteError(code) {
          diagnose(
            win,
            seq,
            'handler-error',
            `routes/llm.mjs failed for #${seq} (${boundLabel(code) ?? 'unknown'})`,
          );
        },
      });
    },

    /**
     * Record a WebSocket upgrade request and allocate its connection id.
     *
     * @param {{ method?: string, path?: string, queryKeys?: string[], surface?: string | null }} fields
     */
    recordUpgrade(fields) {
      const connection = state.nextConnection;
      state.nextConnection += 1;
      const { win, seq, record } = admit(
        'wsUpgrade',
        { ...fields, kind: 'ws-upgrade', connection },
        `ws-upgrade ${fields.method ?? '?'} ${fields.path ?? '?'}`,
      );
      if (record) {
        record.upgrade = 'pending';
        finish(win, record, 'done');
      }
      let decided = false;
      return Object.freeze({
        seq,
        connection,
        accept() {
          if (decided) return;
          decided = true;
          if (record) record.upgrade = 'accepted';
        },
        /** @param {number} [discardedBytes] Bytes that arrived with the upgrade. */
        reject(discardedBytes = 0) {
          if (decided) return;
          decided = true;
          if (record) record.upgrade = 'rejected';
          if (discardedBytes <= 0) return;
          win.bytes.received += discardedBytes;
          win.bytes.omitted += discardedBytes;
          if (!record) return;
          record.byteLength += discardedBytes;
          record.parse = 'unavailable';
          record.reasons.add('discarded-data');
          diagnose(
            win,
            seq,
            'discarded-data',
            `${describeRecord(record)} was rejected with ${discardedBytes} bytes of data`,
          );
        },
      });
    },

    /**
     * Record one complete WebSocket message.
     *
     * @param {{ connection: number, frame: number, binary: boolean, data: Buffer, surface?: string | null }} fields
     */
    recordMessage({ connection, frame, binary, data, surface = null }) {
      const { win, seq, record } = admit(
        'wsMessage',
        { kind: 'ws-message', connection, frame, binary, surface },
        `ws-message connection ${connection} frame ${frame}`,
      );
      retain(win, record, data);
      finish(win, record, 'done');
      return Object.freeze({
        seq,
        recorded: record !== null,
        /**
         * @param {'response' | 'failed' | 'ignored' | 'error'} reply
         * @param {string} [responseId] The id sent back to the client.
         */
        setReply(reply, responseId) {
          if (!record) return;
          record.reply = reply;
          if (typeof responseId !== 'string' || responseId === '') return;
          record.responseId = boundLabel(responseId);
          win.responseSeqs.set(record.responseId, seq);
        },
        noteError(code) {
          diagnose(
            win,
            seq,
            'handler-error',
            `scripted Responses reply failed for #${seq} (${boundLabel(code) ?? 'unknown'})`,
          );
        },
      });
    },

    /**
     * Record a WebSocket frame the protocol layer rejected before delivery.
     *
     * @param {{ connection: number, frame: number, code: string, surface?: string | null }} fields
     */
    recordMessageError({ connection, frame, code, surface = null }) {
      const { win, record } = admit(
        'wsMessage',
        { kind: 'ws-message', connection, frame, surface },
        `ws-message connection ${connection} frame ${frame}`,
      );
      if (record) markMalformed(win, record, code);
    },

    /**
     * Record an HTTP request Node could not parse into a request.
     *
     * @param {{ code: string }} fields
     */
    recordMalformedRequest({ code }) {
      const { win, record } = admit(
        'http',
        { kind: 'http' },
        `malformed http request (${boundLabel(code) ?? 'unknown'})`,
      );
      if (record) markMalformed(win, record, code);
    },
  });
}

function newRecord(seq, fields) {
  return {
    seq,
    kind: fields.kind,
    surface: typeof fields.surface === 'string' ? fields.surface : null,
    method: typeof fields.method === 'string' ? fields.method : null,
    path: typeof fields.path === 'string' ? fields.path : null,
    queryKeys: Array.isArray(fields.queryKeys)
      ? fields.queryKeys.filter((key) => typeof key === 'string')
      : [],
    contentEncoding:
      typeof fields.contentEncoding === 'string'
        ? fields.contentEncoding
        : null,
    connection: Number.isSafeInteger(fields.connection)
      ? fields.connection
      : null,
    frame: Number.isSafeInteger(fields.frame) ? fields.frame : null,
    binary: typeof fields.binary === 'boolean' ? fields.binary : null,
    state: 'pending',
    byteLength: 0,
    retainedBytes: 0,
    chunks: [],
    buffer: null,
    parse: 'pending',
    prompt: 'none',
    previousResponseId: null,
    previousSeq: null,
    responseId: null,
    marker: null,
    handled: null,
    status: null,
    upgrade: null,
    reply: null,
    error: null,
    reasons: new Set(['pending']),
  };
}

function projectRecord(record) {
  const bytes =
    record.buffer ?? Buffer.concat(record.chunks, record.retainedBytes);
  const incomplete = [...record.reasons].sort();
  return {
    seq: record.seq,
    kind: record.kind,
    surface: record.surface,
    method: record.method,
    path: record.path,
    queryKeys: [...record.queryKeys],
    contentEncoding: record.contentEncoding,
    connection: record.connection,
    frame: record.frame,
    binary: record.binary,
    state: record.state,
    byteLength: record.byteLength,
    retainedBytes: record.retainedBytes,
    rawBase64: bytes.toString('base64'),
    parse: record.parse,
    ...(record.parse === 'ok' ? { json: JSON.parse(utf8.decode(bytes)) } : {}),
    prompt: record.prompt,
    previousResponseId: record.previousResponseId,
    previousSeq: record.previousSeq,
    responseId: record.responseId,
    marker: record.marker,
    handled: record.handled,
    status: record.status,
    upgrade: record.upgrade,
    reply: record.reply,
    error: record.error,
    complete: incomplete.length === 0,
    incomplete,
  };
}

function parseJson(buffer) {
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    return { status: 'invalid' };
  }
  // Mirrors `!raw.trim()` in the mock's body readers.
  if (text.trim() === '') return { status: 'empty' };
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch {
    return { status: 'invalid' };
  }
}

function promptShape(record, body) {
  const none = { prompt: 'none', previousResponseId: null };
  if (!isPlainObject(body)) return none;
  if (record.kind === 'ws-message') {
    return body.type === 'response.create' ? responsesShape(body) : none;
  }
  if (record.kind !== 'http') return none;
  switch (record.surface) {
    case CAPTURE_SURFACES.openAiResponses:
      return responsesShape(body);
    case CAPTURE_SURFACES.anthropicMessages:
    case CAPTURE_SURFACES.openAiChatCompletions:
      return {
        prompt: Array.isArray(body.messages) ? 'full' : 'none',
        previousResponseId: null,
      };
    default:
      return none;
  }
}

function responsesShape(body) {
  const previous = body.previous_response_id;
  const previousResponseId =
    previous === undefined || previous === null || previous === ''
      ? null
      : boundLabel(
          typeof previous === 'string' ? previous : JSON.stringify(previous),
        );
  if (body.generate === false) return { prompt: 'prewarm', previousResponseId };
  if (previousResponseId !== null)
    return { prompt: 'delta', previousResponseId };
  const hasInput = typeof body.input === 'string' || Array.isArray(body.input);
  return { prompt: hasInput ? 'full' : 'none', previousResponseId: null };
}

// ── Snapshot helpers ────────────────────────────────────────────────────────

function checkSnapshot(snapshot) {
  if (
    !isPlainObject(snapshot) ||
    snapshot.version !== CAPTURE_SNAPSHOT_VERSION ||
    !Array.isArray(snapshot.records) ||
    !isPlainObject(snapshot.counts) ||
    !isPlainObject(snapshot.limits)
  ) {
    throw new TypeError(
      `Expected an outbound capture snapshot (version ${CAPTURE_SNAPSHOT_VERSION}).`,
    );
  }
}

function checkCanary(canary) {
  if (typeof canary !== 'string' || !CANARY_PATTERN.test(canary)) {
    throw new TypeError(
      `Canaries must be 8-256 characters of [A-Za-z0-9_.:-] starting with a letter or digit; received ${JSON.stringify(canary)}.`,
    );
  }
}

function checkCanaries(canaries) {
  const list = typeof canaries === 'string' ? [canaries] : canaries;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(
      'Expected a canary string or a non-empty array of them.',
    );
  }
  list.forEach(checkCanary);
  return [...list];
}

function selectRecords(snapshot, options, allowedKeys) {
  if (!isPlainObject(options)) {
    throw new TypeError('Canary options must be an object.');
  }
  for (const key of Object.keys(options)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(
        `Unknown canary option "${key}". Expected ${allowedKeys.join(', ')}.`,
      );
    }
  }
  const { filter } = options;
  if (filter === undefined) return snapshot.records;
  if (typeof filter !== 'function') {
    throw new TypeError('Canary option filter must be a function of a record.');
  }
  return snapshot.records.filter((record) => filter(record));
}

function booleanOption(options, key, fallback) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TypeError(`Canary option ${key} must be a boolean.`);
  }
  return value;
}

function locateCanary(record, canary) {
  const locations = [];
  if (typeof record.path === 'string' && record.path.includes(canary)) {
    locations.push('path');
  }
  if (Buffer.from(record.rawBase64, 'base64').includes(canary, 0, 'utf8')) {
    locations.push('raw');
  }
  if (record.parse === 'ok') {
    const { anywhere, inToolResult } = searchJson(record.json, canary);
    if (anywhere) locations.push('json');
    if (inToolResult) locations.push('tool-result');
  }
  return locations;
}

// Iterative walk over decoded strings and object keys, tracking whether the
// current node sits inside a tool result.
function searchJson(value, canary) {
  let anywhere = false;
  let inToolResult = false;
  const stack = [{ node: value, inside: false }];
  while (stack.length > 0 && !(anywhere && inToolResult)) {
    const { node, inside } = stack.pop();
    if (typeof node === 'string') {
      if (node.includes(canary)) {
        anywhere = true;
        inToolResult ||= inside;
      }
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, inside });
      continue;
    }
    const within = inside || isToolResult(node);
    for (const [key, child] of Object.entries(node)) {
      if (key.includes(canary)) {
        anywhere = true;
        inToolResult ||= within;
      }
      stack.push({ node: child, inside: within });
    }
  }
  return { anywhere, inToolResult };
}

function isToolResult(node) {
  if (node.role === 'tool') return true;
  return (
    typeof node.type === 'string' &&
    (node.type.endsWith('tool_result') || node.type.endsWith('_output'))
  );
}

function hasEvidenceGap(record) {
  return record.incomplete.some((reason) =>
    EVIDENCE_GAP_REASONS.includes(reason),
  );
}

function droppedProblem(snapshot) {
  if (!(snapshot.counts.dropped > 0)) return [];
  return [
    `${snapshot.counts.dropped} of ${snapshot.counts.received} received items were not recorded (maxRecords ${snapshot.limits.maxRecords})`,
  ];
}

function listRecords(records, detail) {
  const lines = records
    .slice(0, MAX_REPORTED_RECORDS)
    .map((record) => `${describeRecord(record)} [${detail(record)}]`);
  if (records.length > MAX_REPORTED_RECORDS) {
    lines.push(`${records.length - MAX_REPORTED_RECORDS} more records`);
  }
  return lines;
}

function describeRecord(record) {
  if (record.kind === 'ws-message') {
    return `#${record.seq} ws-message connection ${record.connection} frame ${record.frame}`;
  }
  return `#${record.seq} ${record.kind} ${record.method ?? '?'} ${record.path ?? '?'}`;
}

function isContentEncoded(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== 'identity';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundLabel(value) {
  if (typeof value !== 'string') return null;
  return value.length > MAX_LABEL_CHARS
    ? value.slice(0, MAX_LABEL_CHARS)
    : value;
}
