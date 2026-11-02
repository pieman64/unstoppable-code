import {
  CODE_GRAPH_SCHEMA_VERSION,
  type CodeGraphSearchResult,
} from '../types/code-graph';
import {
  deleteMetadataValue,
  getMetadataValue,
  requireNumber,
  requireRow,
  requireString,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './database';

const SYMBOL_FTS_MAPPING_VERSION_KEY = 'symbol_fts_mapping_version';
const SYMBOL_FTS_MAPPING_VERSION_VALUE = '5:rowid-v1';

/**
 * The mapping is trusted only when a complete writer has published it for the
 * exact schema/writer pair. Its rowids are deleted through the mapping indexes;
 * validating every row against the facts here would turn each build into a
 * graph-wide scan.
 */
export function isSymbolFtsMappingTrusted(db: CodeGraphDatabase): boolean {
  return (
    getMetadataValue(db, 'schema_version') ===
      String(CODE_GRAPH_SCHEMA_VERSION) &&
    getMetadataValue(db, SYMBOL_FTS_MAPPING_VERSION_KEY) ===
      SYMBOL_FTS_MAPPING_VERSION_VALUE
  );
}

/**
 * Rebuilds both FTS tables and their rowid map in one existing/immediate
 * transaction.
 */
export function rebuildSymbolFts(db: CodeGraphDatabase): void {
  withImmediateTransaction(db, () => {
    rebuildSymbolFtsInTransaction(db);
  });
}

/**
 * Replaces only rows for these file ids from their final facts. Store writers
 * call `deleteSymbolFtsForFiles` before changing facts and this helper after
 * the replacement. The engine only repairs a still-untrusted mapping after
 * writers finish; it does not repeat a completed selective projection.
 */
export function replaceSymbolFtsForFiles(
  db: CodeGraphDatabase,
  fileIds: readonly string[],
): void {
  const uniqueFileIds = Array.from(new Set(fileIds));
  if (uniqueFileIds.length === 0) return;
  withImmediateTransaction(db, () => {
    ensureSymbolFtsMapping(db);
    deleteSymbolFtsRowsForFiles(db, uniqueFileIds);
    insertSymbolFtsRowsForFiles(db, uniqueFileIds);
  });
}

/**
 * Deletes mapped rows for file ids before the owning writer removes facts.
 */
export function deleteSymbolFtsForFiles(
  db: CodeGraphDatabase,
  fileIds: readonly string[],
): void {
  const uniqueFileIds = Array.from(new Set(fileIds));
  if (uniqueFileIds.length === 0) return;
  withImmediateTransaction(db, () => {
    ensureSymbolFtsMapping(db);
    deleteSymbolFtsRowsForFiles(db, uniqueFileIds);
  });
}

/**
 * Deletes a repository partition using the indexed opaque `repositories.id`
 * identity, not the public `repo_id` and never the FTS UNINDEXED symbol_id.
 */
export function deleteSymbolFtsForRepository(
  db: CodeGraphDatabase,
  repositoryRowId: string,
): void {
  withImmediateTransaction(db, () => {
    ensureSymbolFtsMapping(db);
    db.prepare(
      `DELETE FROM symbol_fts WHERE rowid IN (
           SELECT symbol_fts_rowid FROM symbol_fts_rows WHERE repository_id = ?
         )`,
    ).run(repositoryRowId);
    db.prepare(
      `DELETE FROM symbol_fragment_fts WHERE rowid IN (
           SELECT fragment_fts_rowid FROM symbol_fts_rows WHERE repository_id = ?
         )`,
    ).run(repositoryRowId);
    db.prepare('DELETE FROM symbol_fts_rows WHERE repository_id = ?').run(
      repositoryRowId,
    );
  });
}

function ensureSymbolFtsMapping(db: CodeGraphDatabase): void {
  if (!isSymbolFtsMappingTrusted(db)) {
    rebuildSymbolFtsInTransaction(db);
  }
}

function rebuildSymbolFtsInTransaction(db: CodeGraphDatabase): void {
  // Marker invalidation, both index resets, bounded facts projection and final
  // marker publication all share this transaction. A failed rebuild rolls all
  // of it back, including the previous marker. Keyset pages keep statement
  // result memory bounded independently of graph size.
  deleteMetadataValue(db, SYMBOL_FTS_MAPPING_VERSION_KEY);
  db.exec('DELETE FROM symbol_fts');
  db.exec('DELETE FROM symbol_fragment_fts');
  db.prepare('DELETE FROM symbol_fts_rows').run();

  const batchSize = 256;
  const firstPage = db.prepare(
    `SELECT s.id AS symbol_id, s.file_id AS file_id,
       s.repository_id AS repository_id, s.name AS name,
       s.qualified_name AS qualified_name,
       COALESCE(s.signature, '') AS signature,
       f.relative_path AS file_path
     FROM symbols s JOIN files f ON f.id = s.file_id
     ORDER BY s.id LIMIT ?`,
  );
  const nextPage = db.prepare(
    `SELECT s.id AS symbol_id, s.file_id AS file_id,
       s.repository_id AS repository_id, s.name AS name,
       s.qualified_name AS qualified_name,
       COALESCE(s.signature, '') AS signature,
       f.relative_path AS file_path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.id > ? ORDER BY s.id LIMIT ?`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbol_fts
       (rowid, symbol_id, name, qualified_name, signature, file_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertFragment = db.prepare(
    `INSERT INTO symbol_fragment_fts
       (rowid, symbol_id, name_folded, qualified_name_folded)
     VALUES (?, ?, ?, ?)`,
  );
  const insertMapping = db.prepare(
    `INSERT INTO symbol_fts_rows
       (symbol_id, file_id, repository_id, symbol_fts_rowid, fragment_fts_rowid)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let afterSymbolId: string | null = null;
  let symbolFtsRowid = 1;
  let fragmentFtsRowid = 1;
  while (true) {
    const rows =
      afterSymbolId === null
        ? firstPage.all(batchSize)
        : nextPage.all(afterSymbolId, batchSize);
    if (rows.length === 0) break;
    for (const value of rows) {
      const row = requireRow(value);
      const symbolId = requireString(row, 'symbol_id');
      const name = requireString(row, 'name');
      const qualifiedName = requireString(row, 'qualified_name');
      insertSymbol.run(
        symbolFtsRowid,
        symbolId,
        name,
        qualifiedName,
        requireString(row, 'signature'),
        requireString(row, 'file_path'),
      );
      insertFragment.run(
        fragmentFtsRowid,
        symbolId,
        foldForFragmentSearch(name),
        foldForFragmentSearch(qualifiedName),
      );
      insertMapping.run(
        symbolId,
        requireString(row, 'file_id'),
        requireString(row, 'repository_id'),
        symbolFtsRowid,
        fragmentFtsRowid,
      );
      afterSymbolId = symbolId;
      symbolFtsRowid += 1;
      fragmentFtsRowid += 1;
    }
    if (rows.length < batchSize) break;
  }
  // This is deliberately the final write: the marker becomes visible only
  // with the completed map and both completed FTS indexes at transaction commit.
  setMetadataValue(
    db,
    SYMBOL_FTS_MAPPING_VERSION_KEY,
    SYMBOL_FTS_MAPPING_VERSION_VALUE,
  );
}

function deleteSymbolFtsRowsForFiles(
  db: CodeGraphDatabase,
  fileIds: readonly string[],
): void {
  const selectMapping = db.prepare(
    `SELECT symbol_id, symbol_fts_rowid, fragment_fts_rowid
     FROM symbol_fts_rows WHERE file_id = ?`,
  );
  for (const fileId of fileIds) {
    deleteMappedSymbolFtsRows(db, selectMapping.all(fileId));
  }
}

function deleteMappedSymbolFtsRows(
  db: CodeGraphDatabase,
  rows: readonly unknown[],
): void {
  const deleteSymbol = db.prepare('DELETE FROM symbol_fts WHERE rowid = ?');
  const deleteFragment = db.prepare(
    'DELETE FROM symbol_fragment_fts WHERE rowid = ?',
  );
  const deleteMapping = db.prepare(
    'DELETE FROM symbol_fts_rows WHERE symbol_id = ?',
  );
  for (const value of rows) {
    const row = requireRow(value);
    deleteSymbol.run(requireNumber(row, 'symbol_fts_rowid'));
    deleteFragment.run(requireNumber(row, 'fragment_fts_rowid'));
    deleteMapping.run(requireString(row, 'symbol_id'));
  }
}

function nextMappedRowid(
  db: CodeGraphDatabase,
  column: 'symbol_fts_rowid' | 'fragment_fts_rowid',
): number {
  // Both rowid columns have UNIQUE indexes, so MAX is an index-edge lookup,
  // not a table or FTS scan on the trusted selective path.
  const row = requireRow(
    db
      .prepare(
        `SELECT COALESCE(MAX(${column}), 0) + 1 AS next_rowid
         FROM symbol_fts_rows`,
      )
      .get(),
  );
  const nextRowid = requireNumber(row, 'next_rowid');
  if (!Number.isSafeInteger(nextRowid) || nextRowid <= 0) {
    throw new Error('Symbol FTS rowid space is exhausted.');
  }
  return nextRowid;
}

function insertSymbolFtsRowsForFiles(
  db: CodeGraphDatabase,
  fileIds: readonly string[],
): void {
  const selectSymbols = db.prepare(
    `SELECT s.id AS symbol_id, s.file_id AS file_id,
       s.repository_id AS repository_id, s.name AS name,
       s.qualified_name AS qualified_name,
       COALESCE(s.signature, '') AS signature,
       f.relative_path AS file_path
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.file_id = ? ORDER BY s.id`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbol_fts
       (rowid, symbol_id, name, qualified_name, signature, file_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertFragment = db.prepare(
    `INSERT INTO symbol_fragment_fts
       (rowid, symbol_id, name_folded, qualified_name_folded)
     VALUES (?, ?, ?, ?)`,
  );
  const insertMapping = db.prepare(
    `INSERT INTO symbol_fts_rows
       (symbol_id, file_id, repository_id, symbol_fts_rowid, fragment_fts_rowid)
     VALUES (?, ?, ?, ?, ?)`,
  );
  let nextSymbolFtsRowid = nextMappedRowid(db, 'symbol_fts_rowid');
  let nextFragmentFtsRowid = nextMappedRowid(db, 'fragment_fts_rowid');
  for (const fileId of fileIds) {
    for (const value of selectSymbols.all(fileId)) {
      const row = requireRow(value);
      const symbolId = requireString(row, 'symbol_id');
      const name = requireString(row, 'name');
      const qualifiedName = requireString(row, 'qualified_name');
      if (
        !Number.isSafeInteger(nextSymbolFtsRowid) ||
        !Number.isSafeInteger(nextFragmentFtsRowid)
      ) {
        throw new Error('Symbol FTS rowid space is exhausted.');
      }
      insertSymbol.run(
        nextSymbolFtsRowid,
        symbolId,
        name,
        qualifiedName,
        requireString(row, 'signature'),
        requireString(row, 'file_path'),
      );
      insertFragment.run(
        nextFragmentFtsRowid,
        symbolId,
        foldForFragmentSearch(name),
        foldForFragmentSearch(qualifiedName),
      );
      insertMapping.run(
        symbolId,
        requireString(row, 'file_id'),
        requireString(row, 'repository_id'),
        nextSymbolFtsRowid,
        nextFragmentFtsRowid,
      );
      nextSymbolFtsRowid += 1;
      nextFragmentFtsRowid += 1;
    }
  }
}

function foldForFragmentSearch(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

const fragmentFtsAvailability = new WeakMap<CodeGraphDatabase, boolean>();

function hasFragmentFts(db: CodeGraphDatabase): boolean {
  const cached = fragmentFtsAvailability.get(db);
  if (cached !== undefined) return cached;
  const available =
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'symbol_fragment_fts'`,
      )
      .get() !== undefined;
  fragmentFtsAvailability.set(db, available);
  return available;
}

function escapeLikePrefix(value: string): string {
  return `${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

export function searchSymbolFts(
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
  // sees the exact symbol. This query is bounded by the caller's result count.
  //
  // The leading bare `LIKE` adds no filtering: both arms of the original
  // disjunction already imply it (NOCASE equality and LIKE fold the same
  // ASCII letters, and the escaped pattern is the query followed by `%`).
  // SQLite turns that bare prefix `LIKE` into a range seek on
  // `idx_symbols_name_nocase`; the disjunction itself, whose `LIKE` carries a
  // collation, would scan every symbol. The unary `+` (an identity on the
  // text id) keeps a repository-scoped search from walking that repository's
  // every symbol through `idx_symbols_repo_name` instead.
  const prefixPattern = escapeLikePrefix(query.normalize('NFC'));
  const priority = db
    .prepare(
      `SELECT s.id AS symbol_id, s.name AS name, s.qualified_name AS qualified_name,
         f.relative_path AS file_path, s.kind AS kind, s.line_start AS line_start
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN repositories r ON r.id = +s.repository_id
       WHERE s.name LIKE ? ESCAPE '\\'
         AND (s.name = ? COLLATE NOCASE OR s.name LIKE ? ESCAPE '\\' COLLATE NOCASE)${scope}
       ORDER BY CASE WHEN s.name = ? COLLATE NOCASE THEN 0 ELSE 1 END,
         s.qualified_name, s.id
       LIMIT ?`,
    )
    .all(
      prefixPattern,
      query.normalize('NFC'),
      prefixPattern,
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
