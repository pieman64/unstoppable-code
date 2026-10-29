export const CODEX_MCP_STDIO_LAUNCHER_COMMAND = '__codex-mcp-stdio-launcher';

const CODEX_MCP_ROUTE_ID_PATTERN = /^[a-f0-9]{32}\.[a-f0-9]{48}$/;

export function isCodexMcpRouteId(value: string): boolean {
  return CODEX_MCP_ROUTE_ID_PATTERN.test(value);
}

export function codexMcpRouteAuthFileName(routeId: string): string {
  if (!isCodexMcpRouteId(routeId)) {
    throw new Error('Invalid MCP broker route');
  }
  return `${routeId}.auth.json`;
}
