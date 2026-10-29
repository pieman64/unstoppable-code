import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommsSetupAction } from '../comms-setup/runner';
import { runMemoryAction } from '../memory/runner';
import { openSqliteDatabase } from '../_lib/sqlite';

describe('sqlite-backed actions', () => {
  let tempDir: string;
  let outputFile: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-sqlite-actions-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and queries durable memory entries', async () => {
    await runMemoryAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_OPERATION: 'set',
      INPUT_NAMESPACE: 'learned',
      INPUT_KEY: 'pattern',
      INPUT_VALUE: 'Prefer narrow diffs.',
    });
    await runMemoryAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_OPERATION: 'get',
      INPUT_NAMESPACE: 'learned',
      INPUT_KEY: 'pattern',
    });
    await runMemoryAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_OPERATION: 'query',
      INPUT_NAMESPACE: 'learned',
      INPUT_QUERY: 'narrow',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    expect(outputs).toContain('db_path=');
    expect(outputs).toContain('value=Prefer narrow diffs.');
    expect(outputs).toContain('"key":"pattern"');
  });

  it('creates a comms database with the expected tables', async () => {
    await runCommsSetupAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_CHANNEL_NAME: 'reviewers',
      INPUT_EXTRA_TABLES:
        '["CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"]',
    });

    const outputs = fs.readFileSync(outputFile, 'utf8');
    const dbPathLine = outputs
      .split('\n')
      .find((line) => line.startsWith('db_path='));
    expect(dbPathLine).toBeTruthy();
    const dbPath = dbPathLine?.slice('db_path='.length) ?? '';
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(outputs).toContain('channel_name=reviewers');
    expect(outputs).toContain('extra_table_count=1');

    const db = openSqliteDatabase(dbPath);
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining(['channels', 'messages', 'notes']),
      );
    } finally {
      db.close();
    }
  });
});
