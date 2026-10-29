import assert from 'node:assert/strict';
import test from 'node:test';
import { EPOCH_LIMITS, budgetFit, recommendGuard } from '../guard-math.mjs';
import {
  aggregateStatuses,
  classifyRecords,
  evaluateAcrossWindows,
} from '../phase-classifier.mjs';
import {
  classifyInputItem,
  growthSeries,
  isGenerationRecord,
  summarizeResponsesRequest,
  toolSurface,
  withEffectiveBytes,
} from '../request-breakdown.mjs';
import {
  analyzeWindow,
  compareToolSurface,
  globalAgentsTable,
  harnessOverhead,
} from '../window-analysis.mjs';

function responsesRecord(seq, body, extra = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    seq,
    kind: 'http',
    surface: 'openai-responses',
    method: 'POST',
    path: '/v1/responses',
    prompt: 'full',
    complete: true,
    incomplete: [],
    parse: 'ok',
    json: body,
    byteLength: raw.length,
    rawBase64: raw.toString('base64'),
    previousSeq: null,
    ...extra,
  };
}
const userPrompt = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '[Canopy-Cbap0-e1-aa] hello' }],
};
const agentsItem = (token) => ({
  type: 'message',
  role: 'user',
  content: [
    {
      type: 'input_text',
      text: `# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\n${token}\n</INSTRUCTIONS>`,
    },
  ],
});
const call = {
  type: 'function_call',
  name: 'observe',
  call_id: 'c1',
  arguments: '{}',
};
const output = (n) => ({
  type: 'function_call_output',
  call_id: 'c1',
  output: 'x'.repeat(n),
});
const tools = [
  { type: 'function', name: 'observe' },
  { type: 'function', name: 'finish' },
];

test('input items are classified; global AGENTS is found by header or canary token', () => {
  assert.equal(classifyInputItem(agentsItem('T')), 'global_agents');
  assert.equal(
    classifyInputItem(
      { type: 'message', role: 'user', content: 'plain AGENTS' },
      { agentsTokens: [] },
    ),
    'user_other',
  );
  assert.equal(
    classifyInputItem(
      { type: 'message', role: 'user', content: 'has TOKEN9 inside' },
      { agentsTokens: ['TOKEN9'] },
    ),
    'global_agents',
  );
  assert.equal(classifyInputItem(userPrompt), 'user_prompt');
  assert.equal(classifyInputItem(call), 'tool_call');
  assert.equal(classifyInputItem(output(3)), 'tool_output');
  assert.equal(classifyInputItem({ type: 'reasoning' }), 'reasoning');
});

test('request summary breaks down instructions, tools, global item and tool outputs', () => {
  const body = {
    model: 'm',
    instructions: 'base prompt',
    tools,
    input: [agentsItem('T1'), userPrompt, call, output(1000)],
  };
  const summary = summarizeResponsesRequest(responsesRecord(1, body));
  assert.equal(summary.parsed, true);
  assert.equal(summary.instructionsBytes, 'base prompt'.length);
  assert.equal(summary.toolCount, 2);
  assert.deepEqual(summary.toolNames, ['observe', 'finish']);
  assert.ok(summary.classBytes.tool_output > 1000);
  assert.equal(summary.globalAgents.present, true);
  assert.ok(summary.globalAgents.bytes > 30);
  assert.ok(summary.otherFieldBytes >= 0);
  assert.equal(
    summary.instructionsBytes +
      summary.toolsBytes +
      summary.inputBytes +
      summary.otherFieldBytes,
    summary.totalBytes,
  );
  assert.equal(
    summarizeResponsesRequest({ seq: 2, parse: 'truncated', byteLength: 9 })
      .parsed,
    false,
  );
  assert.deepEqual(
    toolSurface({
      tools: [{ type: 'namespace', name: 'ns', tools: [{ name: 'a' }] }],
    }),
    ['ns.a'],
  );
  assert.ok(isGenerationRecord(responsesRecord(1, {})));
  assert.equal(
    isGenerationRecord(responsesRecord(1, {}, { prompt: 'prewarm' })),
    false,
  );
});

test('delta requests are reconstructed approximately and unresolved deltas are flagged', () => {
  const full = summarizeResponsesRequest(
    responsesRecord(1, { tools, input: [userPrompt] }),
  );
  const delta = summarizeResponsesRequest(
    responsesRecord(
      2,
      { previous_response_id: 'resp_1', input: [output(500)] },
      { prompt: 'delta', previousSeq: 1 },
    ),
  );
  const orphan = summarizeResponsesRequest(
    responsesRecord(
      3,
      { previous_response_id: 'resp_x', input: [output(10)] },
      { prompt: 'delta', previousSeq: null },
    ),
  );
  assert.equal(delta.isDelta, true);
  const series = withEffectiveBytes(
    [full, delta, orphan],
    new Map([
      [1, null],
      [2, 1],
      [3, null],
    ]),
  );
  assert.equal(series[0].effective, 'exact');
  assert.equal(series[1].effective, 'approximate-delta-reconstruction');
  assert.equal(series[1].effectiveBytes, full.totalBytes + delta.inputBytes);
  assert.equal(series[2].effective, 'unresolved-delta');
  assert.equal(series[2].effectiveBytes, null);
  const growth = growthSeries(series);
  assert.equal(growth[1].addedBytes, delta.inputBytes);
  assert.equal(growth[2].addedBytes, null);
});

test('phase classifier labels first request, later requests, non-generation records and completion', () => {
  const gen = (seq) => responsesRecord(seq, {});
  const models = {
    seq: 1,
    kind: 'http',
    surface: 'models',
    method: 'GET',
    path: '/v1/models',
    prompt: 'none',
  };
  const phases = classifyRecords(
    [
      models,
      gen(2),
      gen(3),
      {
        seq: 4,
        kind: 'http',
        surface: null,
        method: 'GET',
        path: '/x',
        prompt: 'none',
      },
      gen(5),
      gen(6),
    ],
    { completionSeq: 5 },
  );
  assert.deepEqual(
    [...phases],
    [
      [1, 'before-inference'],
      [2, 'before-inference'],
      [3, 'after-tools'],
      [4, 'after-tools'],
      [5, 'after-tools'],
      [6, 'completion'],
    ],
  );
  assert.deepEqual(
    [
      ...classifyRecords([gen(1), gen(2)], {
        singlePhase: 'launch-failure',
      }).values(),
    ],
    ['launch-failure', 'launch-failure'],
  );
});

test('aggregate statuses are worst-of and empty phases are never a vacuous pass', () => {
  assert.equal(aggregateStatuses(['pass', 'blocked', 'pass']), 'blocked');
  assert.equal(aggregateStatuses(['pass', 'fail', 'blocked']), 'fail');
  assert.equal(aggregateStatuses([]), 'unobserved');
  const snapshot = { records: [{ seq: 1 }] };
  const windows = [
    { label: 'w', snapshot, phases: new Map([[1, 'before-inference']]) },
  ];
  assert.equal(
    evaluateAcrossWindows(windows, 'completion', () => ({
      status: 'pass',
      hits: [],
      detail: '',
    })).status,
    'unobserved',
  );
  assert.equal(
    evaluateAcrossWindows(windows, 'before-inference', () => ({
      status: 'pass',
      hits: [],
      detail: '',
    })).status,
    'pass',
  );
  assert.equal(
    evaluateAcrossWindows(windows, 'before-inference', () => ({
      status: 'fail',
      hits: [{ seq: 1, locations: ['raw'], prompt: 'full' }],
      detail: 'hit',
    })).status,
    'fail',
  );
});

test('window analysis locates content per request and compares tool surfaces', () => {
  const records = [
    responsesRecord(1, {
      tools,
      input: [agentsItem('ORIG_TOKEN_1'), userPrompt],
    }),
    responsesRecord(2, {
      tools,
      input: [agentsItem('REPL_TOKEN_2'), userPrompt, call, output(200)],
    }),
  ];
  const snapshot = { records };
  const analysis = analyzeWindow(snapshot, {
    completionSeq: 2,
    agentsTokens: ['ORIG_TOKEN_1', 'REPL_TOKEN_2'],
    contentTokens: { orig: 'ORIG_TOKEN_1', repl: 'REPL_TOKEN_2' },
  });
  assert.deepEqual(
    analysis.summaries.map((s) => s.phase),
    ['before-inference', 'after-tools'],
  );
  const table = globalAgentsTable(analysis.summaries);
  assert.deepEqual(
    table.map((row) => [row.carries.orig, row.carries.repl]),
    [
      [true, false],
      [false, true],
    ],
  );
  assert.ok(table.every((row) => row.globalAgentsBytes > 0));
  assert.ok(harnessOverhead(analysis.summaries[0]).harnessBytes > 0);
  assert.deepEqual(compareToolSurface(['a', 'b', 'shell'], ['a', 'b']), {
    equal: false,
    extra: ['shell'],
    missing: [],
    actualCount: 3,
  });
  assert.equal(compareToolSurface(['b', 'a'], ['a', 'b']).equal, true);
});

test('guard math shows both byte/token ratios and stays unresolved when one page does not fit', () => {
  const fit3 = budgetFit({
    baselineBytes: 20_000,
    observationBytes: 19_000,
    receiptStepBytes: 500,
    bytesPerToken: 3,
  });
  assert.equal(fit3.budgetBytes, 48_000);
  assert.equal(fit3.maxObservationsInContext, 1);
  assert.equal(
    budgetFit({
      baselineBytes: 20_000,
      observationBytes: 19_000,
      receiptStepBytes: 500,
      bytesPerToken: 4,
    }).maxObservationsInContext,
    2,
  );
  const ok = recommendGuard({
    baselineBytes: 20_000,
    observationBytes: 19_000,
    receiptStepBytes: 500,
  });
  assert.equal(ok.status, 'measured');
  assert.equal(ok.fits.length, 2);
  assert.equal(
    ok.perPageObservationGuard,
    1,
    'the conservative (3 bytes/token) fit wins',
  );
  assert.ok(
    ok.epochActionCap <= EPOCH_LIMITS.actions &&
      ok.epochRequestCap <= EPOCH_LIMITS.requests,
  );
  const tooBig = recommendGuard({
    baselineBytes: 45_000,
    observationBytes: 19_000,
    receiptStepBytes: 500,
  });
  assert.equal(tooBig.status, 'unresolved');
  assert.match(tooBig.reason, /even one observation/);
  assert.equal(
    recommendGuard({
      baselineBytes: NaN,
      observationBytes: 1,
      receiptStepBytes: 1,
    }).status,
    'unresolved',
  );
});

test('advertised tool census includes pinned additional_tools input items', () => {
  const request = {
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ type: 'custom', name: 'exec' }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(toolSurface(request), ['functions.exec']);
});
