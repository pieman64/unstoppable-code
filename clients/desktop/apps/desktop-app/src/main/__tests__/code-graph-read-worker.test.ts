import { CodeGraphEngine } from '@canopy/code-graph/engine';
import * as baseGraph from '@canopy/code-graph/base-graph';
import type {
  CodeGraphDatabase,
  CodeGraphStatement,
} from '@canopy/code-graph/store/database';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executeCodeGraphRead,
  readLastBuildAt,
} from '../code-graph/read-worker';

function git(root: string, args: string[]): void {
  execFileSync('git', ['-C', root, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** Records every statement the read worker prepares on its database. */
function recordPreparedSql(): { sql: string[]; restore: () => void } {
  const sql: string[] = [];
  const original = baseGraph.openReadonlyDatabase;
  const spy = jest
    .spyOn(baseGraph, 'openReadonlyDatabase')
    .mockImplementation((dbPath: string): CodeGraphDatabase => {
      const db = original(dbPath);
      return {
        exec: (text: string): void => db.exec(text),
        prepare: (text: string): CodeGraphStatement => {
          sql.push(text);
          return db.prepare(text);
        },
        close: (): void => db.close(),
      };
    });
  return { sql, restore: () => spy.mockRestore() };
}

describe('code graph read worker', () => {
  it('returns the same persisted diagnostics as the engine status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-status-'));
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function work(){}');
    const dbPath = path.join(dir, '.graph/graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: dir }],
    });
    try {
      await engine.buildOrUpdate({ verifyContent: true });
      const expected = engine.getStatus();
      const readonlyDb = new DatabaseSync(dbPath, { readOnly: true });
      let persistedProjection: unknown;
      try {
        const row = readonlyDb
          .prepare(
            "SELECT value FROM graph_metadata WHERE key = 'summary_projection_v1'",
          )
          .get();
        if (typeof row?.value !== 'string')
          throw new Error('The real build did not persist its projection.');
        persistedProjection = JSON.parse(row.value);
      } finally {
        readonlyDb.close();
      }

      const result = await executeCodeGraphRead({
        dbPath,
        task: { kind: 'calls', calls: [{ method: 'status' }] },
      });
      expect(result).toEqual({
        ok: true,
        result: {
          kind: 'calls',
          value: [
            {
              state: 'ready',
              projection: persistedProjection,
              diagnostics: expected.diagnostics,
            },
          ],
        },
      });
    } finally {
      engine.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads lastBuildAt from metadata exactly as the status read reports it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-last-build-'));
    const dbPath = path.join(dir, 'graph.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(
        'CREATE TABLE graph_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      // Absent before any build; then the engine's epoch-milliseconds text.
      expect(readLastBuildAt(db)).toBeNull();
      db.prepare('INSERT INTO graph_metadata VALUES (?, ?)').run(
        'last_build_at',
        '1790940215551',
      );
      expect(readLastBuildAt(db)).toBe(1790940215551);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers detect-changed with the status lastBuildAt and no table counts', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-detect-'));
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function work(){}\n');
    git(dir, ['init', '--quiet']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'fixture']);
    writeFileSync(
      path.join(dir, 'fixture.ts'),
      'export function work(){ return 1; }\n',
    );
    const dbPath = path.join(dir, '.graph/graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: dir }],
    });
    let expected: number | null;
    try {
      await engine.buildOrUpdate({ verifyContent: true });
      // The oracle: the full status read, which the read worker's status
      // projection preserves (see the first test).
      expected = engine.getStatus().lastBuildAt;
    } finally {
      engine.close();
    }
    expect(expected).toEqual(expect.any(Number));

    const recorder = recordPreparedSql();
    try {
      const result = await executeCodeGraphRead({
        dbPath,
        task: {
          kind: 'detect-changed',
          rootPath: dir,
          baseRef: 'HEAD',
          repoId: 'fixture',
        },
      });
      expect(result).toMatchObject({
        ok: true,
        result: { kind: 'detect-changed', value: { lastBuildAt: expected } },
      });
      expect(recorder.sql.length).toBeGreaterThan(0);
      expect(recorder.sql.filter((text) => /COUNT\s*\(/i.test(text))).toEqual(
        [],
      );
    } finally {
      recorder.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists the worktree fingerprint and reports completion from metadata', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-persist-'));
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function work(){}');
    const dbPath = path.join(dir, '.graph/graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: dir }],
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }

    try {
      await expect(
        executeCodeGraphRead({
          dbPath,
          task: { kind: 'persist-fingerprint', fingerprint: 'end-digest' },
        }),
      ).resolves.toEqual({ ok: true, result: { kind: 'persist-fingerprint' } });
      await expect(
        executeCodeGraphRead({
          dbPath,
          task: { kind: 'fingerprint-metadata' },
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          kind: 'fingerprint-metadata',
          value: { fingerprint: 'end-digest', completed: true },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to create a database when persisting a fingerprint', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-missing-'));
    const dbPath = path.join(dir, 'graph.db');
    try {
      await expect(
        executeCodeGraphRead({
          dbPath,
          task: { kind: 'persist-fingerprint', fingerprint: 'digest' },
        }),
      ).resolves.toEqual({
        ok: false,
        code: 'database-error',
        message: 'The retained Code Graph could not be read. Try again.',
      });
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens call databases read-only and never runs migrations', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-worker-'));
    const dbPath = path.join(dir, 'graph.db');
    new DatabaseSync(dbPath).close();

    try {
      const response = await executeCodeGraphRead({
        dbPath,
        task: { kind: 'calls', calls: [{ method: 'status' }] },
      });

      expect(response).toEqual({
        ok: true,
        result: {
          kind: 'calls',
          value: [{ state: 'error', classification: 'unsupported-schema' }],
        },
      });
      const verificationDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          verificationDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all(),
        ).toEqual([]);
      } finally {
        verificationDb.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
