import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  LedgerScopeBindings,
  resolveArchivedLedgerContainerCreatedAt,
  resolveLedgerContainerCreatedAt,
  type LedgerContainerCreatedAtReaders,
} from '../scope-bindings';
import { LedgerStorageHostError } from '../storage-host';
import type { LedgerStoreClient } from '../ledger-store-client';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerStoreFixture,
  type LedgerStoreFixture,
} from './fixtures/in-process-ledger-store-client';

const LEDGER_UUID: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);

interface BindingsUnderTest {
  readonly scopes: LedgerScopeBindings;
  readonly storeRequests: () => number;
}

describe('LedgerScopeBindings', () => {
  let fixture: LedgerStoreFixture;

  beforeEach(() => {
    fixture = createLedgerStoreFixture();
  });

  afterEach(() => {
    fixture.dispose();
  });

  function createBindings(
    accountId: string | null = 'account-1',
  ): BindingsUnderTest {
    let storeRequests = 0;
    return {
      scopes: new LedgerScopeBindings({
        store: (): LedgerStoreClient => {
          storeRequests += 1;
          return fixture.client;
        },
        getAccountId: (): Promise<string | null> => Promise.resolve(accountId),
      }),
      storeRequests: (): number => storeRequests,
    };
  }

  it('touches no storage until an incarnation is first used', () => {
    const { storeRequests } = createBindings();

    expect(storeRequests()).toBe(0);
    expect(fixture.client.calls).toEqual([]);
    expect(fixture.repository.getStorageCounts().scopes).toBe(0);
  });

  it('binds an incarnation once, under the store authority and the signed-in account', async () => {
    const { scopes } = createBindings();

    const first = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );
    const again = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );

    expect(again).toBe(first);
    expect(first).toEqual({
      ledgerId: LEDGER_UUID,
      authorityId: fixture.repository.authorityId,
      container: TEST_CONTAINER,
      containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      accountId: 'account-1',
    });
    expect(fixture.repository.getScope(first.ledgerId)).toMatchObject({
      accountId: 'account-1',
      containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      lifecycleState: 'active',
    });
    expect(fixture.client.callCount('getAuthorityId')).toBe(1);
    expect(fixture.client.callCount('bindScope')).toBe(1);
  });

  it('finds the same ledger again after a restart', async () => {
    const before = await createBindings().scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );
    const after = await createBindings('account-2').scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );

    expect(after.ledgerId).toBe(before.ledgerId);
    // The account is recorded when the ledger is minted and never rebound.
    expect(fixture.repository.getScope(after.ledgerId)?.accountId).toBe(
      'account-1',
    );
    expect(fixture.repository.getStorageCounts().scopes).toBe(1);
  });

  it('mints a new ledger for a reused container ID with a new creation time', async () => {
    const { scopes } = createBindings();

    const original = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );
    const recreated = await scopes.resolve(
      TEST_CONTAINER,
      '2026-09-20T09:30:00.000Z',
    );

    expect(recreated.ledgerId).not.toBe(original.ledgerId);
    expect(recreated.container).toEqual(original.container);
    expect(recreated.containerCreatedAt).toBe('2026-09-20T09:30:00.000Z');
    expect(fixture.repository.getStorageCounts().scopes).toBe(2);
  });

  it('keeps each kind of container apart', async () => {
    const { scopes } = createBindings();
    const containers: LedgerContainer[] = [
      TEST_CONTAINER,
      {
        kind: 'code_worktree',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-2',
      },
      {
        kind: 'cowork_entry',
        workspaceId: 'workspace-1',
        entryId: 'worktree-1',
      },
      {
        kind: 'advisor_entry',
        appWorkspaceId: 'app-advisor',
        entryId: 'worktree-1',
      },
    ];

    const ledgers = await Promise.all(
      containers.map((container) =>
        scopes.resolve(container, TEST_CONTAINER_CREATED_AT),
      ),
    );

    expect(new Set(ledgers.map((scope) => scope.ledgerId)).size).toBe(4);
    expect(ledgers.map((scope) => scope.container)).toEqual(containers);
  });

  it('never confuses two tuples whose IDs join to the same text', async () => {
    const { scopes } = createBindings();

    const first = await scopes.resolve(
      { kind: 'code_worktree', workspaceId: 'a\u0000b', worktreeId: 'c' },
      TEST_CONTAINER_CREATED_AT,
    );
    const second = await scopes.resolve(
      { kind: 'code_worktree', workspaceId: 'a', worktreeId: 'b\u0000c' },
      TEST_CONTAINER_CREATED_AT,
    );

    expect(second.ledgerId).not.toBe(first.ledgerId);
  });

  it('shares one bind among concurrent first uses', async () => {
    const { scopes } = createBindings();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        scopes.resolve(TEST_CONTAINER, TEST_CONTAINER_CREATED_AT),
      ),
    );

    expect(new Set(results.map((scope) => scope.ledgerId)).size).toBe(1);
    expect(fixture.client.callCount('getAuthorityId')).toBe(1);
    expect(fixture.client.callCount('bindScope')).toBe(1);
  });

  it('records a first use while signed out without an account', async () => {
    const { scopes } = createBindings(null);

    const scope = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );

    expect(fixture.repository.getScope(scope.ledgerId)?.accountId).toBeNull();
    expect(scope.accountId).toBeNull();
  });

  it('reads the account a merged guest scope moved to once every binding is forgotten', async () => {
    const { scopes } = createBindings('guest-1');
    const before = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );
    await fixture.client.rebindAccount({
      fromAccountId: 'guest-1',
      toAccountId: 'account-1',
    });

    const cached = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );
    scopes.forgetAll();
    const after = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );

    expect(cached).toBe(before);
    expect(before.accountId).toBe('guest-1');
    expect(after).toEqual({ ...before, accountId: 'account-1' });
    expect(fixture.client.callCount('bindScope')).toBe(2);
  });

  it('tries a failed bind again on the next use', async () => {
    const { scopes } = createBindings();
    fixture.client.failNext(
      'bindScope',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Storage stopped'),
    );

    await expect(
      scopes.resolve(TEST_CONTAINER, TEST_CONTAINER_CREATED_AT),
    ).rejects.toMatchObject({ reason: 'STORAGE_UNAVAILABLE' });
    const scope = await scopes.resolve(
      TEST_CONTAINER,
      TEST_CONTAINER_CREATED_AT,
    );

    expect(fixture.repository.getScope(scope.ledgerId)).not.toBeNull();
    expect(fixture.client.callCount('bindScope')).toBe(2);
  });

  it('reads the writer authority again after a failed read', async () => {
    const { scopes } = createBindings();
    fixture.client.failNext(
      'getAuthorityId',
      new LedgerStorageHostError('WRITER_UNAVAILABLE', 'Database is held'),
    );

    await expect(
      scopes.resolve(TEST_CONTAINER, TEST_CONTAINER_CREATED_AT),
    ).rejects.toMatchObject({ reason: 'WRITER_UNAVAILABLE' });
    await expect(
      scopes.resolve(TEST_CONTAINER, TEST_CONTAINER_CREATED_AT),
    ).resolves.toMatchObject({ authorityId: fixture.repository.authorityId });
    expect(fixture.client.callCount('getAuthorityId')).toBe(2);
  });
});

describe('resolveLedgerContainerCreatedAt', () => {
  function stubReaders(): {
    readers: LedgerContainerCreatedAtReaders;
    worktree: jest.Mock<Promise<string | null>, [string, string]>;
    workEntry: jest.Mock<Promise<string | null>, [string, string]>;
  } {
    const worktree = jest.fn<Promise<string | null>, [string, string]>(() =>
      Promise.resolve('2026-09-01T08:00:00.000Z'),
    );
    const workEntry = jest.fn<Promise<string | null>, [string, string]>(() =>
      Promise.resolve('2026-09-02T08:00:00.000Z'),
    );
    return {
      readers: { worktreeCreatedAt: worktree, workEntryCreatedAt: workEntry },
      worktree,
      workEntry,
    };
  }

  it('reads each container kind from the persistence that owns it', async () => {
    const { readers, worktree, workEntry } = stubReaders();

    await expect(
      resolveLedgerContainerCreatedAt(TEST_CONTAINER, readers),
    ).resolves.toBe('2026-09-01T08:00:00.000Z');
    await expect(
      resolveLedgerContainerCreatedAt(
        { kind: 'cowork_entry', workspaceId: 'cowork-1', entryId: 'entry-1' },
        readers,
      ),
    ).resolves.toBe('2026-09-02T08:00:00.000Z');
    await expect(
      resolveLedgerContainerCreatedAt(
        {
          kind: 'advisor_entry',
          appWorkspaceId: 'app-advisor',
          entryId: 'entry-2',
        },
        readers,
      ),
    ).resolves.toBe('2026-09-02T08:00:00.000Z');

    expect(worktree.mock.calls).toEqual([['workspace-1', 'worktree-1']]);
    expect(workEntry.mock.calls).toEqual([
      ['cowork-1', 'entry-1'],
      ['app-advisor', 'entry-2'],
    ]);
  });

  it('reports a missing container as null', async () => {
    const { readers, worktree } = stubReaders();
    worktree.mockResolvedValueOnce(null);

    await expect(
      resolveLedgerContainerCreatedAt(TEST_CONTAINER, readers),
    ).resolves.toBeNull();
  });

  it.each([
    ['a traversal', '../workspace-1'],
    ['an uppercase ID', 'Workspace-1'],
    ['an empty ID', ''],
  ])('never reads persistence for %s', async (_label, workspaceId) => {
    const { readers, worktree } = stubReaders();

    await expect(
      resolveLedgerContainerCreatedAt(
        { kind: 'code_worktree', workspaceId, worktreeId: 'worktree-1' },
        readers,
      ),
    ).resolves.toBeNull();
    expect(worktree).not.toHaveBeenCalled();
  });

  describe('with the desktop persistence', () => {
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    let dataDir: string;

    function writeJson(relativePath: string, value: unknown): void {
      const filePath = join(dataDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(value));
    }

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'ledger-container-created-at-'));
      process.env.CANOPY_DATA_DIR = dataDir;
    });

    afterEach(() => {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('reads worktrees.json and both work-entries.json registries', async () => {
      writeJson('workspaces/workspace-1/worktrees.json', {
        version: 1,
        worktrees: [
          {
            id: 'worktree-1',
            branchName: 'feature',
            createdAt: '2026-09-01T08:00:00.000Z',
          },
        ],
      });
      writeJson('workspaces/cowork-1/work-entries.json', {
        version: 1,
        entries: [{ id: 'entry-1', createdAt: '2026-09-02T08:00:00.000Z' }],
      });
      writeJson('app-workspaces/app-advisor/work-entries.json', {
        version: 1,
        entries: [{ id: 'entry-2', createdAt: '2026-09-03T08:00:00.000Z' }],
      });

      await expect(
        resolveLedgerContainerCreatedAt(TEST_CONTAINER),
      ).resolves.toBe('2026-09-01T08:00:00.000Z');
      await expect(
        resolveLedgerContainerCreatedAt({
          kind: 'cowork_entry',
          workspaceId: 'cowork-1',
          entryId: 'entry-1',
        }),
      ).resolves.toBe('2026-09-02T08:00:00.000Z');
      await expect(
        resolveLedgerContainerCreatedAt({
          kind: 'advisor_entry',
          appWorkspaceId: 'app-advisor',
          entryId: 'entry-2',
        }),
      ).resolves.toBe('2026-09-03T08:00:00.000Z');
      await expect(
        resolveLedgerContainerCreatedAt({
          kind: 'cowork_entry',
          workspaceId: 'cowork-1',
          entryId: 'entry-9',
        }),
      ).resolves.toBeNull();
    });
  });
});

describe('resolveArchivedLedgerContainerCreatedAt', () => {
  let fixture: LedgerStoreFixture;

  beforeEach(() => {
    fixture = createLedgerStoreFixture();
  });

  afterEach(() => {
    fixture.dispose();
  });

  async function bind(containerCreatedAt: string): Promise<string> {
    const authorityId = await fixture.client.getAuthorityId();
    const { scope } = await fixture.client.bindScope({
      authorityId,
      container: TEST_CONTAINER,
      containerCreatedAt,
      accountId: null,
    });
    return scope.scope.ledgerId;
  }

  it("finds an archived container's one archived incarnation", async () => {
    const ledgerId = await bind(TEST_CONTAINER_CREATED_AT);
    await expect(
      resolveArchivedLedgerContainerCreatedAt(TEST_CONTAINER, fixture.client),
    ).resolves.toBeNull();

    await fixture.client.setScopeLifecycle({ ledgerId, state: 'archived' });

    await expect(
      resolveArchivedLedgerContainerCreatedAt(TEST_CONTAINER, fixture.client),
    ).resolves.toBe(TEST_CONTAINER_CREATED_AT);
  });

  it('never guesses between archived incarnations of a reused ID', async () => {
    for (const createdAt of [
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    ]) {
      await fixture.client.setScopeLifecycle({
        ledgerId: await bind(createdAt),
        state: 'archived',
      });
    }

    await expect(
      resolveArchivedLedgerContainerCreatedAt(TEST_CONTAINER, fixture.client),
    ).resolves.toBeNull();
  });
});
