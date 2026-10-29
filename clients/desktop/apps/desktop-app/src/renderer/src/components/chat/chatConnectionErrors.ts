import { isClaudeAuthenticationFailureMessage } from '@canopy/agent-transcript';
import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  parseMcpToolName,
  prettifyToolName,
} from '@canopy/ui-shared/components';

export type HarnessConnectionProvider = 'claude' | 'codex';

export function getHarnessConnectionProvider(
  message: string,
): HarnessConnectionProvider | null {
  const normalized = message.trim();
  if (
    isClaudeAuthenticationFailureMessage(normalized) ||
    /^You're not signed in to Claude\b/i.test(normalized)
  ) {
    return 'claude';
  }
  if (
    normalized === 'Codex is not authenticated.' ||
    /^Error: Unauthorized$/i.test(normalized) ||
    /^You're not signed in to Codex\b/i.test(normalized)
  ) {
    return 'codex';
  }
  return null;
}

/**
 * The proxy failure parser and its closed code set live in `@canopy/protocol`
 * so the web Portal can reuse them: the marker must never reach rendered text
 * on ANY surface, and shared runs replay this transcript through the web app.
 * Re-exported here so existing desktop imports keep their call sites.
 */
export type { CanopyProxyError, CanopyProxyErrorCode } from '@canopy/protocol';
export { parseCanopyProxyError } from '@canopy/protocol';

/**
 * A 401 in an HTTP *status* position: `HTTP 401`, `HTTP/1.1 401`, `(401)`,
 * `status 401`, `status: 401`, `statusCode = 401`, `"status":401`.
 *
 * Adjacency to an `Unauthorized` marker alone is not enough (CAN-1814 review
 * round 2). A bare `\b401\b` next to the word also matched an errored MCP tool
 * relaying a THIRD-PARTY upstream body — `Error 401: Unauthorized from the
 * GitHub API` — and fetch/proxy-style servers, which relay exactly that, are
 * the ones the structured producer cannot reach, so they lean hardest on this
 * fallback.
 *
 * `"status":401` deliberately still counts. The `status` keyword context is
 * required by a real MCP client string (`request failed with status 401
 * Unauthorized`), and a JSON body spelling the same field is indistinguishable
 * from it here.
 */
const STATUS_401 = String.raw`(?:\bhttp[\s/]+(?:\d\.\d\s+)?401\b|\(\s*401\s*\)|\bstatus(?:\s*code)?\b["']?\s*[:=]?\s*401\b)`;

/** The marker that turns a 401 status into an authentication verdict. */
const UNAUTHORIZED_MARKER = String.raw`\b(?:unauthorized|invalid_token)\b`;

/** Short window, so the status and the marker have to belong to each other. */
const NEARBY = String.raw`[\s\S]{0,64}?`;

/**
 * A 401 status next to an `Unauthorized` / `invalid_token` marker, in either
 * order. Both halves are required: the status position rules out prose that
 * merely contains the number (`Processed 401 events`), and the marker rules
 * out an unrelated 401 status line.
 */
const HTTP_401_UNAUTHORIZED = new RegExp(
  [
    `${STATUS_401}${NEARBY}${UNAUTHORIZED_MARKER}`,
    `${UNAUTHORIZED_MARKER}${NEARBY}${STATUS_401}`,
  ].join('|'),
  'i',
);

/**
 * LAST-RESORT fallback for an errored MCP tool result that carries no
 * structured `authFailure`. Structured data always wins where it exists
 * (`ToolCallBlock`), and every new HTTP-proxy OAuth failure produces it.
 *
 * This is NOT only a legacy-transcript path, which is why the status-line 401
 * alternative is back (CAN-1814 review). The structured producer only fires
 * when the proxy route has both `authorizationToken` and `loadedOAuth`
 * (`mcp/http-proxy-service.ts`), so three live cases still depend on this
 * function today:
 *   - Codex, whose MCP failure pairing is deliberately unimplemented;
 *   - stdio MCP servers, which never traverse the HTTP proxy at all;
 *   - HTTP MCP servers authenticated by a static header
 *     (`headers: { Authorization: 'Bearer $TOKEN' }`), which have no
 *     `loadedOAuth`.
 *
 * The only call site already gates on `result.isError === true` AND
 * `parseMcpToolName(toolName) !== null`, so a 401 quoted in ordinary tool
 * output — a `Read` of a log file, say — can never reach here.
 */
export function isMcpConnectionError(message: string): boolean {
  const normalized = message.trim();
  return (
    /MCP server (?:authentication|authorization) required/i.test(normalized) ||
    /\b(?:MCP|OAuth)\b.*\b(?:not connected|not authenticated|unauthorized|authentication required|authorization required|token (?:expired|invalid|missing|rejected))\b/i.test(
      normalized,
    ) ||
    HTTP_401_UNAUTHORIZED.test(normalized)
  );
}

/**
 * Wire-shape stand-in for a provider auth failure detected by the deprecated
 * text heuristic above, so pre-PR-1 transcripts still render the one recovery
 * card instead of a second, parallel component (CAN-1814).
 *
 * `detail` carries the host-generated system message verbatim. That is not new
 * interpolation of raw error text: it is the exact string the component this
 * replaces (`HarnessConnectionRecovery`) rendered as its headline, and it is
 * authored by Canopy, not by an upstream server.
 */
export function legacyProviderAuthFailure(
  provider: HarnessConnectionProvider,
  message: string,
): AuthDependencyFailure {
  return {
    dependencyClass: 'provider',
    dependencyId: provider,
    displayName: provider === 'claude' ? 'Claude' : 'Codex',
    failureClass: 'unauthenticated',
    recovery: { kind: 'provider_terminal', provider },
    detail: message,
  };
}

/**
 * Wire-shape stand-in for an MCP auth failure detected by
 * {@link isMcpConnectionError}.
 *
 * The recovery is a settings deeplink, NOT `mcp_oauth`: this path has only the
 * tool name, which `parseMcpToolName` resolves to a normalized DISPLAY name
 * rather than a `serverId`/`configId` pair (CAN-2249 caps app-managed server
 * names, so the mapping is lossy both ways). Without those two ids there is no
 * OAuth flow to start, so the card routes to the MCP settings surface — which
 * is exactly what the button it replaces did.
 */
export function legacyMcpAuthFailure(toolName: string): AuthDependencyFailure {
  const parsed = parseMcpToolName(toolName);
  return {
    dependencyClass: 'mcp',
    dependencyId: parsed ? `mcp-tool:${parsed.server}` : 'mcp-tool:unknown',
    displayName: parsed ? prettifyToolName(parsed.server) : 'MCP server',
    failureClass: 'unauthenticated',
    recovery: { kind: 'settings_deeplink', target: { page: 'mcp-servers' } },
  };
}
