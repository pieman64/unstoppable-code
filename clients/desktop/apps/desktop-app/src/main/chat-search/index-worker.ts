import { parentPort, workerData } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ChatSearchIndexer } from './indexer';
import { openChatSearchDatabase } from './schema';
import {
  INDEX_WORKER_METHODS,
  isIndexWorkerRequest,
  type IndexWorkerResponse,
} from './index-worker-contract';
import { isRecord } from '../lib/type-guards';

function databasePath(db: DatabaseSync): string | null {
  const row: unknown = db.prepare('PRAGMA database_list').get();
  return isRecord(row) && typeof row.file === 'string' && row.file.length > 0
    ? row.file
    : null;
}

/** Sole SQLite writer for one service instance; no Electron, provider, or canonical chat owner lives here. */
function run(): void {
  const port = parentPort;
  if (!port) return;
  const data: unknown = workerData;
  if (!isRecord(data) || typeof data.dbPath !== 'string')
    throw new Error('Invalid search index worker configuration');
  let db = openChatSearchDatabase(data.dbPath);
  let readablePath = databasePath(db);
  let temporaryDirectory: string | undefined;
  if (!readablePath) {
    // Keep recovery searchable through a read-only main connection as well.
    // The temporary derived index is rebuilt next launch; never fall back to main-thread writes.
    db.close();
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'canopy-search-index-'));
    db = openChatSearchDatabase(join(temporaryDirectory, 'index.sqlite'));
    readablePath = databasePath(db);
    if (!readablePath) {
      db.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
      throw new Error('Search index storage is unavailable');
    }
  }
  const indexer = new ChatSearchIndexer(db);
  const allowed = new Set<string>(INDEX_WORKER_METHODS);
  const send = (message: IndexWorkerResponse): void =>
    port.postMessage(message);
  send({ kind: 'ready', dbPath: readablePath });
  port.on('message', (input: unknown): void => {
    if (!isIndexWorkerRequest(input)) {
      send({ kind: 'fatal', error: 'Invalid search index worker request' });
      return;
    }
    const request = input;
    try {
      if (request.method === 'close') {
        db.close();
        if (temporaryDirectory)
          rmSync(temporaryDirectory, { recursive: true, force: true });
        send({ kind: 'result', id: request.id, ok: true, value: undefined });
        port.close();
        return;
      }
      if (request.method !== 'barrier' && !allowed.has(request.method))
        throw new Error('Unknown search index operation');
      const value: unknown =
        request.method === 'barrier'
          ? undefined
          : Reflect.apply(indexer[request.method], indexer, request.args);
      send({ kind: 'result', id: request.id, ok: true, value });
    } catch (error) {
      send({
        kind: 'result',
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
try {
  run();
} catch (error) {
  parentPort?.postMessage({
    kind: 'fatal',
    error: error instanceof Error ? error.message : String(error),
  } satisfies IndexWorkerResponse);
  parentPort?.close();
}
