import type {
  CodeGraphPathRequest,
  CodeGraphPathResult,
  CodeGraphPathHop,
} from '../../../types/code-graph-tools';
import { canonicalQualifiedName } from '../ids';
import {
  requireRow,
  requireString,
  requireNumber,
  optionalString,
  optionalNumber,
  type CodeGraphDatabase,
} from '../store/database';

/** All limits bound work, including unsuccessful searches. Never load the graph. */
export function findRelationshipPath(
  db: CodeGraphDatabase,
  input: CodeGraphPathRequest,
): CodeGraphPathResult {
  const cap = (
    value: number | undefined,
    fallback: number,
    maximum: number,
  ): number =>
    value === undefined || !Number.isFinite(value)
      ? fallback
      : Math.max(1, Math.min(maximum, Math.floor(value)));
  const limits = {
    maxDepth: cap(input.maxDepth, 6, 12),
    maxNodes: cap(input.maxNodes, 200, 500),
    maxEdges: 5000,
  };
  let visitedEdges = 0;
  const seen = new Set<string>();
  const result = (
    status: CodeGraphPathResult['status'],
    hops: CodeGraphPathHop[] = [],
  ): CodeGraphPathResult => ({
    status,
    hops,
    visitedNodes: seen.size,
    visitedEdges,
    limits,
  });
  const endpoint = (
    name: string,
  ): Array<{ id: string; repositoryId: string }> =>
    db
      .prepare(
        `SELECT s.id, s.repository_id FROM symbols s JOIN repositories r ON r.id = s.repository_id
     WHERE s.qualified_name = ? AND (? IS NULL OR r.repo_id = ?) LIMIT 2`,
      )
      .all(
        canonicalQualifiedName(name),
        input.repoId ?? null,
        input.repoId ?? null,
      )
      .map((value) => {
        const row = requireRow(value);
        return {
          id: requireString(row, 'id'),
          repositoryId: requireString(row, 'repository_id'),
        };
      });
  const starts = endpoint(input.target);
  const ends = endpoint(input.to);
  if (starts.length === 0 || ends.length === 0)
    return result('endpoint-not-found');
  if (starts.length !== 1 || ends.length !== 1)
    return result('ambiguous-endpoint');
  const start = starts[0];
  const end = ends[0];
  seen.add(start.id);
  if (start.id === end.id) return result('found');
  if (start.repositoryId !== end.repositoryId) return result('no-path');
  const previous = new Map<string, { parent: string; hop: CodeGraphPathHop }>();
  const queue = [{ id: start.id, depth: 0 }];
  let exhausted = false;
  const directed = input.mode === 'call-path';
  const statement = (
    reverse: boolean,
  ): ReturnType<CodeGraphDatabase['prepare']> =>
    db.prepare(`SELECT e.id, e.source_symbol_id, e.target_symbol_id, e.kind,
    a.qualified_name AS source_name, b.qualified_name AS target_name,
    f.relative_path, e.line, e.confidence_tier, e.confidence_score, e.resolver_id,
    substr(e.evidence_json, 1, 2048) AS evidence, length(e.evidence_json) > 2048 AS evidence_truncated
    FROM (SELECT * FROM edges INDEXED BY ${reverse ? 'idx_edges_target_symbol' : 'idx_edges_source_symbol'}
      WHERE repository_id = ? AND ${reverse ? 'target_symbol_id' : 'source_symbol_id'} = ?${directed ? " AND kind = 'CALLS'" : ''} ORDER BY rowid LIMIT ?) e
    LEFT JOIN symbols a ON a.id = e.source_symbol_id AND a.repository_id = e.repository_id
    LEFT JOIN symbols b ON b.id = e.target_symbol_id AND b.repository_id = e.repository_id
    LEFT JOIN files f ON f.id = e.source_file_id`);

  const outgoing = statement(false);
  const incoming = directed ? null : statement(true);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (visitedEdges >= limits.maxEdges) return result('budget-exhausted');
    const remaining = limits.maxEdges - visitedEdges;
    const rows = outgoing.all(start.repositoryId, current.id, remaining + 1);
    if (incoming !== null && rows.length <= remaining)
      rows.push(
        ...incoming.all(
          start.repositoryId,
          current.id,
          remaining - rows.length + 1,
        ),
      );
    for (const value of rows) {
      if (visitedEdges >= limits.maxEdges) return result('budget-exhausted');
      visitedEdges += 1;
      const row = requireRow(value);
      if (
        (directed && requireString(row, 'kind') !== 'CALLS') ||
        optionalString(row, 'source_name') === null ||
        optionalString(row, 'target_name') === null ||
        optionalString(row, 'relative_path') === null
      )
        continue;
      const source = requireString(row, 'source_symbol_id');
      const forward = source === current.id;
      const next = forward ? requireString(row, 'target_symbol_id') : source;
      if (seen.has(next)) continue;
      if (current.depth >= limits.maxDepth) {
        exhausted = true;
        continue;
      }
      if (seen.size >= limits.maxNodes) return result('budget-exhausted');
      const hop: CodeGraphPathHop = {
        source: requireString(row, 'source_name'),
        target: requireString(row, 'target_name'),
        kind: requireString(row, 'kind'),
        direction: forward ? 'forward' : 'reverse',
        filePath: requireString(row, 'relative_path'),
        line: optionalNumber(row, 'line'),
        confidenceTier: requireString(row, 'confidence_tier'),
        confidenceScore: requireNumber(row, 'confidence_score'),
        resolverId: optionalString(row, 'resolver_id'),
        evidence: requireString(row, 'evidence'),
        evidenceTruncated: requireNumber(row, 'evidence_truncated') === 1,
      };
      seen.add(next);
      previous.set(next, { parent: current.id, hop });
      if (next === end.id) {
        const hops: CodeGraphPathHop[] = [];
        let cursor = next;
        while (cursor !== start.id) {
          const entry = previous.get(cursor);
          if (entry === undefined)
            throw new Error('Broken relationship path predecessor');
          hops.push(entry.hop);
          cursor = entry.parent;
        }
        return result('found', hops.reverse());
      }
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }
  return result(exhausted ? 'budget-exhausted' : 'no-path');
}
