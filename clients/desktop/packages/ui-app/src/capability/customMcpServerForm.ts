import {
  MAX_MCP_EXTRA_HEADERS,
  mcpExtraHeadersProblem,
  type McpExtraHeadersProblem,
} from '@canopy/protocol/mcp-servers';

export interface CustomMcpHeaderRow {
  readonly id: number;
  readonly name: string;
  readonly value: string;
}

export interface CustomMcpHeadersCheck {
  /** The headers to send; empty rows are dropped. */
  readonly headers: Record<string, string>;
  /** Problems keyed by row id. */
  readonly rowErrors: Readonly<Record<number, string>>;
  /** A problem that belongs to no single row. */
  readonly error: string | null;
}

export const CUSTOM_MCP_NAME_MAX_LENGTH = 120;
export const CUSTOM_MCP_URL_MAX_LENGTH = 4096;
export const CUSTOM_MCP_URL_EXAMPLE = 'https://mcp.example.com/mcp';
const HTTPS_URL_REQUIRED = `Enter an HTTPS URL, like ${CUSTOM_MCP_URL_EXAMPLE}.`;
const PUBLIC_URL_REQUIRED =
  'Enter a public address. The cloud can’t reach local or private network servers.';
const PRIVATE_HOST_SUFFIX =
  /(?:^|\.)(?:local|internal|localhost|lan|home|invalid|test)$/;

/** The URL's hostname, used to prefill an empty name. */
export function customMcpNameFromUrl(value: string): string | null {
  try {
    return new URL(value.trim()).hostname.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/**
 * The name to prefill from a URL, only while the name is empty and the user
 * has not typed in it. `null` leaves the name alone.
 */
export function prefilledCustomMcpName(
  name: string,
  nameTouched: boolean,
  url: string,
  maxLength: number,
): string | null {
  if (nameTouched || name.trim() !== '') return null;
  return customMcpNameFromUrl(url)?.slice(0, maxLength) ?? null;
}

/** The closed Advanced summary: which choices differ, never their values. */
export function customMcpAdvancedHint(
  choices: readonly (string | false | undefined)[],
): string | undefined {
  return choices.filter(Boolean).join(' · ') || undefined;
}

/**
 * What is wrong with a custom MCP server URL, mirroring the broker's
 * `validateUpstreamUrl` rules so most mistakes are caught before a request.
 * The broker stays authoritative.
 */
export function customMcpUrlProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter the server URL.';
  if (trimmed.length > CUSTOM_MCP_URL_MAX_LENGTH)
    return 'Use a URL of 4,096 characters or fewer.';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return HTTPS_URL_REQUIRED;
  }
  if (parsed.protocol !== 'https:') return HTTPS_URL_REQUIRED;
  if (parsed.username !== '' || parsed.password !== '')
    return 'Remove the sign-in details from the URL. Add an access token instead.';
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host.includes(':') ||
    /^[0-9.]+$/.test(host) ||
    !host.includes('.') ||
    PRIVATE_HOST_SUFFIX.test(host)
  )
    return PUBLIC_URL_REQUIRED;
  return null;
}

export function customMcpNameProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > CUSTOM_MCP_NAME_MAX_LENGTH)
    return `Use ${String(CUSTOM_MCP_NAME_MAX_LENGTH)} characters or fewer.`;
  return null;
}

const HEADERS_LIMIT = `Use ${String(MAX_MCP_EXTRA_HEADERS)} headers or fewer.`;

function headerProblemMessage(
  problem: Exclude<McpExtraHeadersProblem, { kind: 'not_object' | 'too_many' }>,
): string {
  switch (problem.kind) {
    case 'invalid_name':
      return 'Use letters, numbers, and dashes in the header name.';
    case 'blocked_name':
      return `The cloud sets ${problem.header} itself. Remove this header.`;
    case 'duplicate_name':
      return 'This header is already listed. Remove one of them.';
    case 'invalid_value':
      return 'Remove line breaks and other control characters from the value.';
    case 'value_too_long':
      return 'Use a value of 4,096 characters or fewer.';
  }
}

/**
 * Checks the header rows with the same rules the broker applies, placing each
 * problem on the row it belongs to. The broker stays authoritative.
 */
export function checkCustomMcpHeaders(
  rows: readonly CustomMcpHeaderRow[],
): CustomMcpHeadersCheck {
  const filled = rows
    .map((row) => ({ ...row, name: row.name.trim(), value: row.value.trim() }))
    .filter((row) => row.name !== '' || row.value !== '');
  const unnamed = filled.find((row) => row.name === '');
  if (unnamed)
    return {
      headers: {},
      rowErrors: { [unnamed.id]: 'Enter a header name.' },
      error: null,
    };
  // A duplicate is reported on its later row.
  const seen = new Map<string, number>();
  for (const row of filled) {
    const lower = row.name.toLowerCase();
    if (seen.has(lower))
      return {
        headers: {},
        rowErrors: {
          [row.id]: headerProblemMessage({
            kind: 'duplicate_name',
            header: row.name,
          }),
        },
        error: null,
      };
    seen.set(lower, row.id);
  }
  const headers = Object.fromEntries(
    filled.map((row): [string, string] => [row.name, row.value]),
  );
  const problem = mcpExtraHeadersProblem(headers);
  if (problem === null) return { headers, rowErrors: {}, error: null };
  if (problem.kind === 'not_object' || problem.kind === 'too_many')
    return { headers: {}, rowErrors: {}, error: HEADERS_LIMIT };
  const rowId = seen.get(problem.header.toLowerCase());
  const message = headerProblemMessage(problem);
  return rowId === undefined
    ? { headers: {}, rowErrors: {}, error: message }
    : { headers: {}, rowErrors: { [rowId]: message }, error: null };
}
