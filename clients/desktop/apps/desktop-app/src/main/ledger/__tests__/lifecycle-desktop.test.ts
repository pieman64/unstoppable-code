const mockGetLedgerStoreClient = jest.fn();
const mockRecordAppDiagnostic = jest.fn();
const mockFsyncDirectory = jest.fn<Promise<void>, [string]>();
const mockDrainLedgerScopeBeforePurge = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRequestLedgerSync = jest.fn<void, []>();

jest.mock('../storage-client', () => ({
  getLedgerStoreClient: (): unknown => mockGetLedgerStoreClient(),
}));
// Sync is covered by its own tests; here only the drain before a purge and
// the request that follows a recorded archive, restore or move.
jest.mock('../sync-host', () => ({
  drainLedgerScopeBeforePurge: (ledgerId: string): Promise<void> =>
    mockDrainLedgerScopeBeforePurge(ledgerId),
  requestLedgerSync: (): void => {
    mockRequestLedgerSync();
  },
  desktopLedgerSyncStatus: {
    hold: (): Promise<null> => Promise.resolve(null),
    audienceChangePending: (): Promise<boolean> => Promise.resolve(false),
  },
}));
jest.mock('../../lib/fsync-directory', () => ({
  fsyncDirectory: (directory: string): Promise<void> =>
    mockFsyncDirectory(directory),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: (event: unknown) => void;
  } => ({
    recordAppDiagnostic: (event: unknown): void => {
      mockRecordAppDiagnostic(event);
    },
  }),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fsPromises, { type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  LedgerFindScopeInput,
  LedgerScopeLifecycleState,
  LedgerScopeRecord,
} from '@canopy/desktop-shared/node/ledger';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import type * as CoreLedgerAdapterModule from '../core-ledger-adapter';
import type {
  LedgerStoreClient,
  LedgerStorePurgeScopeResult,
  LedgerStoreRebindScopeInput,
  LedgerStoreSetScopeLifecycleInput,
} from '../ledger-store-client';
import type * as LifecycleModule from '../lifecycle';
import type * as ServiceModule from '../service';
import type * as StorageHostModule from '../storage-host';
import type * as W5CommitStoreModule from '../../lib/w5-commit-log-file-store';
import type { W5FileRead } from '../../lib/w5-file-store';

type Lifecycle = typeof LifecycleModule;

const T0 = '2026-09-20T10:00:00.000Z';
const T1 = '2026-09-26T08:30:00.000Z';
const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111';

function worktree(worktreeId: string, workspaceId = 'ws-1'): LedgerContainer {
  return { kind: 'code_worktree', workspaceId, worktreeId };
}

function coworkEntry(entryId: string): LedgerContainer {
  return { kind: 'cowork_entry', workspaceId: 'cowork-1', entryId };
}

function advisorEntry(entryId: string): LedgerContainer {
  return { kind: 'advisor_entry', appWorkspaceId: 'app-advisor', entryId };
}

function containerKey(container: LedgerContainer): string {
  return JSON.stringify(container);
}

function unused(method: string): Promise<never> {
  return Promise.reject(new Error(`${method} is not a lifecycle call`));
}

/** A minimal in-memory store with the repository's lifecycle rules. */
class InMemoryLifecycleStore implements LedgerStoreClient {
  readonly scopes = new Map<string, LedgerScopeRecord>();
  readonly calls: string[] = [];
  private readonly failures = new Map<string, Error>();
  private nextLedger = 1;

  addScope(
    container: LedgerContainer,
    containerCreatedAt: string,
    lifecycleState: LedgerScopeLifecycleState = 'active',
  ): LedgerScopeRecord {
    const ledgerId = `00000000-0000-4000-8000-${String(this.nextLedger).padStart(12, '0')}`;
    this.nextLedger += 1;
    const record: LedgerScopeRecord = {
      scope: { ledgerId, authorityId: AUTHORITY_ID, container },
      containerCreatedAt,
      accountId: null,
      lifecycleState,
      sequence: '1',
      createdAt: '2026-09-28T00:00:00.000Z',
    };
    this.scopes.set(ledgerId, record);
    return record;
  }

  state(scope: LedgerScopeRecord): LedgerScopeRecord | undefined {
    return this.scopes.get(scope.scope.ledgerId);
  }

  failNext(method: string, error: Error): void {
    this.failures.set(method, error);
  }

  getAuthorityId(): Promise<never> {
    return unused('getAuthorityId');
  }

  bindScope(): Promise<never> {
    return unused('bindScope');
  }

  bindGlobalScope(): Promise<never> {
    return unused('bindGlobalScope');
  }

  findGlobalScope(): Promise<never> {
    return unused('findGlobalScope');
  }

  registerActor(): Promise<never> {
    return unused('registerActor');
  }

  listActors(): Promise<never> {
    return unused('listActors');
  }

  addEntry(): Promise<never> {
    return unused('addEntry');
  }

  updateEntry(): Promise<never> {
    return unused('updateEntry');
  }

  publishSummary(): Promise<never> {
    return unused('publishSummary');
  }

  listReceiptKeys(): Promise<never> {
    return unused('listReceiptKeys');
  }

  getEntry(): Promise<never> {
    return unused('getEntry');
  }

  listPendingTitles(): Promise<never> {
    return unused('listPendingTitles');
  }

  recordPendingTitleAttempt(): Promise<never> {
    return unused('recordPendingTitleAttempt');
  }

  resolvePendingTitle(): Promise<never> {
    return unused('resolvePendingTitle');
  }

  searchEntries(): Promise<never> {
    return unused('searchEntries');
  }

  listChanges(): Promise<never> {
    return unused('listChanges');
  }

  getStorageCounts(): Promise<never> {
    return unused('getStorageCounts');
  }

  listScopes(): Promise<LedgerScopeRecord[]> {
    return this.answer('listScopes', () => Array.from(this.scopes.values()));
  }

  findScope(input: LedgerFindScopeInput): Promise<LedgerScopeRecord | null> {
    return this.answer(
      'findScope',
      () =>
        Array.from(this.scopes.values()).find(
          (scope) =>
            containerKey(scope.scope.container) ===
              containerKey(input.container) &&
            scope.containerCreatedAt === input.containerCreatedAt,
        ) ?? null,
    );
  }

  getScope(ledgerId: string): Promise<LedgerScopeRecord | null> {
    return this.answer('getScope', () => this.scopes.get(ledgerId) ?? null);
  }

  findContainerScopes(
    container: LedgerContainer,
  ): Promise<LedgerScopeRecord[]> {
    return this.answer('findContainerScopes', () =>
      Array.from(this.scopes.values()).filter(
        (scope) =>
          containerKey(scope.scope.container) === containerKey(container),
      ),
    );
  }

  setScopeLifecycle(
    input: LedgerStoreSetScopeLifecycleInput,
  ): Promise<LedgerScopeRecord> {
    return this.answer('setScopeLifecycle', () => {
      const scope = this.scopes.get(input.ledgerId);
      if (
        scope === undefined ||
        scope.lifecycleState === 'retirement_pending'
      ) {
        throw new Error('Refused');
      }
      const next: LedgerScopeRecord = { ...scope, lifecycleState: input.state };
      this.scopes.set(input.ledgerId, next);
      return next;
    });
  }

  rebindScope(input: LedgerStoreRebindScopeInput): Promise<LedgerScopeRecord> {
    return this.answer('rebindScope', () => {
      const scope = this.scopes.get(input.ledgerId);
      if (scope === undefined || scope.lifecycleState !== 'archived') {
        throw new Error('Refused');
      }
      const next: LedgerScopeRecord = {
        ...scope,
        scope: { ...scope.scope, container: input.container },
        containerCreatedAt: input.containerCreatedAt,
        lifecycleState: 'active',
      };
      this.scopes.set(input.ledgerId, next);
      return next;
    });
  }

  purgeScope(ledgerId: string): Promise<LedgerStorePurgeScopeResult> {
    return this.answer('purgeScope', () => {
      const scope = this.scopes.get(ledgerId);
      if (scope === undefined) return { purged: false };
      if (scope.lifecycleState !== 'retirement_pending') {
        throw new Error('Refused');
      }
      this.scopes.delete(ledgerId);
      return { purged: true };
    });
  }

  private answer<T>(method: string, run: () => T): Promise<T> {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure !== undefined) {
      this.failures.delete(method);
      return Promise.reject(failure);
    }
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Refused'),
      );
    }
  }
}

const ANY_STRING: unknown = expect.any(String);
const ABSENT: W5FileRead = { state: 'absent' };

/** The first argument of each recorded call, as text. */
function firstArguments(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): string[] {
  return calls.map((call) => String(call[0]));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function archiveManifest(
  projectId: string,
  id: string,
  kind: 'worktree' | 'work-entry',
  createdAt: string,
): Record<string, unknown> {
  return {
    version: 1,
    id,
    kind,
    projectId,
    name: id,
    createdAt,
    archivedAt: '2026-09-25T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-10-25T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

describe('desktop Ledger lifecycle', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let lifecycle: Lifecycle;
  let storageHost: typeof StorageHostModule;

  function databasePath(): string {
    return join(dataDir, 'ledger', 'ledger.sqlite');
  }

  function createDatabaseFile(): void {
    mkdirSync(dirname(databasePath()), { recursive: true });
    writeFileSync(databasePath(), 'not a database');
  }

  function useStore(): InMemoryLifecycleStore {
    const store = new InMemoryLifecycleStore();
    mockGetLedgerStoreClient.mockReturnValue(store);
    return store;
  }

  beforeEach(async () => {
    previousDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'ledger-lifecycle-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    mockFsyncDirectory.mockReset();
    mockFsyncDirectory.mockResolvedValue(undefined);
    jest.resetModules();
    lifecycle = await import('../lifecycle');
    storageHost = await import('../storage-host');
  });

  afterEach(async () => {
    await lifecycle.whenLedgerLifecycleIdle();
    jest.restoreAllMocks();
    mockGetLedgerStoreClient.mockReset();
    mockRecordAppDiagnostic.mockReset();
    mockDrainLedgerScopeBeforePurge.mockClear();
    mockRequestLedgerSync.mockClear();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('without a database file, requests no store and creates nothing', async () => {
    lifecycle.notifyLedgerContainerArchived(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { retained: true },
    );
    lifecycle.notifyLedgerContainerArchived(
      { container: worktree('wt-2'), containerCreatedAt: T0 },
      { retained: false },
    );
    lifecycle.notifyLedgerContainerRestored(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { container: worktree('wt-3'), containerCreatedAt: T1 },
    );
    lifecycle.notifyLedgerContainerPurged({
      container: worktree('wt-4'),
      containerCreatedAt: T0,
    });
    lifecycle.notifyLedgerContainerRemovedExternally(worktree('wt-5'), null);
    await lifecycle.recordLedgerRestoreIntent(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { container: worktree('wt-3'), containerCreatedAt: T1 },
    );
    await lifecycle.recordLedgerMoveIntent(
      { container: worktree('wt-6'), containerCreatedAt: T0 },
      { container: worktree('wt-6', 'ws-2'), containerCreatedAt: T0 },
    );
    lifecycle.discardLedgerMoveIntent(
      { container: worktree('wt-6'), containerCreatedAt: T0 },
      { container: worktree('wt-6', 'ws-2'), containerCreatedAt: T0 },
    );
    const capture = await lifecycle.captureLedgerWorkspaceIncarnations(
      'ws-1',
      [],
    );
    lifecycle.notifyLedgerWorkspaceDeleted(capture);
    await lifecycle.reconcileLedgerScopesAtStartup();
    await lifecycle.whenLedgerLifecycleIdle();

    expect(capture).toBeNull();
    expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, 'ledger'))).toBe(false);
  });

  it('reports an intent whose directory cannot be synced as not durable', async () => {
    createDatabaseFile();
    useStore();
    mockFsyncDirectory.mockRejectedValueOnce(
      Object.assign(new Error('I/O error'), { code: 'EIO' }),
    );

    // A crash could undo the write, so the restore must keep its archive.
    await expect(
      lifecycle.recordLedgerRestoreIntent(
        { container: worktree('wt-old'), containerCreatedAt: T0 },
        { container: worktree('wt-new'), containerCreatedAt: T1 },
      ),
    ).resolves.toBe('not_durable');
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ledger_lifecycle_failed',
        reason: 'restore: EIO',
      }),
    );
  });

  it('tells a host whether the database may exist, without creating it', async () => {
    await expect(lifecycle.ledgerDatabaseMayExist()).resolves.toBe(false);
    expect(existsSync(join(dataDir, 'ledger'))).toBe(false);

    createDatabaseFile();
    await expect(lifecycle.ledgerDatabaseMayExist()).resolves.toBe(true);
    expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
  });

  it('waits only a bounded time on a slow intent write, which still completes', async () => {
    createDatabaseFile();
    useStore();
    const journalPath = join(dataDir, 'ledger', 'lifecycle-intents.json');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realOpen = fsPromises.open;
    jest
      .spyOn(fsPromises, 'open')
      .mockImplementation(
        async (
          ...args: Parameters<typeof fsPromises.open>
        ): Promise<FileHandle> => {
          await gate;
          return realOpen(...args);
        },
      );

    const started = Date.now();
    const recording = await lifecycle.recordLedgerRestoreIntent(
      { container: worktree('wt-old'), containerCreatedAt: T0 },
      { container: worktree('wt-new'), containerCreatedAt: T1 },
    );
    const waited = Date.now() - started;

    // The restore goes on after the bound, while the write is still pending,
    // and learns that its intent is not durable yet.
    expect(recording).toBe('not_durable');
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(5_000);
    expect(existsSync(journalPath)).toBe(false);

    release();
    await lifecycle.whenLedgerLifecycleIdle();
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      version: 1,
      intents: [{ kind: 'rebind' }],
    });
    expect(mockRecordAppDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'ledger_lifecycle_failed',
        reason: 'restore: INTENT_WRITE_TIMEOUT',
      }),
    );
  });

  it('keeps the intent journal beside the database, and a restore that ended before its rebind is rebound at the next launch', async () => {
    createDatabaseFile();
    const store = useStore();
    const scope = store.addScope(worktree('wt-old'), T0, 'archived');
    writeJson(join(dataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', type: 'single-repo', color: 'blue' },
      ],
    });
    writeJson(join(dataDir, 'workspaces', 'ws-1', 'worktrees.json'), {
      version: 1,
      worktrees: [{ id: 'wt-new', branchName: 'restored', createdAt: T1 }],
    });

    // The restore records its intent, then the app exits before the
    // participant runs; the archive is already purged.
    await lifecycle.recordLedgerRestoreIntent(
      { container: worktree('wt-old'), containerCreatedAt: T0 },
      { container: worktree('wt-new'), containerCreatedAt: T1 },
    );
    // The host's wait is bounded; the write itself always finishes.
    await lifecycle.whenLedgerLifecycleIdle();
    const journalPath = join(dataDir, 'ledger', 'lifecycle-intents.json');
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({
      version: 1,
      intents: [
        {
          kind: 'rebind',
          from: { container: worktree('wt-old'), containerCreatedAt: T0 },
          to: { container: worktree('wt-new'), containerCreatedAt: T1 },
        },
      ],
    });
    // Beside the database, which stays untouched.
    expect(readFileSync(databasePath(), 'utf8')).toBe('not a database');

    jest.resetModules();
    const relaunched: Lifecycle = await import('../lifecycle');
    await relaunched.reconcileLedgerScopesAtStartup();
    await relaunched.whenLedgerLifecycleIdle();

    expect(store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toEqual({
      version: 1,
      intents: [],
    });
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
  });

  it('reports idle at once, touching nothing, when no participant or pass ever ran', async () => {
    const statSpy = jest.spyOn(fsPromises, 'stat');
    let idle = false;

    void lifecycle.whenLedgerLifecycleIdle().then((): void => {
      idle = true;
    });
    await Promise.resolve();

    // Quit waits on this before stopping Ledger storage; it costs nothing
    // when the lifecycle was never created.
    expect(idle).toBe(true);
    expect(statSpy).not.toHaveBeenCalled();
    expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
  });

  it('only stats the database file: it is never opened, read or written', async () => {
    createDatabaseFile();
    const store = useStore();
    const scope = store.addScope(worktree('wt-1'), T0);
    const statSpy = jest.spyOn(fsPromises, 'stat');
    const openSpy = jest.spyOn(fsPromises, 'open');
    const readSpy = jest.spyOn(fsPromises, 'readFile');
    const writeSpy = jest.spyOn(fsPromises, 'writeFile');
    const appendSpy = jest.spyOn(fsPromises, 'appendFile');
    const copySpy = jest.spyOn(fsPromises, 'copyFile');
    const removeSpy = jest.spyOn(fsPromises, 'rm');
    const unlinkSpy = jest.spyOn(fsPromises, 'unlink');

    lifecycle.notifyLedgerContainerArchived(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { retained: false },
    );
    await lifecycle.whenLedgerLifecycleIdle();
    await lifecycle.reconcileLedgerScopesAtStartup();

    expect(store.state(scope)).toBeUndefined();
    expect(statSpy).toHaveBeenCalledWith(databasePath());
    const touchedPaths = [
      ...firstArguments(openSpy.mock.calls),
      ...firstArguments(readSpy.mock.calls),
      ...firstArguments(writeSpy.mock.calls),
      ...firstArguments(appendSpy.mock.calls),
      ...firstArguments(copySpy.mock.calls),
      ...firstArguments(removeSpy.mock.calls),
      ...firstArguments(unlinkSpy.mock.calls),
    ];
    expect(
      touchedPaths.filter((path) => path.startsWith(databasePath())),
    ).toEqual([]);
    expect(readFileSync(databasePath(), 'utf8')).toBe('not a database');
    expect(existsSync(`${databasePath()}-wal`)).toBe(false);
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
  });

  it('settles scopes against the persisted registries, index and archives, failing closed', async () => {
    createDatabaseFile();
    const workspaces = join(dataDir, 'workspaces');
    writeJson(join(workspaces, 'index.json'), {
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', type: 'single-repo', color: 'blue' },
        { id: 'ws-2', name: 'Two', type: 'multi-repo', color: 'red' },
        { id: 'cowork-1', name: 'Notes', type: 'cowork', color: 'green' },
      ],
    });
    writeJson(join(workspaces, 'ws-1', 'worktrees.json'), {
      version: 1,
      worktrees: [{ id: 'wt-live', branchName: 'live', createdAt: T0 }],
    });
    writeJson(
      join(
        workspaces,
        'ws-1',
        'archived-containers',
        'wt-archived',
        'container.json',
      ),
      archiveManifest('ws-1', 'wt-archived', 'worktree', T0),
    );
    // A capture in progress: the directory exists, the manifest does not.
    mkdirSync(join(workspaces, 'ws-1', 'archived-containers', 'wt-staging'), {
      recursive: true,
    });
    mkdirSync(join(workspaces, 'ws-2'), { recursive: true });
    writeFileSync(join(workspaces, 'ws-2', 'worktrees.json'), '{ damaged');
    writeJson(join(workspaces, 'cowork-1', 'work-entries.json'), {
      version: 1,
      entries: [{ id: 'entry-live', createdAt: T0 }],
    });
    writeJson(
      join(dataDir, 'app-workspaces', 'app-advisor', 'work-entries.json'),
      {
        version: 1,
        entries: [{ id: 'advisor-live', createdAt: T0 }],
      },
    );

    const store = useStore();
    const live = store.addScope(worktree('wt-live'), T0, 'archived');
    const gone = store.addScope(worktree('wt-gone'), T0);
    const archived = store.addScope(worktree('wt-archived'), T0);
    const staging = store.addScope(worktree('wt-staging'), T0);
    const damaged = store.addScope(worktree('wt-any', 'ws-2'), T0);
    const deletedWorkspace = store.addScope(worktree('wt-1', 'ws-deleted'), T0);
    const coworkGone = store.addScope(coworkEntry('entry-gone'), T0);
    const coworkLive = store.addScope(
      coworkEntry('entry-live'),
      T0,
      'archived',
    );
    const advisorGone = store.addScope(advisorEntry('advisor-gone'), T0);
    const advisorLive = store.addScope(advisorEntry('advisor-live'), T0);

    await lifecycle.reconcileLedgerScopesAtStartup();

    expect(store.state(live)?.lifecycleState).toBe('active');
    expect(store.state(archived)?.lifecycleState).toBe('archived');
    expect(store.state(staging)).toEqual(staging);
    expect(store.state(damaged)).toEqual(damaged);
    // The damaged registry of ws-2 could hide where either worktree moved,
    // so neither retires while it stays unreadable.
    expect(store.state(gone)).toEqual(gone);
    expect(store.state(deletedWorkspace)).toEqual(deletedWorkspace);
    expect(store.state(coworkGone)).toBeUndefined();
    expect(store.state(coworkLive)?.lifecycleState).toBe('active');
    expect(store.state(advisorGone)).toBeUndefined();
    expect(store.state(advisorLive)).toEqual(advisorLive);
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
  });

  it('moves the scope of a worktree another workspace now lists, and retires one listed nowhere', async () => {
    createDatabaseFile();
    const workspaces = join(dataDir, 'workspaces');
    writeJson(join(workspaces, 'index.json'), {
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', type: 'single-repo', color: 'blue' },
        { id: 'ws-2', name: 'Two', type: 'multi-repo', color: 'red' },
        { id: 'ws-3', name: 'Three', type: 'multi-repo', color: 'green' },
        { id: 'cowork-1', name: 'Notes', type: 'cowork', color: 'green' },
      ],
    });
    writeJson(join(workspaces, 'ws-1', 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    writeJson(join(workspaces, 'ws-2', 'worktrees.json'), {
      version: 1,
      worktrees: [
        // Same instant, another spelling: still the moved incarnation.
        {
          id: 'wt-moved',
          branchName: 'moved',
          createdAt: '2026-09-20T12:00:00+02:00',
        },
        { id: 'wt-orphaned', branchName: 'orphaned', createdAt: T0 },
        { id: 'wt-twice', branchName: 'twice', createdAt: T0 },
        { id: 'wt-reused', branchName: 'reused', createdAt: T1 },
      ],
    });
    writeJson(join(workspaces, 'ws-3', 'worktrees.json'), {
      version: 1,
      worktrees: [{ id: 'wt-twice', branchName: 'twice', createdAt: T0 }],
    });
    // A Cowork workspace has no worktrees.json; it is not searched.

    const store = useStore();
    const moved = store.addScope(worktree('wt-moved'), T0);
    const orphaned = store.addScope(worktree('wt-orphaned', 'ws-deleted'), T0);
    const ambiguous = store.addScope(worktree('wt-twice'), T0);
    const reused = store.addScope(worktree('wt-reused'), T0);
    const gone = store.addScope(worktree('wt-gone'), T0);

    await lifecycle.reconcileLedgerScopesAtStartup();

    expect(store.state(moved)).toEqual({
      ...moved,
      scope: { ...moved.scope, container: worktree('wt-moved', 'ws-2') },
      containerCreatedAt: T0,
      lifecycleState: 'active',
    });
    // A deleted workspace whose worktree lives on elsewhere moves, too.
    expect(store.state(orphaned)?.scope.container).toEqual(
      worktree('wt-orphaned', 'ws-2'),
    );
    expect(store.state(ambiguous)).toEqual(ambiguous);
    // Another incarnation under the same ID is not the same worktree.
    expect(store.state(reused)).toBeUndefined();
    expect(store.state(gone)).toBeUndefined();
    // Each retired scope's outbox drained before its purge (LD10).
    expect(
      mockDrainLedgerScopeBeforePurge.mock.calls.map(([ledgerId]) => ledgerId),
    ).toEqual([reused.scope.ledgerId, gone.scope.ledgerId]);
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalled();
  });

  it('retires nothing a missing or partial workspace index could hide', async () => {
    createDatabaseFile();
    const workspaces = join(dataDir, 'workspaces');
    writeJson(join(workspaces, 'ws-1', 'worktrees.json'), {
      version: 1,
      worktrees: [],
    });
    const store = useStore();
    const scope = store.addScope(worktree('wt-gone'), T0);

    await lifecycle.reconcileLedgerScopesAtStartup();
    expect(store.state(scope)).toEqual(scope);

    // One entry the app would drop makes the index partial.
    writeJson(join(workspaces, 'index.json'), {
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', type: 'single-repo', color: 'blue' },
        { id: 'ws-3', name: 'Three', type: 'unknown-kind', color: 'red' },
      ],
    });
    const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
    await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();
  });

  it('records a content-free app diagnostic when storage fails, without throwing', async () => {
    createDatabaseFile();
    const store = useStore();
    store.addScope(worktree('wt-secret'), T0);
    store.failNext(
      'findScope',
      new storageHost.LedgerStorageHostError(
        'STORAGE_UNAVAILABLE',
        'Ledger storage stopped',
      ),
    );

    expect(() =>
      lifecycle.notifyLedgerContainerArchived(
        { container: worktree('wt-secret'), containerCreatedAt: T0 },
        { retained: false },
      ),
    ).not.toThrow();
    await lifecycle.whenLedgerLifecycleIdle();

    expect(mockRecordAppDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith({
      version: 1,
      timestamp: ANY_STRING,
      kind: 'ledger_lifecycle_failed',
      reason: 'delete: STORAGE_UNAVAILABLE',
    });
    expect(JSON.stringify(mockRecordAppDiagnostic.mock.calls)).not.toMatch(
      /wt-secret|ws-1|ledger\.sqlite/,
    );
  });

  it('records a store client that cannot be created as a failure', async () => {
    createDatabaseFile();
    mockGetLedgerStoreClient.mockImplementation((): never => {
      throw new Error('No storage host');
    });

    lifecycle.notifyLedgerContainerPurged({
      container: worktree('wt-1'),
      containerCreatedAt: T0,
    });
    await lifecycle.whenLedgerLifecycleIdle();

    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith({
      version: 1,
      timestamp: ANY_STRING,
      kind: 'ledger_lifecycle_failed',
      reason: 'purge: UNEXPECTED',
    });
  });

  it('asks sync to send an archive once it commits', async () => {
    createDatabaseFile();
    const store = useStore();
    const scope = store.addScope(worktree('wt-1'), T0);

    lifecycle.notifyLedgerContainerArchived(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { retained: true },
    );
    await lifecycle.whenLedgerLifecycleIdle();

    expect(store.state(scope)?.lifecycleState).toBe('archived');
    expect(mockRequestLedgerSync).toHaveBeenCalledTimes(1);
  });

  it('evicts the caches of the desktop Ledger service once it exists', async () => {
    createDatabaseFile();
    const store = useStore();
    const scope = store.addScope(worktree('wt-1'), T0);
    const adapter: typeof CoreLedgerAdapterModule =
      await import('../core-ledger-adapter');
    const service: typeof ServiceModule = await import('../service');
    const desktopService = adapter.getDesktopLedgerService();
    if (!(desktopService instanceof service.LedgerCoreService)) {
      throw new Error('Expected the desktop Ledger service');
    }
    const forgetContainer = jest.spyOn(
      desktopService.scopes,
      'forgetContainer',
    );
    const forgetLedger = jest.spyOn(desktopService.actors, 'forgetLedger');

    lifecycle.notifyLedgerContainerArchived(
      { container: worktree('wt-1'), containerCreatedAt: T0 },
      { retained: false },
    );
    await lifecycle.whenLedgerLifecycleIdle();

    expect(store.state(scope)).toBeUndefined();
    expect(forgetContainer).toHaveBeenCalledWith(worktree('wt-1'));
    expect(forgetLedger).toHaveBeenCalledWith(scope.scope.ledgerId);
  });

  describe('strict persistence readers', () => {
    it('read registries as absent, unreadable or their rows', async () => {
      const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
      const workspaces = join(dataDir, 'workspaces');
      writeJson(join(workspaces, 'ws-1', 'worktrees.json'), {
        version: 1,
        worktrees: [{ id: 'wt-1', branchName: 'one', createdAt: T0 }],
      });
      writeJson(join(workspaces, 'ws-2', 'worktrees.json'), {
        version: 1,
        worktrees: [
          { id: 'wt-1', branchName: 'one', createdAt: T0 },
          { id: 'wt-1', branchName: 'again', createdAt: T1 },
        ],
      });
      writeJson(join(workspaces, 'ws-3', 'worktrees.json'), {
        version: 1,
        worktrees: [{ id: 'wt-1', branchName: 'one' }],
      });
      writeJson(join(workspaces, 'cowork-1', 'work-entries.json'), {
        version: 2,
        entries: [],
      });

      await expect(
        persistence.readContainerRegistry('worktrees', 'ws-1'),
      ).resolves.toEqual({
        status: 'ok',
        createdAtById: new Map([['wt-1', T0]]),
      });
      await expect(
        persistence.readContainerRegistry('worktrees', 'ws-missing'),
      ).resolves.toEqual({ status: 'absent' });
      // Duplicated IDs and rows without a creation time prove nothing.
      await expect(
        persistence.readContainerRegistry('worktrees', 'ws-2'),
      ).resolves.toEqual({ status: 'unreadable' });
      await expect(
        persistence.readContainerRegistry('worktrees', 'ws-3'),
      ).resolves.toEqual({ status: 'unreadable' });
      await expect(
        persistence.readContainerRegistry('work_entries', 'cowork-1'),
      ).resolves.toEqual({ status: 'unreadable' });
      // Only a missing list is absent: a file where the workspace directory
      // should be (ENOTDIR) proves nothing.
      writeFileSync(join(workspaces, 'ws-file'), 'not a directory');
      await expect(
        persistence.readContainerRegistry('worktrees', 'ws-file'),
      ).resolves.toEqual({ status: 'unreadable' });
    });

    it('read an archive as absent, unreadable or what its manifest records', async () => {
      const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
      const archives = join(
        dataDir,
        'workspaces',
        'ws-1',
        'archived-containers',
      );
      writeJson(join(archives, 'wt-restored', 'container.json'), {
        ...archiveManifest('ws-1', 'wt-restored', 'worktree', T0),
        restoredTo: {
          kind: 'worktree',
          id: 'wt-new',
          restoredAt: '2026-09-26T09:00:00.000Z',
          createdAt: T1,
        },
      });
      writeJson(
        join(archives, 'wt-renamed', 'container.json'),
        archiveManifest('ws-1', 'wt-other', 'worktree', T0),
      );
      mkdirSync(archives, { recursive: true });
      writeFileSync(join(archives, 'wt-file'), 'not a directory');

      await expect(
        persistence.readArchivedContainer('ws-1', 'wt-restored'),
      ).resolves.toEqual({
        status: 'ok',
        record: {
          kind: 'worktree',
          id: 'wt-restored',
          projectId: 'ws-1',
          createdAt: T0,
          restoredTo: { kind: 'worktree', id: 'wt-new', createdAt: T1 },
        },
      });
      await expect(
        persistence.readArchivedContainer('ws-1', 'wt-none'),
      ).resolves.toEqual({ status: 'absent' });
      await expect(
        persistence.readArchivedContainer('ws-1', 'wt-renamed'),
      ).resolves.toEqual({ status: 'unreadable' });
      await expect(
        persistence.readArchivedContainer('ws-1', 'wt-file'),
      ).resolves.toEqual({ status: 'unreadable' });
    });

    it('read the workspace index only when every entry is sound', async () => {
      const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
      const indexPath = join(dataDir, 'workspaces', 'index.json');

      await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();

      writeJson(indexPath, {
        version: 1,
        workspaces: [
          { id: 'ws-1', name: 'One', type: 'single-repo', color: 'blue' },
          { id: 'cowork-1', name: 'Notes', type: 'cowork', color: 'green' },
        ],
      });
      await expect(persistence.readWorkspaceIndex()).resolves.toEqual(
        new Map([
          ['ws-1', 'single-repo'],
          ['cowork-1', 'cowork'],
        ]),
      );

      writeFileSync(indexPath, '{ damaged');
      await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();
    });

    // The reads behind the worktree:archive and workspace:delete
    // participants, the relocation search and the startup pass.
    describe('through the W5 repositories (CAN-5478)', () => {
      let files: Map<string, W5FileRead>;
      let replaced: string[];
      let storeModule: typeof W5CommitStoreModule;

      function stored(path: string, value: unknown): void {
        files.set(path, { state: 'present', raw: JSON.stringify(value) });
      }

      function indexPath(): string {
        return join(dataDir, 'workspaces', 'index.json');
      }

      function listPath(workspaceId: string): string {
        return join(dataDir, 'workspaces', workspaceId, 'worktrees.json');
      }

      function entry(id: string, type: string): Record<string, unknown> {
        return { id, name: id, type, color: 'blue' };
      }

      beforeEach(async () => {
        files = new Map();
        replaced = [];
        storeModule = await import('../../lib/w5-commit-log-file-store');
        // Disk stays empty: only a read through the repositories sees these.
        storeModule.__setDesktopW5FileStoreForTests({
          read: (path) => Promise.resolve(files.get(path) ?? ABSENT),
          replace: (path) => {
            replaced.push(path);
            return Promise.reject(new Error('Reads never write'));
          },
        });
      });

      afterEach(async () => {
        const { nodeW5FileStore } = await import('../../lib/w5-file-store');
        storeModule.__setDesktopW5FileStoreForTests(nodeW5FileStore);
      });

      it('reads the index only when the repository proves every entry', async () => {
        const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
        stored(indexPath(), {
          version: 1,
          workspaces: [
            entry('ws-1', 'single-repo'),
            entry('ws-1', 'single-repo'),
            { id: 'cowork-1', type: 'cowork', color: 'green' },
          ],
        });
        await expect(persistence.readWorkspaceIndex()).resolves.toEqual(
          new Map([
            ['ws-1', 'single-repo'],
            ['cowork-1', 'cowork'],
          ]),
        );

        for (const workspaces of [
          // Partial: entries the repository cannot normalize.
          [entry('ws-1', 'single-repo'), { id: 'ws-2', type: 'multi-repo' }],
          [entry('ws-1', 'single-repo'), { ...entry('ws-2', 'git') }],
          [{ id: 'ws-1', type: 'single-repo', color: 'blue' }],
          // Ambiguous: no id, or one id with two types.
          [entry('', 'single-repo')],
          [entry('ws-1', 'single-repo'), entry('ws-1', 'multi-repo')],
        ]) {
          stored(indexPath(), { version: 1, workspaces });
          await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();
        }
        files.set(indexPath(), { state: 'unreadable' });
        await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();
        files.delete(indexPath());
        await expect(persistence.readWorkspaceIndex()).resolves.toBeNull();
      });

      it('reads a worktree list as absent, unreadable or every row it holds', async () => {
        const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
        const { markWorkspaceWorktreeRecentlyRemoved } =
          await import('../../lib/workspace-persistence');
        stored(listPath('ws-1'), {
          version: 1,
          worktrees: [
            { id: 'wt-1', branchName: 'one', createdAt: T0 },
            { id: 'wt-2', branchName: 'two', createdAt: T1 },
          ],
        });
        // A row this process removed still names its incarnation.
        markWorkspaceWorktreeRecentlyRemoved('ws-1', 'wt-2', T1);
        await expect(
          persistence.readContainerRegistry('worktrees', 'ws-1'),
        ).resolves.toEqual({
          status: 'ok',
          createdAtById: new Map([
            ['wt-1', T0],
            ['wt-2', T1],
          ]),
        });
        expect(replaced).toEqual([]);

        await expect(
          persistence.readContainerRegistry('worktrees', 'ws-missing'),
        ).resolves.toEqual({ status: 'absent' });
        files.set(listPath('ws-io'), { state: 'unreadable' });
        stored(listPath('ws-partial'), {
          version: 1,
          worktrees: [
            { id: 'wt-1', branchName: 'one', createdAt: T0 },
            { id: 'wt-2', branchName: 'two' },
          ],
        });
        stored(listPath('ws-twice'), {
          version: 1,
          worktrees: [
            { id: 'wt-1', branchName: 'one', createdAt: T0 },
            { id: 'wt-1', branchName: 'again', createdAt: T1 },
          ],
        });
        stored(listPath('ws-v2'), { version: 2, worktrees: [] });
        for (const workspaceId of [
          'ws-io',
          'ws-partial',
          'ws-twice',
          'ws-v2',
        ]) {
          await expect(
            persistence.readContainerRegistry('worktrees', workspaceId),
          ).resolves.toEqual({ status: 'unreadable' });
        }
      });

      it('reads a list without waiting on, or joining, a W5 list lock', async () => {
        const persistence = lifecycle.DESKTOP_LEDGER_LIFECYCLE_PERSISTENCE;
        const locks = await import('../../lib/w5-repository-locks');
        for (const workspaceId of ['ws-a', 'ws-b'])
          stored(listPath(workspaceId), {
            version: 1,
            worktrees: [{ id: 'wt-1', branchName: 'one', createdAt: T0 }],
          });
        const ok = { status: 'ok', createdAtById: new Map([['wt-1', T0]]) };
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => undefined;
        const holding = new Promise<void>((resolve) => {
          entered = resolve;
        });
        // Another task holds ws-a's list, as an archive at quit may.
        const holder = locks.withW5RepositoryLock(
          { kind: 'list', path: listPath('ws-a') },
          async () => {
            entered();
            await held;
          },
        );
        await holding;
        // The quit drain waits 2 s for lifecycle work.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise((resolve) => {
          timer = setTimeout(resolve, 2_000, 'timed out');
        });
        try {
          await expect(
            Promise.race([
              persistence.readContainerRegistry('worktrees', 'ws-a'),
              timedOut,
            ]),
          ).resolves.toEqual(ok);
          // A lifecycle task inherits its participant's context: here a
          // later list's lease, and then a commit scope that has finished.
          await locks.withW5RepositoryLock(
            { kind: 'list', path: listPath('ws-b') },
            () =>
              expect(
                persistence.readContainerRegistry('worktrees', 'ws-a'),
              ).resolves.toEqual(ok),
          );
          let afterScope: Promise<unknown> = Promise.resolve();
          await locks.withW5CommitLocks([], () => {
            afterScope = new Promise((resolve) => setImmediate(resolve)).then(
              () => persistence.readContainerRegistry('worktrees', 'ws-b'),
            );
            return Promise.resolve();
          });
          await expect(afterScope).resolves.toEqual(ok);
        } finally {
          clearTimeout(timer);
          release();
          await holder;
        }
      });
    });
  });
});
