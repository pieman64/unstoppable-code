import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as WorkerThreads from 'node:worker_threads';
import {
  CONTAINER_CREATED_AT,
  WORKTREE_CONTAINER,
  addInput,
} from '@canopy/desktop-shared/node/ledger/__tests__/ledger-test-harness';
import { TSX_EXEC_ARGV } from './fixtures/tsx-worker-threads';

interface MockWorkerRecord {
  worker: WorkerThreads.Worker;
  filename: string | URL;
  options: WorkerThreads.WorkerOptions | undefined;
  exitCode: number | undefined;
}

const mockWorkers: MockWorkerRecord[] = [];

jest.mock('node:worker_threads', () => {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        // Jest runs TypeScript sources, so the test double is TypeScript as
        // well and runs through tsx; production starts the bundled worker.
        const [filename, options] = args;
        super(filename, {
          ...options,
          execArgv: [...TSX_EXEC_ARGV],
        });
        const record: MockWorkerRecord = {
          worker: this,
          filename,
          options,
          exitCode: undefined,
        };
        this.once('exit', (exitCode: number): void => {
          record.exitCode = exitCode;
        });
        mockWorkers.push(record);
      }
    },
  };
});

const mockGetLedgerDatabasePath = jest.fn(
  (): string => '/nonexistent/canopy-ledger-storage-host-test/ledger.sqlite',
);

jest.mock('../../lib/paths', () => ({
  getLedgerDatabasePath: (): string => mockGetLedgerDatabasePath(),
}));

import { createWorkerLedgerStoreClient } from '../storage-client';
import {
  getLedgerStorageHost,
  ledgerStorageWorkersStarted,
  LedgerStorageHost,
  LedgerStorageHostError,
  shutdownLedgerStorageHost,
  type LedgerStorageHostOptions,
} from '../storage-host';

jest.setTimeout(30_000);

const FIXTURE_ENTRY = join(__dirname, 'fixtures', 'echo-storage-worker.ts');

let tempDir: string;
const hosts: LedgerStorageHost[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ledger-storage-host-'));
  mockWorkers.length = 0;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  rmSync(tempDir, { recursive: true, force: true });
});

function databasePath(fileName = 'ledger.sqlite'): string {
  return join(tempDir, 'ledger', fileName);
}

function createHost(
  options: Partial<LedgerStorageHostOptions> = {},
): LedgerStorageHost {
  const host = new LedgerStorageHost({
    dbPath: databasePath(),
    workerEntry: FIXTURE_ENTRY,
    ...options,
  });
  hosts.push(host);
  return host;
}

async function hostError(
  call: Promise<unknown>,
): Promise<LedgerStorageHostError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof LedgerStorageHostError) return error;
    throw error;
  }
  throw new Error('Expected the Ledger storage call to fail');
}

function workerAt(index: number): MockWorkerRecord {
  const record = mockWorkers[index];
  if (!record) throw new Error(`No storage worker was started at ${index}`);
  return record;
}

/** Proves nothing holds the database lock by writing from this thread. */
function countOpens(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    const row: unknown = db
      .prepare('SELECT count(*) AS opens FROM fixture_opens')
      .get();
    if (
      typeof row !== 'object' ||
      row === null ||
      !('opens' in row) ||
      typeof row.opens !== 'number'
    ) {
      throw new Error('Unexpected fixture_opens row');
    }
    return row.opens;
  } finally {
    db.close();
  }
}

describe('LedgerStorageHost', () => {
  it('round-trips pending-title calls through the repository worker', async () => {
    const host = createHost({
      workerEntry: join(__dirname, '..', 'storage-worker.ts'),
    });
    const client = createWorkerLedgerStoreClient(host);
    const authorityId = await client.getAuthorityId();
    const { scope } = await client.bindScope({
      authorityId,
      container: WORKTREE_CONTAINER,
      containerCreatedAt: CONTAINER_CREATED_AT,
      accountId: null,
    });
    const ledgerId = scope.scope.ledgerId;
    const chat = await client.registerActor({
      ledgerId,
      kind: 'chat',
      authorityId,
      originKey: 'chat:pending-title',
      displayName: 'Pending title test',
    });
    const receipt = await client.addEntry(
      addInput(
        { ledgerId },
        chat.actor.actor,
        {
          type: 'TASK',
          content: 'A pending title entry without an explicit title.',
        },
        'pending-title-worker-round-trip',
      ),
    );
    const entryId = receipt.entry.entryId;

    await expect(client.listPendingTitles()).resolves.toEqual([
      {
        entryId,
        ledgerId,
        createdAt: receipt.entry.createdAt,
        attempts: 0,
        lastAttemptAt: null,
      },
    ]);
    const firstAttempt = await client.recordPendingTitleAttempt({ entryId });
    expect(firstAttempt).toMatchObject({ entryId, ledgerId, attempts: 1 });
    expect(firstAttempt?.lastAttemptAt).toEqual(expect.any(String));
    await expect(
      client.recordPendingTitleAttempt({ entryId }),
    ).resolves.toMatchObject({ entryId, ledgerId, attempts: 2 });
    await expect(
      client.resolvePendingTitle({ entryId, title: 'Resolved title' }),
    ).resolves.toMatchObject({
      resolved: true,
      entry: { entryId, title: 'Resolved title' },
    });
    await expect(client.listPendingTitles()).resolves.toEqual([]);
    await expect(
      client.recordPendingTitleAttempt({ entryId }),
    ).resolves.toBeNull();
    await expect(
      client.resolvePendingTitle({ entryId, title: null }),
    ).resolves.toEqual({ resolved: false, entry: null });
  });

  it('starts no worker and touches no files until the first call', async () => {
    const dbPath = databasePath();
    const host = createHost({ dbPath });

    expect(mockWorkers).toHaveLength(0);
    expect(existsSync(join(tempDir, 'ledger'))).toBe(false);

    await expect(host.call('echo', { value: 1 })).resolves.toEqual({
      order: 1,
      args: { value: 1 },
      overlapped: false,
    });
    expect(mockWorkers).toHaveLength(1);
    expect(workerAt(0).filename).toBe(FIXTURE_ENTRY);
    expect(workerAt(0).options).toMatchObject({
      workerData: { dbPath },
      name: 'ledger-storage',
    });
    // The worker, not the host, created the store.
    expect(existsSync(dbPath)).toBe(true);
  });

  it('counts each storage worker it starts, and none before the first call', async () => {
    const before = ledgerStorageWorkersStarted();
    const host = createHost({ dbPath: databasePath() });
    expect(ledgerStorageWorkersStarted()).toBe(before);

    await host.call('echo', { value: 1 });
    await host.call('echo', { value: 2 });

    expect(ledgerStorageWorkersStarted()).toBe(before + 1);
  });

  it('defaults to the bundled worker entry and never falls back to the main thread', async () => {
    const dbPath = databasePath();
    const host = new LedgerStorageHost({ dbPath });
    hosts.push(host);

    const error = await hostError(host.call('echo', {}));

    expect(error.reason).toBe('STORAGE_UNAVAILABLE');
    expect(workerAt(0).filename).toBe(
      join(__dirname, '..', 'ledger-storage-worker.js'),
    );
    expect(existsSync(join(tempDir, 'ledger'))).toBe(false);
  });

  it('sends one call at a time, in call order', async () => {
    const host = createHost();
    const delays = [40, 30, 20, 10, 0];

    const results = await Promise.all(
      delays.map((delayMs, index) => host.call('echo', { delayMs, index })),
    );

    expect(results).toEqual(
      delays.map((delayMs, index) => ({
        order: index + 1,
        args: { delayMs, index },
        overlapped: false,
      })),
    );
    expect(mockWorkers).toHaveLength(1);
  });

  it('reports a failed open as WRITER_UNAVAILABLE and opens again on the next call', async () => {
    const dbPath = databasePath();
    const writer = createHost({ dbPath });
    const contender = createHost({ dbPath });
    await writer.call('echo', {});

    const [firstError, secondError] = await Promise.all([
      hostError(contender.call('echo', { value: 'first' })),
      hostError(contender.call('echo', { value: 'second' })),
    ]);

    expect(firstError).toMatchObject({
      reason: 'WRITER_UNAVAILABLE',
      message: 'The Ledger database is in use',
      details: { lock: 'held' },
    });
    expect(secondError.reason).toBe('WRITER_UNAVAILABLE');

    await writer.shutdown();
    await expect(
      contender.call('echo', { value: 'after release' }),
    ).resolves.toMatchObject({ order: 1 });
    expect(mockWorkers).toHaveLength(3);
    expect(workerAt(1).exitCode).toBeDefined();
  });

  it('fails calls with STORAGE_UNAVAILABLE when the worker exits, then restarts on the next call', async () => {
    const dbPath = databasePath();
    const host = createHost({ dbPath });
    await host.call('echo', {});

    const [crashed, waiting] = await Promise.all([
      hostError(host.call('exit', {})),
      hostError(host.call('echo', { value: 'waiting' })),
    ]);

    expect(crashed).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      details: { exitCode: 3 },
    });
    expect(waiting.reason).toBe('STORAGE_UNAVAILABLE');

    await expect(host.call('echo', { value: 'again' })).resolves.toEqual({
      order: 1,
      args: { value: 'again' },
      overlapped: false,
    });
    expect(mockWorkers).toHaveLength(2);

    await host.shutdown();
    expect(countOpens(dbPath)).toBe(2);
  });

  it('fails calls with STORAGE_UNAVAILABLE when the worker throws', async () => {
    const host = createHost();

    const error = await hostError(host.call('throw', {}));

    expect(error.reason).toBe('STORAGE_UNAVAILABLE');
    expect(error.message).not.toContain('Scripted');
    await expect(host.call('echo', {})).resolves.toMatchObject({ order: 1 });
    expect(mockWorkers).toHaveLength(2);
  });

  it('passes a reported request failure through and keeps the worker', async () => {
    const host = createHost();

    const error = await hostError(
      host.call('fail', {
        reason: 'REVISION_CONFLICT',
        message: 'The entry changed',
        details: { reason: 'REVISION_CONFLICT', currentRevision: 3 },
      }),
    );

    expect(error).toBeInstanceOf(LedgerStorageHostError);
    expect(error).toMatchObject({
      name: 'LedgerStorageHostError',
      reason: 'REVISION_CONFLICT',
      message: 'The entry changed',
      details: { reason: 'REVISION_CONFLICT', currentRevision: 3 },
    });
    await expect(host.call('echo', {})).resolves.toMatchObject({ order: 1 });
    expect(mockWorkers).toHaveLength(1);
  });

  it('fails a call that is not answered in time and restarts on the next call', async () => {
    const host = createHost({ requestTimeoutMs: 300 });
    await host.call('echo', {});

    const error = await hostError(host.call('hang', {}));

    expect(error).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage did not answer',
    });
    await expect(host.call('echo', {})).resolves.toMatchObject({ order: 1 });
    expect(mockWorkers).toHaveLength(2);
    expect(workerAt(0).exitCode).toBeDefined();
  });

  it('fails calls when the worker does not open the database in time', async () => {
    const host = createHost({
      dbPath: databasePath('hang-on-open.sqlite'),
      startupTimeoutMs: 1_000,
    });

    const error = await hostError(host.call('echo', {}));

    expect(error).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage did not start',
    });
  });

  it.each(['malformed', 'wrong-id'])(
    'fails closed on a %s response',
    async (method) => {
      const host = createHost();

      const error = await hostError(host.call(method, {}));

      expect(error).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        message: 'Ledger storage sent an unexpected message',
      });
      await expect(host.call('echo', {})).resolves.toMatchObject({
        order: 1,
      });
      expect(mockWorkers).toHaveLength(2);
    },
  );

  it('rejects arguments that cannot be sent without stopping the worker', async () => {
    const host = createHost();

    const error = await hostError(
      host.call('echo', { callback: (): undefined => undefined }),
    );

    expect(error.reason).toBe('INTERNAL');
    await expect(host.call('echo', {})).resolves.toMatchObject({ order: 1 });
    expect(mockWorkers).toHaveLength(1);
  });

  it('refuses a call without a method before starting a worker', async () => {
    const host = createHost();

    expect((await hostError(host.call('', {}))).reason).toBe('INTERNAL');
    expect(mockWorkers).toHaveLength(0);
  });

  it('refuses calls beyond the queue bound', async () => {
    const host = createHost({ maxQueuedCalls: 2 });

    const accepted = [host.call('echo', {}), host.call('echo', {})];
    const refused = await hostError(host.call('echo', {}));

    expect(refused).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage is busy',
    });
    await expect(Promise.all(accepted)).resolves.toHaveLength(2);
  });

  it('shuts down after the in-flight call, rejecting waiting and later calls and releasing the database', async () => {
    const dbPath = databasePath();
    const host = createHost({ dbPath });
    await host.call('echo', {});
    expect(() => countOpens(dbPath)).toThrow('locked');

    const inFlight = host.call('echo', { delayMs: 200 });
    const waiting = hostError(host.call('echo', { value: 'waiting' }));
    const stopping = host.shutdown();

    expect(host.shutdown()).toBe(stopping);
    await expect(inFlight).resolves.toMatchObject({ order: 2 });
    expect(await waiting).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage is shutting down',
    });
    await stopping;
    expect(workerAt(0).exitCode).toBeDefined();
    expect(await hostError(host.call('echo', {}))).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage is shut down',
    });
    expect(mockWorkers).toHaveLength(1);
    expect(countOpens(dbPath)).toBe(1);
  });

  it('bounds shutdown when the in-flight call never finishes', async () => {
    const host = createHost({ shutdownTimeoutMs: 200 });
    await host.call('echo', {});
    const hung = hostError(host.call('hang', {}));

    await host.shutdown();

    expect((await hung).reason).toBe('STORAGE_UNAVAILABLE');
    expect(workerAt(0).exitCode).toBeDefined();
  });

  it('stops a worker that is still starting', async () => {
    const host = createHost();
    const starting = hostError(host.call('echo', {}));

    await host.shutdown();

    expect((await starting).reason).toBe('STORAGE_UNAVAILABLE');
    expect(mockWorkers).toHaveLength(1);
    expect(workerAt(0).exitCode).toBeDefined();
  });

  it('shuts down without starting a worker when it was never used', async () => {
    const host = createHost();

    await host.shutdown();

    expect((await hostError(host.call('echo', {}))).reason).toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(mockWorkers).toHaveLength(0);
    expect(existsSync(join(tempDir, 'ledger'))).toBe(false);
  });

  it('rejects timing options that are not positive', () => {
    expect(
      () =>
        new LedgerStorageHost({ dbPath: databasePath(), requestTimeoutMs: 0 }),
    ).toThrow(RangeError);
    expect(
      () =>
        new LedgerStorageHost({
          dbPath: databasePath(),
          startupTimeoutMs: Number.NaN,
        }),
    ).toThrow(RangeError);
  });
});

describe('getLedgerStorageHost', () => {
  it('returns one host that starts nothing and stays closed after shutdown', async () => {
    const host = getLedgerStorageHost();
    expect(getLedgerStorageHost()).toBe(host);
    expect(mockWorkers).toHaveLength(0);

    await shutdownLedgerStorageHost();

    expect((await hostError(host.call('echo', {}))).reason).toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(mockWorkers).toHaveLength(0);
    expect(existsSync('/nonexistent/canopy-ledger-storage-host-test')).toBe(
      false,
    );
  });
});

describe('shutdownLedgerStorageHost', () => {
  it('touches nothing when the Ledger was never used, and a later host refuses calls', async () => {
    await jest.isolateModulesAsync(async () => {
      const storageHost = await import('../storage-host');
      mockGetLedgerDatabasePath.mockClear();

      await storageHost.shutdownLedgerStorageHost();

      expect(mockGetLedgerDatabasePath).not.toHaveBeenCalled();
      const late = storageHost.getLedgerStorageHost();
      // The isolated module has its own error class, so match by shape.
      await expect(late.call('echo', {})).rejects.toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        message: 'Ledger storage is shut down',
      });
      expect(mockWorkers).toHaveLength(0);
    });
  });
});
