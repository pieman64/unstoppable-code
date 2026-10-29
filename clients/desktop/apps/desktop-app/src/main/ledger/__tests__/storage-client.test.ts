import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  LedgerRepository,
  type LedgerActorRecord,
  type LedgerBindScopeInput,
  type LedgerRegisterActorInput,
  type LedgerScopeRecord,
  type LedgerStorageCounts,
} from '@canopy/desktop-shared/node/ledger';
import {
  CHAT_DETAILS,
  CONTAINER_CREATED_AT,
  NO_DETAILS,
  WORKTREE_CONTAINER,
  addInput,
  updateInput,
  worktreeContainer,
} from '@canopy/desktop-shared/node/ledger/__tests__/ledger-test-harness';
import {
  LedgerErrorDetailsSchema,
  type LedgerActorKind,
  type LedgerActorRef,
  type LedgerAddEntryParams,
  type LedgerContainer,
} from '@canopy/protocol/canopy-core';
import type * as TsxWorkerThreads from './fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<typeof TsxWorkerThreads>('./fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

jest.mock('../../lib/paths', () => ({
  getLedgerDatabasePath: (): string =>
    '/nonexistent/canopy-ledger-storage-client-test/ledger.sqlite',
}));

import type {
  LedgerStoreClient,
  LedgerStoreRebindScopeInput,
  LedgerStoreSetScopeLifecycleInput,
} from '../ledger-store-client';
import {
  createWorkerLedgerStoreClient,
  getLedgerStoreClient,
} from '../storage-client';
import {
  LedgerStorageHost,
  LedgerStorageHostError,
  shutdownLedgerStorageHost,
} from '../storage-host';
import { TSX_EXEC_ARGV, startedWorkers } from './fixtures/tsx-worker-threads';

jest.setTimeout(60_000);

const WORKER_ENTRY = join(__dirname, '..', 'storage-worker.ts');
const OPEN_PROBE = join(__dirname, 'fixtures', 'ledger-open-probe.ts');
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = 'Nightjar launch figures';
const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Wire the storage worker',
  content: 'Route every Ledger store call through the storage worker.',
};

let tempDir: string;
const hosts: LedgerStorageHost[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ledger-storage-client-'));
  startedWorkers.length = 0;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
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
  throw new Error('Expected the Ledger store call to fail');
}

interface SeededLedger {
  readonly authorityId: string;
  readonly scope: LedgerScopeRecord;
  readonly ledgerId: string;
  readonly user: LedgerActorRef;
  readonly chat: LedgerActorRef;
}

/** Binds the test worktree's scope and registers a user and a chat. */
async function seedLedger(client: LedgerStoreClient): Promise<SeededLedger> {
  const authorityId = await client.getAuthorityId();
  const { scope } = await client.bindScope({
    authorityId,
    container: WORKTREE_CONTAINER,
    containerCreatedAt: CONTAINER_CREATED_AT,
    accountId: 'account-1',
  });
  const ledgerId = scope.scope.ledgerId;
  const register = async (
    kind: LedgerActorKind,
    originKey: string,
    displayName: string,
  ): Promise<LedgerActorRef> =>
    (
      await client.registerActor({
        ledgerId,
        kind,
        authorityId,
        originKey,
        displayName,
      })
    ).actor.actor;
  return {
    authorityId,
    scope,
    ledgerId,
    user: await register('user', 'user:local', 'You'),
    chat: await register('chat', 'chat:1', 'Chat 1'),
  };
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Size and modification time of the database and its sidecar files. Stat never
 * opens them: closing a descriptor this process opened on the database would
 * drop the process's POSIX locks on it, including the worker's lock.
 */
function statDatabaseFiles(dbPath: string): Record<string, FileStat | null> {
  const snapshot: Record<string, FileStat | null> = {};
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${dbPath}${suffix}`;
    if (!existsSync(path)) {
      snapshot[suffix || 'db'] = null;
      continue;
    }
    const { size, mtimeMs } = statSync(path);
    snapshot[suffix || 'db'] = { size, mtimeMs };
  }
  return snapshot;
}

/** Opens the database from a separate Node process, without waiting. */
function runOpenProbe(dbPath: string): Promise<unknown> {
  return new Promise<unknown>((resolveProbe, reject) => {
    const child = spawn(
      process.execPath,
      [...TSX_EXEC_ARGV, OPEN_PROBE, dbPath],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string): void => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string): void => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code: number | null): void => {
      if (code !== 0) {
        reject(
          new Error(`The open probe exited with ${String(code)}: ${stderr}`),
        );
        return;
      }
      try {
        const outcome: unknown = JSON.parse(stdout);
        resolveProbe(outcome);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

describe('createWorkerLedgerStoreClient', () => {
  it('starts no worker and creates no files until the first call', async () => {
    const dbPath = databasePath();
    const client = createWorkerLedgerStoreClient(createHost(dbPath));

    expect(startedWorkers).toHaveLength(0);
    expect(existsSync(dirname(dbPath))).toBe(false);

    await expect(client.getStorageCounts()).resolves.toMatchObject({
      scopes: 0,
    });
    expect(startedWorkers).toHaveLength(1);
    expect(startedWorkers[0]?.workerData).toEqual({ dbPath });
    expect(existsSync(dbPath)).toBe(true);
  });

  it('round-trips every store method through the worker', async () => {
    const client = createWorkerLedgerStoreClient(createHost());

    const authorityId = await client.getAuthorityId();
    expect(authorityId).toMatch(UUID);
    const bindInput: LedgerBindScopeInput = {
      authorityId,
      container: WORKTREE_CONTAINER,
      containerCreatedAt: CONTAINER_CREATED_AT,
      accountId: 'account-1',
    };
    const bound = await client.bindScope(bindInput);
    expect(bound).toMatchObject({
      created: true,
      scope: {
        scope: { authorityId, container: WORKTREE_CONTAINER },
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: 'account-1',
        lifecycleState: 'active',
      },
    });
    const ledgerId = bound.scope.scope.ledgerId;
    await expect(client.bindScope(bindInput)).resolves.toEqual({
      scope: bound.scope,
      created: false,
    });
    await expect(
      client.findScope({
        container: WORKTREE_CONTAINER,
        containerCreatedAt: CONTAINER_CREATED_AT,
      }),
    ).resolves.toEqual(bound.scope);
    await expect(client.getScope(ledgerId)).resolves.toEqual(bound.scope);
    await expect(client.getScope(randomUUID())).resolves.toBeNull();

    const userInput: LedgerRegisterActorInput = {
      ledgerId,
      kind: 'user',
      authorityId,
      originKey: 'user:local',
      displayName: 'You',
    };
    const user = await client.registerActor(userInput);
    expect(user).toMatchObject({
      created: true,
      actor: { ledgerId, originKey: 'user:local', displayName: 'You' },
    });
    await expect(client.registerActor(userInput)).resolves.toEqual({
      actor: user.actor,
      created: false,
    });
    const chat = await client.registerActor({
      ledgerId,
      kind: 'chat',
      authorityId,
      originKey: 'chat:1',
      displayName: 'Chat 1',
    });
    const helper = await client.registerActor({
      ledgerId,
      kind: 'background',
      authorityId,
      originKey: 'summary:generation-1',
      displayName: 'Summary',
    });
    await expect(client.listActors(ledgerId)).resolves.toEqual([
      user.actor,
      chat.actor,
      helper.actor,
    ]);

    const addition = addInput({ ledgerId }, chat.actor.actor, TASK, 'add-1');
    const added = await client.addEntry(addition);
    expect(added).toMatchObject({
      changed: true,
      // Committed on this device; the mirror has not acknowledged it.
      syncState: 'pending',
      entry: {
        revision: 1,
        type: 'TASK',
        title: TASK.title,
        owner: chat.actor.actor,
      },
    });
    // An exact replay returns the stored receipt.
    await expect(client.addEntry(addition)).resolves.toEqual(added);

    const read = await client.getEntry({
      ledgerId,
      entryId: added.entry.entryId,
      includeHistory: true,
    });
    expect(read.entry).toEqual(added.entry);
    expect(read.sourceAvailability).toBe('available');
    expect(read.history?.mutations).toHaveLength(1);

    const summary = await client.publishSummary({
      ledgerId,
      helper: helper.actor.actor,
      helperDetails: NO_DETAILS,
      params: {
        snapshotId: 'snapshot-1',
        generationId: 'generation-1',
        title: 'Summary of the work',
        content: 'The storage worker is wired.',
        sourceTruncated: false,
      },
      idempotencyKey: `summary:${ledgerId}:snapshot-1`,
    });
    expect(summary.entry).toMatchObject({
      type: 'SUMMARY',
      status: 'INFO',
      author: helper.actor.actor,
    });

    const search = await client.searchEntries({
      ledgerId,
      query: 'storage worker',
      sort: 'created_desc',
    });
    expect(search.entries.map((item) => item.entryId).sort()).toEqual(
      [added.entry.entryId, summary.entry.entryId].sort(),
    );
    expect(search).toMatchObject({ nextCursor: null, hasMore: false });
    expect(search).not.toHaveProperty('owners');
    // Each entry's origin crosses beside it, for the host to resolve.
    expect(search.origins).toHaveLength(search.entries.length);
    expect(search.origins.map((origin) => origin.kind).sort()).toEqual([
      'chat',
      'summary',
    ]);

    const changes = await client.listChanges({ ledgerId, afterSequence: '0' });
    expect(changes.changes).toEqual([
      expect.objectContaining({ entryId: added.entry.entryId, revision: 1 }),
      expect.objectContaining({ entryId: summary.entry.entryId, revision: 1 }),
    ]);
    expect(changes.hasMore).toBe(false);

    await expect(client.getStorageCounts()).resolves.toEqual({
      scopes: 1,
      actors: 3,
      entries: 2,
      entryVersions: 2,
      mutations: 2,
      receipts: 2,
      outbox: 6,
      searchRows: 2,
    });

    // Parsed results are rebuilt in this realm, not left as foreign clones.
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
    expect(search.entries).toBeInstanceOf(Array);
    expect(startedWorkers).toHaveLength(1);
  });

  it('round-trips the sync methods through the worker', async () => {
    const client = createWorkerLedgerStoreClient(createHost());
    const { ledgerId, chat } = await seedLedger(client);
    const added = await client.addEntry(
      addInput({ ledgerId }, chat, TASK, 'to-sync'),
    );
    const scope = await client.getScope(ledgerId);
    const unsynced = {
      scope,
      acknowledgedSequence: '0',
      mirrorAudience: null,
      audienceConfirmedAt: null,
      repairReason: null,
    };

    await expect(client.listSyncScopes()).resolves.toEqual([unsynced]);
    await expect(client.getScopeSync(ledgerId)).resolves.toEqual(unsynced);
    await expect(client.getScopeSync(randomUUID())).resolves.toBeNull();

    const events = await client.readOutbox({
      ledgerId,
      afterSequence: '0',
      limit: 100,
    });
    expect(events.map((event) => event.scopeSequence)).toEqual(
      events.map((_event, index) => String(index + 1)),
    );
    expect(events.at(-1)).toMatchObject({
      kind: 'entry_revision',
      entryId: added.entry.entryId,
      entryRevision: 1,
      scopeSequence: added.localSequence,
    });
    expect(Object.getPrototypeOf(events[0])).toBe(Object.prototype);

    await expect(
      client.recordMirrorAudience({ ledgerId, audience: { kind: 'private' } }),
    ).resolves.toMatchObject({ mirrorAudience: { kind: 'private' } });
    await expect(
      client.acknowledgeOutbox({ ledgerId, sequence: added.localSequence }),
    ).resolves.toMatchObject({ acknowledgedSequence: added.localSequence });
    await expect(
      client.readOutbox({ ledgerId, afterSequence: '0', limit: 100 }),
    ).resolves.toEqual([]);
    await expect(
      client.getEntry({ ledgerId, entryId: added.entry.entryId }),
    ).resolves.toMatchObject({ syncState: 'mirrored' });
    const page = await client.searchEntries({ ledgerId });
    expect(page.entries.map((entry) => entry.syncState)).toEqual(['mirrored']);

    await expect(
      client.setScopeRepair({ ledgerId, reason: 'stale_writer' }),
    ).resolves.toMatchObject({ repairReason: 'stale_writer' });
    await expect(
      client.rebindAccount({
        fromAccountId: 'account-1',
        toAccountId: 'account-2',
      }),
    ).resolves.toEqual({ rebound: 1 });
    await expect(client.getScope(ledgerId)).resolves.toMatchObject({
      accountId: 'account-2',
    });

    // A store refusal crosses the worker boundary with its reason.
    expect(
      await hostError(client.acknowledgeOutbox({ ledgerId, sequence: '999' })),
    ).toMatchObject({ reason: 'INVALID_INPUT' });
    expect(startedWorkers).toHaveLength(1);
  });

  it('round-trips the scope lifecycle methods through the worker', async () => {
    const client = createWorkerLedgerStoreClient(createHost());
    const { authorityId, ledgerId, chat } = await seedLedger(client);
    const addition = addInput({ ledgerId }, chat, TASK, 'before-archive');
    const added = await client.addEntry(addition);
    const { scope: other } = await client.bindScope({
      authorityId,
      container: worktreeContainer('worktree-2'),
      containerCreatedAt: CONTAINER_CREATED_AT,
      accountId: null,
    });
    const current = await client.getScope(ledgerId);

    await expect(client.listScopes()).resolves.toEqual([current, other]);
    await expect(
      client.findContainerScopes(WORKTREE_CONTAINER),
    ).resolves.toEqual([current]);

    const archived = await client.setScopeLifecycle({
      ledgerId,
      state: 'archived',
    });
    expect(archived).toMatchObject({
      scope: { ledgerId, container: WORKTREE_CONTAINER },
      lifecycleState: 'archived',
    });
    const readOnly = await hostError(
      client.addEntry(addInput({ ledgerId }, chat, TASK, 'while-archived')),
    );
    expect(readOnly).toMatchObject({
      reason: 'SCOPE_RETIRED',
      details: { reason: 'SCOPE_RETIRED' },
    });

    // Restore creates a new container; the archived scope moves to it.
    const restoredContainer: LedgerContainer =
      worktreeContainer('worktree-1-r');
    const rebound = await client.rebindScope({
      ledgerId,
      container: restoredContainer,
      containerCreatedAt: '2026-09-20T09:30:00.000Z',
    });
    expect(rebound).toEqual({
      ...archived,
      scope: { ...archived.scope, container: restoredContainer },
      containerCreatedAt: '2026-09-20T09:30:00.000Z',
      lifecycleState: 'active',
      sequence: String(Number(archived.sequence) + 1),
    });
    await expect(
      client.findContainerScopes(restoredContainer),
    ).resolves.toEqual([rebound]);
    await expect(
      client.getEntry({ ledgerId, entryId: added.entry.entryId }),
    ).resolves.toMatchObject({ entry: { scope: rebound.scope } });
    // An exact replay still returns the stored receipt.
    await expect(client.addEntry(addition)).resolves.toEqual(added);

    const live = await hostError(client.purgeScope(ledgerId));
    expect(live).toMatchObject({
      reason: 'FORBIDDEN',
      details: { reason: 'FORBIDDEN', field: 'ledgerId' },
    });
    await expect(
      client.setScopeLifecycle({ ledgerId, state: 'retirement_pending' }),
    ).resolves.toMatchObject({ lifecycleState: 'retirement_pending' });
    await expect(client.purgeScope(ledgerId)).resolves.toEqual({
      purged: true,
    });
    await expect(client.purgeScope(ledgerId)).resolves.toEqual({
      purged: false,
    });
    await expect(client.listScopes()).resolves.toEqual([other]);
    await expect(client.getStorageCounts()).resolves.toEqual({
      scopes: 1,
      actors: 0,
      entries: 0,
      entryVersions: 0,
      mutations: 0,
      receipts: 0,
      outbox: 1,
      searchRows: 0,
    });
    const missing = await hostError(
      client.setScopeLifecycle({ ledgerId, state: 'archived' }),
    );
    expect(missing).toMatchObject({
      reason: 'NOT_FOUND',
      details: { reason: 'NOT_FOUND', field: 'ledgerId' },
    });
    expect(startedWorkers).toHaveLength(1);
  });

  it('keeps the authority ID and data across a host shutdown and a fresh host', async () => {
    const dbPath = databasePath();
    const first = createHost(dbPath);
    const seeded = await seedLedger(createWorkerLedgerStoreClient(first));
    await first.shutdown();

    const restarted = createWorkerLedgerStoreClient(createHost(dbPath));

    await expect(restarted.getAuthorityId()).resolves.toBe(seeded.authorityId);
    await expect(restarted.getScope(seeded.ledgerId)).resolves.toMatchObject({
      scope: seeded.scope.scope,
    });
    expect(startedWorkers).toHaveLength(2);
    expect(startedWorkers[0]?.exitCode).toBeDefined();
  });

  it('T05: commits exactly one of two concurrent updates racing the same revision', async () => {
    const client = createWorkerLedgerStoreClient(createHost());
    const { ledgerId, user, chat } = await seedLedger(client);
    const added = await client.addEntry(
      addInput({ ledgerId }, chat, TASK, 'task'),
    );
    const entryId = added.entry.entryId;
    const before = await client.getStorageCounts();

    // Both are sent before either commits; the worker runs them one at a time.
    const [first, second] = await Promise.allSettled([
      client.updateEntry(
        updateInput(
          { ledgerId },
          chat,
          { entryId, expectedRevision: 1, status: 'IN_PROGRESS' },
          'chat-starts',
        ),
      ),
      client.updateEntry(
        updateInput(
          { ledgerId },
          user,
          { entryId, expectedRevision: 1, status: 'BLOCKED' },
          'user-blocks',
        ),
      ),
    ]);

    expect(first).toMatchObject({
      status: 'fulfilled',
      value: { changed: true, entry: { revision: 2, status: 'IN_PROGRESS' } },
    });
    expect(second.status).toBe('rejected');
    const conflict: unknown =
      second.status === 'rejected' ? second.reason : undefined;
    expect(conflict).toBeInstanceOf(LedgerStorageHostError);
    expect(conflict).toMatchObject({
      reason: 'REVISION_CONFLICT',
      message: 'The Feed entry changed since it was read.',
    });
    const details =
      conflict instanceof LedgerStorageHostError
        ? LedgerErrorDetailsSchema.parse(conflict.details)
        : undefined;
    expect(details).toMatchObject({
      reason: 'REVISION_CONFLICT',
      field: 'expectedRevision',
      currentEntry: { entryId, revision: 2, status: 'IN_PROGRESS' },
    });

    const after = await client.getStorageCounts();
    const committed = (counts: LedgerStorageCounts): number[] => [
      counts.entries,
      counts.entryVersions,
      counts.mutations,
      counts.receipts,
    ];
    expect(committed(after)).toEqual(
      committed({
        ...before,
        entryVersions: before.entryVersions + 1,
        mutations: before.mutations + 1,
        receipts: before.receipts + 1,
      }),
    );
    await expect(client.getEntry({ ledgerId, entryId })).resolves.toMatchObject(
      {
        entry: { revision: 2, status: 'IN_PROGRESS' },
      },
    );
  });

  it('T15: refuses a second writer while one holds the database, writing nothing, then opens once it shuts down', async () => {
    const dbPath = databasePath();
    const holder = createHost(dbPath);
    const holderClient = createWorkerLedgerStoreClient(holder);
    const { authorityId, ledgerId, chat } = await seedLedger(holderClient);
    await holderClient.addEntry(addInput({ ledgerId }, chat, TASK, 'held'));
    const counts = await holderClient.getStorageCounts();
    const files = statDatabaseFiles(dbPath);

    // A second host in this process.
    const contender = createWorkerLedgerStoreClient(createHost(dbPath));
    const refused = await hostError(contender.getAuthorityId());
    expect(refused).toMatchObject({
      reason: 'WRITER_UNAVAILABLE',
      message: 'Another process holds the Feed database.',
    });
    expect(LedgerErrorDetailsSchema.parse(refused.details)).toEqual({
      reason: 'WRITER_UNAVAILABLE',
    });
    expect(refused.message).not.toContain(tempDir);
    // A second process.
    await expect(runOpenProbe(dbPath)).resolves.toEqual({
      opened: false,
      reason: 'WRITER_UNAVAILABLE',
    });

    expect(statDatabaseFiles(dbPath)).toEqual(files);
    await expect(holderClient.getStorageCounts()).resolves.toEqual(counts);

    await holder.shutdown();
    // The lock is released by the time shutdown resolves: an open that cannot
    // wait for it succeeds, in this process and in another.
    const reopened = LedgerRepository.open({
      databasePath: dbPath,
      openBusyTimeoutMs: 0,
    });
    try {
      expect(reopened.authorityId).toBe(authorityId);
    } finally {
      reopened.close();
    }
    await expect(runOpenProbe(dbPath)).resolves.toEqual({
      opened: true,
      authorityId,
    });

    await expect(contender.getAuthorityId()).resolves.toBe(authorityId);
    await expect(contender.getStorageCounts()).resolves.toEqual(counts);
  });

  it('rejects store errors with the store reason and protocol details, and no entry text or paths in the message', async () => {
    const client = createWorkerLedgerStoreClient(createHost());
    const { ledgerId, chat } = await seedLedger(client);
    const secretTask: LedgerAddEntryParams = {
      type: 'TASK',
      title: SECRET,
      content: `${SECRET} are due on Friday.`,
      referenceFiles: [{ rootId: 'repo', path: 'plans/nightjar.md' }],
    };
    const added = await client.addEntry(
      addInput({ ledgerId }, chat, secretTask, 'secret'),
    );
    const entryId = added.entry.entryId;
    await client.updateEntry(
      updateInput(
        { ledgerId },
        chat,
        { entryId, expectedRevision: 1, status: 'COMPLETED' },
        'complete',
      ),
    );

    const errors = [
      await hostError(
        client.updateEntry(
          updateInput(
            { ledgerId },
            chat,
            { entryId, expectedRevision: 2, status: 'FAILED' },
            'reopen',
          ),
        ),
      ),
      await hostError(
        client.addEntry(
          addInput(
            { ledgerId },
            chat,
            { ...secretTask, content: `${SECRET} slipped.` },
            'secret',
          ),
        ),
      ),
      await hostError(
        client.addEntry(
          addInput(
            { ledgerId },
            chat,
            { ...secretTask, title: `${SECRET} ${'x'.repeat(100)}` },
            'too-long',
          ),
        ),
      ),
      await hostError(client.getEntry({ ledgerId, entryId: randomUUID() })),
      await hostError(client.listActors(randomUUID())),
    ];

    expect(errors.map((error) => error.reason)).toEqual([
      'TERMINAL_ENTRY',
      'IDEMPOTENCY_KEY_REUSED',
      'INVALID_INPUT',
      'NOT_FOUND',
      'NOT_FOUND',
    ]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(LedgerStorageHostError);
      expect(LedgerErrorDetailsSchema.parse(error.details).reason).toBe(
        error.reason,
      );
      expect(error.message).not.toContain('Nightjar');
      expect(error.message).not.toContain('nightjar.md');
      expect(error.message).not.toContain(tempDir);
    }
    expect(LedgerErrorDetailsSchema.parse(errors[0]?.details)).toMatchObject({
      currentEntry: { entryId, revision: 2, status: 'COMPLETED' },
    });
    expect(LedgerErrorDetailsSchema.parse(errors[2]?.details)).toMatchObject({
      field: 'title',
    });
  });
});

describe('createWorkerLedgerStoreClient result validation', () => {
  const ledgerId = randomUUID();
  const authorityId = randomUUID();
  const scope: LedgerScopeRecord = {
    scope: { ledgerId, authorityId, container: WORKTREE_CONTAINER },
    containerCreatedAt: CONTAINER_CREATED_AT,
    accountId: null,
    lifecycleState: 'active',
    sequence: '4',
    createdAt: '2026-09-28T12:00:00.000Z',
  };
  const actor: LedgerActorRecord = {
    actor: { actorId: randomUUID(), kind: 'user', authorityId },
    ledgerId,
    originKey: 'user:local',
    displayName: 'You',
    createdAt: '2026-09-28T12:00:00.000Z',
  };
  const counts: LedgerStorageCounts = {
    scopes: 1,
    actors: 1,
    entries: 0,
    entryVersions: 0,
    mutations: 0,
    receipts: 0,
    outbox: 2,
    searchRows: 0,
  };

  function scriptedClient(result: unknown): {
    client: LedgerStoreClient;
    call: jest.SpyInstance<Promise<unknown>, [string, unknown]>;
  } {
    const host = createHost();
    const call = jest.spyOn(host, 'call').mockResolvedValue(result);
    return { client: createWorkerLedgerStoreClient(host), call };
  }

  it('sends each call as its positional arguments and returns a rebuilt result', async () => {
    const { client, call } = scriptedClient(scope);
    const input = {
      container: WORKTREE_CONTAINER,
      containerCreatedAt: CONTAINER_CREATED_AT,
    };

    const found = await client.findScope(input);
    await client.getScope(ledgerId);

    expect(found).toEqual(scope);
    expect(found).not.toBe(scope);
    expect(call.mock.calls).toEqual([
      ['findScope', [input]],
      ['getScope', [ledgerId]],
    ]);
    call.mockResolvedValue(counts);
    await expect(client.getStorageCounts()).resolves.toEqual(counts);
    expect(call).toHaveBeenLastCalledWith('getStorageCounts', []);
    expect(startedWorkers).toHaveLength(0);
  });

  it.each<
    [string, (client: LedgerStoreClient) => Promise<unknown>, unknown, object]
  >([
    [
      'an authority that is not a UUID',
      (client): Promise<unknown> => client.getAuthorityId(),
      'desktop-authority-1',
      { method: 'getAuthorityId' },
    ],
    [
      'a negative row count',
      (client): Promise<unknown> => client.getStorageCounts(),
      { ...counts, entries: -1 },
      { method: 'getStorageCounts', field: 'entries' },
    ],
    [
      'an unknown lifecycle state',
      (client): Promise<unknown> => client.getScope(ledgerId),
      { ...scope, lifecycleState: 'deleted' },
      { method: 'getScope', field: 'lifecycleState' },
    ],
    [
      'an extra field',
      (client): Promise<unknown> => client.getScope(ledgerId),
      { ...scope, path: '/Users/someone/ledger.sqlite' },
      { method: 'getScope' },
    ],
    [
      'an actor without a display name',
      (client): Promise<unknown> => client.listActors(ledgerId),
      [actor, { ...actor, displayName: '' }],
      { method: 'listActors', field: '1.displayName' },
    ],
    [
      'owner candidates the store never returns',
      (client): Promise<unknown> => client.searchEntries({ ledgerId }),
      {
        entries: [],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
        owners: { candidates: [], nextCursor: null },
      },
      { method: 'searchEntries' },
    ],
    [
      'a receipt without an entry',
      (client): Promise<unknown> =>
        client.updateEntry(
          updateInput(
            { ledgerId },
            actor.actor,
            { entryId: randomUUID(), expectedRevision: 1, status: 'BLOCKED' },
            'key',
          ),
        ),
      {
        changed: false,
        mutationId: null,
        localSequence: '1',
        syncState: 'local_only',
      },
      { method: 'updateEntry', field: 'entry' },
    ],
    [
      'no result',
      (client): Promise<unknown> =>
        client.getEntry({ ledgerId, entryId: randomUUID() }),
      undefined,
      { method: 'getEntry' },
    ],
    [
      'a listed scope in an unknown lifecycle state',
      (client): Promise<unknown> => client.listScopes(),
      [scope, { ...scope, lifecycleState: 'purged' }],
      { method: 'listScopes', field: '1.lifecycleState' },
    ],
    [
      'container scopes that are not a list',
      (client): Promise<unknown> =>
        client.findContainerScopes(WORKTREE_CONTAINER),
      scope,
      { method: 'findContainerScopes' },
    ],
    [
      'a lifecycle change without a scope',
      (client): Promise<unknown> =>
        client.setScopeLifecycle({ ledgerId, state: 'archived' }),
      null,
      { method: 'setScopeLifecycle' },
    ],
    [
      'a rebound scope with a malformed container',
      (client): Promise<unknown> =>
        client.rebindScope({
          ledgerId,
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        }),
      { ...scope, scope: { ...scope.scope, container: { kind: 'folder' } } },
      { method: 'rebindScope', field: 'scope.container.kind' },
    ],
    [
      'a purge result without its flag',
      (client): Promise<unknown> => client.purgeScope(ledgerId),
      { removed: true },
      { method: 'purgeScope' },
    ],
    [
      'a purge result with an extra field',
      (client): Promise<unknown> => client.purgeScope(ledgerId),
      { purged: true, rows: 12 },
      { method: 'purgeScope' },
    ],
  ])('rejects %s with INTERNAL', async (_label, run, result, details) => {
    const { client } = scriptedClient(result);

    const error = await hostError(run(client));

    expect(error).toMatchObject({
      reason: 'INTERNAL',
      message: 'Ledger storage returned an unexpected result',
      details,
    });
  });

  it('sends the scope lifecycle calls as their positional arguments', async () => {
    const { client, call } = scriptedClient([scope]);
    const lifecycle: LedgerStoreSetScopeLifecycleInput = {
      ledgerId,
      state: 'archived',
    };
    const rebind: LedgerStoreRebindScopeInput = {
      ledgerId,
      container: WORKTREE_CONTAINER,
      containerCreatedAt: CONTAINER_CREATED_AT,
    };

    await expect(client.listScopes()).resolves.toEqual([scope]);
    await expect(
      client.findContainerScopes(WORKTREE_CONTAINER),
    ).resolves.toEqual([scope]);
    call.mockResolvedValue(scope);
    await expect(client.setScopeLifecycle(lifecycle)).resolves.toEqual(scope);
    await expect(client.rebindScope(rebind)).resolves.toEqual(scope);
    call.mockResolvedValue({ purged: false });
    await expect(client.purgeScope(ledgerId)).resolves.toEqual({
      purged: false,
    });

    expect(call.mock.calls).toEqual([
      ['listScopes', []],
      ['findContainerScopes', [WORKTREE_CONTAINER]],
      ['setScopeLifecycle', [lifecycle]],
      ['rebindScope', [rebind]],
      ['purgeScope', [ledgerId]],
    ]);
    expect(startedWorkers).toHaveLength(0);
  });

  it('passes host rejections through unchanged', async () => {
    const host = createHost();
    const rejection = new LedgerStorageHostError(
      'WRITER_UNAVAILABLE',
      'Another process holds the Feed database.',
      { reason: 'WRITER_UNAVAILABLE' },
    );
    jest.spyOn(host, 'call').mockRejectedValue(rejection);

    await expect(
      createWorkerLedgerStoreClient(host).bindScope({
        authorityId,
        container: WORKTREE_CONTAINER,
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      }),
    ).rejects.toBe(rejection);
  });

  it('checks every receipt with the protocol schema', async () => {
    const { client } = scriptedClient({
      entry: { entryId: randomUUID() },
      changed: true,
      mutationId: randomUUID(),
      localSequence: '1',
      syncState: 'local_only',
    });

    const error = await hostError(
      client.publishSummary({
        ledgerId,
        helper: actor.actor,
        helperDetails: CHAT_DETAILS,
        params: {
          snapshotId: 'snapshot-1',
          generationId: 'generation-1',
          title: 'Summary',
          content: 'Content',
          sourceTruncated: false,
        },
        idempotencyKey: 'summary',
      }),
    );

    expect(error).toMatchObject({
      reason: 'INTERNAL',
      details: { method: 'publishSummary', field: 'entry.schemaVersion' },
    });
  });
});

describe('getLedgerStoreClient', () => {
  it('returns one client over the app host that starts nothing until called', async () => {
    const client = getLedgerStoreClient();
    expect(getLedgerStoreClient()).toBe(client);
    expect(startedWorkers).toHaveLength(0);

    await shutdownLedgerStorageHost();

    await expect(client.getAuthorityId()).rejects.toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      message: 'Ledger storage is shut down',
    });
    expect(startedWorkers).toHaveLength(0);
    expect(existsSync('/nonexistent/canopy-ledger-storage-client-test')).toBe(
      false,
    );
  });
});
