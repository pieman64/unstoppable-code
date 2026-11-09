// ---------------------------------------------------------------------------
// Desktop integration server — wire contracts
// ---------------------------------------------------------------------------
//
// `desktop-integration-server` is the consolidated localhost HTTP surface
// that the bundled `claude` CLI and the plugin MCP proxy talk to. This
// module locks down the route paths, auth header names, and the hook
// callback POST body shape so the backend route handlers, the wrapper
// script generator, and any conformance tests all reference one source of
// truth.
//
// Branded values (route prefix, alt token header, token env var, hook script
// filename) derive at module load from `@canopy/brand/current`. This file
// MUST stay otherwise dependency-free so it is safe to import from both the
// renderer and main process.

import { buildDesktopIntegrationRoutes } from '@canopy/protocol/brand';
import { BRAND } from '@canopy/brand/current';
import type { CanopyInjectedToolSurface } from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';

// ---------------------------------------------------------------------------
// Hostname / port binding
// ---------------------------------------------------------------------------

/**
 * Loopback host the integration server binds to. The server is intentionally
 * localhost-only — multi-user remote HTTP access is an explicit non-goal.
 */
export const DESKTOP_INTEGRATION_SERVER_HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// Route paths (derived from `BRAND.desktopIntegration.routePrefix`)
// ---------------------------------------------------------------------------

const DESKTOP_INTEGRATION_ROUTES = buildDesktopIntegrationRoutes(BRAND);

/**
 * Prefix every branded integration route starts with. Backend route
 * registration code uses this to scope all integration handlers under a
 * single tree. Defaults to `/canopy` for the Canopy brand; non-Canopy
 * brands rebrand at module load.
 */
export const DESKTOP_INTEGRATION_ROUTE_PREFIX: string =
  DESKTOP_INTEGRATION_ROUTES.routePrefix;

/** Base path for the branded MCP worktree-session HTTP route. */
export const CANOPY_MCP_WORKTREE_SESSION_PATH: string =
  DESKTOP_INTEGRATION_ROUTES.mcpWorktreeSession;

/** Base path for the Claude Code hook callback route. */
export const CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH: string =
  DESKTOP_INTEGRATION_ROUTES.hooksClaudeTerminalWorktreeSession;

/** Base path for the plugin MCP HTTP proxy. */
export const CANOPY_MCP_PROXY_PATH: string =
  DESKTOP_INTEGRATION_ROUTES.mcpProxy;

/**
 * Legacy unbranded plugin MCP proxy path. Preserved during migration so
 * existing generated configs continue to resolve. Handlers MUST route the
 * legacy alias through the same logic as {@link CANOPY_MCP_PROXY_PATH}.
 *
 * This is the only "legacy" alias the desktop integration server honors;
 * branded builds do NOT support legacy `/canopy/...` routes, legacy
 * `X-Canopy-*` headers, or legacy `mcp__canopy__*` tool names.
 */
export const LEGACY_MCP_PROXY_PATH = '/mcp';

/**
 * Builds the absolute MCP worktree-session route for a given session key.
 * Session keys are random per-runtime identifiers and MUST be opaque to
 * URL consumers (no project / worktree / chat IDs derived from them).
 */
export function buildCanopyMcpWorktreeSessionRoute(sessionKey: string): string {
  return `${CANOPY_MCP_WORKTREE_SESSION_PATH}/${encodeURIComponent(sessionKey)}`;
}

/** Builds the absolute hook callback route for a given session key. */
export function buildCanopyHooksClaudeTerminalRoute(
  sessionKey: string,
): string {
  return `${CANOPY_HOOKS_CLAUDE_TERMINAL_WORKTREE_SESSION_PATH}/${encodeURIComponent(
    sessionKey,
  )}`;
}

/** Builds the absolute plugin MCP proxy route for a given route id. */
export function buildCanopyMcpProxyRoute(routeId: string): string {
  return `${CANOPY_MCP_PROXY_PATH}/${encodeURIComponent(routeId)}`;
}

/**
 * Builds the legacy `/mcp/<routeId>` alias path. Backend handlers wire this
 * to the same logic as {@link buildCanopyMcpProxyRoute}; this helper exists
 * so the legacy alias contract is testable without string-template drift.
 */
export function buildLegacyMcpProxyRoute(routeId: string): string {
  return `${LEGACY_MCP_PROXY_PATH}/${encodeURIComponent(routeId)}`;
}

// ---------------------------------------------------------------------------
// Auth header names
// ---------------------------------------------------------------------------

/**
 * Standard bearer-token header name. Clients SHOULD prefer this header when
 * possible; the alternate header below is provided only for MCP clients
 * with awkward `Authorization` support.
 */
export const DESKTOP_INTEGRATION_BEARER_HEADER = 'Authorization';

/** Bearer-token prefix used with {@link DESKTOP_INTEGRATION_BEARER_HEADER}. */
export const DESKTOP_INTEGRATION_BEARER_PREFIX = 'Bearer ';

/**
 * Alternate header name accepted in place of the standard `Authorization`
 * header. The backend MUST honor both — if it only honors one, MCP wiring
 * will fail for clients that cannot inject the standard form.
 *
 * Derived from `BRAND.desktopIntegration.tokenHeaderName` at module load;
 * defaults to `X-Canopy-Integration-Token` for the Canopy brand.
 */
export const DESKTOP_INTEGRATION_ALT_TOKEN_HEADER: string =
  BRAND.desktopIntegration.tokenHeaderName;

/**
 * Process environment variable name used by the branded hook-callback
 * wrapper script to discover its bearer token. Locked here so the
 * wrapper-script generator and the hook handler agree without indirection.
 *
 * Derived from `BRAND.desktopIntegration.tokenEnvVar` at module load;
 * defaults to `CANOPY_DESKTOP_INTEGRATION_TOKEN` for the Canopy brand.
 */
export const DESKTOP_INTEGRATION_TOKEN_ENV_VAR: string =
  BRAND.desktopIntegration.tokenEnvVar;

/**
 * Filename of the generated hook callback wrapper script. The desktop
 * integration server writes this file to the worktree session directory and
 * Claude Code is configured to spawn it. The filename is brand-aware so
 * non-Canopy installs ship a `<internalName>-hook-callback.js` rather than
 * the legacy `canopy-hook-callback.js`.
 */
export const DESKTOP_INTEGRATION_HOOK_SCRIPT_FILENAME: string = `${BRAND.internalName}-hook-callback.js`;

/** Set of accepted auth header names (case-insensitive on the wire). */
export const DESKTOP_INTEGRATION_ACCEPTED_HEADERS: readonly string[] = [
  DESKTOP_INTEGRATION_BEARER_HEADER,
  DESKTOP_INTEGRATION_ALT_TOKEN_HEADER,
];

/**
 * Extract a bearer token from a `Headers`-style record, accepting either
 * the standard `Authorization: Bearer …` form or the alternate
 * `X-Canopy-Integration-Token: …` form. Lookups are case-insensitive on
 * the header name.
 *
 * Returns `null` when no recognized header carries a non-empty token.
 */
export function extractDesktopIntegrationToken(
  headerLookup: (name: string) => string | null | undefined,
): string | null {
  const authHeader = headerLookup(DESKTOP_INTEGRATION_BEARER_HEADER);
  if (typeof authHeader === 'string' && authHeader.length > 0) {
    if (authHeader.startsWith(DESKTOP_INTEGRATION_BEARER_PREFIX)) {
      const token = authHeader
        .slice(DESKTOP_INTEGRATION_BEARER_PREFIX.length)
        .trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  const altHeader = headerLookup(DESKTOP_INTEGRATION_ALT_TOKEN_HEADER);
  if (typeof altHeader === 'string' && altHeader.trim().length > 0) {
    return altHeader.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------
// Hook callback POST body
// ---------------------------------------------------------------------------

/**
 * Discriminated set of Claude Code hook event names the wrapper script
 * forwards. The list mirrors the upstream Claude Code hook taxonomy. The
 * wrapper passes the raw upstream payload through unmodified, so the
 * backend can stay defensive against future hook event additions; new
 * names should be appended here as they become officially supported.
 */
export type ClaudeTerminalHookEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Notification'
  | 'SessionEnd'
  | 'PostCompact';

/** Frozen list of known hook event names. */
export const CLAUDE_TERMINAL_HOOK_EVENT_NAMES: readonly ClaudeTerminalHookEventName[] =
  [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'Notification',
    'SessionEnd',
    'PostCompact',
  ];

export function isClaudeTerminalHookEventName(
  value: unknown,
): value is ClaudeTerminalHookEventName {
  return (
    typeof value === 'string' &&
    (CLAUDE_TERMINAL_HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}

/**
 * Wire payload produced by the branded hook-callback wrapper script and
 * consumed by the
 * `${routePrefix}/hooks/claude-terminal/worktree-session/<sessionKey>` route.
 *
 * The wrapper reads the raw Claude hook JSON from stdin and forwards it
 * verbatim as `hookPayload`. The backend MUST NOT assume any particular
 * field set on `hookPayload` because the upstream shape can vary by
 * Claude Code version.
 *
 * Required HTTP behavior on the wrapper side:
 *  - `Content-Type: application/json`.
 *  - `Authorization: Bearer <token>` (from
 *    {@link DESKTOP_INTEGRATION_TOKEN_ENV_VAR}).
 *  - Short timeout; fail-open (exit `0`) when the server is down.
 *  - Print no stdout unless the hook requires JSON output for that event.
 *
 * Hook route response: `200` with an optional Claude hook-output JSON body.
 * PreToolUse uses that body for Canopy approval decisions; other events
 * normally return an empty body. `4xx`/`5xx` errors MUST NOT block Claude
 * Code; the wrapper still exits `0`.
 */
export interface ClaudeTerminalHookCallbackBody {
  hookEventName: ClaudeTerminalHookEventName;
  /** Verbatim Claude hook JSON. Treated as opaque by the wire contract. */
  hookPayload: unknown;
}

export function isClaudeTerminalHookCallbackBody(
  value: unknown,
): value is ClaudeTerminalHookCallbackBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isClaudeTerminalHookEventName(
      (value as Record<string, unknown>).hookEventName,
    ) &&
    'hookPayload' in value
  );
}

// ---------------------------------------------------------------------------
// MCP tool surface
// ---------------------------------------------------------------------------

/**
 * Surface identifier for the worktree-session MCP route. Re-exported here
 * so backend code that constructs HTTP MCP handlers has a single import
 * path for transport constants.
 */
export const CLAUDE_TERMINAL_MCP_SURFACE: CanopyInjectedToolSurface =
  'claude-code-terminal';

/**
 * Canonical capability keys advertised on the worktree-session MCP route.
 * The terminal-mode surface advertises worktree-scoped Canopy tools but does
 * NOT advertise {@code AskUserQuestion} because the terminal experience
 * handles user prompts directly in the PTY. Split-agent tools are also
 * excluded until active terminal turns can be flushed into the canonical
 * transcript before cloning.
 */
export const CLAUDE_TERMINAL_MCP_TOOL_KEYS: readonly CanopyInjectedToolKey[] =
  CANOPY_INJECTED_TOOL_SURFACE_ALLOWLISTS[CLAUDE_TERMINAL_MCP_SURFACE];

// ---------------------------------------------------------------------------
// HTTP status codes
// ---------------------------------------------------------------------------

/**
 * Status code emitted when a request is missing or carries an invalid
 * integration token. Documented in transport tests so any future change to
 * the auth layer surfaces at the contract level.
 */
export const DESKTOP_INTEGRATION_UNAUTHORIZED_STATUS = 401;

/**
 * Status code emitted when the {@code sessionKey} embedded in a route is
 * unknown (already cleaned up, never registered, etc.). Either this code
 * or {@link DESKTOP_INTEGRATION_UNAUTHORIZED_STATUS} is acceptable for a
 * cleaned-up runtime; document the expected status in handler tests.
 */
export const DESKTOP_INTEGRATION_NOT_FOUND_STATUS = 404;
