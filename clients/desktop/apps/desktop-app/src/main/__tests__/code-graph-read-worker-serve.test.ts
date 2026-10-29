import * as baseGraph from '@canopy/desktop-shared/node/code-graph/base-graph';
import { CodeGraphEngine } from '@canopy/desktop-shared/node/code-graph/engine';
import {
  type CodeGraphDatabase,
  getMetadataValue,
  openCodeGraphDatabase,
  setMetadataValue,
  withImmediateTransaction,
} from '@canopy/desktop-shared/node/code-graph/store/database';
import {
  CODE_GRAPH_MIGRATIONS,
  runCodeGraphMigrations,
} from '@canopy/desktop-shared/node/code-graph/store/migrations';
import { rebuildSymbolFts } from '@canopy/desktop-shared/node/code-graph/store/fts';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  CodeGraphWorkerReadRequest,
  CodeGraphWorkerReadResponse,
} from '../code-graph/read-runner';
import {
  executeCodeGraphRead,
  serveCodeGraphReads,
} from '../code-graph/read-worker';

/** The worker's parent port, as the runner drives it: one request at a time. */
class FakeParentPort extends EventEmitter {
  private readonly waiting: Array<
    (response: CodeGraphWorkerReadResponse) => void
  > = [];
  public readonly responses: CodeGraphWorkerReadResponse[] = [];

  public postMessage(message: CodeGraphWorkerReadResponse): void {
    this.responses.push(message);
    this.waiting.shift()?.(message);
  }

  public ask(payload: unknown): Promise<CodeGraphWorkerReadResponse> {
    const response = new Promise<CodeGraphWorkerReadResponse>((resolve) => {
      this.waiting.push(resolve);
    });
    this.emit('message', { data: payload });
    return response;
  }
}

async function buildGraph(
  root: string,
  dbPath: string,
  source: string,
): Promise<void> {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'fixture.ts'), source);
  const engine = await CodeGraphEngine.open({
    dbPath,
    repositories: [{ repoId: 'fixture', rootPath: root }],
  });
  try {
    await engine.buildOrUpdate({ verifyContent: true });
  } finally {
    engine.close();
  }
}

function searchRequest(
  dbPath: string,
  query: string,
): CodeGraphWorkerReadRequest {
  return {
    dbPath,
    task: {
      kind: 'calls',
      calls: [{ method: 'search', query, limit: 20 }, { method: 'status' }],
    },
  };
}

function names(response: CodeGraphWorkerReadResponse): string[] {
  if (!response.ok || response.result.kind !== 'calls') {
    throw new Error(`unexpected response ${JSON.stringify(response)}`);
  }
  const [hits] = response.result.value;
  if (!Array.isArray(hits)) throw new Error('search returned no list');
  return hits
    .map((hit: unknown) =>
      typeof hit === 'object' && hit !== null && 'name' in hit
        ? String(hit.name)
        : '',
    )
    .sort();
}

describe('code graph read worker serving loop', () => {
  let dir: string;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-read-serve-'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('the read worker must not exit after answering');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers request after request on one port without exiting', async () => {
    const dbPath = path.join(dir, 'graph.db');
    await buildGraph(
      path.join(dir, 'src'),
      dbPath,
      'export function alpha(){}\nexport function alphabet(){}\n',
    );
    const port = new FakeParentPort();
    serveCodeGraphReads(port);

    for (let round = 0; round < 3; round += 1) {
      const response = await port.ask(searchRequest(dbPath, 'alpha'));
      expect(names(response)).toEqual(['alpha', 'alphabet']);
      expect(response).toEqual(
        await executeCodeGraphRead(searchRequest(dbPath, 'alpha')),
      );
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('answers requests one at a time, in arrival order', async () => {
    const dbPath = path.join(dir, 'graph.db');
    await buildGraph(
      path.join(dir, 'src'),
      dbPath,
      'export function alpha(){}\n',
    );
    const port = new FakeParentPort();
    serveCodeGraphReads(port);

    // Arrive back to back: a slow detect-changed (git) and a fast search.
    const slow = port.ask({
      dbPath,
      task: {
        kind: 'detect-changed',
        repoId: 'fixture',
        rootPath: path.join(dir, 'src'),
        baseRef: 'HEAD',
      },
    });
    const fast = port.ask(searchRequest(dbPath, 'alpha'));
    await Promise.all([slow, fast]);
    expect(port.responses[0]).toMatchObject({ ok: false });
    expect(names(port.responses[1] ?? { ok: false, message: '' })).toEqual([
      'alpha',
    ]);
  });

  it('keeps serving after a malformed request', async () => {
    const dbPath = path.join(dir, 'graph.db');
    await buildGraph(
      path.join(dir, 'src'),
      dbPath,
      'export function alpha(){}\n',
    );
    const port = new FakeParentPort();
    serveCodeGraphReads(port);

    await expect(port.ask({ nonsense: true })).resolves.toEqual({
      ok: false,
      code: 'invalid-response',
      message: 'Invalid Code Graph read request.',
    });
    expect(names(await port.ask(searchRequest(dbPath, 'alpha')))).toEqual([
      'alpha',
    ]);
  });

  describe('generation swaps', () => {
    it('answers from the new file after the database is replaced (new inode)', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'old'),
        dbPath,
        'export function oldGeneration(){}\n',
      );
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      expect(
        names(await port.ask(searchRequest(dbPath, 'Generation'))),
      ).toEqual(['oldGeneration']);

      // Publish a new generation the way the seed install does: remove the
      // old file and its sidecars, then rename a finished database in.
      const nextPath = path.join(dir, 'next', 'graph.db');
      await buildGraph(
        path.join(dir, 'new'),
        nextPath,
        'export function newGeneration(){}\n',
      );
      const oldInode = statSync(dbPath).ino;
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }
      renameSync(nextPath, dbPath);
      expect(statSync(dbPath).ino).not.toBe(oldInode);

      const after = await port.ask(searchRequest(dbPath, 'Generation'));
      expect(names(after)).toEqual(['newGeneration']);
      expect(after).toEqual(
        await executeCodeGraphRead(searchRequest(dbPath, 'Generation')),
      );
    });

    it('answers from the migrated schema after an in-place v3 to v4 migration', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'src'),
        dbPath,
        'export function alpha(){}\nexport function Alphabet(){}\n',
      );
      // Give the built graph the schema-v3 index set and version.
      const writer = openCodeGraphDatabase(dbPath);
      try {
        writer.exec(`DROP INDEX IF EXISTS idx_symbols_name_nocase;
          DROP INDEX IF EXISTS idx_edges_target_symbol;
          CREATE INDEX idx_edges_target_symbol ON edges(target_symbol_id);`);
        setMetadataValue(writer, 'schema_version', '3');
      } finally {
        writer.close();
      }
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      const onV3 = await port.ask(searchRequest(dbPath, 'alpha'));
      expect(names(onV3)).toEqual(['Alphabet', 'alpha']);

      // The writer (a build worker in production) migrates in place.
      const migrator = openCodeGraphDatabase(dbPath);
      try {
        // Retain this exact historical v3→v4 transition independently of the
        // current release schema; later generation tests run all migrations.
        for (const migration of CODE_GRAPH_MIGRATIONS.filter(
          (entry) => entry.version === 4,
        )) {
          withImmediateTransaction(migrator, () => {
            migration.up(migrator);
            setMetadataValue(
              migrator,
              'schema_version',
              String(migration.version),
            );
          });
        }
        expect(getMetadataValue(migrator, 'schema_version')).toBe('4');
      } finally {
        migrator.close();
      }

      const onV4 = await port.ask(searchRequest(dbPath, 'alpha'));
      // Facts and diagnostics remain literal; metadata reports the writer's
      // new schema version. The retained reader must match a fresh reader.
      if (!onV3.ok || onV3.result.kind !== 'calls') {
        throw new Error('Expected the v3 search/status batch to succeed');
      }
      const oldStatus = onV3.result.value[1];
      if (
        typeof oldStatus !== 'object' ||
        oldStatus === null ||
        !('observed' in oldStatus) ||
        typeof oldStatus.observed !== 'object' ||
        oldStatus.observed === null ||
        !('schemaVersion' in oldStatus.observed)
      ) {
        throw new Error('Expected observed schema metadata for the v3 batch');
      }
      expect(oldStatus.observed.schemaVersion).toBe(3);
      expect(onV4).toEqual({
        ...onV3,
        result: {
          ...onV3.result,
          value: [
            onV3.result.value[0],
            {
              ...oldStatus,
              observed: { ...oldStatus.observed, schemaVersion: 4 },
            },
          ],
        },
      });
      expect(onV4).toEqual(
        await executeCodeGraphRead(searchRequest(dbPath, 'alpha')),
      );
      // The reader itself never migrated anything.
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('answers like a fresh reader after an in-place migration adds a table', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'src'),
        dbPath,
        'export function alphabet(){}\n',
      );
      // A schema-v2 graph: no fragment index, so a mid-word search finds
      // nothing.
      const writer = openCodeGraphDatabase(dbPath);
      try {
        writer.exec('DROP TABLE symbol_fragment_fts;');
        setMetadataValue(writer, 'schema_version', '2');
      } finally {
        writer.close();
      }
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      expect(names(await port.ask(searchRequest(dbPath, 'phabet')))).toEqual(
        [],
      );

      // A build migrates the same file in place and fills the new index.
      const migrator = openCodeGraphDatabase(dbPath);
      try {
        runCodeGraphMigrations(migrator);
        rebuildSymbolFts(migrator);
      } finally {
        migrator.close();
      }

      // The warm reader must not answer from what it learned about the old
      // schema: it answers exactly as a reader opened now does.
      const fresh = await executeCodeGraphRead(searchRequest(dbPath, 'phabet'));
      expect(names(fresh)).toEqual(['alphabet']);
      expect(await port.ask(searchRequest(dbPath, 'phabet'))).toEqual(fresh);
    });

    it('fails closed, without creating a file, after the database is deleted', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'src'),
        dbPath,
        'export function alpha(){}\n',
      );
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      expect(names(await port.ask(searchRequest(dbPath, 'alpha')))).toEqual([
        'alpha',
      ]);

      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${dbPath}${suffix}`, { force: true });
      }

      const after = await port.ask(searchRequest(dbPath, 'alpha'));
      expect(after).toMatchObject({ ok: false });
      expect(existsSync(dbPath)).toBe(false);
      const metadata = await port.ask({
        dbPath,
        task: { kind: 'fingerprint-metadata' },
      });
      expect(metadata).toMatchObject({ ok: false });
      expect(existsSync(dbPath)).toBe(false);
    });

    it('does not keep a connection whose file was replaced while it opened', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'old'),
        dbPath,
        'export function oldGeneration(){}\n',
      );
      const nextPath = path.join(dir, 'next', 'graph.db');
      await buildGraph(
        path.join(dir, 'new'),
        nextPath,
        'export function newGeneration(){}\n',
      );
      // The swap lands between the reader's open and its first read.
      const original = baseGraph.openReadonlyDatabase;
      const spy = jest
        .spyOn(baseGraph, 'openReadonlyDatabase')
        .mockImplementationOnce((target: string): CodeGraphDatabase => {
          const db = original(target);
          for (const suffix of ['', '-wal', '-shm']) {
            rmSync(`${dbPath}${suffix}`, { force: true });
          }
          renameSync(nextPath, dbPath);
          return db;
        });
      try {
        const port = new FakeParentPort();
        serveCodeGraphReads(port);
        // This request was already reading the old file: it may answer from
        // it, as a one-shot reader that opened a moment earlier would.
        expect(
          names(await port.ask(searchRequest(dbPath, 'Generation'))),
        ).toEqual(['oldGeneration']);
        // The next request must not.
        expect(
          names(await port.ask(searchRequest(dbPath, 'Generation'))),
        ).toEqual(['newGeneration']);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('connection reuse', () => {
    function countOpens(): { opens: () => number; restore: () => void } {
      const spy = jest.spyOn(baseGraph, 'openReadonlyDatabase');
      return {
        opens: () => spy.mock.calls.length,
        restore: () => spy.mockRestore(),
      };
    }

    it('keeps one read-only connection to a completed graph across requests', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'src'),
        dbPath,
        'export function alpha(){}\n',
      );
      const counter = countOpens();
      try {
        const port = new FakeParentPort();
        serveCodeGraphReads(port);
        for (let round = 0; round < 3; round += 1) {
          expect(names(await port.ask(searchRequest(dbPath, 'alpha')))).toEqual(
            ['alpha'],
          );
          await expect(
            port.ask({ dbPath, task: { kind: 'fingerprint-metadata' } }),
          ).resolves.toMatchObject({ ok: true });
        }
        expect(counter.opens()).toBe(1);
      } finally {
        counter.restore();
      }
    });

    it('keeps no connection to a graph without a completed build', async () => {
      const dbPath = path.join(dir, 'graph.db');
      const writer = openCodeGraphDatabase(dbPath);
      runCodeGraphMigrations(writer);
      writer.close();
      const counter = countOpens();
      try {
        const port = new FakeParentPort();
        serveCodeGraphReads(port);
        for (let round = 0; round < 2; round += 1) {
          await expect(
            port.ask({ dbPath, task: { kind: 'fingerprint-metadata' } }),
          ).resolves.toMatchObject({
            ok: true,
            result: { value: { completed: false } },
          });
        }
        // Seeding replaces a graph only while it has no completed build, so
        // a reader never holds the file a seed install removes.
        expect(counter.opens()).toBe(2);
      } finally {
        counter.restore();
      }
    });

    it('releases its connection before writing the fingerprint', async () => {
      const dbPath = path.join(dir, 'graph.db');
      await buildGraph(
        path.join(dir, 'src'),
        dbPath,
        'export function alpha(){}\n',
      );
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      await port.ask(searchRequest(dbPath, 'alpha'));

      await expect(
        port.ask({
          dbPath,
          task: { kind: 'persist-fingerprint', fingerprint: 'end-digest' },
        }),
      ).resolves.toEqual({ ok: true, result: { kind: 'persist-fingerprint' } });
      // The fingerprint writer closed as the only connection, so it
      // checkpointed and removed its WAL, as with one-shot readers.
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      await expect(
        port.ask({ dbPath, task: { kind: 'fingerprint-metadata' } }),
      ).resolves.toMatchObject({
        ok: true,
        result: { value: { fingerprint: 'end-digest', completed: true } },
      });
    });

    it('does not keep a build WAL on disk while it idles', async () => {
      const dbPath = path.join(dir, 'graph.db');
      const root = path.join(dir, 'src');
      await buildGraph(root, dbPath, 'export function alpha(){}\n');
      const port = new FakeParentPort();
      serveCodeGraphReads(port);
      await port.ask(searchRequest(dbPath, 'alpha'));

      // A refresh build runs and closes while the reader idles with its
      // connection open.
      writeFileSync(
        path.join(root, 'fixture.ts'),
        'export function alpha(){}\nexport function beta(){}\n',
      );
      const engine = await CodeGraphEngine.open({
        dbPath,
        repositories: [{ repoId: 'fixture', rootPath: root }],
      });
      try {
        await engine.buildOrUpdate({ verifyContent: true });
        expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      } finally {
        engine.close();
      }
      expect(
        existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0,
      ).toBe(0);
      // And the warm reader sees the refresh.
      expect(names(await port.ask(searchRequest(dbPath, 'beta')))).toEqual([
        'beta',
      ]);
    });
  });
});
