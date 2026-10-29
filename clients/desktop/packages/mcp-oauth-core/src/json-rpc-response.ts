export const MCP_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Streamable-HTTP MCP servers require clients to accept both JSON and SSE
 * responses on POST; spec-compliant servers reject a JSON-only Accept header
 * with 406 Not Acceptable.
 */
export const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';

export interface McpJsonRpcMessage {
  message: Record<string, unknown>;
  bytesRead: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findSseEventSeparator(
  buffer: string,
): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function parseSseEventJsonRpc(
  eventBlock: string,
): Record<string, unknown> | null {
  const data = eventBlock
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (isRecord(parsed) && ('result' in parsed || 'error' in parsed)) {
      return parsed;
    }
  } catch {
    // Non-JSON keepalive/event payloads are ignored.
  }
  return null;
}

async function readSseJsonRpcMessage(
  response: Response,
): Promise<McpJsonRpcMessage> {
  const body = response.body;
  if (!body) {
    throw new Error('Empty SSE response body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MCP_MAX_RESPONSE_BYTES) {
          throw new Error(
            `MCP response exceeds ${String(MCP_MAX_RESPONSE_BYTES)} bytes`,
          );
        }
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += decoder.decode();
      let separator = findSseEventSeparator(buffer);
      while (separator) {
        const eventBlock = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const message = parseSseEventJsonRpc(eventBlock);
        if (message) return { message, bytesRead: totalBytes };
        separator = findSseEventSeparator(buffer);
      }
      if (done) {
        const message = parseSseEventJsonRpc(buffer);
        if (message) return { message, bytesRead: totalBytes };
        throw new Error('SSE stream ended without a JSON-RPC response');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function readBoundedJsonBody(
  response: Response,
): Promise<McpJsonRpcMessage> {
  const body = response.body;
  if (!body) {
    throw new Error('Empty JSON response body');
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MCP_MAX_RESPONSE_BYTES) {
        throw new Error(
          `MCP response exceeds ${String(MCP_MAX_RESPONSE_BYTES)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const message: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(message)) {
    throw new Error('MCP response must be a JSON object');
  }
  return { message, bytesRead: totalBytes };
}

export async function readMcpJsonRpcMessage(
  response: Response,
): Promise<McpJsonRpcMessage> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > MCP_MAX_RESPONSE_BYTES
    ) {
      throw new Error(
        `MCP response has invalid Content-Length ${contentLengthHeader}`,
      );
    }
  }
  const contentType = response.headers.get('content-type') ?? '';
  return contentType.includes('text/event-stream')
    ? readSseJsonRpcMessage(response)
    : readBoundedJsonBody(response);
}
