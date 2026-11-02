/** C4 launch projections read the actual SDK/app-server launch boundary. */
export function replayRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a lifecycle launch object');
  }
  return Object.fromEntries(Object.entries(value));
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === 'string')
  ) {
    throw new Error(`Expected ${label} string array`);
  }
  return value;
}

/** Names only: never project environment values or authentication configuration. */
export const LIFECYCLE_ENV_KEYS = [
  'RTK_BINARY_PATH',
  'CANOPY_RTK_BINARY_PATH',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
];

export function projectClaudeLaunch(input: unknown): Record<string, unknown> {
  const query = replayRecord(input);
  const options = replayRecord(query.options);
  const systemPrompt = options.systemPrompt;
  const system =
    typeof systemPrompt === 'object' && systemPrompt !== null
      ? replayRecord(systemPrompt)
      : undefined;
  const env = options.env ? replayRecord(options.env) : {};
  const prompt = query.prompt;
  const streaming =
    typeof prompt === 'object' &&
    prompt !== null &&
    Symbol.asyncIterator in prompt;
  return {
    settingSources: stringArray(options.settingSources, 'settingSources'),
    permissionMode: options.permissionMode,
    includePartialMessages: options.includePartialMessages ?? false,
    promptMode: streaming ? 'streaming' : typeof prompt,
    disallowedToolsSet: [
      ...Array.from(
        new Set(stringArray(options.disallowedTools ?? [], 'disallowedTools')),
      ),
    ].sort(),
    hookEventsSet: Object.keys(
      options.hooks ? replayRecord(options.hooks) : {},
    ).sort(),
    perTaskStopAffordance: options.perTaskStopAffordance,
    systemPromptKind:
      system?.type === 'preset'
        ? `preset:${String(system.preset)}`
        : typeof systemPrompt,
    sessionStateEventsEnv: env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS,
    envKeysSet: Object.keys(env)
      .filter((key) => LIFECYCLE_ENV_KEYS.includes(key))
      .sort(),
  };
}

export function projectCodexLaunch(input: unknown): Record<string, unknown> {
  const params = replayRecord(input);
  const config = params.config ? replayRecord(params.config) : {};
  const features =
    config.features && typeof config.features === 'object'
      ? replayRecord(config.features)
      : {};
  const entries = new Map(Object.entries(features));
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith('features.'))
      entries.set(key.slice('features.'.length), value);
  }
  const agents =
    config.agents && typeof config.agents === 'object'
      ? replayRecord(config.agents)
      : {};
  return {
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    featuresSet: Array.from(entries)
      .map(([name, value]) => `${name}=${String(value)}`)
      .sort(),
    multiAgent:
      config['agents.enabled'] ??
      agents.enabled ??
      entries.get('multi_agent') ??
      null,
  };
}
