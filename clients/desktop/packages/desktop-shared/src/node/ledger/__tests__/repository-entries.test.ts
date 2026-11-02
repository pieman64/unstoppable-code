import { DatabaseSync } from 'node:sqlite';

import {
  LEDGER_STATUSES,
  LEDGER_TERMINAL_STATUSES,
  LedgerCommandReceiptSchema,
  type LedgerActorRef,
  type LedgerCommandReceipt,
  type LedgerStatus,
  type LedgerPublishSummaryParams,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from '../errors';
import { isLedgerEntryOpen } from '../policy';
import {
  NO_DETAILS,
  PERSONAL_OWNER,
  addInput,
  attributionFor,
  bindGlobal,
  captureLedgerError,
  registerTestActor,
  setUpLedger,
  updateInput,
  withUncheckedFields,
  type LedgerTestContext,
} from './ledger-test-harness';

const OPEN_STATUSES: readonly LedgerStatus[] = LEDGER_STATUSES.filter(
  (status: LedgerStatus): boolean => isLedgerEntryOpen(status),
);

describe('LedgerRepository entries', () => {
  let context: LedgerTestContext;
  let keyCounter = 0;

  function nextKey(): string {
    keyCounter += 1;
    return `request-${keyCounter}`;
  }

  function addTask(
    actor: LedgerActorRef = context.chat,
    status?: LedgerStatus,
  ): LedgerCommandReceipt {
    return context.repository.addEntry(
      addInput(
        context,
        actor,
        {
          type: 'TASK',
          title: 'Ship the ledger',
          content: 'Write the store and its tests.',
          ...(status === undefined ? {} : { status }),
        },
        nextKey(),
      ),
    );
  }

  function setStatus(
    receipt: LedgerCommandReceipt,
    status: LedgerStatus,
    actor: LedgerActorRef = context.chat,
    key: string = nextKey(),
  ): LedgerCommandReceipt {
    return context.repository.updateEntry(
      updateInput(
        context,
        actor,
        {
          entryId: receipt.entry.entryId,
          expectedRevision: receipt.entry.revision,
          status,
        },
        key,
      ),
    );
  }

  function setOwner(
    receipt: LedgerCommandReceipt,
    owner: LedgerActorRef,
    actor: LedgerActorRef = context.chat,
  ): LedgerCommandReceipt {
    return context.repository.updateEntry(
      updateInput(
        context,
        actor,
        {
          entryId: receipt.entry.entryId,
          expectedRevision: receipt.entry.revision,
          owner: { actorId: owner.actorId, eligibilityToken: 'token' },
        },
        nextKey(),
        { newOwner: owner },
      ),
    );
  }

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  describe('addEntry', () => {
    it('creates revision 1 with host-supplied identity and a local receipt', () => {
      const receipt = addTask();
      expect(LedgerCommandReceiptSchema.parse(receipt)).toEqual(receipt);
      expect(receipt).toMatchObject({
        changed: true,
        localSequence: '7',
        // Committed here; the mirror has not acknowledged it.
        syncState: 'pending',
      });
      expect(receipt.mutationId).not.toBeNull();
      expect(receipt.entry).toMatchObject({
        schemaVersion: 1,
        revision: 1,
        type: 'TASK',
        status: 'TODO',
        author: context.chat,
        owner: context.chat,
        createdAt: context.clock.iso(),
        updatedAt: context.clock.iso(),
        highlights: [],
        referenceFiles: [],
        scope: { ledgerId: context.ledgerId },
      });
      expect(context.repository.getScope(context.ledgerId)?.sequence).toBe('7');
    });

    it('applies the default status of each public type', () => {
      const types = ['TASK', 'ACTION', 'DECISION', 'OBSERVATION'] as const;
      const statuses = types.map(
        (type): LedgerStatus =>
          context.repository.addEntry(
            addInput(
              context,
              context.chat,
              { type, title: type, content: 'Default status.' },
              nextKey(),
            ),
          ).entry.status,
      );
      expect(statuses).toEqual(['TODO', 'IN_PROGRESS', 'INFO', 'INFO']);
    });

    it('assigns a new entry to another registered owner', () => {
      const receipt = context.repository.addEntry(
        addInput(
          context,
          context.chat,
          {
            type: 'TASK',
            title: 'Review the store',
            content: 'Please review.',
            owner: { actorId: context.user.actorId, eligibilityToken: 'token' },
          },
          nextKey(),
          { owner: context.user },
        ),
      );
      expect(receipt.entry.owner).toEqual(context.user);
      expect(receipt.entry.author).toEqual(context.chat);
    });

    it('rejects a resolved owner that differs from the requested one', () => {
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              context,
              context.chat,
              { type: 'TASK', title: 'Task', content: 'Owner mismatch.' },
              nextKey(),
              { owner: context.user },
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'owner' });
    });

    it('never lets background helpers or sidecars author through Add', () => {
      for (const author of [context.helper, context.sidecar]) {
        const error = captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              context,
              author,
              { type: 'OBSERVATION', title: 'Note', content: 'Not allowed.' },
              nextKey(),
            ),
          ),
        );
        expect(error.reason).toBe('FORBIDDEN');
      }
      expect(context.repository.getStorageCounts().entries).toBe(0);
    });

    it('links a correction to an entry in the same ledger only', () => {
      const original = addTask();
      const correction = context.repository.addEntry(
        addInput(
          context,
          context.chat,
          {
            type: 'DECISION',
            title: 'Corrected decision',
            content: 'Supersedes the task.',
            supersedesEntryId: original.entry.entryId,
          },
          nextKey(),
        ),
      );
      expect(correction.entry.supersedesEntryId).toBe(original.entry.entryId);
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              context,
              context.chat,
              {
                type: 'DECISION',
                title: 'Dangling correction',
                content: 'No such entry.',
                supersedesEntryId: '00000000-0000-4000-8000-00000000ffff',
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'supersedesEntryId' });
    });
  });

  describe('T03 status transitions and the terminal lock', () => {
    it('allows every transition out of every open status', () => {
      for (const from of OPEN_STATUSES) {
        for (const to of LEDGER_STATUSES) {
          if (to === from) continue;
          const created = addTask(context.chat, from);
          context.clock.advance(1_000);
          const updated = setStatus(created, to);
          expect(updated.changed).toBe(true);
          expect(updated.entry.status).toBe(to);
          expect(updated.entry.revision).toBe(2);
          expect(updated.entry.updatedAt).toBe(context.clock.iso());
          expect(updated.entry.createdAt).toBe(created.entry.createdAt);
        }
      }
    });

    it('treats an unchanged open entry as a no-op that still records its receipt', () => {
      const created = addTask();
      const before = context.repository.getStorageCounts();
      context.clock.advance(60_000);

      const sameStatus = setStatus(created, 'TODO');
      const sameOwner = setOwner(created, context.chat);

      for (const noop of [sameStatus, sameOwner]) {
        expect(noop).toEqual({
          entry: created.entry,
          changed: false,
          mutationId: null,
          localSequence: created.localSequence,
          syncState: 'pending',
        });
      }
      const after = context.repository.getStorageCounts();
      expect(after).toEqual({ ...before, receipts: before.receipts + 2 });
      expect(
        context.repository.getEntry({
          ledgerId: context.ledgerId,
          entryId: created.entry.entryId,
        }).entry,
      ).toEqual(created.entry);
    });

    it('rejects every change to a terminal entry, including no-ops', () => {
      for (const terminal of LEDGER_TERMINAL_STATUSES) {
        const closed = setStatus(addTask(), terminal);
        const attempts: (() => LedgerCommandReceipt)[] = [
          (): LedgerCommandReceipt => setStatus(closed, 'IN_PROGRESS'),
          (): LedgerCommandReceipt => setStatus(closed, terminal),
          (): LedgerCommandReceipt => setOwner(closed, context.otherChat),
          (): LedgerCommandReceipt => setOwner(closed, context.chat),
          (): LedgerCommandReceipt => setStatus(closed, 'TODO', context.user),
        ];
        for (const attempt of attempts) {
          const error = captureLedgerError(attempt);
          expect(error.reason).toBe('TERMINAL_ENTRY');
          expect(error.currentEntry).toEqual(closed.entry);
        }
      }
    });

    it('rejects changes to entries created in a terminal status', () => {
      const decision = context.repository.addEntry(
        addInput(
          context,
          context.chat,
          { type: 'DECISION', title: 'Decided', content: 'Use SQLite.' },
          nextKey(),
        ),
      );
      expect(decision.entry.status).toBe('INFO');
      expect(captureLedgerError(() => setStatus(decision, 'TODO')).reason).toBe(
        'TERMINAL_ENTRY',
      );
    });

    it('replays the request that made an entry terminal', () => {
      const created = addTask();
      const completion = setStatus(created, 'COMPLETED', context.chat, 'done');
      context.clock.advance(5_000);
      expect(setStatus(created, 'COMPLETED', context.chat, 'done')).toEqual(
        completion,
      );
      // A new request at the terminal revision is rejected, even as a no-op.
      expect(
        captureLedgerError(() =>
          setStatus(completion, 'COMPLETED', context.chat, 'done-again'),
        ).reason,
      ).toBe('TERMINAL_ENTRY');
    });

    it('never moves updatedAt backwards when the clock does', () => {
      const created = addTask();
      context.clock.advance(-60_000);
      const updated = setStatus(created, 'IN_PROGRESS');
      expect(updated.entry.revision).toBe(2);
      expect(updated.entry.updatedAt).toBe(created.entry.updatedAt);
    });
  });

  describe('ownership', () => {
    it('lets agents update only entries they currently own', () => {
      const created = addTask(context.chat);
      expect(
        captureLedgerError(() =>
          setStatus(created, 'IN_PROGRESS', context.otherChat),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN' });
      expect(
        captureLedgerError(() =>
          context.repository.updateEntry(
            updateInput(
              context,
              context.otherChat,
              {
                entryId: created.entry.entryId,
                expectedRevision: 1,
                status: 'BLOCKED',
              },
              nextKey(),
              { mayUpdateAnyOpenEntry: true },
            ),
          ),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN' });
    });

    it('transfers ownership, after which the previous owner cannot update', () => {
      const created = addTask(context.chat);
      const transferred = setOwner(created, context.otherChat);
      expect(transferred.entry.owner).toEqual(context.otherChat);
      expect(transferred.entry.revision).toBe(2);
      expect(
        captureLedgerError(() => setStatus(transferred, 'BLOCKED')).reason,
      ).toBe('FORBIDDEN');
      expect(
        setStatus(transferred, 'BLOCKED', context.otherChat).entry.status,
      ).toBe('BLOCKED');
    });

    it('lets the user update and reassign any open entry', () => {
      const created = addTask(context.chat);
      const reassigned = setOwner(created, context.user, context.user);
      expect(reassigned.entry.owner).toEqual(context.user);
      expect(setStatus(reassigned, 'NEEDS_REVIEW', context.user).changed).toBe(
        true,
      );
    });

    it('rejects owners that are unregistered or sidecars', () => {
      const created = addTask(context.chat);
      const stranger: LedgerActorRef = {
        ...context.otherChat,
        actorId: '00000000-0000-4000-8000-00000000ffff',
      };
      for (const owner of [stranger, context.sidecar]) {
        expect(
          captureLedgerError(() => setOwner(created, owner)),
        ).toMatchObject({ reason: 'OWNER_UNAVAILABLE', field: 'owner' });
      }
    });

    it('rejects callers that are not registered in the ledger', () => {
      const created = addTask(context.chat);
      const impostor: LedgerActorRef = {
        ...context.chat,
        kind: 'pipeline_agent',
      };
      expect(
        captureLedgerError(() => setStatus(created, 'BLOCKED', impostor)),
      ).toMatchObject({ reason: 'FORBIDDEN' });
    });
  });

  describe('T05 revision compare-and-swap', () => {
    it('commits exactly one of two commands racing the same revision', async () => {
      const created = addTask();
      const race = await Promise.allSettled(
        (['IN_PROGRESS', 'BLOCKED'] as const).map(
          (
            status: LedgerStatus,
            index: number,
          ): Promise<LedgerCommandReceipt> =>
            Promise.resolve().then(
              (): LedgerCommandReceipt =>
                setStatus(created, status, context.chat, `race-${index}`),
            ),
        ),
      );
      const fulfilled = race.filter((result) => result.status === 'fulfilled');
      const rejected: unknown[] = [];
      for (const result of race) {
        if (result.status !== 'rejected') continue;
        const reason: unknown = result.reason;
        rejected.push(reason);
      }
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const conflict = rejected[0];
      expect(conflict).toBeInstanceOf(LedgerStoreError);
      if (!(conflict instanceof LedgerStoreError)) return;
      expect(conflict.reason).toBe('REVISION_CONFLICT');
      expect(conflict.currentEntry?.revision).toBe(2);

      const current = context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: created.entry.entryId,
        includeHistory: true,
      });
      expect(current.entry.revision).toBe(2);
      expect(current.history?.mutations).toHaveLength(2);
      expect(context.repository.getStorageCounts()).toMatchObject({
        entryVersions: 2,
        mutations: 2,
        receipts: 2,
      });
    });

    it('rejects a stale revision with the current projection', () => {
      const created = addTask();
      const updated = setStatus(created, 'IN_PROGRESS');
      const error = captureLedgerError(() => setStatus(created, 'BLOCKED'));
      expect(error.reason).toBe('REVISION_CONFLICT');
      expect(error.field).toBe('expectedRevision');
      expect(error.currentEntry).toEqual(updated.entry);
      expect(error.toDetails()).toEqual({
        reason: 'REVISION_CONFLICT',
        field: 'expectedRevision',
        currentEntry: updated.entry,
      });
    });

    it('rejects a command issued while another is still in its transaction', () => {
      const created = addTask();
      let nested: unknown = null;
      context.faults.runNext('updateEntry', (): void => {
        nested = captureLedgerError(() =>
          setStatus(created, 'BLOCKED', context.chat, 'nested'),
        );
      });
      const result = setStatus(created, 'IN_PROGRESS', context.chat, 'outer');
      expect(nested).toMatchObject({
        reason: 'STORAGE_UNAVAILABLE',
        diagnosticCode: 'reentrant_command',
      });
      expect(result.entry.status).toBe('IN_PROGRESS');
      expect(result.entry.revision).toBe(2);
      expect(context.repository.getStorageCounts().mutations).toBe(2);
    });
  });

  describe('publishSummary', () => {
    const params: LedgerPublishSummaryParams = {
      snapshotId: 'snapshot-1',
      generationId: 'generation-1',
      title: 'Summary of the work',
      content: 'The ledger store landed.',
      highlights: ['Store', 'Tests'],
      sourceTruncated: false,
    };

    it('creates a SUMMARY/INFO entry owned by the generating helper', () => {
      const receipt = context.repository.publishSummary({
        ledgerId: context.ledgerId,
        helper: context.helper,
        helperDetails: NO_DETAILS,
        params,
        idempotencyKey: `summary:${context.ledgerId}:snapshot-1`,
      });
      expect(receipt.entry).toMatchObject({
        type: 'SUMMARY',
        status: 'INFO',
        author: context.helper,
        owner: context.helper,
        highlights: ['Store', 'Tests'],
        origin: {
          kind: 'summary',
          ledgerId: context.ledgerId,
          snapshotId: 'snapshot-1',
          generationId: 'generation-1',
          helperActorId: context.helper.actorId,
        },
        attribution: {
          kind: 'system',
          effectiveActor: context.helper,
          recordedBy: context.helper,
        },
      });
      expect(
        captureLedgerError(() =>
          context.repository.updateEntry(
            updateInput(
              context,
              context.user,
              {
                entryId: receipt.entry.entryId,
                expectedRevision: 1,
                status: 'TODO',
              },
              nextKey(),
            ),
          ),
        ).reason,
      ).toBe('TERMINAL_ENTRY');
    });

    it('publishes each snapshot once per key', () => {
      const publish = (
        overrides: Partial<LedgerPublishSummaryParams>,
      ): LedgerCommandReceipt =>
        context.repository.publishSummary({
          ledgerId: context.ledgerId,
          helper: context.helper,
          helperDetails: NO_DETAILS,
          params: { ...params, ...overrides },
          idempotencyKey: `summary:${context.ledgerId}:snapshot-1`,
        });
      const first = publish({});
      expect(publish({})).toEqual(first);
      expect(
        captureLedgerError(() => publish({ sourceTruncated: true })).reason,
      ).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(context.repository.getStorageCounts().entries).toBe(1);
    });

    it('accepts only background helpers', () => {
      expect(
        captureLedgerError(() =>
          context.repository.publishSummary({
            ledgerId: context.ledgerId,
            helper: context.chat,
            helperDetails: NO_DETAILS,
            params,
            idempotencyKey: 'summary:chat',
          }),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN', field: 'author' });
    });

    it('lists which publication keys already hold a receipt', () => {
      const key = (snapshotId: string): string =>
        `summary:${context.ledgerId}:${snapshotId}`;
      context.repository.publishSummary({
        ledgerId: context.ledgerId,
        helper: context.helper,
        helperDetails: NO_DETAILS,
        params,
        idempotencyKey: key('snapshot-1'),
      });
      // Another operation's receipt under the same key is not a publication.
      context.repository.addEntry(
        addInput(
          context,
          context.chat,
          { type: 'TASK', title: 'Unrelated', content: 'An Add.' },
          key('snapshot-2'),
        ),
      );

      expect(
        context.repository.listReceiptKeys({
          ledgerId: context.ledgerId,
          operation: 'core.ledger.summary.publish',
          idempotencyKeys: [
            key('snapshot-2'),
            key('snapshot-1'),
            key('snapshot-1'),
          ],
        }),
      ).toEqual([key('snapshot-1')]);
      expect(
        context.repository.listReceiptKeys({
          ledgerId: 'unknown-ledger',
          operation: 'core.ledger.summary.publish',
          idempotencyKeys: [key('snapshot-1')],
        }),
      ).toEqual([]);
      expect(
        context.repository.listReceiptKeys({
          ledgerId: context.ledgerId,
          operation: 'core.ledger.summary.publish',
          idempotencyKeys: [],
        }),
      ).toEqual([]);
    });

    it('bounds receipt-key lookups', () => {
      expect(
        captureLedgerError(() =>
          context.repository.listReceiptKeys({
            ledgerId: context.ledgerId,
            operation: 'core.ledger.entry.delete',
            idempotencyKeys: ['key'],
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'operation' });
      expect(
        captureLedgerError(() =>
          context.repository.listReceiptKeys({
            ledgerId: context.ledgerId,
            operation: 'core.ledger.summary.publish',
            idempotencyKeys: Array.from(
              { length: 101 },
              (_unused, index) => `key-${String(index)}`,
            ),
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'idempotencyKeys' });
    });

    it('rejects SUMMARY through Add', () => {
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              context,
              context.chat,
              withUncheckedFields(
                { type: 'TASK', title: 'Summary', content: 'Not via Add.' },
                { type: 'SUMMARY' },
              ),
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'type' });
      expect(context.repository.getStorageCounts().entries).toBe(0);
    });
  });

  describe('scope lifecycle', () => {
    it('rejects writes to archived scopes while reads and replays still work', () => {
      const created = addTask(context.chat);
      const addKey = `request-${keyCounter}`;
      context.repository.close();
      const raw = new DatabaseSync(context.databasePath);
      raw
        .prepare(
          "UPDATE ledger_scopes SET lifecycle_state = 'archived' WHERE ledger_id = ?",
        )
        .run(context.ledgerId);
      raw.close();

      const reopened = context.reopen();
      expect(
        captureLedgerError(() =>
          reopened.updateEntry(
            updateInput(
              context,
              context.chat,
              {
                entryId: created.entry.entryId,
                expectedRevision: 1,
                status: 'IN_PROGRESS',
              },
              'after-archive',
            ),
          ),
        ).reason,
      ).toBe('SCOPE_RETIRED');
      expect(
        captureLedgerError(() =>
          reopened.registerActor({
            ledgerId: context.ledgerId,
            kind: 'chat',
            authorityId: context.chat.authorityId,
            originKey: 'chat:3',
            displayName: 'Chat 3',
          }),
        ).reason,
      ).toBe('SCOPE_RETIRED');
      // Receipt lookup precedes the lifecycle check.
      expect(
        reopened.addEntry(
          addInput(
            context,
            context.chat,
            {
              type: 'TASK',
              title: 'Ship the ledger',
              content: 'Write the store and its tests.',
            },
            addKey,
          ),
        ),
      ).toEqual(created);
      expect(
        reopened.getEntry({
          ledgerId: context.ledgerId,
          entryId: created.entry.entryId,
        }).entry,
      ).toEqual(created.entry);
      expect(reopened.getScope(context.ledgerId)?.lifecycleState).toBe(
        'archived',
      );
    });
  });

  it('attributes creation to the host-supplied attribution', () => {
    const receipt = addTask(context.user);
    expect(receipt.entry.attribution).toEqual(attributionFor(context.user));
    expect(receipt.entry.origin).toEqual({
      kind: 'user',
      ledgerId: context.ledgerId,
      userActorId: context.user.actorId,
    });
  });

  describe('global scopes', () => {
    const GLOBAL_TASK = {
      type: 'TASK',
      title: 'Review the release run',
      content: 'Check the pipeline output.',
    } as const;

    /** A Personal global Ledger with one pipeline agent. */
    function seedGlobal(): {
      readonly ledgerId: string;
      readonly agent: LedgerActorRef;
    } {
      const ledgerId = bindGlobal(
        context.repository,
        PERSONAL_OWNER,
        'account-1',
      ).scope.ledgerId;
      return {
        ledgerId,
        agent: registerTestActor(
          context.repository,
          ledgerId,
          'pipeline_agent',
          'pipeline:attempt-1',
          'Review step',
        ),
      };
    }

    it('rejects reference files without writing, and accepts entries without them', () => {
      const { ledgerId, agent } = seedGlobal();
      const counts = context.repository.getStorageCounts();
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              { ledgerId },
              agent,
              {
                ...GLOBAL_TASK,
                referenceFiles: [{ rootId: 'repo', path: 'src/release.ts' }],
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'referenceFiles' });
      expect(context.repository.getStorageCounts()).toEqual(counts);

      const added = context.repository.addEntry(
        addInput(
          { ledgerId },
          agent,
          { ...GLOBAL_TASK, referenceFiles: [] },
          nextKey(),
        ),
      );
      expect(added.entry).toMatchObject({
        scope: { ledgerId, container: { kind: 'global' } },
        referenceFiles: [],
        status: 'TODO',
      });
      // Status, revision and correction rules are those of any scope.
      const started = context.repository.updateEntry(
        updateInput(
          { ledgerId },
          agent,
          {
            entryId: added.entry.entryId,
            expectedRevision: 1,
            status: 'IN_PROGRESS',
          },
          nextKey(),
        ),
      );
      expect(started.entry.revision).toBe(2);
      expect(
        captureLedgerError(() =>
          context.repository.updateEntry(
            updateInput(
              { ledgerId },
              agent,
              {
                entryId: added.entry.entryId,
                expectedRevision: 1,
                status: 'COMPLETED',
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'REVISION_CONFLICT' });
      // A correction may not reference files either.
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              { ledgerId },
              agent,
              {
                type: 'DECISION',
                title: 'Corrected review',
                content: 'Supersedes the task.',
                supersedesEntryId: added.entry.entryId,
                referenceFiles: [{ rootId: 'repo', path: 'src/release.ts' }],
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'referenceFiles' });
    });

    it('never links a correction across Ledgers', () => {
      const { ledgerId, agent } = seedGlobal();
      const taskEntry = addTask();
      const globalEntry = context.repository.addEntry(
        addInput({ ledgerId }, agent, GLOBAL_TASK, nextKey()),
      );
      const counts = context.repository.getStorageCounts();
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              { ledgerId },
              agent,
              {
                type: 'DECISION',
                title: 'Cross-Ledger correction',
                content: 'Names a task entry.',
                supersedesEntryId: taskEntry.entry.entryId,
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'supersedesEntryId' });
      expect(
        captureLedgerError(() =>
          context.repository.addEntry(
            addInput(
              context,
              context.chat,
              {
                type: 'DECISION',
                title: 'Cross-Ledger correction',
                content: 'Names a global entry.',
                supersedesEntryId: globalEntry.entry.entryId,
              },
              nextKey(),
            ),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'supersedesEntryId' });
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });
  });
});
