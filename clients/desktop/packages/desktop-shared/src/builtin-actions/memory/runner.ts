import * as path from 'node:path';
import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';
import { ensureCanopyDir, openSqliteDatabase } from '../_lib/sqlite';

type MemoryOperation = 'get' | 'set' | 'delete' | 'list' | 'query';

function parseOperation(raw: string | undefined): MemoryOperation {
  switch ((raw ?? '').trim()) {
    case 'get':
    case 'set':
    case 'delete':
    case 'list':
    case 'query':
      return (raw ?? '').trim() as MemoryOperation;
    default:
      throw new Error(
        'memory operation must be one of: get, set, delete, list, query',
      );
  }
}

function parseLimit(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 20;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('memory limit must be a positive integer');
  }
  return parsed;
}

function initializeMemorySchema(
  db: ReturnType<typeof openSqliteDatabase>,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_namespace_updated_at
      ON memory_entries(namespace, updated_at DESC);
  `);
}

function getMemoryDbPath(env: NodeJS.ProcessEnv): string {
  if (env.INPUT_DB_PATH?.trim()) {
    return path.resolve(process.cwd(), env.INPUT_DB_PATH);
  }
  return path.join(ensureCanopyDir(), 'memory.db');
}

export async function runMemoryAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let db: ReturnType<typeof openSqliteDatabase> | undefined;

  await runWithActionEnvironment(env, async () => {
    try {
      const operation = parseOperation(env.INPUT_OPERATION);
      const namespace = env.INPUT_NAMESPACE?.trim() || 'default';
      const key = env.INPUT_KEY?.trim();
      const value = env.INPUT_VALUE ?? '';
      const query = env.INPUT_QUERY ?? '';
      const limit = parseLimit(env.INPUT_LIMIT);
      const dbPath = getMemoryDbPath(env);

      db = openSqliteDatabase(dbPath);
      initializeMemorySchema(db);

      setOutput('db_path', dbPath);

      if (operation === 'set') {
        if (!key) {
          throw new Error('memory set requires key');
        }
        db.prepare(
          `INSERT INTO memory_entries(namespace, key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
        ).run(namespace, key, value, new Date().toISOString());
        setOutput('count', '1');
        setOutput('value', value);
        return Promise.resolve();
      }

      if (operation === 'get') {
        if (!key) {
          throw new Error('memory get requires key');
        }
        const row = db
          .prepare(
            'SELECT value, updated_at FROM memory_entries WHERE namespace = ? AND key = ?',
          )
          .get(namespace, key) as
          | { updated_at: string; value: string }
          | undefined;
        setOutput('count', row ? '1' : '0');
        setOutput('value', row?.value ?? '');
        return Promise.resolve();
      }

      if (operation === 'delete') {
        if (!key) {
          throw new Error('memory delete requires key');
        }
        const result = db
          .prepare('DELETE FROM memory_entries WHERE namespace = ? AND key = ?')
          .run(namespace, key);
        setOutput('count', String(result.changes));
        return Promise.resolve();
      }

      if (operation === 'list') {
        const rows = db
          .prepare(
            `SELECT namespace, key, value, updated_at
           FROM memory_entries
           WHERE namespace = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          )
          .all(namespace, limit) as Array<Record<string, unknown>>;
        setOutput('count', String(rows.length));
        setOutput('entries', JSON.stringify(rows));
        return Promise.resolve();
      }

      const rows = db
        .prepare(
          `SELECT namespace, key, value, updated_at
         FROM memory_entries
         WHERE namespace = ?
           AND (key LIKE ? OR value LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
        )
        .all(namespace, `%${query}%`, `%${query}%`, limit) as Array<
        Record<string, unknown>
      >;
      setOutput('count', String(rows.length));
      setOutput('entries', JSON.stringify(rows));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      db?.close();
    }
  });
}
