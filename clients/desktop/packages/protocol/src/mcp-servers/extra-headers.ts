// Validation rules for the extra upstream headers a custom account MCP
// connection stores. The cloud start route, the desktop main process and both
// forms use these same rules; the cloud stays authoritative.

export const MAX_MCP_EXTRA_HEADERS = 16;
export const MAX_MCP_EXTRA_HEADER_NAME_LENGTH = 256;
export const MAX_MCP_EXTRA_HEADER_VALUE_LENGTH = 4096;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Printable ASCII, tab and obs-text; never CR, LF or other control characters.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * Names the cloud proxy strips from the caller that a connection may still
 * store. The proxy applies stored headers after its strip pass, so the
 * caller's own value never reaches the upstream.
 */
export const MCP_EXTRA_HEADER_STORED_ALLOWED_STRIPPED: ReadonlySet<string> =
  new Set(['x-api-key']);

// Every name the cloud proxy owns or strips (its STRIPPED_REQUEST_HEADERS
// minus the stored-allowed set), so a stored header is never silently dropped.
const BLOCKED_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
  'cookie',
  'mcp-session-id',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'x-canopy-workspace',
  'x-canopy-worktree',
  'x-canopy-org-project',
  'x-canopy-work-owner',
]);

export type McpExtraHeadersProblem =
  | { kind: 'not_object' }
  | { kind: 'too_many' }
  | { kind: 'invalid_name'; header: string }
  | { kind: 'blocked_name'; header: string }
  | { kind: 'duplicate_name'; header: string }
  | { kind: 'invalid_value'; header: string }
  | { kind: 'value_too_long'; header: string };

/** Whether the cloud refuses to store a header with this name. */
export function isBlockedMcpExtraHeaderName(name: string): boolean {
  return BLOCKED_NAMES.has(name.toLowerCase());
}

/** The first reason extra headers would be refused, or null when valid. */
export function mcpExtraHeadersProblem(
  value: unknown,
): McpExtraHeadersProblem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { kind: 'not_object' };
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_EXTRA_HEADERS) return { kind: 'too_many' };
  const seen = new Set<string>();
  for (const [header, headerValue] of entries) {
    const lower = header.toLowerCase();
    if (
      header.length > MAX_MCP_EXTRA_HEADER_NAME_LENGTH ||
      !HEADER_NAME.test(header)
    )
      return { kind: 'invalid_name', header };
    if (BLOCKED_NAMES.has(lower)) return { kind: 'blocked_name', header };
    if (seen.has(lower)) return { kind: 'duplicate_name', header };
    if (typeof headerValue !== 'string' || !HEADER_VALUE.test(headerValue))
      return { kind: 'invalid_value', header };
    if (headerValue.length > MAX_MCP_EXTRA_HEADER_VALUE_LENGTH)
      return { kind: 'value_too_long', header };
    seen.add(lower);
  }
  return null;
}

/** Validated copy of caller-supplied extra upstream headers, or null. */
export function parseMcpExtraHeaders(
  value: unknown,
): Record<string, string> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    mcpExtraHeadersProblem(value) !== null
  )
    return null;
  // fromEntries defines own properties, so a `__proto__` name stays data.
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
