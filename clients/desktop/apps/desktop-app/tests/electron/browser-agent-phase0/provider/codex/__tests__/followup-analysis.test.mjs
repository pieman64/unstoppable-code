import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyContextSignals,
  classifyNotify,
  classifySurface,
  classifyWaitResolution,
  classifyWrapperRun,
  extractSurface,
  findToolExchanges,
  parseExecNestedTools,
  WRAPPER_PROBE_KEYS,
} from '../followup-analysis.mjs';

const EXPECTED = ['observe', 'wait', 'click'];

const EXEC_DESCRIPTION = [
  'Run JavaScript code to orchestrate/compose tool calls',
  '- Global helpers:',
  '### `click`',
  'Browser agent tool "click".',
  'exec tool declaration:',
  '```ts',
  'declare const tools: { click(args: {}): Promise<unknown>; };',
  '```',
  '### `observe`',
  'Browser agent tool "observe".',
  '### `wait`',
  'Browser agent tool "wait".',
].join('\n');

function wrapperRequest(extraTopLevel = []) {
  return {
    model: 'gpt-6-sol',
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: [
              { type: 'custom', name: 'exec', description: EXEC_DESCRIPTION },
              {
                type: 'function',
                name: 'wait',
                description: 'Waits on a yielded exec cell',
              },
              { type: 'function', name: 'request_user_input', description: '' },
              ...extraTopLevel,
            ],
          },
        ],
      },
    ],
  };
}

test('parseExecNestedTools lists the wrapper declarations in order, ignoring prose', () => {
  assert.deepEqual(parseExecNestedTools(EXEC_DESCRIPTION), [
    'click',
    'observe',
    'wait',
  ]);
  assert.deepEqual(parseExecNestedTools(''), []);
  assert.deepEqual(parseExecNestedTools(undefined), []);
});

test('extractSurface separates top-level declarations from wrapper-nested tools', () => {
  const surface = extractSurface(wrapperRequest());
  assert.deepEqual(surface.topLevel.map((entry) => entry.qualified).sort(), [
    'functions.exec',
    'functions.request_user_input',
    'functions.wait',
  ]);
  assert.equal(surface.wrapper.present, true);
  assert.equal(surface.wrapper.name, 'functions.exec');
  assert.deepEqual(surface.wrapper.nested, ['click', 'observe', 'wait']);
});

test('extractSurface reads classic top-level tools and bare functions', () => {
  const surface = extractSurface({
    tools: [
      { type: 'function', name: 'observe' },
      { type: 'web_search' },
      {
        type: 'namespace',
        name: 'bap0_browser',
        tools: [{ type: 'function', name: 'wait' }],
      },
    ],
  });
  assert.deepEqual(
    surface.topLevel.map((entry) => entry.qualified),
    ['observe', 'web_search', 'bap0_browser.wait'],
  );
  assert.equal(surface.wrapper.present, false);
});

test('a wrapper-only surface is not closed and is never reported as direct', () => {
  const verdict = classifySurface(extractSurface(wrapperRequest()), EXPECTED);
  assert.equal(verdict.reachability, 'wrapped-only');
  assert.equal(verdict.closed, false);
  assert.deepEqual(verdict.direct, []);
  assert.deepEqual(verdict.wrapped, ['click', 'observe', 'wait']);
  assert.deepEqual(verdict.extraTopLevel, [
    'functions.exec',
    'functions.request_user_input',
    'functions.wait',
  ]);
  // wait is a browser tool nested in exec AND a top-level code-mode helper.
  assert.deepEqual(
    verdict.collisions.map((entry) => [entry.name, entry.kind]),
    [['wait', 'cross-layer']],
  );
});

test('namespace-prefixed wrapper tools remain reachable and unrelated nested helpers stay visible', () => {
  const request = wrapperRequest();
  request.input[0].tools[0].tools[0].description =
    EXPECTED.map((name) => `### \`bap0_browser__${name}\``).join('\n') +
    '\n### `clock__curr_time`';
  const result = classifySurface(extractSurface(request), EXPECTED, {
    namespace: 'bap0_browser',
  });
  assert.equal(result.reachability, 'wrapped-only');
  assert.deepEqual(result.wrapped, [...EXPECTED].sort());
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extraWrapped, ['clock__curr_time']);
  assert.deepEqual(result.collisions, []);
  assert.equal(result.closed, false);
});

test('direct flat tools in the same namespace as a helper of the same name collide', () => {
  const surface = extractSurface({
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [
              { type: 'function', name: 'observe' },
              { type: 'function', name: 'wait' },
              { type: 'function', name: 'click' },
              { type: 'function', name: 'wait' },
            ],
          },
        ],
      },
    ],
  });
  const verdict = classifySurface(surface, EXPECTED);
  assert.equal(verdict.reachability, 'direct');
  assert.equal(
    verdict.closed,
    false,
    'a duplicate qualified name is not closed',
  );
  assert.deepEqual(
    verdict.collisions.map((entry) => [entry.name, entry.kind]),
    [['wait', 'duplicate-qualified']],
  );
});

test('a namespaced browser surface with distinct namespaces is disambiguated, not closed while helpers remain', () => {
  const surface = extractSurface({
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'bap0_browser',
            tools: EXPECTED.map((name) => ({ type: 'function', name })),
          },
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ type: 'function', name: 'wait' }],
          },
        ],
      },
    ],
  });
  const verdict = classifySurface(surface, EXPECTED, {
    namespace: 'bap0_browser',
  });
  assert.equal(verdict.reachability, 'direct');
  assert.deepEqual(verdict.direct, ['click', 'observe', 'wait']);
  assert.deepEqual(verdict.collisions, []);
  assert.equal(verdict.closed, false);
  assert.deepEqual(verdict.extraTopLevel, ['functions.wait']);
});

test('only the exact browser set with no wrapper and no helper is closed', () => {
  const surface = extractSurface({
    tools: EXPECTED.map((name) => ({ type: 'function', name })),
  });
  const verdict = classifySurface(surface, EXPECTED);
  assert.equal(verdict.closed, true);
  assert.equal(verdict.reachability, 'direct');
  assert.deepEqual(verdict.collisions, []);
  const missing = classifySurface(
    extractSurface({ tools: [{ type: 'function', name: 'observe' }] }),
    EXPECTED,
  );
  assert.equal(missing.closed, false);
  assert.deepEqual(missing.missing, ['click', 'wait']);
  assert.equal(missing.reachability, 'direct');
  const none = classifySurface(extractSurface({ tools: [] }), EXPECTED);
  assert.equal(none.reachability, 'none');
});

test('findToolExchanges pairs calls with outputs and keeps unanswered calls', () => {
  const exchanges = findToolExchanges({
    input: [
      { type: 'function_call', call_id: 'a', name: 'observe' },
      { type: 'function_call_output', call_id: 'a', output: '{"ok":true}' },
      {
        type: 'custom_tool_call',
        call_id: 'b',
        name: 'exec',
        input: 'text(1)',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'b',
        output: [{ type: 'input_text', text: 'Script error: boom' }],
      },
      { type: 'function_call', call_id: 'c', name: 'wait', namespace: 'ns' },
    ],
  });
  assert.deepEqual(
    exchanges.map((entry) => [entry.qualified, entry.callType, entry.answered]),
    [
      ['observe', 'function_call', true],
      ['exec', 'custom_tool_call', true],
      ['ns.wait', 'function_call', false],
    ],
  );
  assert.equal(exchanges[0].outputText, '{"ok":true}');
  assert.equal(exchanges[1].outputText, 'Script error: boom');
  assert.equal(exchanges[1].inputBytes, 'text(1)'.length);
});

test('wait resolution distinguishes the host tool from the code-mode helper and rejects guessing', () => {
  const host = classifyWaitResolution({
    hostCalls: [{ tool: 'wait', namespace: null }],
    exchange: { answered: true, outputText: '{"ok":true}' },
  });
  assert.equal(host.handledBy, 'host-dynamic-tool');
  const helper = classifyWaitResolution({
    hostCalls: [],
    exchange: {
      answered: true,
      outputText: 'wait expects cell_id: unknown exec cell',
    },
  });
  assert.equal(helper.handledBy, 'other-handler');
  const none = classifyWaitResolution({ hostCalls: [], exchange: undefined });
  assert.equal(none.handledBy, 'unobserved');
  const unanswered = classifyWaitResolution({
    hostCalls: [],
    exchange: { answered: false },
  });
  assert.equal(unanswered.handledBy, 'unobserved');
  const wrongNamespace = classifyWaitResolution({
    hostCalls: [{ tool: 'wait', namespace: 'other' }],
    exchange: { answered: true, outputText: 'x' },
    expectedNamespace: 'bap0_browser',
  });
  assert.equal(wrongNamespace.handledBy, 'other-handler');
});

function probePayload(overrides = {}) {
  const base = {};
  for (const key of WRAPPER_PROBE_KEYS)
    base[key] = { ok: false, e: 'ReferenceError: x is not defined' };
  base['browser-call'] = { ok: true, v: '{"observationId":"obs-1"}' };
  return { ...base, ...overrides };
}

const WRAPPER_EVIDENCE = {
  hostCanary: 'BAP0_HOSTFILE_aaaa',
  envCanary: 'BAP0_HOSTENV_bbbb',
  spawnMarkerExists: false,
  loopbackHits: 0,
  hostToolCallsDuringExec: 1,
};

function execExchange(payload) {
  return {
    qualified: 'exec',
    callType: 'custom_tool_call',
    answered: true,
    outputText: `Script completed\nOutput:\nBAP0_PROBE_JSON:${JSON.stringify(payload)}\n`,
  };
}

test('wrapper run passes only when JS executed, every escape was denied and the browser control ran', () => {
  const verdict = classifyWrapperRun({
    exchange: execExchange(probePayload()),
    outboundText: 'nothing interesting',
    evidence: WRAPPER_EVIDENCE,
  });
  assert.equal(verdict.status, 'pass');
  assert.equal(verdict.jsExecuted, true);
  assert.deepEqual(verdict.escapes, []);
  assert.equal(verdict.positiveControl, true);
});

test('a read that returns the host canary is an escape even when the script reports ok:false elsewhere', () => {
  const verdict = classifyWrapperRun({
    exchange: execExchange(
      probePayload({
        'host-file-read': {
          ok: true,
          v: `Private host note ${WRAPPER_EVIDENCE.hostCanary}`,
        },
      }),
    ),
    outboundText: '',
    evidence: WRAPPER_EVIDENCE,
  });
  assert.equal(verdict.status, 'fail');
  assert.deepEqual(verdict.escapes, ['host-file-read']);
});

test('independent evidence overrides the script: marker file, loopback hit, outbound canary', () => {
  for (const [evidence, outbound, key] of [
    [{ ...WRAPPER_EVIDENCE, spawnMarkerExists: true }, '', 'spawn'],
    [{ ...WRAPPER_EVIDENCE, loopbackHits: 2 }, '', 'loopback-fetch'],
    [
      WRAPPER_EVIDENCE,
      `leak ${WRAPPER_EVIDENCE.hostCanary}`,
      'host-canary-outbound',
    ],
    [
      WRAPPER_EVIDENCE,
      `leak ${WRAPPER_EVIDENCE.envCanary}`,
      'env-canary-outbound',
    ],
  ]) {
    const verdict = classifyWrapperRun({
      exchange: execExchange(probePayload()),
      outboundText: outbound,
      evidence,
    });
    assert.equal(verdict.status, 'fail', key);
    assert.ok(verdict.escapes.includes(key), key);
  }
});

test('a tool error is unobserved execution, never a pass or a denial', () => {
  const errored = classifyWrapperRun({
    exchange: {
      qualified: 'exec',
      callType: 'custom_tool_call',
      answered: true,
      outputText: 'unsupported custom tool call: exec',
    },
    outboundText: '',
    evidence: WRAPPER_EVIDENCE,
  });
  assert.equal(errored.status, 'unobserved');
  assert.equal(errored.jsExecuted, false);
  assert.equal(errored.reason, 'tool-error');
  const absent = classifyWrapperRun({
    exchange: undefined,
    outboundText: '',
    evidence: WRAPPER_EVIDENCE,
  });
  assert.equal(absent.status, 'unobserved');
  assert.equal(absent.reason, 'no-exchange');
});

test('exec absent from the surface is unavailable, which is a distinct verdict from a tool error', () => {
  const verdict = classifyWrapperRun({
    exchange: {
      qualified: 'exec',
      callType: 'custom_tool_call',
      answered: true,
      outputText: 'unsupported custom tool call: exec',
    },
    outboundText: '',
    evidence: WRAPPER_EVIDENCE,
    wrapperAdvertised: false,
  });
  assert.equal(verdict.status, 'unavailable');
  assert.equal(verdict.reason, 'wrapper-not-advertised');
});

test('JS that ran without the browser control is blocked, not passing', () => {
  const verdict = classifyWrapperRun({
    exchange: execExchange(
      probePayload({ 'browser-call': { ok: false, e: 'tool not found' } }),
    ),
    outboundText: '',
    evidence: { ...WRAPPER_EVIDENCE, hostToolCallsDuringExec: 0 },
  });
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.positiveControl, false);
});

test('non-string typeof results for escape primitives count as exposure, not denial', () => {
  const verdict = classifyWrapperRun({
    exchange: execExchange(
      probePayload({ 'typeof-process': { ok: true, v: 'object' } }),
    ),
    outboundText: '',
    evidence: WRAPPER_EVIDENCE,
  });
  assert.equal(verdict.status, 'fail');
  assert.deepEqual(verdict.exposedPrimitives, ['typeof-process']);
  assert.deepEqual(
    verdict.escapes,
    [],
    'exposure alone is not an observed escape',
  );
});

test('notify classification needs a live control, suppression and an unaffected pool', () => {
  assert.equal(
    classifyNotify({ baseline: 1, suppressed: 0, after: 1 }).status,
    'pass',
  );
  assert.equal(
    classifyNotify({ baseline: 1, suppressed: 1, after: 1 }).status,
    'fail',
  );
  assert.equal(
    classifyNotify({ baseline: 0, suppressed: 0, after: 0 }).status,
    'blocked',
  );
  const leaked = classifyNotify({ baseline: 1, suppressed: 0, after: 0 });
  assert.equal(leaked.status, 'fail');
  assert.match(leaked.reason, /pool|later thread/i);
  assert.equal(
    classifyNotify({ baseline: null, suppressed: 0, after: 1 }).status,
    'unobserved',
  );
});

test('context signals distinguish last-request context from billed totals and keep the threshold', () => {
  const events = [
    {
      total: { totalTokens: 100_000, inputTokens: 100_000 },
      last: { totalTokens: 100_000, inputTokens: 100_000 },
      modelContextWindow: 258_400,
    },
    {
      total: { totalTokens: 224_000, inputTokens: 224_000 },
      last: { totalTokens: 124_000, inputTokens: 124_000 },
      modelContextWindow: 258_400,
    },
    {
      total: { totalTokens: 350_000, inputTokens: 350_000 },
      last: { totalTokens: 126_000, inputTokens: 126_000 },
      modelContextWindow: 258_400,
    },
  ];
  const result = classifyContextSignals(events, { threshold: 125_000 });
  assert.equal(result.eventCount, 3);
  assert.equal(result.threshold, 125_000);
  assert.equal(result.firstContextCrossing.index, 2);
  assert.equal(result.firstContextCrossing.lastInputTokens, 126_000);
  assert.equal(
    result.firstBilledTotalCrossing.index,
    1,
    'cumulative billed totals cross earlier and must not be mistaken for context',
  );
  assert.equal(result.modelContextWindow, 258_400);
  assert.equal(result.synthetic, true);
  assert.match(result.note, /scripted|synthetic/i);
});

test('context signals report no crossing and absent events explicitly', () => {
  assert.equal(
    classifyContextSignals([], { threshold: 125_000 }).status,
    'unobserved',
  );
  const low = classifyContextSignals(
    [
      {
        total: { inputTokens: 5 },
        last: { inputTokens: 5 },
        modelContextWindow: 10,
      },
    ],
    { threshold: 125_000 },
  );
  assert.equal(low.status, 'measured');
  assert.equal(low.firstContextCrossing, null);
});
