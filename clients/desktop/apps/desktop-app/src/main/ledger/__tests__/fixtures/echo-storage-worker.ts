import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  LedgerStorageResponse,
  LedgerStorageStartupMessage,
} from '../../storage-worker-contract';

/*
 * Test double for the Ledger storage worker, run through tsx by the storage
 * host tests. Like the real worker, it takes the database's exclusive write
 * lock when it opens and reports `openFailed` when another connection holds
 * that lock. Requests are scripted by method name. Tests must not import this
 * module: it runs only as a worker entry.
 */

// Opening a database with this file name never finishes (see the host tests).
const HANG_ON_OPEN_FILENAME = 'hang-on-open.sqlite';

interface FixtureRequest {
  id: number;
  method: string;
  args: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequest(value: unknown): FixtureRequest | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    typeof value.method !== 'string'
  ) {
    return undefined;
  }
  return { id: value.id, method: value.method, args: value.args };
}

function delayOf(args: unknown): number {
  return isRecord(args) && typeof args.delayMs === 'number' ? args.delayMs : 0;
}

function openExclusively(dbPath: string): DatabaseSync | undefined {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 50 });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('PRAGMA journal_mode = WAL');
    // The first write takes the exclusive lock, and the connection keeps it.
    db.exec(
      'CREATE TABLE IF NOT EXISTS fixture_opens (opened_at INTEGER NOT NULL)',
    );
    db.prepare('INSERT INTO fixture_opens (opened_at) VALUES (?)').run(
      Date.now(),
    );
    return db;
  } catch {
    db.close();
    return undefined;
  }
}

const port = parentPort;
const data: unknown = workerData;
const dbPath =
  isRecord(data) && typeof data.dbPath === 'string' ? data.dbPath : undefined;
if (!port || dbPath === undefined) {
  throw new Error('The storage worker fixture needs a parent port and path');
}

function post(
  message: LedgerStorageStartupMessage | LedgerStorageResponse | object,
): void {
  port?.postMessage(message);
}

let echoed = 0;
let unanswered = 0;
let overlapped = false;

function answer(message: LedgerStorageResponse | object): void {
  unanswered -= 1;
  post(message);
}

const handlers = new Map<string, (request: FixtureRequest) => void>([
  [
    'echo',
    (request): void => {
      setTimeout((): void => {
        echoed += 1;
        answer({
          id: request.id,
          ok: true,
          result: { order: echoed, args: request.args, overlapped },
        });
      }, delayOf(request.args));
    },
  ],
  [
    'fail',
    (request): void => {
      answer({ id: request.id, ok: false, error: request.args });
    },
  ],
  ['hang', (): void => undefined],
  ['exit', (): never => process.exit(3)],
  [
    'throw',
    (): never => {
      throw new Error('Scripted storage worker crash');
    },
  ],
  [
    'malformed',
    (request): void => {
      answer({ id: request.id, ok: 'maybe' });
    },
  ],
  [
    'wrong-id',
    (request): void => {
      answer({ id: request.id + 1, ok: true, result: null });
    },
  ],
]);

// Listening keeps the worker alive, including when it never finishes opening.
port.on('message', (value: unknown): void => {
  const request = readRequest(value);
  if (!request) return;
  if (unanswered > 0) overlapped = true;
  unanswered += 1;
  const handler = handlers.get(request.method);
  if (handler) {
    handler(request);
    return;
  }
  answer({
    id: request.id,
    ok: false,
    error: { reason: 'INTERNAL', message: 'Unknown fixture method' },
  });
});

const hangOnOpen = basename(dbPath) === HANG_ON_OPEN_FILENAME;
// Held for the worker's lifetime, so the lock is released only when it stops.
const database = hangOnOpen ? undefined : openExclusively(dbPath);
if (!hangOnOpen) {
  post(
    database
      ? { type: 'ready' }
      : {
          type: 'openFailed',
          error: {
            reason: 'WRITER_UNAVAILABLE',
            message: 'The Ledger database is in use',
            details: { lock: 'held' },
          },
        },
  );
}
