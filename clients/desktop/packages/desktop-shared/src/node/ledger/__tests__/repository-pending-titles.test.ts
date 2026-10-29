import { createHash } from 'node:crypto';

import type {
  LedgerAddEntryParams,
  LedgerCommandReceipt,
  LedgerEntry,
} from '@canopy/protocol/canopy-core';
import {
  LedgerEntrySchema,
  LedgerMutationSchema,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';

import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  addInput,
  captureLedgerError,
  readLedgerDatabase,
  registerTestActor,
  setUpLedger,
  updateInput,
  worktreeContainer,
  type LedgerTestContext,
} from './ledger-test-harness';

const PENDING_TASK: LedgerAddEntryParams = {
  type: 'TASK',
  content: 'Draft title\nBody without searchable title words.',
};

const LedgerEntryEventPayloadSchema = z.strictObject({
  entry: LedgerEntrySchema,
  mutation: LedgerMutationSchema,
  publication: z.strictObject({ sourceTruncated: z.boolean() }).optional(),
});

function mirrorImmutableFields(entry: LedgerEntry): unknown {
  return {
    entryId: entry.entryId,
    ledgerId: entry.scope.ledgerId,
    authorityId: entry.scope.authorityId,
    createdAt: entry.createdAt,
    author: entry.author,
    authorDetails: entry.authorDetails,
    type: entry.type,
    title: entry.title,
    content: entry.content,
    highlights: entry.highlights,
    referenceFiles: entry.referenceFiles,
    origin: entry.origin,
    attribution: entry.attribution,
    supersedesEntryId: entry.supersedesEntryId,
  };
}

describe('LedgerRepository pending titles', () => {
  let context: LedgerTestContext;
  let keyCounter = 0;

  function nextKey(): string {
    keyCounter += 1;
    return `pending-title-${keyCounter}`;
  }

  function addPending(): LedgerCommandReceipt & {
    readonly idempotencyKey: string;
  } {
    const idempotencyKey = nextKey();
    return {
      ...context.repository.addEntry(
        addInput(context, context.chat, PENDING_TASK, idempotencyKey),
      ),
      idempotencyKey,
    };
  }

  beforeEach(() => {
    context = setUpLedger();
    keyCounter = 0;
  });

  afterEach(() => {
    context.dispose();
  });

  it('marks only title-omitted Add entries in local get and search results', () => {
    const pending = addPending();
    const explicit = context.repository.addEntry(
      addInput(
        context,
        context.chat,
        { ...PENDING_TASK, title: 'Handwritten title' },
        nextKey(),
      ),
    );

    expect(pending.entry.title).toBe(
      'Draft title Body without searchable title words.',
    );
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: pending.entry.entryId,
      }),
    ).toMatchObject({
      titlePending: true,
      entry: { title: pending.entry.title },
    });
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: pending.entry.entryId,
      }).entry,
    ).not.toHaveProperty('titlePending');
    expect(
      context.repository.searchEntries({ ledgerId: context.ledgerId }).entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: pending.entry.entryId,
          titlePending: true,
        }),
        expect.objectContaining({
          entryId: explicit.entry.entryId,
          title: 'Handwritten title',
        }),
      ]),
    );
    expect(context.repository.listPendingTitles()).toEqual([
      {
        entryId: pending.entry.entryId,
        ledgerId: context.ledgerId,
        createdAt: context.clock.iso(),
        attempts: 0,
        lastAttemptAt: null,
      },
    ]);
  });

  it('records attempts and timestamps transactionally, returning null after resolution', () => {
    const pending = addPending();
    const entryId = pending.entry.entryId;

    context.clock.advance(1_000);
    expect(context.repository.recordPendingTitleAttempt({ entryId })).toEqual({
      entryId,
      ledgerId: context.ledgerId,
      createdAt: pending.entry.createdAt,
      attempts: 1,
      lastAttemptAt: context.clock.iso(),
    });

    context.clock.advance(1_000);
    expect(
      context.repository.recordPendingTitleAttempt({ entryId }),
    ).toMatchObject({ attempts: 2, lastAttemptAt: context.clock.iso() });

    context.faults.failNext('recordPendingTitleAttempt');
    expect(
      captureLedgerError(() =>
        context.repository.recordPendingTitleAttempt({ entryId }),
      ),
    ).toMatchObject({ reason: 'STORAGE_UNAVAILABLE' });
    expect(context.repository.listPendingTitles()).toMatchObject([
      { entryId, attempts: 2, lastAttemptAt: '2026-09-28T12:00:02.000Z' },
    ]);

    expect(
      context.repository.recordPendingTitleAttempt({
        entryId: '00000000-0000-4000-8000-00000000ffff',
      }),
    ).toBeNull();
  });

  it('holds a scope outbox at its first pending entry, including later revisions', () => {
    const pending = addPending();
    context.repository.updateEntry(
      updateInput(
        context,
        context.chat,
        {
          entryId: pending.entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
        },
        nextKey(),
      ),
    );
    const laterEntry = context.repository.addEntry(
      addInput(
        context,
        context.chat,
        {
          type: 'TASK',
          title: 'Later scope entry',
          content: 'Held behind title.',
        },
        nextKey(),
      ),
    );

    const secondLedgerId = context.repository.bindScope({
      authorityId: AUTHORITY_ID,
      container: worktreeContainer('worktree-pending-title-other'),
      containerCreatedAt: CONTAINER_CREATED_AT,
      accountId: 'account-1',
    }).scope.scope.ledgerId;
    const secondUser = registerTestActor(
      context.repository,
      secondLedgerId,
      'user',
      'user:other',
      'Other user',
    );
    const otherScopeEntry = context.repository.addEntry(
      addInput(
        { ledgerId: secondLedgerId },
        secondUser,
        { type: 'TASK', title: 'Other scope', content: 'Not held.' },
        nextKey(),
      ),
    );

    expect(
      context.repository
        .readOutbox({
          ledgerId: context.ledgerId,
          afterSequence: '0',
          limit: 100,
        })
        .map((event) => event.scopeSequence),
    ).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(
      context.repository
        .readOutbox({
          ledgerId: context.ledgerId,
          afterSequence: '0',
          limit: 100,
        })
        .map((event) => event.entryId),
    ).not.toContain(laterEntry.entry.entryId);
    expect(
      context.repository.readOutbox({
        ledgerId: secondLedgerId,
        afterSequence: '0',
        limit: 100,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryId: otherScopeEntry.entry.entryId }),
      ]),
    );
  });

  it('normalizes and resolves a title in place without changing revision or receipt', () => {
    const pending = addPending();
    const updated = context.repository.updateEntry(
      updateInput(
        context,
        context.chat,
        {
          entryId: pending.entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
        },
        nextKey(),
      ),
    );
    const revision = updated.entry.revision;
    const updatedAt = updated.entry.updatedAt;

    const resolved = context.repository.resolvePendingTitle({
      entryId: pending.entry.entryId,
      title: '\n Better\t title  \t',
    });

    expect(resolved).toMatchObject({
      resolved: true,
      entry: {
        entryId: pending.entry.entryId,
        revision,
        updatedAt,
        title: 'Better title',
        status: 'IN_PROGRESS',
      },
    });
    expect(context.repository.listPendingTitles()).toEqual([]);
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: pending.entry.entryId,
      }),
    ).not.toHaveProperty('titlePending');
    expect(
      context.repository.searchEntries({
        ledgerId: context.ledgerId,
        query: 'better',
      }).entries,
    ).toMatchObject([
      { entryId: pending.entry.entryId, title: 'Better title' },
    ]);
    const outbox = context.repository.readOutbox({
      ledgerId: context.ledgerId,
      afterSequence: '0',
      limit: 100,
    });
    const entryEvents = outbox.filter(
      (event) => event.kind === 'entry_revision',
    );
    expect(entryEvents).toHaveLength(2);
    const parsedEntryEvents = entryEvents.map((event) =>
      LedgerEntryEventPayloadSchema.parse(JSON.parse(event.payloadJson)),
    );
    expect(parsedEntryEvents).toMatchObject([
      {
        entry: {
          entryId: pending.entry.entryId,
          revision: 1,
          status: 'TODO',
          title: 'Better title',
        },
      },
      {
        entry: {
          entryId: pending.entry.entryId,
          revision: 2,
          status: 'IN_PROGRESS',
          title: 'Better title',
        },
      },
    ]);
    for (const event of entryEvents) {
      expect(
        createHash('sha256').update(event.payloadJson, 'utf8').digest('hex'),
      ).toBe(event.payloadHash);
    }
    const firstPayload = parsedEntryEvents[0];
    const secondPayload = parsedEntryEvents[1];
    if (firstPayload === undefined || secondPayload === undefined) {
      throw new Error('Expected two entry revision events');
    }
    expect(mirrorImmutableFields(firstPayload.entry)).toEqual(
      mirrorImmutableFields(secondPayload.entry),
    );
    expect(secondPayload.mutation).toMatchObject({
      kind: 'update',
      revision: 2,
      previousRevision: 1,
      status: { from: 'TODO', to: 'IN_PROGRESS' },
    });

    context.repository.close();
    const rawState = readLedgerDatabase(context.databasePath, (raw) => {
      const currentProjection = raw
        .prepare(
          'SELECT projection_json FROM ledger_entries WHERE entry_id = ?',
        )
        .get(pending.entry.entryId);
      const versions = raw
        .prepare(
          'SELECT revision, projection_json FROM ledger_entry_versions WHERE entry_id = ? ORDER BY revision',
        )
        .all(pending.entry.entryId)
        .map((row) => ({
          revision: String(row.revision),
          projectionJson: String(row.projection_json),
        }));
      const fts = raw
        .prepare(
          'SELECT title, content FROM ledger_search WHERE rowid = (SELECT entry_rowid FROM ledger_entries WHERE entry_id = ?)',
        )
        .get(pending.entry.entryId);
      const titleMatches = raw.prepare(
        'SELECT count(*) AS matches FROM ledger_search WHERE ledger_search MATCH ?',
      );

      return {
        currentProjection: String(currentProjection?.projection_json ?? ''),
        versions,
        ftsTitle: String(fts?.title ?? ''),
        ftsContent: String(fts?.content ?? ''),
        ftsTitleMatchesNewTitle: String(
          titleMatches.get('title : "Better"')?.matches ?? '',
        ),
        ftsTitleMatchesOldProvisionalTitle: String(
          titleMatches.get('title : "Draft"')?.matches ?? '',
        ),
      };
    });
    expect(rawState.currentProjection).toContain('Better title');
    expect(rawState.versions).toHaveLength(2);
    expect(rawState.versions.map((version) => version.revision)).toEqual([
      '1',
      '2',
    ]);
    for (const version of rawState.versions) {
      expect(version.projectionJson).toContain('Better title');
    }
    expect(rawState.ftsTitle).toBe('Better title');
    expect(rawState.ftsContent).toBe(PENDING_TASK.content);
    expect(rawState.ftsTitleMatchesNewTitle).toBe('1');
    expect(rawState.ftsTitleMatchesOldProvisionalTitle).toBe('0');

    const reopened = context.reopen();
    const replay = reopened.addEntry(
      addInput(context, context.chat, PENDING_TASK, pending.idempotencyKey),
    );
    expect(replay).toEqual({
      entry: pending.entry,
      changed: pending.changed,
      mutationId: pending.mutationId,
      localSequence: pending.localSequence,
      syncState: pending.syncState,
    });
  });

  it.each([
    ['null title', null],
    ['invalid title', 'x'.repeat(101)],
    ['unchanged title', 'Draft title Body without searchable title words.'],
    ['empty title', ''],
    ['whitespace-only title', '  \n\t  '],
  ])('clears a marker without rewriting when given %s', (_label, title) => {
    const pending = addPending();
    const result = context.repository.resolvePendingTitle({
      entryId: pending.entry.entryId,
      title,
    });

    expect(result).toEqual({ resolved: true, entry: pending.entry });
    expect(context.repository.listPendingTitles()).toEqual([]);
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: pending.entry.entryId,
      }).entry.title,
    ).toBe(pending.entry.title);
  });

  it('does not rewrite an entry whose first revision was acknowledged', () => {
    const pending = addPending();
    context.repository.acknowledgeOutbox({
      ledgerId: context.ledgerId,
      sequence: pending.localSequence,
    });
    const result = context.repository.resolvePendingTitle({
      entryId: pending.entry.entryId,
      title: 'Do not rewrite acknowledged content',
    });

    expect(result).toEqual({ resolved: true, entry: pending.entry });
    expect(context.repository.listPendingTitles()).toEqual([]);
    expect(
      context.repository.searchEntries({ ledgerId: context.ledgerId }).entries,
    ).toMatchObject([{ title: pending.entry.title }]);
  });

  it('rolls back every title projection and marker change if commit fails', () => {
    const pending = addPending();
    const heldOutbox = context.repository.readOutbox({
      ledgerId: context.ledgerId,
      afterSequence: '0',
      limit: 100,
    });
    context.faults.failNext('resolvePendingTitle');

    const error = captureLedgerError(() =>
      context.repository.resolvePendingTitle({
        entryId: pending.entry.entryId,
        title: 'Replacement title',
      }),
    );

    expect(error).toMatchObject({ reason: 'STORAGE_UNAVAILABLE' });
    expect(context.repository.listPendingTitles()).toHaveLength(1);
    expect(
      context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: pending.entry.entryId,
      }),
    ).toMatchObject({
      titlePending: true,
      entry: { title: pending.entry.title, revision: 1 },
    });
    expect(
      context.repository.readOutbox({
        ledgerId: context.ledgerId,
        afterSequence: '0',
        limit: 100,
      }),
    ).toEqual(heldOutbox);
    expect(
      context.repository.searchEntries({
        ledgerId: context.ledgerId,
        query: 'replacement',
      }).entries,
    ).toEqual([]);
  });

  it('removes pending title markers when their scope is purged', () => {
    const pending = addPending();
    context.repository.setScopeLifecycle({
      ledgerId: context.ledgerId,
      state: 'retirement_pending',
    });

    expect(context.repository.purgeScope(context.ledgerId)).toEqual({
      purged: true,
    });
    expect(context.repository.listPendingTitles()).toEqual([]);
    expect(
      context.repository.resolvePendingTitle({
        entryId: pending.entry.entryId,
        title: 'After purge',
      }),
    ).toEqual({ resolved: false, entry: null });
  });

  it('returns unresolved with a null entry when no marker exists', () => {
    expect(
      context.repository.resolvePendingTitle({
        entryId: '00000000-0000-4000-8000-00000000ffff',
        title: 'No pending marker',
      }),
    ).toEqual({ resolved: false, entry: null });
  });
});
