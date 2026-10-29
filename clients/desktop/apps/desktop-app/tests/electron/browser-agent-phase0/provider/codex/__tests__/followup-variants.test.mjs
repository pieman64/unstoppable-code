import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { BROWSER_AGENT_TOOL_NAMES } from '../../shared/tool-schemas.mjs';
import { CUSTOM_INPUT_KEY } from '../custom-call-rewriter.mjs';
import {
  ARM_IDS,
  BROWSER_NAMESPACE,
  DIRECT_MODEL,
  HELPER_TOGGLE_FEATURES,
  armAllowedTools,
  armDefinition,
  armScenario,
  armThreadParams,
  wrapperProbeSource,
} from '../followup-variants.mjs';
import {
  WRAPPER_PROBE_KEYS,
  classifyWrapperRun,
} from '../followup-analysis.mjs';
import { browserThreadParams, codingThreadParams } from '../thread-params.mjs';

const INPUT = {
  epochDir: '/tmp/e',
  project: '/tmp/p',
  baseUrl: 'http://127.0.0.1:1',
  ambientMcpServerNames: ['bap0_mcp'],
};

const baseline = () => armThreadParams('baseline', INPUT);

test('there are at most seven arms, in a fixed order, each with a definition', () => {
  assert.deepEqual(ARM_IDS, [
    'baseline',
    'notify-empty',
    'coding-control-after',
    'direct-model',
    'namespaced-direct',
    'toggles-context',
    'ns-feature-config',
  ]);
  assert.ok(ARM_IDS.length <= 7);
  for (const id of ARM_IDS) assert.equal(armDefinition(id).id, id);
  assert.throws(() => armDefinition('nope'));
});

test('baseline is exactly the existing production-shaped browser launch', () => {
  assert.deepEqual(
    baseline(),
    browserThreadParams({
      epochDir: INPUT.epochDir,
      baseUrl: INPUT.baseUrl,
      ambientMcpServerNames: INPUT.ambientMcpServerNames,
    }),
  );
});

test('coding control is the existing coding launch with no browser overrides', () => {
  assert.deepEqual(
    armThreadParams('coding-control-after', INPUT),
    codingThreadParams({ project: INPUT.project, baseUrl: INPUT.baseUrl }),
  );
});

test('each variant changes only its intended thread-scoped keys', () => {
  const base = baseline();
  const strip = (params, ...keys) => {
    const copy = structuredClone(params);
    for (const key of keys) {
      const path = key.split('.');
      let node = copy;
      for (const part of path.slice(0, -1)) node = node[part];
      delete node[path.at(-1)];
    }
    return copy;
  };

  const empty = armThreadParams('notify-empty', INPUT);
  assert.deepEqual(empty.config.notify, []);
  assert.deepEqual(strip(empty, 'config.notify'), base);

  const direct = armThreadParams('direct-model', INPUT);
  assert.equal(direct.model, DIRECT_MODEL);
  assert.deepEqual({ ...direct, model: base.model }, base);

  const ns = armThreadParams('namespaced-direct', INPUT);
  assert.deepEqual(ns.config.code_mode, {
    direct_only_tool_namespaces: [BROWSER_NAMESPACE],
  });
  assert.equal(ns.dynamicTools.length, 1);
  assert.equal(ns.dynamicTools[0].type, 'namespace');
  assert.equal(ns.dynamicTools[0].name, BROWSER_NAMESPACE);
  assert.deepEqual(
    ns.dynamicTools[0].tools.map((tool) => tool.name),
    [...BROWSER_AGENT_TOOL_NAMES],
  );
  assert.ok(ns.dynamicTools[0].tools.every((tool) => tool.type === 'function'));
  assert.deepEqual(
    strip(ns, 'config.code_mode', 'dynamicTools'),
    strip(base, 'dynamicTools'),
  );

  const toggles = armThreadParams('toggles-context', INPUT);
  for (const feature of HELPER_TOGGLE_FEATURES)
    assert.equal(toggles.config.features[feature], false, feature);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(toggles.config.features).filter(
        ([name]) => !HELPER_TOGGLE_FEATURES.includes(name),
      ),
    ),
    base.config.features,
  );
  assert.deepEqual(
    strip(toggles, 'config.features'),
    strip(base, 'config.features'),
  );
});

test('every arm keeps the loopback provider, no model fallback, no ambient MCP and ephemeral threads', () => {
  for (const id of ARM_IDS) {
    const params = armThreadParams(id, INPUT);
    assert.equal(params.modelProvider, 'probe', id);
    assert.equal(params.allowProviderModelFallback, false, id);
    assert.equal(params.ephemeral, true, id);
    assert.equal(
      params.config.model_providers.probe.base_url,
      `${INPUT.baseUrl}/v1`,
      id,
    );
    if (id !== 'coding-control-after') {
      assert.equal(params.config.mcp_servers.bap0_mcp.enabled, false, id);
      assert.equal(params.config.features.shell_tool, false, id);
    }
  }
});

test('documented feature-table contrast uses the current official key without replacing the binary-inferred arm', () => {
  const original = armThreadParams('namespaced-direct', INPUT);
  const documented = armThreadParams('ns-feature-config', INPUT);
  assert.deepEqual(documented.dynamicTools, original.dynamicTools);
  assert.equal('code_mode' in documented.config, false);
  assert.deepEqual(documented.config.features.code_mode, {
    enabled: true,
    direct_only_tool_namespaces: [BROWSER_NAMESPACE],
  });
  assert.ok(ARM_IDS.includes('ns-feature-config'));
});

test('host policy allows exactly the browser tools in the namespace the arm declares', () => {
  const flat = armAllowedTools('baseline');
  assert.deepEqual(
    flat.map((entry) => entry.tool),
    [...BROWSER_AGENT_TOOL_NAMES],
  );
  assert.ok(flat.every((entry) => entry.namespace === null));
  const scoped = armAllowedTools('namespaced-direct');
  assert.ok(scoped.every((entry) => entry.namespace === BROWSER_NAMESPACE));
  assert.equal(scoped.length, BROWSER_AGENT_TOOL_NAMES.length);
  assert.deepEqual(armAllowedTools('coding-control-after'), []);
});

test('browser scenarios script a direct call, the wait collision call, then the exec attempt last', () => {
  for (const id of [
    'baseline',
    'notify-empty',
    'direct-model',
    'namespaced-direct',
    'toggles-context',
  ]) {
    const { llm } = armScenario(id, { wrapperSource: 'text("x")' });
    assert.equal(llm.openAiStepCursor, 'completed-scenario-tool-calls', id);
    const calls = llm.steps.flatMap((step) => step.toolCalls ?? []);
    assert.deepEqual(
      calls.map((call) => call.name),
      ['observe', 'wait', 'exec'],
      id,
    );
    const namespace = armDefinition(id).namespace;
    assert.equal(calls[0].namespace ?? null, namespace, id);
    assert.equal(calls[1].namespace ?? null, namespace, id);
    assert.equal(
      calls[2].namespace ?? null,
      null,
      'exec is never namespaced by the script',
    );
    assert.deepEqual(calls[2].input, { [CUSTOM_INPUT_KEY]: 'text("x")' });
    assert.equal(llm.steps.at(-1).stopReason, 'end_turn');
    assert.deepEqual(calls[1].input, {
      until: { kind: 'duration', milliseconds: 100 },
    });
  }
  const coding = armScenario('coding-control-after', {});
  assert.deepEqual(
    coding.llm.steps.map((step) => step.toolCalls ?? null),
    [null],
  );
});

test('the context arm scripts a synthetic usage ramp that crosses the 125k checkpoint on the last request only', () => {
  const { llm } = armScenario('toggles-context', {
    wrapperSource: 'text("x")',
  });
  const inputs = llm.steps.map((step) => step.usage?.inputTokens ?? null);
  assert.ok(inputs.every((value) => value !== null));
  assert.deepEqual(
    [...inputs].sort((a, b) => a - b),
    inputs,
    'monotonic',
  );
  const crossing = inputs.findIndex((value) => value >= 125_000);
  assert.equal(crossing, inputs.length - 1);
  assert.ok(inputs.at(-2) < 125_000 && inputs.at(-2) > 100_000);
  const plain = armScenario('baseline', { wrapperSource: 'text("x")' });
  assert.ok(plain.llm.steps.every((step) => step.usage === undefined));
});

const PROBE_PATHS = {
  hostFile: '/tmp/synthetic/home/Documents/private-notes.txt',
  envName: 'BAP0_HOST_ENV_CANARY',
  spawnMarker: '/tmp/synthetic/records/spawn-marker',
  loopbackUrl: 'http://127.0.0.1:9/escape',
};

test('the wrapper probe source reports every probe key and embeds only synthetic targets', () => {
  const source = wrapperProbeSource(PROBE_PATHS);
  for (const key of WRAPPER_PROBE_KEYS)
    assert.ok(source.includes(`'${key}'`), `probe key ${key}`);
  assert.ok(source.includes('BAP0_PROBE_JSON:'));
  for (const value of Object.values(PROBE_PATHS))
    assert.ok(source.includes(JSON.stringify(value)), value);
  assert.ok(!/api[_-]?key|bearer|authorization/i.test(source));
});

function runProbe({ extras = {}, tools = {}, names } = {}) {
  const texts = [];
  const source = wrapperProbeSource(PROBE_PATHS);
  const allTools = (names ?? Object.keys(tools)).map((name) => ({
    name,
    description: '',
  }));
  const sandbox = {
    text: (value) => texts.push(String(value)),
    ALL_TOOLS: allTools,
    tools,
    ...extras,
  };
  const run = runInNewContext(`(async () => {\n${source}\n})()`, sandbox);
  return run.then(() => texts.join('\n'));
}

test('inside an isolate with no host globals every escape is denied and the browser control runs', async () => {
  let observed = 0;
  const output = await runProbe({
    tools: {
      observe: async () => {
        observed += 1;
        return { observationId: 'obs-1' };
      },
    },
  });
  assert.equal(observed, 1);
  const verdict = classifyWrapperRun({
    exchange: {
      answered: true,
      callType: 'custom_tool_call',
      outputText: output,
    },
    outboundText: '',
    evidence: {
      hostCanary: 'H',
      envCanary: 'E',
      spawnMarkerExists: false,
      loopbackHits: 0,
      hostToolCallsDuringExec: observed,
    },
  });
  assert.equal(verdict.status, 'pass', JSON.stringify(verdict));
  assert.deepEqual(verdict.exposedPrimitives, []);
});

test('the same source is flagged as exposure when the isolate hands out process/require', async () => {
  let read = 0;
  const output = await runProbe({
    extras: {
      process: { env: { [PROBE_PATHS.envName]: 'SECRETVALUE' } },
      require: (name) => {
        if (name === 'node:fs' || name === 'fs')
          return {
            readFileSync: () => {
              read += 1;
              return 'Private host note HOSTCANARY';
            },
          };
        throw new Error(`blocked ${name}`);
      },
    },
    tools: { observe: async () => ({ observationId: 'obs-1' }) },
  });
  assert.ok(read >= 1);
  const verdict = classifyWrapperRun({
    exchange: {
      answered: true,
      callType: 'custom_tool_call',
      outputText: output,
    },
    outboundText: '',
    evidence: {
      hostCanary: 'HOSTCANARY',
      envCanary: 'SECRETVALUE',
      spawnMarkerExists: false,
      loopbackHits: 0,
      hostToolCallsDuringExec: 1,
    },
  });
  assert.equal(verdict.status, 'fail');
  assert.ok(verdict.escapes.includes('host-file-read'));
  assert.ok(verdict.escapes.includes('env-read'));
  assert.ok(verdict.exposedPrimitives.includes('typeof-require'));
});

test('namespaced tools are located through ALL_TOOLS by flat identifier or dotted path', async () => {
  for (const [name, tools] of [
    ['bap0_browser__observe', { bap0_browser__observe: null }],
    ['bap0_browser.observe', { bap0_browser: { observe: null } }],
  ]) {
    let observed = 0;
    const call = async () => {
      observed += 1;
      return { observationId: 'o' };
    };
    if (name.includes('__')) tools.bap0_browser__observe = call;
    else tools.bap0_browser.observe = call;
    const output = await runProbe({ tools, names: [name, 'wait'] });
    assert.equal(observed, 1, name);
    assert.match(output, /"browser-call":\{"ok":true/);
  }
});

test('with no matching tool the browser control fails visibly instead of inventing a call', async () => {
  const output = await runProbe({ tools: {}, names: ['something_else'] });
  assert.match(output, /"browser-call":\{"ok":false/);
  assert.match(output, /observe not in ALL_TOOLS/);
});
