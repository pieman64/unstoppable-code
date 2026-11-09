import { createHash } from 'node:crypto';
import path from 'node:path';
import { isoDay, writeJson, writeJsonl } from './fsHelpers.mjs';

/**
 * Seed the agent-observability audit trail. Factored out of the inline
 * `seedObservabilityData` helper in
 * `apps/desktop-app/tests/electron/observability.spec.mjs`.
 *
 * On-disk paths (`apps/desktop-app/src/main/lib/paths.ts`):
 *   - `agent-observability/audit/<day>.jsonl`  (one `AgentAuditEntry` per line)
 *   - `agent-observability/snapshot.json`      (optional read-cache snapshot)
 *   - `agent-observability/transcripts/<day>/<key>.jsonl` (per-entry sidecars
 *     for entries with `hasTranscript: true`)
 *
 * The service buckets audit entries by `entry.startedAt`'s UTC ISO day prefix.
 * `<day>` defaults to the latest entry's `startedAt` day. The transcript
 * sidecar storage key is derived exactly as the service does:
 * `sha256(eventType\nstartedAt\nid).slice(0,12)` joined with sanitized
 * `eventType` + `startedAt` segments (mirrors the spec helper).
 *
 * `AgentAuditEntry` shape lives in
 * `packages/execution-engine/src/types/observability.ts`.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {import('@canopy/execution-engine/types/observability').AgentAuditEntry[]} options.entries
 * @param {string} [options.day] override the `YYYY-MM-DD` bucket filename
 * @param {boolean | object} [options.snapshot] write `snapshot.json`. `true`
 *   (the default) writes a minimal snapshot embedding `entries` as
 *   `recentEntries`; pass a full snapshot object to control it, or `false` to
 *   skip. Mirrors the snapshot the spec writes.
 * @param {Record<string, unknown[]>} [options.transcripts] map of entry id →
 *   transcript lines. Entries listed here are written as JSONL sidecars under
 *   the transcripts dir; the entry should also carry `hasTranscript: true`.
 * @returns {{
 *   auditFilePath: string,
 *   day: string,
 *   snapshotFilePath?: string,
 *   transcriptFilePaths: Record<string, string>,
 * }}
 */
export function seedObservabilityAudit(options) {
  const {
    userDataDir,
    entries,
    day,
    snapshot = true,
    transcripts = {},
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedObservabilityAudit requires userDataDir');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(
      'seedObservabilityAudit requires a non-empty entries array',
    );
  }

  const resolvedDay = day ?? deriveDay(entries);
  const auditFilePath = path.join(
    userDataDir,
    'agent-observability',
    'audit',
    `${resolvedDay}.jsonl`,
  );
  writeJsonl(auditFilePath, entries);

  let snapshotFilePath;
  if (snapshot) {
    snapshotFilePath = path.join(
      userDataDir,
      'agent-observability',
      'snapshot.json',
    );
    const snapshotValue =
      snapshot === true ? buildDefaultSnapshot(entries) : snapshot;
    writeJson(snapshotFilePath, snapshotValue);
  }

  /** @type {Record<string, string>} */
  const transcriptFilePaths = {};
  for (const entry of entries) {
    const lines = transcripts[entry.id];
    if (!lines) {
      continue;
    }
    const transcriptPath = buildTranscriptFilePath(userDataDir, entry);
    writeJsonl(transcriptPath, lines);
    transcriptFilePaths[entry.id] = transcriptPath;
  }

  return {
    auditFilePath,
    day: resolvedDay,
    ...(snapshotFilePath ? { snapshotFilePath } : {}),
    transcriptFilePaths,
  };
}

function deriveDay(entries) {
  let latest = 0;
  for (const entry of entries) {
    const ms = Date.parse(entry?.startedAt ?? '');
    if (Number.isFinite(ms) && ms > latest) {
      latest = ms;
    }
  }
  return isoDay(latest > 0 ? latest : Date.now());
}

function buildDefaultSnapshot(entries) {
  return {
    version: 1,
    historicalMode: 'forward-only',
    retentionDays: 7,
    recentEntries: entries,
    usage: {
      updatedAt: new Date().toISOString(),
      providers: [],
    },
  };
}

function sanitizeTranscriptKeySegment(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'na';
}

function buildTranscriptFilePath(userDataDir, entry) {
  const startedAt = entry.startedAt;
  const eventType = entry.eventType;
  const day = startedAt.slice(0, 10);
  const digest = createHash('sha256')
    .update([eventType, startedAt, entry.id].join('\n'))
    .digest('hex')
    .slice(0, 12);
  const storageKey = [
    sanitizeTranscriptKeySegment(eventType),
    sanitizeTranscriptKeySegment(startedAt),
    digest,
  ].join('__');
  return path.join(
    userDataDir,
    'agent-observability',
    'transcripts',
    day,
    `${storageKey}.jsonl`,
  );
}
