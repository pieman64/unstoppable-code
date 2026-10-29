// Thin wrappers over the wave-1 capture listener: start it on loopback,
// summarize every channel, and turn canary searches into ledger statuses.
import { writeFile } from 'node:fs/promises';
import { createCaptureServer } from '../../../mock-server/capture-server.mjs';
import {
  assertSnapshotCanaryAbsent,
  findSnapshotCanary,
} from '../../../mock-server/outbound-capture.mjs';
import { STATUS } from './ledger.mjs';

export {
  registerScenario,
  clearScenario,
} from '../../../mock-server/control-plane.mjs';

/**
 * Start a dedicated capture listener on 127.0.0.1 with an ephemeral port.
 *
 * @param {Partial<import('../../../mock-server/outbound-capture.mjs').CaptureLimits>} [limits]
 */
export async function startCapture(limits = {}) {
  const { server, capture, close } = createCaptureServer(limits);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Capture listener has no port');
  return {
    capture,
    close,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

/** Channel-level summary of a snapshot: nothing is dropped from the counts. */
export function summarizeSnapshot(snapshot) {
  const bySurface = {};
  for (const record of snapshot.records) {
    const key = `${record.kind}:${record.surface ?? 'unrouted'}:${record.path ?? ''}`;
    bySurface[key] = (bySurface[key] ?? 0) + 1;
  }
  return {
    counts: snapshot.counts,
    kinds: snapshot.kinds,
    bytes: snapshot.bytes,
    overflow: snapshot.overflow,
    bySurface,
    records: snapshot.records.map((record) => ({
      seq: record.seq,
      kind: record.kind,
      surface: record.surface,
      method: record.method,
      path: record.path,
      byteLength: record.byteLength,
      prompt: record.prompt,
      complete: record.complete,
      incomplete: record.incomplete,
      marker: record.marker,
      status: record.status,
      reply: record.reply,
    })),
    diagnostics: snapshot.diagnostics,
  };
}

/**
 * Evaluate one canary against a snapshot.
 *
 * - expected `absent`: `pass` only when assertSnapshotCanaryAbsent proves it
 *   (no hit, nothing dropped, no evidence gap); `fail` on any hit; `blocked`
 *   when a gap prevents the proof.
 * - expected `accepted`: `pass` when present in at least one complete full
 *   prompt; hits are always listed.
 *
 * @returns {{ status: string, hits: object[], detail: string }}
 */
export function evaluateCanary(snapshot, token, expected, filter) {
  const hits = findSnapshotCanary(snapshot, token).filter((hit) =>
    filter
      ? filter(snapshot.records.find((record) => record.seq === hit.seq))
      : true,
  );
  if (expected === 'accepted') {
    const full = hits.filter((hit) => hit.prompt === 'full' && hit.complete);
    return {
      status: full.length > 0 ? STATUS.pass : STATUS.fail,
      hits,
      detail:
        full.length > 0
          ? `present in ${full.length} complete full prompt(s)`
          : 'accepted source not observed in any complete full prompt',
    };
  }
  if (hits.length > 0)
    return {
      status: STATUS.fail,
      hits,
      detail: `found in ${hits.length} record(s)`,
    };
  try {
    const { searched } = assertSnapshotCanaryAbsent(
      snapshot,
      [token],
      filter ? { filter } : {},
    );
    return {
      status: STATUS.pass,
      hits,
      detail: `absent from ${searched} searched record(s)`,
    };
  } catch (error) {
    return {
      status: STATUS.blocked,
      hits,
      detail: String(error?.message ?? error).slice(0, 500),
    };
  }
}

/** Write a full snapshot (retained raw bytes included) as JSON evidence. */
export async function writeSnapshot(file, snapshot) {
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Decode a record's retained bytes to text (for size breakdowns). */
export function recordText(record) {
  return Buffer.from(record.rawBase64, 'base64').toString('utf8');
}
