import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../../shared/constants.mjs';
import { createCanarySet } from '../../shared/canaries.mjs';
import {
  HOOK_EVENTS,
  planFixtures,
  renderConfigToml,
  tomlString,
  writeFixtures,
} from '../config-fixture.mjs';
import {
  PROBE_CONFIG_ARGS,
  checkDelegationProfileDrift,
  extractDelegationConfigArgs,
} from '../drift-guard.mjs';
import {
  inspectProcessEnvironment,
  parsePsEnvironment,
} from '../process-env.mjs';

const layout = {
  root: '/tmp/canopy-browser-agent-probe-codex-x',
  home: '/tmp/canopy-browser-agent-probe-codex-x/home',
  codexHome: '/tmp/canopy-browser-agent-probe-codex-x/home/.codex',
  ancestor: '/tmp/canopy-browser-agent-probe-codex-x/ancestor',
  project: '/tmp/canopy-browser-agent-probe-codex-x/ancestor/project',
};
const recorders = {
  notify: '/r/notify.sh',
  mcp: '/r/mcp.sh',
  hook: '/r/hook.sh',
};

test('tomlString escapes quotes and backslashes and rejects control characters', () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => tomlString('a\nb'));
});

test('config.toml puts top-level keys before tables and points every URL at loopback', () => {
  const canaries = createCanarySet();
  const text = renderConfigToml({
    baseUrl: 'http://127.0.0.1:4567',
    canaries,
    recorders,
  });
  const firstTable = text.indexOf('\n[');
  for (const key of [
    'model_provider = "probe"',
    'chatgpt_base_url',
    'openai_base_url',
    'notify = ',
    'developer_instructions = ',
  ]) {
    const at = text.indexOf(key);
    assert.ok(
      at >= 0 && at < firstTable,
      `${key} must precede the first table`,
    );
  }
  const urls = [...text.matchAll(/https?:\/\/[^"\s]+/g)].map(
    (match) => match[0],
  );
  assert.ok(urls.length >= 3);
  assert.ok(
    urls.every((url) => url.startsWith('http://127.0.0.1:4567')),
    `non-loopback URL in ${urls.join(',')}`,
  );
  assert.match(
    text,
    /\[model_providers\.probe\]\nname = "Loopback probe"\nbase_url = "http:\/\/127\.0\.0\.1:4567\/v1"\nwire_api = "responses"\nrequires_openai_auth = false/,
  );
  assert.match(text, /notify = \["\/r\/notify\.sh", "BAP0_NOTIFY_/);
  assert.match(
    text,
    new RegExp(
      `\\[mcp_servers\\.${canaries.mcpUserConfig}\\]\\ncommand = "/r/mcp\\.sh"`,
    ),
  );
  for (const event of HOOK_EVENTS)
    assert.match(
      text,
      new RegExp(
        `\\[\\[hooks\\.${event}\\.hooks\\]\\]\\ntype = "command"\\ncommand = "/r/hook\\.sh ${canaries.hook}"`,
      ),
    );
  assert.match(text, /\[plugins\."bap0-probe@bap0-local"\]\nenabled = true/);
});

test('every applicable canary lands in exactly its planned fixture; nothing is written outside the roots', async () => {
  const canaries = createCanarySet();
  const plan = planFixtures({
    layout,
    canaries,
    baseUrl: 'http://127.0.0.1:1',
    recorders,
  });
  const owners = {
    codexGlobalAgents: 'AGENTS.md',
    ancestorInstructions: 'ancestor/AGENTS.md',
    projectInstructions: 'project/AGENTS.md',
    projectOverrideInstructions: 'project/AGENTS.override.md',
    settings: 'config.toml',
    notify: 'config.toml',
    mcpUserConfig: 'config.toml',
    hook: 'config.toml',
    skillUser: 'skills/bap0-user-skill/SKILL.md',
    skillAgentsDir: '.agents/skills/bap0-agents-skill/SKILL.md',
    plugin: '.codex-plugin/plugin.json',
    memory: 'memories/MEMORY.md',
    rules: 'rules/default.rules',
  };
  for (const [id, suffix] of Object.entries(owners)) {
    const holders = plan.filter((entry) =>
      entry.content.includes(canaries[id]),
    );
    assert.ok(holders.length >= 1, `${id} is not planted`);
    assert.ok(
      holders.some((entry) => entry.path.endsWith(suffix)),
      `${id} missing from ${suffix}`,
    );
  }
  // The replacement canary is written only during the run, never as a fixture.
  assert.equal(
    plan.filter((entry) =>
      entry.content.includes(canaries.codexGlobalAgentsReplacement),
    ).length,
    0,
  );
  assert.equal(
    plan.filter((entry) => entry.content.includes(canaries.codingThreadContext))
      .length,
    0,
  );
  await assert.rejects(
    writeFixtures(
      [{ id: 'x', path: '/etc/bap0-never-written', content: 'x' }],
      [layout.home],
    ),
    /outside allowed roots/,
  );
});

test('drift guard matches the real route-runtime.ts profile and flags drift', async () => {
  const source = await readFile(
    path.join(
      REPO_ROOT,
      'apps/desktop-app/src/main/agents/delegation/route-runtime.ts',
    ),
    'utf8',
  );
  const result = checkDelegationProfileDrift(source);
  assert.equal(result.status, 'pass', result.problems.join('; '));
  assert.deepEqual(extractDelegationConfigArgs(source), [...PROBE_CONFIG_ARGS]);
  const drifted = source.replace(
    "'features.apps=false'",
    "'features.apps=true'",
  );
  assert.equal(checkDelegationProfileDrift(drifted).status, 'fail');
  assert.equal(
    checkDelegationProfileDrift(
      source.replace(
        "environmentPolicy: 'restricted'",
        "environmentPolicy: 'inherit'",
      ),
    ).status,
    'fail',
  );
});

test('ps environment inspection reports names only and flags credential names / foreign homes', () => {
  const ok =
    '/x/codex app-server -c features.hooks=false LANG=en_US.UTF-8 HOME=/tmp/canopy-browser-agent-probe-codex-x/home CODEX_HOME=/tmp/canopy-browser-agent-probe-codex-x/home/.codex PATH=';
  assert.deepEqual(Object.keys(parsePsEnvironment(ok)).sort(), [
    'CODEX_HOME',
    'HOME',
    'LANG',
    'PATH',
  ]);
  assert.equal(inspectProcessEnvironment(ok, layout).status, 'pass');
  const bad = `${ok} OPENAI_API_KEY=sk-secret GITHUB_TOKEN=abc`;
  const inspected = inspectProcessEnvironment(bad, layout);
  assert.equal(inspected.status, 'fail');
  assert.deepEqual(inspected.credentialNames.sort(), [
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
  ]);
  assert.ok(!JSON.stringify(inspected).includes('sk-secret'));
  assert.equal(
    inspectProcessEnvironment('/x/codex app-server -c a=b', layout).status,
    'blocked',
  );
  assert.equal(
    inspectProcessEnvironment(
      '/x/codex HOME=/Users/someone CODEX_HOME=/Users/someone/.codex',
      layout,
    ).status,
    'fail',
  );
});
