// Synthetic Codex user-state fixtures for S0.1: every ambient source the
// browser launch must not load, each carrying a fresh canary token. Planning
// evidence tooling only. Pure planning (`planFixtures`) is separate from the
// filesystem writer (`writeFixtures`) so the layout is unit-testable.
//
// Format certainty (nothing here could be run against the binary offline):
//   verified   - AGENTS.md / AGENTS.override.md / skills SKILL.md / config.toml
//                keys present as strings in the pinned binary or generated types.
//   unverified - hooks TOML shape, plugin cache layout + enable table, memory
//                file layout, rules syntax. The report marks these and the
//                positive control decides whether each was actually live.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** TOML basic string. Rejects control characters other than tab. */
export function tomlString(value) {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value))
    throw new Error('control character in TOML string');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function tomlArray(values) {
  return `[${values.map(tomlString).join(', ')}]`;
}

/** Hook events declared in the user config (PascalCase per Codex hooks docs; unverified for 0.159). */
export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Stop',
]);

export const FIXTURE_NAMES = Object.freeze({
  userSkill: 'bap0-user-skill',
  agentsSkill: 'bap0-agents-skill',
  pluginSkill: 'bap0-plugin-skill',
  pluginName: 'bap0-probe',
  pluginMarketplace: 'bap0-local',
  pluginVersion: '1.0.0',
});

/** Name of the user-config MCP server; carries the canary (token chars are valid). */
export function mcpServerName(canaries) {
  return canaries.mcpUserConfig;
}

/**
 * Render the user config.toml. Top-level scalars precede tables (TOML rule).
 *
 * @param {{ baseUrl: string, canaries: Record<string,string>, recorders: { notify: string, mcp: string, hook: string } }} input
 */
export function renderConfigToml({ baseUrl, canaries, recorders }) {
  const v1 = `${baseUrl}/v1`;
  const lines = [
    '# Synthetic probe config (browser-agent Phase 0). Never the user configuration.',
    'model_provider = "probe"',
    `chatgpt_base_url = ${tomlString(`${baseUrl}/backend-api/`)}`,
    `openai_base_url = ${tomlString(v1)}`,
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    // User-instruction-style key: `settings` canary.
    `developer_instructions = ${tomlString(`Probe settings instructions ${canaries.settings}`)}`,
    `notify = ${tomlArray([recorders.notify, canaries.notify])}`,
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'memories = true',
    '',
    '[model_providers.probe]',
    'name = "Loopback probe"',
    `base_url = ${tomlString(v1)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    `[mcp_servers.${mcpServerName(canaries)}]`,
    `command = ${tomlString(recorders.mcp)}`,
    `args = ${tomlArray(['--name', mcpServerName(canaries), '--description', `Probe MCP ${canaries.mcpUserConfig}`])}`,
    '',
    `[plugins.${tomlString(`${FIXTURE_NAMES.pluginName}@${FIXTURE_NAMES.pluginMarketplace}`)}]`,
    'enabled = true',
    '',
  ];
  for (const event of HOOK_EVENTS) {
    lines.push(
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(`${recorders.hook} ${canaries.hook}`)}`,
      'timeout = 10',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** SKILL.md with the canary in both description (catalog) and body. */
export function renderSkill({ name, canary, scopeLabel }) {
  return [
    '---',
    `name: ${name}`,
    `description: Probe ${scopeLabel} skill ${canary}`,
    '---',
    `# ${name}`,
    `Probe skill body ${canary}`,
    '',
  ].join('\n');
}

/**
 * Plan every fixture file. Paths are absolute. `live` names how the positive
 * control can show the fixture; `verified` marks format certainty.
 *
 * @param {{ layout: { home: string, codexHome: string, ancestor: string, project: string }, canaries: Record<string,string>, baseUrl: string, recorders: { notify: string, mcp: string, hook: string } }} input
 */
export function planFixtures({ layout, canaries, baseUrl, recorders }) {
  const { codexHome, home, ancestor, project } = layout;
  const plan = [];
  const add = (id, file, content, extra = {}) =>
    plan.push({ id, path: file, content, verified: true, ...extra });

  add(
    'codexGlobalAgents',
    path.join(codexHome, 'AGENTS.md'),
    `# Probe global instructions\n${canaries.codexGlobalAgents}\n`,
  );
  add(
    'ancestorInstructions',
    path.join(ancestor, 'AGENTS.md'),
    `# Probe ancestor instructions\n${canaries.ancestorInstructions}\n`,
  );
  add(
    'projectInstructions',
    path.join(project, 'AGENTS.md'),
    `# Probe project instructions\n${canaries.projectInstructions}\n`,
    {
      note: 'AGENTS.override.md in the same directory takes precedence for Codex; this file may not be live in the control.',
    },
  );
  add(
    'projectOverrideInstructions',
    path.join(project, 'AGENTS.override.md'),
    `# Probe project override\n${canaries.projectOverrideInstructions}\n`,
  );
  add(
    'config',
    path.join(codexHome, 'config.toml'),
    renderConfigToml({ baseUrl, canaries, recorders }),
    {
      carries: ['settings', 'notify', 'mcpUserConfig', 'hook', 'plugin'],
      verified: false,
      note: 'Top-level keys exist in the pinned binary/types; the [[hooks.*]] shape and [plugins."name@market"] table are unverified offline.',
    },
  );
  add(
    'skillUser',
    path.join(codexHome, 'skills', FIXTURE_NAMES.userSkill, 'SKILL.md'),
    renderSkill({
      name: FIXTURE_NAMES.userSkill,
      canary: canaries.skillUser,
      scopeLabel: 'user',
    }),
  );
  add(
    'skillAgentsDir',
    path.join(home, '.agents', 'skills', FIXTURE_NAMES.agentsSkill, 'SKILL.md'),
    renderSkill({
      name: FIXTURE_NAMES.agentsSkill,
      canary: canaries.skillAgentsDir,
      scopeLabel: 'agents-dir',
    }),
  );
  const pluginRoot = path.join(
    codexHome,
    'plugins',
    'cache',
    FIXTURE_NAMES.pluginMarketplace,
    FIXTURE_NAMES.pluginName,
    FIXTURE_NAMES.pluginVersion,
  );
  add(
    'plugin',
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    `${JSON.stringify({ name: FIXTURE_NAMES.pluginName, version: FIXTURE_NAMES.pluginVersion, description: `Probe plugin ${canaries.plugin}`, skills: './skills/' }, null, 2)}\n`,
    {
      verified: false,
      note: 'Cache layout and manifest shape are an unverified best effort.',
    },
  );
  add(
    'plugin',
    path.join(pluginRoot, 'skills', FIXTURE_NAMES.pluginSkill, 'SKILL.md'),
    renderSkill({
      name: FIXTURE_NAMES.pluginSkill,
      canary: canaries.plugin,
      scopeLabel: 'plugin',
    }),
    { verified: false },
  );
  add(
    'memory',
    path.join(codexHome, 'memories', 'memory_summary.md'),
    `# Probe memory summary\n${canaries.memory}\n`,
    {
      verified: false,
      note: 'Memory layout is an unverified best effort; features.memories=true is set in the user config.',
    },
  );
  add(
    'memory',
    path.join(codexHome, 'memories', 'MEMORY.md'),
    `# Task Group: probe\n${canaries.memory}\n`,
    { verified: false },
  );
  add(
    'rules',
    path.join(codexHome, 'rules', 'default.rules'),
    `# ${canaries.rules}\n`,
    {
      note: 'Rules feed the exec policy, not prompt text; absence from outbound bytes is uninformative even if loaded.',
    },
  );
  return plan;
}

/** Write a plan to disk. Refuses any path outside the synthetic home/ancestor trees. */
export async function writeFixtures(plan, allowedRoots) {
  for (const entry of plan) {
    const resolved = path.resolve(entry.path);
    if (
      !allowedRoots.some(
        (root) =>
          resolved === root || resolved.startsWith(`${root}${path.sep}`),
      )
    )
      throw new Error(`Fixture path outside allowed roots: ${resolved}`);
    await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
    await writeFile(resolved, entry.content, { mode: 0o600 });
  }
  return plan.map(({ id, path: file, verified, note }) => ({
    id,
    path: file,
    verified,
    ...(note ? { note } : {}),
  }));
}
