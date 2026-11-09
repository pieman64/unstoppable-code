import type { McpServerIndexEntry } from '@canopy/execution-engine/types/mcp-servers';

/**
 * Flatten an MCP server index for consumers that look servers up by id.
 *
 * Account rows nest the device servers they shadow under `deviceCopies`, so a
 * top-level `find` misses any device server that also has an account
 * connection. Every reader that keys on a server id must go through this
 * helper so the picker, the activity panel, the Advisor, and the edit dialog
 * all see the same set of servers.
 */
export function flattenMcpServerRows(
  rows: readonly McpServerIndexEntry[],
): McpServerIndexEntry[] {
  return rows.flatMap((row): McpServerIndexEntry[] => [
    row,
    ...(row.deviceCopies ?? []),
  ]);
}
