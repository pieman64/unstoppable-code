// Unit tests for the October 2 follow-up helpers. No provider binary, no
// credential and no external network is involved.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONTEXT_CHECKPOINT_TOKENS,
  SYNTHETIC_OAUTH_TOKEN,
} from '../../shared/followup-policy.mjs';
import {
  createAuthObserver,
  startAuthObservedCapture,
} from '../auth-listener.mjs';
import {
  ARM_BY_ID,
  BROWSER_LOOP,
  FOLLOWUP_ARMS,
  TOOL_LOOP_ARM_IDS,
  armEnvironmentParams,
  armOptions,
  armSteps,
  armVerifyParams,
  contextLoopSteps,
  followupLoopSteps,
} from '../followup-arms.mjs';
import {
  billedUsage,
  callableEvidence,
  evaluateAuth,
  evaluateContextSignals,
  evaluateMemoryMatrix,
  evaluateMemoryFlagPair,
  evaluateSourceCanaries,
  evaluateToolLoop,
  initInventory,
} from '../followup-analysis.mjs';
import {
  FORBIDDEN_ISOLATED_OPTIONS,
  assertNoBareMode,
  isolatedDeviations,
  isolatedOptions,
} from '../launch-options.mjs';
import {
  BARE_MODE_ENV_NAMES,
  FOLLOWUP_EXTRA_ENV_NAMES,
  buildProviderEnvironment,
  loadProductionSeams,
  verifyProviderEnvironment,
} from '../probe-env.mjs';
import { driveQuery } from '../query-driver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:45001';
const PROXY = 'http://127.0.0.1:45002';

async function layoutFor() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'bap0-fu-test-')),
  );
  return {
    root,
    home: path.join(root, 'home'),
    claudeHomeDir: path.join(root, 'home', '.claude'),
    claudeConfigDir: path.join(root, 'claude-config'),
    tmp: path.join(root, 'tmp'),
  };
}

async function buildFor(armId, override = {}) {
  const arm = ARM_BY_ID[armId];
  const seams = await loadProductionSeams();
  const layout = await layoutFor();
  const built = buildProviderEnvironment({
    seams,
    layout,
    baseUrl: BASE,
    proxyUrl: PROXY,
    shimDir: path.join(layout.root, 'shim-bin'),
    claudeTmpDir: path.join(layout.tmp, 'claude-code-tmp'),
    ...armEnvironmentParams(arm),
    ...override,
  });
  const verify = (mutate = () => {}, verifyOverride = {}) => {
    const withoutProxy = { ...built.envWithoutProxy };
    mutate(withoutProxy);
    const env = {
      ...withoutProxy,
      HTTPS_PROXY: PROXY,
      HTTP_PROXY: PROXY,
      https_proxy: PROXY,
      http_proxy: PROXY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    };
    return verifyProviderEnvironment({
      env,
      envWithoutProxy: withoutProxy,
      layout,
      baseUrl: BASE,
      proxyUrl: PROXY,
      hostEnv: {},
      ...armVerifyParams(arm),
      ...verifyOverride,
    });
  };
  return { arm, layout, ...built, verify };
}

test('every arm environment verifies, and its memory flag matches the arm', async () => {
  for (const arm of FOLLOWUP_ARMS) {
    const built = await buildFor(arm.id);
    const result = built.verify();
    assert.equal(
      result.ok,
      true,
      `${arm.id}: ${JSON.stringify(result.checks.filter((c) => !c.ok))}`,
    );
    assert.equal(
      built.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      arm.memoryFlag === 'kept' ? '1' : undefined,
      arm.id,
    );
  }
});

test('the production-equivalent arm keeps DISABLE_AUTO_MEMORY=1 and the removal arm still removes it', async () => {
  const production = await buildFor('I-prod');
  assert.deepEqual(production.delta.keptFromProductionBuilder, [
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  ]);
  assert.deepEqual(production.delta.removedFromProductionBuilder, []);
  const removal = await buildFor('U-mem');
  assert.deepEqual(removal.delta.removedFromProductionBuilder, [
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  ]);
  assert.equal(
    removal.verify(undefined, { expectAutoMemoryDisabled: true }).ok,
    false,
    'the flag expectation is enforced',
  );
  assert.equal(
    production.verify((e) => delete e.CLAUDE_CODE_DISABLE_AUTO_MEMORY).ok,
    false,
  );
});

test('default (first-run) environment behavior is unchanged: the flag is removed and not allowlisted', async () => {
  const seams = await loadProductionSeams();
  const layout = await layoutFor();
  const built = buildProviderEnvironment({
    seams,
    layout,
    baseUrl: BASE,
    proxyUrl: PROXY,
    shimDir: path.join(layout.root, 'shim-bin'),
    claudeTmpDir: path.join(layout.tmp, 'claude-code-tmp'),
  });
  assert.equal('CLAUDE_CODE_DISABLE_AUTO_MEMORY' in built.env, false);
  assert.equal(built.delta.credentialMode, 'api-key');
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in built.env, false);
});

test('production-shaped OAuth: oauthToken only, no base URL, no API key; placeholder predicate enforced', async () => {
  const built = await buildFor('O-init');
  assert.equal(built.env.CLAUDE_CODE_OAUTH_TOKEN, SYNTHETIC_OAUTH_TOKEN);
  for (const name of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ])
    assert.equal(name in built.env, false, name);
  assert.equal(built.verify().ok, true);
  assert.equal(
    built.verify((e) => (e.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-looks-real'))
      .ok,
    false,
  );
  assert.equal(
    built.verify((e) => (e.ANTHROPIC_BASE_URL = BASE)).ok,
    false,
    'a base URL breaks the production shape',
  );
  assert.equal(
    built.verify(
      (e) => (e.ANTHROPIC_API_KEY = 'bap0-placeholder-not-a-credential'),
    ).ok,
    false,
  );
  assert.equal(
    built.verify((e) => (e.CLAUDE_CODE_SIMPLE = '1')).ok,
    false,
    'SIMPLE mode skips OAuth credentials',
  );
  assert.deepEqual(BARE_MODE_ENV_NAMES, ['CLAUDE_CODE_SIMPLE']);
  assert.equal(
    built.verify((e) => (e.GITHUB_TOKEN = 'ghp_xxxxxxxxxx')).ok,
    false,
  );
});

test('loopback OAuth arm adds only the loopback base URL and is labelled non-production', async () => {
  const built = await buildFor('O-loop');
  assert.equal(built.env.ANTHROPIC_BASE_URL, BASE);
  assert.equal(built.env.CLAUDE_CODE_OAUTH_TOKEN, SYNTHETIC_OAUTH_TOKEN);
  assert.equal('ANTHROPIC_API_KEY' in built.env, false);
  assert.equal(built.verify().ok, true);
  assert.equal(
    built.verify((e) => (e.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'))
      .ok,
    false,
  );
  assert.match(ARM_BY_ID['O-loop'].label, /NON-production/);
});

test('targeted controls arrive as explicit environment values and unknown extras are refused', async () => {
  const built = await buildFor('I-targeted');
  assert.equal(built.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, '1');
  assert.equal(built.env.CLAUDE_CODE_DISABLE_ATTACHMENTS, '1');
  assert.equal(built.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(built.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(
    built.verify((e) => delete e.ENABLE_CLAUDEAI_MCP_SERVERS).ok,
    false,
  );
  await assert.rejects(
    buildFor('I-prod', { extraEnv: { SOME_OTHER_VARIABLE: '1' } }),
    /not an admitted extra/,
  );
  await assert.rejects(
    buildFor('I-prod', { credentialMode: 'nope' }),
    /Unknown credential mode/,
  );
  assert.ok(
    FOLLOWUP_EXTRA_ENV_NAMES.includes('CLAUDE_CODE_DISABLE_AUTO_MEMORY'),
  );
});

const gateway = {
  server: { name: 'browser' },
  allowedTools: ['mcp__browser__observe', 'mcp__browser__finish'],
};

test('option deviations are exactly the documented ones and the explicit browser MCP survives every arm', () => {
  const expectations = {
    'I-prod': [],
    'I-removed': [],
    'I-safe': ['extraArgs'],
    'I-targeted': ['settings', 'extraArgs'],
    'O-init': [],
    'O-loop': [],
    'O-safe-init': ['extraArgs'],
    'O-safe-loop': ['extraArgs'],
    'I-context': [],
  };
  for (const [id, expected] of Object.entries(expectations)) {
    const options = armOptions(ARM_BY_ID[id], { gateway, denials: [] });
    assert.deepEqual(
      isolatedDeviations(options).sort(),
      [...expected].sort(),
      id,
    );
    assert.deepEqual(Object.keys(options.mcpServers), ['browser'], id);
    assert.equal(options.strictMcpConfig, true, id);
    assert.deepEqual(options.tools, [], id);
    assert.ok(!('hooks' in options), `${id} passes no SDK hooks`);
  }
  const safe = armOptions(ARM_BY_ID['I-safe'], { gateway, denials: [] });
  assert.deepEqual(safe.extraArgs, { 'safe-mode': null });
  const targeted = armOptions(ARM_BY_ID['I-targeted'], {
    gateway,
    denials: [],
  });
  assert.deepEqual(targeted.settings, { disableAllHooks: true });
  assert.deepEqual(targeted.extraArgs, { 'disable-slash-commands': null });
  assert.ok(FORBIDDEN_ISOLATED_OPTIONS.includes('extraArgs'));
});

test('unrestricted arms are the positive-control options, not an isolated launch', () => {
  for (const id of ['U-mem', 'U-flag']) {
    const options = armOptions(ARM_BY_ID[id], { denials: [] });
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.equal(options.systemPrompt.preset, 'claude_code');
    assert.equal('tools' in options, false);
  }
});

test('bare and SIMPLE mode are refused for every arm, never an authentication workaround', () => {
  assert.throws(() => assertNoBareMode({ extraArgs: { bare: null } }), /OAuth/);
  assert.throws(
    () => assertNoBareMode({ extraArgs: { '--bare': null } }),
    /OAuth/,
  );
  assert.throws(
    () => assertNoBareMode({}, { CLAUDE_CODE_SIMPLE: '1' }),
    /OAuth/,
  );
  assert.equal(
    assertNoBareMode({ extraArgs: { 'safe-mode': null } }, {}),
    true,
  );
  const mutated = {
    ...isolatedOptions({ gateway, denials: [] }),
    extraArgs: { bare: null },
  };
  assert.throws(() => assertNoBareMode(mutated));
  for (const arm of FOLLOWUP_ARMS)
    assert.doesNotThrow(
      () => armOptions(arm, { gateway, denials: [] }),
      arm.id,
    );
});

test('neither memory control is inert: roles, flags and options differ in exactly one factor', () => {
  const byId = ARM_BY_ID;
  assert.equal(byId['U-mem'].role, 'positive-control');
  assert.equal(byId['U-mem'].options, 'unrestricted');
  assert.equal(byId['U-mem'].memoryFlag, 'removed');
  assert.equal(byId['U-flag'].options, 'unrestricted');
  assert.equal(byId['U-flag'].memoryFlag, 'kept');
  assert.equal(byId['I-removed'].options, 'flag-removed');
  assert.equal(byId['I-removed'].memoryFlag, 'removed');
  assert.equal(byId['I-prod'].options, 'production');
  assert.equal(byId['I-prod'].memoryFlag, 'kept');
  assert.equal(
    new Set(FOLLOWUP_ARMS.map((arm) => arm.id)).size,
    FOLLOWUP_ARMS.length,
  );
  for (const arm of FOLLOWUP_ARMS) assert.ok(arm.timeoutMs <= 45_000, arm.id);
});

test('credential arms: production-shaped init-only never scripts a model; loopback arm is the labelled delta', () => {
  const init = ARM_BY_ID['O-init'];
  assert.equal(init.credential, 'oauth-init');
  assert.equal(init.initOnly, true);
  assert.equal(armSteps(init), null);
  assert.equal(ARM_BY_ID['O-loop'].credential, 'oauth-loopback');
  assert.ok(
    FOLLOWUP_ARMS.filter((arm) => arm.credential === 'api-key').length >= 6,
  );
});

test('scripted loops validate against the derived schemas; context usage crosses the 125k checkpoint', () => {
  assert.deepEqual(
    BROWSER_LOOP.map(([name]) => name),
    ['observe', 'click', 'observe', 'finish'],
  );
  assert.equal(followupLoopSteps().length, BROWSER_LOOP.length + 1);
  const steps = contextLoopSteps();
  const inputs = steps.map((step) => step.usage?.inputTokens).filter(Boolean);
  assert.ok(inputs.some((value) => value < CONTEXT_CHECKPOINT_TOKENS));
  assert.ok(inputs.some((value) => value > CONTEXT_CHECKPOINT_TOKENS));
  assert.equal(CONTEXT_CHECKPOINT_TOKENS, 125_000);
  assert.deepEqual(
    [...TOOL_LOOP_ARM_IDS].sort(),
    [
      'I-context',
      'I-prod',
      'I-removed',
      'I-safe',
      'I-targeted',
      'O-loop',
      'O-safe-loop',
    ].sort(),
  );
});

// ── Auth listener ───────────────────────────────────────────────────────────
test('the auth observer keeps booleans only: no header value, token substring or length', () => {
  const observer = createAuthObserver({ max: 3 });
  observer.observe({
    method: 'POST',
    url: '/v1/messages?secret=abc',
    headers: { authorization: `Bearer ${SYNTHETIC_OAUTH_TOKEN}` },
  });
  observer.observe({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer something-else-entirely' },
  });
  observer.observe({
    method: 'GET',
    url: '/v1/models',
    headers: { 'x-api-key': 'bap0-placeholder-not-a-credential' },
  });
  observer.observe({ method: 'GET', url: '/dropped', headers: {} });
  const text = JSON.stringify(observer.snapshot());
  assert.ok(!text.includes(SYNTHETIC_OAUTH_TOKEN));
  assert.ok(!text.includes('something-else-entirely'));
  assert.ok(!text.includes('secret=abc'), 'no query string is retained');
  assert.deepEqual(observer.summarize(), {
    total: 4,
    retained: 3,
    dropped: 1,
    bearer: 2,
    syntheticOAuth: 1,
    apiKey: 1,
    syntheticApiKey: 1,
    unexpectedBearer: 1,
  });
  observer.reset();
  assert.equal(observer.summarize().total, 0);
});

test('the observed capture listener classifies a real loopback request and still captures it', async () => {
  const listener = await startAuthObservedCapture();
  try {
    await new Promise((resolve, reject) => {
      const request = http.request(
        `${listener.baseUrl}/v1/models`,
        { headers: { authorization: `Bearer ${SYNTHETIC_OAUTH_TOKEN}` } },
        (response) => {
          response.resume();
          response.once('end', resolve);
        },
      );
      request.once('error', reject);
      request.end();
    });
    const summary = listener.auth.summarize();
    assert.equal(summary.total, 1);
    assert.equal(summary.syntheticOAuth, 1);
    assert.equal(
      listener.capture.snapshot().counts.received >= 1 ||
        listener.capture.snapshot().records.length >= 1,
      true,
    );
  } finally {
    await listener.close();
  }
});

// ── Analysis ────────────────────────────────────────────────────────────────
const evaluate = (snapshot, token) => ({
  status: 'pass',
  detail: '',
  hits: snapshot.records
    .filter((record) => JSON.stringify(record.json ?? {}).includes(token))
    .map((record) => ({ seq: record.seq })),
});
const messagesRecord = (seq, body, marker = 'm') => ({
  seq,
  surface: 'anthropic-messages',
  method: 'POST',
  parse: 'ok',
  json: body,
  marker,
  byteLength: JSON.stringify(body).length,
});
const arm = (id, records, extra = {}) => ({
  id,
  key: 'm',
  snapshot: { records },
  ...extra,
});

test('memory matrix: an inert positive control blocks every absence; a live one makes each row meaningful', () => {
  const clean = [
    messagesRecord(1, { messages: [{ role: 'user', content: 'hi' }] }),
  ];
  const live = [
    messagesRecord(1, { messages: [{ role: 'user', content: 'MEMTOKEN' }] }),
  ];
  const inert = evaluateMemoryMatrix({
    arms: {
      'U-mem': arm('U-mem', clean),
      'U-flag': arm('U-flag', clean),
      'I-removed': arm('I-removed', clean),
      'I-prod': arm('I-prod', clean),
    },
    token: 'MEMTOKEN',
    evaluate,
  });
  assert.equal(inert.controlLive, false);
  assert.equal(inert.rows['U-mem'].status, 'blocked');
  assert.equal(inert.rows['I-prod'].status, 'blocked');
  const good = evaluateMemoryMatrix({
    arms: {
      'U-mem': arm('U-mem', live),
      'U-flag': arm('U-flag', clean),
      'I-removed': arm('I-removed', clean),
      'I-prod': arm('I-prod', clean),
    },
    token: 'MEMTOKEN',
    evaluate,
  });
  assert.equal(good.controlLive, true);
  assert.equal(good.status, 'pass');
  const flagFails = evaluateMemoryMatrix({
    arms: {
      'U-mem': arm('U-mem', live),
      'U-flag': arm('U-flag', live),
      'I-removed': arm('I-removed', clean),
      'I-prod': arm('I-prod', clean),
    },
    token: 'MEMTOKEN',
    evaluate,
  });
  assert.equal(flagFails.rows['U-flag'].status, 'fail');
  assert.equal(flagFails.rows['I-prod'].status, 'pass');
  assert.equal(flagFails.status, 'fail');
  const missing = evaluateMemoryMatrix({
    arms: { 'U-mem': arm('U-mem', live) },
    token: 'MEMTOKEN',
    evaluate,
  });
  assert.equal(missing.rows['I-prod'].status, 'unobserved');
});

test('source canaries: absence of a dead fixture is blocked, a hit fails', () => {
  const tokens = { settings: 'SET', plugin: 'PLG' };
  const result = evaluateSourceCanaries({
    arm: arm('I-prod', [messagesRecord(1, { x: 'PLG' })]),
    tokens,
    evaluate,
    liveness: {
      settings: { live: false, basis: 'not observed' },
      plugin: { live: true, basis: 'x' },
    },
    ids: ['settings', 'plugin'],
  });
  assert.equal(result.settings.status, 'blocked');
  assert.equal(result.plugin.hits, 1);
  assert.equal(
    evaluateSourceCanaries({ arm: null, tokens, evaluate, ids: ['settings'] })
      .settings.status,
    'unobserved',
  );
});

test('source exclusion cannot pass an init-only arm with no outbound records', () => {
  const result = evaluateSourceCanaries({
    arm: arm('O-init', []),
    tokens: { settings: 'SET' },
    evaluate,
    liveness: { settings: { live: true, basis: 'control' } },
    ids: ['settings'],
  });
  assert.equal(result.settings.status, 'unobserved');
});

test('paired isolated memory launches prove the flag effect independently of the unrestricted preset', () => {
  const live = [
    messagesRecord(1, { messages: [{ role: 'user', content: 'MEMTOKEN' }] }),
  ];
  const clean = [
    messagesRecord(1, { messages: [{ role: 'user', content: 'hi' }] }),
  ];
  const pair = (removed, kept) =>
    evaluateMemoryFlagPair({
      arms: {
        'I-removed': arm('I-removed', removed),
        'I-prod': arm('I-prod', kept),
      },
      token: 'MEMTOKEN',
      evaluate,
    });
  assert.equal(pair(live, clean).status, 'pass');
  assert.equal(pair(clean, clean).status, 'blocked');
  assert.equal(pair(live, live).status, 'fail');
  assert.equal(pair(live, []).status, 'unobserved');
});

test('browser loop fails when a native tool is advertised alongside a working gateway', () => {
  const data = arm(
    'I-prod',
    [messagesRecord(1, { tools: [{ name: 'Bash' }] })],
    {
      driven: { init: initMessage() },
      gatewayEvents: [{ tool: 'observe', valid: true }],
    },
  );
  assert.equal(
    evaluateToolLoop(data, { expected: ['observe'] }).status,
    'fail',
  );
});

const initMessage = (overrides = {}) => ({
  tools: ['mcp__browser__observe'],
  mcp_servers: [{ name: 'browser', status: 'connected' }],
  skills: [],
  plugins: [],
  slash_commands: [],
  apiKeySource: 'none',
  output_style: 'default',
  ...overrides,
});

test('tool loop: init inventory, request-advertised tools and executed calls are distinct channels', () => {
  const executed = ['observe', 'click', 'observe', 'finish'].map((tool) => ({
    tool,
    valid: true,
  }));
  const good = arm(
    'I-prod',
    [messagesRecord(1, { tools: [{ name: 'mcp__browser__observe' }] })],
    {
      driven: { init: initMessage(), toolUses: ['mcp__browser__observe'] },
      gatewayEvents: executed,
      denials: [],
    },
  );
  const evidence = callableEvidence(good);
  assert.deepEqual(evidence.initTools, ['mcp__browser__observe']);
  assert.deepEqual(evidence.requestAdvertisedTools, ['mcp__browser__observe']);
  assert.deepEqual(evidence.executedGatewayTools, [
    'observe',
    'click',
    'observe',
    'finish',
  ]);
  assert.equal(
    evaluateToolLoop(good, { expected: BROWSER_LOOP.map(([name]) => name) })
      .status,
    'pass',
  );
  const inventoryOnly = arm('I-safe', [], {
    driven: { init: initMessage() },
    gatewayEvents: [],
    denials: [],
  });
  const verdict = evaluateToolLoop(inventoryOnly, { expected: ['observe'] });
  assert.equal(
    verdict.status,
    'fail',
    'an init inventory alone proves nothing was callable',
  );
  const missingServer = arm('I-safe', [], {
    driven: { init: initMessage({ mcp_servers: [] }) },
    gatewayEvents: executed,
    denials: [],
  });
  assert.equal(
    evaluateToolLoop(missingServer, { expected: ['observe'] }).status,
    'fail',
  );
  assert.equal(
    evaluateToolLoop({ skipped: 'time' }, { expected: ['observe'] }).status,
    'unobserved',
  );
  assert.equal(initInventory(null), null);
  assert.match(initInventory(initMessage()).label, /not proof of callability/);
});

test('context signals keep billed usage and context occupancy apart and label scripted plumbing', () => {
  const run = arm('I-context', [messagesRecord(1, {}), messagesRecord(2, {})], {
    scriptedInputTokens: [50_000, 100_000, 126_000],
    driven: {
      contextSamples: [
        {
          label: 'after-assistant-3',
          totalTokens: 126_500,
          maxTokens: 200_000,
          autoCompactThreshold: 167_000,
        },
        { label: 'at-result', error: 'closed' },
      ],
      systemMessages: [],
      result: {
        usage: { input_tokens: 400_000, output_tokens: 900 },
        num_turns: 5,
      },
    },
  });
  const signals = evaluateContextSignals(run);
  assert.equal(signals.status, 'measured');
  assert.equal(signals.checkpoint, 125_000);
  assert.equal(signals.scriptedCrossesCheckpoint, true);
  assert.equal(signals.contextAtOrAboveCheckpoint, true);
  assert.equal(
    signals.billed.inputTokens,
    400_000,
    'billed/cumulative is reported separately',
  );
  assert.match(signals.label, /Scripted values are plumbing only/);
  assert.match(billedUsage(run.driven.result).label, /billed\/cumulative/);
  const none = evaluateContextSignals(
    arm('I-context', [], {
      driven: {
        contextSamples: [{ label: 'x', error: 'unsupported' }],
        systemMessages: [],
      },
    }),
  );
  assert.equal(none.status, 'unobserved');
  assert.equal(evaluateContextSignals(undefined).status, 'unobserved');
});

test('auth evidence: init-only never claims inference or tool calls; loopback is non-production', () => {
  const initOnly = evaluateAuth(
    {
      driven: {
        init: initMessage({ apiKeySource: 'CLAUDE_CODE_OAUTH_TOKEN' }),
      },
      initOnly: true,
      keychainAttempts: 0,
    },
    {
      proxy: { external: 2, byHost: { 'api.anthropic.com:443': { count: 2 } } },
    },
  );
  assert.equal(initOnly.status, 'measured');
  assert.equal(initOnly.inferenceObserved, false);
  assert.equal(initOnly.toolCallsObserved, false);
  assert.deepEqual(initOnly.refusingProxy.hosts, ['api.anthropic.com:443']);
  assert.match(initOnly.label, /real OAuth acceptance is not inferred/);
  const loopback = evaluateAuth(
    { driven: { init: initMessage() } },
    { proxy: { external: 0, byHost: {} }, auth: { syntheticOAuth: 3 } },
  );
  assert.match(loopback.label, /NON-production/);
  assert.equal(evaluateAuth({ skipped: 'blocked' }, {}).status, 'unobserved');
});

// ── Driver additions ────────────────────────────────────────────────────────
function scriptedQuery(messages, { usage } = {}) {
  return () => {
    let closed = false;
    const generator = (async function* () {
      for (const message of messages) {
        if (closed) return;
        yield message;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      while (!closed && messages.hold)
        await new Promise((resolve) => setTimeout(resolve, 5));
    })();
    generator.close = () => {
      closed = true;
    };
    if (usage) generator.getContextUsage = usage;
    return generator;
  };
}

test('driveQuery: stopAfterInit closes a query that would otherwise never finish', async () => {
  const messages = [{ type: 'system', subtype: 'init', session_id: 's' }];
  messages.hold = true;
  const driven = await driveQuery({
    query: scriptedQuery(messages),
    prompt: 'p',
    options: {},
    timeoutMs: 5_000,
    stopAfterInit: { settleMs: 20 },
  });
  assert.equal(driven.timedOut, false);
  assert.equal(driven.init.session_id, 's');
});

test('driveQuery: context samples are summaries, bounded, and tolerate failures', async () => {
  const messages = [
    { type: 'system', subtype: 'init', session_id: 's' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } },
    { type: 'result', subtype: 'success' },
  ];
  let calls = 0;
  const driven = await driveQuery({
    query: scriptedQuery(messages, {
      usage: async () => {
        calls += 1;
        if (calls === 2) throw new Error('closed');
        return {
          totalTokens: 126_000,
          maxTokens: 200_000,
          categories: [
            { name: 'Messages', tokens: 100, kind: 'used' },
            { name: 'Free', tokens: 5, kind: 'free' },
          ],
          autoCompactThreshold: 167_000,
          isAutoCompactEnabled: true,
          gridRows: [[1]],
        };
      },
    }),
    prompt: 'p',
    options: {},
    timeoutMs: 5_000,
    drainMs: 50,
    contextUsage: { afterAssistantMessages: 2 },
  });
  assert.equal(driven.contextSamples.length, 2);
  assert.equal(driven.contextSamples[0].label, 'after-assistant-2');
  assert.equal(driven.contextSamples[0].totalTokens, 126_000);
  assert.deepEqual(driven.contextSamples[0].usedCategories, [
    { name: 'Messages', tokens: 100 },
  ]);
  assert.ok(!('gridRows' in driven.contextSamples[0]));
  assert.match(driven.contextSamples[1].error, /closed/);
  const unsupported = await driveQuery({
    query: scriptedQuery(messages),
    prompt: 'p',
    options: {},
    timeoutMs: 5_000,
    drainMs: 50,
    contextUsage: { afterAssistantMessages: 1 },
  });
  assert.match(unsupported.contextSamples[0].error, /not available/);
});

// ── Entry script containment ────────────────────────────────────────────────
test('followup.mjs reads no credential, keychain or real-home path and uses only allowed imports', async () => {
  const source = await readFile(path.join(here, '..', 'followup.mjs'), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  for (const pattern of [
    /homedir/,
    /find-generic-password/,
    /Library\/Keychains/,
    /\.credentials/,
    /keychain-helper/i,
    /process\.env\.HOME/,
    /os\.userInfo/,
    /apps\/desktop-app/,
    /from\s*'electron'/,
  ])
    assert.ok(!pattern.test(code), `followup.mjs must not match ${pattern}`);
  assert.ok(!/import\(\s*[^'`"\s)]/.test(code), 'no computed dynamic imports');
  const specifiers = [...code.matchAll(/from\s*'([^']+)'/g)].map(
    (match) => match[1],
  );
  for (const specifier of specifiers)
    assert.ok(
      specifier.startsWith('node:') ||
        specifier.startsWith('./') ||
        specifier.startsWith('../shared/') ||
        specifier === '@anthropic-ai/claude-agent-sdk',
      `unexpected import ${specifier}`,
    );
  assert.match(code, /securityd-and-host-keychain-deny/);
  assert.match(code, /manifest\.followUp !== true/);
});

test('every named import in followup.mjs exists in its module (the entry script is never imported)', async () => {
  const file = path.join(here, '..', 'followup.mjs');
  const source = await readFile(file, 'utf8');
  const imports = [
    ...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g),
  ].map((match) => ({
    specifier: match[2],
    names: match[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0])
      .filter(Boolean),
  }));
  assert.ok(imports.length >= 18, `parsed ${imports.length} imports`);
  for (const { specifier, names } of imports) {
    const target = specifier.startsWith('.')
      ? pathToFileURL(path.resolve(path.dirname(file), specifier)).href
      : specifier;
    const mod = await import(target);
    for (const name of names)
      assert.ok(name in mod, `${specifier} does not export ${name}`);
  }
});
