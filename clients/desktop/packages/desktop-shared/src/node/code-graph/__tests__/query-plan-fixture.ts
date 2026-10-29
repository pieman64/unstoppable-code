/**
 * Phase 18 query-plan fixture and oracles.
 *
 * The oracles are the pre-phase-18 implementations, kept verbatim, so tests
 * can prove the rewritten queries return the same results (and, where the
 * old order was only a tie-break, the documented order).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { CodeGraphSearchResult } from '../../../types/code-graph';
import { CodeGraphEngine } from '../engine';
import { canonicalQualifiedName } from '../ids';
import { repositoryRowId } from '../ids';
import {
  openCodeGraphDatabase,
  requireNumber,
  requireRow,
  requireString,
  type CodeGraphDatabase,
  type CodeGraphSqlValue,
  type CodeGraphStatement,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';

export interface RealisticFixtureGraph {
  root: string;
  dbPath: string;
  cleanup: () => void;
}

/**
 * Builds a graph of a copy of the engine's own source tree (TypeScript
 * sources, tests, and a markdown index that links into them): hundreds of
 * symbols, thousands of resolved and unresolved edges, cycles, children,
 * test links and doc links.
 */
export async function buildRealisticFixtureGraph(
  repoIds: readonly string[] = ['fixture'],
  extraFiles: Readonly<Record<string, string>> = {},
  /** Adjusts the migrated, still-empty database before the cold build. */
  prepareDatabase?: (db: CodeGraphDatabase) => void,
): Promise<RealisticFixtureGraph> {
  const root = mkdtempSync(path.join(tmpdir(), 'code-graph-plan-fixture-'));
  const source = path.resolve(__dirname, '..');
  const repositories = repoIds.map((repoId) => {
    const rootPath = path.join(root, repoId);
    cpSync(source, rootPath, {
      recursive: true,
      filter: (entry) => !entry.endsWith('.db'),
    });
    writeFileSync(
      path.join(rootPath, 'INDEX.md'),
      [
        '# Code graph engine',
        '',
        '- [Store](store/graph-store.ts)',
        '- [Queries](query/queries.ts)',
        '- [Search](store/fts.ts)',
        '- [Database](store/database.ts)',
        '',
      ].join('\n'),
    );
    for (const [relativePath, content] of Object.entries(extraFiles)) {
      mkdirSync(path.dirname(path.join(rootPath, relativePath)), {
        recursive: true,
      });
      writeFileSync(path.join(rootPath, relativePath), content);
    }
    return { repoId, rootPath };
  });
  const dbPath = path.join(root, '.graph', 'graph.db');
  if (prepareDatabase !== undefined) {
    const db = openCodeGraphDatabase(dbPath);
    try {
      runCodeGraphMigrations(db);
      prepareDatabase(db);
    } finally {
      db.close();
    }
  }
  const engine = await CodeGraphEngine.open({ dbPath, repositories });
  try {
    await engine.buildOrUpdate();
  } finally {
    engine.close();
  }
  return {
    root,
    dbPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The schema-v3 index set: the full (non-partial) edge target index and no
 * NOCASE name index. Facts are untouched. */
export function useSchemaV3Indexes(db: CodeGraphDatabase): void {
  db.exec(`DROP INDEX IF EXISTS idx_symbols_name_nocase;
    DROP INDEX IF EXISTS idx_edges_target_symbol;
    CREATE INDEX idx_edges_target_symbol ON edges(target_symbol_id);`);
}

/** Every user index's name and definition, in name order. */
export function indexDefinitions(
  db: CodeGraphDatabase,
): Array<{ name: string; sql: string }> {
  return db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
    )
    .all()
    .map((value) => {
      const row = requireRow(value);
      return {
        name: requireString(row, 'name'),
        sql: requireString(row, 'sql'),
      };
    });
}

/** EXPLAIN QUERY PLAN details for one statement with its bound values. */
export function queryPlan(
  db: CodeGraphDatabase,
  sql: string,
  params: readonly CodeGraphSqlValue[],
): string[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((value) => requireString(requireRow(value), 'detail'));
}

export interface RecordedStatement {
  sql: string;
  params: CodeGraphSqlValue[];
}

/** Wraps a database so every executed statement and its values are recorded. */
export function recordingDatabase(db: CodeGraphDatabase): {
  db: CodeGraphDatabase;
  executed: RecordedStatement[];
} {
  const executed: RecordedStatement[] = [];
  return {
    executed,
    db: {
      exec: (sql: string): void => db.exec(sql),
      close: (): void => db.close(),
      prepare: (sql: string): CodeGraphStatement => {
        const statement = db.prepare(sql);
        return {
          all: (...params: CodeGraphSqlValue[]): unknown[] => {
            executed.push({ sql, params });
            return statement.all(...params);
          },
          get: (...params: CodeGraphSqlValue[]): unknown => {
            executed.push({ sql, params });
            return statement.get(...params);
          },
          run: (
            ...params: CodeGraphSqlValue[]
          ): ReturnType<CodeGraphStatement['run']> => {
            executed.push({ sql, params });
            return statement.run(...params);
          },
        };
      },
    },
  };
}

function oracleSymbolIdFor(
  db: CodeGraphDatabase,
  qualifiedName: string,
  repoId?: string,
): string | null {
  const row =
    repoId === undefined
      ? db
          .prepare('SELECT id FROM symbols WHERE qualified_name = ?')
          .get(qualifiedName)
      : db
          .prepare(
            `SELECT s.id FROM symbols s
             JOIN repositories r ON r.id = s.repository_id AND r.repo_id = ?
             WHERE s.qualified_name = ?`,
          )
          .get(repoId, qualifiedName);
  return row === undefined ? null : requireString(requireRow(row), 'id');
}

/** Pre-phase-18 `CodeGraphQueryService.getImpactRadius` (recursive CTE). */
export function oracleImpactRadius(
  db: CodeGraphDatabase,
  qualifiedName: string,
  options?: { maxDepth?: number; maxNodes?: number },
  repoId?: string,
): Array<{
  qualifiedName: string;
  kind: string;
  filePath: string;
  depth: number;
}> {
  const id = oracleSymbolIdFor(
    db,
    canonicalQualifiedName(qualifiedName),
    repoId,
  );
  if (id === null) {
    return [];
  }
  const maxDepth = Math.max(1, Math.min(options?.maxDepth ?? 2, 5));
  const maxNodes = Math.max(1, Math.min(options?.maxNodes ?? 200, 1000));
  return db
    .prepare(
      `WITH RECURSIVE impact(symbol_id, depth) AS (
         SELECT id, 0 FROM symbols WHERE id = ?
         UNION
         SELECT id, 0 FROM symbols WHERE parent_symbol_id = ?
         UNION
         SELECT e.source_symbol_id, i.depth + 1
         FROM edges e JOIN impact i ON e.target_symbol_id = i.symbol_id
         WHERE e.source_symbol_id IS NOT NULL
           AND e.kind IN ('CALLS', 'IMPORTS_FROM', 'REFERENCES', 'DOCUMENTS', 'IPC_INVOKES', 'USES_PIPELINE_ACTION')
           AND i.depth < ?
       )
       SELECT DISTINCT s.qualified_name, s.kind, f.relative_path, MIN(i.depth) AS depth
       FROM impact i
       JOIN symbols s ON s.id = i.symbol_id
       JOIN files f ON f.id = s.file_id
       WHERE i.depth > 0
       GROUP BY s.id
       ORDER BY depth, s.qualified_name
       LIMIT ?`,
    )
    .all(id, id, maxDepth, maxNodes)
    .map((value) => {
      const row = requireRow(value);
      return {
        qualifiedName: requireString(row, 'qualified_name'),
        kind: requireString(row, 'kind'),
        filePath: requireString(row, 'relative_path'),
        depth: requireNumber(row, 'depth'),
      };
    });
}

/** Pre-phase-18 `CodeGraphStore.listTopDegreeSymbols` (UNION ALL degree). */
export function oracleTopDegreeSymbols(
  db: CodeGraphDatabase,
  repoId?: string,
  limit = 20,
): Array<{
  qualifiedName: string;
  kind: string;
  filePath: string;
  degree: number;
}> {
  const params: Array<string | number> = [];
  let sourceClause = 'e.source_symbol_id IS NOT NULL';
  let targetClause = 'e.target_symbol_id IS NOT NULL';
  if (repoId !== undefined) {
    const repositoryRow = repositoryRowId(repoId);
    sourceClause += ' AND e.repository_id = ?';
    targetClause += ' AND e.repository_id = ?';
    params.push(repositoryRow, repositoryRow);
  }
  params.push(Math.max(1, Math.min(limit, 1000)));
  return db
    .prepare(
      `WITH degree AS (
         SELECT e.source_symbol_id AS symbol_id FROM edges e WHERE ${sourceClause}
         UNION ALL
         SELECT e.target_symbol_id AS symbol_id FROM edges e WHERE ${targetClause}
       )
       SELECT s.qualified_name, s.kind, f.relative_path, COUNT(*) AS degree
       FROM degree d
       JOIN symbols s ON s.id = d.symbol_id
       JOIN files f ON f.id = s.file_id
       GROUP BY s.id
       ORDER BY degree DESC, s.qualified_name
       LIMIT ?`,
    )
    .all(...params)
    .map((value) => {
      const row = requireRow(value);
      return {
        qualifiedName: requireString(row, 'qualified_name'),
        kind: requireString(row, 'kind'),
        filePath: requireString(row, 'relative_path'),
        degree: requireNumber(row, 'degree'),
      };
    });
}

// --- Pre-phase-18 store/fts.ts search, verbatim -----------------------------

function foldForFragmentSearch(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

const oracleFragmentFtsAvailability = new WeakMap<CodeGraphDatabase, boolean>();

function hasFragmentFts(db: CodeGraphDatabase): boolean {
  const cached = oracleFragmentFtsAvailability.get(db);
  if (cached !== undefined) return cached;
  const available =
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_fragment_fts'`,
      )
      .get() !== undefined;
  oracleFragmentFtsAvailability.set(db, available);
  return available;
}

function escapeLikePrefix(value: string): string {
  return `${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

export function oracleSearchSymbolFts(
  db: CodeGraphDatabase,
  query: string,
  limit: number,
  repoId?: string,
): CodeGraphSearchResult[] {
  const tokens = query
    .normalize('NFC')
    .match(new RegExp('[\\p{L}\\p{N}_]+', 'gu'));
  if (tokens === null || tokens.length === 0) return [];
  // Bound query complexity independently of graph size. Never interpret FTS syntax.
  if (tokens.length > 16 || tokens.some((token) => token.length > 256))
    throw new Error(
      'Symbol search accepts at most 16 terms of 256 characters each.',
    );
  const terms = tokens;
  const sanitized = terms.map((token) => `"${token}"*`).join(' ');
  const count = Math.max(1, Math.min(500, Math.floor(limit)));
  const fields = `fts.symbol_id AS symbol_id, fts.name AS name, fts.qualified_name AS qualified_name,
    fts.file_path AS file_path, s.kind AS kind, s.line_start AS line_start`;
  const from = `FROM symbol_fts fts JOIN symbols s ON s.id = fts.symbol_id
    JOIN repositories r ON r.id = s.repository_id`;
  const scope = repoId === undefined ? '' : ' AND r.repo_id = ?';
  const parameters = repoId === undefined ? [] : [repoId];
  // Exact and prefix name matches must be selected independently of the
  // broad FTS query. Otherwise signature/path hits with a better BM25 score
  // can consume the primary LIMIT before the application-level name ranking
  // sees the exact symbol. This query is bounded by the caller's result count
  // and uses the symbols repository/name index where a repository is scoped.
  const priority = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name AS name, s.qualified_name AS qualified_name,
         f.relative_path AS file_path, s.kind AS kind, s.line_start AS line_start
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN repositories r ON r.id = s.repository_id
       WHERE (s.name = ? COLLATE NOCASE OR s.name LIKE ? ESCAPE '\\' COLLATE NOCASE)${scope}
       ORDER BY CASE WHEN s.name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
         s.qualified_name, s.id
       LIMIT ?`,
    )
    .all(
      query.normalize('NFC'),
      escapeLikePrefix(query.normalize('NFC')),
      ...parameters,
      query.normalize('NFC'),
      count,
    );
  const primary = db
    .prepare(
      `SELECT ${fields} ${from} WHERE symbol_fts MATCH ?${scope}
    ORDER BY bm25(symbol_fts), fts.qualified_name, fts.symbol_id LIMIT ?`,
    )
    .all(sanitized, ...parameters, count);
  // Interior fragments use a Unicode-folded trigram FTS index. The primary
  // token-prefix query remains authoritative when it already fills the limit.
  // Short terms cannot use a trigram by themselves; when a longer term exists,
  // filter those short terms inside the bounded indexed candidate set.
  const foldedTerms = terms.map(foldForFragmentSearch);
  const indexedTerms = foldedTerms.filter((term) => term.length >= 3);
  const fragmentQuery = indexedTerms.map((term) => `"${term}"`).join(' AND ');
  const candidateLimit = Math.min(5_000, Math.max(count * 20, count));
  const fallback =
    primary.length >= count || fragmentQuery.length === 0 || !hasFragmentFts(db)
      ? []
      : db
          .prepare(
            `SELECT fragments_fts.symbol_id AS symbol_id, s.name AS name,
               s.qualified_name AS qualified_name, f.relative_path AS file_path,
               s.kind AS kind, s.line_start AS line_start
             FROM symbol_fragment_fts fragments_fts
             JOIN symbols s ON s.id = fragments_fts.symbol_id
             JOIN files f ON f.id = s.file_id
             JOIN repositories r ON r.id = s.repository_id
             WHERE symbol_fragment_fts MATCH ?${scope}
             ORDER BY bm25(symbol_fragment_fts), s.qualified_name, fragments_fts.symbol_id
             LIMIT ?`,
          )
          .all(fragmentQuery, ...parameters, candidateLimit)
          .filter((value) => {
            const row = requireRow(value);
            const name = foldForFragmentSearch(requireString(row, 'name'));
            const qualifiedName = foldForFragmentSearch(
              requireString(row, 'qualified_name'),
            );
            return foldedTerms.every(
              (term) => name.includes(term) || qualifiedName.includes(term),
            );
          })
          .slice(0, count);
  const needle = foldForFragmentSearch(query);
  const primaryIds = new Set(
    primary.map((value) => requireString(requireRow(value), 'symbol_id')),
  );
  const rows = new Map<string, CodeGraphSearchResult>();
  for (const value of [...priority, ...primary, ...fallback]) {
    const row = requireRow(value);
    const symbolId = requireString(row, 'symbol_id');
    const name = requireString(row, 'name')
      .normalize('NFC')
      .toLocaleLowerCase('en-US');
    rows.set(symbolId, {
      matchKind:
        name === needle
          ? 'exact'
          : name.startsWith(needle)
            ? 'prefix'
            : primaryIds.has(symbolId)
              ? 'token-prefix'
              : 'fragment',
      symbolId,
      name: requireString(row, 'name'),
      qualifiedName: requireString(row, 'qualified_name'),
      kind: requireString(row, 'kind'),
      filePath: requireString(row, 'file_path'),
      lineStart: requireNumber(row, 'line_start'),
    });
  }
  const rank = (hit: CodeGraphSearchResult): number => {
    const name = foldForFragmentSearch(hit.name);
    return name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
  };
  // Stable sort retains BM25 order within equally ranked primary hits.
  return Array.from(rows.values())
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, count);
}
