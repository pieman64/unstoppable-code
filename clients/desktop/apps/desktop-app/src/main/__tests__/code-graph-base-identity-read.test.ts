/** PRIVATE CANDIDATE: unrun. Header exception is NOT full integrity validation. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as base from '@canopy/code-graph/base-graph';
import {
  CODE_GRAPH_SCHEMA_VERSION,
  CODE_GRAPH_EXTRACTOR_VERSION,
} from '@canopy/desktop-shared/types/code-graph';
import type {
  CodeGraphDatabase,
  CodeGraphStatement,
} from '@canopy/code-graph/store/database';
import { readCodeGraphBaseIdentity } from '../code-graph/read-worker';
describe('base identity metadata and bounded repository header', () => {
  let dir: string;
  let dbPath: string;
  const identity = {
    canonicalRepoRoot: '/private/repo',
    repoId: 'repo',
    customLanguagesFingerprint: 'none',
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'base-identity-'));
    dbPath = path.join(dir, 'graph.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        'CREATE TABLE graph_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE repositories(repo_id TEXT,git_head TEXT)',
      );
      for (const [key, value] of Object.entries({
        schema_version: String(CODE_GRAPH_SCHEMA_VERSION),
        extractor_version: String(CODE_GRAPH_EXTRACTOR_VERSION),
        base_canonical_repo_root: identity.canonicalRepoRoot,
        custom_languages_fingerprint: 'none',
        completed_build_at: '10',
        last_build_at: '11',
      }))
        db.prepare('INSERT INTO graph_metadata VALUES (?,?)').run(key, value);
      db.prepare('INSERT INTO repositories VALUES (?,?)').run('repo', 'head');
    } finally {
      db.close();
    }
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  it('uses only metadata and LIMIT 2 header in one committed readonly view and closes', () => {
    const statements: string[] = [];
    const original = base.openReadonlyDatabase;
    const close = jest.fn();
    jest
      .spyOn(base, 'openReadonlyDatabase')
      .mockImplementation((file): CodeGraphDatabase => {
        const db = original(file);
        return {
          exec: (sql): void => {
            statements.push(sql);
            db.exec(sql);
          },
          prepare: (sql): CodeGraphStatement => {
            statements.push(sql);
            return db.prepare(sql);
          },
          close: (): void => {
            close();
            db.close();
          },
        };
      });
    expect(readCodeGraphBaseIdentity(dbPath, identity, 'head')).toMatchObject({
      state: 'readable',
      matches: {
        schema: true,
        extractor: true,
        canonicalRoot: true,
        customLanguagesFingerprint: true,
        repoId: true,
        gitHead: true,
        completed: true,
      },
      observed: { lastBuildAt: 11, completedBuildAt: 10 },
    });
    expect(statements[0]).toBe('BEGIN');
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(close).toHaveBeenCalledTimes(1);
    const headers = statements.filter((sql) => /FROM repositories/i.test(sql));
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(/substr\(repo_id, 1, 1024\)/);
    expect(headers[0]).toMatch(/length\(CAST\(git_head AS BLOB\)\) <= 512/);
    expect(headers[0]).toMatch(/FROM repositories LIMIT 2/);
    expect(statements.join(' ')).not.toMatch(
      /quick_check|COUNT|symbols|edges|communities|fts|PRAGMA|UPDATE|INSERT|DELETE/i,
    );
  });
  it.each(['', '01', '-1', '1e2', ' ', '99999999999999999'])(
    'rejects noncanonical actual completion %j without last-build fallback',
    (marker) => {
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "UPDATE graph_metadata SET value=? WHERE key='completed_build_at'",
      ).run(marker);
      db.close();
      expect(readCodeGraphBaseIdentity(dbPath, identity, 'head')).toMatchObject(
        {
          state: 'readable',
          matches: { completed: false },
          observed: { lastBuildAt: 11, completedBuildAt: null },
        },
      );
    },
  );
  it.each(['repo_id', 'git_head'])(
    'rejects oversized header %s without materializing raw text in its reply',
    (column) => {
      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE repositories SET ${column}=?`).run(
        '/private/'.repeat(1000),
      );
      db.close();
      const result = readCodeGraphBaseIdentity(dbPath, identity, 'head');
      expect(result).toEqual({ state: 'error', classification: 'io' });
      expect(JSON.stringify(result)).not.toContain('/private/');
    },
  );
  it('treats multiple repositories as mismatch, not measured absence', () => {
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO repositories VALUES (?,?)').run('other', 'head');
    db.close();
    expect(readCodeGraphBaseIdentity(dbPath, identity, 'head')).toMatchObject({
      state: 'readable',
      repository: null,
      matches: { repoId: false, gitHead: false },
    });
  });
  it('rolls back and closes on header rejection; never leaks SQL or paths', () => {
    const original = base.openReadonlyDatabase;
    const operations: string[] = [];
    jest
      .spyOn(base, 'openReadonlyDatabase')
      .mockImplementation((file): CodeGraphDatabase => {
        const db = original(file);
        return {
          exec: (sql): void => {
            operations.push(sql);
            db.exec(sql);
          },
          prepare: (sql): CodeGraphStatement => {
            if (sql.includes('FROM repositories'))
              throw new Error('SELECT /private/graph.db');
            return db.prepare(sql);
          },
          close: (): void => {
            operations.push('close');
            db.close();
          },
        };
      });
    expect(readCodeGraphBaseIdentity(dbPath, identity, 'head')).toEqual({
      state: 'error',
      classification: 'io',
    });
    expect(operations).toEqual(['BEGIN', 'ROLLBACK', 'close']);
  });
});
