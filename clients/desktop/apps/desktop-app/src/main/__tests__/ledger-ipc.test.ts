import type {
  CanopyCallerDescriptor,
  LedgerCommandReceipt,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewChangedEvent,
  LedgerViewScope,
  LedgerViewSource,
} from '@canopy/protocol/ledger-view';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  LEDGER_CHANGE_BROADCAST_INTERVAL_MS,
  addLedgerEntryForView,
  createLedgerChangeBroadcaster,
  getLedgerEntryForView,
  getLedgerFeedEntryForView,
  searchLedgerFeedForView,
  listLedgerOwnersForView,
  searchLedgerEntriesForView,
  updateLedgerEntryForView,
  type LedgerIpcHost,
} from '../ipc/ledger';
import type { LedgerCallerBindingRegistration } from '../ledger/caller-bindings';
import { resolveArchivedLedgerContainerCreatedAt } from '../ledger/scope-bindings';
import { LedgerFeedService } from '../ledger/feed-service';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../ledger/__tests__/fixtures/in-process-ledger-store-client';

const filesystemServices = {
  listFileTreeRoots: (): Promise<{ roots: [] }> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<{ entries: [] }> =>
    Promise.resolve({ entries: [] }),
};

// The harness binds TEST_CONTAINER: worktree-1 of workspace-1.
const SCOPE: LedgerViewScope = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
};

/** The caller main derives for a trusted renderer window. */
const IPC_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:7',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read'],
};

const USER_ACTOR: unknown = expect.objectContaining({ kind: 'user' });
const ANY_STRING: unknown = expect.any(String);

const CHAT_SOURCE: LedgerViewSource = {
  availability: 'available',
  target: {
    kind: 'chat',
    projectId: SCOPE.projectId,
    worktreeId: SCOPE.worktreeId,
    chatId: 'chat-1',
    archived: false,
  },
};

describe('Ledger panel IPC', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let registered: LedgerCallerBindingRegistration[];
  let bindingIds: string[];
  let databaseMayExist: boolean;

  function host(overrides: Partial<LedgerIpcHost> = {}): LedgerIpcHost {
    return {
      isEnabled: (): boolean => harness.enabled,
      databaseMayExist: (): Promise<boolean> =>
        Promise.resolve(databaseMayExist),
      registry: () => ({
        register: (registration: LedgerCallerBindingRegistration): string => {
          registered.push(registration);
          const bindingId = harness.bindings.register(registration);
          bindingIds.push(bindingId);
          return bindingId;
        },
        revoke: (bindingId: string): boolean =>
          harness.bindings.revoke(bindingId),
      }),
      container: (scope) =>
        scope.projectId === SCOPE.projectId &&
        scope.worktreeId === SCOPE.worktreeId
          ? TEST_CONTAINER
          : null,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(TEST_CONTAINER_CREATED_AT),
      archivedContainerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(null),
      resolveSource: (): Promise<LedgerViewSource> =>
        Promise.resolve(CHAT_SOURCE),
      ...overrides,
    };
  }

  /** Adds a task as the harness chat, "Chat one". */
  function addTask(key: string, title: string): Promise<LedgerCommandReceipt> {
    return harness.service.addEntry(
      {
        type: 'TASK',
        title,
        content: `${title} in detail.`,
        _meta: { idempotencyKey: key },
      },
      harness.context(harness.register(), key),
    );
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
    registered = [];
    bindingIds = [];
    databaseMayExist = true;
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  it('reads a page as the local user, with actor labels, and revokes the binding after', async () => {
    const { entry } = await addTask('ipc-add', 'Plan the storage work');

    const result = await searchLedgerEntriesForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, params: { query: 'storage' } },
      host(),
    );

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        entries: [{ entryId: entry.entryId, title: 'Plan the storage work' }],
        actors: [
          {
            actorId: entry.author.actorId,
            kind: 'chat',
            displayName: 'Chat one',
          },
        ],
      },
    });
    // One read-only user binding for exactly this read.
    expect(registered).toEqual([
      expect.objectContaining({
        container: TEST_CONTAINER,
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        role: 'user',
        actor: USER_ACTOR,
      }),
    ]);
    expect(bindingIds.map((id) => harness.bindings.resolve(id))).toEqual([
      undefined,
    ]);
  });

  it('reads nothing while the Ledger is off', async () => {
    harness.enabled = false;

    await expect(
      searchLedgerEntriesForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, params: {} },
        host(),
      ),
    ).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(harness.storeRequests()).toBe(0);
  });

  it.each([
    ['has no Ledger container', { container: (): null => null }],
    [
      'no longer exists',
      { containerCreatedAt: (): Promise<null> => Promise.resolve(null) },
    ],
  ])('reports a scope that %s', async (_case, overrides) => {
    await expect(
      searchLedgerEntriesForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, params: {} },
        host(overrides),
      ),
    ).resolves.toEqual({ status: 'unavailable', reason: 'no_scope' });
    expect(registered).toEqual([]);
  });

  it('answers an empty page without creating a Ledger that was never used', async () => {
    databaseMayExist = false;

    await expect(
      searchLedgerEntriesForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, params: {} },
        host(),
      ),
    ).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [],
        nextCursor: null,
        hasMore: false,
        watermark: '0',
        actors: [],
      },
    });
    await expect(
      getLedgerEntryForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, entryId: '00000000-0000-4000-8000-0000000000aa' },
        host(),
      ),
    ).resolves.toMatchObject({ status: 'error', reason: 'NOT_FOUND' });
    expect(harness.storeRequests()).toBe(0);
  });

  it.each([
    ['an unsafe scope ID', { scope: { projectId: '../x', worktreeId: 'wt' } }],
    ['a missing scope', { params: {} }],
    ['an invalid search', { scope: SCOPE, params: { limit: 0 } }],
    ['no request', null],
  ])('refuses %s without reading', async (_case, request) => {
    await expect(
      searchLedgerEntriesForView(dispatcher, IPC_CALLER, request, host()),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    expect(registered).toEqual([]);
  });

  it('returns an entry with its history and source, and keeps reading when the source cannot be checked', async () => {
    const { entry } = await addTask('ipc-get', 'Plan the storage work');

    const read = await getLedgerEntryForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, entryId: entry.entryId },
      host(),
    );
    expect(read).toMatchObject({
      status: 'ok',
      value: {
        entry: {
          entry: { entryId: entry.entryId },
          history: { mutations: [{ kind: 'create', revision: 1 }] },
        },
        source: CHAT_SOURCE,
      },
    });

    const unchecked = await getLedgerEntryForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, entryId: entry.entryId },
      host({
        resolveSource: (): Promise<LedgerViewSource> =>
          Promise.reject(new Error('unreadable')),
      }),
    );
    expect(unchecked).toMatchObject({ status: 'ok', value: { source: null } });
  });

  it('reports a Ledger error by its reason, never as an empty result', async () => {
    await addTask('ipc-error', 'Plan the storage work');

    await expect(
      getLedgerEntryForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, entryId: '00000000-0000-4000-8000-0000000000bb' },
        host(),
      ),
    ).resolves.toMatchObject({
      status: 'error',
      reason: 'NOT_FOUND',
      message: ANY_STRING,
    });
  });
});

describe('Ledger panel IPC writes', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let registered: LedgerCallerBindingRegistration[];
  let bindingIds: string[];

  function host(): LedgerIpcHost {
    return {
      isEnabled: (): boolean => harness.enabled,
      // Writes never ask: they create the Ledger on first use.
      databaseMayExist: (): Promise<boolean> => Promise.resolve(false),
      registry: () => ({
        register: (registration: LedgerCallerBindingRegistration): string => {
          registered.push(registration);
          const bindingId = harness.bindings.register(registration);
          bindingIds.push(bindingId);
          return bindingId;
        },
        revoke: (bindingId: string): boolean =>
          harness.bindings.revoke(bindingId),
      }),
      container: () => TEST_CONTAINER,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(TEST_CONTAINER_CREATED_AT),
      archivedContainerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(null),
      resolveSource: (): Promise<LedgerViewSource> =>
        Promise.resolve(CHAT_SOURCE),
    };
  }

  function addAsUser(
    requestKey: string,
    params: Record<string, unknown>,
  ): ReturnType<typeof addLedgerEntryForView> {
    return addLedgerEntryForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, requestKey, params },
      host(),
    );
  }

  function updateAsUser(
    requestKey: string,
    params: Record<string, unknown>,
  ): ReturnType<typeof updateLedgerEntryForView> {
    return updateLedgerEntryForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, requestKey, params },
      host(),
    );
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
    registered = [];
    bindingIds = [];
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  it('adds an entry as the person, owned by them, and returns the first receipt when the draft is retried', async () => {
    const params = {
      type: 'TASK',
      title: 'Write the release notes',
      content: 'Cover the Ledger panel.',
    };

    const first = await addAsUser('draft-1', params);
    if (first.status !== 'ok') throw new Error('Expected a receipt');
    expect(first.value.changed).toBe(true);
    expect(first.value.entry).toMatchObject({
      title: 'Write the release notes',
      author: USER_ACTOR,
      owner: first.value.entry.author,
      origin: { kind: 'user' },
    });
    // A user binding for exactly this write, revoked after.
    expect(registered).toEqual([
      expect.objectContaining({ role: 'user', actor: USER_ACTOR }),
    ]);
    expect(bindingIds.map((id) => harness.bindings.resolve(id))).toEqual([
      undefined,
    ]);

    // An unknown outcome is retried with the same key: still one entry.
    const retried = await addAsUser('draft-1', params);
    expect(retried).toMatchObject({
      status: 'ok',
      value: { entry: { entryId: first.value.entry.entryId } },
    });
    const page = await searchLedgerEntriesForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE, params: {} },
      // The first write created the database.
      {
        ...host(),
        databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
      },
    );
    expect(page).toMatchObject({ status: 'ok', value: { entries: [{}] } });
  });

  it('changes status from the current revision, and refuses a stale revision and a terminal entry', async () => {
    const added = await addAsUser('draft-2', {
      type: 'TASK',
      title: 'Update parser recovery',
      content: 'Preserve incomplete events.',
    });
    if (added.status !== 'ok') throw new Error('Expected a receipt');
    const { entryId } = added.value.entry;

    await expect(
      updateAsUser('start', {
        entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { entry: { revision: 2, status: 'IN_PROGRESS' } },
    });
    await expect(
      updateAsUser('stale', {
        entryId,
        expectedRevision: 1,
        status: 'BLOCKED',
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'REVISION_CONFLICT' });

    await expect(
      updateAsUser('done', {
        entryId,
        expectedRevision: 2,
        status: 'COMPLETED',
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { entry: { revision: 3, status: 'COMPLETED' } },
    });
    await expect(
      updateAsUser('reopen', {
        entryId,
        expectedRevision: 3,
        status: 'IN_PROGRESS',
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'TERMINAL_ENTRY' });
  });

  it('lists owners with the person first and a paused pipeline agent exactly, and refuses its token once the run resumes', async () => {
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
    ]);
    harness.pipelineAgents.notePaused({
      agentSessionId: 'session-review',
      displayName: 'Review changes · Release checks',
      executionId: 'execution-1',
      jobId: 'review',
      stepId: 'agent',
      attempt: 1,
      container: TEST_CONTAINER,
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-30T10:00:00.000Z',
    });
    const added = await addAsUser('draft-3', {
      type: 'TASK',
      title: 'Triage the flaky tests',
      content: 'Two parser tests fail on retry.',
    });
    if (added.status !== 'ok') throw new Error('Expected a receipt');

    const owners = await listLedgerOwnersForView(
      dispatcher,
      IPC_CALLER,
      { scope: SCOPE },
      host(),
    );
    if (owners.status !== 'ok') throw new Error('Expected owners');
    expect(
      owners.value.candidates.map((candidate) => [
        candidate.actor.kind,
        candidate.displayName,
        candidate.isSelf,
      ]),
    ).toEqual([
      ['user', 'You', true],
      ['chat', 'Chat one', false],
      ['pipeline_agent', 'Review changes · Release checks', false],
    ]);
    const chat = owners.value.candidates[1];
    const agent = owners.value.candidates[2];
    if (chat === undefined || agent === undefined) {
      throw new Error('Expected candidates');
    }
    expect(agent.pipelineAgent).toEqual({
      executionId: 'execution-1',
      jobId: 'review',
      stepId: 'agent',
      attempt: 1,
      checkpointId: 'checkpoint-1',
      pausedAt: '2026-09-30T10:00:00.000Z',
    });

    // Assigning the chat keeps the person as the author.
    const assigned = await updateAsUser('assign-chat', {
      entryId: added.value.entry.entryId,
      expectedRevision: 1,
      owner: {
        actorId: chat.actor.actorId,
        eligibilityToken: chat.eligibilityToken,
      },
    });
    expect(assigned).toMatchObject({
      status: 'ok',
      value: {
        entry: {
          revision: 2,
          owner: { actorId: chat.actor.actorId },
          author: USER_ACTOR,
        },
      },
    });

    // A picker opened before the run resumed cannot assign its agent after.
    harness.pipelineAgents.retireExecution('execution-1');
    await expect(
      updateAsUser('assign-agent', {
        entryId: added.value.entry.entryId,
        expectedRevision: 2,
        owner: {
          actorId: agent.actor.actorId,
          eligibilityToken: agent.eligibilityToken,
        },
      }),
    ).resolves.toMatchObject({ status: 'error', reason: 'OWNER_UNAVAILABLE' });
  });

  it.each([
    ['no request key', { scope: SCOPE, params: {} }],
    [
      'an invalid entry',
      { scope: SCOPE, requestKey: 'draft-4', params: { type: 'SUMMARY' } },
    ],
    ['no request', null],
  ])('refuses %s without writing', async (_case, request) => {
    await expect(
      addLedgerEntryForView(dispatcher, IPC_CALLER, request, host()),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    expect(registered).toEqual([]);
  });

  it('writes nothing while the Ledger is off', async () => {
    harness.enabled = false;

    await expect(
      addAsUser('draft-5', {
        type: 'TASK',
        title: 'Write the release notes',
        content: 'Cover the Ledger panel.',
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });
    await expect(
      listLedgerOwnersForView(dispatcher, IPC_CALLER, { scope: SCOPE }, host()),
    ).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });
    expect(harness.storeRequests()).toBe(0);
  });
});

describe('createLedgerChangeBroadcaster', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends one event per interval, each entry once at its latest revision', () => {
    const sent: LedgerViewChangedEvent[] = [];
    const broadcaster = createLedgerChangeBroadcaster((event) => {
      sent.push(event);
    });

    broadcaster.push({ scope: SCOPE, entryId: 'entry-1', revision: 1 });
    broadcaster.push({ scope: SCOPE, entryId: 'entry-1', revision: 2 });
    broadcaster.push({ scope: SCOPE, entryId: 'entry-2', revision: 1 });
    jest.advanceTimersByTime(LEDGER_CHANGE_BROADCAST_INTERVAL_MS - 1);
    expect(sent).toEqual([]);
    jest.advanceTimersByTime(1);

    expect(sent).toEqual([
      {
        changes: [
          { scope: SCOPE, entryId: 'entry-1', revision: 2 },
          { scope: SCOPE, entryId: 'entry-2', revision: 1 },
        ],
      },
    ]);

    broadcaster.push({ scope: SCOPE, entryId: 'entry-3', revision: 1 });
    broadcaster.dispose();
    jest.advanceTimersByTime(LEDGER_CHANGE_BROADCAST_INTERVAL_MS);
    expect(sent).toHaveLength(1);
  });

  it('carries each scope whose sync changed once, or every scope', () => {
    const sent: LedgerViewChangedEvent[] = [];
    const broadcaster = createLedgerChangeBroadcaster((event) => {
      sent.push(event);
    });
    const other: LedgerViewScope = {
      projectId: 'workspace-1',
      worktreeId: 'worktree-2',
    };

    broadcaster.pushSyncChange(SCOPE);
    broadcaster.pushSyncChange({ ...SCOPE });
    broadcaster.pushSyncChange(other);
    jest.advanceTimersByTime(LEDGER_CHANGE_BROADCAST_INTERVAL_MS);
    broadcaster.push({ scope: SCOPE, entryId: 'entry-1', revision: 1 });
    broadcaster.pushSyncChange(SCOPE);
    broadcaster.pushSyncChange('all');
    jest.advanceTimersByTime(LEDGER_CHANGE_BROADCAST_INTERVAL_MS);

    expect(sent).toEqual([
      { changes: [], syncChanged: [SCOPE, other] },
      {
        changes: [{ scope: SCOPE, entryId: 'entry-1', revision: 1 }],
        syncChanged: 'all',
      },
    ]);
    broadcaster.dispose();
  });
});

describe('Ledger Feed IPC', () => {
  const FEED_REQUEST = {
    audience: 'mine',
    query: '',
    filters: {
      types: [],
      statuses: [],
      owner: 'anyone',
      author: 'anyone',
      period: 'any',
      includeArchived: false,
    },
  };

  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let bindingIds: string[];

  function host(): LedgerIpcHost {
    return {
      isEnabled: (): boolean => harness.enabled,
      databaseMayExist: (): Promise<boolean> => Promise.resolve(true),
      registry: () => ({
        register: (registration: LedgerCallerBindingRegistration): string => {
          const bindingId = harness.bindings.register(registration);
          bindingIds.push(bindingId);
          return bindingId;
        },
        revoke: (bindingId: string): boolean =>
          harness.bindings.revoke(bindingId),
      }),
      container: (scope) =>
        scope.projectId === SCOPE.projectId &&
        scope.worktreeId === SCOPE.worktreeId
          ? TEST_CONTAINER
          : null,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(TEST_CONTAINER_CREATED_AT),
      archivedContainerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(null),
      resolveSource: (): Promise<LedgerViewSource> =>
        Promise.resolve(CHAT_SOURCE),
    };
  }

  /** The Feed over the harness store, with the cloud out of reach. */
  function feed(): LedgerFeedService {
    return new LedgerFeedService({
      readAccount: () =>
        Promise.resolve({ kind: 'signed_in', accountId: 'account-1' }),
      listScopes: async () =>
        (await harness.store.client.listSyncScopes()).map((record) => ({
          ledgerId: record.scope.scope.ledgerId,
          accountId: record.scope.accountId,
          container: record.scope.scope.container,
          containerCreatedAt: record.scope.containerCreatedAt,
          archived: record.scope.lifecycleState === 'archived',
        })),
      viewScope: () => SCOPE,
      mirror: {
        search: () => Promise.resolve({ ok: false, failure: 'unavailable' }),
        getEntry: () => Promise.resolve({ ok: false, failure: 'unavailable' }),
      },
    });
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
    bindingIds = [];
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  it("reads this device's scopes through the dispatcher as the local user", async () => {
    const receipt = await harness.service.addEntry(
      {
        type: 'TASK',
        title: 'Plan the storage work',
        content: 'In detail.',
        _meta: { idempotencyKey: 'feed-ipc-add' },
      },
      harness.context(harness.register(), 'feed-ipc-add'),
    );

    const result = await searchLedgerFeedForView(
      feed(),
      dispatcher,
      IPC_CALLER,
      FEED_REQUEST,
      host(),
    );

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        rows: [
          {
            entry: { entryId: receipt.entry.entryId },
            origin: { kind: 'this_device', scope: SCOPE },
          },
        ],
        notice: 'remote_unavailable',
      },
    });
    // One binding for the one scope, revoked once it was read.
    expect(bindingIds).toHaveLength(1);
    expect(harness.bindings.resolve(bindingIds[0] ?? '')).toBeUndefined();
  });

  it("shows an archived worktree's entries, whose registry row is gone, when archived ones are included", async () => {
    const receipt = await harness.service.addEntry(
      {
        type: 'TASK',
        title: 'Plan the storage work',
        content: 'In detail.',
        _meta: { idempotencyKey: 'feed-ipc-archived' },
      },
      harness.context(harness.register(), 'feed-ipc-archived'),
    );
    const [record] = await harness.store.client.listSyncScopes();
    if (record === undefined) throw new Error('Expected a scope');
    await harness.store.client.setScopeLifecycle({
      ledgerId: record.scope.scope.ledgerId,
      state: 'archived',
    });
    // Archiving removed the worktree from `worktrees.json`.
    const archivedHost: LedgerIpcHost = {
      ...host(),
      containerCreatedAt: (): Promise<null> => Promise.resolve(null),
      archivedContainerCreatedAt: (container) =>
        resolveArchivedLedgerContainerCreatedAt(
          container,
          harness.store.client,
        ),
    };

    const result = await searchLedgerFeedForView(
      feed(),
      dispatcher,
      IPC_CALLER,
      {
        ...FEED_REQUEST,
        filters: { ...FEED_REQUEST.filters, includeArchived: true },
      },
      archivedHost,
    );

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        rows: [
          {
            entry: { entryId: receipt.entry.entryId },
            scopeArchived: true,
            origin: { kind: 'this_device', scope: SCOPE },
          },
        ],
      },
    });
    expect(bindingIds).toHaveLength(1);
    expect(harness.bindings.resolve(bindingIds[0] ?? '')).toBeUndefined();

    // Selecting the row opens its detail, read through the same incarnation.
    await expect(
      getLedgerEntryForView(
        dispatcher,
        IPC_CALLER,
        { scope: SCOPE, entryId: receipt.entry.entryId },
        archivedHost,
      ),
    ).resolves.toMatchObject({
      status: 'ok',
      value: { entry: { entry: { entryId: receipt.entry.entryId } } },
    });
    // Writes still need the live container.
    await expect(
      updateLedgerEntryForView(
        dispatcher,
        IPC_CALLER,
        {
          scope: SCOPE,
          requestKey: 'archived-update',
          params: {
            entryId: receipt.entry.entryId,
            expectedRevision: 1,
            status: 'COMPLETED',
          },
        },
        archivedHost,
      ),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'no_scope' });
  });

  it('refuses while the Ledger is off, and a request it does not know', async () => {
    harness.enabled = false;
    await expect(
      searchLedgerFeedForView(
        feed(),
        dispatcher,
        IPC_CALLER,
        FEED_REQUEST,
        host(),
      ),
    ).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });
    await expect(
      getLedgerFeedEntryForView(feed(), { entryId: 'x' }, host()),
    ).resolves.toEqual({ status: 'unavailable', reason: 'disabled' });

    harness.enabled = true;
    await expect(
      searchLedgerFeedForView(
        feed(),
        dispatcher,
        IPC_CALLER,
        { ...FEED_REQUEST, audience: 'everyone' },
        host(),
      ),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
    await expect(
      getLedgerFeedEntryForView(feed(), { entryId: 'not-an-id' }, host()),
    ).resolves.toMatchObject({ status: 'error', reason: 'INVALID_INPUT' });
  });
});
