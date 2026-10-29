// Thread-start parameters for the probe: the coding positive control (like a
// coding delegate, no browser overrides) and the browser launch (05 §8 overrides
// plus the structured-helper report-only preset). Pure builders.
import { deriveBrowserToolSchemas } from '../shared/tool-schemas.mjs';

export const PROBE_MODEL = 'gpt-6-sol';
export const PROBE_PROVIDER = 'probe';
export const BROWSER_PERMISSION_PROFILE = 'bap0_browser';
/** Versioned placeholder base prompt; not production prompt copy. */
export const BROWSER_PROBE_PROMPT =
  'bap0-browser-probe-prompt/v1: You are a scripted browser probe. Use the provided tools only.';

/** Thread-scoped loopback provider (production never sets this; the synthetic user config also does). */
export function probeProviderConfig(baseUrl) {
  return {
    name: 'Loopback probe',
    base_url: `${baseUrl}/v1`,
    wire_api: 'responses',
    requires_openai_auth: false,
  };
}

/** Features turned off for browser threads (05 §8 list + report-only preset + precedent). */
export const BROWSER_FEATURES_OFF = Object.freeze([
  'plugins',
  'skill_search',
  'apps',
  'hooks',
  'memories',
  'shell_tool',
  'unified_exec',
  'image_generation',
  'view_image',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'in_app_local_automation',
  'goals',
  'tool_suggest',
  'code_mode',
  'code_mode_host',
  'remote_plugin',
  'workspace_dependencies',
  'sleep_tool',
  'apply_patch_freeform',
  'request_permissions_tool',
]);

/** @param {{ baseUrl: string, ambientMcpServerNames: readonly string[] }} input */
export function browserThreadConfig({ baseUrl, ambientMcpServerNames }) {
  return {
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    include_environment_context: false,
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    skills: { include_instructions: false, max_context_tokens: 1 },
    web_search: 'disabled',
    'agents.enabled': false,
    features: {
      ...Object.fromEntries(BROWSER_FEATURES_OFF.map((name) => [name, false])),
      skip_host_skill_discovery: true,
    },
    // Empty MCP tables do not suppress canonical named servers; disable by name.
    mcp_servers: Object.fromEntries(
      ambientMcpServerNames.map((name) => [name, { enabled: false }]),
    ),
    model_providers: { [PROBE_PROVIDER]: probeProviderConfig(baseUrl) },
    permissions: {
      [BROWSER_PERMISSION_PROFILE]: {
        filesystem: { ':minimal': 'read' },
        network: { enabled: false },
      },
    },
  };
}

/** Coding positive control config: loopback provider + code mode off only. */
export function codingThreadConfig({ baseUrl }) {
  return {
    model_providers: { [PROBE_PROVIDER]: probeProviderConfig(baseUrl) },
    features: { code_mode: false },
  };
}

/** Dynamic tool specs from the derived browser schemas. */
export function browserDynamicTools() {
  return deriveBrowserToolSchemas().map(
    ({ name, description, inputSchema }) => ({
      type: 'function',
      name,
      description,
      inputSchema,
    }),
  );
}

/** @param {{ epochDir: string, baseUrl: string, ambientMcpServerNames: readonly string[], withRuntimeWorkspaceRoots?: boolean }} input */
export function browserThreadParams({
  epochDir,
  baseUrl,
  ambientMcpServerNames,
  withRuntimeWorkspaceRoots = true,
}) {
  return {
    model: PROBE_MODEL,
    modelProvider: PROBE_PROVIDER,
    allowProviderModelFallback: false,
    cwd: epochDir,
    ...(withRuntimeWorkspaceRoots ? { runtimeWorkspaceRoots: [epochDir] } : {}),
    environments: [],
    selectedCapabilityRoots: [],
    ephemeral: true,
    approvalPolicy: 'never',
    permissions: BROWSER_PERMISSION_PROFILE,
    baseInstructions: BROWSER_PROBE_PROMPT,
    developerInstructions: '',
    experimentalRawEvents: false,
    config: browserThreadConfig({ baseUrl, ambientMcpServerNames }),
    dynamicTools: browserDynamicTools(),
  };
}

/** @param {{ project: string, baseUrl: string }} input */
export function codingThreadParams({ project, baseUrl }) {
  return {
    model: PROBE_MODEL,
    modelProvider: PROBE_PROVIDER,
    allowProviderModelFallback: false,
    cwd: project,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    experimentalRawEvents: false,
    config: codingThreadConfig({ baseUrl }),
  };
}
