import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  LedgerRepository,
  LedgerStoreError,
  type LedgerAcknowledgeOutboxInput,
  type LedgerActorRecord,
  type LedgerAddEntryInput,
  type LedgerBindGlobalScopeInput,
  type LedgerBindScopeInput,
  type LedgerBindScopeResult,
  type LedgerFindGlobalScopeInput,
  type LedgerFindScopeInput,
  type LedgerHandBackEntryInput,
  type LedgerListChangesInput,
  type LedgerListReceiptKeysInput,
  type LedgerOutboxEventRecord,
  type LedgerPublishSummaryInput,
  type LedgerPendingTitleRecord,
  type LedgerRecordPendingTitleAttemptInput,
  type LedgerResolvePendingTitleInput,
  type LedgerResolvePendingTitleResult,
  type LedgerReadOutboxInput,
  type LedgerRebindAccountInput,
  type LedgerRebindAccountResult,
  type LedgerRecordMirrorAudienceInput,
  type LedgerRegisterActorInput,
  type LedgerRegisterActorResult,
  type LedgerRollupsInput,
  type LedgerScopeRecord,
  type LedgerScopeSyncRecord,
  type LedgerSearchEntriesResult,
  type LedgerSetScopeRepairInput,
  type LedgerStorageCounts,
  type LedgerStoreCommandReceipt,
  type LedgerUpdateEntryInput,
  type LedgerWorkSummaryInput,
} from '@canopy/desktop-shared/node/ledger';
import type {
  CanopyCallerDescriptor,
  CanopyGrantName,
  CanopyJsonValue,
  LedgerAuthorDetails,
  LedgerChangesListResult,
  LedgerContainer,
  LedgerEntryGetResult,
  LedgerRollupsListResult,
  LedgerWorkSummaryGetResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import {
  LedgerOwnerEligibility,
  type LedgerLiveChat,
} from '../../actor-directory';
import type { LedgerLiveDelegate } from '../../delegate-owners';
import { LedgerPipelineAgentOwners } from '../../pipeline-agent-owners';
import {
  LedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from '../../caller-bindings';
import type {
  LedgerStorageClient,
  LedgerStoreClient,
  LedgerStoreGetEntryInput,
  LedgerStorePurgeScopeResult,
  LedgerStoreRebindScopeInput,
  LedgerStoreSearchEntriesInput,
  LedgerStoreSetScopeLifecycleInput,
} from '../../ledger-store-client';
import { ledgerContainerKey } from '../../scope-bindings';
import {
  createLedgerService,
  type LedgerCoreService,
  type LedgerServiceOptions,
} from '../../service';
import { LedgerStorageHostError } from '../../storage-host';

/*
 * An in-process `LedgerStorageClient` over a real `LedgerRepository` on a
 * SQLite file in a temporary directory. Store errors reject as
 * `LedgerStorageHostError(reason, message, details)` with the JSON details the
 * storage worker sends, and calls resolve asynchronously, as they do across
 * the worker boundary.
 */

export type LedgerStoreMethod = keyof LedgerStorageClient;

type StoreFailure =
  | { readonly when: 'before'; readonly error: Error }
  | { readonly when: 'after'; readonly error: Error };

/** Converts plain data to a JSON value, dropping undefined members. */
function toJsonValue(value: unknown): CanopyJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown): CanopyJsonValue => toJsonValue(item));
  }
  if (typeof value === 'object') {
    const result: { [key: string]: CanopyJsonValue } = {};
    for (const key of Object.keys(value)) {
      const item: unknown = Reflect.get(value, key);
      if (item !== undefined) result[key] = toJsonValue(item);
    }
    return result;
  }
  throw new TypeError('Expected JSON data');
}

/** JSON-shaped data from any realm; prototypes are not checked. */
function isCrossRealmJson(value: unknown): value is CanopyJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item: unknown): boolean => isCrossRealmJson(item));
  }
  if (typeof value === 'object') {
    return Object.keys(value).every((key): boolean =>
      isCrossRealmJson(Reflect.get(value, key)),
    );
  }
  return false;
}

/** The same JSON built in another V8 context, as a worker reply can be. */
export function inForeignRealm(value: CanopyJsonValue): CanopyJsonValue {
  const foreign: unknown = runInNewContext('JSON.parse(source)', {
    source: JSON.stringify(value),
  });
  if (!isCrossRealmJson(foreign)) {
    throw new TypeError('Expected JSON from the foreign realm');
  }
  return foreign;
}

export interface InProcessLedgerStoreClientOptions {
  /** Sends store error details built in another realm. */
  readonly foreignRealmDetails?: boolean;
}

export class InProcessLedgerStoreClient implements LedgerStorageClient {
  /** Every method called, in order. */
  readonly calls: LedgerStoreMethod[] = [];
  private readonly repository: LedgerRepository;
  private readonly options: InProcessLedgerStoreClientOptions;
  private readonly failures = new Map<LedgerStoreMethod, StoreFailure[]>();

  constructor(
    repository: LedgerRepository,
    options: InProcessLedgerStoreClientOptions = {},
  ) {
    this.repository = repository;
    this.options = options;
  }

  /** Rejects the next call of `method` without running it. */
  failNext(method: LedgerStoreMethod, error: Error): void {
    this.queueFailure(method, { when: 'before', error });
  }

  /** Runs the next call of `method`, then rejects as if its reply was lost. */
  failNextAfterRunning(method: LedgerStoreMethod, error: Error): void {
    this.queueFailure(method, { when: 'after', error });
  }

  callCount(method: LedgerStoreMethod): number {
    return this.calls.filter((call) => call === method).length;
  }

  getAuthorityId(): Promise<string> {
    return this.run('getAuthorityId', () => this.repository.authorityId);
  }

  bindScope(input: LedgerBindScopeInput): Promise<LedgerBindScopeResult> {
    return this.run('bindScope', () => this.repository.bindScope(input));
  }

  findScope(input: LedgerFindScopeInput): Promise<LedgerScopeRecord | null> {
    return this.run('findScope', () => this.repository.findScope(input));
  }

  bindGlobalScope(
    input: LedgerBindGlobalScopeInput,
  ): Promise<LedgerBindScopeResult> {
    return this.run('bindGlobalScope', () =>
      this.repository.bindGlobalScope(input),
    );
  }

  findGlobalScope(
    input: LedgerFindGlobalScopeInput,
  ): Promise<LedgerScopeRecord | null> {
    return this.run('findGlobalScope', () =>
      this.repository.findGlobalScope(input),
    );
  }

  getScope(ledgerId: string): Promise<LedgerScopeRecord | null> {
    return this.run('getScope', () => this.repository.getScope(ledgerId));
  }

  registerActor(
    input: LedgerRegisterActorInput,
  ): Promise<LedgerRegisterActorResult> {
    return this.run('registerActor', () =>
      this.repository.registerActor(input),
    );
  }

  listActors(ledgerId: string): Promise<LedgerActorRecord[]> {
    return this.run('listActors', () => this.repository.listActors(ledgerId));
  }

  addEntry(input: LedgerAddEntryInput): Promise<LedgerStoreCommandReceipt> {
    return this.run('addEntry', () => this.repository.addEntry(input));
  }

  listPendingTitles(): Promise<LedgerPendingTitleRecord[]> {
    return this.run('listPendingTitles', () =>
      this.repository.listPendingTitles(),
    );
  }

  recordPendingTitleAttempt(
    input: LedgerRecordPendingTitleAttemptInput,
  ): Promise<LedgerPendingTitleRecord | null> {
    return this.run('recordPendingTitleAttempt', () =>
      this.repository.recordPendingTitleAttempt(input),
    );
  }

  resolvePendingTitle(
    input: LedgerResolvePendingTitleInput,
  ): Promise<LedgerResolvePendingTitleResult> {
    return this.run('resolvePendingTitle', () =>
      this.repository.resolvePendingTitle(input),
    );
  }

  updateEntry(
    input: LedgerUpdateEntryInput,
  ): Promise<LedgerStoreCommandReceipt> {
    return this.run('updateEntry', () => this.repository.updateEntry(input));
  }

  handBackEntry(
    input: LedgerHandBackEntryInput,
  ): Promise<LedgerStoreCommandReceipt> {
    return this.run('handBackEntry', () =>
      this.repository.handBackEntry(input),
    );
  }

  publishSummary(
    input: LedgerPublishSummaryInput,
  ): Promise<LedgerStoreCommandReceipt> {
    return this.run('publishSummary', () =>
      this.repository.publishSummary(input),
    );
  }

  listReceiptKeys(input: LedgerListReceiptKeysInput): Promise<string[]> {
    return this.run('listReceiptKeys', () =>
      this.repository.listReceiptKeys(input),
    );
  }

  getEntry(input: LedgerStoreGetEntryInput): Promise<LedgerEntryGetResult> {
    return this.run('getEntry', () => this.repository.getEntry(input));
  }

  searchEntries(
    input: LedgerStoreSearchEntriesInput,
  ): Promise<LedgerSearchEntriesResult> {
    return this.run('searchEntries', () =>
      this.repository.searchEntries(input),
    );
  }

  listChanges(input: LedgerListChangesInput): Promise<LedgerChangesListResult> {
    return this.run('listChanges', () => this.repository.listChanges(input));
  }

  listRollups(input: LedgerRollupsInput): Promise<LedgerRollupsListResult> {
    return this.run('listRollups', () => this.repository.listRollups(input));
  }

  getWorkSummary(
    input: LedgerWorkSummaryInput,
  ): Promise<LedgerWorkSummaryGetResult> {
    return this.run('getWorkSummary', () =>
      this.repository.getWorkSummary(input),
    );
  }

  getStorageCounts(): Promise<LedgerStorageCounts> {
    return this.run('getStorageCounts', () =>
      this.repository.getStorageCounts(),
    );
  }

  listScopes(): Promise<LedgerScopeRecord[]> {
    return this.run('listScopes', () => this.repository.listScopes());
  }

  findContainerScopes(
    container: LedgerContainer,
  ): Promise<LedgerScopeRecord[]> {
    return this.run('findContainerScopes', () =>
      this.repository.findContainerScopes(container),
    );
  }

  setScopeLifecycle(
    input: LedgerStoreSetScopeLifecycleInput,
  ): Promise<LedgerScopeRecord> {
    return this.run('setScopeLifecycle', () =>
      this.repository.setScopeLifecycle(input),
    );
  }

  rebindScope(input: LedgerStoreRebindScopeInput): Promise<LedgerScopeRecord> {
    return this.run('rebindScope', () => this.repository.rebindScope(input));
  }

  purgeScope(ledgerId: string): Promise<LedgerStorePurgeScopeResult> {
    return this.run('purgeScope', () => this.repository.purgeScope(ledgerId));
  }

  listSyncScopes(): Promise<LedgerScopeSyncRecord[]> {
    return this.run('listSyncScopes', () => this.repository.listSyncScopes());
  }

  getScopeSync(ledgerId: string): Promise<LedgerScopeSyncRecord | null> {
    return this.run('getScopeSync', () =>
      this.repository.getScopeSync(ledgerId),
    );
  }

  readOutbox(input: LedgerReadOutboxInput): Promise<LedgerOutboxEventRecord[]> {
    return this.run('readOutbox', () => this.repository.readOutbox(input));
  }

  acknowledgeOutbox(
    input: LedgerAcknowledgeOutboxInput,
  ): Promise<LedgerScopeSyncRecord> {
    return this.run('acknowledgeOutbox', () =>
      this.repository.acknowledgeOutbox(input),
    );
  }

  recordMirrorAudience(
    input: LedgerRecordMirrorAudienceInput,
  ): Promise<LedgerScopeSyncRecord> {
    return this.run('recordMirrorAudience', () =>
      this.repository.recordMirrorAudience(input),
    );
  }

  setScopeRepair(
    input: LedgerSetScopeRepairInput,
  ): Promise<LedgerScopeSyncRecord> {
    return this.run('setScopeRepair', () =>
      this.repository.setScopeRepair(input),
    );
  }

  rebindAccount(
    input: LedgerRebindAccountInput,
  ): Promise<LedgerRebindAccountResult> {
    return this.run('rebindAccount', () =>
      this.repository.rebindAccount(input),
    );
  }

  private queueFailure(method: LedgerStoreMethod, failure: StoreFailure): void {
    const queued = this.failures.get(method) ?? [];
    queued.push(failure);
    this.failures.set(method, queued);
  }

  private async run<Result>(
    method: LedgerStoreMethod,
    body: () => Result,
  ): Promise<Result> {
    this.calls.push(method);
    // Resolve asynchronously, as a worker reply does.
    await Promise.resolve();
    const failure = this.failures.get(method)?.shift();
    if (failure?.when === 'before') throw failure.error;
    let result: Result;
    try {
      result = body();
    } catch (error) {
      throw this.toHostError(error);
    }
    if (failure?.when === 'after') throw failure.error;
    return result;
  }

  private toHostError(error: unknown): LedgerStorageHostError {
    if (!(error instanceof LedgerStoreError)) {
      return new LedgerStorageHostError(
        'INTERNAL',
        'The Ledger storage request failed',
      );
    }
    const details = toJsonValue(error.toDetails());
    return new LedgerStorageHostError(
      error.reason,
      error.message,
      this.options.foreignRealmDetails === true
        ? inForeignRealm(details)
        : details,
    );
  }
}

export interface LedgerStoreFixture {
  readonly directory: string;
  readonly databasePath: string;
  readonly repository: LedgerRepository;
  readonly client: InProcessLedgerStoreClient;
  dispose(): void;
}

export interface LedgerStoreFixtureOptions extends InProcessLedgerStoreClientOptions {
  /** The store's clock; real time by default. */
  readonly now?: () => Date;
}

/** A fresh Ledger database in a temporary directory. */
export function createLedgerStoreFixture(
  options: LedgerStoreFixtureOptions = {},
): LedgerStoreFixture {
  return openLedgerStoreFixture(
    mkdtempSync(join(tmpdir(), 'canopy-ledger-service-')),
    options,
  );
}

/** The Ledger database in `directory`, laid out as under the data directory. */
function openLedgerStoreFixture(
  directory: string,
  options: LedgerStoreFixtureOptions,
): LedgerStoreFixture {
  const databasePath = join(directory, 'ledger', 'ledger.sqlite');
  const repository = LedgerRepository.open({
    databasePath,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    directory,
    databasePath,
    repository,
    client: new InProcessLedgerStoreClient(repository, options),
    dispose(): void {
      if (repository.isOpen) repository.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const TEST_CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
};
export const TEST_CONTAINER_CREATED_AT = '2026-09-01T08:00:00.000Z';

export const USER_DETAILS: LedgerAuthorDetails = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

export const CHAT_DETAILS: LedgerAuthorDetails = {
  harness: 'claude',
  model: 'claude-sonnet',
  thinkingEffort: 'medium',
  mode: 'default',
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: null,
};

export const ALL_LEDGER_GRANTS: readonly CanopyGrantName[] = [
  'core.ledger.read',
  'core.ledger.write',
  'core.ledger.publishSummary',
];

/** A settable epoch-millisecond clock. */
export interface TestClock {
  readonly now: () => number;
  advance(ms: number): void;
}

export function createTestClock(
  startMs = Date.parse('2026-09-28T12:00:00.000Z'),
): TestClock {
  let current = startMs;
  return {
    now: (): number => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

export interface LedgerServiceHarness {
  readonly store: LedgerStoreFixture;
  readonly bindings: LedgerCallerBindingRegistry;
  readonly eligibility: LedgerOwnerEligibility;
  readonly clock: TestClock;
  readonly service: LedgerCoreService;
  /** The `canopy-ledger-enabled` value the service reads. */
  enabled: boolean;
  /** The signed-in account a scope is bound to when first used. */
  accountId: string | null;
  /** How often the service asked for the store client. */
  readonly storeRequests: () => number;
  setLiveChats(container: LedgerContainer, chats: LedgerLiveChat[]): void;
  /** Paused pipeline agents, as the pipeline host records them. */
  readonly pipelineAgents: LedgerPipelineAgentOwners;
  /** The retained delegates the delegation host reports for a container. */
  setLiveDelegates(
    container: LedgerContainer,
    delegates: LedgerLiveDelegate[],
  ): void;
  /** Registers a caller binding (a chat in the test worktree by default). */
  register(overrides?: Partial<LedgerCallerBindingRegistration>): string;
  /** Registers the local user in a container. */
  registerUser(overrides?: Partial<LedgerCallerBindingRegistration>): string;
  caller(
    principalId: string,
    grants?: readonly CanopyGrantName[],
  ): CanopyCallerDescriptor;
  context(principalId: string, idempotencyKey?: string): CanopyHandlerContext;
  dispose(): void;
}

export interface LedgerServiceHarnessOptions {
  readonly store?: LedgerStoreFixtureOptions;
  readonly accountId?: string | null;
  /**
   * Eligibility state to share, such as the app's. Defaults to a private one
   * on the harness clock.
   */
  readonly eligibility?: LedgerOwnerEligibility;
  readonly service?: Partial<
    Pick<
      LedgerServiceOptions,
      'resolveSourceAvailability' | 'redact' | 'onEntryChanged' | 'syncStatus'
    >
  >;
}

/** A service over a real store, with stubbed flag, account and chats. */
export function createLedgerServiceHarness(
  options: LedgerServiceHarnessOptions = {},
): LedgerServiceHarness {
  return createServiceHarnessOver(
    createLedgerStoreFixture(options.store),
    options,
  );
}

/**
 * Closes `previous`'s database and opens a new harness on the same file, as a
 * relaunch does: only what is on disk survives. The new harness owns the
 * directory, so dispose it instead of `previous`.
 */
export function reopenLedgerServiceHarness(
  previous: LedgerServiceHarness,
  options: LedgerServiceHarnessOptions = {},
): LedgerServiceHarness {
  if (previous.store.repository.isOpen) previous.store.repository.close();
  return createServiceHarnessOver(
    openLedgerStoreFixture(previous.store.directory, options.store ?? {}),
    options,
  );
}

function createServiceHarnessOver(
  store: LedgerStoreFixture,
  options: LedgerServiceHarnessOptions,
): LedgerServiceHarness {
  const bindings = new LedgerCallerBindingRegistry();
  const clock = createTestClock();
  const eligibility =
    options.eligibility ?? new LedgerOwnerEligibility({ now: clock.now });
  const liveChats = new Map<string, LedgerLiveChat[]>();
  const liveDelegates = new Map<string, LedgerLiveDelegate[]>();
  const pipelineAgents = new LedgerPipelineAgentOwners();
  let storeRequests = 0;
  const harness: LedgerServiceHarness = {
    store,
    bindings,
    eligibility,
    clock,
    pipelineAgents,
    enabled: true,
    accountId:
      options.accountId === undefined ? 'account-1' : options.accountId,
    storeRequests: (): number => storeRequests,
    service: createLedgerService({
      store: (): LedgerStoreClient => {
        storeRequests += 1;
        return store.client;
      },
      isEnabled: (): boolean => harness.enabled,
      getAccountId: (): string | null => harness.accountId,
      liveChats: (container) =>
        Promise.resolve(liveChats.get(ledgerContainerKey(container)) ?? []),
      liveDelegates: (container) =>
        Promise.resolve(liveDelegates.get(ledgerContainerKey(container)) ?? []),
      pipelineAgents,
      callerBindings: bindings,
      eligibility,
      now: clock.now,
      ...options.service,
    }),
    setLiveChats(container: LedgerContainer, chats: LedgerLiveChat[]): void {
      liveChats.set(ledgerContainerKey(container), chats);
    },
    setLiveDelegates(
      container: LedgerContainer,
      delegates: LedgerLiveDelegate[],
    ): void {
      liveDelegates.set(ledgerContainerKey(container), delegates);
    },
    register(overrides: Partial<LedgerCallerBindingRegistration> = {}): string {
      return bindings.register({
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        actor: { kind: 'chat', originKey: 'chat-1', displayName: 'Chat one' },
        role: 'interactive_chat',
        authorDetails: CHAT_DETAILS,
        runtimeGeneration: 1,
        ...overrides,
      });
    },
    registerUser(
      overrides: Partial<LedgerCallerBindingRegistration> = {},
    ): string {
      return harness.register({
        actor: { kind: 'user', originKey: 'local', displayName: 'You' },
        role: 'user',
        authorDetails: USER_DETAILS,
        ...overrides,
      });
    },
    caller(
      principalId: string,
      grants: readonly CanopyGrantName[] = ALL_LEDGER_GRANTS,
    ): CanopyCallerDescriptor {
      return {
        principalId,
        clientInstanceId: 'test-client',
        authorityId: 'test-authority',
        interfaceKind: 'test',
        grants: [...grants],
      };
    },
    context(
      principalId: string,
      idempotencyKey?: string,
    ): CanopyHandlerContext {
      return {
        requestId: 'test-request',
        caller: harness.caller(principalId),
        metadata: idempotencyKey === undefined ? {} : { idempotencyKey },
        signal: new AbortController().signal,
      };
    },
    dispose(): void {
      store.dispose();
    },
  };
  return harness;
}
