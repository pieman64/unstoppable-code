import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  LEDGER_LIMITS,
  type LedgerActorRef,
  type LedgerAddEntryParams,
  type LedgerCommandReceipt,
  type LedgerEntrySearchItem,
  type LedgerStatus,
} from '@canopy/protocol/canopy-core';

import { LedgerRepository } from '../repository';
import {
  buildLedgerSearchPageStatement,
  normalizeLedgerSearch,
  type LedgerSearchPagePosition,
} from '../search';
import type { LedgerSearchEntriesInput } from '../types';
import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  WORKTREE_CONTAINER,
  worktreeContainer,
  addInput,
  captureLedgerError,
  createTempDirectory,
  removeTempDirectory,
  setUpLedger,
  updateInput,
  type LedgerTestContext,
} from './ledger-test-harness';

describe('LedgerRepository search (T07)', () => {
  let context: LedgerTestContext;
  let keyCounter = 0;

  function add(
    params: LedgerAddEntryParams,
    actor: LedgerActorRef = context.chat,
    owner: LedgerActorRef = actor,
  ): LedgerCommandReceipt {
    keyCounter += 1;
    const ownerTarget =
      owner.actorId === actor.actorId
        ? {}
        : { owner: { actorId: owner.actorId, eligibilityToken: 'token' } };
    return context.repository.addEntry(
      addInput(
        context,
        actor,
        { ...params, ...ownerTarget },
        `search-${keyCounter}`,
        { owner },
      ),
    );
  }

  function note(title: string, content = 'Details.'): LedgerCommandReceipt {
    return add({ type: 'OBSERVATION', title, content });
  }

  function setStatus(
    receipt: LedgerCommandReceipt,
    status: LedgerStatus,
  ): LedgerCommandReceipt {
    keyCounter += 1;
    const current = context.repository.getEntry({
      ledgerId: context.ledgerId,
      entryId: receipt.entry.entryId,
    }).entry;
    return context.repository.updateEntry(
      updateInput(
        context,
        context.user,
        {
          entryId: current.entryId,
          expectedRevision: current.revision,
          status,
        },
        `search-${keyCounter}`,
      ),
    );
  }

  function search(
    overrides: Omit<Partial<LedgerSearchEntriesInput>, 'ledgerId'>,
  ): ReturnType<LedgerRepository['searchEntries']> {
    return context.repository.searchEntries({
      ledgerId: context.ledgerId,
      ...overrides,
    });
  }

  function titles(items: readonly LedgerEntrySearchItem[]): string[] {
    return items.map((item: LedgerEntrySearchItem): string => item.title);
  }

  function ids(items: readonly LedgerEntrySearchItem[]): string[] {
    return items.map((item: LedgerEntrySearchItem): string => item.entryId);
  }

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  it("returns each entry's origin beside its search item, in the same order", () => {
    const first = note('First note');
    const second = add({
      type: 'TASK',
      title: 'Second task',
      content: 'Do it.',
    });

    const result = search({ sort: 'created_desc' });

    expect(ids(result.entries)).toEqual([
      second.entry.entryId,
      first.entry.entryId,
    ]);
    expect(result.origins).toEqual([second.entry.origin, first.entry.origin]);
    // The item itself still leaves its provenance out.
    expect(result.entries[0]).not.toHaveProperty('origin');
    expect(search({ query: 'nothing-matches-this' }).origins).toEqual([]);
  });

  describe('literal query matching', () => {
    beforeEach(() => {
      note('Alpha OR gamma', 'All three words appear here.');
      note('Only alpha', 'Nothing else.');
      note('Only gamma', 'Nothing else.');
      note('Alpha not beta', 'The words appear in this order.');
      note('Alpha and beta', 'Without the negation.');
      note('Operator text', 'The NEAR(alpha beta) call and "quoted" words.');
      note('Column filter', 'Look at col:umn and caret^ values.');
      note('Prefix check', 'A prefix appears in this entry.');
      note('Café au lait', 'Diacritics matter.');
      add({
        type: 'DECISION',
        title: 'Decision with highlights',
        content: 'Chosen approach.',
        highlights: ['Highlighted keyword zebra'],
      });
    });

    it('treats OR and NOT as ordinary words, not operators', () => {
      expect(titles(search({ query: 'alpha OR gamma' }).entries)).toEqual([
        'Alpha OR gamma',
      ]);
      expect(titles(search({ query: 'alpha NOT beta' }).entries)).toEqual([
        'Alpha not beta',
      ]);
    });

    it('matches FTS syntax characters and quotes literally', () => {
      expect(titles(search({ query: 'NEAR(alpha' }).entries)).toEqual([
        'Operator text',
      ]);
      expect(titles(search({ query: '"quoted"' }).entries)).toEqual([
        'Operator text',
      ]);
      expect(titles(search({ query: 'col:umn' }).entries)).toEqual([
        'Column filter',
      ]);
      expect(titles(search({ query: 'caret^' }).entries)).toEqual([
        'Column filter',
      ]);
      // An unbalanced quote is not a syntax error.
      expect(titles(search({ query: '"alpha' }).entries)).toEqual([
        'Operator text',
        'Alpha and beta',
        'Alpha not beta',
        'Only alpha',
        'Alpha OR gamma',
      ]);
    });

    it('matches each word by its start, as people type', () => {
      note('Say hello', 'Say hello in 5 languages');
      expect(titles(search({ query: 'say h' }).entries)).toEqual(['Say hello']);
      expect(titles(search({ query: 'pre' }).entries)).toEqual([
        'Prefix check',
      ]);
      // A typed asterisk is a character, not an operator.
      expect(titles(search({ query: 'pre*' }).entries)).toEqual([
        'Prefix check',
      ]);
      // The start of a word, never its middle.
      expect(search({ query: 'efix' }).entries).toEqual([]);
    });

    it('matches case-insensitively and keeps diacritics significant', () => {
      expect(titles(search({ query: 'CAFÉ' }).entries)).toEqual([
        'Café au lait',
      ]);
      expect(search({ query: 'cafe' }).entries).toEqual([]);
    });

    it('searches highlights too', () => {
      expect(titles(search({ query: 'zebra' }).entries)).toEqual([
        'Decision with highlights',
      ]);
    });

    it('returns nothing for a query without indexable words', () => {
      for (const query of ['(', '* ) "', '---']) {
        const result = search({ query });
        expect(result.entries).toEqual([]);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
      }
    });
  });

  describe('filters', () => {
    it('filters by type, status, owner, author and attribution', () => {
      const task = add({ type: 'TASK', title: 'Task', content: 'To do.' });
      const assigned = add(
        { type: 'TASK', title: 'Assigned', content: 'For the user.' },
        context.chat,
        context.user,
      );
      const userAction = add(
        { type: 'ACTION', title: 'User action', content: 'By the user.' },
        context.user,
      );
      const blocked = add({
        type: 'TASK',
        title: 'Blocked task',
        content: 'Waiting.',
        status: 'BLOCKED',
      });

      expect(ids(search({ types: ['ACTION'] }).entries)).toEqual([
        userAction.entry.entryId,
      ]);
      expect(ids(search({ statuses: ['TODO'] }).entries)).toEqual([
        assigned.entry.entryId,
        task.entry.entryId,
      ]);
      expect(
        ids(search({ ownerActorId: context.user.actorId }).entries),
      ).toEqual([userAction.entry.entryId, assigned.entry.entryId]);
      expect(
        ids(search({ authorActorId: context.user.actorId }).entries),
      ).toEqual([userAction.entry.entryId]);
      expect(ids(search({ attribution: ['user'] }).entries)).toEqual([
        userAction.entry.entryId,
      ]);
      expect(
        ids(
          search({
            entryIds: [blocked.entry.entryId, task.entry.entryId],
            statuses: ['BLOCKED'],
          }).entries,
        ),
      ).toEqual([blocked.entry.entryId]);
    });

    it('applies inclusive lower and exclusive upper time bounds in UTC', () => {
      // The clock starts at 2026-09-28T12:00:00.000Z.
      const first = add({ type: 'TASK', title: 'First', content: 'x' });
      context.clock.advance(60_000);
      const second = add({ type: 'TASK', title: 'Second', content: 'x' });
      context.clock.advance(60_000);
      const third = add({ type: 'TASK', title: 'Third', content: 'x' });

      expect(
        ids(
          search({
            createdAfter: second.entry.createdAt,
            createdBefore: third.entry.createdAt,
          }).entries,
        ),
      ).toEqual([second.entry.entryId]);
      // Offset bounds select the same instants as their UTC forms.
      expect(
        ids(search({ createdAfter: '2026-09-28T14:00:00+02:00' }).entries),
      ).toEqual([
        third.entry.entryId,
        second.entry.entryId,
        first.entry.entryId,
      ]);
      expect(
        ids(search({ createdBefore: '2026-09-28T14:01:00+02:00' }).entries),
      ).toEqual([first.entry.entryId]);

      context.clock.advance(60_000);
      const updated = setStatus(first, 'IN_PROGRESS');
      expect(
        ids(search({ updatedAfter: updated.entry.updatedAt }).entries),
      ).toEqual([first.entry.entryId]);
      expect(
        ids(search({ updatedBefore: updated.entry.updatedAt }).entries),
      ).toEqual([third.entry.entryId, second.entry.entryId]);
    });

    it('sorts by creation or by last update', () => {
      const older = add({ type: 'TASK', title: 'Older', content: 'x' });
      context.clock.advance(1_000);
      const newer = add({ type: 'TASK', title: 'Newer', content: 'x' });
      context.clock.advance(1_000);
      setStatus(older, 'IN_PROGRESS');
      expect(ids(search({}).entries)).toEqual([
        newer.entry.entryId,
        older.entry.entryId,
      ]);
      expect(ids(search({ sort: 'updated_desc' }).entries)).toEqual([
        older.entry.entryId,
        newer.entry.entryId,
      ]);
    });

    it('returns search projections with source availability', () => {
      const created = note('Projection');
      const [item] = search({}).entries;
      expect(item).toEqual({
        entryId: created.entry.entryId,
        revision: 1,
        type: 'OBSERVATION',
        title: 'Projection',
        content: 'Details.',
        highlights: [],
        referenceFiles: [],
        status: 'INFO',
        owner: context.chat,
        author: context.chat,
        attributionKind: 'self_reported',
        createdAt: created.entry.createdAt,
        updatedAt: created.entry.updatedAt,
        sourceAvailability: 'available',
        syncState: 'pending',
      });
      expect(
        search({ resolveSourceAvailability: () => 'archived' }).entries[0]
          ?.sourceAvailability,
      ).toBe('archived');
    });
  });

  describe('snapshot pagination', () => {
    it('defaults to pages of 30', () => {
      for (let index = 0; index < 31; index += 1) note(`Entry ${index}`);
      const page = search({});
      expect(page.entries).toHaveLength(LEDGER_LIMITS.searchPageDefault);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).not.toBeNull();
      expect(search({ limit: 100 }).entries).toHaveLength(31);
    });

    it('neither drops nor duplicates entries whose status changes between pages', () => {
      const created = Array.from({ length: 5 }, (_value, index) => {
        context.clock.advance(1_000);
        return add({ type: 'TASK', title: `Task ${index}`, content: 'x' });
      });
      const [e0, e1, e2, e3, e4] = created;
      if (!e0 || !e1 || !e2 || !e3 || !e4) throw new Error('setup failed');

      const first = search({ statuses: ['TODO'], limit: 2 });
      expect(ids(first.entries)).toEqual([e4.entry.entryId, e3.entry.entryId]);
      expect(first.hasMore).toBe(true);

      // Between pages: one listed and one unlisted entry leave the filter,
      // and a new matching entry appears.
      setStatus(e4, 'IN_PROGRESS');
      setStatus(e2, 'COMPLETED');
      context.clock.advance(1_000);
      const late = add({ type: 'TASK', title: 'Late task', content: 'x' });

      const second = search({
        statuses: ['TODO'],
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.watermark).toBe(first.watermark);
      expect(ids(second.entries)).toEqual([e2.entry.entryId, e1.entry.entryId]);
      expect(second.entries[0]).toMatchObject({ status: 'TODO', revision: 1 });

      const third = search({
        statuses: ['TODO'],
        limit: 2,
        cursor: second.nextCursor ?? undefined,
      });
      expect(ids(third.entries)).toEqual([e0.entry.entryId]);
      expect(third.hasMore).toBe(false);
      expect(third.nextCursor).toBeNull();

      const seen = [...first.entries, ...second.entries, ...third.entries];
      expect(new Set(ids(seen)).size).toBe(5);
      expect(ids(seen)).not.toContain(late.entry.entryId);

      // A fresh search reflects the current state.
      expect(ids(search({ statuses: ['TODO'] }).entries)).toEqual([
        late.entry.entryId,
        e3.entry.entryId,
        e1.entry.entryId,
        e0.entry.entryId,
      ]);
    });

    it('keeps update-sorted pages stable while entries are updated', () => {
      const created = Array.from({ length: 4 }, (_value, index) => {
        context.clock.advance(1_000);
        return add({ type: 'TASK', title: `Task ${index}`, content: 'x' });
      });
      const first = search({ sort: 'updated_desc', limit: 2 });
      const last = created[0];
      if (last === undefined) throw new Error('setup failed');
      context.clock.advance(1_000);
      setStatus(last, 'BLOCKED');
      const rest = search({
        sort: 'updated_desc',
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect([...ids(first.entries), ...ids(rest.entries)]).toEqual(
        [...created].reverse().map((receipt) => receipt.entry.entryId),
      );
      expect(rest.hasMore).toBe(false);
    });

    it('lets the page size change but not the filters or sort', () => {
      for (let index = 0; index < 4; index += 1) note(`Note ${index}`);
      const first = search({ query: 'note', limit: 1 });
      const cursor = first.nextCursor ?? undefined;
      expect(search({ query: 'note', limit: 3, cursor }).entries).toHaveLength(
        3,
      );
      for (const changed of [
        { query: 'details' },
        { query: 'note', statuses: ['INFO'] as LedgerStatus[] },
        { query: 'note', sort: 'updated_desc' as const },
        { query: 'note', ownerActorId: context.chat.actorId },
      ]) {
        expect(
          captureLedgerError(() => search({ ...changed, limit: 1, cursor })),
        ).toMatchObject({ reason: 'CURSOR_EXPIRED', field: 'cursor' });
      }
    });

    it('expires cursors after ten minutes', () => {
      for (let index = 0; index < 3; index += 1) note(`Note ${index}`);
      const first = search({ limit: 1 });
      const cursor = first.nextCursor ?? undefined;
      context.clock.advance(LEDGER_LIMITS.cursorLifetimeMs);
      expect(search({ limit: 1, cursor }).entries).toHaveLength(1);
      context.clock.advance(1);
      expect(
        captureLedgerError(() => search({ limit: 1, cursor })).reason,
      ).toBe('CURSOR_EXPIRED');
    });

    it('rejects tampered cursors and cursors from another ledger or database', () => {
      for (let index = 0; index < 3; index += 1) note(`Note ${index}`);
      const cursor = search({ limit: 1 }).nextCursor ?? '';
      const tampered = `${cursor.slice(0, 10)}${cursor[10] === 'A' ? 'B' : 'A'}${cursor.slice(11)}`;
      expect(
        captureLedgerError(() => search({ limit: 1, cursor: tampered })).reason,
      ).toBe('CURSOR_EXPIRED');

      const otherLedger = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer('worktree-2'),
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      }).scope.scope.ledgerId;
      expect(
        captureLedgerError(() =>
          context.repository.searchEntries({
            ledgerId: otherLedger,
            limit: 1,
            cursor,
          }),
        ).reason,
      ).toBe('CURSOR_EXPIRED');

      const directory = createTempDirectory();
      const other = LedgerRepository.open({
        databasePath: join(directory, 'ledger.sqlite'),
        now: context.clock.now,
      });
      try {
        const foreignLedger = other.bindScope({
          authorityId: AUTHORITY_ID,
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
          accountId: null,
        }).scope.scope.ledgerId;
        expect(
          captureLedgerError(() =>
            other.searchEntries({ ledgerId: foreignLedger, cursor }),
          ).reason,
        ).toBe('CURSOR_EXPIRED');
      } finally {
        other.close();
        removeTempDirectory(directory);
      }
    });

    it('keeps cursors valid across a reopen within their lifetime', () => {
      for (let index = 0; index < 3; index += 1) note(`Note ${index}`);
      const first = search({ limit: 2 });
      context.repository.close();
      const reopened = context.reopen();
      const rest = reopened.searchEntries({
        ledgerId: context.ledgerId,
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(rest.entries).toHaveLength(1);
    });

    it('reports unknown ledgers as not found', () => {
      expect(
        captureLedgerError(() =>
          context.repository.searchEntries({
            ledgerId: '00000000-0000-4000-8000-00000000ffff',
          }),
        ).reason,
      ).toBe('NOT_FOUND');
    });
  });

  describe('pages of a scope unchanged since the snapshot', () => {
    function currentSequence(): number {
      const record = context.repository
        .listScopes()
        .find((scope) => scope.scope.ledgerId === context.ledgerId);
      if (record === undefined) throw new Error('setup failed');
      return Number(record.sequence);
    }

    /** Closes the repository so the test can read its file directly. */
    function openForReads(): DatabaseSync {
      context.repository.close();
      return new DatabaseSync(context.databasePath, { readOnly: true });
    }

    function planOf(db: DatabaseSync, sql: string): string {
      return db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row): string => String(row.detail))
        .join(' | ');
    }

    it('reads their first page from the entries in sort order, not entry by entry', () => {
      for (let index = 0; index < 5; index += 1) {
        context.clock.advance(1_000);
        note(`Entry ${index}`);
      }
      const prepare = jest.spyOn(DatabaseSync.prototype, 'prepare');
      let pages: string[];
      try {
        search({});
        search({ sort: 'updated_desc' });
        pages = prepare.mock.calls
          .map(([sql]): string => sql)
          .filter((sql: string): boolean => sql.includes('ORDER BY'));
      } finally {
        prepare.mockRestore();
      }
      expect(pages).toHaveLength(2);
      const db = openForReads();
      try {
        const plans = pages.map((sql: string): string => planOf(db, sql));
        expect(plans[0]).toContain('ledger_entries_by_created');
        expect(plans[1]).toContain('ledger_entries_by_updated');
        for (const plan of plans) {
          expect(plan).not.toContain('CORRELATED');
          expect(plan).not.toContain('TEMP B-TREE');
        }
      } finally {
        db.close();
      }
    });

    it('returns the same rows as a read of each entry at the snapshot', () => {
      const tasks = Array.from({ length: 8 }, (_value, index) => {
        // Pairs share a timestamp, so the entry ID breaks their ties.
        if (index % 2 === 0) context.clock.advance(1_000);
        return add(
          {
            type: index % 3 === 0 ? 'DECISION' : 'TASK',
            title: `Task ${index} ${index % 2 === 0 ? 'alpha' : 'beta'}`,
            content: 'Details.',
          },
          index % 2 === 0 ? context.chat : context.otherChat,
        );
      });
      tasks.forEach((task: LedgerCommandReceipt, index: number): void => {
        if (index % 3 === 0) return;
        context.clock.advance(500);
        setStatus(task, index % 2 === 0 ? 'BLOCKED' : 'IN_PROGRESS');
        if (index % 4 === 1) setStatus(task, 'COMPLETED');
      });
      const watermark = currentSequence();
      const [third] = search({ sort: 'updated_desc', limit: 3 }).entries.slice(
        2,
      );
      const [fourth] = search({ limit: 4 }).entries.slice(3);
      if (third === undefined || fourth === undefined) {
        throw new Error('setup failed');
      }
      const searches: readonly {
        readonly input: Omit<LedgerSearchEntriesInput, 'ledgerId'>;
        readonly after: LedgerSearchPagePosition['after'];
      }[] = [
        { input: {}, after: null },
        { input: { sort: 'updated_desc' }, after: null },
        {
          input: { sort: 'updated_desc' },
          after: { sortValue: third.updatedAt, entryId: third.entryId },
        },
        {
          input: {},
          after: { sortValue: fourth.createdAt, entryId: fourth.entryId },
        },
        { input: { statuses: ['BLOCKED', 'COMPLETED'] }, after: null },
        { input: { types: ['TASK'], sort: 'updated_desc' }, after: null },
        { input: { ownerActorId: context.otherChat.actorId }, after: null },
        { input: { authorActorId: context.chat.actorId }, after: null },
        { input: { query: 'alpha' }, after: null },
        {
          input: { updatedAfter: third.updatedAt, sort: 'updated_desc' },
          after: null,
        },
      ];
      const db = openForReads();
      try {
        for (const { input, after } of searches) {
          const normalized = normalizeLedgerSearch({
            ledgerId: context.ledgerId,
            ...input,
          });
          const read = (currentAt: number): unknown[] => {
            const statement = buildLedgerSearchPageStatement(
              context.ledgerId,
              normalized,
              { watermark, after },
              50,
              currentAt,
            );
            return db.prepare(statement.sql).all(...statement.params);
          };
          // A scope that changed after the snapshot reads each entry's
          // version at the snapshot; one that did not reads its entries.
          const unchanged = read(watermark);
          expect(unchanged).toEqual(read(watermark + 1));
          expect(unchanged.length).toBeGreaterThan(0);
        }
      } finally {
        db.close();
      }
    });
  });

  describe('listChanges', () => {
    it('lists entry revisions after a sequence, skipping scope and actor events', () => {
      const scopeSequence = Number(
        context.repository.getScope(context.ledgerId)?.sequence,
      );
      const created = note('Changed');
      const task = add({ type: 'TASK', title: 'Task', content: 'x' });
      const updated = setStatus(task, 'BLOCKED');

      const all = context.repository.listChanges({
        ledgerId: context.ledgerId,
        afterSequence: '0',
      });
      expect(all).toEqual({
        changes: [
          {
            sequence: String(scopeSequence + 1),
            entryId: created.entry.entryId,
            revision: 1,
          },
          {
            sequence: String(scopeSequence + 2),
            entryId: task.entry.entryId,
            revision: 1,
          },
          {
            sequence: String(scopeSequence + 3),
            entryId: task.entry.entryId,
            revision: 2,
          },
        ],
        nextSequence: updated.localSequence,
        hasMore: false,
      });

      const page = context.repository.listChanges({
        ledgerId: context.ledgerId,
        afterSequence: '0',
        limit: 2,
      });
      expect(page.hasMore).toBe(true);
      expect(page.nextSequence).toBe(String(scopeSequence + 2));
      expect(
        context.repository.listChanges({
          ledgerId: context.ledgerId,
          afterSequence: page.nextSequence,
        }).changes,
      ).toHaveLength(1);
      expect(
        context.repository.listChanges({
          ledgerId: context.ledgerId,
          afterSequence: updated.localSequence,
        }),
      ).toEqual({
        changes: [],
        nextSequence: updated.localSequence,
        hasMore: false,
      });
    });

    it('rejects sequences beyond the ledger and malformed sequences', () => {
      expect(
        captureLedgerError(() =>
          context.repository.listChanges({
            ledgerId: context.ledgerId,
            afterSequence: '99999999999999999999',
          }),
        ).reason,
      ).toBe('CURSOR_EXPIRED');
      for (const afterSequence of ['-1', '01', 'abc', '']) {
        expect(
          captureLedgerError(() =>
            context.repository.listChanges({
              ledgerId: context.ledgerId,
              afterSequence,
            }),
          ),
        ).toMatchObject({ reason: 'INVALID_INPUT', field: 'afterSequence' });
      }
      expect(
        captureLedgerError(() =>
          context.repository.listChanges({
            ledgerId: context.ledgerId,
            afterSequence: '0',
            limit: LEDGER_LIMITS.changesPageMax + 1,
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'limit' });
    });
  });

  describe('getEntry', () => {
    it('pages mutation history oldest first', () => {
      const task = add({ type: 'TASK', title: 'History', content: 'x' });
      for (const status of [
        'IN_PROGRESS',
        'BLOCKED',
        'NEEDS_REVIEW',
      ] as const) {
        setStatus(task, status);
      }
      const first = context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: task.entry.entryId,
        includeHistory: true,
        historyLimit: 3,
      });
      expect(first.entry.revision).toBe(4);
      expect(first.sourceAvailability).toBe('available');
      expect(
        first.history?.mutations.map((mutation) => [
          mutation.kind,
          mutation.revision,
          mutation.status?.to,
        ]),
      ).toEqual([
        ['create', 1, 'TODO'],
        ['update', 2, 'IN_PROGRESS'],
        ['update', 3, 'BLOCKED'],
      ]);
      const rest = context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: task.entry.entryId,
        historyCursor: first.history?.nextCursor ?? undefined,
      });
      expect(
        rest.history?.mutations.map((mutation) => mutation.revision),
      ).toEqual([4]);
      expect(rest.history?.nextCursor).toBeNull();
      expect(
        context.repository.getEntry({
          ledgerId: context.ledgerId,
          entryId: task.entry.entryId,
        }).history,
      ).toBeNull();
    });

    it('rejects history cursors issued for another entry', () => {
      const first = add({ type: 'TASK', title: 'First', content: 'x' });
      const second = add({ type: 'TASK', title: 'Second', content: 'x' });
      setStatus(first, 'IN_PROGRESS');
      const cursor = context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: first.entry.entryId,
        includeHistory: true,
        historyLimit: 1,
      }).history?.nextCursor;
      expect(cursor).toBeTruthy();
      expect(
        captureLedgerError(() =>
          context.repository.getEntry({
            ledgerId: context.ledgerId,
            entryId: second.entry.entryId,
            historyCursor: cursor ?? undefined,
          }),
        ),
      ).toMatchObject({ reason: 'CURSOR_EXPIRED', field: 'historyCursor' });
    });

    it('never reveals entries through another ledger', () => {
      const task = add({ type: 'TASK', title: 'Private', content: 'x' });
      const otherLedger = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer('worktree-2'),
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      }).scope.scope.ledgerId;
      expect(
        captureLedgerError(() =>
          context.repository.getEntry({
            ledgerId: otherLedger,
            entryId: task.entry.entryId,
          }),
        ),
      ).toMatchObject({ reason: 'NOT_FOUND', field: 'entryId' });
      expect(
        context.repository.searchEntries({
          ledgerId: otherLedger,
          entryIds: [task.entry.entryId],
        }).entries,
      ).toEqual([]);
    });
  });
});
