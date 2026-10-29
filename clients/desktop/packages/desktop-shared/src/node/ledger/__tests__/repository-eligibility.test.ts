import type {
  LedgerActorRef,
  LedgerCommandReceipt,
} from '@canopy/protocol/canopy-core';

import type { LedgerAddEntryInput, LedgerUpdateEntryInput } from '../types';
import {
  addInput,
  captureLedgerError,
  setUpLedger,
  updateInput,
  type LedgerTestContext,
} from './ledger-test-harness';

describe('LedgerRepository owner eligibility verdict', () => {
  let context: LedgerTestContext;
  let keyCounter = 0;

  function nextKey(): string {
    keyCounter += 1;
    return `request-${keyCounter}`;
  }

  function addTask(
    actor: LedgerActorRef = context.chat,
    overrides: Partial<LedgerAddEntryInput> = {},
  ): LedgerCommandReceipt {
    return context.repository.addEntry(
      addInput(
        context,
        actor,
        {
          type: 'TASK',
          title: 'Ship the ledger',
          content: 'Write the store and its tests.',
        },
        nextKey(),
        overrides,
      ),
    );
  }

  /** An Update that requests only an owner change, to `newOwner`. */
  function ownerChangeInput(
    receipt: LedgerCommandReceipt,
    newOwner: LedgerActorRef,
    actor: LedgerActorRef,
    key: string,
    overrides: Partial<LedgerUpdateEntryInput> = {},
  ): LedgerUpdateEntryInput {
    return updateInput(
      context,
      actor,
      {
        entryId: receipt.entry.entryId,
        expectedRevision: receipt.entry.revision,
        owner: { actorId: newOwner.actorId, eligibilityToken: 'token' },
      },
      key,
      { newOwner, ...overrides },
    );
  }

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  describe('addEntry', () => {
    it('rejects an explicit owner the host marks ineligible and writes nothing', () => {
      const counts = context.repository.getStorageCounts();
      const error = captureLedgerError(() =>
        context.repository.addEntry(
          addInput(
            context,
            context.chat,
            {
              type: 'TASK',
              title: 'Review the store',
              content: 'Please review.',
              owner: {
                actorId: context.user.actorId,
                eligibilityToken: 'token',
              },
            },
            nextKey(),
            { owner: context.user, ownerEligible: false },
          ),
        ),
      );
      expect(error).toMatchObject({
        reason: 'OWNER_UNAVAILABLE',
        field: 'owner',
      });
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('accepts an explicit owner the host marks eligible, including the implicit default', () => {
      const verdicts: readonly Partial<LedgerAddEntryInput>[] = [
        { ownerEligible: true },
        {},
      ];
      for (const verdict of verdicts) {
        const receipt = context.repository.addEntry(
          addInput(
            context,
            context.chat,
            {
              type: 'TASK',
              title: 'Review the store',
              content: 'Please review.',
              owner: {
                actorId: context.user.actorId,
                eligibilityToken: 'token',
              },
            },
            nextKey(),
            { owner: context.user, ...verdict },
          ),
        );
        expect(receipt.entry.owner).toEqual(context.user);
        expect(receipt.entry.author).toEqual(context.chat);
      }
    });

    it('ignores an ineligible verdict when the owner is the author', () => {
      const receipt = addTask(context.chat, { ownerEligible: false });
      expect(receipt.entry.owner).toEqual(context.chat);
      expect(receipt.entry.author).toEqual(context.chat);
    });
  });

  describe('updateEntry', () => {
    it('rejects an owner change the host marks ineligible and leaves the entry unchanged', () => {
      const created = addTask();
      const counts = context.repository.getStorageCounts();
      const error = captureLedgerError(() =>
        context.repository.updateEntry(
          ownerChangeInput(
            created,
            context.otherChat,
            context.chat,
            nextKey(),
            {
              ownerEligible: false,
            },
          ),
        ),
      );
      expect(error).toMatchObject({
        reason: 'OWNER_UNAVAILABLE',
        field: 'owner',
      });
      expect(context.repository.getStorageCounts()).toEqual(counts);
      expect(
        context.repository.getEntry({
          ledgerId: context.ledgerId,
          entryId: created.entry.entryId,
        }).entry,
      ).toEqual(created.entry);
    });

    it('reports a stale revision before considering the eligibility verdict', () => {
      const created = addTask();
      context.repository.updateEntry(
        updateInput(
          context,
          context.chat,
          {
            entryId: created.entry.entryId,
            expectedRevision: created.entry.revision,
            status: 'IN_PROGRESS',
          },
          nextKey(),
        ),
      );
      // `created` still carries the pre-update revision, now stale.
      const error = captureLedgerError(() =>
        context.repository.updateEntry(
          ownerChangeInput(
            created,
            context.otherChat,
            context.chat,
            nextKey(),
            {
              ownerEligible: false,
            },
          ),
        ),
      );
      expect(error).toMatchObject({
        reason: 'REVISION_CONFLICT',
        field: 'expectedRevision',
      });
    });

    it('reports a terminal entry before considering the eligibility verdict', () => {
      const created = addTask();
      const closed = context.repository.updateEntry(
        updateInput(
          context,
          context.chat,
          {
            entryId: created.entry.entryId,
            expectedRevision: created.entry.revision,
            status: 'COMPLETED',
          },
          nextKey(),
        ),
      );
      const error = captureLedgerError(() =>
        context.repository.updateEntry(
          ownerChangeInput(closed, context.otherChat, context.chat, nextKey(), {
            ownerEligible: false,
          }),
        ),
      );
      expect(error.reason).toBe('TERMINAL_ENTRY');
    });

    it('reports a forbidden caller before considering the eligibility verdict', () => {
      const created = addTask(context.chat);
      const error = captureLedgerError(() =>
        context.repository.updateEntry(
          ownerChangeInput(
            created,
            context.otherChat,
            context.otherChat,
            nextKey(),
            { ownerEligible: false },
          ),
        ),
      );
      expect(error).toMatchObject({ reason: 'FORBIDDEN', field: 'owner' });
    });

    it('ignores the eligibility verdict for a status-only update', () => {
      const created = addTask();
      const updated = context.repository.updateEntry(
        updateInput(
          context,
          context.chat,
          {
            entryId: created.entry.entryId,
            expectedRevision: created.entry.revision,
            status: 'IN_PROGRESS',
          },
          nextKey(),
          { ownerEligible: false },
        ),
      );
      expect(updated.entry.status).toBe('IN_PROGRESS');
      expect(updated.entry.owner).toEqual(context.chat);
    });

    it('ignores the eligibility verdict for an owner "change" to the current owner', () => {
      const created = addTask();
      const noop = context.repository.updateEntry(
        ownerChangeInput(created, context.chat, context.chat, nextKey(), {
          ownerEligible: false,
        }),
      );
      expect(noop.changed).toBe(false);
      expect(noop.entry).toEqual(created.entry);
    });
  });

  describe('stale-token replay', () => {
    it('replays an accepted owner assignment from Add even after the token goes stale', () => {
      const request = addInput(
        context,
        context.chat,
        {
          type: 'TASK',
          title: 'Review the store',
          content: 'Please review.',
          owner: { actorId: context.user.actorId, eligibilityToken: 'token' },
        },
        'owner-assign-1',
        { owner: context.user, ownerEligible: true },
      );
      const original = context.repository.addEntry(request);
      const counts = context.repository.getStorageCounts();
      const stale: LedgerAddEntryInput = { ...request, ownerEligible: false };
      expect(context.repository.addEntry(stale)).toEqual(original);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('replays an accepted owner change from Update even after the token goes stale', () => {
      const created = addTask();
      const request = ownerChangeInput(
        created,
        context.otherChat,
        context.chat,
        'owner-change-1',
        { ownerEligible: true },
      );
      const original = context.repository.updateEntry(request);
      const counts = context.repository.getStorageCounts();
      const stale: LedgerUpdateEntryInput = {
        ...request,
        ownerEligible: false,
      };
      expect(context.repository.updateEntry(stale)).toEqual(original);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });
  });
});
