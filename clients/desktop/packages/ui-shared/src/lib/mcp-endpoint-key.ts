/**
 * The endpoint an MCP server points at: `http:<host>` for http servers and the
 * constant `command` for command servers; `null` when an http server names no
 * parseable host. Index rows expose only their host, so two http servers on
 * one host are one endpoint here; callers also require a matching name.
 */
export function mcpEndpointKey(server: {
  type: 'command' | 'http';
  url?: string;
  urlHost?: string;
}): string | null {
  if (server.type === 'command') return 'command';
  if (server.urlHost !== undefined && server.urlHost !== '') {
    return `http:${server.urlHost.toLowerCase()}`;
  }
  if (server.url === undefined || server.url === '') return null;
  try {
    const host = new URL(server.url).hostname;
    return host === '' ? null : `http:${host.toLowerCase()}`;
  } catch {
    return null;
  }
}
