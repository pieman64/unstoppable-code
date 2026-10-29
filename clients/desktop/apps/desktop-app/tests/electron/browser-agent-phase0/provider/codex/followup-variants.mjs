// Arm definitions for the Codex follow-up comparison. Each arm is one
// thread-scoped launch on the same warm pooled app-server; nothing here
// changes the process profile, the home or production behaviour. Arms differ
// from the existing launches only in the keys named below.
//
//   baseline            existing browser launch (model gpt-6-sol, flat dynamic tools)
//   notify-empty        baseline + thread `notify = []`
//   coding-control-after coding launch run after the suppressed thread (notify live again?)
//   direct-model        baseline with a catalog model whose tool_mode is null
//   namespaced-direct   one dynamic tool namespace + code_mode.direct_only_tool_namespaces
//   toggles-context     baseline + helper-tool feature toggles; scripted usage ramp
//
// Config keys were located in the pinned binary's strings (CodeModeConfigToml
// carries direct_only_tool_namespaces; the bundled model catalog carries
// per-model tool_mode). Whether the runtime honours them is what the native
// run observes; unknown or ineffective keys show up as an unchanged surface.
import { CONTEXT_CHECKPOINT_TOKENS } from '../shared/followup-policy.mjs';
import {
  BROWSER_AGENT_TOOL_NAMES,
  deriveBrowserToolSchemas,
} from '../shared/tool-schemas.mjs';
import { CUSTOM_INPUT_KEY } from './custom-call-rewriter.mjs';
import { codingScenario } from './scenario.mjs';
import {
  PROBE_MODEL,
  browserThreadParams,
  codingThreadParams,
} from './thread-params.mjs';

export const ARM_IDS = Object.freeze([
  'baseline',
  'notify-empty',
  'coding-control-after',
  'direct-model',
  'namespaced-direct',
  'toggles-context',
  'ns-feature-config',
]);

export const BROWSER_NAMESPACE = 'bap0_browser';
/** Bundled catalog slug whose `tool_mode` is null (no code-mode-only routing). */
export const DIRECT_MODEL = 'gpt-5.5';

/** Helper/search/code-mode related feature keys found in the pinned binary. */
export const HELPER_TOGGLE_FEATURES = Object.freeze([
  'default_mode_request_user_input',
  'send_async_message',
  'send_message_to_user_async',
  'tool_search',
  'deferred_tool_world_state',
  'unavailable_dummy_tools',
  'code_mode_prewarm',
  'code_mode_buffered_exec',
  'code_mode_interrupt',
  'js_repl',
  'js_repl_tools_only',
]);
/** Retry subset when the full list is rejected at thread start. */
export const HELPER_TOGGLE_FEATURES_MINIMAL = Object.freeze(
  HELPER_TOGGLE_FEATURES.slice(0, 3),
);

/** Scripted synthetic `last` input tokens per response; the final one crosses 125k. */
export const CONTEXT_USAGE_RAMP = Object.freeze([
  90_000,
  110_000,
  CONTEXT_CHECKPOINT_TOKENS - 1_000,
  CONTEXT_CHECKPOINT_TOKENS + 1_000,
]);

const DEFINITIONS = Object.freeze({
  baseline: {
    model: PROBE_MODEL,
    kind: 'browser',
    namespace: null,
    notify: 'live',
    purpose:
      'Existing production-shaped browser launch; notify positive control.',
  },
  'notify-empty': {
    model: PROBE_MODEL,
    kind: 'browser',
    namespace: null,
    notify: 'suppressed',
    purpose: 'Baseline plus thread-scoped notify = [] on the warm pool.',
  },
  'coding-control-after': {
    model: PROBE_MODEL,
    kind: 'coding',
    namespace: null,
    notify: 'live',
    purpose:
      'Coding launch after the suppressed thread: notify must still fire.',
  },
  'direct-model': {
    model: DIRECT_MODEL,
    kind: 'browser',
    namespace: null,
    notify: 'live',
    purpose: `Baseline with ${DIRECT_MODEL}: does a null tool_mode model expose the browser tools directly?`,
  },
  'namespaced-direct': {
    model: PROBE_MODEL,
    kind: 'browser',
    namespace: BROWSER_NAMESPACE,
    notify: 'live',
    purpose:
      'One dynamic tool namespace plus code_mode.direct_only_tool_namespaces; wait collision by namespace.',
  },
  'toggles-context': {
    model: PROBE_MODEL,
    kind: 'browser',
    namespace: null,
    notify: 'live',
    purpose:
      'Baseline plus helper feature toggles; scripted usage ramp across the 125k checkpoint.',
  },
  'ns-feature-config': {
    model: PROBE_MODEL,
    kind: 'browser',
    namespace: BROWSER_NAMESPACE,
    notify: 'live',
    purpose:
      'Current official features.code_mode table contrast; pinned-version support is measured, not inferred.',
  },
});

export function armDefinition(id) {
  const definition = DEFINITIONS[id];
  if (!definition) throw new Error(`Unknown arm ${id}`);
  return { id, ...definition };
}

function namespacedDynamicTools() {
  return [
    {
      type: 'namespace',
      name: BROWSER_NAMESPACE,
      description: 'Probe browser tool namespace (placeholder description).',
      tools: deriveBrowserToolSchemas().map(
        ({ name, description, inputSchema }) => ({
          type: 'function',
          name,
          description,
          inputSchema,
        }),
      ),
    },
  ];
}

/**
 * Thread/start params for one arm.
 *
 * @param {string} id
 * @param {{ epochDir: string, project: string, baseUrl: string, ambientMcpServerNames: readonly string[] }} input
 * @param {{ minimalToggles?: boolean }} [options]
 */
export function armThreadParams(id, input, options = {}) {
  armDefinition(id);
  if (id === 'coding-control-after')
    return codingThreadParams({
      project: input.project,
      baseUrl: input.baseUrl,
    });
  const base = browserThreadParams({
    epochDir: input.epochDir,
    baseUrl: input.baseUrl,
    ambientMcpServerNames: input.ambientMcpServerNames,
  });
  switch (id) {
    case 'baseline':
      return base;
    case 'notify-empty':
      return { ...base, config: { ...base.config, notify: [] } };
    case 'direct-model':
      return { ...base, model: DIRECT_MODEL };
    case 'namespaced-direct':
      return {
        ...base,
        dynamicTools: namespacedDynamicTools(),
        config: {
          ...base.config,
          code_mode: { direct_only_tool_namespaces: [BROWSER_NAMESPACE] },
        },
      };
    case 'ns-feature-config':
      return {
        ...base,
        dynamicTools: namespacedDynamicTools(),
        config: {
          ...base.config,
          features: {
            ...base.config.features,
            code_mode: {
              enabled: true,
              direct_only_tool_namespaces: [BROWSER_NAMESPACE],
            },
          },
        },
      };
    case 'toggles-context': {
      const toggles = options.minimalToggles
        ? HELPER_TOGGLE_FEATURES_MINIMAL
        : HELPER_TOGGLE_FEATURES;
      return {
        ...base,
        config: {
          ...base.config,
          features: {
            ...base.config.features,
            ...Object.fromEntries(toggles.map((name) => [name, false])),
          },
        },
      };
    }
    default:
      throw new Error(`Unhandled arm ${id}`);
  }
}

/** Host-tool allowlist (namespace-aware) for one arm. */
export function armAllowedTools(id) {
  const definition = armDefinition(id);
  if (definition.kind !== 'browser') return [];
  return BROWSER_AGENT_TOOL_NAMES.map((tool) => ({
    namespace: definition.namespace,
    tool,
  }));
}

/**
 * Scripted conversation for one arm. The exec step is last so a rejected or
 * unrewritable custom call cannot hide the surface or the earlier calls.
 */
export function armScenario(id, { wrapperSource } = {}) {
  const definition = armDefinition(id);
  if (definition.kind === 'coding') return codingScenario();
  const scoped = definition.namespace
    ? { namespace: definition.namespace }
    : {};
  const usageAt = (index) =>
    id === 'toggles-context'
      ? {
          usage: {
            inputTokens: CONTEXT_USAGE_RAMP[index],
            outputTokens: 200,
            cacheReadInputTokens: 0,
          },
        }
      : {};
  return {
    llm: {
      openAiStepCursor: 'completed-scenario-tool-calls',
      steps: [
        {
          toolCalls: [{ name: 'observe', input: {}, ...scoped }],
          stopReason: 'tool_use',
          ...usageAt(0),
        },
        {
          toolCalls: [
            {
              name: 'wait',
              input: { until: { kind: 'duration', milliseconds: 100 } },
              ...scoped,
            },
          ],
          stopReason: 'tool_use',
          ...usageAt(1),
        },
        {
          toolCalls: [
            { name: 'exec', input: { [CUSTOM_INPUT_KEY]: wrapperSource } },
          ],
          stopReason: 'tool_use',
          ...usageAt(2),
        },
        {
          text: 'Follow-up probe complete.',
          stopReason: 'end_turn',
          ...usageAt(3),
        },
      ],
    },
  };
}

/**
 * JavaScript sent to `exec`. Every probe is wrapped so a denial is recorded
 * as data, never thrown; the result line is machine-readable and the targets
 * are synthetic. Independent evidence (marker file, loopback listener) is
 * checked by the host, not by this script.
 */
export function wrapperProbeSource({
  hostFile,
  envName,
  spawnMarker,
  loopbackUrl,
}) {
  return `const out = {};
const rec = async (key, fn) => {
  try {
    out[key] = { ok: true, v: String(await fn()).slice(0, 300) };
  } catch (error) {
    out[key] = { ok: false, e: String((error && error.message) || error).slice(0, 300) };
  }
};
const HOST_FILE = ${JSON.stringify(hostFile)};
const ENV_NAME = ${JSON.stringify(envName)};
const SPAWN_MARKER = ${JSON.stringify(spawnMarker)};
const LOOPBACK_URL = ${JSON.stringify(loopbackUrl)};
await rec('typeof-require', () => typeof require);
await rec('typeof-process', () => typeof process);
await rec('typeof-fetch', () => typeof fetch);
await rec('typeof-Deno', () => typeof Deno);
await rec('typeof-Bun', () => typeof Bun);
await rec('typeof-XMLHttpRequest', () => typeof XMLHttpRequest);
await rec('typeof-WebSocket', () => typeof WebSocket);
await rec('dynamic-import-fs', async () => {
  const fs = await import('node:fs');
  return fs.readFileSync(HOST_FILE, 'utf8');
});
await rec('host-file-read', () => require('node:fs').readFileSync(HOST_FILE, 'utf8'));
await rec('env-read', () => process.env[ENV_NAME]);
await rec('spawn', () => require('node:child_process').execFileSync('/usr/bin/touch', [SPAWN_MARKER]));
await rec('loopback-fetch', async () => (await fetch(LOOPBACK_URL)).status);
await rec('globals', () => Object.getOwnPropertyNames(globalThis).sort().join(','));
await rec('all-tools', () => ALL_TOOLS.map((tool) => tool.name).join(','));
const findTool = (leaf) => {
  const names = ALL_TOOLS.map((tool) => tool.name);
  const target = names.find((name) => new RegExp('(^|[._])' + leaf + '$').test(name));
  if (!target) throw new Error(leaf + ' not in ALL_TOOLS: ' + names.slice(0, 40).join(','));
  const fn =
    target in tools
      ? tools[target]
      : target.split('.').reduce((node, part) => (node == null ? undefined : node[part]), tools);
  if (typeof fn !== 'function') throw new Error('not callable: ' + target);
  return fn;
};
await rec('browser-call', async () => JSON.stringify(await findTool('observe')({})).slice(0, 200));
await rec('browser-wait-call', async () =>
  JSON.stringify(await findTool('wait')({ until: { kind: 'duration', milliseconds: 100 } })).slice(0, 200),
);
text('BAP0_PROBE_JSON:' + JSON.stringify(out));
`;
}
