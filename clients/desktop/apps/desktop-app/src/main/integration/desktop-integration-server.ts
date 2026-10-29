import {
  getMcpHttpProxyService,
  type CanopyWorktreeSessionRoute,
  type ClaudeTerminalHookHandler,
  type McpProxyBroadcastHandlers,
  type McpProxyHealthCheck,
  type McpProxyRoute,
  type McpHttpProxyService,
} from '../mcp/http-proxy-service';

export type {
  CanopyWorktreeSessionRoute,
  ClaudeTerminalHookHandler,
  McpProxyBroadcastHandlers,
  McpProxyHealthCheck,
  McpProxyRoute,
};

export type DesktopIntegrationServer = McpHttpProxyService;

export function getDesktopIntegrationServer(): DesktopIntegrationServer {
  return getMcpHttpProxyService();
}
