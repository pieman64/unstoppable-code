// Synthetic canary catalog and invocation recorders. Tokens are fresh per run
// and match outbound-capture's CANARY_PATTERN, so byte search is exact.
import { randomBytes } from 'node:crypto';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Every ambient source S0.1 plants. `expected` is what a qualified isolated
 * launch must show in outbound traffic: `absent`, or `accepted` (the Codex
 * global AGENTS.md exception, 05 §1.12). `providers` limits applicability;
 * a source outside a provider's list is reported `n/a` for that provider.
 */
export const CANARY_CATALOG = Object.freeze([
  {
    id: 'ancestorInstructions',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where:
      'AGENTS.md / CLAUDE.md in the synthetic repository root above the project',
  },
  {
    id: 'projectInstructions',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'AGENTS.md / CLAUDE.md in the synthetic project directory',
  },
  {
    id: 'projectOverrideInstructions',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'AGENTS.override.md / CLAUDE.local.md in the project',
  },
  {
    id: 'userInstructions',
    providers: ['claude'],
    expected: 'absent',
    where: 'CLAUDE.md in CLAUDE_CONFIG_DIR and ~/.claude',
  },
  {
    id: 'codexGlobalAgents',
    providers: ['codex'],
    expected: 'accepted',
    where: '$CODEX_HOME/AGENTS.md (accepted exception, 05 §1.12)',
  },
  {
    id: 'codexGlobalAgentsReplacement',
    providers: ['codex'],
    expected: 'accepted',
    where: 'replacement $CODEX_HOME/AGENTS.md content written during an epoch',
  },
  {
    id: 'settings',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where:
      'user/project settings (config.toml instructions keys, settings.json)',
  },
  {
    id: 'skillUser',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'skill in the provider user skills directory',
  },
  {
    id: 'skillAgentsDir',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'skill in ~/.agents/skills',
  },
  {
    id: 'plugin',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'plugin in the provider user plugin location',
  },
  {
    id: 'outputStyle',
    providers: ['claude'],
    expected: 'absent',
    where: 'output style in the user output-styles directory',
  },
  {
    id: 'memory',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'provider memory store',
  },
  {
    id: 'mcpUserConfig',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where:
      'MCP server declared in user config (config.toml / settings / .mcp.json)',
  },
  {
    id: 'hook',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'hook command text; invocation recorded separately',
  },
  {
    id: 'notify',
    providers: ['codex'],
    expected: 'absent',
    where: 'notify command in config.toml; invocation recorded separately',
  },
  {
    id: 'rules',
    providers: ['codex'],
    expected: 'absent',
    where: '$CODEX_HOME/rules/*.rules',
  },
  {
    id: 'codingThreadContext',
    providers: ['codex'],
    expected: 'absent',
    where: 'prompt of the earlier coding thread on the same pooled process',
  },
  {
    id: 'hostEnvironment',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'non-allowlisted variable in the probe child environment',
  },
  {
    id: 'hostFile',
    providers: ['codex', 'claude'],
    expected: 'absent',
    where: 'file in the synthetic home never referenced by the probe',
  },
]);

export const CANARY_IDS = Object.freeze(
  CANARY_CATALOG.map((entry) => entry.id),
);

/** Name of the host-environment canary variable (not on any allowlist). */
export const HOST_ENV_CANARY_NAME = 'BAP0_HOST_ENV_CANARY';

/** A fresh token: `BAP0_<ID>_<16 hex>`. */
export function canaryToken(id) {
  const tag = id
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 40);
  return `BAP0_${tag}_${randomBytes(8).toString('hex')}`;
}

/** Fresh tokens for every catalog entry: `{ [id]: token }`. */
export function createCanarySet() {
  return Object.freeze(
    Object.fromEntries(CANARY_IDS.map((id) => [id, canaryToken(id)])),
  );
}

/** Catalog entries applicable to one provider. */
export function canariesFor(provider) {
  return CANARY_CATALOG.filter((entry) => entry.providers.includes(provider));
}

/**
 * Write an executable `/bin/sh` recorder. Every invocation appends one line
 * (`<name> <epoch-ms> argc=<n>`) to `<records>/<name>.log` and exits 0. Uses
 * absolute paths only, so an empty PATH still works. The script text embeds
 * `canary` so the command itself is also a searchable token.
 *
 * @returns {Promise<string>} absolute script path
 */
export async function writeRecorderScript(recordsDir, name, canary) {
  if (!/^[a-z0-9-]{1,40}$/.test(name))
    throw new Error(`Invalid recorder name ${name}`);
  const script = path.join(recordsDir, `${name}.sh`);
  const log = path.join(recordsDir, `${name}.log`);
  await writeFile(
    script,
    `#!/bin/sh\n# ${canary}\n/bin/echo "${name} $(/bin/date +%s) argc=$#" >> '${log}'\nexit 0\n`,
  );
  await chmod(script, 0o700);
  return script;
}

/** Invocation lines per recorder name: `{ [name]: string[] }`. */
export async function readRecorderInvocations(recordsDir) {
  const out = {};
  for (const entry of await readdir(recordsDir).catch(() => [])) {
    if (!entry.endsWith('.log')) continue;
    const text = await readFile(path.join(recordsDir, entry), 'utf8');
    out[entry.slice(0, -4)] = text.split('\n').filter(Boolean);
  }
  return out;
}
