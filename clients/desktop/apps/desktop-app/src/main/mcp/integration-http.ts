import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import { logMainProcessError } from '../lib/main-process-logging';

export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeds maximum size');
    this.name = 'RequestBodyTooLargeError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return undefined;
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function jsonRpcError(
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  };
}

// Error text can carry paths and workspace ids, so it goes to the log, never to the model.
export function jsonRpcInternalError(
  id: unknown,
  error: unknown,
): Record<string, unknown> {
  logMainProcessError('Injected MCP tool call failed', error);
  return jsonRpcError(id, -32603, 'Internal error');
}

export function getJsonRpcId(payload: unknown): unknown {
  return isRecord(payload) && 'id' in payload ? payload.id : null;
}

export function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(payload));
}

export function writePayloadTooLargeJsonRpc(res: ServerResponse): void {
  writeJson(res, 413, jsonRpcError(null, -32013, 'Payload too large'));
}
