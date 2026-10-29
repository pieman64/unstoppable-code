// End-to-end test of the analysis layer against REAL capture snapshots: the
// shared capture listener (loopback only) receives fabricated Anthropic
// request bodies. No provider process is started.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CANARY_CATALOG,
  canariesFor,
  createCanarySet,
} from '../../shared/canaries.mjs';
import { evaluateCanary, startCapture } from '../../shared/capture.mjs';
import { STATUS, createLedger } from '../../shared/ledger.mjs';
import { deriveBrowserToolSchemas } from '../../shared/tool-schemas.mjs';
import { analyze } from '../analysis.mjs';
import { REQUESTED_MODEL } from '../probe-env.mjs';
import {
  PROBE_SYSTEM_PROMPT,
  ROTATION_LOOP,
  probeUserPrompt,
  scenarioKey,
} from '../scripts.mjs';

const BROWSER = deriveBrowserToolSchemas().map(
  (entry) => `mcp__browser__${entry.name}`,
);
const toolDefs = (names = BROWSER) =>
  names.map((name) => ({
    name,
    description: `d ${name}`,
    input_schema: { type: 'object', properties: {} },
  }));
const obs = (sentinel, step) =>
  JSON.stringify({ page: sentinel, step, pad: 'x'.repeat(19_000) });

let counter = 0;
const assistantTurn = (name, text = 'step') => {
  counter += 1;
  return {
    id: `toolu_${counter}`,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        { type: 'tool_use', id: `toolu_${counter}`, name, input: {} },
      ],
    },
  };
};
const toolResult = (id, text, isError = false) => ({
  role: 'user',
  content: [
    {
      type: 'tool_result',
      tool_use_id: id,
      content: [{ type: 'text', text }],
      ...(isError ? { is_error: true } : {}),
    },
  ],
});

async function post(base, route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.text();
}
const messagesBody = (key, messages, extra = {}) => ({
  model: REQUESTED_MODEL,
  stream: false,
  max_tokens: 1024,
  system: [{ type: 'text', text: PROBE_SYSTEM_PROMPT }],
  tools: toolDefs(),
  messages: [
    { role: 'user', content: [{ type: 'text', text: probeUserPrompt(key) }] },
    ...messages,
  ],
  ...extra,
});

function initFor(cwd, over = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: REQUESTED_MODEL,
    cwd,
    tools: BROWSER,
    skills: [],
    plugins: [],
    mcp_servers: [{ name: 'browser', status: 'connected' }],
    slash_commands: ['compact', 'context'],
    output_style: 'default',
    agents: [],
    apiKeySource: 'ANTHROPIC_API_KEY',
    permissionMode: 'default',
    claude_code_version: '2.1.284',
    ...over,
  };
}
const success = (over = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  usage: { input_tokens: 1200, output_tokens: 24 },
  modelUsage: { [REQUESTED_MODEL]: {} },
  time_to_request_from_spawn_ms: 700,
  duration_ms: 1500,
  ...over,
});

function variantShell(id, label, key, cwd, over = {}) {
  return {
    id,
    label,
    key,
    cwd,
    isolated: id !== 'A',
    optionsSummary: {},
    recorderDelta: {},
    keychainAttempts: 0,
    denials: [],
    gatewayEvents: [],
    cwdBefore: [],
    cwdAfter: [],
    driven: {
      init: initFor(cwd),
      result: success(),
      error: null,
      timeline: {
        startedAtMs: 0,
        spawnObservedAtMs: 120,
        initAtMs: 600,
        firstAssistantAtMs: 1400,
        resultAtMs: 1500,
        closedAtMs: 1700,
      },
      processes: [],
      messageCounts: {},
      systemMessages: [],
      stderrTail: '',
    },
    arrivals: Array.from({ length: 30 }, (_, index) => ({
      index: index + 1,
      atMs: 800 + index * 50,
    })),
    ...over,
  };
}

/** Send one loop to the capture listener; returns the variant snapshot. */
async function loop(
  capture,
  key,
  sentinel,
  steps,
  { injectInto = {}, extraPostsAfter = [] } = {},
) {
  capture.capture.reset();
  counter = 0; // the mock reuses deterministic tool_use ids across launches
  const history = [];
  await post(capture.baseUrl, '/v1/messages', messagesBody(key, history));
  let index = 0;
  for (const name of steps) {
    index += 1;
    const turn = assistantTurn(name, `Step ${index}.`);
    const big = ['observe', 'read_text', 'scroll'].includes(
      name.replace('mcp__browser__', ''),
    );
    history.push(
      turn.message,
      toolResult(
        turn.id,
        big ? obs(sentinel, index) : '{"ok":true}',
        name === 'Bash',
      ),
    );
    const extra = injectInto[index];
    if (extra)
      history[history.length - 1].content.push({
        type: 'text',
        text: typeof extra === 'function' ? extra() : extra,
      });
    await post(capture.baseUrl, '/v1/messages', messagesBody(key, history));
  }
  const snapshot = capture.capture.snapshot();
  const resultSeq = snapshot.records
    .filter((record) => record.surface === 'anthropic-messages')
    .at(-1).seq;
  for (const extra of extraPostsAfter)
    await post(capture.baseUrl, extra.route, extra.body);
  const finalSnapshot = capture.capture.snapshot();
  capture.capture.reset();
  return { snapshot: finalSnapshot, resultSeq };
}

async function scenario({ leaks = {} } = {}) {
  const capture = await startCapture();
  try {
    const canaries = createCanarySet();
    const catalog = canariesFor('claude');
    const fixtures = catalog.map((entry) => ({
      id: entry.id,
      live:
        entry.id === 'hostEnvironment' || entry.id === 'hostFile'
          ? { notRequired: true }
          : entry.id === 'plugin'
            ? { init: { field: 'plugins', includes: 'bap0-plugin' } }
            : entry.id === 'hook'
              ? { recorder: ['hook-stop'] }
              : { request: true },
      paths: [],
    }));
    const variants = {};

    // A: positive control carries every instruction canary except plugin (not live) and the host ones.
    capture.capture.reset();
    const controlKey = scenarioKey('control');
    const controlText = [
      'userInstructions',
      'ancestorInstructions',
      'projectInstructions',
      'projectOverrideInstructions',
      'settings',
      'skillUser',
      'skillAgentsDir',
      'outputStyle',
      'memory',
      'mcpUserConfig',
    ]
      .map((id) => canaries[id])
      .join(' ');
    await post(
      capture.baseUrl,
      '/v1/messages',
      messagesBody(controlKey, [], { system: `default preset ${controlText}` }),
    );
    const controlSnapshot = capture.capture.snapshot();
    capture.capture.reset();
    variants.A = variantShell('A', 'control', controlKey, '/p', {
      snapshot: controlSnapshot,
      recorderDelta: { 'hook-stop': 1 },
      resultSeq: controlSnapshot.records.at(-1).seq,
    });

    const keyB = scenarioKey('isolated');
    const b = await loop(
      capture,
      keyB,
      'BAP0_PAGE_E11_aaaaaaaaaaaa',
      ['mcp__browser__observe', 'Bash'],
      {
        extraPostsAfter: [
          { route: '/v1/messages/count_tokens', body: { messages: [] } },
        ],
      },
    );
    variants.B = variantShell('B', 'isolated', keyB, '/epochs/iso-b', {
      ...b,
      sentinel: 'BAP0_PAGE_E11_aaaaaaaaaaaa',
    });
    const keyC = scenarioKey('mdsoff');
    const c = await loop(capture, keyC, 'BAP0_PAGE_E12_bbbbbbbbbbbb', [
      'mcp__browser__observe',
      'Bash',
    ]);
    variants.C = variantShell(
      'C',
      'isolated + MDS off',
      keyC,
      '/epochs/iso-c',
      { ...c, sentinel: 'BAP0_PAGE_E12_bbbbbbbbbbbb' },
    );

    const sentinels = [1, 2, 3].map(
      (epoch) => `BAP0_PAGE_E${epoch}_${String(epoch).repeat(12)}`,
    );
    for (const epoch of [1, 2, 3]) {
      const key = scenarioKey(`epoch${epoch}`);
      const steps = ROTATION_LOOP.map((name) => `mcp__browser__${name}`);
      const lazy = Object.fromEntries(
        Object.entries(leaks[epoch] ?? {}).map(([step, value]) => [
          step,
          typeof value === 'function' ? () => value(canaries) : value,
        ]),
      );
      const { snapshot, resultSeq } = await loop(
        capture,
        key,
        sentinels[epoch - 1],
        steps,
        { injectInto: lazy },
      );
      variants[`D${epoch}`] = variantShell(
        `D${epoch}`,
        `epoch ${epoch}`,
        key,
        `/epochs/rot-e${epoch}`,
        {
          snapshot,
          resultSeq,
          sentinel: sentinels[epoch - 1],
          gatewayEvents: ROTATION_LOOP.map((tool) => ({ tool, valid: true })),
          driven: {
            ...variantShell('x', 'x', key, '/x').driven,
            result: success({ num_turns: 7 }),
          },
        },
      );
      variants[`D${epoch}`].driven.init = initFor(`/epochs/rot-e${epoch}`);
    }

    const keyE = scenarioKey('failure');
    capture.capture.reset();
    await post(capture.baseUrl, '/v1/messages', messagesBody(keyE, []));
    const failureSnapshot = capture.capture.snapshot();
    capture.capture.reset();
    variants.E = variantShell('E', 'failure', keyE, '/epochs/fail-e', {
      snapshot: failureSnapshot,
      driven: {
        ...variantShell('x', 'x', keyE, '/x').driven,
        init: initFor('/epochs/fail-e'),
        result: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          api_error_status: 400,
        },
      },
    });

    const keyF = scenarioKey('budget');
    const f = await loop(capture, keyF, 'BAP0_PAGE_E15_ffffffffffff', [
      'mcp__browser__observe',
      'mcp__browser__observe',
      'mcp__browser__observe',
    ]);
    variants.F = variantShell('F', 'budget hook', keyF, '/epochs/budget-f', {
      ...f,
      sentinel: 'BAP0_PAGE_E15_ffffffffffff',
      hookLog: [{ batch: 1 }, { batch: 2 }, { batch: 3 }],
      stoppedAtBatch: 3,
    });
    // F above produced 4 requests; the hook would have stopped after batch 3 (3 requests), so model it as a violation.
    return { capture, canaries, catalog, fixtures, variants };
  } catch (error) {
    await capture.close();
    throw error;
  }
}

async function run(options) {
  const setup = await scenario(options);
  try {
    const ledger = createLedger('claude');
    const managedPolicy = [
      {
        path: '/Library/Application Support/ClaudeCode/CLAUDE.md',
        exists: false,
        error: 'ENOENT',
      },
    ];
    const analysis = analyze({
      ledger,
      STATUS,
      evaluate: evaluateCanary,
      catalog: setup.catalog,
      tokens: setup.canaries,
      fixtures: setup.fixtures,
      expectedToolNames: BROWSER,
      variants: setup.variants,
      managedPolicy,
      requestedModel: REQUESTED_MODEL,
      hookEvents: ['PreToolUse', 'PostToolBatch'],
      extra: { schemaOverhead: { totalDefinitionBytes: 1000 } },
    });
    const entries = ledger.entries();
    const get = (id, phase) =>
      entries.filter((entry) => entry.id === id && entry.phase === phase);
    return { ledger, analysis, entries, get, setup };
  } finally {
    await setup.capture.close();
  }
}

test('clean isolated launches: absence passes where the fixture is live, blocks where it is not', async () => {
  const { get, analysis } = await run();
  const status = (id, phase) => get(id, phase).at(-1)?.status;
  assert.equal(status('canary.userInstructions', 'before-inference'), 'pass');
  assert.equal(status('canary.projectInstructions', 'after-tools'), 'pass');
  assert.equal(
    status('canary.plugin', 'before-inference'),
    'blocked',
    'plugin was not live in the control',
  );
  assert.match(
    JSON.stringify(get('canary.plugin', 'before-inference').at(-1).evidence),
    /not live in the positive control/,
  );
  assert.equal(status('canary.hostEnvironment', 'before-inference'), 'pass');
  assert.equal(
    status('canary.userInstructions', 'completion'),
    'pass',
    'B sent a count_tokens after the result',
  );
  assert.equal(status('canary.userInstructions', 'launch-failure'), 'pass');
  // The control is labelled and never counted as isolation evidence.
  assert.equal(
    get('canary.userInstructions', 'before-inference')[0].status,
    'measured',
  );
  assert.match(
    get('canary.userInstructions', 'before-inference')[0].evidence.variant,
    /positive control/,
  );
  assert.equal(analysis.liveness.plugin.live, false);
  assert.equal(analysis.liveness.userInstructions.live, true);
  // Aggregate: blocked plugin keeps the aggregate blocked, never pass.
  assert.equal(
    status('close.only-accepted-source', 'before-inference'),
    'blocked',
  );
  assert.equal(status('close.claude-md-user', 'before-inference'), 'pass');
});

test('managed CLAUDE.md and org-managed results can never pass', async () => {
  const { get } = await run();
  assert.equal(
    get('close.claude-md-managed', 'before-inference').at(-1).status,
    'blocked',
  );
  assert.match(
    get('close.claude-md-managed', 'before-inference').at(-1).evidence.reason,
    /requires host edit/,
  );
  assert.equal(get('close.org-managed', 'launch').at(-1).status, 'blocked');
  assert.equal(
    get('close.claude-md-managed', 'before-inference').at(-1).evidence
      .managedFileExistsOnHost,
    false,
  );
});

test('structural requirements: tools, init, between-tool, rotation, disable-mds', async () => {
  const { get } = await run();
  assert.equal(
    get('close.claude-tools-empty', 'before-inference').at(-1).status,
    'pass',
  );
  assert.equal(
    get('close.claude-tools-empty', 'before-inference').at(-1).evidence
      .scriptedBashAttemptResult.isError,
    true,
  );
  assert.equal(
    get('launch.tool-surface', 'before-inference').at(-1).status,
    'pass',
  );
  assert.equal(get('launch.tool-surface', 'after-tools').at(-1).status, 'pass');
  assert.equal(get('launch.claude-init', 'launch').at(-1).status, 'pass');
  assert.equal(
    get('close.claude-between-tool', 'after-tools').at(-1).status,
    'pass',
  );
  assert.equal(get('rotation.old-canary-absent', 'run').at(-1).status, 'pass');
  assert.equal(get('rotation.no-resume', 'run').at(-1).status, 'pass');
  assert.equal(
    get('rotation.repeated-tools', 'after-tools').at(-1).status,
    'pass',
  );
  const mds = get('close.claude-disable-mds', 'before-inference').at(-1);
  assert.equal(mds.status, 'measured');
  assert.equal(mds.evidence.identical, true);
  assert.equal(
    get('canonical.no-model-fallback', 'launch').at(-1).status,
    'pass',
  );
  assert.equal(get('launch.empty-cwd', 'launch').at(-1).status, 'pass');
  // The failure was induced (HTTP 400), but the not-live plugin fixture keeps absence unproven.
  const failure = get('phase.launch-failure', 'launch-failure').at(-1);
  assert.equal(failure.status, 'blocked');
  assert.equal(failure.evidence.apiErrorStatus, 400);
  assert.equal(failure.evidence.modelRequests, 1);
});

test('S0.2 figures are measured, labelled synthetic, and the guard is explicit', async () => {
  const { get, analysis } = await run();
  assert.equal(get('s02.session-start', 'run').at(-1).status, 'measured');
  assert.match(
    get('s02.session-start', 'run').at(-1).evidence.label,
    /not release performance/,
  );
  const growth = get('s02.page-growth', 'run').at(-1).evidence;
  assert.equal(growth.perEpochTotalBytes.length, 3);
  assert.ok(growth.observationGrowth.median > 15_000);
  const accounting = get('s02.token-accounting', 'run').at(-1).evidence;
  assert.equal(accounting.mockUsageSynthetic.synthetic, true);
  assert.equal(accounting.countTokensSynthetic[0].synthetic, true);
  assert.equal(accounting.byteEstimates.estimate, true);
  const guard = get('s02.guard-recommendation', 'run').at(-1);
  assert.ok(['measured', 'unresolved'].includes(guard.status));
  assert.equal(analysis.s02.guard.basis.synthetic, true);
  assert.equal(
    analysis.s02.perEpoch[0].requests[0].tokenEstimate.estimate,
    true,
  );
  const budget = get('budget.pre-request', 'run').at(-1);
  assert.equal(budget.status, 'unresolved');
  assert.equal(
    budget.evidence.experimentF.stopEnforcedBeforeNextRequest,
    false,
    'F fabricated 4 requests after a stop at batch 3',
  );
  assert.match(budget.evidence.neededForConservativeBound, /PostToolBatch/);
});

test('an injected reminder carrying an instruction canary fails the source, the aggregate and between-tool', async () => {
  const { get } = await run({
    leaks: {
      2: {
        2: (canaries) =>
          `<system-reminder>${canaries.projectInstructions}</system-reminder>`,
      },
    },
  });
  const between = get('close.claude-between-tool', 'after-tools').at(-1);
  assert.equal(between.status, 'fail');
  assert.deepEqual(between.evidence.offending[0].extraCanaries, [
    'projectInstructions',
  ]);
  assert.ok(between.evidence.extraBytesTotal > 0);
  assert.equal(
    get('canary.projectInstructions', 'after-tools').at(-1).status,
    'fail',
  );
  assert.equal(
    get('close.only-accepted-source', 'after-tools').at(-1).status,
    'fail',
  );
});

test('an old-epoch sentinel reaching a later epoch fails rotation', async () => {
  const leak = 'BAP0_PAGE_E1_111111111111';
  const { get } = await run({ leaks: { 2: { 2: `carried over ${leak}` } } });
  assert.equal(get('rotation.old-canary-absent', 'run').at(-1).status, 'fail');
});

test('catalog coverage: every claude canary has an entry for every phase', async () => {
  const { entries } = await run();
  for (const entry of canariesFor('claude'))
    for (const phase of [
      'before-inference',
      'after-tools',
      'completion',
      'launch-failure',
    ])
      assert.ok(
        entries.some(
          (item) => item.id === `canary.${entry.id}` && item.phase === phase,
        ),
        `${entry.id} ${phase}`,
      );
  assert.ok(CANARY_CATALOG.length > 0);
});
