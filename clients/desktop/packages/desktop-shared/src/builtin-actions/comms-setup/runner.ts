import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setOutput } from '../_lib/output';
import { runWithSynchronousActionEnvironment } from '../_lib/action-env';
import { ensureCanopyDir, openSqliteDatabase } from '../_lib/sqlite';

function parseExtraTables(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('extra_tables must be a JSON string array');
  }
  return parsed.map((value) => {
    if (typeof value !== 'string') {
      throw new Error('extra_tables must be a JSON string array');
    }
    return value;
  });
}

export function runCommsSetupAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let db: ReturnType<typeof openSqliteDatabase> | undefined;

  runWithSynchronousActionEnvironment(env, () => {
    try {
      const channelName =
        env.INPUT_CHANNEL_NAME?.trim() || `channel-${randomUUID()}`;
      const dbPath = path.join(ensureCanopyDir(), `comms-${randomUUID()}.db`);
      const extraTables = parseExtraTables(env.INPUT_EXTRA_TABLES);

      db = openSqliteDatabase(dbPath);
      db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT NOT NULL,
        sender TEXT,
        role TEXT,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_created_at
        ON messages(channel_name, created_at DESC);
    `);
      const DDL_PATTERN =
        /^\s*CREATE\s+(TABLE|INDEX)\s+(IF\s+NOT\s+EXISTS\s+)?/i;
      for (const statement of extraTables) {
        if (!DDL_PATTERN.test(statement)) {
          throw new Error(
            'extra_tables only allows CREATE TABLE/INDEX statements',
          );
        }
        db.exec(statement);
      }
      db.prepare(
        'INSERT OR IGNORE INTO channels(name, created_at) VALUES (?, ?)',
      ).run(channelName, new Date().toISOString());

      setOutput('db_path', dbPath);
      setOutput('channel_name', channelName);
      setOutput('extra_table_count', String(extraTables.length));
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      db?.close();
    }
  });
  return Promise.resolve();
}
