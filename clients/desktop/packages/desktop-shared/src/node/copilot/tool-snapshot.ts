import { setTimeout as delay } from 'node:timers/promises';
import type { CopilotSession, CurrentToolMetadata } from '@github/copilot-sdk';
import {
  createCopilotCapabilitySnapshot,
  type CopilotCapabilitySnapshot,
} from './capability-snapshot';
import { managedMcpServerFriendlyLabel } from '../plugins/mcp-server-name';

/** The name a person sees for a server: its friendly managed label, else the raw name. */
function shownServerName(name: string): string {
  return managedMcpServerFriendlyLabel(name) ?? name;
}

/** Only the pinned SDK's readiness operations cross this boundary. */
export interface CopilotToolMetadataRpc {
  tools: Pick<
    CopilotSession['rpc']['tools'],
    'initializeAndValidate' | 'getCurrentMetadata'
  >;
  mcp: Pick<CopilotSession['rpc']['mcp'], 'list'>;
}

export type CopilotMcpToolEvidence =
  | { name: string; status: 'connected'; toolCount: number }
  | { name: string; status: 'auth_required' | 'unavailable' };

type ListedMcpServer = Awaited<
  ReturnType<CopilotToolMetadataRpc['mcp']['list']>
>['servers'][number];

/** One selected server with the status the runtime reported after initialization. */
export interface CopilotMcpServerReadiness {
  name: string;
  status: ListedMcpServer['status'];
  error?: string;
}

export interface CopilotToolReadiness {
  /** The bound tool set: only servers that connected contribute to it. */
  snapshot: CopilotCapabilitySnapshot;
  /** Every selected server, so hosts can tell the user which ones sat out. */
  servers: CopilotMcpServerReadiness[];
}

/**
 * Capture the initialized model-facing table, without connection credentials
 * or URLs. A selected server that failed, needs sign-in, is disabled, was
 * stopped (including by managed policy) or is not configured for the session
 * sits out of the snapshot and is reported; the turn continues with the
 * rest, as the other harnesses do. A server the runtime never listed or is
 * still connecting leaves the bound tool set unknown, so that stays
 * fail-closed.
 */
export async function readCopilotToolSnapshot(
  rpc: CopilotToolMetadataRpc,
  selectedServers: readonly string[],
  signal: AbortSignal,
  onMcpToolsReady?: (evidence: CopilotMcpToolEvidence[]) => void,
): Promise<CopilotToolReadiness> {
  signal.throwIfAborted();
  await rpc.tools.initializeAndValidate();
  signal.throwIfAborted();
  let { servers: listed } = await rpc.mcp.list();
  if (onMcpToolsReady) {
    const startupDeadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(25_000),
    ]);
    try {
      while (
        selectedServers.some((name) =>
          listed.some(
            (server) => server.name === name && server.status === 'pending',
          ),
        )
      ) {
        await delay(100, undefined, { signal: startupDeadline });
        ({ servers: listed } = await rpc.mcp.list());
        startupDeadline.throwIfAborted();
      }
    } catch (error) {
      signal.throwIfAborted();
      // Native startup can outlast the setup budget. A normal prompt may use
      // its other tools; an activation's separate required-target gate will
      // refuse to continue with this server still unavailable.
      if (!startupDeadline.aborted || !onMcpToolsReady) throw error;
    }
  }

  signal.throwIfAborted();
  const servers: CopilotMcpServerReadiness[] = [];
  for (const name of selectedServers) {
    const server = listed.find((entry) => entry.name === name);
    if ((!server || server.status === 'pending') && !onMcpToolsReady)
      throw new Error(
        `Copilot could not connect to the MCP server "${shownServerName(name)}". Retry after checking the connection.`,
      );
    servers.push({
      name,
      status: server?.status ?? 'not_configured',
      ...(typeof server?.error === 'string' && server.error
        ? { error: server.error }
        : {}),
    });
  }
  const connected = new Set(
    servers
      .filter((server) => server.status === 'connected')
      .map((server) => server.name),
  );
  const { tools } = await rpc.tools.getCurrentMetadata();
  signal.throwIfAborted();
  if (tools === null || tools.length > 10_000)
    throw new Error('Copilot could not verify the initialized tool list.');
  const names = new Set<string>();
  const metadata: CurrentToolMetadata[] = [];
  let bytes = 0;
  for (const tool of tools) {
    if (!tool.mcpServerName && !tool.mcpToolName) continue;
    if (
      tool.mcpServerName &&
      selectedServers.includes(tool.mcpServerName) &&
      !connected.has(tool.mcpServerName)
    )
      throw new Error(
        `Copilot returned tools for the MCP server "${shownServerName(tool.mcpServerName)}" before it connected. Retry after checking the connection.`,
      );
    if (
      !tool.mcpServerName ||
      !tool.mcpToolName ||
      !connected.has(tool.mcpServerName) ||
      names.has(tool.name)
    )
      throw new Error('Copilot returned an unexpected MCP tool identity.');
    names.add(tool.name);
    const entry: CurrentToolMetadata = {
      name: tool.name,
      namespacedName: tool.namespacedName,
      mcpServerName: tool.mcpServerName,
      mcpToolName: tool.mcpToolName,
      description: tool.description,
      input_schema: tool.input_schema,
      deferLoading: tool.deferLoading,
    };
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > 8 * 1024 * 1024)
      throw new Error('Copilot MCP tool definitions exceed the size limit.');
    metadata.push(entry);
  }
  metadata.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  signal.throwIfAborted();
  onMcpToolsReady?.(
    selectedServers.map((name): CopilotMcpToolEvidence => {
      const server = servers.find((server) => server.name === name);
      if (server?.status === 'connected')
        return {
          name,
          status: 'connected',
          toolCount: metadata.filter((tool) => tool.mcpServerName === name)
            .length,
        };
      return {
        name,
        status:
          server?.status === 'needs-auth' ? 'auth_required' : 'unavailable',
      };
    }),
  );
  return {
    snapshot: createCopilotCapabilitySnapshot({
      mcpServers: Array.from(connected).sort(),
      modelFacingMcpTools: metadata,
    }),
    servers,
  };
}

const MCP_ERROR_MAX_LENGTH = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A value that reads like a credential rather than a word: it carries a
 * digit, mixes cases, or is long enough that no ordinary word matches. After
 * whitespace or a bare colon the keyword may be followed by prose ("Basic
 * Authentication Required", "token: Unauthorized"), so a single capitalized
 * word there is still a word; after an equals sign or inside quoted JSON,
 * "password=Correcthorse" is a value.
 */
function looksLikeCredential(value: string, relaxed: boolean): boolean {
  const cased = relaxed ? value.slice(1) : value;
  return (
    /\d/.test(value) ||
    (/[a-z]/.test(value) && /[A-Z]/.test(cased)) ||
    value.length >= 16
  );
}

/** Env keys whose values are treated as secrets; other env values are plain config. */
const CREDENTIAL_ENV_KEY = /key|token|secret|password|passwd|credential|auth/i;
/** The credential behind an HTTP auth scheme, when a header value carries one. */
const HEADER_SCHEME = /^(?:bearer|basic|token)\s+(\S+)$/i;
/** Closers that end a URL only when their opener is not inside it. */
const URL_CLOSERS = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
  ['>', '<'],
]);
const URL_OPENERS = new Set(URL_CLOSERS.values());

/**
 * Split the punctuation that follows a URL in prose from the URL itself:
 * sentence punctuation, a quote or backtick, and a closer whose opener is
 * not inside the URL, so "(see https://x.example/y)" gives its bracket back
 * while "https://x.example/y(z)" and "?token=[redacted]" keep theirs. Each
 * bracket is counted once, so a long run of closers in untrusted runtime
 * text costs linear time.
 */
function splitUrlTrailer(url: string): [string, string] {
  const counts = new Map<string, number>();
  for (let i = 0; i < url.length; i += 1) {
    const ch = url.charAt(i);
    if (URL_CLOSERS.has(ch) || URL_OPENERS.has(ch))
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let end = url.length;
  while (end > 0) {
    const ch = url.charAt(end - 1);
    const opener = URL_CLOSERS.get(ch);
    if (opener === undefined) {
      if (!/[.,;:!?'`]/.test(ch)) break;
    } else {
      const closers = counts.get(ch) ?? 0;
      if (closers <= (counts.get(opener) ?? 0)) break;
      counts.set(ch, closers - 1);
    }
    end -= 1;
  }
  return [url.slice(0, end), url.slice(end)];
}

/** Headers that carry content negotiation or routing, never a credential. */
const BENIGN_HEADER =
  /^(?:accept(?:-[a-z]+)?|content-(?:type|length)|user-agent|cache-control|connection|host|origin|referer)$/i;

/**
 * The runtime's connection error, made safe for a transcript notice, a log
 * line or a thrown message: known secret values are redacted, URLs are
 * reduced to their origin so query strings and paths never carry a key,
 * values after a credential keyword are masked, whitespace is collapsed and
 * the text is bounded. Undefined when nothing useful remains.
 */
export function describeCopilotMcpServerError(
  error: string | undefined,
  secretValues: readonly string[] = [],
): string | undefined {
  if (typeof error !== 'string') return undefined;
  let text = error;
  // Longest first, so a shorter secret that prefixes a longer one cannot
  // leave the longer one's remainder behind.
  for (const secret of Array.from(secretValues).sort(
    (a, b) => b.length - a.length,
  ))
    if (secret.length >= 4) text = text.split(secret).join('[redacted]');
  text = text
    // Any HTTP or WebSocket URL, down to its origin, so a path or query never
    // carries a key. Only whitespace or a double quote, which is never legal
    // unencoded in a URL, ends it; the punctuation that follows it in prose
    // stays outside. Runs before the keyword mask so a masked value inside a
    // URL cannot end the match early.
    .replace(/\b(?:https?|wss?):\/\/[^\s"]+/gi, (url) => {
      const [bare, trailing] = splitUrlTrailer(url);
      try {
        return `${new URL(bare).origin}${trailing}`;
      } catch {
        return `[url]${trailing}`;
      }
    })
    // A credential after a credential keyword (bearer, token, basic,
    // api_key, secret, password; also as the tail of access_token, x-api-key
    // or a quoted JSON key), with a space, colon or equals between; only a
    // value that reads like a credential is masked, so "Basic Authentication
    // Required" and "secret=plainword" survive.
    .replace(
      /(?<![A-Za-z0-9])(bearer|token|basic|api[_-]?key|secret|password|passwd)(["']?\s*[:=]\s*["']?|\s+)([A-Za-z0-9._~+/=!@#$%^&*-]{8,})/gi,
      (match, keyword: string, separator: string, value: string) =>
        looksLikeCredential(value, !/[="']/.test(separator))
          ? `${keyword}${separator}[redacted]`
          : match,
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length <= MCP_ERROR_MAX_LENGTH) return text;
  let head = text.slice(0, MCP_ERROR_MAX_LENGTH - 1);
  // Never end on a high surrogate: drop it rather than split the character.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/**
 * Header values of a session's MCP server config, the bare credential behind
 * a header's auth scheme, and the values of credential-named env keys, so a
 * connection error that echoes one of them can be redacted before it is
 * shown or logged. Left out, because masking them would hit ordinary words
 * or garble the reason: values under four characters, content-negotiation
 * headers such as Accept and Content-Type, ordinary env config, and stdio
 * `args`. A credential passed on a command line is not collected; the
 * keyword mask in {@link describeCopilotMcpServerError} is its only cover.
 */
export function collectCopilotMcpSecretValues(
  mcpServers: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const values = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 4) values.add(value);
  };
  for (const server of Object.values(mcpServers ?? {})) {
    if (!isRecord(server)) continue;
    const headers = server.headers;
    if (isRecord(headers))
      for (const [name, value] of Object.entries(headers)) {
        if (BENIGN_HEADER.test(name)) continue;
        add(value);
        if (typeof value === 'string') add(HEADER_SCHEME.exec(value)?.[1]);
      }
    const env = server.env;
    if (isRecord(env))
      for (const [key, value] of Object.entries(env))
        if (CREDENTIAL_ENV_KEY.test(key)) add(value);
  }
  return Array.from(values);
}

/**
 * A pipeline step or delegated task has nobody to sign in mid-turn, so a
 * selected server that sat out fails the run by name instead of silently
 * narrowing the tools the author selected.
 */
export function assertCopilotMcpServersConnected(
  servers: readonly CopilotMcpServerReadiness[],
  secretValues: readonly string[] = [],
): void {
  const unavailable = servers.filter((server) => server.status !== 'connected');
  if (!unavailable.length) return;
  const plural = unavailable.length > 1;
  throw new Error(
    `Copilot could not connect to the MCP server${plural ? 's' : ''} ${unavailable
      .map((server) => {
        const reason = describeCopilotMcpServerError(
          server.error,
          secretValues,
        );
        return `"${shownServerName(server.name)}" (${server.status}${reason ? `: ${reason}` : ''})`;
      })
      .join(
        ', ',
      )}. Connect or deselect ${plural ? 'them' : 'it'}, then run again.`,
  );
}
