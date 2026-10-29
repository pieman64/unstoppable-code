import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';

function walBytes(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  return existsSync(walPath) ? statSync(walPath).size : 0;
}

describe('code graph engine close', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-close-wal-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no WAL bytes behind while a long-lived reader is attached', async () => {
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function alpha(){}\n');
    const dbPath = path.join(dir, '.graph', 'graph.db');
    const first = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: dir }],
    });
    try {
      await first.buildOrUpdate({ verifyContent: true });
    } finally {
      first.close();
    }

    // A desktop read worker keeps its read-only connection between requests.
    // Its lock stops a closing writer from deleting the WAL, so the writer
    // must empty the WAL itself or the file keeps its high-water size (up to
    // a cold build's whole transaction).
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      reader.prepare('SELECT COUNT(*) AS n FROM symbols').get();
      writeFileSync(
        path.join(dir, 'fixture.ts'),
        'export function alpha(){}\nexport function beta(){}\n',
      );
      const refresh = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: 'fixture', rootPath: dir }],
      });
      try {
        await refresh.buildOrUpdate({ verifyContent: true });
        expect(walBytes(dbPath)).toBeGreaterThan(0);
      } finally {
        refresh.close();
      }
      expect(walBytes(dbPath)).toBe(0);
      // The reader still sees the refreshed graph.
      expect(
        reader
          .prepare("SELECT COUNT(*) AS n FROM symbols WHERE name = 'beta'")
          .get(),
      ).toEqual({ n: 1 });
    } finally {
      reader.close();
    }
  });

  it('still removes the WAL when it is the last connection', async () => {
    writeFileSync(path.join(dir, 'fixture.ts'), 'export function alpha(){}\n');
    const dbPath = path.join(dir, '.graph', 'graph.db');
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: dir }],
    });
    try {
      await engine.buildOrUpdate({ verifyContent: true });
    } finally {
      engine.close();
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });
});
