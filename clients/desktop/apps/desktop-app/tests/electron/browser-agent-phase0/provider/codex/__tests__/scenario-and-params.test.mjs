import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_AGENT_TOOL_NAMES } from '../../shared/tool-schemas.mjs';
import {
  EPOCH_TOOL_SCRIPT,
  browserLoopScenario,
  createEpochToolHost,
  failureScenario,
  markerFor,
} from '../scenario.mjs';
import {
  BROWSER_FEATURES_OFF,
  browserDynamicTools,
  browserThreadConfig,
  browserThreadParams,
  codingThreadParams,
} from '../thread-params.mjs';

test('markers match the mock conversation marker pattern', () => {
  assert.match(`[${markerFor('e1')}]`, /^\[Canopy-C[A-Za-z0-9_-]+\]$/);
  assert.throws(() => markerFor('Bad Kind'));
});

test('the scripted loop uses only closed browser tools with valid arguments', async () => {
  const host = createEpochToolHost({ epoch: 1, nonce: 'abc123' });
  const names = new Set(BROWSER_AGENT_TOOL_NAMES);
  const steps = browserLoopScenario().llm.steps;
  assert.equal(steps.length, EPOCH_TOOL_SCRIPT.length + 1);
  for (const { tool, input } of EPOCH_TOOL_SCRIPT) {
    assert.ok(names.has(tool));
    const result = await host.execute({
      tool,
      namespace: null,
      arguments: input,
    });
    assert.equal(result.success, true, `${tool} arguments rejected`);
  }
  assert.equal(host.calls.length, 6);
  const observe = host.calls.filter((call) => call.tool === 'observe');
  assert.ok(
    observe.every((call) => call.resultBytes > 15_000),
    'observation is at the 100-control/6,000-char bound',
  );
  assert.ok(
    host.calls.filter((call) => call.tool === 'scroll')[0].resultBytes < 200,
    'receipts are small',
  );
  const bad = await host.execute({
    tool: 'shell',
    namespace: null,
    arguments: {},
  });
  assert.equal(bad.success, false);
  const invalid = await host.execute({
    tool: 'navigate',
    namespace: null,
    arguments: { url: 'not a url' },
  });
  assert.equal(invalid.success, false);
  assert.deepEqual(failureScenario().llm.steps, [{ error: 'usage_limit' }]);
});

test('browser thread params carry the 05 section 8 overrides and nothing ambient', () => {
  const params = browserThreadParams({
    epochDir: '/e',
    baseUrl: 'http://127.0.0.1:9',
    ambientMcpServerNames: ['ambient_a', 'ambient_b'],
  });
  assert.equal(params.ephemeral, true);
  assert.deepEqual(params.environments, []);
  assert.deepEqual(params.selectedCapabilityRoots, []);
  assert.deepEqual(params.runtimeWorkspaceRoots, ['/e']);
  assert.equal(params.allowProviderModelFallback, false);
  assert.equal(params.developerInstructions, '');
  assert.equal(params.approvalPolicy, 'never');
  assert.equal(
    params.sandbox,
    undefined,
    'permissions profile cannot be combined with sandbox',
  );
  assert.equal(params.dynamicTools.length, 22);
  assert.ok(
    params.dynamicTools.every(
      (tool) =>
        tool.type === 'function' && tool.inputSchema && tool.description,
    ),
  );
  const c = params.config;
  assert.equal(c.project_doc_max_bytes, 0);
  assert.deepEqual(c.project_doc_fallback_filenames, []);
  for (const key of [
    'include_environment_context',
    'include_permissions_instructions',
    'include_apps_instructions',
    'include_collaboration_mode_instructions',
  ])
    assert.equal(c[key], false);
  assert.deepEqual(c.skills, {
    include_instructions: false,
    max_context_tokens: 1,
  });
  assert.equal(c.web_search, 'disabled');
  assert.equal(c.features.skip_host_skill_discovery, true);
  for (const name of [
    'plugins',
    'skill_search',
    'apps',
    'hooks',
    'memories',
    'shell_tool',
    'unified_exec',
    'multi_agent',
    'multi_agent_v2',
    'browser_use',
    'computer_use',
    'in_app_browser',
    'goals',
    'tool_suggest',
    'code_mode',
    'code_mode_host',
    'remote_plugin',
    'workspace_dependencies',
  ])
    assert.equal(c.features[name], false, name);
  assert.equal(BROWSER_FEATURES_OFF.length, new Set(BROWSER_FEATURES_OFF).size);
  assert.deepEqual(c.mcp_servers, {
    ambient_a: { enabled: false },
    ambient_b: { enabled: false },
  });
  assert.equal(c.model_providers.probe.base_url, 'http://127.0.0.1:9/v1');
  assert.deepEqual(c.permissions.bap0_browser.network, { enabled: false });
  assert.equal(
    browserThreadParams({
      epochDir: '/e',
      baseUrl: 'http://127.0.0.1:9',
      ambientMcpServerNames: [],
      withRuntimeWorkspaceRoots: false,
    }).runtimeWorkspaceRoots,
    undefined,
  );
  assert.equal(browserDynamicTools().length, 22);
  assert.equal(
    browserThreadConfig({
      baseUrl: 'http://127.0.0.1:9',
      ambientMcpServerNames: [],
    }).mcp_servers &&
      Object.keys(
        browserThreadConfig({
          baseUrl: 'http://127.0.0.1:9',
          ambientMcpServerNames: [],
        }).mcp_servers,
      ).length,
    0,
  );
});

test('coding control has no browser overrides', () => {
  const params = codingThreadParams({
    project: '/p',
    baseUrl: 'http://127.0.0.1:9',
  });
  assert.equal(params.cwd, '/p');
  assert.equal(params.sandbox, 'read-only');
  assert.equal(params.dynamicTools, undefined);
  assert.equal(params.baseInstructions, undefined);
  assert.equal(params.environments, undefined);
  assert.equal(params.allowProviderModelFallback, false);
  assert.equal(params.config.features.code_mode, false);
  assert.equal(params.config.features.plugins, undefined);
  assert.equal(params.config.project_doc_max_bytes, undefined);
});
