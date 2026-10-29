import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { CodexConfig } from './codex-model-config';
import type { CodexSelectedCapabilityRoot } from '../types';

export interface HelperClaudePluginConfig {
  type: 'local';
  path: string;
}

export interface HelperAgentPluginRuntime {
  claudePlugins: HelperClaudePluginConfig[];
  claudeMcpServers: Record<string, McpServerConfig>;
  codexCapabilityRoots: CodexSelectedCapabilityRoot[];
  codexMcpServers: CodexConfig;
}

export function emptyHelperAgentPluginRuntime(): HelperAgentPluginRuntime {
  return {
    claudePlugins: [],
    claudeMcpServers: {},
    codexCapabilityRoots: [],
    codexMcpServers: {},
  };
}

export function withoutHelperAgentMcpServers(
  runtime: HelperAgentPluginRuntime,
): HelperAgentPluginRuntime {
  const safeRuntime: HelperAgentPluginRuntime & Record<string, unknown> = {
    ...runtime,
  };
  // Strip obsolete fields from callers compiled during the migration window.
  Reflect.deleteProperty(safeRuntime, ['codex', 'ProcessEnv'].join(''));
  Reflect.deleteProperty(safeRuntime, ['codexMcp', 'EnvKeys'].join(''));
  return {
    ...safeRuntime,
    claudeMcpServers: {},
    codexMcpServers: {},
  };
}
