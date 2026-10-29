import * as path from 'node:path';
import type { McpServer } from '@agentclientprotocol/sdk';
import { BRAND } from '@canopy/brand/current';
import {
  cursorCanopyMcpServerNames,
  type CursorCanopyServerMode,
} from '../../lib/cursor-mcp-tool-call';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value))
    if (typeof entry === 'string') result[key] = entry;
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export interface CursorMcpServerBuildInput {
  /**
   * The app's own authenticated worktree MCP routes; `null` omits them. The
   * session only supplies them when the CLI advertised HTTP MCP support and
   * reports that capability gap itself, so they are silently omitted here
   * without it.
   */
  canopy: { mainUrl: string; uiUrl: string; authToken: string } | null;
  /** Which app tool set the session carries; names the reserved servers. */
  mode?: CursorCanopyServerMode;
  /** Plugin and standalone servers in the Claude SDK config shape. */
  resolvedMcpServers: Record<string, unknown>;
  /** `agentCapabilities.mcpCapabilities` from ACP initialization. */
  capabilities: { http?: boolean; sse?: boolean } | undefined;
  /**
   * Resolves a command to an absolute, existing executable path (`null` when
   * it does not exist). `cwd` is the directory the definition declares, so a
   * definition-relative command never resolves against the worktree.
   */
  resolveExecutable: (command: string, cwd?: string) => Promise<string | null>;
}

export interface CursorMcpServerBuildResult {
  servers: McpServer[];
  /** Why a selected server was not handed to Cursor. */
  warnings: string[];
  /** Advisories about servers that were handed to Cursor. */
  notes: string[];
}

/**
 * Translates the session's complete MCP selection into the ACP `mcpServers`
 * list the pinned Cursor CLI accepts on `session/new` and `session/load`.
 * Reserved identities reject the selection; unsupported transports report warnings.
 */
export async function buildCursorMcpServers(
  input: CursorMcpServerBuildInput,
): Promise<CursorMcpServerBuildResult> {
  const servers: McpServer[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const http = input.capabilities?.http === true;
  const sse = input.capabilities?.sse === true;
  const reserved = cursorCanopyMcpServerNames(input.mode ?? 'default');
  // Every app server name is reserved in every mode: a resolved server named
  // after the other mode's main server would otherwise be handed to the CLI
  // under a name the app owns.
  const reservedNames = new Set<string>([
    cursorCanopyMcpServerNames('default').main,
    cursorCanopyMcpServerNames('app-advisor').main,
    cursorCanopyMcpServerNames('pipeline-editor').main,
    reserved.ui,
  ]);
  if (input.canopy && http) {
    const authorization = `Bearer ${input.canopy.authToken}`;
    // A fresh list per server: the CLI may mutate what it receives.
    const bearer = (): { name: string; value: string }[] => [
      { name: 'Authorization', value: authorization },
    ];
    servers.push(
      {
        type: 'http',
        name: reserved.main,
        url: input.canopy.mainUrl,
        headers: bearer(),
      },
      {
        type: 'http',
        name: reserved.ui,
        url: input.canopy.uiUrl,
        headers: bearer(),
      },
    );
  }
  for (const [name, definition] of Object.entries(input.resolvedMcpServers)) {
    if (reservedNames.has(name))
      throw new Error(
        `MCP server "${name}" conflicts with a reserved ${BRAND.displayName} server name.`,
      );
    if (!isRecord(definition)) {
      warnings.push(
        `MCP server "${name}" has an unrecognized definition and was skipped.`,
      );
      continue;
    }
    if (definition.enabled === false) continue;
    const type = definition.type;
    if (type === 'http' || type === 'sse') {
      if (typeof definition.url !== 'string') {
        warnings.push(
          `MCP server "${name}" has an unrecognized definition and was skipped.`,
        );
        continue;
      }
      if (type === 'http' ? !http : !sse) {
        warnings.push(
          `MCP server "${name}" needs ${type === 'http' ? 'HTTP' : 'SSE'} MCP support that Cursor did not advertise and was skipped.`,
        );
        continue;
      }
      const headers = Object.entries(stringRecord(definition.headers)).map(
        ([header, value]) => ({ name: header, value }),
      );
      servers.push({ type, name, url: definition.url, headers });
      continue;
    }
    if (type === 'stdio' || typeof definition.command === 'string') {
      if (typeof definition.command !== 'string') {
        warnings.push(
          `MCP server "${name}" has an unrecognized definition and was skipped.`,
        );
        continue;
      }
      // Absolute commands are validated too: a missing one would otherwise be
      // handed to Cursor and fail opaquely inside the CLI.
      const command = await input.resolveExecutable(
        definition.command,
        typeof definition.cwd === 'string' ? definition.cwd : undefined,
      );
      if (!command) {
        warnings.push(
          definition.command.startsWith('/')
            ? `MCP server "${name}" command "${definition.command}" was not found and was skipped.`
            : definition.command.includes('/')
              ? `MCP server "${name}" command "${definition.command}" was not found relative to its own directory and was skipped.`
              : `MCP server "${name}" command "${definition.command}" was not found on PATH and was skipped.`,
        );
        continue;
      }
      const args = stringArray(definition.args);
      const env = stringRecord(definition.env);
      // ACP stdio servers have no cwd field: the child inherits Cursor's
      // working directory, so a directory the definition asked for only
      // located the executable above. The shared plugin resolver already
      // makes cwd-relative args that exist absolute, so only an arg still
      // written as an explicit relative path (`./`, `../`, or the Windows
      // forms) is at risk of not resolving from Cursor's working directory.
      // Say so for that case rather than let the server fail quietly; stay
      // silent otherwise. Package specifiers, URLs, and flag values also
      // contain separators, and a bare name is indistinguishable from a
      // subcommand here, so none of those are noted; a relative path inside
      // a flag value (`--config=./missing.json`) is likewise not noted, and
      // neither is a server that reads files relative to its own working
      // directory at runtime, which still runs in Cursor's.
      if (
        typeof definition.cwd === 'string' &&
        args.some((arg) => !path.isAbsolute(arg) && /^\.\.?[\\/]/.test(arg))
      )
        notes.push(
          `MCP server "${name}" runs in Cursor's working directory; its own directory "${definition.cwd}" only locates the executable.`,
        );
      const droppedArgs = Array.isArray(definition.args)
        ? definition.args.length - args.length
        : 0;
      const droppedEnv = isRecord(definition.env)
        ? Object.keys(definition.env).length - Object.keys(env).length
        : 0;
      if (droppedArgs > 0 || droppedEnv > 0) {
        const dropped = [
          droppedArgs > 0
            ? `${String(droppedArgs)} non-string ${droppedArgs === 1 ? 'argument' : 'arguments'}`
            : null,
          droppedEnv > 0
            ? `${String(droppedEnv)} non-string env ${droppedEnv === 1 ? 'value' : 'values'}`
            : null,
        ].filter((part): part is string => part !== null);
        warnings.push(`MCP server "${name}" dropped ${dropped.join(' and ')}.`);
      }
      servers.push({
        name,
        command,
        args,
        env: Object.entries(env).map(([variable, value]) => ({
          name: variable,
          value,
        })),
      });
      continue;
    }
    if (typeof type === 'string') {
      warnings.push(
        `MCP server "${name}" uses a transport Cursor cannot run and was skipped.`,
      );
      continue;
    }
    warnings.push(
      `MCP server "${name}" has an unrecognized definition and was skipped.`,
    );
  }
  return { servers, warnings, notes };
}
