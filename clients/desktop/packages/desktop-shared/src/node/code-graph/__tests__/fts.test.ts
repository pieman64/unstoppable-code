import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  setMetadataValue,
  type CodeGraphDatabase,
} from '../store/database';
import {
  CODE_GRAPH_MIGRATIONS,
  runCodeGraphMigrations,
} from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import {
  isSymbolFtsMappingTrusted,
  rebuildSymbolFts,
  searchSymbolFts,
} from '../store/fts';
import {
  fileRowId,
  repositoryRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type { CodeGraphFileFacts } from '../../../types/code-graph';

const REPO = 'repo-a';

function factsWithSymbol(
  relativePath: string,
  name: string,
  signature = `function ${name}(input: string): void`,
): CodeGraphFileFacts {
  const fileId = fileRowId(REPO, relativePath);
  return {
    file: {
      id: fileId,
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'h',
      sizeBytes: 1,
      mtimeNs: '1',
      lineCount: 1,
      grammarId: 'typescript',
      grammarAbi: 14,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols: [
      {
        id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
        repositoryId: REPO,
        fileId,
        kind: 'function',
        name,
        qualifiedName: symbolQualifiedName(relativePath, [], name),
        parentSymbolId: null,
        lineStart: 3,
        lineEnd: 5,
        byteStart: 0,
        byteEnd: 10,
        signature,
        exported: true,
        isTest: false,
        extra: {},
      },
    ],
    edges: [],
  };
}

describe('code-graph FTS', () => {
  let dir: string;
  let db: CodeGraphDatabase;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-fts-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    const store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
    store.replaceFileFacts(
      factsWithSymbol('src/worktree-service.ts', 'createWorktree'),
    );
    store.replaceFileFacts(factsWithSymbol('src/other.ts', 'unrelatedThing'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds symbols after rebuild and returns joined metadata', () => {
    rebuildSymbolFts(db);
    const results = searchSymbolFts(db, 'createWorktree', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].qualifiedName).toBe(
      'src/worktree-service.ts::createWorktree',
    );
    expect(results[0].kind).toBe('function');
    expect(results[0].filePath).toBe('src/worktree-service.ts');
    expect(results[0].lineStart).toBe(3);
  });

  it('finds identifier fragments and Unicode while preserving exact-name priority', () => {
    const store = new CodeGraphStore(db);
    store.replaceFileFacts(factsWithSymbol('src/unicode.ts', '处理订单'));
    store.replaceFileFacts(factsWithSymbol('src/accent.ts', 'créerFacture'));
    rebuildSymbolFts(db);
    for (const query of [
      'createWork',
      'Worktree',
      'reateWork',
      'create Worktree',
    ]) {
      expect(searchSymbolFts(db, query, 10)[0]?.name).toBe('createWorktree');
    }
    expect(searchSymbolFts(db, '处理订单', 10)[0]?.name).toBe('处理订单');
    expect(searchSymbolFts(db, 'créer', 10)[0]?.name).toBe('créerFacture');
    expect(searchSymbolFts(db, 'ÉER', 10)[0]?.name).toBe('créerFacture');
    expect(searchSymbolFts(db, 'createWorktree', 10)[0]?.name).toBe(
      'createWorktree',
    );
  });

  it('retains an exact name before truncating broad FTS candidates', () => {
    const store = new CodeGraphStore(db);
    store.replaceFileFacts(factsWithSymbol('src/exact.ts', 'needleSymbol'));
    for (let index = 0; index < 20; index += 1) {
      store.replaceFileFacts(
        factsWithSymbol(
          `src/decoy-${index}.ts`,
          `decoy${index}`,
          `function decoy${index}(${Array(20).fill('needleSymbol').join(', ')}): void`,
        ),
      );
    }
    rebuildSymbolFts(db);

    expect(searchSymbolFts(db, 'needleSymbol', 1)[0]?.name).toBe(
      'needleSymbol',
    );
  });

  it('uses an indexed fragment lookup instead of preparing a full-table substring scan', () => {
    rebuildSymbolFts(db);
    const preparedSql: string[] = [];
    const observedDb: CodeGraphDatabase = {
      exec(sql: string): void {
        db.exec(sql);
      },
      prepare(sql: string) {
        preparedSql.push(sql);
        return db.prepare(sql);
      },
      close(): void {
        db.close();
      },
    };

    expect(searchSymbolFts(observedDb, 'reateWork', 10)[0]?.name).toBe(
      'createWorktree',
    );
    expect(preparedSql.some((sql) => sql.includes('instr(lower('))).toBe(false);
    const fragmentSql = preparedSql.find((sql) =>
      sql.includes('symbol_fragment_fts MATCH'),
    );
    expect(fragmentSql).toBeDefined();
    expect(fragmentSql).toContain('FROM symbol_fragment_fts fragments_fts');
    expect(fragmentSql).not.toContain('FROM symbol_fts fts');
    if (fragmentSql === undefined) {
      throw new Error('fragment query was not prepared');
    }
    const queryPlan = db
      .prepare(`EXPLAIN QUERY PLAN ${fragmentSql}`)
      .all('"reatework"', 200)
      .map((row) => JSON.stringify(row))
      .join('\n');
    expect(queryPlan).toContain('SCAN fragments_fts VIRTUAL TABLE');
    expect(queryPlan).not.toContain('SCAN fts VIRTUAL TABLE');
  });

  it('returns token-prefix results from a read-only v2 database without the fragment table', () => {
    const legacyPath = path.join(dir, 'legacy-v2.db');
    const writable = openCodeGraphDatabase(legacyPath);
    writable.exec(
      'CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    for (const migration of CODE_GRAPH_MIGRATIONS.filter(
      (candidate) => candidate.version <= 2,
    )) {
      migration.up(writable);
    }
    setMetadataValue(writable, 'schema_version', '2');
    const legacyStore = new CodeGraphStore(writable);
    legacyStore.upsertRepository({
      repoId: REPO,
      rootPath: '/abs',
      gitHead: null,
    });
    // Populate the historical schema directly: the current fact writer owns
    // v5 indexes that deliberately do not exist in this read-only v2 fixture.
    const facts = factsWithSymbol('src/legacy.ts', 'createLegacyWorktree');
    const symbol = facts.symbols[0];
    if (symbol === undefined) throw new Error('Missing legacy fixture symbol');
    const repositoryId = repositoryRowId(REPO);
    writable
      .prepare(
        `INSERT INTO files
      (id, repository_id, relative_path, absolute_path, language, size_bytes,
       mtime_ns, parse_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        facts.file.id,
        repositoryId,
        facts.file.relativePath,
        facts.file.absolutePath,
        facts.file.language,
        facts.file.sizeBytes,
        facts.file.mtimeNs,
        facts.file.parseStatus,
        facts.file.updatedAt,
      );
    writable
      .prepare(
        `INSERT INTO symbols
      (id, repository_id, file_id, kind, name, qualified_name, line_start,
       line_end, byte_start, byte_end, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        symbol.id,
        repositoryId,
        symbol.fileId,
        symbol.kind,
        symbol.name,
        symbol.qualifiedName,
        symbol.lineStart,
        symbol.lineEnd,
        symbol.byteStart,
        symbol.byteEnd,
        symbol.signature,
      );
    writable.exec(`INSERT INTO symbol_fts (symbol_id, name, qualified_name, signature, file_path)
      SELECT s.id, s.name, s.qualified_name, COALESCE(s.signature, ''), f.relative_path
      FROM symbols s JOIN files f ON f.id = s.file_id`);
    writable.close();

    const readOnly: CodeGraphDatabase = new DatabaseSync(legacyPath, {
      readOnly: true,
    });
    try {
      expect(
        readOnly
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('symbol_fragment_fts', 'symbol_fts_rows')",
          )
          .all(),
      ).toEqual([]);
      expect(
        searchSymbolFts(readOnly, 'createLegacyWorktree', 10)[0]?.name,
      ).toBe('createLegacyWorktree');
    } finally {
      readOnly.close();
    }
  });

  it('rejects excessive queries instead of silently dropping required terms', () => {
    rebuildSymbolFts(db);
    expect(() =>
      searchSymbolFts(db, Array(17).fill('createWorktree').join(' '), 10),
    ).toThrow('16 terms');
    expect(() => searchSymbolFts(db, 'x'.repeat(257), 10)).toThrow('256');
  });

  it('rebuild replaces stale rows', () => {
    rebuildSymbolFts(db);
    rebuildSymbolFts(db);
    expect(searchSymbolFts(db, 'createWorktree', 10)).toHaveLength(1);
  });

  it('is immune to FTS operator injection', () => {
    rebuildSymbolFts(db);
    expect(() => searchSymbolFts(db, 'create AND ") OR (', 10)).not.toThrow();
    expect(searchSymbolFts(db, '"""', 10)).toEqual([]);
  });

  it('removes repository fragment-index rows when reconciling membership', () => {
    rebuildSymbolFts(db);
    const fragmentsBeforeRemoval = db
      .prepare(
        'SELECT symbol_id, name_folded, qualified_name_folded FROM symbol_fragment_fts ORDER BY symbol_id',
      )
      .all();
    expect(fragmentsBeforeRemoval).toHaveLength(2);

    const store = new CodeGraphStore(db);
    expect(store.reconcileRepositories([])).toBe(true);

    // Inspect the virtual table itself: search joins against `symbols` and
    // would hide orphaned fragment rows after the repository's symbols vanish.
    expect(
      db
        .prepare(
          'SELECT symbol_id, name_folded, qualified_name_folded FROM symbol_fragment_fts ORDER BY symbol_id',
        )
        .all(),
    ).toEqual([]);
    expect(
      db.prepare('SELECT * FROM symbol_fts_rows ORDER BY symbol_id').all(),
    ).toEqual([]);
    expect(isSymbolFtsMappingTrusted(db)).toBe(true);
  });
});
