// Schema 2's capture queries, copied verbatim from `commit-log.ts` before
// CAN-5563 replaced them with the schema 3 summary. They scan a path's whole
// history, so they are the oracle that summary must match exactly.
import type { DatabaseSync } from 'node:sqlite';

import type {
  W5CaptureFile,
  W5FileChainEvidence,
  W5FileLogEvidence,
} from '../../capture-contract';

const malformed = (column: string): string =>
  `(${column} IS NOT NULL AND (length(CAST(${column} AS BLOB)) != 64 OR ltrim(${column}, '0123456789abcdef') != ''))`;

const CHAIN_QUERY = `SELECT COUNT(*) AS decisions,
      COALESCE(MAX(position = 1 AND previous IS NULL), 0) AS starts_absent,
      COALESCE(SUM(CASE
        WHEN ${malformed('previous')} OR ${malformed('image')} THEN 1
        WHEN position = 1 THEN 0
        ELSE previous IS NOT before END), 0) AS discontinuities
      FROM (SELECT previous_fingerprint AS previous, new_fingerprint AS image,
        LAG(new_fingerprint) OVER (ORDER BY commit_id) AS before,
        ROW_NUMBER() OVER (ORDER BY commit_id) AS position
        FROM w5_commit_files WHERE path = ?)`;

const FILES_QUERY = `SELECT c.commit_id, c.state,
      CASE WHEN f.previous_fingerprint IS NULL THEN NULL ELSE hex(substr(CAST(f.previous_fingerprint AS BLOB), 1, 65)) END AS previous_fingerprint,
      CASE WHEN f.new_fingerprint IS NULL THEN NULL ELSE hex(substr(CAST(f.new_fingerprint AS BLOB), 1, 65)) END AS new_fingerprint
      FROM w5_commit_files f JOIN w5_commits c USING (commit_id)
      WHERE f.path = ? AND (c.state != 'applied' OR c.commit_id = (
        SELECT latest.commit_id FROM w5_commit_files latest
        JOIN w5_commits decision USING (commit_id)
        WHERE latest.path = f.path AND decision.state = 'applied'
        ORDER BY latest.commit_id DESC LIMIT 1
      )) ORDER BY c.commit_id`;

const COUNTS_QUERY = `SELECT COUNT(*) AS retained,
          (SELECT COUNT(*) FROM w5_commits WHERE state != 'applied') AS unresolved
         FROM w5_commits`;

export type ChainValues = Omit<W5FileChainEvidence, 'file'>;

export function schemaV2Chain(db: DatabaseSync, path: string): ChainValues {
  const row = db.prepare(CHAIN_QUERY).get(path);
  return {
    decisions: Number(row?.decisions),
    startsAbsent: Number(row?.starts_absent) === 1,
    discontinuities: Number(row?.discontinuities),
  };
}

/** Every path with history, by path. */
export function schemaV2Chains(db: DatabaseSync): Map<string, ChainValues> {
  const chains = new Map<string, ChainValues>();
  for (const row of db
    .prepare('SELECT DISTINCT path FROM w5_commit_files ORDER BY path')
    .all()) {
    const path = String(row.path);
    chains.set(path, schemaV2Chain(db, path));
  }
  return chains;
}

/** What schema 2's capture returned for these files' evidence and counts. */
export function schemaV2Capture(
  db: DatabaseSync,
  files: readonly { file: W5CaptureFile; path: string }[],
): {
  retainedCommits: number;
  unresolvedCommits: number;
  files: W5FileLogEvidence[] | 'malformed';
  chains: W5FileChainEvidence[];
} {
  const counts = db.prepare(COUNTS_QUERY).get();
  const decode = (value: unknown): string | null =>
    typeof value === 'string'
      ? Buffer.from(value, 'hex').toString('utf8')
      : null;
  const evidence: W5FileLogEvidence[] = [];
  let malformedRow = false;
  for (const { file, path } of files) {
    for (const row of db.prepare(FILES_QUERY).all(path)) {
      const previousFingerprint = decode(row.previous_fingerprint);
      const newFingerprint = decode(row.new_fingerprint);
      const state = String(row.state);
      if (
        [previousFingerprint, newFingerprint].some(
          (value) => value !== null && !/^[a-f0-9]{64}$/.test(value),
        ) ||
        (state !== 'committed' &&
          state !== 'applied' &&
          state !== 'recovery-required')
      ) {
        malformedRow = true;
        continue;
      }
      evidence.push({
        file,
        commitId: Number(row.commit_id),
        state,
        previousFingerprint,
        newFingerprint,
      });
    }
  }
  return {
    retainedCommits: Number(counts?.retained),
    unresolvedCommits: Number(counts?.unresolved),
    files: malformedRow ? 'malformed' : evidence,
    chains: files.map(({ file, path }) => ({
      file,
      ...schemaV2Chain(db, path),
    })),
  };
}
