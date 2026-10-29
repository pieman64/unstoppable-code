import type { OpenCodeCapabilitySnapshot } from './capability-snapshot';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/** Native keys use the pinned runtime's normalization, not the MCP wire names. */
export function openCodeMcpNativeKey(server: string, tool: string): string {
  return `${server.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/** Never choose a schema or policy identity when native keys collide. */
export function resolveOpenCodeMcpSnapshotTool(
  snapshot: OpenCodeCapabilitySnapshot['mcp'],
  nativeKey: string,
): { server: string; tool: Tool } | undefined {
  let match: { server: string; tool: Tool } | undefined;
  for (const server of snapshot) {
    for (const tool of server.tools) {
      if (openCodeMcpNativeKey(server.name, tool.name) !== nativeKey) continue;
      if (match) return undefined;
      match = { server: server.name, tool };
    }
  }
  return match;
}
