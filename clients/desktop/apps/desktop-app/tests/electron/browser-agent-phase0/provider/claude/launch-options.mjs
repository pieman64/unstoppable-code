// SDK options for each variant. The isolated set is the 05 1.4 launch
// contract for Claude; nothing is cloned from a normal chat configuration.
import { PROBE_PROMPT_VERSION, PROBE_SYSTEM_PROMPT } from './scripts.mjs';

export const ISOLATED_MAX_TURNS = 14;

/** Options common to every isolated launch (B, C, D, E, F); F adds `hooks` via `extra`. */
export function isolatedOptions({ gateway, denials, extra = {} }) {
  const allowed = new Set(gateway.allowedTools);
  return {
    settingSources: [],
    systemPrompt: PROBE_SYSTEM_PROMPT,
    tools: [],
    skills: [],
    plugins: [],
    agents: {},
    strictMcpConfig: true,
    mcpServers: { browser: gateway.server },
    allowedTools: gateway.allowedTools,
    canUseTool: async (toolName, input) => {
      if (allowed.has(toolName))
        return { behavior: 'allow', updatedInput: input };
      denials.push({ toolName, inputKeys: Object.keys(input ?? {}) });
      return { behavior: 'deny', message: 'Not an admitted browser tool.' };
    },
    persistSession: false,
    maxTurns: ISOLATED_MAX_TURNS,
    ...extra,
  };
}

export const ISOLATED_OPTIONS_SUMMARY = Object.freeze({
  settingSources: [],
  systemPrompt: `custom string (${PROBE_PROMPT_VERSION})`,
  tools: [],
  skills: [],
  plugins: [],
  agents: '{} (empty map)',
  hooks: 'not passed',
  strictMcpConfig: true,
  mcpServers: 'browser (in-process, alwaysLoad) only',
  allowedTools: '22 mcp__browser__*',
  canUseTool: 'allow only those 22, deny and record anything else',
  persistSession: false,
  resume: 'never',
  continue: 'never',
  cwd: 'fresh empty epoch dir',
  maxTurns: ISOLATED_MAX_TURNS,
  fallbackModel: 'never set',
});

/** Positive control: NOT an isolated launch. Every tool call is denied and recorded. */
export function controlOptions({ denials }) {
  return {
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    canUseTool: async (toolName, input) => {
      denials.push({ toolName, inputKeys: Object.keys(input ?? {}) });
      return { behavior: 'deny', message: 'Denied by the probe control.' };
    },
    persistSession: false,
    maxTurns: 6,
  };
}

/** Options that must never appear on an isolated launch. */
export const FORBIDDEN_ISOLATED_OPTIONS = Object.freeze([
  'resume',
  'continue',
  'resumeSessionAt',
  'forkSession',
  'fallbackModel',
  'additionalDirectories',
  'settings',
  'managedSettings',
  'extraArgs',
  'sessionStore',
  'enableFileCheckpointing',
  'hooks',
]);

// ── October 2 follow-up arms ────────────────────────────────────────────────
// Each follow-up arm starts from the isolated contract and records every
// deviation from it. Neither bare mode nor CLAUDE_CODE_SIMPLE is ever used:
// both skip OAuth/keychain credentials (07 section 11).

/** Extra SDK options a follow-up arm may add on top of the isolated contract. */
export const FOLLOWUP_OPTION_DEVIATIONS = Object.freeze({
  production: Object.freeze([]),
  'flag-removed': Object.freeze([]),
  targeted: Object.freeze(['extraArgs', 'settings']),
  'safe-mode': Object.freeze(['extraArgs']),
});

/** Isolated launch unchanged; the arm differs only by its environment. */
export function productionEquivalentOptions({ gateway, denials }) {
  return isolatedOptions({ gateway, denials });
}

/** Targeted controls from the 07 section 11 table (the environment half lives in probe-env.mjs). */
export function targetedControlOptions({ gateway, denials }) {
  return isolatedOptions({
    gateway,
    denials,
    extra: {
      settings: { disableAllHooks: true },
      extraArgs: { 'disable-slash-commands': null },
    },
  });
}

/**
 * `--safe-mode` through the SDK's extraArgs, keeping the explicit in-process
 * browser gateway (mcpServers + strictMcpConfig) from the isolated contract.
 */
export function safeModeOptions({ gateway, denials }) {
  return isolatedOptions({
    gateway,
    denials,
    extra: { extraArgs: { 'safe-mode': null } },
  });
}

/** Forbidden-for-isolated option names actually present on `options`. */
export function isolatedDeviations(options) {
  return FORBIDDEN_ISOLATED_OPTIONS.filter((name) => name in options);
}

/** Throws when an options/env pair would select bare or SIMPLE mode. */
export function assertNoBareMode(options, env = {}) {
  const extra = options.extraArgs ?? {};
  if ('bare' in extra || '--bare' in extra)
    throw new Error('bare mode skips OAuth/keychain credentials');
  if (env.CLAUDE_CODE_SIMPLE !== undefined)
    throw new Error('CLAUDE_CODE_SIMPLE skips OAuth/keychain credentials');
  return true;
}
