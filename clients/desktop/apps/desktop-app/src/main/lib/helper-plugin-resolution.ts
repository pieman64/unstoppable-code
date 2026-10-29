import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import {
  getExecutionHarnessForModel,
  hasAnySelections,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  emptyHelperAgentPluginRuntime,
  type HelperAgentPluginRuntime,
} from '@canopy/desktop-shared/lib/helper-agent-plugins';
import type { CodexConfig } from '@canopy/desktop-shared/lib/codex-model-config';
import { cleanupChatSkillPluginDir } from '../plugins/plugin-cleanup';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { getCodexRuntimeService } from '../codex/runtime-service';

export interface ResolveHelperPluginsOptions {
  projectId: string;
  worktreeId: string;
  helperName: string;
  model: string;
  selections: ChatTabPluginSelections;
}

export interface RunWithOptionalHelperPluginsOptions {
  projectId?: string;
  worktreeId?: string;
  helperName: string;
  model: string;
  selections?: ChatTabPluginSelections;
}

const DANGEROUS_OBJECT_KEYS = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

export function mergeHelperCodexMcpServers(
  config: CodexConfig,
  pluginMcpServers: CodexConfig,
): CodexConfig {
  const configuredMcpServers = isRecord(config.mcp_servers)
    ? config.mcp_servers
    : {};
  const mergedMcpServers = {
    ...pluginMcpServers,
    ...configuredMcpServers,
  };

  return {
    ...config,
    ...(Object.keys(mergedMcpServers).length > 0
      ? { mcp_servers: mergedMcpServers }
      : {}),
  };
}

export async function runWithOptionalHelperPlugins<T>(
  options: RunWithOptionalHelperPluginsOptions,
  run: (runtime: HelperAgentPluginRuntime) => Promise<T>,
): Promise<T> {
  if (!options.selections || !hasAnySelections(options.selections)) {
    return run(emptyHelperAgentPluginRuntime());
  }

  if (!options.projectId || !options.worktreeId) {
    emitHelperPluginWarning(
      `Skipping configured plugins for ${options.helperName}: audit context is required.`,
    );
    return run(emptyHelperAgentPluginRuntime());
  }

  return withResolvedHelperPlugins(
    {
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      helperName: options.helperName,
      model: options.model,
      selections: options.selections,
    },
    run,
  );
}

export async function withResolvedHelperPlugins<T>(
  options: ResolveHelperPluginsOptions,
  run: (runtime: HelperAgentPluginRuntime) => Promise<T>,
): Promise<T> {
  if (!hasAnySelections(options.selections)) {
    return run(emptyHelperAgentPluginRuntime());
  }

  const chatId = `helper-${options.helperName}-${randomUUID()}`;
  let runtime = emptyHelperAgentPluginRuntime();
  const executionHarness = getExecutionHarnessForModel(options.model);
  if (!executionHarness) {
    throw new Error(
      `No execution harness is available for helper model "${options.model}"`,
    );
  }
  const mcpHttpProxyService =
    executionHarness === 'codex' ? getMcpHttpProxyService() : null;

  try {
    try {
      const resolved = await resolvePlugins(
        options.selections,
        options.projectId,
        options.worktreeId,
        chatId,
        executionHarness === 'codex'
          ? {
              purpose: 'codex-session',
              enableHttpMcpProxy: true,
              mcpHttpProxyService: mcpHttpProxyService ?? undefined,
              mcpStdioBroker: getCodexRuntimeService(),
              sessionId: chatId,
            }
          : {
              purpose: 'claude-session',
            },
      );

      for (const warning of resolved.warnings) {
        emitHelperPluginWarning(warning);
      }

      runtime = {
        claudePlugins: resolved.sdkPlugins,
        claudeMcpServers: toClaudeMcpServers(resolved.mcpServers),
        codexCapabilityRoots: resolved.selectedCapabilityRoots,
        codexMcpServers: resolved.codexMcpServers,
      };
    } catch (error) {
      emitHelperPluginWarning(
        `Failed to resolve plugins for ${options.helperName}: ${getErrorMessage(error)}`,
      );
    }

    return await run(runtime);
  } finally {
    mcpHttpProxyService?.unregisterRoutesForSession(chatId);
    await getCodexRuntimeService().revokeStdioMcpRoutes(chatId);
    try {
      cleanupChatSkillPluginDir(options.projectId, options.worktreeId, chatId);
    } catch (error) {
      emitHelperPluginWarning(
        `Failed to clean up plugins for ${options.helperName}: ${getErrorMessage(error)}`,
      );
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isClaudeMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === 'http' || value.type === 'sse') {
    return (
      typeof value.url === 'string' &&
      (value.headers === undefined || isStringRecord(value.headers))
    );
  }

  return (
    (value.type === undefined || value.type === 'stdio') &&
    typeof value.command === 'string' &&
    (value.args === undefined || isStringArray(value.args)) &&
    (value.env === undefined || isStringRecord(value.env))
  );
}

function toClaudeMcpServers(
  servers: Record<string, unknown>,
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (DANGEROUS_OBJECT_KEYS.has(name)) {
      emitHelperPluginWarning(`Ignoring unsafe MCP server name "${name}".`);
      continue;
    }

    if (isClaudeMcpServerConfig(server)) {
      result[name] = server;
    } else {
      emitHelperPluginWarning(`Invalid MCP server "${name}".`);
    }
  }

  return result;
}

function emitHelperPluginWarning(message: string): void {
  process.emitWarning(message, {
    type: 'CanopyHelperPluginResolverWarning',
  });
}
