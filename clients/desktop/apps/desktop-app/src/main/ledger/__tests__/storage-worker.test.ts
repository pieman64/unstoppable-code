import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger';
import {
  CONTAINER_CREATED_AT,
  WORKTREE_CONTAINER,
} from '@canopy/desktop-shared/node/ledger/__tests__/ledger-test-harness';
import {
  LedgerErrorDetailsSchema,
  LedgerUuidSchema,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';
import type * as TsxWorkerThreads from './fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<typeof TsxWorkerThreads>('./fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

jest.mock('../../lib/paths', () => ({
  getLedgerDatabasePath: (): string =>
    '/nonexistent/canopy-ledger-storage-worker-test/ledger.sqlite',
}));

import { LedgerStorageHost, LedgerStorageHostError } from '../storage-host';
import {
  isLedgerStorageResponse,
  isLedgerStorageStartupMessage,
  type LedgerStorageWorkerData,
} from '../storage-worker-contract';
import { startedWorkers } from './fixtures/tsx-worker-threads';

jest.setTimeout(60_000);

const WORKER_ENTRY = join(__dirname, '..', 'storage-worker.ts');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_COUNTS = {
  scopes: 0,
  actors: 0,
  entries: 0,
  entryVersions: 0,
  mutations: 0,
  receipts: 0,
  outbox: 0,
  searchRows: 0,
};
/** The ledger ID inside a `bindScope` result. */
const BoundScopeSchema = z.object({
  scope: z.object({ scope: z.object({ ledgerId: LedgerUuidSchema }) }),
});

let tempDir: string;
const hosts: LedgerStorageHost[] = [];
const workers: Worker[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ledger-storage-worker-'));
  startedWorkers.length = 0;
});

afterEach(async () => {
  await Promise.all([
    ...hosts.splice(0).map((host) => host.shutdown()),
    ...workers.splice(0).map((worker) => worker.terminate()),
  ]);
  rmSync(tempDir, { recursive: true, force: true });
});

function databasePath(): string {
  return join(tempDir, 'ledger', 'ledger.sqlite');
}

function createHost(dbPath = databasePath()): LedgerStorageHost {
  const host = new LedgerStorageHost({ dbPath, workerEntry: WORKER_ENTRY });
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

/** Runs the worker without a host, to see the messages it sends. */
function startWorker(workerData: LedgerStorageWorkerData): {
  worker: Worker;
  next: () => Promise<unknown>;
} {
  const worker = new Worker(WORKER_ENTRY, { workerData });
  workers.push(worker);
  const received: unknown[] = [];
  const waiting: Array<(message: unknown) => void> = [];
  worker.on('message', (message: unknown): void => {
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else received.push(message);
  });
  return {
    worker,
    next: (): Promise<unknown> =>
      received.length > 0
        ? Promise.resolve(received.shift())
        : new Promise<unknown>((resolve) => {
            waiting.push(resolve);
          }),
  };
}

describe('Ledger storage worker', () => {
  it('runs repository methods from positional arguments', async () => {
    const host = createHost();

    const authorityId = await host.call('getAuthorityId', []);
    expect(authorityId).toEqual(expect.stringMatching(UUID));
    const bound = await host.call('bindScope', [
      {
        authorityId,
        container: WORKTREE_CONTAINER,
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      },
    ]);
    expect(bound).toMatchObject({
      created: true,
      scope: { scope: { authorityId, container: WORKTREE_CONTAINER } },
    });
    await expect(host.call('getScope', [randomUUID()])).resolves.toBeNull();
    await expect(host.call('getStorageCounts', [])).resolves.toMatchObject({
      scopes: 1,
      entries: 0,
    });
    expect(startedWorkers).toHaveLength(1);
  });

  it('answers each request in order, after reporting ready', async () => {
    const { worker, next } = startWorker({ dbPath: databasePath() });

    expect(await next()).toEqual({ type: 'ready' });
    worker.postMessage({ id: 1, method: 'getAuthorityId', args: [] });
    worker.postMessage({ id: 2, method: 'getStorageCounts', args: [] });
    const first = await next();
    const second = await next();

    const authorityId: unknown = expect.stringMatching(UUID);
    expect(isLedgerStorageResponse(first)).toBe(true);
    expect(first).toEqual({ id: 1, ok: true, result: authorityId });
    expect(second).toEqual({ id: 2, ok: true, result: EMPTY_COUNTS });
  });

  it('answers a malformed request that has an id and ignores one without', async () => {
    const { worker, next } = startWorker({ dbPath: databasePath() });
    expect(await next()).toEqual({ type: 'ready' });

    worker.postMessage({ id: 3, method: 7, args: [] });
    worker.postMessage({ method: 'getAuthorityId', args: [] });
    worker.postMessage({ id: 4, method: 'getStorageCounts' });
    worker.postMessage({ id: 5, method: 'getStorageCounts', args: [] });

    await expect(next()).resolves.toEqual({
      id: 3,
      ok: false,
      error: {
        reason: 'INTERNAL',
        message: 'The Ledger storage request is malformed',
      },
    });
    await expect(next()).resolves.toEqual({
      id: 4,
      ok: false,
      error: {
        reason: 'INTERNAL',
        message: 'The Ledger storage request is malformed',
      },
    });
    await expect(next()).resolves.toEqual({
      id: 5,
      ok: true,
      result: EMPTY_COUNTS,
    });
  });

  it.each([
    'close',
    'open',
    'authorityId',
    'toString',
    'constructor',
    '__proto__',
  ])(
    'rejects the unsupported method %p with INTERNAL and keeps serving',
    async (method) => {
      const host = createHost();

      const error = await hostError(host.call(method, []));

      expect(error).toMatchObject({
        reason: 'INTERNAL',
        message: 'The Ledger storage method is not supported',
        details: undefined,
      });
      await expect(host.call('getAuthorityId', [])).resolves.toMatch(UUID);
      expect(startedWorkers).toHaveLength(1);
    },
  );

  it.each<[string, string, unknown]>([
    ['no arguments', 'getAuthorityId', undefined],
    ['an object for arguments', 'getAuthorityId', {}],
    ['an extra argument', 'getStorageCounts', [{}]],
    ['an unwrapped argument', 'getScope', 'ledger-id'],
    ['a missing argument', 'getScope', []],
    ['a number for an id', 'getScope', [7]],
    ['two ids', 'listActors', ['a', 'b']],
    ['null for an input', 'bindScope', [null]],
    ['a string for an input', 'addEntry', ['input']],
    ['an array for an input', 'updateEntry', [[{}]]],
    ['a date for an input', 'searchEntries', [new Date(0)]],
    ['a map for an input', 'listChanges', [new Map([['limit', 1]])]],
    ['an argument for no parameters', 'listScopes', [{}]],
    ['an id for a container', 'findContainerScopes', ['worktree-1']],
    ['an unwrapped lifecycle input', 'setScopeLifecycle', { ledgerId: 'l' }],
    ['an array for a rebind input', 'rebindScope', [[]]],
    ['an input for a purged ledger id', 'purgeScope', [{ ledgerId: 'l' }]],
  ])(
    'rejects %s with INTERNAL and writes nothing',
    async (_label, method, args) => {
      const host = createHost();

      const error = await hostError(host.call(method, args));

      expect(error).toMatchObject({
        reason: 'INTERNAL',
        message: 'The Ledger storage request is malformed',
        details: undefined,
      });
      await expect(host.call('getStorageCounts', [])).resolves.toEqual(
        EMPTY_COUNTS,
      );
      expect(startedWorkers).toHaveLength(1);
    },
  );

  it('reports store errors with their reason, fixed message and protocol details', async () => {
    const host = createHost();
    const authorityId = await host.call('getAuthorityId', []);

    const invalidTime = await hostError(
      host.call('bindScope', [
        {
          authorityId,
          container: WORKTREE_CONTAINER,
          containerCreatedAt: 'yesterday',
          accountId: null,
        },
      ]),
    );
    const longOriginKey = await hostError(
      host.call('registerActor', [
        {
          ledgerId: randomUUID(),
          kind: 'user',
          authorityId,
          originKey: 'k'.repeat(3_000),
          displayName: 'You',
        },
      ]),
    );
    const missingScope = await hostError(
      host.call('listActors', [randomUUID()]),
    );

    expect(invalidTime).toMatchObject({
      reason: 'INVALID_INPUT',
      message: 'The Feed request is invalid.',
      details: { reason: 'INVALID_INPUT', field: 'containerCreatedAt' },
    });
    expect(longOriginKey).toMatchObject({
      reason: 'INVALID_INPUT',
      details: { reason: 'INVALID_INPUT', field: 'originKey', limit: 2_048 },
    });
    expect(missingScope).toMatchObject({
      reason: 'NOT_FOUND',
      message: 'The Feed item was not found.',
      details: { reason: 'NOT_FOUND' },
    });
    for (const error of [invalidTime, longOriginKey, missingScope]) {
      expect(LedgerErrorDetailsSchema.safeParse(error.details).success).toBe(
        true,
      );
    }
    expect(startedWorkers).toHaveLength(1);
  });

  it('runs the scope lifecycle methods and validates what their types cannot', async () => {
    const host = createHost();
    const authorityId = await host.call('getAuthorityId', []);
    const bound = await host.call('bindScope', [
      {
        authorityId,
        container: WORKTREE_CONTAINER,
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      },
    ]);
    const ledgerId = BoundScopeSchema.parse(bound).scope.scope.ledgerId;

    await expect(host.call('listScopes', [])).resolves.toHaveLength(1);
    await expect(
      host.call('findContainerScopes', [WORKTREE_CONTAINER]),
    ).resolves.toHaveLength(1);
    const unknownState = await hostError(
      host.call('setScopeLifecycle', [{ ledgerId, state: 'purged' }]),
    );
    const badLedgerId = await hostError(
      host.call('rebindScope', [
        {
          ledgerId: 7,
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        },
      ]),
    );
    const badContainer = await hostError(
      host.call('findContainerScopes', [{ kind: 'folder' }]),
    );
    expect(unknownState).toMatchObject({
      reason: 'INVALID_INPUT',
      details: { reason: 'INVALID_INPUT', field: 'state' },
    });
    expect(badLedgerId).toMatchObject({
      reason: 'INVALID_INPUT',
      details: { reason: 'INVALID_INPUT', field: 'ledgerId' },
    });
    expect(badContainer).toMatchObject({
      reason: 'INVALID_INPUT',
      details: { reason: 'INVALID_INPUT', field: 'container.kind' },
    });

    await expect(
      host.call('setScopeLifecycle', [
        { ledgerId, state: 'retirement_pending' },
      ]),
    ).resolves.toMatchObject({ lifecycleState: 'retirement_pending' });
    await expect(host.call('purgeScope', [ledgerId])).resolves.toEqual({
      purged: true,
    });
    await expect(host.call('getStorageCounts', [])).resolves.toEqual(
      EMPTY_COUNTS,
    );
    expect(startedWorkers).toHaveLength(1);
  });

  it('reports a database it cannot open without its path', async () => {
    const blocker = join(tempDir, 'not-a-directory');
    writeFileSync(blocker, 'file');
    const dbPath = join(blocker, 'ledger.sqlite');
    const host = createHost(dbPath);

    const error = await hostError(host.call('getAuthorityId', []));

    // The host keeps the reason the worker reported for the failed open.
    expect(error).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Feed storage is unavailable.',
      details: { reason: 'STORAGE_UNAVAILABLE' },
    });
    expect(JSON.stringify([error.message, error.details])).not.toContain(
      tempDir,
    );
  });

  it('reports a damaged database as STORAGE_UNAVAILABLE and leaves it untouched', async () => {
    const dbPath = databasePath();
    const damaged = Buffer.from('not a Ledger database, just damaged bytes');
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, damaged);
    const host = createHost(dbPath);

    const error = await hostError(host.call('getAuthorityId', []));

    expect(error).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Feed storage is unavailable.',
      details: { reason: 'STORAGE_UNAVAILABLE' },
    });
    expect(JSON.stringify([error.message, error.details])).not.toContain(
      tempDir,
    );
    expect(readFileSync(dbPath)).toEqual(damaged);
  });

  it('reports a start without a database path', async () => {
    const host = createHost('');

    const error = await hostError(host.call('getAuthorityId', []));

    expect(error).toMatchObject({
      reason: 'INTERNAL',
      message: 'The Ledger storage worker was started without a database path',
      details: undefined,
    });
  });

  it('exits on its own after a failed open', async () => {
    const { worker, next } = startWorker({ dbPath: '' });
    const exited = new Promise<number>((resolve) => {
      worker.once('exit', resolve);
    });

    const startup = await next();

    expect(isLedgerStorageStartupMessage(startup)).toBe(true);
    expect(startup).toMatchObject({ type: 'openFailed' });
    await expect(exited).resolves.toBe(0);
  });

  it('releases the database lock by the time the host has shut down', async () => {
    const dbPath = databasePath();
    const host = createHost(dbPath);
    const authorityId = await host.call('getAuthorityId', []);

    await host.shutdown();

    // An open that cannot wait for the lock succeeds at once.
    const reopened = LedgerRepository.open({
      databasePath: dbPath,
      openBusyTimeoutMs: 0,
    });
    try {
      expect(reopened.authorityId).toBe(authorityId);
    } finally {
      reopened.close();
    }
    expect(startedWorkers[0]?.exitCode).toBeDefined();
  });
});
