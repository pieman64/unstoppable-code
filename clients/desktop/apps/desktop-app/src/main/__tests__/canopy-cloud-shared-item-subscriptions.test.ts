/**
 * CAN-2334 install-subscription ledger and outbox.
 *
 * Desktop records the shared items a user installs so web can email them when
 * the owner publishes an update. These tests pin the ledger semantics (one
 * entry per key, removals only when the last local copy goes, upsert/removal
 * cancellation), the upload gate (signed-in non-guest accounts only, stop on
 * an account switch), chunking, per-item permanent vs transient errors, and
 * the one-time backfill that completes only after every chunk succeeded.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SHARED_ITEM_BATCH_SIZE,
  parseSharedItemSubscriptionBatch,
  type SharedItemSubscriptionBatch,
  type SharedItemSubscriptionBatchResult,
  type SharedItemSubscriptionItemResult,
} from '@canopy/protocol/shared-item-subscriptions';

let mockLedgerPath = '';
const mockReadAccount = jest.fn();
const mockRequestCanopyCloudJson = jest.fn();
const mockCollectBackfill = jest.fn();
const mockAccountListeners: Array<(entry: unknown) => void> = [];

class MockCanopyCloudClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
  }
}

jest.mock('../lib/paths', () => ({
  getSharedItemUpdateSubscriptionsFilePath: (): string => mockLedgerPath,
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): unknown => mockReadAccount(),
  subscribeCanopyCloudAccountChanges: (
    listener: (entry: unknown) => void,
  ): (() => void) => {
    mockAccountListeners.push(listener);
    return (): void => {
      const index = mockAccountListeners.indexOf(listener);
      if (index >= 0) mockAccountListeners.splice(index, 1);
    };
  },
}));

jest.mock('../portal/portal-state-store', () => ({
  readPortalStateStore: (): Promise<unknown> =>
    Promise.resolve({ version: 1, clientDeviceId: 'device-1' }),
}));

jest.mock('../canopy-cloud/client', () => ({
  CanopyCloudClientError: MockCanopyCloudClientError,
  requestCanopyCloudJson: (...args: unknown[]): unknown =>
    mockRequestCanopyCloudJson(...args),
}));

jest.mock(
  '../canopy-cloud/shared-item-subscription-backfill',
  () => ({
    // Tests resolve a bare list for a complete backfill.
    collectSharedItemInstallsForBackfill: async (): Promise<unknown> => {
      const found: unknown = await mockCollectBackfill();
      return Array.isArray(found) ? { records: found, complete: true } : found;
    },
  }),
  { virtual: true },
);

import {
  flushSharedItemSubscriptions,
  readSharedItemSubscriptionLedger,
  recordSharedItemInstall,
  recordSharedItemLocalUninstall,
  recordSharedItemUninstall,
  runSharedItemSubscriptionBackfill,
  subscribeSharedItemSubscriptionFlush,
  type SharedItemInstallRecord,
} from '../canopy-cloud/shared-item-subscriptions';

const BATCH_PATH = '/api/v1/shared-item-subscriptions/batch';

interface AccountEntry {
  apiKey: string;
  authMode?: 'guest' | 'oauth';
  credentialSource?: 'guest' | 'oauth';
  account?: { id: string };
}

function realAccount(id: string): AccountEntry {
  return { apiKey: `key-${id}`, authMode: 'oauth', account: { id } };
}

function guestAccount(id: string): AccountEntry {
  return {
    apiKey: `key-${id}`,
    authMode: 'guest',
    credentialSource: 'guest',
    account: { id },
  };
}

let currentAccount: AccountEntry | null = null;
let accountReadStatus: 'ok' | 'unavailable' = 'ok';

/** Every batch POSTed, parsed back through the shared contract parser. */
const sentBatches: SharedItemSubscriptionBatch[] = [];
/** Per-item result overrides keyed by `remoteId`; default is `{ ok: true }`. */
const itemResults = new Map<string, SharedItemSubscriptionItemResult>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSentBatch(init: unknown): SharedItemSubscriptionBatch {
  if (!isRecord(init) || typeof init.body !== 'string') {
    throw new Error('Expected a JSON body');
  }
  const batch = parseSharedItemSubscriptionBatch(JSON.parse(init.body));
  if (batch === null) throw new Error('Body is not a valid batch');
  return batch;
}

function resultFor(remoteId: string): SharedItemSubscriptionItemResult {
  return itemResults.get(remoteId) ?? { ok: true };
}

function defaultRespond(
  path: unknown,
  init: unknown,
): Promise<SharedItemSubscriptionBatchResult> {
  expect(path).toBe(BATCH_PATH);
  const batch = parseSentBatch(init);
  sentBatches.push(batch);
  return Promise.resolve({
    upserts: batch.upserts.map((item) => resultFor(item.remoteId)),
    removals: batch.removals.map((item) => resultFor(item.remoteId)),
  });
}

function install(
  overrides: Partial<SharedItemInstallRecord> = {},
): SharedItemInstallRecord {
  return {
    kind: 'automation',
    remoteId: 'remote-1',
    sourceKind: 'shared',
    contentHash: 'hash-1',
    localId: 'local-1',
    ...overrides,
  };
}

function sentUpsertIds(): string[] {
  return sentBatches.flatMap((batch) =>
    batch.upserts.map((item) => item.remoteId),
  );
}

function sentRemovalIds(): string[] {
  return sentBatches.flatMap((batch) =>
    batch.removals.map((item) => item.remoteId),
  );
}

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'canopy-shared-item-subs-'));
  mockLedgerPath = join(
    tempDir,
    'data',
    'shared-item-update-subscriptions.json',
  );
  currentAccount = null;
  accountReadStatus = 'ok';
  sentBatches.length = 0;
  itemResults.clear();
  mockAccountListeners.length = 0;
  mockReadAccount.mockReset();
  mockReadAccount.mockImplementation(() =>
    Promise.resolve(
      accountReadStatus === 'ok'
        ? { status: 'ok', entry: currentAccount }
        : {
            status: 'unavailable',
            error: new Error('locked'),
            secureStorageFailure: { code: 'locked' },
          },
    ),
  );
  mockRequestCanopyCloudJson.mockReset();
  mockRequestCanopyCloudJson.mockImplementation(defaultRespond);
  mockCollectBackfill.mockReset();
  mockCollectBackfill.mockResolvedValue([]);
});

afterEach(async () => {
  // Drain anything a fire-and-forget call left running before the next test
  // swaps the ledger path out from under it.
  await flushSharedItemSubscriptions();
  await readSharedItemSubscriptionLedger();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Wait for queued ledger changes and the flushes they triggered. */
async function settle(): Promise<void> {
  await readSharedItemSubscriptionLedger();
  await flushSharedItemSubscriptions();
}

async function readLedgerFile(): Promise<unknown> {
  await readSharedItemSubscriptionLedger();
  return JSON.parse(await readFile(mockLedgerPath, 'utf8'));
}

describe('ledger', () => {
  it('records an install with its content hash and local id', async () => {
    recordSharedItemInstall(install());

    await expect(readLedgerFile()).resolves.toEqual({
      version: 1,
      installs: [
        {
          kind: 'automation',
          remoteId: 'remote-1',
          sourceKind: 'shared',
          contentHash: 'hash-1',
          localIds: ['local-1'],
        },
      ],
      byAccount: {},
    });
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  });

  it('keeps one entry per key and unions local ids', async () => {
    recordSharedItemInstall(install({ localId: 'a' }));
    recordSharedItemInstall(install({ localId: 'b' }));
    recordSharedItemInstall(install({ localId: 'a' }));

    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.installs).toEqual([
      expect.objectContaining({ remoteId: 'remote-1', localIds: ['a', 'b'] }),
    ]);
  });

  it('serializes concurrent fire-and-forget installs without losing writes', async () => {
    for (let index = 0; index < 25; index += 1) {
      recordSharedItemInstall(install({ remoteId: `remote-${index}` }));
    }

    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.installs).toHaveLength(25);
  });

  it('re-uploads a key whose hash changed for every account', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install({ contentHash: 'hash-1' }));
    await flushSharedItemSubscriptions();
    currentAccount = realAccount('user-b');
    await flushSharedItemSubscriptions();
    expect(sentUpsertIds()).toEqual(['remote-1', 'remote-1']);

    currentAccount = null;
    recordSharedItemInstall(install({ contentHash: 'hash-2' }));
    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']?.syncedKeys).toEqual([]);
    expect(ledger.byAccount['user-b']?.syncedKeys).toEqual([]);

    sentBatches.length = 0;
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();
    expect(sentBatches).toEqual([
      {
        upserts: [
          {
            kind: 'automation',
            remoteId: 'remote-1',
            sourceKind: 'shared',
            sourceKey: 'desktop:device-1',
            contentHash: 'hash-2',
          },
        ],
        removals: [],
      },
    ]);
  });

  it('does not re-upload a re-register with the same hash', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();
    recordSharedItemInstall(install({ localId: 'local-2' }));
    await flushSharedItemSubscriptions();

    expect(sentUpsertIds()).toEqual(['remote-1']);
  });

  it('queues a removal only when the last local copy is uninstalled', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install({ localId: 'a' }));
    recordSharedItemInstall(install({ localId: 'b' }));
    await flushSharedItemSubscriptions();

    recordSharedItemUninstall(install({ localId: 'a' }));
    await flushSharedItemSubscriptions();
    expect(sentRemovalIds()).toEqual([]);

    recordSharedItemUninstall(install({ localId: 'b' }));
    await flushSharedItemSubscriptions();
    expect(sentBatches.at(-1)).toEqual({
      upserts: [],
      removals: [
        {
          kind: 'automation',
          remoteId: 'remote-1',
          sourceKind: 'shared',
          sourceKey: 'desktop:device-1',
        },
      ],
    });
    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.installs).toEqual([]);
    expect(ledger.byAccount['user-a']).toEqual({
      syncedKeys: [],
      heldKeys: [],
      pendingRemovals: [],
      backfillVersion: 1,
    });
  });

  it('still owes a removal when the hash changed and the item was uninstalled before it re-synced', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install({ contentHash: 'hash-1' }));
    await flushSharedItemSubscriptions();
    currentAccount = realAccount('user-b');
    await flushSharedItemSubscriptions();

    // Signed out: "Apply update" re-registers a new hash, then the item goes.
    currentAccount = null;
    recordSharedItemInstall(install({ contentHash: 'hash-2' }));
    recordSharedItemUninstall(install());
    await settle();

    sentBatches.length = 0;
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();
    currentAccount = realAccount('user-b');
    await flushSharedItemSubscriptions();

    expect(sentUpsertIds()).toEqual([]);
    expect(sentRemovalIds()).toEqual(['remote-1', 'remote-1']);
    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']).toEqual({
      syncedKeys: [],
      heldKeys: [],
      pendingRemovals: [],
      backfillVersion: 1,
    });
  });

  it('unregisters a local copy by kind and local id from every share it came from', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(
      install({ kind: 'pipeline', sourceKind: 'public', localId: 'p-1' }),
    );
    recordSharedItemInstall(
      install({
        kind: 'pipeline',
        remoteId: 'team-1',
        sourceKind: 'shared',
        localId: 'p-1',
      }),
    );
    recordSharedItemInstall(
      install({ kind: 'pipeline', remoteId: 'other', localId: 'p-2' }),
    );
    recordSharedItemInstall(install({ kind: 'skill', localId: 'p-1' }));
    await settle();

    sentBatches.length = 0;
    recordSharedItemLocalUninstall({ kind: 'pipeline', localId: 'p-1' });
    await settle();

    expect(sentRemovalIds().sort()).toEqual(['remote-1', 'team-1']);
    const ledger = await readSharedItemSubscriptionLedger();
    expect(
      ledger.installs.map((entry) => `${entry.kind}:${entry.remoteId}`),
    ).toEqual(['pipeline:other', 'skill:remote-1']);
  });

  it('ignores a local uninstall that names no recorded copy or is invalid', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install());
    await settle();
    sentBatches.length = 0;

    recordSharedItemLocalUninstall({ kind: 'automation', localId: 'unknown' });
    recordSharedItemLocalUninstall({ kind: 'automation', localId: '' });
    await settle();

    expect(sentBatches).toEqual([]);
    expect(
      (await readSharedItemSubscriptionLedger()).installs.map(
        (entry) => entry.localIds,
      ),
    ).toEqual([['local-1']]);
  });

  it('ignores an uninstall for a key it never recorded', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemUninstall(install());
    await flushSharedItemSubscriptions();

    expect(sentBatches).toEqual([]);
  });

  it('cancels a pending upsert when the item is removed before it uploads', async () => {
    recordSharedItemInstall(install());
    recordSharedItemUninstall(install());
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();

    expect(sentBatches).toEqual([]);
  });

  it('cancels a pending removal when the item is reinstalled', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();
    currentAccount = null;
    recordSharedItemUninstall(install());
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a']
        ?.pendingRemovals,
    ).toEqual(['automation:shared:remote-1']);

    recordSharedItemInstall(install({ contentHash: 'hash-1' }));
    sentBatches.length = 0;
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();

    expect(sentRemovalIds()).toEqual([]);
    expect(sentUpsertIds()).toEqual(['remote-1']);
  });

  it('queues a removal when the item is uninstalled while its upsert is in flight', async () => {
    currentAccount = realAccount('user-a');
    let releaseRequest: () => void = () => undefined;
    mockRequestCanopyCloudJson.mockImplementationOnce(
      (path: unknown, init: unknown) =>
        new Promise((resolve) => {
          releaseRequest = (): void => {
            resolve(defaultRespond(path, init));
          };
        }),
    );
    recordSharedItemInstall(install());
    const flushing = flushSharedItemSubscriptions();
    await waitFor(() => mockRequestCanopyCloudJson.mock.calls.length === 1);
    recordSharedItemUninstall(install());
    releaseRequest();
    await flushing;
    await flushSharedItemSubscriptions();

    expect(sentRemovalIds()).toEqual(['remote-1']);
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a'],
    ).toEqual({
      syncedKeys: [],
      heldKeys: [],
      pendingRemovals: [],
      backfillVersion: 1,
    });
  });

  it('treats an unparseable ledger file as empty and rewrites it', async () => {
    await mkdir(join(tempDir, 'data'), { recursive: true });
    await writeFile(mockLedgerPath, '{ not json', 'utf8');

    await expect(readSharedItemSubscriptionLedger()).resolves.toEqual({
      version: 1,
      installs: [],
      byAccount: {},
    });
    recordSharedItemInstall(install());

    await expect(readLedgerFile()).resolves.toEqual(
      expect.objectContaining({
        version: 1,
        installs: [expect.objectContaining({ remoteId: 'remote-1' })],
      }),
    );
  });

  it('treats a ledger with an unknown version or shape as empty', async () => {
    await mkdir(join(tempDir, 'data'), { recursive: true });
    await writeFile(
      mockLedgerPath,
      JSON.stringify({ version: 2, installs: 'nope', byAccount: [] }),
      'utf8',
    );

    await expect(readSharedItemSubscriptionLedger()).resolves.toEqual({
      version: 1,
      installs: [],
      byAccount: {},
    });
  });

  it('drops malformed entries from an otherwise valid ledger', async () => {
    await mkdir(join(tempDir, 'data'), { recursive: true });
    await writeFile(
      mockLedgerPath,
      JSON.stringify({
        version: 1,
        installs: [
          {
            kind: 'plugin',
            remoteId: 'x',
            sourceKind: 'shared',
            contentHash: null,
            localIds: ['a'],
          },
          {
            kind: 'skill',
            remoteId: 'skill-1',
            sourceKind: 'public',
            contentHash: null,
            localIds: ['s'],
          },
        ],
        byAccount: {
          'user-a': {
            syncedKeys: 'bad',
            pendingRemovals: [],
            backfillVersion: 1,
          },
          'user-b': {
            syncedKeys: ['skill:public:skill-1'],
            pendingRemovals: [],
            backfillVersion: 1,
          },
        },
      }),
      'utf8',
    );

    await expect(readSharedItemSubscriptionLedger()).resolves.toEqual({
      version: 1,
      installs: [
        {
          kind: 'skill',
          remoteId: 'skill-1',
          sourceKind: 'public',
          contentHash: null,
          localIds: ['s'],
        },
      ],
      byAccount: {
        'user-b': {
          syncedKeys: ['skill:public:skill-1'],
          // A file without `heldKeys` held what it synced.
          heldKeys: ['skill:public:skill-1'],
          pendingRemovals: [],
          backfillVersion: 1,
        },
      },
    });
  });

  it('never throws when the ledger cannot be written', async () => {
    // A file where the data directory should be makes mkdir fail.
    await writeFile(join(tempDir, 'data'), 'not a directory', 'utf8');

    expect(() => {
      recordSharedItemInstall(install());
      recordSharedItemUninstall(install());
    }).not.toThrow();
    await expect(flushSharedItemSubscriptions()).resolves.toBeUndefined();
  });

  it('ignores an install with an invalid kind', async () => {
    // Exercise the runtime guard a mistyped caller would hit.
    recordSharedItemInstall(Object.assign(install(), { kind: 'plugin' }));

    await expect(readSharedItemSubscriptionLedger()).resolves.toEqual({
      version: 1,
      installs: [],
      byAccount: {},
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Condition not met');
}

describe('upload gate', () => {
  it('does nothing while signed out', async () => {
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();

    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    expect(mockCollectBackfill).not.toHaveBeenCalled();
  });

  it('does nothing for a guest account', async () => {
    currentAccount = guestAccount('guest-1');
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();

    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['guest-1'],
    ).toBeUndefined();
  });

  it('does nothing when the account cannot be read', async () => {
    currentAccount = realAccount('user-a');
    accountReadStatus = 'unavailable';
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();

    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
  });

  it('uploads installs as the desktop source with the recorded hash', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(
      install({ kind: 'skill', sourceKind: 'public', contentHash: null }),
    );
    await flushSharedItemSubscriptions();

    expect(sentBatches).toEqual([
      {
        upserts: [
          {
            kind: 'skill',
            remoteId: 'remote-1',
            sourceKind: 'public',
            sourceKey: 'desktop:device-1',
            contentHash: null,
          },
        ],
        removals: [],
      },
    ]);
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledWith(
      BATCH_PATH,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps per-account sync state separate', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();
    await flushSharedItemSubscriptions();
    currentAccount = realAccount('user-b');
    await flushSharedItemSubscriptions();

    expect(sentUpsertIds()).toEqual(['remote-1', 'remote-1']);
  });

  it('stops when the account changes between chunks', async () => {
    currentAccount = realAccount('user-a');
    const count = MAX_SHARED_ITEM_BATCH_SIZE + 10;
    mockCollectBackfill.mockResolvedValue(
      Array.from({ length: count }, (_, index) =>
        install({ remoteId: `remote-${index}`, localId: `local-${index}` }),
      ),
    );
    mockRequestCanopyCloudJson.mockImplementationOnce(
      (path: unknown, init: unknown) => {
        currentAccount = realAccount('user-b');
        return defaultRespond(path, init);
      },
    );
    await flushSharedItemSubscriptions();

    expect(sentBatches).toHaveLength(1);
    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']?.syncedKeys).toHaveLength(
      MAX_SHARED_ITEM_BATCH_SIZE,
    );
    expect(ledger.byAccount['user-a']?.backfillVersion).toBe(0);
  });
});

describe('flush', () => {
  it('chunks requests at the batch size limit', async () => {
    currentAccount = realAccount('user-a');
    const count = MAX_SHARED_ITEM_BATCH_SIZE * 2 + 5;
    mockCollectBackfill.mockResolvedValue(
      Array.from({ length: count }, (_, index) =>
        install({ remoteId: `remote-${index}`, localId: `local-${index}` }),
      ),
    );
    await flushSharedItemSubscriptions();

    expect(
      sentBatches.map((batch) => batch.upserts.length + batch.removals.length),
    ).toEqual([MAX_SHARED_ITEM_BATCH_SIZE, MAX_SHARED_ITEM_BATCH_SIZE, 5]);
    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']?.syncedKeys).toHaveLength(count);
    expect(ledger.byAccount['user-a']?.backfillVersion).toBe(1);
  });

  it('marks permanent per-item errors synced and retries transient ones', async () => {
    currentAccount = realAccount('user-a');
    itemResults.set('gone', { ok: false, code: 'not-found' });
    itemResults.set('denied', { ok: false, code: 'forbidden' });
    itemResults.set('flaky', { ok: false, code: 'error' });
    recordSharedItemInstall(install({ remoteId: 'gone', localId: 'g' }));
    recordSharedItemInstall(install({ remoteId: 'denied', localId: 'd' }));
    recordSharedItemInstall(install({ remoteId: 'flaky', localId: 'f' }));
    await flushSharedItemSubscriptions();
    sentBatches.length = 0;
    itemResults.clear();
    await flushSharedItemSubscriptions();

    expect(sentUpsertIds()).toEqual(['flaky']);
  });

  it('marks permanently rejected removals done and retries transient ones', async () => {
    currentAccount = realAccount('user-a');
    recordSharedItemInstall(install({ remoteId: 'gone', localId: 'g' }));
    recordSharedItemInstall(install({ remoteId: 'flaky', localId: 'f' }));
    await flushSharedItemSubscriptions();
    itemResults.set('gone', { ok: false, code: 'invalid' });
    itemResults.set('flaky', { ok: false, code: 'error' });
    recordSharedItemUninstall(install({ remoteId: 'gone', localId: 'g' }));
    recordSharedItemUninstall(install({ remoteId: 'flaky', localId: 'f' }));
    await flushSharedItemSubscriptions();
    sentBatches.length = 0;
    await flushSharedItemSubscriptions();

    expect(sentRemovalIds()).toEqual(['flaky']);
  });

  it('leaves everything pending when the whole request fails', async () => {
    recordSharedItemInstall(install());
    await settle();
    currentAccount = realAccount('user-a');
    mockRequestCanopyCloudJson.mockRejectedValueOnce(
      new MockCanopyCloudClientError('http-error', 'Server error', 500),
    );
    await flushSharedItemSubscriptions();

    let ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']?.syncedKeys ?? []).toEqual([]);
    expect(ledger.byAccount['user-a']?.backfillVersion ?? 0).toBe(0);

    await flushSharedItemSubscriptions();
    ledger = await readSharedItemSubscriptionLedger();
    expect(sentUpsertIds()).toEqual(['remote-1']);
    expect(ledger.byAccount['user-a']?.backfillVersion).toBe(1);
  });

  it('leaves everything pending on a malformed 2xx response', async () => {
    recordSharedItemInstall(install());
    await settle();
    currentAccount = realAccount('user-a');
    mockRequestCanopyCloudJson.mockResolvedValueOnce({ upserts: [] });
    await flushSharedItemSubscriptions();

    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.byAccount['user-a']?.syncedKeys ?? []).toEqual([]);
    expect(ledger.byAccount['user-a']?.backfillVersion ?? 0).toBe(0);
  });

  it('is single-flight', async () => {
    recordSharedItemInstall(install());
    await settle();
    currentAccount = realAccount('user-a');

    const first = flushSharedItemSubscriptions();
    const second = flushSharedItemSubscriptions();
    expect(second).toBe(first);
    await first;

    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
  });

  it('never rejects', async () => {
    currentAccount = realAccount('user-a');
    mockReadAccount.mockRejectedValue(new Error('boom'));
    recordSharedItemInstall(install());

    await expect(flushSharedItemSubscriptions()).resolves.toBeUndefined();
  });
});

describe('backfill', () => {
  it('returns what the collector finds', async () => {
    const found = [install({ remoteId: 'from-backfill' })];
    mockCollectBackfill.mockResolvedValue(found);

    await expect(runSharedItemSubscriptionBackfill()).resolves.toEqual(found);
  });

  it('merges collected installs into the ledger without clobbering local ids', async () => {
    recordSharedItemInstall(
      install({ localId: 'recorded', contentHash: 'h1' }),
    );
    mockCollectBackfill.mockResolvedValue([
      install({ localId: 'backfilled', contentHash: null }),
      install({
        kind: 'agent',
        remoteId: 'agent-1',
        sourceKind: 'public',
        contentHash: null,
        localId: 'agent-local',
      }),
    ]);
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();

    const ledger = await readSharedItemSubscriptionLedger();
    expect(ledger.installs).toEqual([
      {
        kind: 'automation',
        remoteId: 'remote-1',
        sourceKind: 'shared',
        contentHash: 'h1',
        localIds: ['recorded', 'backfilled'],
      },
      {
        kind: 'agent',
        remoteId: 'agent-1',
        sourceKind: 'public',
        contentHash: null,
        localIds: ['agent-local'],
      },
    ]);
    expect(sentUpsertIds().sort()).toEqual(['agent-1', 'remote-1']);
    expect(ledger.byAccount['user-a']?.backfillVersion).toBe(1);
  });

  it('runs once per account after full success', async () => {
    currentAccount = realAccount('user-a');
    await flushSharedItemSubscriptions();
    await flushSharedItemSubscriptions();
    expect(mockCollectBackfill).toHaveBeenCalledTimes(1);

    currentAccount = realAccount('user-b');
    await flushSharedItemSubscriptions();
    expect(mockCollectBackfill).toHaveBeenCalledTimes(2);
  });

  it('reruns on the next flush when a chunk failed', async () => {
    currentAccount = realAccount('user-a');
    mockCollectBackfill.mockResolvedValue([install()]);
    mockRequestCanopyCloudJson.mockRejectedValueOnce(
      new MockCanopyCloudClientError('network-error', 'offline'),
    );
    await flushSharedItemSubscriptions();
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a']
        ?.backfillVersion ?? 0,
    ).toBe(0);

    await flushSharedItemSubscriptions();
    expect(mockCollectBackfill).toHaveBeenCalledTimes(2);
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a']
        ?.backfillVersion,
    ).toBe(1);
  });

  it('does not complete when the collector fails but still uploads recorded installs', async () => {
    currentAccount = realAccount('user-a');
    mockCollectBackfill.mockRejectedValue(new Error('collector failed'));
    recordSharedItemInstall(install());
    await flushSharedItemSubscriptions();

    const ledger = await readSharedItemSubscriptionLedger();
    expect(sentUpsertIds()).toEqual(['remote-1']);
    expect(ledger.byAccount['user-a']?.backfillVersion ?? 0).toBe(0);
  });

  it('uploads what a partial backfill found but runs it again on the next flush', async () => {
    currentAccount = realAccount('user-a');
    mockCollectBackfill.mockResolvedValueOnce({
      records: [install({ remoteId: 'found', localId: 'found-local' })],
      complete: false,
    });
    await flushSharedItemSubscriptions();

    expect(sentUpsertIds()).toEqual(['found']);
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a']
        ?.backfillVersion,
    ).toBe(0);

    await flushSharedItemSubscriptions();
    expect(mockCollectBackfill).toHaveBeenCalledTimes(2);
    expect(
      (await readSharedItemSubscriptionLedger()).byAccount['user-a']
        ?.backfillVersion,
    ).toBe(1);
  });
});

describe('subscribeSharedItemSubscriptionFlush', () => {
  function emit(entry: AccountEntry | null): void {
    for (const listener of mockAccountListeners) listener(entry);
  }

  it('flushes only when the non-guest account id changes', async () => {
    const dispose = subscribeSharedItemSubscriptionFlush();
    recordSharedItemInstall(install());
    await settle();
    mockReadAccount.mockClear();

    emit(null);
    emit(guestAccount('guest-1'));
    expect(mockReadAccount).not.toHaveBeenCalled();

    currentAccount = realAccount('user-a');
    emit(currentAccount);
    await flushSharedItemSubscriptions();
    expect(sentUpsertIds()).toEqual(['remote-1']);

    // Re-persisting the same account (e.g. a capability re-probe) is ignored.
    const afterSignIn = mockReadAccount.mock.calls.length;
    emit(currentAccount);
    emit(currentAccount);
    expect(mockReadAccount.mock.calls.length).toBe(afterSignIn);

    currentAccount = realAccount('user-b');
    emit(currentAccount);
    await flushSharedItemSubscriptions();
    expect(sentUpsertIds()).toEqual(['remote-1', 'remote-1']);

    dispose();
    expect(mockAccountListeners).toHaveLength(0);
  });

  it('flushes again after signing out and back in', async () => {
    subscribeSharedItemSubscriptionFlush();
    currentAccount = realAccount('user-a');
    emit(currentAccount);
    await flushSharedItemSubscriptions();
    mockReadAccount.mockClear();

    emit(null);
    expect(mockReadAccount).not.toHaveBeenCalled();
    emit(currentAccount);
    await flushSharedItemSubscriptions();
    expect(mockReadAccount).toHaveBeenCalled();
  });
});
