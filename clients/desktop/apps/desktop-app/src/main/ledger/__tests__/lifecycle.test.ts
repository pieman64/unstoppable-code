const mockRecordAppDiagnostic = jest.fn();

jest.mock('../../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: (event: unknown) => void;
  } => ({
    recordAppDiagnostic: (event: unknown): void => {
      mockRecordAppDiagnostic(event);
    },
  }),
}));

import type {
  LedgerFindScopeInput,
  LedgerScopeLifecycleState,
  LedgerScopeRecord,
} from '@canopy/desktop-shared/node/ledger';
import { canonicalizeLedgerInstant } from '@canopy/desktop-shared/node/ledger/time';
import type {
  ArchivedContainerManifestV1,
  WorkspaceType,
} from '@canopy/desktop-shared/types';
import type {
  LedgerAuthorDetails,
  LedgerContainer,
} from '@canopy/protocol/canopy-core';
import {
  LedgerOwnerEligibility,
  type LedgerEligibilityClaim,
} from '../actor-directory';
import {
  LedgerCallerBindingRegistry,
  type LedgerCallerBinding,
} from '../caller-bindings';
import type {
  LedgerStoreClient,
  LedgerStorePurgeScopeResult,
  LedgerStoreRebindScopeInput,
  LedgerStoreSetScopeLifecycleInput,
} from '../ledger-store-client';
import {
  LedgerLifecycle,
  type LedgerArchivedContainerRead,
  type LedgerArchivedContainerRecord,
  type LedgerContainerIncarnation,
  type LedgerContainerRegistryKind,
  type LedgerContainerRegistryRead,
  type LedgerLifecycleCaches,
  type LedgerLifecycleFailure,
  type LedgerLifecyclePersistence,
} from '../lifecycle';
import {
  DEFAULT_MAX_INTENTS,
  LedgerLifecycleIntentJournal,
  type LedgerLifecycleIntentFile,
  type LedgerLifecycleIntentKey,
  type LedgerLifecycleIntentKind,
} from '../lifecycle-intents';
import { ledgerContainerKey } from '../scope-bindings';
import { LedgerStorageHostError } from '../storage-host';

const WORKSPACE_ID = 'workspace-1';
const OTHER_WORKSPACE_ID = 'workspace-2';
const COWORK_WORKSPACE_ID = 'cowork-1';
const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-09-20T10:00:00.000Z';
const T1 = '2026-09-26T08:30:00.000Z';
const T2 = '2026-09-27T12:00:00.000Z';
/** When the harness journal finds a damaged file. */
const JOURNAL_DAMAGE_FOUND_AT = '2026-09-28T09:00:00.000Z';

const AUTHOR_DETAILS: LedgerAuthorDetails = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

type WorktreeContainer = Extract<LedgerContainer, { kind: 'code_worktree' }>;

function worktree(
  worktreeId: string,
  workspaceId: string = WORKSPACE_ID,
): WorktreeContainer {
  return { kind: 'code_worktree', workspaceId, worktreeId };
}

function coworkEntry(entryId: string): LedgerContainer {
  return { kind: 'cowork_entry', workspaceId: COWORK_WORKSPACE_ID, entryId };
}

function advisorEntry(entryId: string): LedgerContainer {
  return { kind: 'advisor_entry', appWorkspaceId: 'app-advisor', entryId };
}

function incarnation(
  container: LedgerContainer,
  containerCreatedAt: string,
): LedgerContainerIncarnation {
  return { container, containerCreatedAt };
}

function canonical(value: string): string {
  const instant = canonicalizeLedgerInstant(value);
  if (instant === null) throw new Error(`Not an instant: ${value}`);
  return instant;
}

function fileSystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: operation failed`), { code });
}

function archivedWorktree(
  worktreeId: string,
  createdAt: string,
  restoredTo: LedgerArchivedContainerRecord['restoredTo'] = null,
): LedgerArchivedContainerRead {
  return {
    status: 'ok',
    record: {
      kind: 'worktree',
      id: worktreeId,
      projectId: WORKSPACE_ID,
      createdAt,
      restoredTo,
    },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }
}

/**
 * Holds the next database check until released, as a slow `stat` would. A
 * check the harness never makes leaves it unused.
 */
function holdDatabaseCheck(harness: Harness): { release(): void } {
  let release = (): void => undefined;
  const held = new Promise<{ isFile(): boolean }>((resolve) => {
    release = (): void => resolve({ isFile: (): boolean => true });
  });
  harness.statDatabase.mockImplementationOnce(() => held);
  return { release: (): void => release() };
}

async function settleUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
  }
  if (!condition()) throw new Error('The awaited condition never held');
}

type StoreMethod =
  | 'listScopes'
  | 'findScope'
  | 'getScope'
  | 'findContainerScopes'
  | 'setScopeLifecycle'
  | 'rebindScope'
  | 'purgeScope';

const ALLOWED_MOVES: {
  readonly [From in LedgerScopeLifecycleState]: readonly LedgerScopeLifecycleState[];
} = {
  active: ['archived', 'retirement_pending'],
  archived: ['active', 'retirement_pending'],
  retirement_pending: [],
};

function refusal(from: LedgerScopeLifecycleState): LedgerStorageHostError {
  return new LedgerStorageHostError(
    from === 'retirement_pending' ? 'SCOPE_RETIRED' : 'FORBIDDEN',
    'The Ledger store refused the lifecycle move',
  );
}

function unused(method: string): Promise<never> {
  return Promise.reject(new Error(`${method} is not a lifecycle call`));
}

/**
 * An in-memory store with the lifecycle rules of the real repository. Every
 * call is logged; a call can be held until released or made to fail once.
 */
class FakeLedgerStore implements LedgerStoreClient {
  readonly scopes = new Map<string, LedgerScopeRecord>();
  readonly calls: StoreMethod[] = [];
  private readonly log: string[];
  private readonly failures = new Map<StoreMethod, Error[]>();
  private readonly holds = new Map<StoreMethod, Promise<void>>();
  private nextLedger = 1;

  constructor(log: string[]) {
    this.log = log;
  }

  addScope(
    container: LedgerContainer,
    containerCreatedAt: string,
    lifecycleState: LedgerScopeLifecycleState = 'active',
    createdAt = '2026-09-28T00:00:00.000Z',
  ): LedgerScopeRecord {
    const ledgerId = `00000000-0000-4000-8000-${String(this.nextLedger).padStart(12, '0')}`;
    this.nextLedger += 1;
    const record: LedgerScopeRecord = {
      scope: { ledgerId, authorityId: AUTHORITY_ID, container },
      containerCreatedAt: canonical(containerCreatedAt),
      accountId: null,
      lifecycleState,
      sequence: '1',
      createdAt,
    };
    this.scopes.set(ledgerId, record);
    return record;
  }

  state(scope: LedgerScopeRecord): LedgerScopeRecord | undefined {
    return this.scopes.get(scope.scope.ledgerId);
  }

  failNext(method: StoreMethod, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  /** Holds the next call to `method` until the returned release runs. */
  hold(method: StoreMethod): () => void {
    let release: () => void = (): void => undefined;
    this.holds.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return (): void => release();
  }

  getAuthorityId(): Promise<never> {
    return unused('getAuthorityId');
  }

  bindScope(): Promise<never> {
    return unused('bindScope');
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

  async listScopes(): Promise<LedgerScopeRecord[]> {
    await this.enter('listScopes');
    return Array.from(this.scopes.values());
  }

  async findScope(
    input: LedgerFindScopeInput,
  ): Promise<LedgerScopeRecord | null> {
    await this.enter('findScope');
    return this.byIdentity(input.container, input.containerCreatedAt) ?? null;
  }

  async getScope(ledgerId: string): Promise<LedgerScopeRecord | null> {
    await this.enter('getScope');
    return this.scopes.get(ledgerId) ?? null;
  }

  async findContainerScopes(
    container: LedgerContainer,
  ): Promise<LedgerScopeRecord[]> {
    await this.enter('findContainerScopes');
    const key = ledgerContainerKey(container);
    return Array.from(this.scopes.values()).filter(
      (scope) => ledgerContainerKey(scope.scope.container) === key,
    );
  }

  async setScopeLifecycle(
    input: LedgerStoreSetScopeLifecycleInput,
  ): Promise<LedgerScopeRecord> {
    await this.enter('setScopeLifecycle');
    const scope = this.require(input.ledgerId);
    if (scope.lifecycleState === input.state) return scope;
    if (!ALLOWED_MOVES[scope.lifecycleState].includes(input.state)) {
      throw refusal(scope.lifecycleState);
    }
    return this.put({ ...scope, lifecycleState: input.state });
  }

  async rebindScope(
    input: LedgerStoreRebindScopeInput,
  ): Promise<LedgerScopeRecord> {
    await this.enter('rebindScope');
    const scope = this.require(input.ledgerId);
    const occupant = this.byIdentity(input.container, input.containerCreatedAt);
    if (
      occupant?.scope.ledgerId === scope.scope.ledgerId &&
      scope.lifecycleState === 'active'
    ) {
      return scope;
    }
    if (input.container.kind !== scope.scope.container.kind) {
      throw new LedgerStorageHostError('INVALID_INPUT', 'Another kind');
    }
    if (scope.lifecycleState !== 'archived') {
      throw refusal(scope.lifecycleState);
    }
    if (occupant !== undefined) {
      throw new LedgerStorageHostError('FORBIDDEN', 'Already has a ledger');
    }
    return this.put({
      ...scope,
      scope: { ...scope.scope, container: input.container },
      containerCreatedAt: canonical(input.containerCreatedAt),
      lifecycleState: 'active',
    });
  }

  async purgeScope(ledgerId: string): Promise<LedgerStorePurgeScopeResult> {
    await this.enter('purgeScope');
    const scope = this.scopes.get(ledgerId);
    if (scope === undefined) return { purged: false };
    if (scope.lifecycleState !== 'retirement_pending') {
      throw refusal(scope.lifecycleState);
    }
    this.scopes.delete(ledgerId);
    return { purged: true };
  }

  private async enter(method: StoreMethod): Promise<void> {
    this.calls.push(method);
    this.log.push(`store:${method}`);
    const held = this.holds.get(method);
    if (held !== undefined) {
      this.holds.delete(method);
      await held;
    }
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) throw failure;
  }

  private byIdentity(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): LedgerScopeRecord | undefined {
    const key = ledgerContainerKey(container);
    const createdAt = canonical(containerCreatedAt);
    return Array.from(this.scopes.values()).find(
      (scope) =>
        ledgerContainerKey(scope.scope.container) === key &&
        scope.containerCreatedAt === createdAt,
    );
  }

  private require(ledgerId: string): LedgerScopeRecord {
    const scope = this.scopes.get(ledgerId);
    if (scope === undefined) {
      throw new LedgerStorageHostError('NOT_FOUND', 'No such scope');
    }
    return scope;
  }

  private put(scope: LedgerScopeRecord): LedgerScopeRecord {
    this.scopes.set(scope.scope.ledgerId, scope);
    return scope;
  }
}

/** Persistence as the strict readers report it; everything absent at first. */
class FakePersistence implements LedgerLifecyclePersistence {
  index: ReadonlyMap<string, WorkspaceType> | null = new Map<
    string,
    WorkspaceType
  >([
    [WORKSPACE_ID, 'single-repo'],
    [OTHER_WORKSPACE_ID, 'multi-repo'],
    [COWORK_WORKSPACE_ID, 'cowork'],
  ]);
  readonly reads: string[] = [];
  private readonly registries = new Map<string, LedgerContainerRegistryRead>();
  private readonly archives = new Map<string, LedgerArchivedContainerRead>();

  setRegistry(
    registry: LedgerContainerRegistryKind,
    parentId: string,
    rows: Readonly<Record<string, string>> | 'absent' | 'unreadable',
  ): void {
    this.registries.set(
      `${registry}:${parentId}`,
      typeof rows === 'string'
        ? { status: rows }
        : {
            status: 'ok',
            createdAtById: new Map(Object.entries(rows)),
          },
    );
  }

  setArchive(
    parentId: string,
    containerId: string,
    read: LedgerArchivedContainerRead,
  ): void {
    this.archives.set(`${parentId}/${containerId}`, read);
  }

  readWorkspaceIndex(): Promise<ReadonlyMap<string, WorkspaceType> | null> {
    this.reads.push('index');
    return Promise.resolve(this.index);
  }

  readContainerRegistry(
    registry: LedgerContainerRegistryKind,
    parentId: string,
  ): Promise<LedgerContainerRegistryRead> {
    this.reads.push(`registry:${registry}:${parentId}`);
    return Promise.resolve(
      this.registries.get(`${registry}:${parentId}`) ?? { status: 'absent' },
    );
  }

  readArchivedContainer(
    parentId: string,
    containerId: string,
  ): Promise<LedgerArchivedContainerRead> {
    this.reads.push(`archive:${parentId}/${containerId}`);
    return Promise.resolve(
      this.archives.get(`${parentId}/${containerId}`) ?? { status: 'absent' },
    );
  }
}

/** The intent journal's file, in memory, surviving a simulated restart. */
class MemoryIntentFile implements LedgerLifecycleIntentFile {
  content: string | null = null;
  readonly damaged: string[] = [];
  writes = 0;
  private readonly failures: Error[] = [];

  failNextWrite(error: Error): void {
    this.failures.push(error);
  }

  /** The recorded intents as `kind:from→to` with container IDs only. */
  summary(): string[] {
    if (this.content === null) return [];
    const parsed: unknown = JSON.parse(this.content);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('intents' in parsed) ||
      !Array.isArray(parsed.intents)
    ) {
      throw new Error('Not an intent journal');
    }
    const entries: readonly unknown[] = parsed.intents;
    return entries.map((entry) => JSON.stringify(entry));
  }

  read(): Promise<string | null> {
    return Promise.resolve(this.content);
  }

  replace(content: string): Promise<void> {
    const failure = this.failures.shift();
    if (failure !== undefined) return Promise.reject(failure);
    this.writes += 1;
    this.content = content;
    return Promise.resolve();
  }

  preserveDamaged(content: string): Promise<void> {
    this.damaged.push(content);
    return Promise.resolve();
  }
}

interface HarnessOptions {
  readonly database?: 'present' | 'missing';
  /** False when the Ledger service was never created. */
  readonly serviceCreated?: boolean;
  readonly batchSize?: number;
  /** The intent journal's bound, when not its default. */
  readonly maxIntents?: number;
  readonly recordFailure?: (failure: LedgerLifecycleFailure) => void;
  /** Sync's bounded drain before a purge; absent by default. */
  readonly drainOutbox?: (ledgerId: string, log: string[]) => Promise<void>;
}

interface Harness {
  readonly lifecycle: LedgerLifecycle;
  readonly store: FakeLedgerStore;
  readonly persistence: FakePersistence;
  readonly intentFile: MemoryIntentFile;
  readonly bindings: LedgerCallerBindingRegistry;
  readonly statDatabase: jest.Mock<Promise<{ isFile(): boolean }>, []>;
  readonly forgetContainer: jest.Mock<void, [LedgerContainer]>;
  readonly forgetLedger: jest.Mock<void, [string]>;
  readonly failures: LedgerLifecycleFailure[];
  /** Store calls, the admission fence, eligibility and cache events, in order. */
  readonly log: string[];
  readonly storeRequests: () => number;
  readonly pauses: () => number;
  /** How often sync was asked to send what a lifecycle move recorded. */
  readonly syncRequests: () => number;
  setDatabase(state: 'present' | 'missing'): void;
  /**
   * A new lifecycle over the same store, persistence and journal file, as
   * after the app quit or crashed: nothing queued or cached survives.
   */
  restart(): LedgerLifecycle;
  registerBinding(
    container: LedgerContainer,
    containerCreatedAt: string,
  ): string;
  resolveBinding(bindingId: string): LedgerCallerBinding | undefined;
  issueOwnerToken(scope: LedgerScopeRecord): string;
  isOwnerTokenValid(scope: LedgerScopeRecord, token: string): boolean;
}

function ownerClaim(scope: LedgerScopeRecord): LedgerEligibilityClaim {
  return {
    ledgerId: scope.scope.ledgerId,
    actorId: '22222222-2222-4222-8222-222222222222',
    container: scope.scope.container,
    originKey: 'user:local',
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const log: string[] = [];
  const store = new FakeLedgerStore(log);
  const persistence = new FakePersistence();
  const bindings = new LedgerCallerBindingRegistry();
  const eligibility = new LedgerOwnerEligibility();
  const failures: LedgerLifecycleFailure[] = [];
  let database = options.database ?? 'present';
  let storeRequests = 0;
  let pauses = 0;
  let syncRequests = 0;
  const statDatabase = jest.fn<Promise<{ isFile(): boolean }>, []>(() =>
    database === 'present'
      ? Promise.resolve({ isFile: (): boolean => true })
      : Promise.reject(fileSystemError('ENOENT')),
  );
  const forgetContainer = jest.fn<void, [LedgerContainer]>(
    (container): void => {
      log.push(`forget-container:${ledgerContainerKey(container)}`);
    },
  );
  const forgetLedger = jest.fn<void, [string]>((ledgerId): void => {
    log.push(`forget-ledger:${ledgerId}`);
  });
  const intentFile = new MemoryIntentFile();
  const createLifecycle = (): LedgerLifecycle =>
    new LedgerLifecycle({
      store: (): LedgerStoreClient => {
        storeRequests += 1;
        return store;
      },
      statDatabase,
      persistence,
      caches: (): LedgerLifecycleCaches | undefined =>
        options.serviceCreated === false
          ? undefined
          : { forgetContainer, forgetLedger },
      callerBindings: (): Pick<LedgerCallerBindingRegistry, 'revokeWhere'> => ({
        revokeWhere: (
          predicate: (binding: LedgerCallerBinding) => boolean,
        ): number => {
          log.push('revoke-bindings');
          return bindings.revokeWhere(predicate);
        },
      }),
      withOwnerAdmission: <T>(
        ledgerId: string,
        fn: () => Promise<T>,
      ): Promise<T> =>
        eligibility.withAdmission(ledgerId, async (): Promise<T> => {
          log.push('fence:enter');
          try {
            return await fn();
          } finally {
            log.push('fence:exit');
          }
        }),
      invalidateOwnerEligibility: (target): void => {
        log.push(`invalidate:${ledgerContainerKey(target.container)}`);
        eligibility.invalidate(target);
      },
      recordFailure:
        options.recordFailure ??
        ((failure): void => {
          failures.push(failure);
        }),
      yieldToEventLoop: (): Promise<void> => {
        pauses += 1;
        return Promise.resolve();
      },
      batchSize: options.batchSize,
      requestSync: (): void => {
        syncRequests += 1;
      },
      ...(options.drainOutbox === undefined
        ? {}
        : {
            drainOutbox: (ledgerId: string): Promise<void> =>
              options.drainOutbox?.(ledgerId, log) ?? Promise.resolve(),
          }),
      intents: new LedgerLifecycleIntentJournal({
        file: intentFile,
        maxIntents: options.maxIntents,
        now: (): Date => new Date(JOURNAL_DAMAGE_FOUND_AT),
      }),
      now: (): Date => new Date('2026-09-28T09:00:00.000Z'),
    });
  const lifecycle: LedgerLifecycle = createLifecycle();
  return {
    lifecycle,
    store,
    persistence,
    intentFile,
    bindings,
    statDatabase,
    forgetContainer,
    forgetLedger,
    failures,
    log,
    storeRequests: (): number => storeRequests,
    pauses: (): number => pauses,
    syncRequests: (): number => syncRequests,
    setDatabase: (state): void => {
      database = state;
    },
    restart: createLifecycle,
    registerBinding: (container, containerCreatedAt): string =>
      bindings.register({
        container,
        containerCreatedAt,
        actor: { kind: 'user', originKey: 'user:local', displayName: 'You' },
        role: 'user',
        authorDetails: AUTHOR_DETAILS,
        runtimeGeneration: 0,
      }),
    resolveBinding: (bindingId): LedgerCallerBinding | undefined =>
      bindings.resolve(bindingId),
    issueOwnerToken: (scope): string =>
      eligibility.issueToken(ownerClaim(scope)),
    isOwnerTokenValid: (scope, token): boolean =>
      eligibility.checkToken(ownerClaim(scope), token),
  };
}

afterEach(() => {
  mockRecordAppDiagnostic.mockReset();
});

describe('LedgerLifecycle without a Ledger database', () => {
  it('leaves storage alone for every participant and the startup pass', async () => {
    const harness = createHarness({ database: 'missing' });
    const { lifecycle } = harness;

    lifecycle.containerArchived(incarnation(worktree('wt-archived'), T0), {
      retained: true,
    });
    lifecycle.containerArchived(incarnation(worktree('wt-deleted'), T0), {
      retained: false,
    });
    lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    lifecycle.containerPurged(incarnation(worktree('wt-purged'), T0));
    lifecycle.containerMoved(
      incarnation(worktree('wt-moved'), T0),
      incarnation(worktree('wt-moved', OTHER_WORKSPACE_ID), T0),
    );
    lifecycle.containerRemovedExternally(worktree('wt-cli'), null);
    lifecycle.containerRemovedExternally(worktree('wt-cli-known'), T0);
    const move: LedgerLifecycleIntentKey = {
      kind: 'move',
      from: incarnation(worktree('wt-joined'), T0),
      to: incarnation(worktree('wt-joined', OTHER_WORKSPACE_ID), T0),
    };
    await lifecycle.recordIntent({
      kind: 'rebind',
      from: incarnation(worktree('wt-old'), T0),
      to: incarnation(worktree('wt-new'), T1),
    });
    await lifecycle.recordIntent(move);
    lifecycle.discardIntent(move);
    const capture = await lifecycle.captureWorkspace(WORKSPACE_ID, []);
    lifecycle.workspaceDeleted({
      incarnations: [incarnation(worktree('wt-in-workspace'), T0)],
    });
    // Nothing can be unsettled without a database.
    await expect(lifecycle.reconcileAtStartup()).resolves.toBe('settled');
    await lifecycle.whenIdle();

    // The store client is never even requested, so no worker can start.
    expect(harness.storeRequests()).toBe(0);
    expect(harness.store.calls).toEqual([]);
    expect(harness.persistence.reads).toEqual([]);
    // Nor is the intent journal written beside a database that does not exist.
    expect(harness.intentFile.writes).toBe(0);
    expect(harness.intentFile.content).toBeNull();
    expect(capture).toBeNull();
    expect(harness.statDatabase).toHaveBeenCalledTimes(13);
    expect(harness.failures).toEqual([]);
  });

  it('checks for the database again on the next event, and only until it is found', async () => {
    const harness = createHarness({ database: 'missing' });
    harness.lifecycle.containerPurged(incarnation(worktree('wt-1'), T0));
    await harness.lifecycle.whenIdle();
    expect(harness.storeRequests()).toBe(0);

    harness.setDatabase('present');
    const scope = harness.store.addScope(worktree('wt-2'), T0, 'archived');
    harness.lifecycle.containerPurged(incarnation(worktree('wt-2'), T0));
    await harness.lifecycle.whenIdle();
    harness.lifecycle.containerPurged(incarnation(worktree('wt-3'), T0));
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.statDatabase).toHaveBeenCalledTimes(2);
  });

  it('records a stat failure other than a missing file and still leaves storage alone', async () => {
    const harness = createHarness();
    harness.statDatabase.mockRejectedValue(fileSystemError('EACCES'));

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.storeRequests()).toBe(0);
    expect(harness.failures).toEqual([
      { operation: 'archive', reason: 'EACCES' },
    ]);
  });

  it('reports an incomplete startup pass when the database cannot be checked', async () => {
    const harness = createHarness();
    harness.statDatabase.mockRejectedValue(fileSystemError('EACCES'));

    // It may still hold scopes and intents, so nothing counts as settled.
    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'incomplete',
    );

    expect(harness.storeRequests()).toBe(0);
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'EACCES' },
    ]);
  });

  it('treats a database path that is not a file as no database', async () => {
    const harness = createHarness();
    harness.statDatabase.mockResolvedValue({ isFile: (): boolean => false });

    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'settled',
    );

    expect(harness.storeRequests()).toBe(0);
    expect(harness.failures).toEqual([]);
  });
});

describe('LedgerLifecycle archive participant', () => {
  it('returns before any storage work, then makes the scope read-only', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const token = harness.issueOwnerToken(scope);
    const binding = harness.registerBinding(worktree('wt-1'), T0);

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    expect(harness.store.calls).toEqual([]);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.lifecycleState).toBe('archived');
    expect(harness.store.calls).toEqual(['findScope', 'setScopeLifecycle']);
    // Its actors stop being assignable owners, under the admission fence.
    expect(harness.isOwnerTokenValid(scope, token)).toBe(false);
    expect(harness.log).toEqual([
      'store:findScope',
      'fence:enter',
      'store:setScopeLifecycle',
      `invalidate:${ledgerContainerKey(worktree('wt-1'))}`,
      'fence:exit',
    ]);
    // Reads of an archived scope go on: cached state and bindings stay.
    expect(harness.forgetContainer).not.toHaveBeenCalled();
    expect(harness.forgetLedger).not.toHaveBeenCalled();
    expect(harness.resolveBinding(binding)).toBeDefined();
    // Participants act on what the host reported, without reading files.
    expect(harness.persistence.reads).toEqual([]);
    expect(harness.failures).toEqual([]);
  });

  it('changes nothing for a scope already archived or a container without one', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-1'), T0, 'archived');

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    harness.lifecycle.containerArchived(incarnation(worktree('wt-2'), T0), {
      retained: true,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.calls).toEqual(['findScope', 'findScope']);
    expect(harness.failures).toEqual([]);
  });

  it('finishes the retirement of a scope that is already retiring', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(
      worktree('wt-1'),
      T0,
      'retirement_pending',
    );

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.store.calls).toEqual(['findScope', 'purgeScope']);
  });

  it('acts on the incarnation as it was when notified', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const container = worktree('wt-1');

    harness.lifecycle.containerArchived(incarnation(container, T0), {
      retained: false,
    });
    container.worktreeId = 'wt-2';
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
  });
});

describe('LedgerLifecycle permanent deletion and retention purge', () => {
  it('retires and purges the scope, evicting cached state and the incarnation’s bindings', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const token = harness.issueOwnerToken(scope);
    const doomed = harness.registerBinding(worktree('wt-1'), T0);
    const newerIncarnation = harness.registerBinding(worktree('wt-1'), T1);
    const otherContainer = harness.registerBinding(worktree('wt-2'), T0);
    const key = ledgerContainerKey(worktree('wt-1'));

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: false,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.store.calls).toEqual([
      'findScope',
      'setScopeLifecycle',
      'purgeScope',
    ]);
    expect(harness.forgetContainer).toHaveBeenCalledWith(worktree('wt-1'));
    expect(harness.forgetLedger).toHaveBeenCalledWith(scope.scope.ledgerId);
    expect(harness.resolveBinding(doomed)).toBeUndefined();
    expect(harness.resolveBinding(newerIncarnation)).toBeDefined();
    expect(harness.resolveBinding(otherContainer)).toBeDefined();
    expect(harness.isOwnerTokenValid(scope, token)).toBe(false);
    // Everything after the store change happens inside the admission fence.
    expect(harness.log).toEqual([
      'store:findScope',
      'fence:enter',
      'store:setScopeLifecycle',
      'store:purgeScope',
      `invalidate:${key}`,
      `forget-container:${key}`,
      `forget-ledger:${scope.scope.ledgerId}`,
      'revoke-bindings',
      'fence:exit',
    ]);
    expect(harness.failures).toEqual([]);
  });

  it('retires an archived scope when retention purges its container', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0, 'archived');
    const other = harness.store.addScope(worktree('wt-1'), T1, 'archived');

    harness.lifecycle.containerPurged(incarnation(worktree('wt-1'), T0));
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.store.state(other)).toEqual(other);
    expect(harness.store.calls).toEqual([
      'findScope',
      'setScopeLifecycle',
      'purgeScope',
    ]);
  });

  it('works before the Ledger service exists, when nothing is cached', async () => {
    const harness = createHarness({ serviceCreated: false });
    const scope = harness.store.addScope(coworkEntry('entry-1'), T0);

    harness.lifecycle.containerArchived(
      incarnation(coworkEntry('entry-1'), T0),
      {
        retained: false,
      },
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.forgetContainer).not.toHaveBeenCalled();
    expect(harness.failures).toEqual([]);
  });

  it("drains the scope's outbox once it is retiring, before the purge (LD10)", async () => {
    const harness = createHarness({
      drainOutbox: (ledgerId, log): Promise<void> => {
        log.push(`drain:${ledgerId}`);
        return Promise.resolve();
      },
    });
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const retiring = harness.store.addScope(
      worktree('wt-2'),
      T0,
      'retirement_pending',
    );

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: false,
    });
    await harness.lifecycle.whenIdle();
    harness.lifecycle.containerArchived(incarnation(worktree('wt-2'), T0), {
      retained: true,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.store.state(retiring)).toBeUndefined();
    expect(
      harness.log.filter(
        (line) => line.startsWith('store:') || line.startsWith('drain:'),
      ),
    ).toEqual([
      'store:findScope',
      'store:setScopeLifecycle',
      `drain:${scope.scope.ledgerId}`,
      'store:purgeScope',
      'store:findScope',
      `drain:${retiring.scope.ledgerId}`,
      'store:purgeScope',
    ]);
  });

  it('purges anyway when the drain fails', async () => {
    const harness = createHarness({
      drainOutbox: (): Promise<void> =>
        Promise.reject(new Error('Sync is unavailable')),
    });
    const scope = harness.store.addScope(worktree('wt-1'), T0);

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: false,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.failures).toEqual([]);
  });
});

describe('LedgerLifecycle restore participant', () => {
  it('reattaches the archived scope to the restored container and reactivates it', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const token = harness.issueOwnerToken(scope);
    const oldBinding = harness.registerBinding(worktree('wt-old'), T0);
    const newBinding = harness.registerBinding(worktree('wt-new'), T1);

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual({
      ...scope,
      scope: { ...scope.scope, container: worktree('wt-new') },
      containerCreatedAt: T1,
      lifecycleState: 'active',
    });
    expect(harness.store.calls).toEqual([
      'findContainerScopes',
      'findScope',
      'rebindScope',
    ]);
    expect(harness.forgetContainer.mock.calls).toEqual([
      [worktree('wt-old')],
      [worktree('wt-new')],
    ]);
    expect(harness.forgetLedger).toHaveBeenCalledWith(scope.scope.ledgerId);
    expect(harness.resolveBinding(oldBinding)).toBeUndefined();
    expect(harness.resolveBinding(newBinding)).toBeDefined();
    expect(harness.isOwnerTokenValid(scope, token)).toBe(false);
    expect(harness.log.indexOf('store:rebindScope')).toBeGreaterThan(
      harness.log.indexOf('fence:enter'),
    );
    expect(harness.log[harness.log.length - 1]).toBe('fence:exit');
    expect(harness.persistence.reads).toEqual([]);
    expect(harness.failures).toEqual([]);
  });

  it('matches the archived creation time as an instant, whatever its spelling', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), '2026-09-20T12:00:00+02:00'),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      worktree('wt-new'),
    );
  });

  it('keeps the old scope when the restored container already has its own', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const own = harness.store.addScope(worktree('wt-new'), T1);
    const oldBinding = harness.registerBinding(worktree('wt-old'), T0);

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.state(own)).toEqual(own);
    expect(harness.resolveBinding(oldBinding)).toBeDefined();
    expect(harness.failures).toEqual([
      { operation: 'restore', reason: 'DESTINATION_HAS_SCOPE' },
    ]);
    // Its intent stays, conflicted, so the startup pass keeps the scope.
    expect(
      harness.intentFile.summary().map((line): unknown => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({
        kind: 'rebind',
        from: incarnation(worktree('wt-old'), T0),
        to: incarnation(worktree('wt-new'), T1),
        conflicted: true,
      }),
    ]);
  });

  it('keeps the archived scope of a conflicted restore while the restored container exists, then retires it', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const own = harness.store.addScope(worktree('wt-new'), T1);
    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    // Restart: the archive is gone, and only the restored container is live.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    await harness.restart().reconcileAtStartup();
    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.state(own)).toEqual(own);
    expect(harness.intentFile.summary()).toHaveLength(1);

    // The restored container is deleted too: nothing keeps the old scope.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    await harness.restart().reconcileAtStartup();
    expect(harness.store.state(archived)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it.each<[string, (harness: Harness) => LedgerScopeRecord[]]>([
    [
      'no scope exists for the archived container',
      (): LedgerScopeRecord[] => [],
    ],
    [
      'only another incarnation has a scope',
      (harness): LedgerScopeRecord[] => [
        harness.store.addScope(worktree('wt-old'), T2, 'archived'),
      ],
    ],
    [
      'two scopes claim the archived incarnation',
      (harness): LedgerScopeRecord[] => [
        harness.store.addScope(worktree('wt-old'), T0, 'archived'),
        harness.store.addScope(worktree('wt-old'), T0, 'archived'),
      ],
    ],
  ])('does nothing when %s', async (_case, arrange) => {
    const harness = createHarness();
    const before = arrange(harness);

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.calls).toEqual(['findContainerScopes']);
    expect(before.map((scope) => harness.store.state(scope))).toEqual(before);
    expect(harness.forgetContainer).not.toHaveBeenCalled();
    expect(harness.failures).toEqual([]);
  });

  it.each<LedgerScopeLifecycleState>(['active', 'retirement_pending'])(
    'leaves a matching %s scope alone and records that it was not archived',
    async (state) => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-old'), T0, state);

      harness.lifecycle.containerRestored(
        incarnation(worktree('wt-old'), T0),
        incarnation(worktree('wt-new'), T1),
      );
      await harness.lifecycle.whenIdle();

      expect(harness.store.state(scope)).toEqual(scope);
      expect(harness.store.calls).toEqual(['findContainerScopes']);
      expect(harness.failures).toEqual([
        { operation: 'restore', reason: 'SCOPE_NOT_ARCHIVED' },
      ]);
    },
  );

  it('refuses an archived creation time that is not an instant', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), 'last Tuesday'),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).toEqual([]);
    expect(harness.failures).toEqual([
      { operation: 'restore', reason: 'INVALID_INPUT' },
    ]);
  });
});

describe('LedgerLifecycle sync requests', () => {
  it('asks sync to send an archive, a restore and a move once each commits', async () => {
    const harness = createHarness();
    harness.store.addScope(worktree('wt-1'), T0);
    harness.store.addScope(worktree('wt-old'), T0, 'archived');
    harness.store.addScope(worktree('wt-moving'), T0);

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    expect(harness.syncRequests()).toBe(0);
    await harness.lifecycle.whenIdle();
    expect(harness.syncRequests()).toBe(1);

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await harness.lifecycle.whenIdle();
    expect(harness.syncRequests()).toBe(2);

    harness.lifecycle.containerMoved(
      incarnation(worktree('wt-moving'), T0),
      incarnation(worktree('wt-moving', OTHER_WORKSPACE_ID), T0),
    );
    await harness.lifecycle.whenIdle();
    // Archived, then rebound: two events.
    expect(harness.syncRequests()).toBe(4);
  });

  it('asks nothing when no event was recorded', async () => {
    const harness = createHarness();
    harness.store.addScope(worktree('wt-1'), T0, 'archived');
    harness.store.addScope(worktree('wt-2'), T0);

    // Already archived; no scope at all; deleted, whose outbox the drain sends.
    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    harness.lifecycle.containerArchived(incarnation(worktree('wt-3'), T0), {
      retained: true,
    });
    harness.lifecycle.containerArchived(incarnation(worktree('wt-2'), T0), {
      retained: false,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.syncRequests()).toBe(0);
  });
});

describe('LedgerLifecycle move participant', () => {
  const source = worktree('wt-1');
  const destination = worktree('wt-1', OTHER_WORKSPACE_ID);

  it('archives the scope, then rebinds it to the destination, keeping its ledger', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);
    const token = harness.issueOwnerToken(scope);
    const sourceBinding = harness.registerBinding(source, T0);
    const destinationBinding = harness.registerBinding(destination, T0);

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    expect(harness.store.calls).toEqual([]);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual({
      ...scope,
      scope: { ...scope.scope, container: destination },
      lifecycleState: 'active',
    });
    expect(harness.store.calls).toEqual([
      'findScope',
      'findScope',
      'setScopeLifecycle',
      'rebindScope',
    ]);
    // Each store change runs inside the ledger's admission fence.
    const sourceKey = ledgerContainerKey(source);
    const destinationKey = ledgerContainerKey(destination);
    expect(harness.log).toEqual([
      'store:findScope',
      'store:findScope',
      'fence:enter',
      'store:setScopeLifecycle',
      `invalidate:${sourceKey}`,
      'fence:exit',
      'fence:enter',
      'store:rebindScope',
      `invalidate:${sourceKey}`,
      `invalidate:${destinationKey}`,
      `forget-container:${sourceKey}`,
      `forget-container:${destinationKey}`,
      `forget-ledger:${scope.scope.ledgerId}`,
      'revoke-bindings',
      'fence:exit',
    ]);
    // Callers bound to the old container stop resolving; the moved
    // worktree's own callers keep theirs.
    expect(harness.resolveBinding(sourceBinding)).toBeUndefined();
    expect(harness.resolveBinding(destinationBinding)).toBeDefined();
    expect(harness.isOwnerTokenValid(scope, token)).toBe(false);
    // Participants act on what the host reported, without reading files.
    expect(harness.persistence.reads).toEqual([]);
    expect(harness.failures).toEqual([]);
  });

  it('moves a worktree renamed on the way and matches creation times as instants', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);
    const renamed = worktree('wt-1-2', OTHER_WORKSPACE_ID);

    harness.lifecycle.containerMoved(
      incarnation(source, '2026-09-20T12:00:00+02:00'),
      incarnation(renamed, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.scope.container).toEqual(renamed);
    expect(harness.failures).toEqual([]);
  });

  it('rebinds a scope a previous step left archived without archiving it again', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0, 'archived');

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: destination },
    });
    expect(harness.store.calls).toEqual([
      'findScope',
      'findScope',
      'rebindScope',
    ]);
  });

  it('leaves the source untouched and records it when the destination already has a scope', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);
    const own = harness.store.addScope(destination, T0);
    const binding = harness.registerBinding(source, T0);

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.state(own)).toEqual(own);
    expect(harness.store.calls).toEqual(['findScope', 'findScope']);
    expect(harness.resolveBinding(binding)).toBeDefined();
    expect(harness.forgetContainer).not.toHaveBeenCalled();
    expect(harness.failures).toEqual([
      { operation: 'move', reason: 'DESTINATION_HAS_SCOPE' },
    ]);
  });

  it('does nothing, silently, when the source never used the Ledger', async () => {
    const harness = createHarness();
    const other = harness.store.addScope(worktree('wt-2'), T0);

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(other)).toEqual(other);
    expect(harness.store.calls).toEqual(['findScope']);
    expect(harness.forgetContainer).not.toHaveBeenCalled();
    // Like archive and restore of a container without a scope: no diagnostic.
    expect(harness.failures).toEqual([]);
  });

  it('changes nothing when the scope already belongs to the destination', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(source, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).toEqual(['findScope', 'findScope']);
    expect(harness.failures).toEqual([]);
  });

  it('never moves a retiring scope', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0, 'retirement_pending');

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).toEqual(['findScope', 'findScope']);
    expect(harness.failures).toEqual([
      { operation: 'move', reason: 'SCOPE_RETIRED' },
    ]);
  });

  it.each<[string, LedgerContainerIncarnation, LedgerContainerIncarnation]>([
    [
      'another kind of container',
      incarnation(source, T0),
      incarnation(coworkEntry('entry-1'), T0),
    ],
    [
      'a source creation time that is not an instant',
      incarnation(source, 'yesterday'),
      incarnation(destination, T0),
    ],
    [
      'a destination creation time that is not an instant',
      incarnation(source, T0),
      incarnation(destination, 'tomorrow'),
    ],
  ])(
    'refuses a move to %s before touching storage',
    async (_case, from, to) => {
      const harness = createHarness();
      const scope = harness.store.addScope(source, T0);

      harness.lifecycle.containerMoved(from, to);
      await harness.lifecycle.whenIdle();

      expect(harness.store.state(scope)).toEqual(scope);
      expect(harness.store.calls).toEqual([]);
      expect(harness.failures).toEqual([
        { operation: 'move', reason: 'INVALID_INPUT' },
      ]);
    },
  );

  it('keeps the scope archived and its callers bound when the rebind fails', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);
    const binding = harness.registerBinding(source, T0);
    harness.store.failNext(
      'rebindScope',
      new LedgerStorageHostError('FORBIDDEN', 'Already has a ledger'),
    );

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    await harness.lifecycle.whenIdle();

    // Read-only, not lost: the startup pass finishes the move.
    expect(harness.store.state(scope)).toEqual({
      ...scope,
      lifecycleState: 'archived',
    });
    expect(harness.resolveBinding(binding)).toBeDefined();
    expect(harness.failures).toEqual([
      { operation: 'move', reason: 'FORBIDDEN' },
    ]);
  });

  it('moves the scope a restore just reattached to the moved container', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const release = harness.store.hold('findContainerScopes');

    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(source, T1),
    );
    harness.lifecycle.containerMoved(
      incarnation(source, T1),
      incarnation(destination, T1),
    );
    await settle();

    // The move waits for the restore, which waits on storage.
    expect(harness.store.calls).toEqual(['findContainerScopes']);
    release();
    await harness.lifecycle.whenIdle();

    expect(harness.store.calls).toEqual([
      'findContainerScopes',
      'findScope',
      'rebindScope',
      'findScope',
      'findScope',
      'setScopeLifecycle',
      'rebindScope',
    ]);
    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: destination },
    });
    expect(harness.failures).toEqual([]);
  });

  it('archives the moved scope when its destination is archived right after the move', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);
    const release = harness.store.hold('setScopeLifecycle');

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    harness.lifecycle.containerArchived(incarnation(destination, T0), {
      retained: true,
    });
    await settle();

    expect(harness.store.calls).toEqual([
      'findScope',
      'findScope',
      'setScopeLifecycle',
    ]);
    release();
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'archived',
      scope: { container: destination },
    });
    expect(harness.failures).toEqual([]);
  });

  it('lets a source deletion queued behind the move find nothing to retire', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(source, T0);

    harness.lifecycle.containerMoved(
      incarnation(source, T0),
      incarnation(destination, T0),
    );
    harness.lifecycle.containerArchived(incarnation(source, T0), {
      retained: false,
    });
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: destination },
    });
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.failures).toEqual([]);
  });
});

/** A minimal archive manifest for a worktree archived from `WORKSPACE_ID`. */
function worktreeManifest(
  worktreeId: string,
  createdAt: string,
): ArchivedContainerManifestV1 {
  return {
    version: 1,
    kind: 'worktree',
    id: worktreeId,
    projectId: WORKSPACE_ID,
    name: worktreeId,
    createdAt,
    archivedAt: '2026-09-25T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-10-25T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

describe('LedgerLifecycle intent journal', () => {
  const archivedFrom = incarnation(worktree('wt-old'), T0);
  const restoredTo = incarnation(worktree('wt-new'), T1);

  function rebindIntent(): {
    kind: LedgerLifecycleIntentKind;
    from: LedgerContainerIncarnation;
    to: LedgerContainerIncarnation;
  } {
    return { kind: 'rebind', from: archivedFrom, to: restoredTo };
  }

  it('records an intent only once the database exists, without starting storage', async () => {
    const harness = createHarness({ database: 'missing' });

    await harness.lifecycle.recordIntent(rebindIntent());
    expect(harness.intentFile.writes).toBe(0);
    expect(harness.intentFile.content).toBeNull();

    harness.setDatabase('present');
    await harness.lifecycle.recordIntent(rebindIntent());

    expect(harness.intentFile.summary()).toHaveLength(1);
    expect(JSON.parse(harness.intentFile.summary()[0] ?? '')).toEqual({
      kind: 'rebind',
      from: archivedFrom,
      to: restoredTo,
      recordedAt: '2026-09-28T09:00:00.000Z',
    });
    expect(harness.storeRequests()).toBe(0);
    expect(harness.failures).toEqual([]);
  });

  it('records a failed journal write without rejecting', async () => {
    const harness = createHarness();
    harness.intentFile.failNextWrite(fileSystemError('ENOSPC'));

    await expect(harness.lifecycle.recordIntent(rebindIntent())).resolves.toBe(
      'not_durable',
    );

    expect(harness.intentFile.content).toBeNull();
    expect(harness.failures).toEqual([
      { operation: 'restore', reason: 'ENOSPC' },
    ]);
  });

  it('refuses an intent past the bound, keeping the pending restore intent for the next launch', async () => {
    const harness = createHarness({ maxIntents: 2 });
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    // The restore's intent is the oldest pending entry.
    await expect(harness.lifecycle.recordIntent(rebindIntent())).resolves.toBe(
      'recorded',
    );
    await expect(
      harness.lifecycle.recordIntent({
        kind: 'move',
        from: { container: worktree('wt-a'), containerCreatedAt: T0 },
        to: { container: worktree('wt-b'), containerCreatedAt: T1 },
      }),
    ).resolves.toBe('recorded');

    await expect(
      harness.lifecycle.recordIntent({
        kind: 'move',
        from: { container: worktree('wt-c'), containerCreatedAt: T0 },
        to: { container: worktree('wt-d'), containerCreatedAt: T1 },
      }),
    ).resolves.toBe('not_durable');
    expect(harness.failures).toContainEqual({
      operation: 'intent_journal',
      reason: 'FULL',
    });
    expect(harness.intentFile.summary()).toHaveLength(2);

    // The app exits before the restore's rebind runs, and the archive is gone.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
  });

  it('keeps the archived scope when replay finds the restored container already has a ledger', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const own = harness.store.addScope(worktree('wt-new'), T1);
    await harness.lifecycle.recordIntent(rebindIntent());
    // The app exits before the participant runs, and the archive is gone.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.state(own)).toEqual(own);
    expect(
      harness.intentFile.summary().map((line): unknown => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ kind: 'rebind', conflicted: true })]);
    expect(harness.failures).toContainEqual({
      operation: 'reconcile',
      reason: 'DESTINATION_HAS_SCOPE',
    });
  });

  it('keeps the scope of a restore whose intent a damaged journal lost', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const other = harness.store.addScope(worktree('wt-gone'), T0);
    await harness.lifecycle.recordIntent(rebindIntent());
    // The app exits before the rebind runs, the archive is gone, and the
    // journal is found damaged at the next launch.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    harness.intentFile.content = '{ "version": 1, "intents": [ { damaged';

    await harness.restart().reconcileAtStartup();

    // Neither scope retires: the lost intent could name either.
    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.state(other)).toEqual(other);
    expect(harness.intentFile.damaged).toEqual([
      '{ "version": 1, "intents": [ { damaged',
    ]);
    expect(JSON.parse(harness.intentFile.content ?? '')).toEqual({
      version: 1,
      intents: [],
      damagedAt: JOURNAL_DAMAGE_FOUND_AT,
    });
    // Reported once for the run, not per scope.
    expect(
      harness.failures.filter(
        (failure) => failure.reason === 'INTENT_JOURNAL_INCOMPLETE',
      ),
    ).toEqual([
      { operation: 'reconcile', reason: 'INTENT_JOURNAL_INCOMPLETE' },
    ]);
  });

  it('applies a restore intent beside an entry it cannot read, keeping gone scopes', async () => {
    const harness = createHarness();
    const archived = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    const other = harness.store.addScope(worktree('wt-gone'), T0);
    const unreadable = {
      kind: 'teleport',
      from: { container: worktree('wt-far'), containerCreatedAt: T0 },
      to: { container: worktree('wt-farther'), containerCreatedAt: T0 },
      recordedAt: '2026-09-28T08:00:00.000Z',
    };
    harness.intentFile.content = JSON.stringify({
      version: 1,
      intents: [
        { ...rebindIntent(), recordedAt: '2026-09-28T07:00:00.000Z' },
        unreadable,
      ],
    });
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });

    await harness.restart().reconcileAtStartup();

    // The restore it can read is applied...
    expect(harness.store.state(archived)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
    // ...the other gone scope is kept, since the entry it cannot read could
    // name it, and that entry stays as it was.
    expect(harness.store.state(other)).toEqual(other);
    expect(harness.intentFile.summary()).toEqual([JSON.stringify(unreadable)]);
  });

  it('retires a gone scope created after the journal was found damaged', async () => {
    const harness = createHarness();
    harness.intentFile.content = '{ damaged';
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    await harness.lifecycle.reconcileAtStartup();
    // A scope first used after then cannot be named by a lost intent.
    const later = harness.store.addScope(
      worktree('wt-later'),
      T2,
      'active',
      '2026-09-28T10:00:00.000Z',
    );
    const earlier = harness.store.addScope(worktree('wt-earlier'), T0);

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(later)).toBeUndefined();
    expect(harness.store.state(earlier)).toEqual(earlier);
  });

  it('clears the intent once the participant has rebound the scope', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');

    await harness.lifecycle.recordIntent(rebindIntent());
    harness.lifecycle.containerRestored(archivedFrom, restoredTo);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      worktree('wt-new'),
    );
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('keeps the intent when storage fails, and the next launch applies it', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    harness.store.failNext(
      'rebindScope',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Stopped'),
    );

    await harness.lifecycle.recordIntent(rebindIntent());
    harness.lifecycle.containerRestored(archivedFrom, restoredTo);
    await harness.lifecycle.whenIdle();
    expect(harness.intentFile.summary()).toHaveLength(1);

    // The restore purged the archive; only the journal maps it now.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    await expect(harness.restart().reconcileAtStartup()).resolves.toBe(
      'settled',
    );

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('reports an incomplete pass when storage stops while it replays an intent', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    await harness.lifecycle.recordIntent(rebindIntent());
    // The app exits before the participant runs, and the archive is gone.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    const relaunched = harness.restart();
    harness.store.failNext(
      'rebindScope',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Stopped'),
    );

    await expect(relaunched.reconcileAtStartup()).resolves.toBe('incomplete');

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.intentFile.summary()).toHaveLength(1);
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'STORAGE_UNAVAILABLE' },
    ]);
  });

  it.each<LedgerScopeLifecycleState>(['archived', 'active'])(
    'rebinds an %s scope at startup after an exit between the restore intent and its rebind',
    async (state) => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-old'), T0, state);
      await harness.lifecycle.recordIntent(rebindIntent());
      // The app exits: the participant never runs, and the archive is gone.
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
        'wt-new': T1,
      });

      await harness.restart().reconcileAtStartup();

      expect(harness.store.state(scope)).toMatchObject({
        lifecycleState: 'active',
        containerCreatedAt: T1,
        scope: { container: worktree('wt-new') },
      });
      expect(harness.store.calls).not.toContain('purgeScope');
      expect(harness.intentFile.summary()).toEqual([]);
      expect(harness.failures).toEqual([]);
    },
  );

  it('rebinds a scope at startup after a move to a suffixed ID ended before its participant', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    });
    // The move committed, then the app exited.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-1-2': T0,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T0,
      scope: { container: worktree('wt-1-2', OTHER_WORKSPACE_ID) },
    });
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('drops the intent of a move that never committed and leaves the scope', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    });
    // Rolled back: the source is still where it was.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, { 'wt-1': T0 });
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('drops a stale intent whose destination is gone, then settles the scope as usual', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    });
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});

    await harness.restart().reconcileAtStartup();

    // Listed nowhere, and no intent says where it went: it retires.
    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('keeps an intent persistence cannot verify, and never retires the scope it names', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    });
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry(
      'worktrees',
      OTHER_WORKSPACE_ID,
      'unreadable',
    );

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.intentFile.summary()).toHaveLength(1);
    expect(harness.failures).toEqual([]);
  });

  it('follows a pending intent instead of retiring a scope removed outside the app', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const binding = harness.registerBinding(worktree('wt-1'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-9', OTHER_WORKSPACE_ID), T0),
    });
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-9': T0,
    });

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), null);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      worktree('wt-9', OTHER_WORKSPACE_ID),
    );
    expect(harness.resolveBinding(binding)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('retires no scope while the journal cannot be read', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    // Written by a newer version: never overwritten, and proves nothing.
    harness.intentFile.content = JSON.stringify({ version: 2, intents: [] });

    await harness.lifecycle.recordIntent(rebindIntent());
    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'incomplete',
    );

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.intentFile.writes).toBe(0);
    expect(harness.failures).toEqual([
      { operation: 'restore', reason: 'INTENT_JOURNAL_NEWER' },
      { operation: 'reconcile', reason: 'INTENT_JOURNAL_UNREADABLE' },
    ]);
  });

  it('forgets a discarded intent', async () => {
    const harness = createHarness();
    const move = {
      kind: 'move' as const,
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    };
    await harness.lifecycle.recordIntent(move);

    harness.lifecycle.discardIntent(move);
    await harness.lifecycle.whenIdle();

    expect(harness.intentFile.summary()).toEqual([]);
  });

  it.each([
    ['exists', 'present', true],
    ['is missing', 'missing', false],
  ] as const)(
    'reports whether the database may exist when it %s',
    async (_case, database, mayExist) => {
      const harness = createHarness({ database });

      await expect(harness.lifecycle.databaseMayExist()).resolves.toBe(
        mayExist,
      );
      expect(harness.storeRequests()).toBe(0);
    },
  );

  it('reports that the database may exist when it cannot tell', async () => {
    const harness = createHarness();
    harness.statDatabase.mockRejectedValueOnce(fileSystemError('EACCES'));

    await expect(harness.lifecycle.databaseMayExist()).resolves.toBe(true);
    expect(harness.failures).toEqual([
      { operation: 'delete', reason: 'EACCES' },
    ]);
  });

  it('forgets an intent discarded while its write is still running', async () => {
    const harness = createHarness();
    const move = {
      kind: 'move' as const,
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    };
    // The write's database check is slow.
    const check = holdDatabaseCheck(harness);

    // The host stopped waiting on the write, and its move did not commit.
    const recording = harness.lifecycle.recordIntent(move);
    harness.lifecycle.discardIntent(move);
    await settle();
    check.release();

    await expect(recording).resolves.toBe('recorded');
    await harness.lifecycle.whenIdle();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('keeps a retried intent that follows the discard of an earlier attempt', async () => {
    const harness = createHarness();
    const move = {
      kind: 'move' as const,
      from: incarnation(worktree('wt-1'), T0),
      to: incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0),
    };
    // Were the discard to check the database on its own, that check would
    // be slow.
    harness.statDatabase.mockImplementationOnce(() =>
      Promise.resolve({ isFile: (): boolean => true }),
    );
    const check = holdDatabaseCheck(harness);

    const first = harness.lifecycle.recordIntent(move);
    harness.lifecycle.discardIntent(move);
    const retry = harness.lifecycle.recordIntent(move);
    await settle();
    check.release();

    await expect(first).resolves.toBe('recorded');
    await expect(retry).resolves.toBe('recorded');
    await harness.lifecycle.whenIdle();
    expect(harness.intentFile.summary()).toHaveLength(1);
  });
});

describe('LedgerLifecycle two-into-one moves', () => {
  it('retires the losing source scope once its container is verified gone, revoking its callers', async () => {
    const harness = createHarness();
    const kept = harness.store.addScope(
      worktree('wt-dest', OTHER_WORKSPACE_ID),
      T0,
    );
    const losing = harness.store.addScope(worktree('wt-join'), T2);
    const binding = harness.registerBinding(worktree('wt-join'), T2);
    const token = harness.issueOwnerToken(losing);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});

    harness.lifecycle.containerMoved(
      incarnation(worktree('wt-join'), T2),
      incarnation(worktree('wt-dest', OTHER_WORKSPACE_ID), T0),
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(losing)).toBeUndefined();
    expect(harness.store.state(kept)).toEqual(kept);
    expect(harness.resolveBinding(binding)).toBeUndefined();
    expect(harness.isOwnerTokenValid(losing, token)).toBe(false);
    expect(harness.failures).toEqual([]);
  });

  it('keeps only the source’s ledger when a join ends before either participant ran', async () => {
    const harness = createHarness();
    const source = harness.store.addScope(worktree('wt-src'), T0);
    const joined = harness.store.addScope(
      worktree('wt-join', OTHER_WORKSPACE_ID),
      T1,
    );
    const combined = incarnation(worktree('wt-src', 'workspace-3'), T0);
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-src'), T0),
      to: combined,
    });
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-join', OTHER_WORKSPACE_ID), T1),
      to: combined,
    });
    harness.persistence.index = new Map<string, WorkspaceType>([
      [WORKSPACE_ID, 'single-repo'],
      [OTHER_WORKSPACE_ID, 'single-repo'],
      ['workspace-3', 'multi-repo'],
    ]);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', 'workspace-3', {
      'wt-src': T0,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(source)?.scope.container).toEqual(
      combined.container,
    );
    expect(harness.store.state(joined)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });
});

describe('LedgerLifecycle intent chains', () => {
  const THIRD_WORKSPACE_ID = 'workspace-3';
  // A worktree moved on twice, keeping its creation time, under new IDs.
  const first = incarnation(worktree('wt-1'), T0);
  const second = incarnation(worktree('wt-1-2', OTHER_WORKSPACE_ID), T0);
  const third = incarnation(worktree('wt-1-3', THIRD_WORKSPACE_ID), T0);

  function move(
    from: LedgerContainerIncarnation,
    to: LedgerContainerIncarnation,
  ): LedgerLifecycleIntentKey {
    return { kind: 'move', from, to };
  }

  function withThirdWorkspace(harness: Harness): void {
    harness.persistence.index = new Map<string, WorkspaceType>([
      [WORKSPACE_ID, 'single-repo'],
      [OTHER_WORKSPACE_ID, 'multi-repo'],
      [THIRD_WORKSPACE_ID, 'multi-repo'],
      [COWORK_WORKSPACE_ID, 'cowork'],
    ]);
  }

  /** Both moves committed: only the third workspace lists the worktree. */
  function commitBothMoves(harness: Harness): void {
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {
      'wt-1-3': T0,
    });
  }

  function rebinds(harness: Harness): number {
    return harness.store.calls.filter((call) => call === 'rebindScope').length;
  }

  it('takes the scope straight to the end of two moves that ended before either participant ran', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(second, third));
    commitBothMoves(harness);

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T0,
      scope: { ledgerId: scope.scope.ledgerId, container: third.container },
    });
    expect(rebinds(harness)).toBe(1);
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
    expect(harness.failures).toEqual([]);
  });

  it.each(['purged', 'still on disk'])(
    'follows a restore and then a move that ended before their participants ran, with the archive %s',
    async (archive) => {
      const harness = createHarness();
      const archived = incarnation(worktree('wt-old'), T0);
      const restored = incarnation(worktree('wt-new'), T1);
      const moved = incarnation(worktree('wt-new-2', OTHER_WORKSPACE_ID), T1);
      const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
      await harness.lifecycle.recordIntent({
        kind: 'rebind',
        from: archived,
        to: restored,
      });
      await harness.lifecycle.recordIntent(move(restored, moved));
      if (archive === 'still on disk') {
        harness.persistence.setArchive(
          WORKSPACE_ID,
          'wt-old',
          archivedWorktree('wt-old', T0, {
            kind: 'worktree',
            id: 'wt-new',
            createdAt: T1,
          }),
        );
      }
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-new-2': T1,
      });

      await harness.restart().reconcileAtStartup();

      expect(harness.store.state(scope)).toMatchObject({
        lifecycleState: 'active',
        containerCreatedAt: T1,
        scope: { container: moved.container },
      });
      expect(harness.store.calls).not.toContain('purgeScope');
      expect(harness.intentFile.summary()).toEqual([]);
      expect(harness.failures).toEqual([]);
    },
  );

  it('stops at a hop whose source is still live, dropping that stale hop', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(second, third));
    // The first move committed; the second never did.
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-1-2': T0,
    });
    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {});

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: second.container },
    });
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('follows the attempt that committed past an earlier one from the same place that never did', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(first, third));
    // Only the second attempt committed.
    commitBothMoves(harness);

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      third.container,
    );
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it.each([
    ['kept, after its removal failed', true],
    ['cleared', false],
  ])(
    'ends at the last move when a participant already took the scope along the first, its intent %s',
    async (_label, removalFails) => {
      const harness = createHarness();
      withThirdWorkspace(harness);
      const scope = harness.store.addScope(first.container, T0);
      await harness.lifecycle.recordIntent(move(first, second));
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1-2': T0,
      });
      if (removalFails) {
        harness.intentFile.failNextWrite(fileSystemError('ENOSPC'));
      }
      harness.lifecycle.containerMoved(first, second);
      await harness.lifecycle.whenIdle();
      expect(harness.store.state(scope)?.scope.container).toEqual(
        second.container,
      );
      // The second move commits, then the app exits before its participant.
      await harness.lifecycle.recordIntent(move(second, third));
      commitBothMoves(harness);

      await harness.restart().reconcileAtStartup();

      expect(harness.store.state(scope)).toMatchObject({
        lifecycleState: 'active',
        scope: { container: third.container },
      });
      expect(rebinds(harness)).toBe(2);
      expect(harness.store.calls).not.toContain('purgeScope');
      expect(harness.intentFile.summary()).toEqual([]);
    },
  );

  it('keeps the ledger that joined first when a join and a later move ended before any participant ran', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const source = harness.store.addScope(worktree('wt-src'), T0);
    const joined = harness.store.addScope(
      worktree('wt-join', OTHER_WORKSPACE_ID),
      T1,
    );
    const combined = incarnation(worktree('wt-src', THIRD_WORKSPACE_ID), T0);
    const split = incarnation(worktree('wt-src-2'), T0);
    await harness.lifecycle.recordIntent(
      move(incarnation(worktree('wt-src'), T0), combined),
    );
    await harness.lifecycle.recordIntent(
      move(incarnation(worktree('wt-join', OTHER_WORKSPACE_ID), T1), combined),
    );
    await harness.lifecycle.recordIntent(move(combined, split));
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-src-2': T0,
    });
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {});

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(source)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: split.container },
    });
    expect(harness.store.state(joined)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('follows a worktree that moved away and back again without looping', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const away = incarnation(worktree('wt-1', OTHER_WORKSPACE_ID), T0);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, away));
    await harness.lifecycle.recordIntent(move(away, first));
    // A malformed hop from a place to itself changes nothing either.
    await harness.lifecycle.recordIntent(move(first, first));
    await harness.lifecycle.recordIntent(move(first, third));
    commitBothMoves(harness);

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      third.container,
    );
    expect(harness.intentFile.summary()).toEqual([]);
  });

  function stop(index: number): LedgerContainerIncarnation {
    return incarnation(worktree(`wt-${index}`), T0);
  }

  /** A line of `hops` moves, as a previous launch left the journal. */
  function leaveLineOfMoves(harness: Harness, hops: number): void {
    harness.intentFile.content = JSON.stringify({
      version: 1,
      intents: Array.from({ length: hops }, (_, index) => ({
        ...move(stop(index), stop(index + 1)),
        recordedAt: '2026-09-28T09:00:00.000Z',
      })),
    });
  }

  it('resolves a chain as long as the journal holds', async () => {
    const harness = createHarness();
    const hops = DEFAULT_MAX_INTENTS;
    const scope = harness.store.addScope(stop(0).container, T0);
    leaveLineOfMoves(harness, hops);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      [`wt-${hops}`]: T0,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      stop(hops).container,
    );
    expect(rebinds(harness)).toBe(1);
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('leaves more connected intents than the journal bound, and their scope, alone', async () => {
    const harness = createHarness();
    const hops = DEFAULT_MAX_INTENTS + 1;
    const scope = harness.store.addScope(stop(0).container, T0);
    leaveLineOfMoves(harness, hops);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      [`wt-${hops}`]: T0,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toHaveLength(hops);
    // Recorded once per pass, however many steps meet the chain.
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'INTENT_CHAIN_TOO_LONG' },
    ]);
  });

  it('never retires a scope while its chain cannot be resolved, then resolves it', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    const binding = harness.registerBinding(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(second, third));
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});
    // Where the chain ends cannot be read.
    harness.persistence.setRegistry(
      'worktrees',
      THIRD_WORKSPACE_ID,
      'unreadable',
    );

    const lifecycle = harness.restart();
    await lifecycle.reconcileAtStartup();
    // Nor does the removal participant retire it.
    lifecycle.containerRemovedExternally(first.container, T0);
    await lifecycle.whenIdle();

    // Its own registry proves the worktree gone, yet the scope stays.
    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.resolveBinding(binding)).toBeDefined();
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toHaveLength(2);
    expect(harness.failures).toEqual([]);

    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {
      'wt-1-3': T0,
    });
    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      third.container,
    );
    expect(harness.resolveBinding(binding)).toBeUndefined();
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('leaves a scope alone when two places claim its container', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(first, third));
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-1-2': T0,
    });
    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {
      'wt-1-3': T0,
    });

    await harness.restart().reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).not.toContain('rebindScope');
    expect(harness.intentFile.summary()).toHaveLength(2);
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'INTENT_CHAIN_AMBIGUOUS' },
    ]);
  });

  it('keeps a move’s intent while its source’s scope waits on a pending chain, so the pass takes the scope to the end', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const fourth = incarnation(worktree('wt-1-4'), T0);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(second, third));
    commitBothMoves(harness);

    // After the relaunch, the worktree moves on before the startup pass runs.
    const lifecycle = harness.restart();
    await lifecycle.recordIntent(move(third, fourth));
    harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-1-4': T0,
    });
    lifecycle.containerMoved(third, fourth);
    await lifecycle.whenIdle();

    // The scope never reached the third place: nothing was carried yet.
    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.intentFile.summary()).toHaveLength(3);

    await lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: fourth.container },
    });
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('follows a chain when a participant settles a container removed outside the app', async () => {
    const harness = createHarness();
    withThirdWorkspace(harness);
    const scope = harness.store.addScope(first.container, T0);
    await harness.lifecycle.recordIntent(move(first, second));
    await harness.lifecycle.recordIntent(move(second, third));
    commitBothMoves(harness);

    harness.lifecycle.containerRemovedExternally(first.container, T0);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.scope.container).toEqual(
      third.container,
    );
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
  });
});

describe('LedgerLifecycle workspace deletion', () => {
  function deleteWorkspace(harness: Harness): void {
    // The deletion commits: the index entry and the directory are gone.
    harness.persistence.index = new Map<string, WorkspaceType>([
      [OTHER_WORKSPACE_ID, 'multi-repo'],
      [COWORK_WORKSPACE_ID, 'cowork'],
    ]);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, 'absent');
  }

  it('captures nothing, reading only a stat, without a database', async () => {
    const harness = createHarness({ database: 'missing' });

    await expect(
      harness.lifecycle.captureWorkspace(WORKSPACE_ID, [
        worktreeManifest('wt-archived', T0),
      ]),
    ).resolves.toBeNull();

    expect(harness.persistence.reads).toEqual([]);
    expect(harness.storeRequests()).toBe(0);
  });

  it('retires every scope the deleted workspace held, revoking their callers', async () => {
    const harness = createHarness();
    const live = harness.store.addScope(worktree('wt-1'), T0);
    const archived = harness.store.addScope(
      worktree('wt-archived'),
      T0,
      'archived',
    );
    const elsewhere = harness.store.addScope(
      worktree('wt-1', OTHER_WORKSPACE_ID),
      T1,
    );
    const binding = harness.registerBinding(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, { 'wt-1': T0 });
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-1': T1,
    });

    const capture = await harness.lifecycle.captureWorkspace(WORKSPACE_ID, [
      worktreeManifest('wt-archived', T0),
    ]);
    if (capture === null) throw new Error('Expected a capture');
    expect(capture.incarnations).toEqual([
      incarnation(worktree('wt-1'), T0),
      incarnation(worktree('wt-archived'), T0),
    ]);
    deleteWorkspace(harness);
    harness.lifecycle.workspaceDeleted(capture);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(live)).toBeUndefined();
    expect(harness.store.state(archived)).toBeUndefined();
    // Another incarnation of the ID, in another workspace, is not touched.
    expect(harness.store.state(elsewhere)).toEqual(elsewhere);
    expect(harness.resolveBinding(binding)).toBeUndefined();
    expect(harness.failures).toEqual([]);
  });

  it('does not purge a worktree that moved elsewhere before the deletion', async () => {
    const harness = createHarness();
    const sameId = harness.store.addScope(worktree('wt-2'), T0);
    const suffixed = harness.store.addScope(worktree('wt-3'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-2': T0,
      'wt-3': T0,
    });
    await harness.lifecycle.recordIntent({
      kind: 'move',
      from: incarnation(worktree('wt-3'), T0),
      to: incarnation(worktree('wt-3-2', OTHER_WORKSPACE_ID), T0),
    });
    const capture = await harness.lifecycle.captureWorkspace(WORKSPACE_ID, []);
    if (capture === null) throw new Error('Expected a capture');
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-2': T0,
      'wt-3-2': T0,
    });
    deleteWorkspace(harness);

    harness.lifecycle.workspaceDeleted(capture);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(sameId)?.scope.container).toEqual(
      worktree('wt-2', OTHER_WORKSPACE_ID),
    );
    expect(harness.store.state(suffixed)?.scope.container).toEqual(
      worktree('wt-3-2', OTHER_WORKSPACE_ID),
    );
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.intentFile.summary()).toEqual([]);
  });

  it('retires a deleted Cowork workspace’s Work Entries', async () => {
    const harness = createHarness();
    const entry = harness.store.addScope(coworkEntry('entry-1'), T0);
    harness.persistence.setRegistry('work_entries', COWORK_WORKSPACE_ID, {
      'entry-1': T0,
    });

    const capture = await harness.lifecycle.captureWorkspace(
      COWORK_WORKSPACE_ID,
      [],
    );
    if (capture === null) throw new Error('Expected a capture');
    harness.persistence.index = new Map<string, WorkspaceType>([
      [WORKSPACE_ID, 'single-repo'],
    ]);
    harness.persistence.setRegistry(
      'work_entries',
      COWORK_WORKSPACE_ID,
      'absent',
    );
    harness.lifecycle.workspaceDeleted(capture);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(entry)).toBeUndefined();
  });
});

describe('LedgerLifecycle ordering', () => {
  it('applies an archive and a quick restore of one container in order', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0);
    const release = harness.store.hold('setScopeLifecycle');

    harness.lifecycle.containerArchived(incarnation(worktree('wt-old'), T0), {
      retained: true,
    });
    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    await settle();

    // The restore waits for the archive, which waits on storage.
    expect(harness.store.calls).toEqual(['findScope', 'setScopeLifecycle']);
    release();
    await harness.lifecycle.whenIdle();

    expect(harness.store.calls).toEqual([
      'findScope',
      'setScopeLifecycle',
      'findContainerScopes',
      'findScope',
      'rebindScope',
    ]);
    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
    expect(harness.failures).toEqual([]);
  });

  it('does not hold one container’s steps behind another’s', async () => {
    const harness = createHarness();
    const held = harness.store.addScope(worktree('wt-1'), T0);
    const other = harness.store.addScope(worktree('wt-2'), T0);
    const release = harness.store.hold('findScope');

    harness.lifecycle.containerArchived(incarnation(worktree('wt-1'), T0), {
      retained: true,
    });
    await settleUntil(() => harness.store.calls.includes('findScope'));
    harness.lifecycle.containerArchived(incarnation(worktree('wt-2'), T0), {
      retained: false,
    });
    await settleUntil(() => harness.store.state(other) === undefined);

    expect(harness.store.state(held)?.lifecycleState).toBe('active');
    release();
    await harness.lifecycle.whenIdle();
    expect(harness.store.state(held)?.lifecycleState).toBe('archived');
    expect(harness.failures).toEqual([]);
  });
});

describe('LedgerLifecycle failures', () => {
  it('never throws or leaves an unhandled rejection, and records only the step and a reason', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const harness = createHarness();
      harness.store.addScope(worktree('wt-secret'), T0);
      harness.store.failNext(
        'findScope',
        new LedgerStorageHostError(
          'STORAGE_UNAVAILABLE',
          'Ledger storage stopped',
        ),
      );
      harness.store.failNext(
        'findContainerScopes',
        new Error('/private/data/wt-secret is broken'),
      );

      expect(() =>
        harness.lifecycle.containerArchived(
          incarnation(worktree('wt-secret'), T0),
          { retained: false },
        ),
      ).not.toThrow();
      expect(() =>
        harness.lifecycle.containerRemovedExternally(
          worktree('wt-secret'),
          null,
        ),
      ).not.toThrow();
      await harness.lifecycle.whenIdle();
      await settle();

      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.failures).toEqual([
        { operation: 'delete', reason: 'STORAGE_UNAVAILABLE' },
        { operation: 'external_removal', reason: 'UNEXPECTED' },
      ]);
      expect(JSON.stringify(harness.failures)).not.toMatch(
        /wt-secret|private|workspace-1/,
      );
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps running when the diagnostic sink throws', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const harness = createHarness({
        recordFailure: (): void => {
          throw new Error('Diagnostics are down');
        },
      });
      const scope = harness.store.addScope(worktree('wt-2'), T0);
      harness.store.failNext(
        'findScope',
        new LedgerStorageHostError('INTERNAL', 'Broken'),
      );

      harness.lifecycle.containerPurged(incarnation(worktree('wt-1'), T0));
      await harness.lifecycle.whenIdle();
      harness.lifecycle.containerArchived(incarnation(worktree('wt-2'), T0), {
        retained: false,
      });
      await harness.lifecycle.whenIdle();
      await settle();

      expect(unhandled).not.toHaveBeenCalled();
      expect(harness.store.state(scope)).toBeUndefined();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('records a malformed notification instead of throwing', () => {
    const harness = createHarness();
    const malformed: LedgerContainerIncarnation = {
      get container(): LedgerContainer {
        throw new Error('The host passed a broken container');
      },
      containerCreatedAt: T0,
    };

    expect(() =>
      harness.lifecycle.containerArchived(malformed, { retained: true }),
    ).not.toThrow();
    expect(() =>
      harness.lifecycle.containerRestored(
        malformed,
        incarnation(worktree('wt-1'), T1),
      ),
    ).not.toThrow();
    expect(() => harness.lifecycle.containerPurged(malformed)).not.toThrow();
    expect(() =>
      harness.lifecycle.containerMoved(
        incarnation(worktree('wt-1'), T0),
        malformed,
      ),
    ).not.toThrow();
    expect(harness.failures).toEqual([
      { operation: 'archive', reason: 'UNEXPECTED' },
      { operation: 'restore', reason: 'UNEXPECTED' },
      { operation: 'purge', reason: 'UNEXPECTED' },
      { operation: 'move', reason: 'UNEXPECTED' },
    ]);
  });
});

describe('LedgerLifecycle external removal participant', () => {
  it('with a creation time, retires only that incarnation once persistence proves it gone', async () => {
    const harness = createHarness();
    const removed = harness.store.addScope(worktree('wt-1'), T0);
    const newer = harness.store.addScope(worktree('wt-1'), T1);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), T0);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(removed)).toBeUndefined();
    expect(harness.store.state(newer)).toEqual(newer);
    expect(harness.failures).toEqual([]);
  });

  it('without a creation time, retires every active incarnation and leaves archived ones to retention', async () => {
    const harness = createHarness();
    const first = harness.store.addScope(worktree('wt-1'), T0);
    const second = harness.store.addScope(worktree('wt-1'), T1);
    const archived = harness.store.addScope(worktree('wt-1'), T2, 'archived');
    const otherContainer = harness.store.addScope(worktree('wt-2'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-1',
      archivedWorktree('wt-1', T2),
    );

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), null);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(first)).toBeUndefined();
    expect(harness.store.state(second)).toBeUndefined();
    expect(harness.store.state(archived)).toEqual(archived);
    expect(harness.store.state(otherContainer)).toEqual(otherContainer);
  });

  it('leaves an incarnation that persistence still lists or cannot prove gone', async () => {
    const harness = createHarness();
    const live = harness.store.addScope(worktree('wt-live'), T0);
    const unproven = harness.store.addScope(
      worktree('wt-1', OTHER_WORKSPACE_ID),
      T0,
    );
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-live': T0,
    });
    harness.persistence.setRegistry(
      'worktrees',
      OTHER_WORKSPACE_ID,
      'unreadable',
    );

    harness.lifecycle.containerRemovedExternally(worktree('wt-live'), T0);
    harness.lifecycle.containerRemovedExternally(
      worktree('wt-1', OTHER_WORKSPACE_ID),
      null,
    );
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(live)).toEqual(live);
    expect(harness.store.state(unproven)).toEqual(unproven);
    expect(harness.failures).toEqual([]);
  });

  it('archives an incarnation that persistence shows archived instead of purging it', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-1',
      archivedWorktree('wt-1', T0),
    );

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), T0);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)?.lifecycleState).toBe('archived');
  });

  it('finishes retiring a scope that is already retiring', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(
      worktree('wt-1'),
      T0,
      'retirement_pending',
    );
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, 'unreadable');

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), null);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toBeUndefined();
  });

  it('follows a worktree that another workspace now lists instead of retiring its scope', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-1': T0,
    });

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), null);
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: worktree('wt-1', OTHER_WORKSPACE_ID) },
    });
    expect(harness.store.calls).not.toContain('purgeScope');
    expect(harness.failures).toEqual([]);
  });

  it('refuses a creation time that is not an instant', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);

    harness.lifecycle.containerRemovedExternally(worktree('wt-1'), 'soon');
    await harness.lifecycle.whenIdle();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.failures).toEqual([
      { operation: 'external_removal', reason: 'INVALID_INPUT' },
    ]);
  });
});

describe('LedgerLifecycle startup reconciliation', () => {
  it('reactivates a scope whose container is live with the same creation time', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0, 'archived');
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-1': '2026-09-20T12:00:00+02:00',
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)?.lifecycleState).toBe('active');
    expect(harness.failures).toEqual([]);
  });

  it('leaves the active scope of a live container as it is', async () => {
    const harness = createHarness();
    harness.store.addScope(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-1': T0,
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.calls).toEqual(['listScopes', 'getScope']);
  });

  it('archives the scope of a container archived with exactly that creation time', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-1',
      archivedWorktree('wt-1', T0),
    );

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)?.lifecycleState).toBe('archived');
  });

  it('retires and purges a scope whose container a readable registry no longer lists', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    const binding = harness.registerBinding(worktree('wt-1'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-other': T0,
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.resolveBinding(binding)).toBeUndefined();
    expect(harness.forgetLedger).toHaveBeenCalledWith(scope.scope.ledgerId);
  });

  it('retires the scope of a reused container ID whose own incarnation is gone', async () => {
    const harness = createHarness();
    const old = harness.store.addScope(worktree('wt-1'), T0);
    const current = harness.store.addScope(worktree('wt-1'), T1);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-1': T1,
    });
    // The archive of yet another incarnation does not cover the old one.
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-1',
      archivedWorktree('wt-1', T2),
    );

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(old)).toBeUndefined();
    expect(harness.store.state(current)).toEqual(current);
  });

  it('retires the scopes of a workspace removed from the index', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(
      worktree('wt-1', 'workspace-gone'),
      T0,
    );

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toBeUndefined();
  });

  it('purges a retiring scope whatever persistence says', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(
      worktree('wt-1'),
      T0,
      'retirement_pending',
    );
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, 'unreadable');
    harness.persistence.index = null;

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toBeUndefined();
    expect(harness.persistence.reads).toEqual([]);
  });

  it('reattaches an archived scope when its manifest proves the restore destination', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-old',
      archivedWorktree('wt-old', T0, {
        kind: 'worktree',
        id: 'wt-new',
        createdAt: T1,
      }),
    );

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      containerCreatedAt: T1,
      scope: { container: worktree('wt-new') },
    });
  });

  it.each<[string, LedgerArchivedContainerRecord['restoredTo']]>([
    [
      'the manifest predates restore identities',
      { kind: 'worktree', id: 'wt-new', createdAt: null },
    ],
    [
      'the destination is not listed',
      { kind: 'worktree', id: 'wt-elsewhere', createdAt: T1 },
    ],
    [
      'the destination has another creation time',
      { kind: 'worktree', id: 'wt-new', createdAt: T2 },
    ],
  ])('keeps the scope archived when %s', async (_case, restoredTo) => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    harness.persistence.setArchive(
      WORKSPACE_ID,
      'wt-old',
      archivedWorktree('wt-old', T0, restoredTo),
    );

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual({
      ...scope,
      lifecycleState: 'archived',
    });
    expect(harness.store.calls).not.toContain('rebindScope');
  });

  it.each<[string, (harness: Harness) => void]>([
    [
      'the registry is unreadable',
      (harness): void => {
        harness.persistence.setRegistry(
          'worktrees',
          WORKSPACE_ID,
          'unreadable',
        );
      },
    ],
    [
      'the workspace index is unreadable, partial or missing',
      (harness): void => {
        harness.persistence.index = null;
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      },
    ],
    [
      'an indexed workspace has no registry',
      (): void => {
        // Every registry starts absent.
      },
    ],
    [
      'the workspace holds another kind of container',
      (harness): void => {
        harness.persistence.index = new Map<string, WorkspaceType>([
          [WORKSPACE_ID, 'cowork'],
        ]);
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      },
    ],
    [
      'an archive directory has no readable manifest',
      (harness): void => {
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
        harness.persistence.setArchive(WORKSPACE_ID, 'wt-1', {
          status: 'unreadable',
        });
      },
    ],
    [
      'the manifest records another kind of container',
      (harness): void => {
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
        harness.persistence.setArchive(WORKSPACE_ID, 'wt-1', {
          status: 'ok',
          record: {
            kind: 'work-entry',
            id: 'wt-1',
            projectId: WORKSPACE_ID,
            createdAt: T0,
            restoredTo: null,
          },
        });
      },
    ],
    [
      'the container is both listed and archived',
      (harness): void => {
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
          'wt-1': T0,
        });
        harness.persistence.setArchive(
          WORKSPACE_ID,
          'wt-1',
          archivedWorktree('wt-1', T0),
        );
      },
    ],
    [
      'the listed creation time is not an instant',
      (harness): void => {
        harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
          'wt-1': 'yesterday',
        });
      },
    ],
  ])('leaves the scope untouched when %s', async (_case, arrange) => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-1'), T0);
    arrange(harness);

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
    expect(harness.store.calls).toEqual(['listScopes', 'getScope']);
    expect(harness.failures).toEqual([]);
  });

  it('settles App Advisor entries from their own registry, without the workspace index', async () => {
    const harness = createHarness();
    const gone = harness.store.addScope(advisorEntry('entry-gone'), T0);
    const live = harness.store.addScope(
      advisorEntry('entry-live'),
      T0,
      'archived',
    );
    harness.persistence.index = null;
    harness.persistence.setRegistry('work_entries', 'app-advisor', {
      'entry-live': T0,
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(gone)).toBeUndefined();
    expect(harness.store.state(live)?.lifecycleState).toBe('active');
    expect(harness.persistence.reads).not.toContain('index');
  });

  it('leaves App Advisor entries alone while their registry is missing', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(advisorEntry('entry-1'), T0);

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(scope)).toEqual(scope);
  });

  it('settles Cowork entries from their workspace’s Work Entry registry', async () => {
    const harness = createHarness();
    const gone = harness.store.addScope(coworkEntry('entry-gone'), T0);
    const archived = harness.store.addScope(coworkEntry('entry-archived'), T0);
    harness.persistence.setRegistry('work_entries', COWORK_WORKSPACE_ID, {
      'entry-live': T1,
    });
    harness.persistence.setArchive(COWORK_WORKSPACE_ID, 'entry-archived', {
      status: 'ok',
      record: {
        kind: 'work-entry',
        id: 'entry-archived',
        projectId: COWORK_WORKSPACE_ID,
        createdAt: T0,
        restoredTo: null,
      },
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(harness.store.state(gone)).toBeUndefined();
    expect(harness.store.state(archived)?.lifecycleState).toBe('archived');
    expect(harness.persistence.reads).toContain(
      `registry:work_entries:${COWORK_WORKSPACE_ID}`,
    );
  });

  describe('a worktree that moved to another workspace', () => {
    const THIRD_WORKSPACE_ID = 'workspace-3';

    it('takes the scope along, keeping its ledger', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      const binding = harness.registerBinding(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': '2026-09-20T12:00:00+02:00',
      });

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)).toEqual({
        ...scope,
        scope: {
          ...scope.scope,
          container: worktree('wt-1', OTHER_WORKSPACE_ID),
        },
        lifecycleState: 'active',
      });
      // Found under the source's queue, then settled again from fresh reads
      // while the queue holds the destination too.
      expect(harness.store.calls).toEqual([
        'listScopes',
        'getScope',
        'findScope',
        'getScope',
        'findScope',
        'setScopeLifecycle',
        'rebindScope',
      ]);
      expect(harness.resolveBinding(binding)).toBeUndefined();
      expect(harness.forgetLedger).toHaveBeenCalledWith(scope.scope.ledgerId);
      expect(harness.failures).toEqual([]);
    });

    it('finishes a move interrupted between archiving and rebinding the scope', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0, 'archived');
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T0,
      });

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)).toMatchObject({
        lifecycleState: 'active',
        scope: { container: worktree('wt-1', OTHER_WORKSPACE_ID) },
      });
      expect(harness.store.calls).not.toContain('setScopeLifecycle');
    });

    it('moves the scope of a deleted workspace whose worktree lives on elsewhere', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(
        worktree('wt-1', 'workspace-gone'),
        T0,
      );
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T0,
      });

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)?.scope.container).toEqual(
        worktree('wt-1', OTHER_WORKSPACE_ID),
      );
      expect(harness.store.calls).not.toContain('purgeScope');
    });

    it('retires the scope when no workspace lists that incarnation', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      // The same ID with another creation time is another worktree.
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T1,
      });

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)).toBeUndefined();
      expect(harness.persistence.reads).toEqual([
        `registry:worktrees:${WORKSPACE_ID}`,
        `archive:${WORKSPACE_ID}/wt-1`,
        'index',
        // Cowork workspaces hold no worktrees and are not searched.
        'index',
        `registry:worktrees:${OTHER_WORKSPACE_ID}`,
      ]);
    });

    it.each<[string, (harness: Harness) => void]>([
      [
        'two workspaces list it',
        (harness): void => {
          harness.persistence.index = new Map<string, WorkspaceType>([
            [WORKSPACE_ID, 'single-repo'],
            [OTHER_WORKSPACE_ID, 'multi-repo'],
            [THIRD_WORKSPACE_ID, 'single-repo'],
          ]);
          harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
            'wt-1': T0,
          });
          harness.persistence.setRegistry('worktrees', THIRD_WORKSPACE_ID, {
            'wt-1': T0,
          });
        },
      ],
      [
        'another workspace’s registry is unreadable',
        (harness): void => {
          harness.persistence.setRegistry(
            'worktrees',
            OTHER_WORKSPACE_ID,
            'unreadable',
          );
        },
      ],
      [
        'another workspace lists it with a creation time that is not an instant',
        (harness): void => {
          harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
            'wt-1': 'last week',
          });
        },
      ],
      [
        'the listed incarnation already has a scope of its own',
        (harness): void => {
          harness.store.addScope(worktree('wt-1', OTHER_WORKSPACE_ID), T0);
          harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
            'wt-1': T0,
          });
        },
      ],
    ])('leaves the scope untouched when %s', async (_case, arrange) => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      arrange(harness);

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)).toEqual(scope);
      expect(harness.store.calls).not.toContain('setScopeLifecycle');
      expect(harness.store.calls).not.toContain('purgeScope');
      expect(harness.failures).toEqual([]);
    });

    it('leaves Work Entries to retire: they never move between workspaces', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(coworkEntry('entry-1'), T0);
      harness.persistence.setRegistry('work_entries', COWORK_WORKSPACE_ID, {});

      await harness.lifecycle.reconcileAtStartup();

      expect(harness.store.state(scope)).toBeUndefined();
      expect(harness.persistence.reads).not.toContain(
        `registry:worktrees:${WORKSPACE_ID}`,
      );
    });

    it('leaves a moved scope to a move participant queued behind it', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T0,
      });
      const release = harness.store.hold('getScope');

      const pass = harness.lifecycle.reconcileAtStartup();
      await settleUntil(() => harness.store.calls.includes('getScope'));
      harness.lifecycle.containerMoved(
        incarnation(worktree('wt-1'), T0),
        incarnation(worktree('wt-1', OTHER_WORKSPACE_ID), T0),
      );
      release();
      await pass;
      await harness.lifecycle.whenIdle();

      expect(harness.store.calls).toEqual([
        'listScopes',
        'getScope',
        'findScope',
        'findScope',
        'setScopeLifecycle',
        'rebindScope',
      ]);
      expect(harness.store.state(scope)?.scope.container).toEqual(
        worktree('wt-1', OTHER_WORKSPACE_ID),
      );
      expect(harness.failures).toEqual([]);
    });

    it('holds the destination while it moves the scope, so a participant for it waits', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T0,
      });
      const release = harness.store.hold('rebindScope');

      const pass = harness.lifecycle.reconcileAtStartup();
      await settleUntil(() => harness.store.calls.includes('rebindScope'));
      harness.lifecycle.containerArchived(
        incarnation(worktree('wt-1', OTHER_WORKSPACE_ID), T0),
        { retained: true },
      );
      await settle();
      const callsWhileHeld = [...harness.store.calls];
      release();
      await pass;
      await harness.lifecycle.whenIdle();

      expect(callsWhileHeld[callsWhileHeld.length - 1]).toBe('rebindScope');
      // The archive of the destination applies to the moved scope.
      expect(harness.store.state(scope)).toMatchObject({
        lifecycleState: 'archived',
        scope: { container: worktree('wt-1', OTHER_WORKSPACE_ID) },
      });
      expect(harness.failures).toEqual([]);
    });

    it('reads afresh once it holds the destination: a worktree deleted meanwhile retires its scope', async () => {
      const harness = createHarness();
      const scope = harness.store.addScope(worktree('wt-1'), T0);
      harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
        'wt-1': T0,
      });
      const release = harness.store.hold('findScope');

      const pass = harness.lifecycle.reconcileAtStartup();
      // The pass is checking whether the destination has a scope of its own.
      await settleUntil(() => harness.store.calls.includes('findScope'));
      harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {});
      release();
      await pass;

      expect(harness.store.state(scope)).toBeUndefined();
      expect(harness.store.calls).not.toContain('rebindScope');
    });
  });

  it('skips a scope a participant moved after the listing', async () => {
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    const release = harness.store.hold('getScope');

    const pass = harness.lifecycle.reconcileAtStartup();
    await settleUntil(() => harness.store.calls.includes('getScope'));
    const moved: LedgerScopeRecord = {
      ...scope,
      scope: { ...scope.scope, container: worktree('wt-new') },
      containerCreatedAt: T1,
      lifecycleState: 'active',
    };
    harness.store.scopes.set(scope.scope.ledgerId, moved);
    release();
    await pass;

    expect(harness.store.state(scope)).toEqual(moved);
    expect(harness.store.calls).toEqual(['listScopes', 'getScope']);
  });

  it('leaves a gone scope to a restore queued behind it', async () => {
    // Restore notifies before it purges the archive, so a pass that already
    // sees the archive gone must let the queued restore reattach the scope.
    const harness = createHarness();
    const scope = harness.store.addScope(worktree('wt-old'), T0, 'archived');
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {
      'wt-new': T1,
    });
    const release = harness.store.hold('getScope');

    const pass = harness.lifecycle.reconcileAtStartup();
    await settleUntil(() => harness.store.calls.includes('getScope'));
    harness.lifecycle.containerRestored(
      incarnation(worktree('wt-old'), T0),
      incarnation(worktree('wt-new'), T1),
    );
    release();
    await pass;
    await harness.lifecycle.whenIdle();

    expect(harness.store.calls).toEqual([
      'listScopes',
      'getScope',
      'findContainerScopes',
      'findScope',
      'rebindScope',
    ]);
    expect(harness.store.state(scope)).toMatchObject({
      lifecycleState: 'active',
      scope: { container: worktree('wt-new') },
    });
  });

  it('stops the pass once storage is unavailable', async () => {
    const harness = createHarness();
    const first = harness.store.addScope(worktree('wt-1'), T0);
    const second = harness.store.addScope(worktree('wt-2'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.store.failNext(
      'getScope',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Stopped'),
    );

    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'incomplete',
    );

    expect(harness.store.calls).toEqual(['listScopes', 'getScope']);
    expect(harness.store.state(first)).toEqual(first);
    expect(harness.store.state(second)).toEqual(second);
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'STORAGE_UNAVAILABLE' },
    ]);
  });

  it('records each other failure reason once and carries on', async () => {
    const harness = createHarness();
    harness.store.addScope(worktree('wt-1'), T0);
    harness.store.addScope(worktree('wt-2'), T0);
    const third = harness.store.addScope(worktree('wt-3'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    const failure = new LedgerStorageHostError('INTERNAL', 'Unexpected');
    harness.store.failNext('setScopeLifecycle', failure);
    harness.store.failNext('setScopeLifecycle', failure);

    // The pass carries on, but the scopes that failed are still unsettled.
    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'incomplete',
    );

    expect(harness.store.state(third)).toBeUndefined();
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'INTERNAL' },
    ]);
  });

  it('records a listing failure without rejecting', async () => {
    const harness = createHarness();
    harness.store.failNext(
      'listScopes',
      new LedgerStorageHostError('WRITER_UNAVAILABLE', 'Held elsewhere'),
    );

    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'incomplete',
    );
    expect(harness.failures).toEqual([
      { operation: 'reconcile', reason: 'WRITER_UNAVAILABLE' },
    ]);
  });

  it('runs once per process', async () => {
    const harness = createHarness();

    const first = harness.lifecycle.reconcileAtStartup();
    const second = harness.lifecycle.reconcileAtStartup();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(harness.store.calls).toEqual(['listScopes']);
  });

  it('settles every scope in batches, yielding between them, and shares one classification index read', async () => {
    const harness = createHarness({ batchSize: 2 });
    const scopes = ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5'].map((id) =>
      harness.store.addScope(worktree(id, 'workspace-gone'), T0),
    );

    await expect(harness.lifecycle.reconcileAtStartup()).resolves.toBe(
      'settled',
    );

    expect(scopes.map((scope) => harness.store.state(scope))).toEqual(
      scopes.map(() => undefined),
    );
    // Three batches of at most two, with a yield between each.
    expect(harness.pauses()).toBe(2);
    // One index read classifies every scope of the pass. Before a worktree
    // retires, the index is read afresh, so a workspace a move created after
    // the pass began is searched too.
    expect(
      harness.persistence.reads.filter((read) => read === 'index'),
    ).toHaveLength(1 + scopes.length);
  });

  it('reaches every scope past the first 2,000 in one pass', async () => {
    const harness = createHarness();
    const count = 2_050;
    const scopes: LedgerScopeRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      scopes.push(
        harness.store.addScope(worktree(`wt-${index}`, 'workspace-gone'), T0),
      );
    }
    // The last scopes are live elsewhere: they must be reached to move.
    const moved = harness.store.addScope(worktree('wt-late'), T0);
    harness.persistence.setRegistry('worktrees', WORKSPACE_ID, {});
    harness.persistence.setRegistry('worktrees', OTHER_WORKSPACE_ID, {
      'wt-late': T0,
    });

    await harness.lifecycle.reconcileAtStartup();

    expect(
      scopes.every((scope) => harness.store.state(scope) === undefined),
    ).toBe(true);
    expect(harness.store.state(moved)?.scope.container).toEqual(
      worktree('wt-late', OTHER_WORKSPACE_ID),
    );
    // The default batch size yields between batches of 100.
    expect(harness.pauses()).toBe(Math.ceil((count + 1) / 100) - 1);
    expect(harness.failures).toEqual([]);
  });
});
