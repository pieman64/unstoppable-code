import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateVariants,
  evaluatePhase,
  worstStatus,
} from '../canary-eval.mjs';
import {
  compareToolSet,
  evaluateBetweenTool,
  evaluateDisableMds,
  evaluateInit,
  evaluateLaunchFailure,
  evaluateRotation,
  evaluateToolSurface,
  evaluateToolsEmpty,
  findUnavailableToolResult,
} from '../evaluators.mjs';

const EXPECTED = ['mcp__browser__observe', 'mcp__browser__finish'];
const body = (tools) => ({ tools: tools.map((name) => ({ name })) });

test('tool set comparison finds extras, missing and forbidden built-ins', () => {
  assert.equal(compareToolSet(EXPECTED, EXPECTED).exact, true);
  const leaky = compareToolSet([...EXPECTED, 'ToolSearch', 'Bash'], EXPECTED);
  assert.deepEqual(leaky.extra, ['ToolSearch', 'Bash']);
  assert.deepEqual(leaky.forbiddenPresent, ['ToolSearch']);
  assert.deepEqual(
    compareToolSet(['mcp__browser__observe'], EXPECTED).missing,
    ['mcp__browser__finish'],
  );
});

test('tools-empty fails when ToolSearch, Agent, Task or Skill appear anywhere', () => {
  const clean = evaluateToolsEmpty({
    initTools: EXPECTED,
    requestBodies: [body(EXPECTED)],
    expectedTools: EXPECTED,
  });
  assert.equal(clean.status, 'pass');
  const inRequest = evaluateToolsEmpty({
    initTools: EXPECTED,
    requestBodies: [body(EXPECTED), body([...EXPECTED, 'Skill'])],
    expectedTools: EXPECTED,
  });
  assert.deepEqual([inRequest.status, inRequest.leaked], ['fail', ['Skill']]);
  const inInit = evaluateToolsEmpty({
    initTools: [...EXPECTED, 'Agent'],
    requestBodies: [body(EXPECTED)],
    expectedTools: EXPECTED,
  });
  assert.equal(inInit.status, 'fail');
  assert.equal(
    evaluateToolsEmpty({
      initTools: null,
      requestBodies: [],
      expectedTools: EXPECTED,
    }).status,
    'unobserved',
  );
  const other = evaluateToolsEmpty({
    initTools: EXPECTED,
    requestBodies: [body([...EXPECTED, 'ListMcpResourcesTool'])],
    expectedTools: EXPECTED,
  });
  assert.equal(other.status, 'pass');
  assert.deepEqual(other.requestExtra, ['ListMcpResourcesTool']);
  assert.equal(
    evaluateToolSurface({
      initTools: EXPECTED,
      requestBodies: [body([...EXPECTED, 'ListMcpResourcesTool'])],
      expectedTools: EXPECTED,
    }).status,
    'fail',
  );
  assert.equal(
    evaluateToolSurface({
      initTools: EXPECTED,
      requestBodies: [body(EXPECTED)],
      expectedTools: EXPECTED,
    }).status,
    'pass',
  );
});

const goodInit = {
  tools: EXPECTED,
  skills: [],
  plugins: [],
  mcp_servers: [{ name: 'browser', status: 'connected' }],
  output_style: 'default',
  cwd: '/e/1',
  slash_commands: ['compact'],
  agents: [],
  session_id: 's',
  model: 'm',
  apiKeySource: 'ANTHROPIC_API_KEY',
};

test('init evaluation: minimal and fixture-free or fail with the field named', () => {
  const ok = evaluateInit(goodInit, { expectedTools: EXPECTED, cwd: '/e/1' });
  assert.equal(ok.status, 'pass');
  assert.equal(ok.fields.slashCommandsNonEmpty, true);
  for (const [field, patch] of [
    ['skills', { skills: ['bap0-skill-user'] }],
    ['plugins', { plugins: [{ name: 'p', path: '/p' }] }],
    ['mcp_servers', { mcp_servers: [{ name: 'browser' }, { name: 'other' }] }],
    ['output_style', { output_style: 'bap0-style' }],
    ['tools', { tools: [...EXPECTED, 'Bash'] }],
    ['cwd', { cwd: '/elsewhere' }],
  ]) {
    const bad = evaluateInit(
      { ...goodInit, ...patch },
      { expectedTools: EXPECTED, cwd: '/e/1' },
    );
    assert.equal(bad.status, 'fail', field);
    assert.ok(
      bad.problems.some((problem) => problem.field === field),
      field,
    );
  }
  assert.equal(
    evaluateInit(null, { expectedTools: EXPECTED }).status,
    'unobserved',
  );
});

test('unavailable native tool attempt is found in the next request history', () => {
  const bodies = [
    {
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'b1',
              is_error: true,
              content: [{ type: 'text', text: 'No such tool available: Bash' }],
            },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(findUnavailableToolResult(bodies), {
    isError: true,
    preview: 'No such tool available: Bash',
  });
  assert.equal(findUnavailableToolResult([{ messages: [] }]), null);
});

test('between-tool evaluation fails on any injected block', () => {
  const clean = {
    shapeOk: true,
    prefixStable: true,
    systemChanged: false,
    toolsChanged: false,
    extras: [],
    extraBytes: 0,
    extraCanaries: [],
    addedMessageCount: 2,
  };
  assert.equal(
    evaluateBetweenTool([{ epoch: 1, diffs: [clean, clean] }]).status,
    'pass',
  );
  const dirty = {
    ...clean,
    shapeOk: false,
    extras: [{ bytes: 99, blockType: 'text' }],
    extraBytes: 99,
    extraCanaries: ['settings'],
  };
  const failed = evaluateBetweenTool([{ epoch: 1, diffs: [clean, dirty] }]);
  assert.equal(failed.status, 'fail');
  assert.equal(failed.offending[0].pair, 2);
  assert.equal(failed.extraBytesTotal, 99);
  assert.equal(
    evaluateBetweenTool([{ epoch: 1, diffs: [] }]).status,
    'unobserved',
  );
  assert.equal(
    evaluateBetweenTool([
      { epoch: 1, diffs: [{ ...clean, systemChanged: true }] },
    ]).status,
    'fail',
  );
});

test('disable-mds: measured effect, fail when an instruction canary survives the flag', () => {
  const same = {
    compared: 1,
    identical: true,
    perRequest: [{ systemByteDelta: 0, messageByteDelta: 0 }],
  };
  assert.equal(
    evaluateDisableMds({ comparison: same, instructionHitsWithFlag: 0 }).status,
    'measured',
  );
  assert.match(
    evaluateDisableMds({ comparison: same, instructionHitsWithFlag: 0 }).effect,
    /no observable difference/,
  );
  const differs = {
    compared: 1,
    identical: false,
    perRequest: [{ systemByteDelta: -10, messageByteDelta: -500 }],
  };
  assert.match(
    evaluateDisableMds({ comparison: differs, instructionHitsWithFlag: 0 })
      .effect,
    /differs/,
  );
  assert.equal(
    evaluateDisableMds({ comparison: same, instructionHitsWithFlag: 1 }).status,
    'fail',
  );
  assert.equal(
    evaluateDisableMds({ comparison: null, instructionHitsWithFlag: 0 }).status,
    'unobserved',
  );
});

function epochFacts(overrides = {}) {
  const loop = [
    'observe',
    'read_text',
    'scroll',
    'observe',
    'record_progress',
    'finish',
  ];
  return [1, 2, 3].map((epoch) => ({
    epoch,
    sessionId: `s${epoch}`,
    sentinel: `S${epoch}`,
    firstRequestMessageCount: 1,
    oldCanary: Object.fromEntries(
      [...Array(epoch - 1).keys()].map((index) => [
        `epoch${index + 1}`,
        'pass',
      ]),
    ),
    sentinelInToolResults: true,
    toolsExecuted: loop,
    resultOk: true,
    ...(overrides[epoch] ?? {}),
  }));
}

test('rotation: distinct sessions, absent old sentinels and a complete loop pass', () => {
  const result = evaluateRotation(epochFacts());
  assert.equal(result.oldCanaryAbsent.status, 'pass');
  assert.equal(result.noResume.status, 'pass');
  assert.equal(result.repeatedTools.status, 'pass');
});

test('rotation failures', () => {
  assert.equal(
    evaluateRotation(
      epochFacts({ 3: { oldCanary: { epoch1: 'pass', epoch2: 'fail' } } }),
    ).oldCanaryAbsent.status,
    'fail',
  );
  assert.equal(
    evaluateRotation(epochFacts({ 2: { sentinelInToolResults: false } }))
      .oldCanaryAbsent.status,
    'blocked',
  );
  assert.equal(
    evaluateRotation(epochFacts({ 2: { sessionId: 's1' } })).noResume.status,
    'fail',
  );
  assert.equal(
    evaluateRotation(epochFacts({ 2: { firstRequestMessageCount: 5 } }))
      .noResume.status,
    'fail',
  );
  assert.equal(
    evaluateRotation(epochFacts(), { resumeOptionUsed: true }).noResume.status,
    'fail',
  );
  assert.equal(
    evaluateRotation(epochFacts({ 1: { toolsExecuted: ['observe'] } }))
      .repeatedTools.status,
    'fail',
  );
  assert.equal(
    evaluateRotation(epochFacts({ 3: { resultOk: false } })).repeatedTools
      .status,
    'fail',
  );
  assert.equal(evaluateRotation([]).oldCanaryAbsent.status, 'unobserved');
});

test('launch failure must actually fail before canary results count', () => {
  assert.equal(
    evaluateLaunchFailure({
      result: { subtype: 'success', is_error: false },
      error: null,
      requestCount: 1,
      statuses: ['pass'],
    }).status,
    'blocked',
  );
  assert.equal(
    evaluateLaunchFailure({
      result: {
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 400,
      },
      error: null,
      requestCount: 1,
      statuses: ['pass', 'pass'],
    }).status,
    'pass',
  );
  assert.equal(
    evaluateLaunchFailure({
      result: null,
      error: { message: 'x' },
      requestCount: 0,
      statuses: ['unobserved'],
    }).status,
    'unobserved',
  );
  assert.equal(
    evaluateLaunchFailure({
      result: null,
      error: { message: 'x' },
      requestCount: 1,
      statuses: ['pass', 'fail'],
    }).status,
    'fail',
  );
});

test('phase evaluation: empty phases prove nothing, non-live fixtures cannot pass', () => {
  const snapshot = { records: [{ seq: 1 }, { seq: 2 }] };
  const phases = new Map([
    [1, 'before-inference'],
    [2, 'after-tools'],
  ]);
  const pass = () => ({ status: 'pass', hits: [], detail: 'absent' });
  assert.equal(
    evaluatePhase({
      snapshot,
      phases,
      phase: 'completion',
      token: 'T',
      expected: 'absent',
      evaluate: pass,
      live: { live: true },
    }).status,
    'unobserved',
  );
  assert.equal(
    evaluatePhase({
      snapshot,
      phases,
      phase: 'after-tools',
      token: 'T',
      expected: 'absent',
      evaluate: pass,
      live: { live: true },
    }).status,
    'pass',
  );
  const blocked = evaluatePhase({
    snapshot,
    phases,
    phase: 'after-tools',
    token: 'T',
    expected: 'absent',
    evaluate: pass,
    live: { live: false, basis: 'x' },
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.detail, /not live/);
  const seen = [];
  evaluatePhase({
    snapshot,
    phases,
    phase: 'after-tools',
    token: 'T',
    expected: 'absent',
    evaluate: (snap, token, expected, filter) => {
      seen.push(snap.records.filter(filter).map((record) => record.seq));
      return pass();
    },
  });
  assert.deepEqual(seen, [[2]]);
  const fail = evaluatePhase({
    snapshot,
    phases,
    phase: 'before-inference',
    token: 'T',
    expected: 'absent',
    evaluate: () => ({ status: 'fail', hits: [{ seq: 1 }], detail: 'found' }),
    live: { live: false },
  });
  assert.equal(
    fail.status,
    'fail',
    'a hit fails even when the fixture was not live',
  );
});

test('aggregation ignores variants that sent nothing in a phase; worst status wins', () => {
  assert.equal(worstStatus(['pass', 'blocked', 'unobserved']), 'blocked');
  assert.equal(worstStatus(['pass', 'fail', 'blocked']), 'fail');
  assert.equal(worstStatus([]), 'unobserved');
  const results = {
    B: { x: { completion: { status: 'unobserved', searched: 0 } } },
    C: {
      x: { completion: { status: 'pass', searched: 1, detail: 'ok', hits: 0 } },
    },
  };
  assert.equal(aggregateVariants(results, 'x', 'completion').status, 'pass');
  assert.equal(
    aggregateVariants({ B: results.B }, 'x', 'completion').status,
    'unobserved',
  );
});
