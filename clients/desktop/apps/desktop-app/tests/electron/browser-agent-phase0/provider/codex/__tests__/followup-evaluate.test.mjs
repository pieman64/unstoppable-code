import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_AGENT_TOOL_NAMES } from '../../shared/tool-schemas.mjs';
import { evaluateFollowUp, summarizeArm } from '../followup-evaluate.mjs';

const EXEC_DESCRIPTION = BROWSER_AGENT_TOOL_NAMES.map(
  (name) => `### \`${name}\`\nBrowser agent tool "${name}".`,
).join('\n');

function record(seq, json, extra = {}) {
  const raw = Buffer.from(JSON.stringify(json));
  return {
    seq,
    kind: 'http',
    surface: 'openai-responses',
    method: 'POST',
    path: '/v1/responses',
    prompt: 'full',
    complete: true,
    parse: 'ok',
    json,
    byteLength: raw.length,
    rawBase64: raw.toString('base64'),
    previousSeq: null,
    ...extra,
  };
}

const wrapperTools = {
  type: 'additional_tools',
  tools: [
    {
      type: 'namespace',
      name: 'functions',
      tools: [
        { type: 'custom', name: 'exec', description: EXEC_DESCRIPTION },
        { type: 'function', name: 'wait' },
        { type: 'function', name: 'request_user_input' },
      ],
    },
  ],
};

const user = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '[Canopy-Cx] go' }],
};

function baselineSnapshot({ execOutput }) {
  const history = [
    user,
    { type: 'function_call', call_id: 'c1', name: 'observe', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    { type: 'function_call', call_id: 'c2', name: 'wait', arguments: '{}' },
    {
      type: 'function_call_output',
      call_id: 'c2',
      output: 'unknown exec cell',
    },
    { type: 'custom_tool_call', call_id: 'c3', name: 'exec', input: 'text(1)' },
    { type: 'custom_tool_call_output', call_id: 'c3', output: execOutput },
  ];
  return {
    counts: { received: 4 },
    records: [
      record(1, { input: [wrapperTools, user] }),
      record(2, { input: [wrapperTools, ...history.slice(0, 3)] }),
      record(3, { input: [wrapperTools, ...history.slice(0, 5)] }),
      record(4, { input: [wrapperTools, ...history] }),
    ],
  };
}

const probeOutput = (payload) =>
  `Output:\nBAP0_PROBE_JSON:${JSON.stringify(payload)}\n`;
const denied = { ok: false, e: 'ReferenceError: x is not defined' };
const CLEAN_PAYLOAD = Object.fromEntries(
  [
    'typeof-require',
    'typeof-process',
    'typeof-fetch',
    'typeof-Deno',
    'typeof-Bun',
    'typeof-XMLHttpRequest',
    'typeof-WebSocket',
  ].map((key) => [key, { ok: true, v: 'undefined' }]),
);
Object.assign(CLEAN_PAYLOAD, {
  'dynamic-import-fs': denied,
  'host-file-read': denied,
  'env-read': denied,
  spawn: denied,
  'loopback-fetch': denied,
  globals: { ok: true, v: 'Array,Object' },
  'all-tools': { ok: true, v: BROWSER_AGENT_TOOL_NAMES.join(',') },
  'browser-call': { ok: true, v: '{"observationId":"o"}' },
});

const EVIDENCE = {
  hostCanary: 'HOSTC',
  envCanary: 'ENVC',
  spawnMarkerExists: false,
  loopbackHits: 0,
};

function baselineArm(overrides = {}) {
  return summarizeArm({
    id: 'baseline',
    snapshot: baselineSnapshot({ execOutput: probeOutput(CLEAN_PAYLOAD) }),
    hostCalls: [
      { tool: 'observe', namespace: null, generationsSeen: 1 },
      { tool: 'observe', namespace: null, generationsSeen: 3 },
    ],
    wrapperEvidence: EVIDENCE,
    notifyDelta: 1,
    eventMethods: ['turn/started', 'turn/completed'],
    tokenUsageEvents: [],
    turn: { status: 'completed', error: null },
    twin: {
      model: 'gpt-6-sol',
      modelProvider: 'probe',
      instructionSources: [],
    },
    ...overrides,
  });
}

test('a baseline arm summarises as wrapped-only with the wait routed away from the host tool', () => {
  const arm = baselineArm();
  assert.equal(arm.surface.verdict.reachability, 'wrapped-only');
  assert.equal(arm.surface.verdict.closed, false);
  assert.equal(arm.surface.stableAcrossRequests, true);
  assert.deepEqual(
    arm.surface.verdict.collisions.map((entry) => entry.kind),
    ['cross-layer'],
  );
  assert.equal(arm.wait.handledBy, 'other-handler');
  assert.equal(arm.direct.observe.answered, true);
  assert.equal(arm.wrapper.status, 'pass');
  assert.equal(
    arm.wrapper.positiveControl,
    true,
    'host saw the nested observe after request 3',
  );
  assert.equal(arm.notifyDelta, 1);
  assert.equal(arm.model, 'gpt-6-sol');
});

test('exec being advertised does not make the wrapper pass without a JS result', () => {
  const arm = summarizeArm({
    ...{
      id: 'baseline',
      snapshot: baselineSnapshot({ execOutput: 'unsupported call: exec' }),
      hostCalls: [],
      wrapperEvidence: EVIDENCE,
      notifyDelta: 0,
      eventMethods: [],
      tokenUsageEvents: [],
      turn: { status: 'completed', error: null },
      twin: { model: 'gpt-6-sol' },
    },
  });
  assert.equal(arm.wrapper.status, 'unobserved');
  assert.equal(arm.wrapper.reason, 'tool-error');
});

test('a coding arm reports its surface without a browser verdict', () => {
  const arm = summarizeArm({
    id: 'coding-control-after',
    snapshot: {
      records: [
        record(1, {
          tools: [{ type: 'function', name: 'shell' }],
          input: [user],
        }),
      ],
    },
    hostCalls: [],
    wrapperEvidence: EVIDENCE,
    notifyDelta: 1,
    eventMethods: [],
    tokenUsageEvents: [],
    turn: { status: 'completed', error: null },
    twin: { model: 'gpt-6-sol' },
  });
  assert.equal(arm.surface.verdict, null);
  assert.deepEqual(arm.surface.topLevel, ['shell']);
  assert.equal(arm.wrapper, null);
});

test('an arm with no generation request is unobserved, not empty-and-fine', () => {
  const arm = summarizeArm({
    id: 'direct-model',
    snapshot: { records: [] },
    hostCalls: [],
    wrapperEvidence: EVIDENCE,
    notifyDelta: null,
    eventMethods: [],
    tokenUsageEvents: [],
    turn: { status: 'error', error: 'startThread failed' },
    twin: null,
  });
  assert.equal(arm.requestCount, 0);
  assert.equal(arm.surface, null);
  assert.equal(arm.wrapper, null);
});

function directArm({ waitByHost = true } = {}) {
  const tools = {
    type: 'additional_tools',
    tools: [
      {
        type: 'namespace',
        name: 'functions',
        tools: BROWSER_AGENT_TOOL_NAMES.map((name) => ({
          type: 'function',
          name,
        })),
      },
    ],
  };
  const history = [
    user,
    { type: 'function_call', call_id: 'c1', name: 'observe', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"ok":true}' },
    { type: 'function_call', call_id: 'c2', name: 'wait', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c2', output: '{"ok":true}' },
    { type: 'custom_tool_call', call_id: 'c3', name: 'exec', input: 'text(1)' },
    {
      type: 'custom_tool_call_output',
      call_id: 'c3',
      output: 'unsupported custom tool call: exec',
    },
  ];
  return summarizeArm({
    id: 'direct-model',
    snapshot: {
      records: [
        record(1, { input: [tools, user] }),
        record(2, { input: [tools, ...history] }),
      ],
    },
    hostCalls: waitByHost
      ? [
          { tool: 'observe', namespace: null, generationsSeen: 1 },
          { tool: 'wait', namespace: null, generationsSeen: 2 },
        ]
      : [],
    wrapperEvidence: EVIDENCE,
    notifyDelta: 1,
    eventMethods: [],
    tokenUsageEvents: [],
    turn: { status: 'completed', error: null },
    twin: { model: 'gpt-5.5' },
  });
}

test('a direct flat surface with no wrapper is closed and its wrapper is unavailable', () => {
  const arm = directArm();
  assert.equal(arm.surface.verdict.closed, true);
  assert.equal(arm.wrapper.status, 'unavailable');
  assert.equal(arm.wait.handledBy, 'host-dynamic-tool');
});

function rows(summaries) {
  return Object.fromEntries(
    evaluateFollowUp(summaries, {
      threshold: 125_000,
      configObservation: null,
    }).map((row) => [row.id, row]),
  );
}

test('surface passes only when some arm is closed and its wait reached the host tool', () => {
  const ok = rows([baselineArm(), directArm()]);
  assert.equal(ok['followup.codex-surface'].status, 'pass');
  assert.deepEqual(ok['followup.codex-surface'].evidence.closedArms, [
    'direct-model',
  ]);
  const wrongWait = rows([baselineArm(), directArm({ waitByHost: false })]);
  assert.equal(wrongWait['followup.codex-surface'].status, 'fail');
  assert.deepEqual(wrongWait['followup.codex-surface'].evidence.closedArms, []);
  const none = rows([]);
  assert.equal(none['followup.codex-surface'].status, 'unobserved');
});

test('wrapper rows aggregate to fail on any escape and treat all-unavailable as not applicable', () => {
  const leaking = baselineArm({
    wrapperEvidence: { ...EVIDENCE, spawnMarkerExists: true },
  });
  assert.equal(
    rows([leaking, directArm()])['followup.codex-wrapper'].status,
    'fail',
  );
  assert.equal(
    rows([baselineArm(), directArm()])['followup.codex-wrapper'].status,
    'pass',
  );
  assert.equal(rows([directArm()])['followup.codex-wrapper'].status, 'n/a');
  assert.equal(rows([])['followup.codex-wrapper'].status, 'unobserved');
});

test('notify row pairs baseline, suppressed and post-suppression coding arms', () => {
  const arm = (id, notifyDelta) =>
    summarizeArm({
      id,
      snapshot: { records: [] },
      hostCalls: [],
      wrapperEvidence: EVIDENCE,
      notifyDelta,
      eventMethods: [],
      tokenUsageEvents: [],
      turn: { status: 'completed', error: null },
      twin: null,
    });
  assert.equal(
    rows([
      arm('baseline', 1),
      arm('notify-empty', 0),
      arm('coding-control-after', 1),
    ])['followup.codex-notify'].status,
    'pass',
  );
  assert.equal(
    rows([
      arm('baseline', 1),
      arm('notify-empty', 1),
      arm('coding-control-after', 1),
    ])['followup.codex-notify'].status,
    'fail',
  );
  assert.equal(
    rows([arm('baseline', 1)])['followup.codex-notify'].status,
    'unobserved',
  );
});

test('context row is measured from the context arm and carries config and compaction observations', () => {
  const arm = summarizeArm({
    id: 'toggles-context',
    snapshot: { records: [] },
    hostCalls: [],
    wrapperEvidence: EVIDENCE,
    notifyDelta: 1,
    eventMethods: ['thread/tokenUsage/updated', 'thread/compacted'],
    tokenUsageEvents: [
      {
        total: { inputTokens: 90_000 },
        last: { inputTokens: 90_000 },
        modelContextWindow: 258_400,
      },
      {
        total: { inputTokens: 216_000 },
        last: { inputTokens: 126_000 },
        modelContextWindow: 258_400,
      },
    ],
    turn: { status: 'completed', error: null },
    twin: null,
  });
  const row = evaluateFollowUp([arm], {
    threshold: 125_000,
    configObservation: {
      model_context_window: null,
      model_auto_compact_token_limit: null,
    },
  }).find((entry) => entry.id === 'followup.context');
  assert.equal(row.status, 'measured');
  assert.equal(row.evidence.signals.firstContextCrossing.index, 1);
  assert.deepEqual(row.evidence.compaction.eventMethods, ['thread/compacted']);
  assert.deepEqual(row.evidence.configObservation, {
    model_context_window: null,
    model_auto_compact_token_limit: null,
  });
  assert.match(
    row.evidence.unobserved.join(' '),
    /real tokenizer|calibration/i,
  );
  const empty = evaluateFollowUp([], {
    threshold: 125_000,
    configObservation: null,
  }).find((entry) => entry.id === 'followup.context');
  assert.equal(empty.status, 'unobserved');
});

test('a model the runtime did not report as requested can never close a surface', () => {
  const silentFallback = (() => {
    const arm = directArm();
    return { ...arm, model: 'gpt-6-sol', modelMatches: false };
  })();
  assert.equal(directArm().modelMatches, true);
  assert.equal(directArm().requestedModel, 'gpt-5.5');
  const result = rows([baselineArm(), silentFallback]);
  assert.equal(result['followup.codex-surface'].status, 'fail');
  assert.deepEqual(result['followup.codex-surface'].evidence.closedArms, []);
  assert.match(
    result['followup.codex-surface'].evidence.scope,
    /synthetic contrast/,
  );
});

test('a wait made from inside the wrapper never stands in for the direct wait call', () => {
  const arm = baselineArm({
    hostCalls: [
      { tool: 'observe', namespace: null, generationsSeen: 1 },
      { tool: 'observe', namespace: null, generationsSeen: 3 },
      { tool: 'wait', namespace: null, generationsSeen: 3 },
    ],
  });
  assert.equal(arm.wait.handledBy, 'other-handler');
});

test('permitted actions need both the script report and the host record', () => {
  const payload = {
    ...CLEAN_PAYLOAD,
    'browser-wait-call': { ok: true, v: '{"ok":true}' },
  };
  const withHost = baselineArm({
    snapshot: baselineSnapshot({ execOutput: probeOutput(payload) }),
    hostCalls: [
      { tool: 'observe', namespace: null, generationsSeen: 3 },
      { tool: 'wait', namespace: null, generationsSeen: 3 },
    ],
  });
  assert.deepEqual(withHost.wrapper.permittedActions, {
    observe: true,
    wait: true,
  });
  const scriptOnly = baselineArm({
    snapshot: baselineSnapshot({ execOutput: probeOutput(payload) }),
    hostCalls: [{ tool: 'observe', namespace: null, generationsSeen: 3 }],
  });
  assert.deepEqual(scriptOnly.wrapper.permittedActions, {
    observe: true,
    wait: false,
  });
});
