import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const P6C_FIXTURE_BYTE_LENGTH = 8 * 1024 * 1024;
export const P6C_FIXTURE_SHA256 =
  '939d5d91103ae26c0595b1a407e9829b87d311d59c2735ff5b5e73f54cabed30';
export const P6C_FIXTURE_MARKER = 'Canopy-CP6cStructured';

/** The exact canonical, pretty-printed structured result used by the probe. */
export function createP6CStructuredPayload() {
  const structured = { tag: 'P6C_HEAD', payload: '', tail: 'P6C_TAIL' };
  structured.payload = 'x'.repeat(
    P6C_FIXTURE_BYTE_LENGTH -
      Buffer.byteLength(JSON.stringify(structured, null, 2)),
  );
  const body = JSON.stringify(structured, null, 2);
  const byteLength = Buffer.byteLength(body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  assert.equal(byteLength, P6C_FIXTURE_BYTE_LENGTH);
  assert.equal(sha256, P6C_FIXTURE_SHA256);
  return { structured, body, byteLength, sha256 };
}

/**
 * Prepare a fresh fake-Codex perf-script run. The large body is serialized to
 * the fixture file, but the returned receipt deliberately does not retain it.
 */
export function prepareP6CCodexFixture(runtimeDir) {
  const gateDir = path.join(runtimeDir, 'gate');
  const statePath = path.join(runtimeDir, 'state.json');
  const scriptPath = path.join(runtimeDir, `${P6C_FIXTURE_MARKER}.json`);
  mkdirSync(gateDir, { recursive: true });
  writeFileSync(path.join(gateDir, 'mode'), 'manual');
  writeFileSync(
    statePath,
    JSON.stringify({ nextThread: 1, nextTurn: 1, threads: {} }),
  );

  const { structured, byteLength, sha256 } = createP6CStructuredPayload();
  const started = {
    type: 'mcpToolCall',
    id: 'p6c-mcp-1',
    server: 'fixture-server',
    tool: 'structured8m',
    arguments: {},
    status: 'inProgress',
    result: null,
    error: null,
  };
  const completed = {
    ...started,
    status: 'completed',
    result: { content: [], structuredContent: structured, _meta: null },
  };
  writeFileSync(
    scriptPath,
    JSON.stringify({
      gateDir,
      chunks: [
        {
          notifications: [
            { method: 'item/started', params: { item: started } },
          ],
        },
        {
          notifications: [
            { method: 'item/completed', params: { item: completed } },
            {
              method: 'turn/completed',
              params: {
                turn: { items: [], status: 'completed', error: null },
              },
            },
          ],
        },
      ],
    }),
  );
  return { gateDir, scriptPath, statePath, byteLength, sha256 };
}

/** Hash a persisted fixture artifact without retaining its complete body. */
export async function hashFileSha256(filePath) {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(filePath)) {
    byteLength += chunk.length;
    hash.update(chunk);
  }
  return { byteLength, sha256: hash.digest('hex') };
}
