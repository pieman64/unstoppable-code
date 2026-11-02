import { DatabaseSync } from 'node:sqlite';

import type {
  LedgerAddEntryParams,
  LedgerCommandReceipt,
} from '@canopy/protocol/canopy-core';

import {
  AUTHORITY_ID,
  PERSONAL_OWNER,
  readGlobalBindings,
  worktreeContainer,
  addInput,
  captureLedgerError,
  setUpLedger,
  updateInput,
  type LedgerTestContext,
} from './ledger-test-harness';

const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Preserve summary publication',
  content: 'Add a durable publication receipt.',
  highlights: ['Keep the writer'],
  referenceFiles: [{ rootId: 'repo', path: 'src/summary.ts', startLine: 12 }],
};

interface OutboxRow {
  readonly sequence: number;
  readonly kind: string;
}

function readOutbox(databasePath: string): OutboxRow[] {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return raw
      .prepare(
        'SELECT scope_sequence, kind FROM ledger_outbox ORDER BY scope_sequence',
      )
      .all()
      .map(
        (row): OutboxRow => ({
          sequence: Number(row.scope_sequence),
          kind: String(row.kind),
        }),
      );
  } finally {
    raw.close();
  }
}

describe('LedgerRepository idempotency and atomicity (T06)', () => {
  let context: LedgerTestContext;

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  function add(
    params: LedgerAddEntryParams,
    key: string,
    actor = context.chat,
  ): LedgerCommandReceipt {
    return context.repository.addEntry(addInput(context, actor, params, key));
  }

  it('replays the original Add receipt without writing anything', () => {
    const original = add(TASK, 'add-1');
    const counts = context.repository.getStorageCounts();
    context.clock.advance(30_000);
    expect(add(TASK, 'add-1')).toEqual(original);
    expect(context.repository.getStorageCounts()).toEqual(counts);
  });

  it('replays the stored receipt exactly, even when host context was re-captured', () => {
    const first = addInput(context, context.chat, TASK, 'add-1', {
      origin: {
        kind: 'chat',
        ledgerId: context.ledgerId,
        chatId: 'chat-1',
        toolCallId: 'call-1',
        turnId: undefined,
      },
    });
    const original = context.repository.addEntry(first);
    // A retry from a later tool call: new anchor, re-read settings.
    const retry = addInput(context, context.chat, TASK, 'add-1', {
      origin: {
        kind: 'chat',
        ledgerId: context.ledgerId,
        chatId: 'chat-1',
        toolCallId: 'call-2',
      },
      authorDetails: { ...first.authorDetails, model: 'another-model' },
    });
    expect(context.repository.addEntry(retry)).toStrictEqual(original);
    expect(original.entry.origin).toStrictEqual({
      kind: 'chat',
      ledgerId: context.ledgerId,
      chatId: 'chat-1',
      toolCallId: 'call-1',
    });
  });

  it('replays requests that differ only before normalization', () => {
    const original = add(TASK, 'add-1');
    const equivalent: LedgerAddEntryParams = {
      ...TASK,
      title: `  ${TASK.title}  `,
      status: 'TODO',
      owner: 'self',
      referenceFiles: [
        { rootId: 'repo', path: 'src/summary.ts', startLine: 12 },
        { rootId: 'repo', path: 'src/summary.ts', startLine: 12 },
      ],
    };
    expect(add(equivalent, 'add-1')).toEqual(original);
    expect(context.repository.getStorageCounts().entries).toBe(1);
  });

  it('rejects a reused key with different input and writes nothing', () => {
    add(TASK, 'add-1');
    const counts = context.repository.getStorageCounts();
    for (const changed of [
      { ...TASK, title: 'Another title' },
      { ...TASK, status: 'BLOCKED' as const },
      { ...TASK, highlights: [] },
      { ...TASK, referenceFiles: [] },
    ]) {
      expect(captureLedgerError(() => add(changed, 'add-1'))).toMatchObject({
        reason: 'IDEMPOTENCY_KEY_REUSED',
        field: 'idempotencyKey',
      });
    }
    expect(context.repository.getStorageCounts()).toEqual(counts);
  });

  it('scopes keys to the calling actor', () => {
    const first = add(TASK, 'shared-key', context.chat);
    const second = add(TASK, 'shared-key', context.otherChat);
    expect(second.entry.entryId).not.toBe(first.entry.entryId);
    expect(second.entry.author).toEqual(context.otherChat);
  });

  it('replays Update receipts, including no-ops, and rejects reuse', () => {
    const created = add(TASK, 'add-1');
    const update = updateInput(
      context,
      context.chat,
      {
        entryId: created.entry.entryId,
        expectedRevision: 1,
        status: 'IN_PROGRESS',
      },
      'update-1',
    );
    const updated = context.repository.updateEntry(update);
    expect(context.repository.updateEntry(update)).toEqual(updated);

    const noop = updateInput(
      context,
      context.chat,
      {
        entryId: created.entry.entryId,
        expectedRevision: 2,
        status: 'IN_PROGRESS',
      },
      'noop-1',
    );
    const noopReceipt = context.repository.updateEntry(noop);
    expect(noopReceipt.changed).toBe(false);
    expect(context.repository.updateEntry(noop)).toEqual(noopReceipt);

    expect(
      captureLedgerError(() =>
        context.repository.updateEntry({
          ...update,
          params: { ...update.params, status: 'BLOCKED' },
        }),
      ).reason,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(context.repository.getStorageCounts()).toMatchObject({
      entryVersions: 2,
      mutations: 2,
      receipts: 3,
    });
  });

  it('rolls back a failed Add completely and lets the same key succeed later', () => {
    const counts = context.repository.getStorageCounts();
    const sequence = context.repository.getScope(context.ledgerId)?.sequence;
    context.faults.failNext('addEntry');
    expect(captureLedgerError(() => add(TASK, 'add-1'))).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      diagnosticCode: 'unexpected',
    });
    expect(context.repository.getStorageCounts()).toEqual(counts);
    expect(context.repository.getScope(context.ledgerId)?.sequence).toBe(
      sequence,
    );
    expect(
      context.repository.searchEntries({
        ledgerId: context.ledgerId,
        query: 'publication',
      }).entries,
    ).toEqual([]);

    const retried = add(TASK, 'add-1');
    expect(retried.localSequence).toBe(String(Number(sequence) + 1));
    expect(context.repository.getStorageCounts()).toEqual({
      ...counts,
      entries: 1,
      entryVersions: 1,
      mutations: 1,
      receipts: 1,
      outbox: counts.outbox + 1,
      searchRows: 1,
    });
  });

  it('rolls back a failed Update and leaves the entry unchanged', () => {
    const created = add(TASK, 'add-1');
    const counts = context.repository.getStorageCounts();
    const update = updateInput(
      context,
      context.chat,
      {
        entryId: created.entry.entryId,
        expectedRevision: 1,
        status: 'COMPLETED',
      },
      'complete',
    );
    context.faults.failNext('updateEntry');
    expect(
      captureLedgerError(() => context.repository.updateEntry(update)),
    ).toMatchObject({ reason: 'STORAGE_UNAVAILABLE' });
    expect(context.repository.getStorageCounts()).toEqual(counts);
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: created.entry.entryId,
      }).entry,
    ).toEqual(created.entry);
    expect(context.repository.updateEntry(update).entry.status).toBe(
      'COMPLETED',
    );
  });

  it('rolls back failed scope bindings and actor registrations', () => {
    const counts = context.repository.getStorageCounts();
    context.faults.failNext('bindScope');
    captureLedgerError(() =>
      context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer('worktree-2'),
        containerCreatedAt: '2026-09-02T00:00:00Z',
        accountId: null,
      }),
    );
    context.faults.failNext('registerActor');
    captureLedgerError(() =>
      context.repository.registerActor({
        ledgerId: context.ledgerId,
        kind: 'chat',
        authorityId: AUTHORITY_ID,
        originKey: 'chat:3',
        displayName: 'Chat 3',
      }),
    );
    expect(context.repository.getStorageCounts()).toEqual(counts);
  });

  it('rolls back a failed global binding completely, binding nothing', () => {
    const counts = context.repository.getStorageCounts();
    context.faults.failNext('bindGlobalScope');
    expect(
      captureLedgerError(() =>
        context.repository.bindGlobalScope({
          authorityId: AUTHORITY_ID,
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        }),
      ).reason,
    ).toBe('STORAGE_UNAVAILABLE');
    expect(context.repository.getStorageCounts()).toEqual(counts);
    expect(
      context.repository.findGlobalScope({
        owner: PERSONAL_OWNER,
        accountId: 'account-1',
      }),
    ).toBeNull();

    // The next attempt mints the one binding, with its registration event.
    const bound = context.repository.bindGlobalScope({
      authorityId: AUTHORITY_ID,
      owner: PERSONAL_OWNER,
      accountId: 'account-1',
    });
    expect(bound.created).toBe(true);
    expect(context.repository.getStorageCounts()).toEqual({
      ...counts,
      scopes: counts.scopes + 1,
      outbox: counts.outbox + 1,
    });
    context.repository.close();
    expect(readGlobalBindings(context.databasePath)).toEqual([
      {
        ownerKey: 'personal',
        accountKey: 'account:account-1',
        ledgerId: bound.scope.scope.ledgerId,
      },
    ]);
  });

  it('writes one contiguous outbox event per accepted change', () => {
    const created = add(TASK, 'add-1');
    context.repository.updateEntry(
      updateInput(
        context,
        context.chat,
        {
          entryId: created.entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
        },
        'update-1',
      ),
    );
    // A no-op writes a receipt but no event.
    context.repository.updateEntry(
      updateInput(
        context,
        context.chat,
        {
          entryId: created.entry.entryId,
          expectedRevision: 2,
          status: 'IN_PROGRESS',
        },
        'noop-1',
      ),
    );
    context.repository.close();
    expect(readOutbox(context.databasePath)).toEqual([
      { sequence: 1, kind: 'scope_registered' },
      { sequence: 2, kind: 'actor_registered' },
      { sequence: 3, kind: 'actor_registered' },
      { sequence: 4, kind: 'actor_registered' },
      { sequence: 5, kind: 'actor_registered' },
      { sequence: 6, kind: 'actor_registered' },
      { sequence: 7, kind: 'entry_revision' },
      { sequence: 8, kind: 'entry_revision' },
    ]);
  });
});
