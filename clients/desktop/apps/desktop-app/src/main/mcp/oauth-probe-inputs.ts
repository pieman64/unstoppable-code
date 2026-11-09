import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/execution-engine/types/mcp-servers';
import {
  buildPluginHttpMcpServerForAuth,
  hasPluginManagedAuth,
  hasPluginOAuthLikeMetadata,
  type PluginMcpAuthIdentity,
} from '../plugins/plugin-mcp-auth';

interface McpOAuthProbeInputs {
  url: string;
  headers: Record<string, string>;
}

/** Identical inputs for passive cache reads and explicit Connect discovery. */
export function standaloneMcpOAuthProbeInputs(
  definition: McpServerDefinitionData,
  config: McpServerConfigData,
): McpOAuthProbeInputs | null {
  if (
    definition.type !== 'http' ||
    !definition.url ||
    definition.oauth ||
    config.authToken
  ) {
    return null;
  }
  return {
    url: definition.url,
    headers: { ...definition.headers, ...config.extraHeaders },
  };
}

export function pluginMcpOAuthProbeInputs(
  identity: PluginMcpAuthIdentity,
  rawValue: Record<string, unknown>,
): McpOAuthProbeInputs | null {
  if (hasPluginManagedAuth(rawValue) || hasPluginOAuthLikeMetadata(rawValue)) {
    return null;
  }
  const server = buildPluginHttpMcpServerForAuth(identity, rawValue, false);
  return server?.definition.url
    ? { url: server.definition.url, headers: server.headers }
    : null;
}
