import type {
  AgentRunRequest,
  DelegationParentContext,
} from '@canopy/desktop-shared/node/delegation';
import {
  AgentDelegationBroker,
  type AgentDelegationBrokerOptions,
  type DelegationStorage,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { LocalDelegationRunner } from '@canopy/desktop-shared/node/delegation/local-runner';
import { AgentRunnerRegistry } from '@canopy/desktop-shared/node/delegation/runner-registry';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import type {
  CanopyCallerDescriptor,
  LedgerOwnerCandidate,
} from '@canopy/protocol/canopy-core';
import type { AgentDelegationSpawnRequest } from '@canopy/protocol/delegation';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import {
  openChildLedgerTools,
  toLedgerLiveDelegates,
  type ChildLedgerTools,
} from '../agents/delegation/ledger-tools';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import type { CanopyInjectedToolTextResult } from '../canopy-tools/core';
import type {
  LedgerToolsDispatcher,
  LedgerToolsHost,
} from '../canopy-tools/ledger-tools-runtime';
import { LedgerOwnerEligibility } from '../ledger/actor-directory';
import {
  LedgerCallerBindingRegistry,
  type LedgerCallerBindingRegistration,
} from '../ledger/caller-bindings';
import { createLedgerService, type LedgerCoreService } from '../ledger/service';
import {
  ALL_LEDGER_GRANTS,
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  USER_DETAILS,
  createLedgerStoreFixture,
  type LedgerStoreFixture,
} from '../ledger/__tests__/fixtures/in-process-ledger-store-client';

/*
 * A delegate's Ledger caller binding lives exactly as long as one of its run
 * generations, through the real delegation broker and a real Ledger store.
 * An app restart is a new process: a new binding registry, Ledger service and
 * broker over the same Ledger database and delegation registry. Bindings are
 * never persisted, and the restarted broker never relaunches a run, so a
 * binding is registered again only when a continuation starts a new live
 * generation.
 */

const ROOT: DelegationParentContext = {
  harnessId: 'claude',
  // The chat's worktree is the harness container, TEST_CONTAINER.
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  sessionKey: 'workspace-1/worktree-1/chat-1',
  turnId: 'turn-1',
  toolCallId: 'spawn-call',
  runtimeGeneration: 1,
  depth: 0,
};

const TASK: AgentDelegationSpawnRequest = {
  modelId: 'logical-review-model',
  description: 'Review delegate',
  prompt: 'Review the storage change.',
  executionMode: 'background',
  contextPolicy: 'task_only',
  isolation: 'shared_worktree',
};

const ROUTE = routeFixture({
  harnessId: 'claude',
  runtimeKind: 'claude-sdk',
  runnerRegistrationId: 'local-delegation-claude-v1',
  capabilities: ['read', 'resume'],
});

class MemoryStorage implements DelegationStorage {
  readonly records = new Map<string, StoredDelegation>();

  load(): Promise<readonly StoredDelegation[]> {
    return Promise.resolve(structuredClone(Array.from(this.records.values())));
  }

  commit(record: StoredDelegation): Promise<void> {
    const copy = structuredClone(record);
    this.records.set(copy.state.delegationId, copy);
    return Promise.resolve();
  }
}

interface RunControl {
  readonly request: AgentRunRequest;
  readonly tools: ChildLedgerTools | null;
  finish(): void;
}

/** One app process: its in-memory Ledger state and delegation broker. */
interface DesktopProcess {
  readonly broker: AgentDelegationBroker;
  readonly bindings: LedgerCallerBindingRegistry;
  /** Every binding registered in this process, in order, with its ID. */
  readonly registered: {
    readonly id: string;
    readonly registration: LedgerCallerBindingRegistration;
  }[];
  readonly service: LedgerCoreService;
  readonly runs: RunControl[];
  waitForRun(delegationId: string, runGeneration: number): Promise<RunControl>;
  stop(): Promise<void>;
}

/** Broker options a test varies: nesting depth and the live root session. */
type BrokerOverrides = Pick<
  AgentDelegationBrokerOptions,
  'maxDepthForParent' | 'resolveHostParent'
>;

function startProcess(
  store: LedgerStoreFixture,
  storage: MemoryStorage,
  overrides: BrokerOverrides = {},
): DesktopProcess {
  const bindings = new LedgerCallerBindingRegistry();
  const registered: DesktopProcess['registered'] = [];
  const register = bindings.register.bind(bindings);
  jest
    .spyOn(bindings, 'register')
    .mockImplementation((registration): string => {
      const id = register(registration);
      registered.push({ id, registration });
      return id;
    });
  const brokerRef: { current?: AgentDelegationBroker } = {};
  const service = createLedgerService({
    store: () => store.client,
    isEnabled: (): boolean => true,
    getAccountId: (): string => 'account-1',
    liveChats: () =>
      Promise.resolve([
        { chatId: 'chat-1', title: 'Chat one', createdAt: null },
      ]),
    liveDelegates: (container) =>
      Promise.resolve(
        container.kind === 'code_worktree' && brokerRef.current !== undefined
          ? toLedgerLiveDelegates(
              brokerRef.current.continuationCandidates({
                projectId: container.workspaceId,
                worktreeId: container.worktreeId,
              }),
            )
          : [],
      ),
    callerBindings: bindings,
    eligibility: new LedgerOwnerEligibility(),
  });
  const dispatcher = createDesktopRuntime({
    services: {
      listFileTreeRoots: (): Promise<{ roots: [] }> =>
        Promise.resolve({ roots: [] }),
      listFileTreeDirectory: (): Promise<{ entries: [] }> =>
        Promise.resolve({ entries: [] }),
    },
    ledgerService: service,
  });
  const host: LedgerToolsHost = {
    dispatcher: (): LedgerToolsDispatcher => dispatcher,
    registry: (): LedgerCallerBindingRegistry => bindings,
    isFlagEnabled: (): boolean => true,
    isRecordingEnabled: (): Promise<boolean> => Promise.resolve(true),
    workspaceType: (): WorkspaceType => 'single-repo',
    containerCreatedAt: (): Promise<string> =>
      Promise.resolve(TEST_CONTAINER_CREATED_AT),
    chatTitle: (): Promise<string> => Promise.resolve('Chat one'),
    databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
  };
  const runs: RunControl[] = [];
  const waiters: { key: string; resolve: (run: RunControl) => void }[] = [];
  const runKey = (delegationId: string, runGeneration: number): string =>
    `${delegationId}:${String(runGeneration)}`;
  const runner = new LocalDelegationRunner(
    'claude',
    'claude-sdk',
    () => Promise.resolve({ available: true }),
    async (context) => {
      // What the host's per-run hook does: the run's own Ledger tools, with
      // the lineage the broker keeps, revoked when the run ends.
      const tools = await openChildLedgerTools(context.request, {
        isLive: (): boolean => !context.signal.aborted,
        lineage: brokerRef.current?.delegationLineage(
          context.request.delegationId,
        ),
        host,
      });
      if (tools !== null)
        context.retain(() => {
          tools.dispose();
          return Promise.resolve();
        });
      await context.emit({ type: 'started', nativeSessionId: 'native-1' });
      let finish: () => void = () => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const run: RunControl = { request: context.request, tools, finish };
      runs.push(run);
      const key = runKey(
        context.request.delegationId,
        context.request.runGeneration,
      );
      for (const waiter of waiters.filter((entry) => entry.key === key))
        waiter.resolve(run);
      await Promise.race([
        finished,
        new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }),
      ]);
      return { status: 'completed', finalText: 'Done' };
    },
    (): void => undefined,
  );
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'local-delegation-claude-v1',
    adapter: runner,
  });
  const broker = new AgentDelegationBroker({
    storage,
    registry,
    cwd: '/worktree',
    capacity: 4,
    resolveRoute: (): Promise<{ ok: true; value: typeof ROUTE }> =>
      Promise.resolve({ ok: true, value: ROUTE }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
    ...overrides,
  });
  brokerRef.current = broker;
  return {
    broker,
    bindings,
    registered,
    service,
    runs,
    waitForRun: (delegationId, runGeneration): Promise<RunControl> => {
      const found = runs.find(
        (run) =>
          run.request.delegationId === delegationId &&
          run.request.runGeneration === runGeneration,
      );
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => {
        waiters.push({ key: runKey(delegationId, runGeneration), resolve });
      });
    },
    stop: async (): Promise<void> => {
      await broker.close();
      await dispatcher.shutdown();
    },
  };
}

function userContext(
  principalId: string,
  idempotencyKey?: string,
): CanopyHandlerContext {
  const caller: CanopyCallerDescriptor = {
    principalId,
    clientInstanceId: 'test-client',
    authorityId: 'test-authority',
    interfaceKind: 'test',
    grants: [...ALL_LEDGER_GRANTS],
  };
  return {
    requestId: 'test-request',
    caller,
    metadata: idempotencyKey === undefined ? {} : { idempotencyKey },
    signal: new AbortController().signal,
  };
}

function registerUser(process: DesktopProcess): string {
  return process.bindings.register({
    container: TEST_CONTAINER,
    containerCreatedAt: TEST_CONTAINER_CREATED_AT,
    actor: { kind: 'user', originKey: 'local', displayName: 'You' },
    role: 'user',
    authorDetails: USER_DETAILS,
    runtimeGeneration: 1,
  });
}

function entryIdOf(result: CanopyInjectedToolTextResult): string {
  const parsed: unknown = JSON.parse(result.text);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('entry' in parsed) ||
    typeof parsed.entry !== 'object' ||
    parsed.entry === null ||
    !('entryId' in parsed.entry) ||
    typeof parsed.entry.entryId !== 'string'
  )
    throw new Error(`Expected an entry, got ${result.text}`);
  return parsed.entry.entryId;
}

function entryIdsOf(result: unknown): string[] {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('entries' in result) ||
    !Array.isArray(result.entries)
  )
    throw new Error('Expected a search result');
  return result.entries.flatMap((entry: unknown): string[] =>
    typeof entry === 'object' &&
    entry !== null &&
    'entryId' in entry &&
    typeof entry.entryId === 'string'
      ? [entry.entryId]
      : [],
  );
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe('delegate Ledger bindings across an app restart', () => {
  let store: LedgerStoreFixture;
  let storage: MemoryStorage;
  const processes: DesktopProcess[] = [];

  beforeEach(() => {
    store = createLedgerStoreFixture();
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    for (const process of processes.splice(0)) {
      for (const run of process.runs) run.finish();
      await process.stop();
    }
    store.dispose();
  });

  function start(overrides: BrokerOverrides = {}): DesktopProcess {
    const process = startProcess(store, storage, overrides);
    processes.push(process);
    return process;
  }

  it('registers a binding only for a live run generation, and revokes it when the run ends', async () => {
    const app = start();
    await app.broker.initialize();
    const spawned = await app.broker.spawn(ROOT, TASK);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;

    const run = await app.waitForRun(id, 1);
    if (run.tools === null) throw new Error('Expected Ledger tools');
    const added = await run.tools.execute('add_ledger_entry', {
      type: 'TASK',
      title: 'Delegated task',
      content: 'Owned by the delegate.',
    });

    expect(
      app.registered.map(({ registration }) => [
        registration.role,
        registration.actor.originKey,
        registration.runtimeGeneration,
      ]),
    ).toEqual([['managed_delegation', id, 1]]);
    const bindingId = app.registered[0]?.id ?? '';
    const detail = await app.service.getEntry(
      { entryId: entryIdOf(added) },
      userContext(registerUser(app)),
    );
    expect(detail.entry.origin).toMatchObject({
      kind: 'managed_delegation',
      delegationId: id,
      root: { kind: 'chat', chatId: 'chat-1' },
      runGeneration: 1,
    });

    run.finish();
    await eventually(() => app.bindings.resolve(bindingId) === undefined);
    await expect(
      run.tools.execute('search_ledger_entries', {}),
    ).resolves.toMatchObject({ isError: true });
  });

  it('keeps no binding across a restart and registers one again only for the next live generation', async () => {
    const before = start();
    await before.broker.initialize();
    const spawned = await before.broker.spawn(ROOT, TASK);
    if (!spawned.ok) throw new Error('Expected admission');
    const id = spawned.value.delegationId;
    const firstRun = await before.waitForRun(id, 1);
    if (firstRun.tools === null) throw new Error('Expected Ledger tools');
    const firstEntryId = entryIdOf(
      await firstRun.tools.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'Before the restart',
        content: 'Recorded by the first run.',
      }),
    );
    const staleBindingId = before.registered[0]?.id ?? '';

    // The app restarts while the run is live: a new process over the same
    // Ledger database and delegation registry.
    const after = start();
    await after.broker.initialize();
    const parent: DelegationParentContext = {
      ...ROOT,
      runtimeGeneration: 2,
      turnId: 'turn-2',
      toolCallId: 'follow-up-call',
    };

    expect(after.broker.inspect(parent, id)).toMatchObject({
      status: 'interrupted',
    });
    expect(after.registered).toEqual([]);
    await expect(
      after.service.searchEntries({}, userContext(staleBindingId)),
    ).rejects.toMatchObject({
      payload: { details: { reason: 'FORBIDDEN' } },
    });

    // The retained delegate is offered as an owner under the same actor.
    // Assigning it an entry records responsibility and starts nothing.
    const user = registerUser(after);
    const listed = (
      await after.service.listOwners({}, userContext(user))
    ).candidates.find(
      (candidate) => candidate.actor.kind === 'managed_delegation',
    );
    if (listed === undefined) throw new Error('Expected the retained delegate');
    const firstEntry = await after.service.getEntry(
      { entryId: firstEntryId },
      userContext(user),
    );
    expect(listed.actor).toEqual(firstEntry.entry.author);
    const assign = (
      owner: LedgerOwnerCandidate,
      key: string,
    ): ReturnType<LedgerCoreService['addEntry']> =>
      after.service.addEntry(
        {
          type: 'TASK',
          title: 'Assigned while retained',
          content: 'Pick this up on the next run.',
          owner: {
            actorId: owner.actor.actorId,
            eligibilityToken: owner.eligibilityToken,
          },
          _meta: { idempotencyKey: key },
        },
        userContext(user, key),
      );
    const assigned = await assign(listed, 'assign');
    expect(assigned.entry.owner).toEqual(listed.actor);
    expect(after.runs).toEqual([]);

    // The chat follows up: the next generation is live and binds again.
    await after.broker.message(parent, {
      delegationId: id,
      operation: 'follow_up',
      message: 'Continue the review.',
    });
    const secondRun = await after.waitForRun(id, 2);
    if (secondRun.tools === null) throw new Error('Expected Ledger tools');
    // Like a chat's, the run's binding is registered on its first call.
    const mine: unknown = JSON.parse(
      (
        await secondRun.tools.execute('search_ledger_entries', {
          owner: 'self',
        })
      ).text,
    );

    expect(
      after.registered.map(({ registration }) => [
        registration.role,
        registration.runtimeGeneration,
        registration.origin?.kind === 'managed_delegation'
          ? registration.origin.runGeneration
          : null,
      ]),
    ).toEqual([
      ['user', 1, null],
      ['managed_delegation', 2, 2],
    ]);
    expect(entryIdsOf(mine)).toEqual(
      expect.arrayContaining([assigned.entry.entryId, firstEntryId]),
    );
    // A picker token from before the follow-up is stale.
    await expect(assign(listed, 'stale')).rejects.toMatchObject({
      payload: { details: { reason: 'OWNER_UNAVAILABLE' } },
    });
  });

  it('names the parent delegate in a nested follow-up after the root session is recreated', async () => {
    let liveRoot: DelegationParentContext = ROOT;
    const app = start({
      maxDepthForParent: (): number => 2,
      resolveHostParent: (): DelegationParentContext => liveRoot,
    });
    await app.broker.initialize();
    const spawned = await app.broker.spawn(ROOT, {
      ...TASK,
      description: 'Parent delegate',
      allowNestedDelegation: true,
    });
    if (!spawned.ok) throw new Error('Expected admission');
    const parentRun = await app.waitForRun(spawned.value.delegationId, 1);
    const nestedCaller = app.broker.childContext(
      parentRun.request,
      'nested-spawn-call',
    );
    if (nestedCaller === undefined) throw new Error('Expected a nested caller');
    const nested = await app.broker.spawn(nestedCaller, {
      ...TASK,
      description: 'Nested delegate',
    });
    if (!nested.ok) throw new Error('Expected nested admission');
    const id = nested.value.delegationId;
    const firstRun = await app.waitForRun(id, 1);
    if (parentRun.tools === null || firstRun.tools === null)
      throw new Error('Expected Ledger tools');
    const parentEntryId = entryIdOf(
      await parentRun.tools.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'Split the review',
        content: 'Recorded by the parent delegate.',
      }),
    );
    const firstEntryId = entryIdOf(
      await firstRun.tools.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'Before the follow-up',
        content: 'Recorded by the nested delegate.',
      }),
    );
    firstRun.finish();
    await eventually(() => app.broker.activeCount(ROOT) === 1);

    // The root session is recreated, and a host message continues the nested
    // delegate: its next run is requested by the recreated root session.
    liveRoot = { ...ROOT, runtimeGeneration: 2, turnId: 'turn-2' };
    expect(
      await app.broker.deliverHostMessage(id, 'Continue the review.'),
    ).toMatchObject({ ok: true });
    const secondRun = await app.waitForRun(id, 2);
    if (secondRun.tools === null) throw new Error('Expected Ledger tools');
    const secondEntryId = entryIdOf(
      await secondRun.tools.execute('add_ledger_entry', {
        type: 'TASK',
        title: 'After the follow-up',
        content: 'Recorded by the nested delegate again.',
      }),
    );

    expect(secondRun.request.parent).toMatchObject({
      runtimeGeneration: 2,
      depth: 0,
    });
    expect(secondRun.request.parent.parentDelegationId).toBeUndefined();
    const user = registerUser(app);
    const detail = (
      entryId: string,
    ): ReturnType<LedgerCoreService['getEntry']> =>
      app.service.getEntry({ entryId }, userContext(user));
    const [parentEntry, first, second] = await Promise.all([
      detail(parentEntryId),
      detail(firstEntryId),
      detail(secondEntryId),
    ]);
    const parentActorId = parentEntry.entry.author.actorId;
    expect(first.entry.origin).toMatchObject({
      parentActorId,
      runGeneration: 1,
    });
    expect(second.entry.origin).toEqual({
      kind: 'managed_delegation',
      ledgerId: second.entry.scope.ledgerId,
      delegationId: id,
      parentActorId,
      root: { kind: 'chat', chatId: 'chat-1' },
      runGeneration: 2,
    });
  });
});
