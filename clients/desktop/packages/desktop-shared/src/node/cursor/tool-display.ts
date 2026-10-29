import { CANOPY_INJECTED_TOOL_REGISTRY } from '../../lib/canopy-injected-tools';
import {
  parseCursorMcpToolCall,
  resolveCursorCanopyToolKey,
} from '../../lib/cursor-mcp-tool-call';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Display-only translation of the pinned CLI's ACP input shapes. */
export function cursorToolDisplay(tool: {
  name: string;
  input: unknown;
  kind?: string;
}): { name: string; input: unknown } {
  const { name, input, kind } = tool;
  if (!isRecord(input)) return { name, input };

  if ((kind === 'read' || kind === 'edit') && typeof input.path === 'string') {
    const { path, ...rest } = input;
    return {
      name: kind === 'read' ? 'Read' : 'Edit',
      input: { ...rest, file_path: path },
    };
  }
  if (kind === 'execute' && typeof input.command === 'string')
    return { name: 'Bash', input };
  if (kind === 'search' && typeof input.pattern === 'string') {
    // Grep can omit its path, so distinguish it from Glob by the CLI's title.
    if (/^Find(?: |$)/.test(name)) return { name: 'Glob', input };
    if (/^grep(?: |$)/.test(name)) return { name: 'Grep', input };
  }
  if (kind === 'search' && typeof input.searchTerm === 'string') {
    const { searchTerm, ...rest } = input;
    return { name: 'WebSearch', input: { ...rest, query: searchTerm } };
  }
  if (kind === 'fetch' && typeof input.url === 'string')
    return { name: 'WebFetch', input };

  // Titles alone are ambiguous (e.g. "Create Plan: ..."). Only unwrap MCP
  // arguments when the structured identity agrees with the shared parser.
  if (
    typeof input.providerIdentifier === 'string' &&
    typeof input.toolName === 'string'
  ) {
    const mcp = parseCursorMcpToolCall({ title: name, rawInput: input, kind });
    if (mcp) {
      const key = resolveCursorCanopyToolKey(mcp);
      return {
        name: key
          ? CANOPY_INJECTED_TOOL_REGISTRY[key].claudeToolName
          : `mcp__${mcp.server}__${mcp.tool}`,
        input: mcp.args ?? {},
      };
    }
  }
  return { name, input };
}

/** The pinned CLI sends ACP "completed" even when its native tool failed. */
export function cursorToolOutputIsError(output: unknown): boolean {
  return (
    isRecord(output) &&
    (typeof output.error === 'string' ||
      output.rejected === true ||
      output.permissionDenied === true ||
      (typeof output.exitCode === 'number' &&
        Number.isFinite(output.exitCode) &&
        output.exitCode !== 0))
  );
}
