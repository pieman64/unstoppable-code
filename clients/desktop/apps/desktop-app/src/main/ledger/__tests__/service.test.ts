import crypto from 'node:crypto';
import {
  LedgerCommandErrorSchema,
  LedgerQueryErrorSchema,
  isBoundedCanopyJsonValue,
  type LedgerCommandReceipt,
  type LedgerEntryAddParams,
  type LedgerContainer,
  type LedgerFileRef,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { LedgerBoundScope } from '../scope-bindings';
import {
  createLedgerService,
  setLedgerPendingTitleScheduler,
  type LedgerSourceAvailabilityRequest,
  type LedgerSyncStatusSource,
} from '../service';
import { LedgerStorageHostError } from '../storage-host';
import type { LedgerSyncHold } from '../sync-policy';
import {
  CHAT_DETAILS,
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  USER_DETAILS,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';

const OTHER_CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-2',
};

const MISSING_ENTRY_ID = '00000000-0000-4000-8000-00000000ffff';

const ANY_STRING: unknown = expect.any(String);
const USER_ACTOR: unknown = expect.objectContaining({ kind: 'user' });
const CHAT_ACTOR: unknown = expect.objectContaining({ kind: 'chat' });

/** Captures the core error an operation rejects with. */
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

describe('LedgerCoreService', () => {
  let harness: LedgerServiceHarness;

  beforeEach(() => {
    harness = createLedgerServiceHarness();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    harness.dispose();
  });

  function addTask(
    principal: string,
    key: string,
    title = 'Plan the storage work',
  ): Promise<LedgerCommandReceipt> {
    return harness.service.addEntry(
      {
        type: 'TASK',
        title,
        content: 'Write the plan.',
        _meta: { idempotencyKey: key },
      },
      harness.context(principal, key),
    );
  }

  describe('pending-title scheduling', () => {
    it('schedules pending title-less Adds and retries, never a titled Add', async () => {
      const scheduled: string[] = [];
      setLedgerPendingTitleScheduler((record): void => {
        scheduled.push(record.entryId);
      });
      try {
        const principal = harness.register();
        const params: LedgerEntryAddParams = {
          type: 'TASK',
          content: 'Write the plan.',
          _meta: { idempotencyKey: 'pending-title-1' },
        };
        const receipt = await harness.service.addEntry(
          params,
          harness.context(principal, 'pending-title-1'),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(scheduled).toEqual([receipt.entry.entryId]);
        expect(
          await harness.service.getEntry(
            { entryId: receipt.entry.entryId },
            harness.context(principal),
          ),
        ).toMatchObject({ titlePending: true });

        await harness.service.addEntry(
          params,
          harness.context(principal, 'pending-title-1'),
        );
        await addTask(principal, 'titled-title-1');
        await new Promise<void>((resolve) => setImmediate(resolve));
        // Receipts replay their original changed flag; the orchestrator dedupes jobs.
        expect(scheduled).toEqual([
          receipt.entry.entryId,
          receipt.entry.entryId,
        ]);
      } finally {
        setLedgerPendingTitleScheduler(undefined);
      }
    });
  });

  describe('construction and the flag', () => {
    it('touches no storage when it is created', () => {
      expect(harness.storeRequests()).toBe(0);
      expect(harness.store.client.calls).toEqual([]);
    });

    it('answers every operation unavailable while the flag is off, before storage', async () => {
      harness.enabled = false;
      const principal = harness.register();
      const context = harness.context(principal, 'key-1');
      const operations: Array<Promise<unknown>> = [
        harness.service.searchEntries({}, context),
        harness.service.getEntry({ entryId: MISSING_ENTRY_ID }, context),
        harness.service.listOwners({}, context),
        harness.service.listChanges({ afterSequence: '0' }, context),
        harness.service.addEntry(
          {
            type: 'TASK',
            title: 'Title',
            content: 'Content',
            _meta: { idempotencyKey: 'key-1' },
          },
          context,
        ),
        harness.service.updateEntry(
          {
            entryId: MISSING_ENTRY_ID,
            expectedRevision: 1,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'key-1' },
          },
          context,
        ),
        harness.service.publishSummary(
          {
            snapshotId: 'snapshot-1',
            generationId: 'generation-1',
            title: 'Summary',
            content: 'Summary text.',
            sourceTruncated: false,
            _meta: { idempotencyKey: 'key-1' },
          },
          context,
        ),
      ];

      for (const operation of operations) {
        const error = await operationError(operation);
        expect(error.payload).toEqual({
          kind: 'capability_unavailable',
          message: 'The Feed is not available.',
          code: 'core.ledger.writerUnavailable',
          details: { reason: 'WRITER_UNAVAILABLE' },
          retry: { kind: 'after_refresh', resource: 'core.ledger' },
        });
      }
      expect(harness.storeRequests()).toBe(0);
      expect(harness.store.client.calls).toEqual([]);
    });

    it('treats a failing flag read as off', async () => {
      const principal = harness.register();
      Object.defineProperty(harness, 'enabled', {
        get: (): boolean => {
          throw new Error('flag service failed');
        },
      });

      const error = await operationError(
        harness.service.searchEntries({}, harness.context(principal)),
      );

      expect(error.payload.kind).toBe('capability_unavailable');
      expect(harness.store.client.calls).toEqual([]);
    });
  });

  describe('caller bindings and roles', () => {
    it('forbids unknown, revoked and expired principals before storage', async () => {
      const revoked = harness.register();
      harness.bindings.revoke(revoked);
      const expired = harness.register({ ttlMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));

      for (const principal of ['unknown-principal', revoked, expired]) {
        const error = await operationError(
          harness.service.searchEntries({}, harness.context(principal)),
        );
        expect(error.payload).toEqual({
          kind: 'permission_denied',
          message: 'The caller may not perform this Feed operation.',
          code: 'core.ledger.forbidden',
          details: { reason: 'FORBIDDEN' },
          retry: { kind: 'never' },
        });
      }
      expect(harness.store.client.calls).toEqual([]);
    });

    it('lets a Summary publisher only publish', async () => {
      const publisher = harness.register({
        role: 'summary_publisher',
        actor: {
          kind: 'background',
          originKey: 'generation-1',
          displayName: 'Summary',
        },
        authorDetails: CHAT_DETAILS,
      });
      const context = harness.context(publisher, 'key-1');
      const refused: Array<Promise<unknown>> = [
        harness.service.searchEntries({}, context),
        harness.service.getEntry({ entryId: MISSING_ENTRY_ID }, context),
        harness.service.listOwners({}, context),
        harness.service.listChanges({ afterSequence: '0' }, context),
        harness.service.addEntry(
          {
            type: 'TASK',
            title: 'Title',
            content: 'Content',
            _meta: { idempotencyKey: 'key-1' },
          },
          context,
        ),
        harness.service.updateEntry(
          {
            entryId: MISSING_ENTRY_ID,
            expectedRevision: 1,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'key-1' },
          },
          context,
        ),
      ];

      for (const operation of refused) {
        await expect(operation).rejects.toMatchObject({
          payload: {
            kind: 'permission_denied',
            details: { reason: 'FORBIDDEN' },
          },
        });
      }
      expect(harness.store.client.calls).toEqual([]);
    });

    it.each(['user', 'interactive_chat'] as const)(
      'refuses Summary publication to the %s role',
      async (role) => {
        const principal =
          role === 'user' ? harness.registerUser() : harness.register();

        await expect(
          harness.service.publishSummary(
            {
              snapshotId: 'snapshot-1',
              generationId: 'generation-1',
              title: 'Summary',
              content: 'Summary text.',
              sourceTruncated: false,
              _meta: { idempotencyKey: 'summary:key' },
            },
            harness.context(principal, 'summary:key'),
          ),
        ).rejects.toMatchObject({
          payload: {
            kind: 'permission_denied',
            details: { reason: 'FORBIDDEN' },
          },
        });
      },
    );

    it('forbids a binding whose actor kind does not match its role', async () => {
      const mismatched = harness.register({
        role: 'interactive_chat',
        actor: { kind: 'user', originKey: 'local', displayName: 'You' },
      });

      await expect(
        harness.service.searchEntries({}, harness.context(mismatched)),
      ).rejects.toMatchObject({
        payload: { details: { reason: 'FORBIDDEN' } },
      });
    });

    it('never lets a principal reach another container', async () => {
      const chatHere = harness.register();
      const chatThere = harness.register({ container: OTHER_CONTAINER });
      const created = await addTask(chatHere, 'key-1');

      await expect(
        harness.service.getEntry(
          { entryId: created.entry.entryId },
          harness.context(chatThere),
        ),
      ).rejects.toMatchObject({
        payload: { kind: 'not_found', details: { reason: 'NOT_FOUND' } },
      });
      await expect(
        harness.service.searchEntries(
          { entryIds: [created.entry.entryId] },
          harness.context(chatThere),
        ),
      ).resolves.toMatchObject({ entries: [] });
    });
  });

  describe('commands and queries', () => {
    it('adds, reads, searches, updates and lists changes for a chat', async () => {
      const chat = harness.register();

      const added = await harness.service.addEntry(
        {
          type: 'TASK',
          title: 'Plan the storage work',
          content: 'Write the plan.',
          highlights: ['Keep it short'],
          referenceFiles: [{ rootId: 'repo-1', path: 'docs/plan.md' }],
          _meta: { idempotencyKey: 'add-1' },
        },
        harness.context(chat, 'add-1'),
      );
      const { entry } = added;
      const read = await harness.service.getEntry(
        { entryId: entry.entryId, includeHistory: true },
        harness.context(chat),
      );
      const searched = await harness.service.searchEntries(
        { query: 'storage' },
        harness.context(chat),
      );
      const updated = await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
          _meta: { idempotencyKey: 'update-1' },
        },
        harness.context(chat, 'update-1'),
      );
      const changes = await harness.service.listChanges(
        { afterSequence: '0' },
        harness.context(chat),
      );

      // The store's fact: the mirror has not acknowledged it yet.
      expect(added).toMatchObject({ changed: true, syncState: 'pending' });
      expect(entry).toMatchObject({
        type: 'TASK',
        status: 'TODO',
        revision: 1,
        scope: {
          authorityId: harness.store.repository.authorityId,
          container: TEST_CONTAINER,
        },
        author: { kind: 'chat' },
        authorDetails: CHAT_DETAILS,
        origin: {
          kind: 'chat',
          ledgerId: entry.scope.ledgerId,
          chatId: 'chat-1',
        },
        attribution: {
          kind: 'self_reported',
          executorDetails: CHAT_DETAILS,
        },
      });
      expect(entry.owner).toEqual(entry.author);
      expect(entry.attribution.effectiveActor).toEqual(entry.author);
      expect(read).toMatchObject({
        entry,
        sourceAvailability: 'available',
        history: { mutations: [{ kind: 'create', revision: 1 }] },
      });
      expect(searched.entries.map((item) => item.entryId)).toEqual([
        entry.entryId,
      ]);
      expect(searched).not.toHaveProperty('owners');
      expect(updated).toMatchObject({
        changed: true,
        entry: { revision: 2, status: 'IN_PROGRESS' },
      });
      expect(changes).toEqual({
        changes: [
          {
            sequence: added.localSequence,
            entryId: entry.entryId,
            revision: 1,
          },
          {
            sequence: updated.localSequence,
            entryId: entry.entryId,
            revision: 2,
          },
        ],
        nextSequence: updated.localSequence,
        hasMore: false,
      });
    });

    it('records the user as the author of user entries', async () => {
      const user = harness.registerUser();

      const { entry } = await addTask(user, 'user-add');

      expect(entry).toMatchObject({
        author: { kind: 'user' },
        authorDetails: USER_DETAILS,
        origin: { kind: 'user', userActorId: entry.author.actorId },
        attribution: { kind: 'user' },
      });
      expect(entry.owner).toEqual(entry.author);
    });

    it('resolves self in owner and author filters to the caller', async () => {
      const chatOne = harness.register();
      const chatTwo = harness.register({
        actor: { kind: 'chat', originKey: 'chat-2', displayName: 'Chat two' },
      });
      const user = harness.registerUser();
      const mine = await addTask(chatOne, 'one', 'Chat one work');
      const theirs = await addTask(chatTwo, 'two', 'Chat two work');
      const users = await addTask(user, 'user', 'User work');

      const ownedByOne = await harness.service.searchEntries(
        { owner: 'self' },
        harness.context(chatOne),
      );
      const authoredByTwo = await harness.service.searchEntries(
        { author: 'self' },
        harness.context(chatTwo),
      );
      const ownedByUser = await harness.service.searchEntries(
        { owner: 'self' },
        harness.context(user),
      );
      const byActorId = await harness.service.searchEntries(
        { owner: { actorId: theirs.entry.owner.actorId } },
        harness.context(chatOne),
      );

      expect(ownedByOne.entries.map((item) => item.entryId)).toEqual([
        mine.entry.entryId,
      ]);
      expect(authoredByTwo.entries.map((item) => item.entryId)).toEqual([
        theirs.entry.entryId,
      ]);
      expect(ownedByUser.entries.map((item) => item.entryId)).toEqual([
        users.entry.entryId,
      ]);
      expect(byActorId.entries.map((item) => item.entryId)).toEqual([
        theirs.entry.entryId,
      ]);
    });

    it('attaches assignable owners to a search on request', async () => {
      harness.setLiveChats(TEST_CONTAINER, [
        { chatId: 'chat-1', title: 'Chat one', createdAt: null },
        {
          chatId: 'chat-2',
          title: 'Chat two',
          createdAt: '2026-09-01T10:00:00.000Z',
        },
      ]);
      const chat = harness.register();

      const result = await harness.service.searchEntries(
        { includeAssignableOwners: true },
        harness.context(chat),
      );

      expect(result.entries).toEqual([]);
      expect(result.owners).toEqual({
        candidates: [
          {
            actor: USER_ACTOR,
            displayName: 'You',
            eligibilityToken: ANY_STRING,
            isSelf: false,
          },
          {
            actor: CHAT_ACTOR,
            displayName: 'Chat one',
            eligibilityToken: ANY_STRING,
            isSelf: true,
          },
          {
            actor: CHAT_ACTOR,
            displayName: 'Chat two',
            eligibilityToken: ANY_STRING,
            isSelf: false,
          },
        ],
        nextCursor: null,
      });
    });

    it('pages owners and refuses a bad owners cursor', async () => {
      harness.setLiveChats(
        TEST_CONTAINER,
        Array.from({ length: 35 }, (_unused, index) => ({
          chatId: `chat-${String(index + 1).padStart(2, '0')}`,
          title: `Chat ${String(index + 1)}`,
          createdAt: '2026-09-01T10:00:00.000Z',
        })),
      );
      const user = harness.registerUser();

      const first = await harness.service.listOwners({}, harness.context(user));
      const cursor = first.nextCursor;
      if (cursor === null) throw new Error('Expected a second page');
      const second = await harness.service.listOwners(
        { cursor },
        harness.context(user),
      );

      expect(first.candidates).toHaveLength(30);
      expect(first.candidates[0]).toMatchObject({
        displayName: 'You',
        isSelf: true,
      });
      expect(second.candidates).toHaveLength(6);
      expect(second.nextCursor).toBeNull();
      await expect(
        harness.service.listOwners(
          { cursor: `${cursor}x` },
          harness.context(user),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          code: 'core.ledger.cursorExpired',
          details: { reason: 'CURSOR_EXPIRED', field: 'cursor' },
          retry: {
            kind: 'after_refresh',
            resource: 'core.ledger.owners.list',
          },
        },
      });
      await expect(
        harness.service.searchEntries(
          { includeAssignableOwners: true, ownersCursor: `${cursor}x` },
          harness.context(user),
        ),
      ).rejects.toMatchObject({
        payload: {
          details: { reason: 'CURSOR_EXPIRED', field: 'ownersCursor' },
          retry: {
            kind: 'after_refresh',
            resource: 'core.ledger.entries.search',
          },
        },
      });
    });

    it('lets the user change any open entry but agents only their own', async () => {
      const chat = harness.register();
      const otherChat = harness.register({
        actor: { kind: 'chat', originKey: 'chat-2', displayName: 'Chat two' },
      });
      const user = harness.registerUser();
      const { entry } = await addTask(chat, 'chat-add');

      const byOtherChat = await operationError(
        harness.service.updateEntry(
          {
            entryId: entry.entryId,
            expectedRevision: 1,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'other-update' },
          },
          harness.context(otherChat, 'other-update'),
        ),
      );
      const byUser = await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          owner: 'self',
          _meta: { idempotencyKey: 'user-update' },
        },
        harness.context(user, 'user-update'),
      );

      expect(byOtherChat.payload).toMatchObject({
        kind: 'permission_denied',
        code: 'core.ledger.forbidden',
        details: { reason: 'FORBIDDEN', field: 'owner' },
        retry: { kind: 'never' },
      });
      expect(byOtherChat.payload.details).not.toHaveProperty('currentEntry');
      expect(byUser.entry.owner.kind).toBe('user');
      expect(
        (
          await harness.service.getEntry(
            { entryId: entry.entryId, includeHistory: true },
            harness.context(user),
          )
        ).history?.mutations[1],
      ).toMatchObject({
        attribution: { kind: 'user' },
        invocationOrigin: { kind: 'user' },
      });
    });

    it('overrides source availability through the injected resolver', async () => {
      harness.dispose();
      harness = createLedgerServiceHarness({
        service: {
          resolveSourceAvailability: (request) =>
            request.subject.kind === 'entry'
              ? 'archived'
              : Promise.resolve('not_on_this_device'),
        },
      });
      const chat = harness.register();
      const { entry } = await addTask(chat, 'key-1');

      await expect(
        harness.service.getEntry(
          { entryId: entry.entryId },
          harness.context(chat),
        ),
      ).resolves.toMatchObject({ sourceAvailability: 'archived' });
      await expect(
        harness.service.searchEntries({}, harness.context(chat)),
      ).resolves.toMatchObject({
        entries: [{ sourceAvailability: 'not_on_this_device' }],
      });
    });

    it("names each search item's source kind, and asks about its source with its origin, one page at a time", async () => {
      harness.dispose();
      const requests: LedgerSourceAvailabilityRequest[] = [];
      harness = createLedgerServiceHarness({
        store: { now: () => new Date('2026-10-11T12:00:00.000Z') },
        service: {
          resolveSourceAvailability: (request) => {
            requests.push(request);
            return request.subject.kind === 'search_item' &&
              request.subject.origin.kind === 'chat'
              ? 'archived'
              : request.stored;
          },
        },
      });
      const chat = harness.register();
      const user = harness.registerUser();
      // Equal timestamps sort by entry ID, so force the chat before the user.
      // Source metadata must stay attached to its entry in either order.
      let nextId = 1000;
      jest
        .spyOn(crypto, 'randomUUID')
        .mockImplementation(
          () => `00000000-0000-4000-8000-${String(nextId--).padStart(12, '0')}`,
        );
      await addTask(chat, 'key-1');
      await addTask(user, 'key-2', 'Review the plan');

      const searched = await harness.service.searchEntries(
        { sort: 'created_desc' },
        harness.context(chat),
      );

      // A chat's entry opens a chat; an entry a person added opens nothing.
      expect(searched.entries).toHaveLength(2);
      expect(
        searched.entries.map((item) => [
          item.author.kind,
          item.sourceKind,
          item.sourceAvailability,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['user', undefined, 'available'],
          ['chat', 'chat', 'archived'],
        ]),
      );
      const asked = requests.filter(
        (request) => request.subject.kind === 'search_item',
      );
      expect(asked).toHaveLength(2);
      expect(
        asked.map((request) =>
          request.subject.kind === 'search_item'
            ? request.subject.origin.kind
            : null,
        ),
      ).toEqual(expect.arrayContaining(['user', 'chat']));
      // One page, one shared key; the next search gets its own.
      expect(asked[0]?.page).toBe(asked[1]?.page);
      await harness.service.searchEntries({}, harness.context(chat));
      expect(requests[requests.length - 1]?.page).not.toBe(asked[0]?.page);
    });

    it('requires an idempotency key for commands', async () => {
      const chat = harness.register();

      await expect(
        harness.service.addEntry(
          {
            type: 'TASK',
            title: 'Title',
            content: 'Content',
            _meta: { idempotencyKey: 'key-1' },
          },
          harness.context(chat),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          details: { reason: 'INVALID_INPUT', field: '_meta.idempotencyKey' },
        },
      });
    });

    it('requires the params key to match the request key', async () => {
      const chat = harness.register();

      await expect(
        harness.service.addEntry(
          {
            type: 'TASK',
            title: 'Title',
            content: 'Content',
            _meta: { idempotencyKey: 'params-key' },
          },
          harness.context(chat, 'metadata-key'),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          details: { reason: 'INVALID_INPUT', field: '_meta.idempotencyKey' },
        },
      });
    });

    it('refuses to write from a binding with malformed author details', async () => {
      const chat = harness.register({
        authorDetails: { ...CHAT_DETAILS, model: 'm'.repeat(300) },
      });

      await expect(addTask(chat, 'key-1')).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          details: { reason: 'FORBIDDEN', field: 'authorDetails' },
        },
      });
      expect(harness.store.repository.getStorageCounts().entries).toBe(0);
    });
  });

  describe('pipeline agents, delegates and Summary publication', () => {
    it('records a pipeline agent with the origin its binding supplies', async () => {
      const agent = harness.register({
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-1',
          displayName: 'Plan step',
        },
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-1',
          physicalJobId: 'job-1',
          logicalJobId: 'job',
          stepId: 'plan',
          attempt: 1,
          iteration: 0,
          agentSessionId: 'session-1',
        },
      });

      const { entry } = await addTask(agent, 'pipeline-add');

      expect(entry).toMatchObject({
        author: { kind: 'pipeline_agent' },
        origin: {
          kind: 'pipeline_agent',
          ledgerId: entry.scope.ledgerId,
          executionId: 'execution-1',
          agentSessionId: 'session-1',
        },
        attribution: { kind: 'self_reported' },
      });
    });

    function registerPipelineAgent(
      overrides: Partial<{
        agentSessionId: string;
        originAgentSessionId: string;
        predecessorAgentSessionId: string;
        attempt: number;
      }> = {},
    ): string {
      const agentSessionId = overrides.agentSessionId ?? 'session-2';
      return harness.register({
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: agentSessionId,
          displayName: 'Implement · Release',
        },
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-1',
          physicalJobId: 'build__variant_1',
          logicalJobId: 'build',
          stepId: 'implement',
          attempt: overrides.attempt ?? 2,
          iteration: 1,
          agentSessionId: overrides.originAgentSessionId ?? agentSessionId,
          ...(overrides.predecessorAgentSessionId === undefined
            ? {}
            : {
                predecessorAgentSessionId: overrides.predecessorAgentSessionId,
              }),
        },
      });
    }

    it('records a retried attempt as a new actor linked to its predecessor', async () => {
      const { entry: first } = await addTask(
        registerPipelineAgent({ agentSessionId: 'session-1', attempt: 1 }),
        'attempt-1',
      );
      const { entry: retry } = await addTask(
        registerPipelineAgent({ predecessorAgentSessionId: 'session-1' }),
        'attempt-2',
        'Retry the storage work',
      );

      expect(retry.author.actorId).not.toBe(first.author.actorId);
      expect(retry.origin).toEqual({
        kind: 'pipeline_agent',
        ledgerId: retry.scope.ledgerId,
        executionId: 'execution-1',
        physicalJobId: 'build__variant_1',
        logicalJobId: 'build',
        stepId: 'implement',
        attempt: 2,
        iteration: 1,
        agentSessionId: 'session-2',
        predecessorAgentSessionId: 'session-1',
      });
    });

    it.each([
      ['names another agent session', { originAgentSessionId: 'session-9' }],
      [
        'names itself as its predecessor',
        { predecessorAgentSessionId: 'session-2' },
      ],
    ])('refuses a pipeline origin that %s', async (_case, overrides) => {
      await expect(
        addTask(registerPipelineAgent(overrides), 'pipeline-add'),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          details: { reason: 'FORBIDDEN', field: 'origin' },
        },
      });
      expect(harness.store.repository.getStorageCounts().entries).toBe(0);
    });

    it('lets a delegate without a registered origin read but not write', async () => {
      const delegate = harness.register({
        role: 'managed_delegation',
        actor: {
          kind: 'managed_delegation',
          originKey: 'delegation-1',
          displayName: 'Delegate',
        },
      });

      await expect(
        harness.service.searchEntries({}, harness.context(delegate)),
      ).resolves.toMatchObject({ entries: [] });
      await expect(addTask(delegate, 'delegate-add')).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          details: { reason: 'FORBIDDEN', field: 'origin' },
        },
      });
    });

    function registerDelegate(
      overrides: Partial<{
        delegationId: string;
        runGeneration: number;
        bindingGeneration: number;
        originDelegationId: string;
        parent: {
          kind: 'chat' | 'managed_delegation';
          originKey: string;
          displayName: string;
        };
      }> = {},
    ): string {
      const delegationId = overrides.delegationId ?? 'delegation-1';
      const runGeneration = overrides.runGeneration ?? 2;
      return harness.register({
        role: 'managed_delegation',
        actor: {
          kind: 'managed_delegation',
          originKey: delegationId,
          displayName: 'Review delegate',
        },
        runtimeGeneration: overrides.bindingGeneration ?? runGeneration,
        origin: {
          kind: 'managed_delegation',
          delegationId: overrides.originDelegationId ?? delegationId,
          parent: overrides.parent ?? {
            kind: 'chat',
            originKey: 'chat-1',
            displayName: 'Chat one',
          },
          root: { kind: 'chat', chatId: 'chat-1' },
          runGeneration,
        },
      });
    }

    it('records a delegate as its own actor, with its parent chat as lineage', async () => {
      const { entry: chatEntry } = await addTask(harness.register(), 'chat');

      const { entry } = await addTask(registerDelegate(), 'delegate-add');

      expect(entry.author).toMatchObject({ kind: 'managed_delegation' });
      expect(entry.author.actorId).not.toBe(chatEntry.author.actorId);
      expect(entry.owner).toEqual(entry.author);
      expect(entry.origin).toEqual({
        kind: 'managed_delegation',
        ledgerId: entry.scope.ledgerId,
        delegationId: 'delegation-1',
        parentActorId: chatEntry.author.actorId,
        root: { kind: 'chat', chatId: 'chat-1' },
        runGeneration: 2,
      });
      expect(entry.attribution).toMatchObject({
        kind: 'self_reported',
        effectiveActor: entry.author,
        recordedBy: entry.author,
      });
    });

    it('registers a parent the ledger has not seen, and names a nested delegate by its parent delegate', async () => {
      const { entry: first } = await addTask(registerDelegate(), 'first');
      const actors = harness.store.repository.listActors(first.scope.ledgerId);
      const firstOrigin = first.origin;
      if (firstOrigin.kind !== 'managed_delegation') {
        throw new Error('Expected the delegate origin to have a parent actor.');
      }
      const parentChat = actors.find(
        (actor) => actor.actor.actorId === firstOrigin.parentActorId,
      );
      expect(parentChat).toMatchObject({
        actor: { kind: 'chat' },
        originKey: 'chat:chat-1',
        displayName: 'Chat one',
      });

      const { entry: nested } = await addTask(
        registerDelegate({
          delegationId: 'delegation-2',
          runGeneration: 1,
          parent: {
            kind: 'managed_delegation',
            originKey: 'delegation-1',
            displayName: 'Review delegate',
          },
        }),
        'nested',
      );

      expect(nested.origin).toMatchObject({
        kind: 'managed_delegation',
        delegationId: 'delegation-2',
        parentActorId: first.author.actorId,
        runGeneration: 1,
      });
    });

    it('keeps the same actor across the run generations of one delegation', async () => {
      const { entry: first } = await addTask(
        registerDelegate({ runGeneration: 1 }),
        'generation-1',
      );
      const { entry: second } = await addTask(
        registerDelegate({ runGeneration: 2 }),
        'generation-2',
        'Continue the storage work',
      );

      expect(second.author).toEqual(first.author);
      expect(second.origin).toMatchObject({ runGeneration: 2 });
    });

    it.each([
      ['names another delegation', { originDelegationId: 'delegation-9' }],
      ['claims another run generation', { bindingGeneration: 1 }],
      [
        'names itself as its parent',
        {
          parent: {
            kind: 'managed_delegation' as const,
            originKey: 'delegation-1',
            displayName: 'Review delegate',
          },
        },
      ],
    ])('refuses a delegate lineage that %s', async (_case, overrides) => {
      await expect(
        addTask(registerDelegate(overrides), 'delegate-add'),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          details: { reason: 'FORBIDDEN', field: 'origin' },
        },
      });
      expect(harness.store.repository.getStorageCounts().entries).toBe(0);
    });

    it('does not let a delegate change an entry its parent chat owns', async () => {
      const { entry } = await addTask(harness.register(), 'chat');
      const delegate = registerDelegate();

      await expect(
        harness.service.updateEntry(
          {
            entryId: entry.entryId,
            expectedRevision: 1,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'delegate-update' },
          },
          harness.context(delegate, 'delegate-update'),
        ),
      ).rejects.toMatchObject({
        payload: { details: { reason: 'FORBIDDEN', field: 'owner' } },
      });
      await expect(
        harness.service.searchEntries(
          { owner: 'self' },
          harness.context(delegate),
        ),
      ).resolves.toMatchObject({ entries: [] });
    });

    it('publishes a Summary entry once per key, authored by its helper', async () => {
      const publisher = harness.register({
        role: 'summary_publisher',
        actor: {
          kind: 'background',
          originKey: 'generation-1',
          displayName: 'Summary',
        },
        authorDetails: CHAT_DETAILS,
      });
      const publish = (): Promise<LedgerCommandReceipt> =>
        harness.service.publishSummary(
          {
            snapshotId: 'snapshot-1',
            generationId: 'generation-1',
            title: 'Worktree summary',
            content: 'The storage worker landed.',
            highlights: ['Worker thread'],
            sourceTruncated: false,
            observedTaskId: 'task-1',
            _meta: { idempotencyKey: 'summary:ledger:snapshot-1' },
          },
          harness.context(publisher, 'summary:ledger:snapshot-1'),
        );

      const published = await publish();

      expect(published.entry).toMatchObject({
        type: 'SUMMARY',
        status: 'INFO',
        author: { kind: 'background' },
        authorDetails: CHAT_DETAILS,
        origin: {
          kind: 'summary',
          snapshotId: 'snapshot-1',
          generationId: 'generation-1',
          helperActorId: published.entry.author.actorId,
          observedTaskId: 'task-1',
        },
        attribution: { kind: 'system' },
      });
      expect(published.entry.owner).toEqual(published.entry.author);
      await expect(publish()).resolves.toEqual(published);
      expect(harness.store.repository.getStorageCounts().entries).toBe(1);
    });
  });

  describe('global (workflow) Ledgers', () => {
    const ORG_A = '0b4f8a52-7c1d-4e8a-9f3b-2d6c1e5a7b90';
    const ORG_B = '7f0c1d2e-3b4a-4c5d-8e6f-901234567890';

    function registerGlobalAgent(scope: LedgerBoundScope): string {
      return harness.register({
        container: scope.container,
        containerCreatedAt: scope.containerCreatedAt,
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-global',
          displayName: 'Triage · Nightly',
        },
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-global',
          physicalJobId: 'triage',
          logicalJobId: 'triage',
          stepId: 'triage',
          attempt: 1,
          iteration: 1,
          agentSessionId: 'session-global',
        },
      });
    }

    it('binds one Ledger per owner and account, and reuses it', async () => {
      const personal = await harness.service.scopes.resolveGlobal({
        kind: 'personal',
      });
      const again = await harness.service.scopes.resolveGlobal({
        kind: 'personal',
      });
      const orgA = await harness.service.scopes.resolveGlobal({
        kind: 'organization',
        organizationId: ORG_A,
      });
      const orgB = await harness.service.scopes.resolveGlobal({
        kind: 'organization',
        organizationId: ORG_B,
      });
      harness.accountId = 'account-2';
      const otherAccount = await harness.service.scopes.resolveGlobal({
        kind: 'personal',
      });

      expect(again.ledgerId).toBe(personal.ledgerId);
      expect(
        new Set([
          personal.ledgerId,
          orgA.ledgerId,
          orgB.ledgerId,
          otherAccount.ledgerId,
        ]).size,
      ).toBe(4);
      expect(personal.accountId).toBe('account-1');
      expect(otherAccount.accountId).toBe('account-2');
    });

    it('records an agent in its global Ledger without chats as owners', async () => {
      const scope = await harness.service.scopes.resolveGlobal({
        kind: 'organization',
        organizationId: ORG_A,
      });
      // A global Ledger's container has no chats, whatever a source says.
      harness.setLiveChats(scope.container, [
        { chatId: 'chat-1', title: 'Chat one', createdAt: null },
      ]);
      const agent = registerGlobalAgent(scope);

      const { entry } = await addTask(agent, 'global-add');
      const owners = await harness.service.listOwners(
        {},
        harness.context(agent),
      );

      expect(entry.scope).toEqual({
        ledgerId: scope.ledgerId,
        authorityId: scope.authorityId,
        container: scope.container,
      });
      expect(
        owners.candidates.map((candidate) => candidate.actor.kind),
      ).not.toContain('chat');
    });

    it('fails an open binding closed once another account signs in', async () => {
      const scope = await harness.service.scopes.resolveGlobal({
        kind: 'personal',
      });
      const agent = registerGlobalAgent(scope);
      await addTask(agent, 'before-switch');

      harness.accountId = 'account-2';

      await expect(addTask(agent, 'after-switch')).rejects.toMatchObject({
        payload: { details: { reason: 'FORBIDDEN', field: 'ledgerId' } },
      });
      await expect(
        harness.service.searchEntries({}, harness.context(agent)),
      ).rejects.toMatchObject({
        payload: { details: { reason: 'FORBIDDEN' } },
      });
    });

    it('refuses file references in a global Ledger', async () => {
      const scope = await harness.service.scopes.resolveGlobal({
        kind: 'personal',
      });
      const agent = registerGlobalAgent(scope);

      await expect(
        harness.service.addEntry(
          {
            type: 'OBSERVATION',
            title: 'A finding',
            content: 'Seen in the run.',
            referenceFiles: [{ rootId: 'workspace-1', path: 'src/index.ts' }],
            _meta: { idempotencyKey: 'global-files' },
          },
          harness.context(agent, 'global-files'),
        ),
      ).rejects.toMatchObject({
        payload: {
          details: { reason: 'INVALID_INPUT', field: 'referenceFiles' },
        },
      });
    });

    it('never mints a global Ledger from a caller binding alone', async () => {
      const agent = harness.register({
        container: { kind: 'global', owner: { kind: 'personal' } },
        containerCreatedAt: TEST_CONTAINER_CREATED_AT,
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-unbound',
          displayName: 'Unbound',
        },
      });

      await expect(
        harness.service.searchEntries({}, harness.context(agent)),
      ).rejects.toMatchObject({
        payload: { details: { reason: 'NOT_FOUND' } },
      });
      expect(harness.store.repository.listScopes()).toEqual([]);
    });
  });

  describe('actor labels and change reports', () => {
    it('labels the authors and owners a page names, and the actors of an entry and its history', async () => {
      const chat = harness.register();
      const user = harness.registerUser();
      const { entry } = await addTask(chat, 'label-add');
      const assigned = await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          owner: 'self',
          _meta: { idempotencyKey: 'label-assign' },
        },
        harness.context(user, 'label-assign'),
      );
      const userActorId = assigned.entry.owner.actorId;

      const page = await harness.service.searchEntries(
        {},
        harness.context(user),
      );
      const read = await harness.service.getEntry(
        { entryId: entry.entryId, includeHistory: true },
        harness.context(user),
      );

      const expected = [
        {
          actorId: entry.author.actorId,
          kind: 'chat',
          displayName: 'Chat one',
        },
        { actorId: userActorId, kind: 'user', displayName: 'You' },
      ];
      expect(page.actors).toEqual(expected);
      expect(read.actors).toEqual(expected);
    });

    it('reports each command that changed an entry, after it committed', async () => {
      harness.dispose();
      const reported: unknown[] = [];
      harness = createLedgerServiceHarness({
        service: {
          onEntryChanged: (change): void => {
            reported.push(change);
          },
        },
      });
      const chat = harness.register();
      const { entry } = await addTask(chat, 'report-add');
      await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
          _meta: { idempotencyKey: 'report-update' },
        },
        harness.context(chat, 'report-update'),
      );
      // Nothing changes, so nothing is reported.
      await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 2,
          status: 'IN_PROGRESS',
          _meta: { idempotencyKey: 'report-no-op' },
        },
        harness.context(chat, 'report-no-op'),
      );
      // A read is never a change.
      await harness.service.searchEntries({}, harness.context(chat));

      const ledgerId = harness.store.repository.listScopes()[0]?.scope.ledgerId;
      expect(reported).toEqual([
        {
          container: TEST_CONTAINER,
          ledgerId,
          entryId: entry.entryId,
          revision: 1,
        },
        {
          container: TEST_CONTAINER,
          ledgerId,
          entryId: entry.entryId,
          revision: 2,
        },
      ]);
    });

    it('commits a command even when the change listener throws', async () => {
      harness.dispose();
      harness = createLedgerServiceHarness({
        service: {
          onEntryChanged: (): void => {
            throw new Error('listener failed');
          },
        },
      });
      const chat = harness.register();

      await expect(addTask(chat, 'throwing-listener')).resolves.toMatchObject({
        changed: true,
      });
      expect(harness.store.repository.getStorageCounts().entries).toBe(1);
    });
  });

  describe('redaction', () => {
    const TOKEN = `ghp_${'A'.repeat(36)}`;

    it('redacts title, content and every highlight before an Add commits', async () => {
      const chat = harness.register();

      const { entry } = await harness.service.addEntry(
        {
          type: 'OBSERVATION',
          title: `Token ${TOKEN} leaked`,
          content: `The key AKIAIOSFODNN7EXAMPLE was in the log.\npassword=hunter2longvalue`,
          highlights: ['Clean', `Also ${TOKEN}`],
          _meta: { idempotencyKey: 'redact-1' },
        },
        harness.context(chat, 'redact-1'),
      );

      expect(entry.title).toBe('Token <redacted-token> leaked');
      expect(entry.content).toBe(
        'The key <redacted-aws-key> was in the log.\npassword=<redacted>',
      );
      expect(entry.highlights).toEqual(['Clean', 'Also <redacted-token>']);
      const stored = harness.store.repository.getEntry({
        ledgerId: entry.scope.ledgerId,
        entryId: entry.entryId,
      }).entry;
      expect(JSON.stringify(stored)).not.toContain(TOKEN);
      expect(JSON.stringify(stored)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it("masks a pipeline step's configured secrets, whatever their shape, before an Add commits", async () => {
      // A configured value no shape-based rule recognizes.
      const SECRET = 'correct horse battery staple';
      const agent = harness.register({
        role: 'pipeline_agent',
        actor: {
          kind: 'pipeline_agent',
          originKey: 'session-secret',
          displayName: 'Deploy step',
        },
        origin: {
          kind: 'pipeline_agent',
          executionId: 'execution-1',
          physicalJobId: 'job-1',
          logicalJobId: 'job',
          stepId: 'deploy',
          attempt: 1,
          iteration: 0,
          agentSessionId: 'session-secret',
        },
        secretValues: [SECRET],
      });

      const { entry } = await harness.service.addEntry(
        {
          type: 'OBSERVATION',
          title: `Used ${SECRET}`,
          content: `The password is ${SECRET}.`,
          highlights: [`${SECRET} again`],
          referenceFiles: [
            { rootId: SECRET, path: `notes/${SECRET}.md`, startLine: 3 },
          ],
          _meta: { idempotencyKey: 'redact-configured' },
        },
        harness.context(agent, 'redact-configured'),
      );

      expect(entry.title).toBe('Used ***');
      expect(entry.content).toBe('The password is ***.');
      expect(entry.highlights).toEqual(['*** again']);
      expect(entry.referenceFiles).toEqual([
        { rootId: '***', path: 'notes/***.md', startLine: 3 },
      ]);
      const stored = harness.store.repository.getEntry({
        ledgerId: entry.scope.ledgerId,
        entryId: entry.entryId,
      }).entry;
      expect(JSON.stringify(stored)).not.toContain(SECRET);
      const outbox = await harness.store.client.readOutbox({
        ledgerId: entry.scope.ledgerId,
        afterSequence: '0',
        limit: 100,
      });
      expect(outbox.length).toBeGreaterThan(0);
      for (const event of outbox) {
        expect(event.payloadJson).not.toContain(SECRET);
      }
    });

    it('redacts a Summary before it is published', async () => {
      const publisher = harness.register({
        role: 'summary_publisher',
        actor: {
          kind: 'background',
          originKey: 'generation-1',
          displayName: 'Summary',
        },
      });

      const { entry } = await harness.service.publishSummary(
        {
          snapshotId: 'snapshot-1',
          generationId: 'generation-1',
          title: `Rotated ${TOKEN}`,
          content: `Bearer ${TOKEN}`,
          highlights: [TOKEN],
          sourceTruncated: false,
          _meta: { idempotencyKey: 'summary:ledger:snapshot-1' },
        },
        harness.context(publisher, 'summary:ledger:snapshot-1'),
      );

      expect(entry.title).toBe('Rotated <redacted-token>');
      expect(entry.content).toBe('Bearer <redacted-token>');
      expect(entry.highlights).toEqual(['<redacted-token>']);
    });

    it('reports the field limit when a masked value no longer fits', async () => {
      const chat = harness.register();
      // Each 6-character address becomes a 16-character marker.
      const title = Array.from({ length: 12 }, () => 'a@b.io').join(' ');

      await expect(
        harness.service.addEntry(
          {
            type: 'TASK',
            title,
            content: 'Contact them.',
            _meta: { idempotencyKey: 'redact-2' },
          },
          harness.context(chat, 'redact-2'),
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'invalid_argument',
          code: 'core.ledger.invalidInput',
          details: { reason: 'INVALID_INPUT', field: 'title', limit: 100 },
        },
      });
      expect(harness.store.repository.getStorageCounts().entries).toBe(0);
    });
  });

  describe('a database a newer build wrote', () => {
    /**
     * The service a relaunch on an older build starts: nothing cached, over
     * a store that opens read-only, so every storage command fails.
     */
    function relaunchedReadOnly(): ReturnType<typeof createLedgerService> {
      const unsupported = (): LedgerStorageHostError =>
        new LedgerStorageHostError(
          'UNSUPPORTED_SCHEMA',
          'The Feed database uses an unsupported schema.',
        );
      for (let i = 0; i < 4; i += 1) {
        harness.store.client.failNext('bindScope', unsupported());
        harness.store.client.failNext('registerActor', unsupported());
      }
      return createLedgerService({
        store: () => harness.store.client,
        isEnabled: () => true,
        getAccountId: () => 'account-1',
        liveChats: () => Promise.resolve([]),
        callerBindings: harness.bindings,
        now: harness.clock.now,
      });
    }

    it('still reads the entries it holds', async () => {
      const chat = harness.register();
      const { entry } = await addTask(chat, 'newer-read');
      // "You" was registered with the scope, as every use registers it.
      await harness.service.searchEntries(
        {},
        harness.context(harness.registerUser()),
      );
      const service = relaunchedReadOnly();
      const user = harness.registerUser();

      const found = await service.searchEntries({}, harness.context(user));
      const read = await service.getEntry(
        { entryId: entry.entryId },
        harness.context(user),
      );

      expect(found.entries.map((item) => item.entryId)).toEqual([
        entry.entryId,
      ]);
      expect(read.entry.entryId).toBe(entry.entryId);
    });

    it('still refuses every write', async () => {
      const chat = harness.register();
      await addTask(chat, 'newer-write-seed');
      const service = relaunchedReadOnly();

      await expect(
        service.addEntry(
          {
            type: 'TASK',
            title: 'After the downgrade',
            content: 'Write it.',
            _meta: { idempotencyKey: 'newer-write' },
          },
          harness.context(chat, 'newer-write'),
        ),
      ).rejects.toMatchObject({
        payload: { details: { reason: 'UNSUPPORTED_SCHEMA' } },
      });
    });
  });

  describe('storage failures', () => {
    const QUERY_CASES = [
      ['INVALID_INPUT', 'invalid_argument', { kind: 'never' }],
      ['NOT_FOUND', 'not_found', { kind: 'never' }],
      ['FORBIDDEN', 'permission_denied', { kind: 'never' }],
      ['TERMINAL_ENTRY', 'failed_precondition', { kind: 'never' }],
      [
        'REVISION_CONFLICT',
        'conflict',
        { kind: 'after_refresh', resource: 'core.ledger.entry.get' },
      ],
      [
        'OWNER_UNAVAILABLE',
        'failed_precondition',
        { kind: 'after_refresh', resource: 'core.ledger.owners.list' },
      ],
      ['SCOPE_RETIRED', 'failed_precondition', { kind: 'never' }],
      ['IDEMPOTENCY_KEY_REUSED', 'conflict', { kind: 'never' }],
      [
        'CURSOR_EXPIRED',
        'failed_precondition',
        { kind: 'after_refresh', resource: 'core.ledger.entries.search' },
      ],
      ['UNSUPPORTED_SCHEMA', 'capability_unavailable', { kind: 'never' }],
      ['STORAGE_UNAVAILABLE', 'unavailable', { kind: 'same_request' }],
      ['RATE_LIMITED', 'resource_exhausted', { kind: 'same_request' }],
      [
        'WRITER_UNAVAILABLE',
        'capability_unavailable',
        { kind: 'after_refresh', resource: 'core.ledger' },
      ],
    ] as const;

    const COMMAND_RETRY: { readonly [reason: string]: object } = {
      REVISION_CONFLICT: {
        kind: 'after_refresh',
        resource: 'core.ledger.entry.get',
      },
      OWNER_UNAVAILABLE: {
        kind: 'after_refresh',
        resource: 'core.ledger.owners.list',
      },
      CURSOR_EXPIRED: {
        kind: 'after_refresh',
        resource: 'core.ledger.entry.add',
      },
      STORAGE_UNAVAILABLE: { kind: 'same_idempotency_key' },
      RATE_LIMITED: { kind: 'same_idempotency_key' },
      WRITER_UNAVAILABLE: { kind: 'after_refresh', resource: 'core.ledger' },
    };

    it.each(QUERY_CASES)(
      'maps %s on a query to %s',
      async (reason, kind, retry) => {
        const chat = harness.register();
        await harness.service.searchEntries({}, harness.context(chat));
        harness.store.client.failNext(
          'searchEntries',
          new LedgerStorageHostError(reason, 'Storage failed', {
            reason,
            field: 'query',
          }),
        );

        const error = await operationError(
          harness.service.searchEntries({}, harness.context(chat)),
        );

        expect(error.payload).toMatchObject({
          kind,
          code: `core.ledger.${reason
            .toLowerCase()
            .replace(/_([a-z])/g, (_match, letter: string) =>
              letter.toUpperCase(),
            )}`,
          details: { reason, field: 'query' },
          retry,
        });
        expect(LedgerQueryErrorSchema.safeParse(error.payload).success).toBe(
          true,
        );
      },
    );

    it.each(QUERY_CASES)(
      'maps %s on a command to %s with a keyed retry',
      async (reason, kind) => {
        const chat = harness.register();
        await harness.service.searchEntries({}, harness.context(chat));
        harness.store.client.failNext(
          'addEntry',
          new LedgerStorageHostError(reason, 'Storage failed', { reason }),
        );

        const error = await operationError(addTask(chat, 'key-1'));

        expect(error.payload).toMatchObject({
          kind,
          details: { reason },
          retry: COMMAND_RETRY[reason] ?? { kind: 'never' },
        });
        expect(LedgerCommandErrorSchema.safeParse(error.payload).success).toBe(
          true,
        );
      },
    );

    it('keeps only the reason when storage details do not match it', async () => {
      const chat = harness.register();
      await harness.service.searchEntries({}, harness.context(chat));
      harness.store.client.failNext(
        'searchEntries',
        new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'Stopped', {
          exitCode: 1,
        }),
      );

      const error = await operationError(
        harness.service.searchEntries({}, harness.context(chat)),
      );

      expect(error.payload.details).toEqual({ reason: 'STORAGE_UNAVAILABLE' });
    });

    it('reports an internal failure without details', async () => {
      const chat = harness.register();
      await harness.service.searchEntries({}, harness.context(chat));
      harness.store.client.failNext(
        'searchEntries',
        new LedgerStorageHostError('INTERNAL', 'Not sent', {
          method: 'searchEntries',
        }),
      );
      harness.store.client.failNext('addEntry', new TypeError('unexpected'));

      const queryError = await operationError(
        harness.service.searchEntries({}, harness.context(chat)),
      );
      const commandError = await operationError(addTask(chat, 'key-1'));

      expect(queryError.payload).toEqual({
        kind: 'internal',
        message: 'The Feed operation failed.',
        retry: { kind: 'never' },
      });
      // The outcome of a command that failed unexpectedly is unknown.
      expect(commandError.payload).toEqual({
        kind: 'internal',
        message: 'The Feed operation failed.',
        retry: { kind: 'same_idempotency_key' },
      });
    });

    it('tells a command whose commit outcome is unknown to retry with its key', async () => {
      const chat = harness.register();
      harness.store.client.failNextAfterRunning(
        'addEntry',
        new LedgerStorageHostError('STORAGE_UNAVAILABLE', 'No answer'),
      );

      const error = await operationError(addTask(chat, 'lost-reply'));
      const retried = await addTask(chat, 'lost-reply');

      expect(error.payload).toMatchObject({
        kind: 'unavailable',
        code: 'core.ledger.storageUnavailable',
        retry: { kind: 'same_idempotency_key' },
      });
      expect(retried.changed).toBe(true);
      expect(harness.store.repository.getStorageCounts().entries).toBe(1);
    });

    it('returns the current entry with a revision conflict', async () => {
      const chat = harness.register();
      const { entry } = await addTask(chat, 'key-1');

      const error = await operationError(
        harness.service.updateEntry(
          {
            entryId: entry.entryId,
            expectedRevision: 2,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'key-2' },
          },
          harness.context(chat, 'key-2'),
        ),
      );

      expect(error.payload).toEqual({
        kind: 'conflict',
        message: 'The Feed entry changed since it was read.',
        code: 'core.ledger.revisionConflict',
        details: {
          reason: 'REVISION_CONFLICT',
          field: 'expectedRevision',
          currentEntry: entry,
        },
        retry: { kind: 'after_refresh', resource: 'core.ledger.entry.get' },
      });
    });

    it('drops a current entry too large for the error bound', async () => {
      const chat = harness.register();
      const referenceFiles: LedgerFileRef[] = Array.from(
        { length: 25 },
        (_unused, index) => ({
          rootId: `${String(index).padStart(2, '0')}${'r'.repeat(510)}`,
          path: `${'p'.repeat(1_000)}/file-${String(index)}.ts`,
        }),
      );
      const { entry } = await harness.service.addEntry(
        {
          type: 'TASK',
          title: 'Touch every file',
          content: 'A wide change.',
          referenceFiles,
          _meta: { idempotencyKey: 'key-1' },
        },
        harness.context(chat, 'key-1'),
      );
      expect(JSON.stringify(entry).length).toBeGreaterThan(32_768);

      const error = await operationError(
        harness.service.updateEntry(
          {
            entryId: entry.entryId,
            expectedRevision: 2,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'key-2' },
          },
          harness.context(chat, 'key-2'),
        ),
      );

      expect(error.payload.details).toEqual({
        reason: 'REVISION_CONFLICT',
        field: 'expectedRevision',
      });
      expect(isBoundedCanopyJsonValue(error.payload.details)).toBe(true);
    });

    it('rebuilds details that arrive from another realm', async () => {
      harness.dispose();
      harness = createLedgerServiceHarness({
        store: { foreignRealmDetails: true },
      });
      const chat = harness.register();
      const { entry } = await addTask(chat, 'key-1');
      await harness.service.updateEntry(
        {
          entryId: entry.entryId,
          expectedRevision: 1,
          status: 'COMPLETED',
          _meta: { idempotencyKey: 'key-2' },
        },
        harness.context(chat, 'key-2'),
      );

      const error = await operationError(
        harness.service.updateEntry(
          {
            entryId: entry.entryId,
            expectedRevision: 2,
            status: 'BLOCKED',
            _meta: { idempotencyKey: 'key-3' },
          },
          harness.context(chat, 'key-3'),
        ),
      );
      const details = error.payload.details;

      expect(error.payload).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.ledger.terminalEntry',
        details: {
          reason: 'TERMINAL_ENTRY',
          currentEntry: { entryId: entry.entryId, status: 'COMPLETED' },
        },
        retry: { kind: 'never' },
      });
      expect(Object.getPrototypeOf(details)).toBe(Object.prototype);
      expect(isBoundedCanopyJsonValue(details)).toBe(true);
    });
  });

  describe('sync states (LD02)', () => {
    it("shows why unsent revisions are not on their way, and the scope's pending audience change", async () => {
      const seen: LedgerBoundScope[] = [];
      let hold: LedgerSyncHold | null = 'policy_restricted';
      const source: LedgerSyncStatusSource = {
        hold: (scope) => {
          seen.push(scope);
          return Promise.resolve(hold);
        },
        audienceChangePending: () => Promise.resolve(true),
      };
      const synced = createLedgerServiceHarness({
        service: { syncStatus: source },
      });
      try {
        const chat = synced.register();
        const added = await synced.service.addEntry(
          {
            type: 'TASK',
            title: 'Plan',
            content: 'Write the plan.',
            _meta: { idempotencyKey: 'add-1' },
          },
          synced.context(chat, 'add-1'),
        );
        const { ledgerId } = added.entry.scope;
        const searched = await synced.service.searchEntries(
          {},
          synced.context(chat),
        );
        const read = await synced.service.getEntry(
          { entryId: added.entry.entryId },
          synced.context(chat),
        );

        expect(added.syncState).toBe('policy_restricted');
        expect(searched.entries.map((item) => item.syncState)).toEqual([
          'policy_restricted',
        ]);
        expect(searched.scopeSync).toEqual({ audienceChangePending: true });
        expect(read.syncState).toBe('policy_restricted');
        expect(seen[0]).toEqual({
          ledgerId,
          authorityId: synced.store.repository.authorityId,
          container: TEST_CONTAINER,
          containerCreatedAt: TEST_CONTAINER_CREATED_AT,
          accountId: 'account-1',
        });

        // What the mirror acknowledged stays synced, whatever holds the rest.
        const scope = await synced.store.client.getScopeSync(ledgerId);
        await synced.store.client.acknowledgeOutbox({
          ledgerId,
          sequence: scope?.scope.sequence ?? '0',
        });
        await synced.store.client.setScopeRepair({
          ledgerId,
          reason: 'sequence_gap',
        });
        hold = null;
        const second = await synced.service.addEntry(
          {
            type: 'TASK',
            title: 'Second',
            content: 'Write the plan.',
            _meta: { idempotencyKey: 'add-2' },
          },
          synced.context(chat, 'add-2'),
        );
        expect(second.syncState).toBe('repair_needed');
        hold = 'local_only';
        const later = await synced.service.searchEntries(
          {},
          synced.context(chat),
        );
        expect(
          Object.fromEntries(
            later.entries.map((item) => [item.entryId, item.syncState]),
          ),
        ).toEqual({
          [added.entry.entryId]: 'mirrored',
          [second.entry.entryId]: 'local_only',
        });
      } finally {
        synced.dispose();
      }
    });

    it("keeps the store's facts when the host cannot say", async () => {
      const failing = new Error('Sync status unavailable');
      const synced = createLedgerServiceHarness({
        service: {
          syncStatus: {
            hold: () => Promise.reject(failing),
            audienceChangePending: () => Promise.reject(failing),
          },
        },
      });
      try {
        const chat = synced.register();
        const added = await synced.service.addEntry(
          {
            type: 'TASK',
            title: 'Plan',
            content: 'Write the plan.',
            _meta: { idempotencyKey: 'add-1' },
          },
          synced.context(chat, 'add-1'),
        );
        const searched = await synced.service.searchEntries(
          {},
          synced.context(chat),
        );

        expect(added.syncState).toBe('pending');
        expect(searched.scopeSync).toEqual({ audienceChangePending: false });
      } finally {
        synced.dispose();
      }
    });

    it('reports no scope sync without a host source', async () => {
      const chat = harness.register();
      await addTask(chat, 'key-1');

      const searched = await harness.service.searchEntries(
        {},
        harness.context(chat),
      );

      expect(searched).not.toHaveProperty('scopeSync');
      expect(searched.entries[0]?.syncState).toBe('pending');
    });
  });

  it('binds the container incarnation the binding names', async () => {
    const chat = harness.register({
      containerCreatedAt: '2026-09-15T08:00:00.000Z',
    });
    const original = harness.register({
      actor: { kind: 'chat', originKey: 'chat-2', displayName: 'Chat two' },
      containerCreatedAt: TEST_CONTAINER_CREATED_AT,
    });

    const recreated = await addTask(chat, 'key-1');
    const before = await addTask(original, 'key-1');

    expect(recreated.entry.scope.ledgerId).not.toBe(
      before.entry.scope.ledgerId,
    );
    await expect(
      harness.service.searchEntries({}, harness.context(chat)),
    ).resolves.toMatchObject({
      entries: [{ entryId: recreated.entry.entryId }],
    });
  });
});
