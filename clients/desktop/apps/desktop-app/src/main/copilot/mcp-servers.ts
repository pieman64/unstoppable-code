import type { SessionConfig } from '@github/copilot-sdk';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import { COPILOT_BUILTIN_MCP_SERVERS } from '@canopy/desktop-shared/node/copilot/session-policy';
import { logMainProcessWarn } from '../lib/main-process-logging';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function strings(value: unknown): Record<string, string> {
  if (!record(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function isMcpArguments(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (arg: unknown) => typeof arg === 'string' && !arg.includes('\0'),
    )
  );
}

/** Explicit per-turn server selection; SDK discovery and built-in servers remain disabled. */
export function buildCopilotMcpServers(input: {
  mode?: 'default' | 'app-advisor';
  mainUrl?: string;
  uiUrl?: string;
  authToken?: string;
  definitions: Record<string, unknown>;
  cwd: string;
}): NonNullable<SessionConfig['mcpServers']> {
  const names = cursorCanopyMcpServerNames(input.mode ?? 'default');
  const servers: NonNullable<SessionConfig['mcpServers']> = {};
  Object.setPrototypeOf(servers, null);
  const reserved = new Set([
    names.main,
    names.ui,
    cursorCanopyMcpServerNames('app-advisor').main,
  ]);
  // Sessions disable the runtime's built-ins by name, so a selected server
  // sharing one could never run and might be mistaken for the built-in.
  // Leave it out rather than fail the turn: plugins can supply these names.
  // The app's own names above stay fatal, since they would shadow app tools.
  const builtIn = new Set<string>(COPILOT_BUILTIN_MCP_SERVERS);
  for (const [name, raw] of Object.entries(input.definitions)) {
    if (reserved.has(name))
      throw new Error(`MCP server ${name} uses a reserved name.`);
    if (!record(raw) || raw.enabled === false) continue;
    if (builtIn.has(name)) {
      logMainProcessWarn(
        '[copilot-mcp-servers]',
        `Skipped MCP server ${name}: Copilot reserves this name for a built-in server.`,
      );
      continue;
    }
    const tools = Array.isArray(raw.allowedTools)
      ? raw.allowedTools.filter(
          (tool): tool is string => typeof tool === 'string',
        )
      : ['*'];
    if (Array.isArray(raw.disabledTools) && raw.disabledTools.length)
      throw new Error(
        `Copilot cannot apply the selected tool exclusions for ${name}.`,
      );
    if (
      (raw.type === undefined || raw.type === 'stdio') &&
      typeof raw.command === 'string' &&
      raw.command &&
      !raw.command.includes('\0')
    ) {
      if (raw.args !== undefined && !isMcpArguments(raw.args))
        throw new Error(`Invalid MCP arguments for ${name}.`);
      servers[name] = {
        type: 'stdio',
        command: raw.command,
        args: raw.args,
        env: strings(raw.env),
        workingDirectory: typeof raw.cwd === 'string' ? raw.cwd : input.cwd,
        tools,
      };
    } else if (
      (raw.type === 'http' || raw.type === 'sse') &&
      typeof raw.url === 'string'
    ) {
      const url = new URL(raw.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(`Invalid MCP URL for ${name}.`);
      servers[name] = {
        type: raw.type,
        url: raw.url,
        headers: strings(raw.headers),
        tools,
      };
    } else throw new Error(`Copilot cannot load MCP server ${name}.`);
  }
  if (input.mainUrl && input.uiUrl && input.authToken) {
    servers[names.main] = {
      type: 'http',
      url: input.mainUrl,
      headers: { Authorization: `Bearer ${input.authToken}` },
      tools: ['*'],
    };
    servers[names.ui] = {
      type: 'http',
      url: input.uiUrl,
      headers: { Authorization: `Bearer ${input.authToken}` },
      tools: ['*'],
    };
  }
  return servers;
}
