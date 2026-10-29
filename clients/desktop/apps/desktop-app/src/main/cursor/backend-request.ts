import { CURSOR_RUNTIME_VERSION } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { isRecord } from '../lib/type-guards';

/**
 * Request headers for a read-only call to Cursor's backend with the managed
 * sign-in's access token, identifying as the pinned CLI the token belongs to.
 */
export function cursorBackendHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': `cli-${CURSOR_RUNTIME_VERSION}`,
  };
}

/**
 * Read a JSON object body with a byte bound. Returns null for a missing body,
 * a body over `maxBytes`, malformed JSON, or a non-object payload; the body is
 * always released. The raw payload never leaves this function.
 */
export async function readCursorBackendJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown> | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
