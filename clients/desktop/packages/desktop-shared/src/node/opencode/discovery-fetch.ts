import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 16 * 1024 * 1024;

/** Bound decoded bytes before the SDK's JSON/SSE parsers retain them. */
export function createOpenCodeDiscoveryFetch(
  signal: AbortSignal,
  fail: (error: Error) => void,
): FetchLike {
  let discoveryBytes = 0;
  return async (url, init): Promise<Response> => {
    const requestSignal = init?.signal
      ? AbortSignal.any([signal, init.signal])
      : signal;
    requestSignal.throwIfAborted();
    const response = await fetch(url, { ...init, signal: requestSignal });
    if (!response.body) return response;
    let responseBytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller): void {
          responseBytes += chunk.byteLength;
          discoveryBytes += chunk.byteLength;
          if (
            responseBytes > MAX_RESPONSE_BYTES ||
            discoveryBytes > MAX_DISCOVERY_BYTES
          ) {
            const error = new Error(
              'OpenCode MCP response exceeds the size limit.',
            );
            // Abort the whole discovery, including concurrent SSE requests and
            // reconnections; an SDK transport error alone need not be fatal.
            fail(error);
            throw error;
          }
          controller.enqueue(chunk);
        },
      }),
      { signal: requestSignal },
    );
    const bounded = new Response(body, response);
    // Preserve fetch metadata used by EventSource when following redirects.
    Object.defineProperties(bounded, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return bounded;
  };
}
