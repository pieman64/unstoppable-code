/** Prevent ambient credentials, routing, hooks and Node injection from selecting authority. */
export function copilotRuntimeEnvironment(
  inherited: NodeJS.ProcessEnv,
  stateDirectory: string,
  connectionToken: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    const name = key.toUpperCase();
    if (
      /^(COPILOT_|GITHUB_|GH_|OPENAI_|ANTHROPIC_|AZURE_OPENAI_|OTEL_|GIT_CONFIG_)/.test(
        name,
      ) ||
      [
        'NODE_OPTIONS',
        'NODE_PATH',
        'NODE_DEBUG',
        'BASH_ENV',
        'ENV',
        'ELECTRON_RUN_AS_NODE',
      ].includes(name)
    )
      continue;
    env[key] = value;
  }
  return {
    ...env,
    COPILOT_HOME: stateDirectory,
    COPILOT_CONNECTION_TOKEN: connectionToken,
    COPILOT_AUTO_UPDATE: 'false',
    COPILOT_DISABLE_KEYTAR: '1',
    COPILOT_TELEMETRY_OFF: 'true',
    NO_COLOR: '1',
  };
}
