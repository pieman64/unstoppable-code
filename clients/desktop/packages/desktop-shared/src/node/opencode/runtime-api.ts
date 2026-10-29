import { setTimeout as delay } from 'node:timers/promises';

/** Preserve only the HTTP status, never provider response bodies or credentials. */
export class OpenCodeMetadataError extends Error {
  constructor(readonly status: number) {
    super('OpenCode local metadata is unavailable.');
    this.name = 'OpenCodeMetadataError';
  }
}

/** Bounded reads from the owned runtime's authenticated loopback server. */
export async function readOpenCodeRuntimeJson(
  base: string,
  pathname: string,
  token: string,
  signal: AbortSignal,
  payload?: { sessionId: string; operation: 'move' | 'remove' },
): Promise<unknown> {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  )
    throw new Error('OpenCode returned an invalid local endpoint.');
  const response = await fetch(new URL(pathname, url), {
    method: payload ? 'POST' : 'GET',
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new OpenCodeMetadataError(response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024 * 1024)
        throw new Error('OpenCode local metadata exceeds the size limit.');
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value;
  } finally {
    await reader.cancel();
  }
}

export interface OpenCodeUsage {
  input_tokens: number;
  /** Includes reasoning for existing headless token consumers. */
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Native price estimate for these calls, never a billed account charge. */
  estimated_cost_usd?: number;
}

/** V2 debounces MCP registration after session/new has already returned. */
export async function readOpenCodeToolCatalog(
  read: () => Promise<unknown>,
  expected: readonly string[],
  signal: AbortSignal,
): Promise<unknown[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    signal.throwIfAborted();
    const tools = await read();
    if (!Array.isArray(tools))
      throw new Error(
        'OpenCode could not check its native tools. Reconnect in Settings and try again.',
      );
    const catalog: unknown[] = tools;
    const names = new Set(
      catalog.flatMap((tool) =>
        record(tool) && typeof tool.id === 'string' ? [tool.id] : [],
      ),
    );
    if (expected.every((name) => names.has(name))) return catalog;
    if (Date.now() >= deadline)
      throw new Error(
        'OpenCode did not load the selected MCP tools. Reconnect the servers and try again.',
      );
    await delay(50, undefined, { signal });
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function counter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** V2 ACP reports the sum of this prompt's model calls, excluding resumed history. */
export function openCodePromptUsage(value: unknown): OpenCodeUsage | undefined {
  if (!record(value)) return undefined;
  // V2 omits optional zero counters. A supplied invalid counter is unknown,
  // not zero; never turn a partial or overflowing report into measured usage.
  const input = value.inputTokens;
  const output = value.outputTokens;
  const reasoning = value.thoughtTokens === undefined ? 0 : value.thoughtTokens;
  const cacheRead =
    value.cachedReadTokens === undefined ? 0 : value.cachedReadTokens;
  const cacheWrite =
    value.cachedWriteTokens === undefined ? 0 : value.cachedWriteTokens;
  if (
    !counter(input) ||
    !counter(output) ||
    !counter(reasoning) ||
    !counter(cacheRead) ||
    !counter(cacheWrite) ||
    !counter(output + reasoning) ||
    !counter(input + output + reasoning + cacheRead + cacheWrite)
  )
    return undefined;
  return {
    input_tokens: input,
    output_tokens: output + reasoning,
    reasoning_tokens: reasoning,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}
