import type * as FeatureFlagsModule from '../../feature-flags';
import type * as CloudAccountStoreModule from '../../lib/canopy-cloud-account-store';
import type * as ChatTabsReaderModule from '../../lib/chat-tabs-reader';
import type * as StorageClientModule from '../storage-client';

const mockGetLedgerStoreClient = jest.fn();
const mockIsFlagEnabled = jest.fn();
const mockReadAccount = jest.fn();
const mockReadChatTabsFile = jest.fn();

jest.mock('../storage-client', () => ({
  ...jest.requireActual<typeof StorageClientModule>('../storage-client'),
  getLedgerStoreClient: (): unknown => mockGetLedgerStoreClient(),
}));
jest.mock('../../feature-flags', () => ({
  ...jest.requireActual<typeof FeatureFlagsModule>('../../feature-flags'),
  getFeatureFlagService: (): { isEnabled: (key: string) => unknown } => ({
    isEnabled: (key: string): unknown => mockIsFlagEnabled(key),
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  ...jest.requireActual<typeof CloudAccountStoreModule>(
    '../../lib/canopy-cloud-account-store',
  ),
  readCanopyCloudAccountWithStatus: (): unknown => mockReadAccount(),
}));
jest.mock('../../lib/chat-tabs-reader', () => ({
  ...jest.requireActual<typeof ChatTabsReaderModule>(
    '../../lib/chat-tabs-reader',
  ),
  readChatTabsFile: (...args: unknown[]): unknown =>
    mockReadChatTabsFile(...args),
}));

import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_QUERY_DEFINITIONS,
  type CanopyGrantName,
  type LedgerEntryAddResult,
} from '@canopy/protocol/canopy-core';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { getLedgerCallerBindingRegistry } from '../caller-bindings';
import {
  createCoreLedgerInstructionHandlers,
  createCoreLedgerQueryHandlers,
  createDesktopLedgerService,
  getDesktopLedgerService,
} from '../core-ledger-adapter';
import type { LedgerService } from '../service';
import { LedgerStorageHostError } from '../storage-host';
import {
  CHAT_DETAILS,
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  createLedgerStoreFixture,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';

const FILESYSTEM_SERVICES = {
  listFileTreeRoots: (): Promise<{ roots: [] }> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<{ entries: [] }> =>
    Promise.resolve({ entries: [] }),
};

async function operationError(
  operation: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('Expected the operation to fail');
}

beforeEach(() => {
  mockGetLedgerStoreClient.mockReset();
  mockIsFlagEnabled.mockReset();
  mockIsFlagEnabled.mockReturnValue(true);
  mockReadAccount.mockReset();
  mockReadAccount.mockResolvedValue({ status: 'ok', entry: null });
  mockReadChatTabsFile.mockReset();
  mockReadChatTabsFile.mockResolvedValue({
    version: 1,
    activeTabId: '',
    tabs: [],
  });
});

describe('core ledger handler maps', () => {
  it('routes each operation to the matching service method', async () => {
    const calls: string[] = [];
    const record = (name: string) => (): Promise<never> => {
      calls.push(name);
      return Promise.reject(new Error(name));
    };
    const service: LedgerService = {
      searchEntries: record('searchEntries'),
      getEntry: record('getEntry'),
      listOwners: record('listOwners'),
      listChanges: record('listChanges'),
      addEntry: record('addEntry'),
      updateEntry: record('updateEntry'),
      publishSummary: record('publishSummary'),
    };
    const context: CanopyHandlerContext = {
      requestId: 'request-1',
      caller: {
        principalId: 'principal',
        clientInstanceId: 'client',
        authorityId: 'authority',
        interfaceKind: 'test',
        grants: [],
      },
      metadata: {},
      signal: new AbortController().signal,
    };
    const queries = createCoreLedgerQueryHandlers(service);
    const commands = createCoreLedgerInstructionHandlers(service);

    const outcomes = await Promise.allSettled([
      queries['core.ledger.entries.search']({}, context),
      queries['core.ledger.entry.get'](
        { entryId: '00000000-0000-4000-8000-000000000001' },
        context,
      ),
      queries['core.ledger.owners.list']({}, context),
      queries['core.ledger.changes.list']({ afterSequence: '0' }, context),
      commands['core.ledger.entry.add'](
        {
          type: 'TASK',
          title: 'Title',
          content: 'Content',
          _meta: { idempotencyKey: 'add-1' },
        },
        context,
      ),
      commands['core.ledger.entry.update'](
        {
          entryId: '00000000-0000-4000-8000-000000000001',
          expectedRevision: 1,
          status: 'BLOCKED',
          _meta: { idempotencyKey: 'update-1' },
        },
        context,
      ),
      commands['core.ledger.summary.publish'](
        {
          snapshotId: 'snapshot-1',
          generationId: 'generation-1',
          title: 'Summary',
          content: 'Summary text.',
          sourceTruncated: false,
          _meta: { idempotencyKey: 'summary-1' },
        },
        context,
      ),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(
      true,
    );
    expect(calls).toEqual([
      'searchEntries',
      'getEntry',
      'listOwners',
      'listChanges',
      'addEntry',
      'updateEntry',
      'publishSummary',
    ]);
    expect(Object.keys(queries).sort()).toEqual(
      Object.keys(CANOPY_QUERY_DEFINITIONS)
        .filter((name) => name.startsWith('core.ledger.'))
        .sort(),
    );
    expect(Object.keys(commands).sort()).toEqual(
      Object.keys(CANOPY_INSTRUCTION_DEFINITIONS)
        .filter((name) => name.startsWith('core.ledger.'))
        .sort(),
    );
  });
});

describe('core.ledger through the desktop dispatcher', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let chat: string;

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: FILESYSTEM_SERVICES,
      ledgerService: harness.service,
    });
    chat = harness.register();
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  function add(
    principal: string,
    key: string,
    title = 'Plan the storage work',
  ): Promise<LedgerEntryAddResult> {
    return dispatcher.instruction(
      'core.ledger.entry.add',
      {
        type: 'TASK',
        title,
        content: 'Write the plan.',
        _meta: { idempotencyKey: key },
      },
      {
        caller: harness.caller(principal),
        metadata: { idempotencyKey: key },
      },
    );
  }

  it('replays a keyed command to its original receipt', async () => {
    const first = await add(chat, 'add-1');
    const replay = await add(chat, 'add-1');

    expect(replay).toEqual(first);
    expect(harness.store.repository.getStorageCounts()).toMatchObject({
      entries: 1,
      receipts: 1,
    });
  });

  it('rejects a reused key with different input', async () => {
    await add(chat, 'add-1');

    const error = await operationError(add(chat, 'add-1', 'Another title'));

    expect(error.payload).toEqual({
      kind: 'conflict',
      message: 'The idempotency key was already used for a different request.',
      code: 'core.ledger.idempotencyKeyReused',
      details: { reason: 'IDEMPOTENCY_KEY_REUSED', field: 'idempotencyKey' },
      retry: { kind: 'never' },
    });
  });

  it('keeps two callers from sharing receipts under one key', async () => {
    const otherChat = harness.register({
      actor: { kind: 'chat', originKey: 'chat-2', displayName: 'Chat two' },
    });

    const mine = await add(chat, 'shared-key');
    const theirs = await add(otherChat, 'shared-key');

    expect(theirs.entry.entryId).not.toBe(mine.entry.entryId);
  });

  it('checks grants before the handler and the role inside it', async () => {
    const readOnly = await operationError(
      dispatcher.instruction(
        'core.ledger.entry.add',
        {
          type: 'TASK',
          title: 'Title',
          content: 'Content',
          _meta: { idempotencyKey: 'key-1' },
        },
        {
          caller: harness.caller(chat, ['core.ledger.read']),
          metadata: { idempotencyKey: 'key-1' },
        },
      ),
    );
    expect(readOnly.payload).toMatchObject({ kind: 'permission_denied' });
    expect(readOnly.payload.details).toBeUndefined();
    expect(harness.store.client.calls).toEqual([]);

    const publisher = harness.register({
      role: 'summary_publisher',
      actor: {
        kind: 'background',
        originKey: 'generation-1',
        displayName: 'Summary',
      },
    });
    const byRole = await operationError(add(publisher, 'key-2'));
    expect(byRole.payload).toMatchObject({
      kind: 'permission_denied',
      code: 'core.ledger.forbidden',
      details: { reason: 'FORBIDDEN' },
    });
  });

  it('requires instruction idempotency metadata before the handler runs', async () => {
    const error = await operationError(
      dispatcher.instruction(
        'core.ledger.entry.add',
        {
          type: 'TASK',
          title: 'Title',
          content: 'Content',
          _meta: { idempotencyKey: 'missing-metadata' },
        },
        { caller: harness.caller(chat) },
      ),
    );

    expect(error.payload.kind).toBe('invalid_argument');
    expect(harness.storeRequests()).toBe(0);
  });

  it('delivers typed Ledger errors intact through the error schemas', async () => {
    const { entry } = await add(chat, 'add-1');

    const conflict = await operationError(
      dispatcher.instruction(
        'core.ledger.entry.update',
        {
          entryId: entry.entryId,
          expectedRevision: 3,
          status: 'BLOCKED',
          _meta: { idempotencyKey: 'update-1' },
        },
        {
          caller: harness.caller(chat),
          metadata: { idempotencyKey: 'update-1' },
        },
      ),
    );
    harness.store.client.failNext(
      'searchEntries',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Busy'),
    );
    const queryUnavailable = await operationError(
      dispatcher.query(
        'core.ledger.entries.search',
        {},
        {
          caller: harness.caller(chat),
        },
      ),
    );
    const cursorExpired = await operationError(
      dispatcher.query(
        'core.ledger.entries.search',
        { cursor: 'not-a-cursor' },
        { caller: harness.caller(chat) },
      ),
    );
    harness.store.client.failNext(
      'updateEntry',
      new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Timed out'),
    );
    const commandUnavailable = await operationError(
      dispatcher.instruction(
        'core.ledger.entry.update',
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          status: 'BLOCKED',
          _meta: { idempotencyKey: 'update-2' },
        },
        {
          caller: harness.caller(chat),
          metadata: { idempotencyKey: 'update-2' },
        },
      ),
    );

    expect(conflict.payload).toMatchObject({
      kind: 'conflict',
      code: 'core.ledger.revisionConflict',
      details: { reason: 'REVISION_CONFLICT', currentEntry: entry },
      retry: { kind: 'after_refresh', resource: 'core.ledger.entry.get' },
    });
    expect(queryUnavailable.payload).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'same_request' },
    });
    expect(cursorExpired.payload).toMatchObject({
      kind: 'failed_precondition',
      code: 'core.ledger.cursorExpired',
      details: { reason: 'CURSOR_EXPIRED', field: 'cursor' },
      retry: {
        kind: 'after_refresh',
        resource: 'core.ledger.entries.search',
      },
    });
    expect(commandUnavailable.payload).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'same_idempotency_key' },
    });
  });

  it('returns results the dispatcher accepts, owners included', async () => {
    harness.setLiveChats(TEST_CONTAINER, [
      { chatId: 'chat-1', title: 'Chat one', createdAt: null },
    ]);
    const { entry } = await add(chat, 'add-1');

    const search = await dispatcher.query(
      'core.ledger.entries.search',
      { owner: 'self', includeAssignableOwners: true },
      { caller: harness.caller(chat) },
    );
    const got = await dispatcher.query(
      'core.ledger.entry.get',
      { entryId: entry.entryId, includeHistory: true },
      { caller: harness.caller(chat) },
    );
    const changes = await dispatcher.query(
      'core.ledger.changes.list',
      { afterSequence: '0' },
      { caller: harness.caller(chat) },
    );

    expect(search.entries.map((item) => item.entryId)).toEqual([entry.entryId]);
    expect(search.owners?.candidates.map((owner) => owner.isSelf)).toEqual([
      false,
      true,
    ]);
    expect(got.history?.mutations).toHaveLength(1);
    expect(changes.changes).toHaveLength(1);
  });
});

describe('desktop Ledger service wiring', () => {
  const allGrants: CanopyGrantName[] = [
    'core.ledger.read',
    'core.ledger.write',
    'core.ledger.publishSummary',
  ];

  it('creates nothing in storage until an operation needs it', () => {
    const service = createDesktopLedgerService();

    expect(service).toBeDefined();
    expect(getDesktopLedgerService()).toBe(getDesktopLedgerService());
    expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    expect(mockIsFlagEnabled).not.toHaveBeenCalled();
    expect(mockReadAccount).not.toHaveBeenCalled();
  });

  it('gates on canopy-ledger-enabled before asking for the store', async () => {
    mockIsFlagEnabled.mockReturnValue(false);
    const dispatcher = createDesktopRuntime({
      services: FILESYSTEM_SERVICES,
      ledgerService: createDesktopLedgerService(),
    });

    try {
      const error = await operationError(
        dispatcher.query(
          'core.ledger.entries.search',
          {},
          {
            caller: {
              principalId: 'anyone',
              clientInstanceId: 'client',
              authorityId: 'authority',
              interfaceKind: 'test',
              grants: allGrants,
            },
          },
        ),
      );

      expect(error.payload).toMatchObject({
        kind: 'capability_unavailable',
        details: { reason: 'WRITER_UNAVAILABLE' },
      });
      expect(mockIsFlagEnabled).toHaveBeenCalledWith(
        CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
      );
      expect(mockGetLedgerStoreClient).not.toHaveBeenCalled();
    } finally {
      await dispatcher.shutdown();
    }
  });

  it('binds scopes to the signed-in account and lists live chats as owners', async () => {
    const fixture = createLedgerStoreFixture();
    mockGetLedgerStoreClient.mockReturnValue(fixture.client);
    mockReadAccount.mockResolvedValue({
      status: 'ok',
      entry: { account: { id: ' account-7 ' } },
    });
    mockReadChatTabsFile.mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Live chat',
          messages: [],
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ],
    });
    const registry = getLedgerCallerBindingRegistry();
    const principal = registry.register({
      container: TEST_CONTAINER,
      containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      actor: { kind: 'chat', originKey: 'chat-1', displayName: 'Live chat' },
      role: 'interactive_chat',
      authorDetails: CHAT_DETAILS,
      runtimeGeneration: 1,
    });
    const dispatcher = createDesktopRuntime({
      services: FILESYSTEM_SERVICES,
      ledgerService: createDesktopLedgerService(),
    });
    const caller = {
      principalId: principal,
      clientInstanceId: 'client',
      authorityId: 'authority',
      interfaceKind: 'test' as const,
      grants: allGrants,
    };

    try {
      const owners = await dispatcher.query(
        'core.ledger.owners.list',
        {},
        { caller },
      );
      const added = await dispatcher.instruction(
        'core.ledger.entry.add',
        {
          type: 'TASK',
          title: 'Title',
          content: 'Content',
          _meta: { idempotencyKey: 'key-1' },
        },
        { caller, metadata: { idempotencyKey: 'key-1' } },
      );

      expect(owners.candidates.map((owner) => owner.displayName)).toEqual([
        'You',
        'Live chat',
      ]);
      expect(
        fixture.repository.getScope(added.entry.scope.ledgerId)?.accountId,
      ).toBe('account-7');
      expect(mockReadChatTabsFile).toHaveBeenCalledWith(
        'workspace-1',
        'worktree-1',
      );
    } finally {
      registry.revoke(principal);
      await dispatcher.shutdown();
      fixture.dispose();
    }
  });

  it('records no account when the account cannot be read', async () => {
    const fixture = createLedgerStoreFixture();
    mockGetLedgerStoreClient.mockReturnValue(fixture.client);
    mockReadAccount.mockResolvedValue({ status: 'unavailable' });
    const registry = getLedgerCallerBindingRegistry();
    const principal = registry.register({
      container: TEST_CONTAINER,
      containerCreatedAt: TEST_CONTAINER_CREATED_AT,
      actor: { kind: 'user', originKey: 'local', displayName: 'You' },
      role: 'user',
      authorDetails: CHAT_DETAILS,
      runtimeGeneration: 1,
    });
    const service = createDesktopLedgerService();

    try {
      const result = await service.searchEntries(
        {},
        {
          requestId: 'request-1',
          caller: {
            principalId: principal,
            clientInstanceId: 'client',
            authorityId: 'authority',
            interfaceKind: 'test',
            grants: allGrants,
          },
          metadata: {},
          signal: new AbortController().signal,
        },
      );

      expect(result.entries).toEqual([]);
      expect(fixture.repository.getStorageCounts().scopes).toBe(1);
      expect(
        fixture.repository.findScope({
          container: TEST_CONTAINER,
          containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        })?.accountId,
      ).toBeNull();
    } finally {
      registry.revoke(principal);
      fixture.dispose();
    }
  });
});
