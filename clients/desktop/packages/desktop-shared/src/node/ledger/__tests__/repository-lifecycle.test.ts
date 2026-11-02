import type { DatabaseSync } from 'node:sqlite';

import {
  LedgerEntrySchema,
  type LedgerActorRef,
  type LedgerAddEntryParams,
  type LedgerCommandReceipt,
  type LedgerContainer,
  type LedgerEntry,
  type LedgerPublishSummaryParams,
} from '@canopy/protocol/canopy-core';

import type {
  LedgerScopeLifecycleState,
  LedgerScopeRecord,
  LedgerSetScopeLifecycleInput,
  LedgerStorageCounts,
} from '../types';
import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  NO_DETAILS,
  ORGANIZATION_OWNER,
  PERSONAL_OWNER,
  WORKTREE_CONTAINER,
  addInput,
  bindGlobal,
  captureLedgerError,
  globalContainer,
  readGlobalBindings,
  readLedgerDatabase,
  registerTestActor,
  setUpLedger,
  unindexedPurgeSteps,
  updateInput,
  withUncheckedFields,
  worktreeContainer,
  type LedgerTestContext,
} from './ledger-test-harness';

/** Restore creates a new container: a new worktree ID and creation time. */
const RESTORED_CONTAINER: LedgerContainer = worktreeContainer('worktree-1-r');
const RESTORED_CREATED_AT = '2026-09-20T09:30:00.000Z';
const UNKNOWN_LEDGER_ID = '00000000-0000-4000-8000-00000000ffff';

const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Archive the worktree',
  content: 'Keep the ledger read-only while the worktree is archived.',
  highlights: ['Nightjar'],
};

const SUMMARY: LedgerPublishSummaryParams = {
  snapshotId: 'snapshot-1',
  generationId: 'generation-1',
  title: 'Summary of the work',
  content: 'The Nightjar ledger was archived.',
  sourceTruncated: false,
};

/** Tables whose rows belong to one scope through `ledger_id`. */
const SCOPED_TABLES = [
  'ledger_scopes',
  'ledger_actors',
  'ledger_entries',
  'ledger_entry_versions',
  'ledger_mutations',
  'ledger_command_receipts',
  'ledger_outbox',
] as const;

interface OutboxEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly payload: unknown;
}

function readOutbox(databasePath: string, ledgerId: string): OutboxEvent[] {
  return readLedgerDatabase(databasePath, (raw) =>
    raw
      .prepare(
        'SELECT scope_sequence, kind, payload_json FROM ledger_outbox WHERE ledger_id = ? ORDER BY scope_sequence',
      )
      .all(ledgerId)
      .map(
        (row): OutboxEvent => ({
          sequence: Number(row.scope_sequence),
          kind: String(row.kind),
          payload: JSON.parse(String(row.payload_json)),
        }),
      ),
  );
}

function countScopedRows(
  raw: DatabaseSync,
  ledgerId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of SCOPED_TABLES) {
    const row = raw
      .prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ledger_id = ?`)
      .get(ledgerId);
    counts[table] = Number(row?.total);
  }
  return counts;
}

function countRows(raw: DatabaseSync, table: string): number {
  return Number(
    raw.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total,
  );
}

function subtractCounts(
  after: LedgerStorageCounts,
  before: LedgerStorageCounts,
): LedgerStorageCounts {
  return {
    scopes: after.scopes - before.scopes,
    actors: after.actors - before.actors,
    entries: after.entries - before.entries,
    entryVersions: after.entryVersions - before.entryVersions,
    mutations: after.mutations - before.mutations,
    receipts: after.receipts - before.receipts,
    outbox: after.outbox - before.outbox,
    searchRows: after.searchRows - before.searchRows,
  };
}

describe('LedgerRepository scope lifecycle', () => {
  let context: LedgerTestContext;
  let keyCounter = 0;

  beforeEach(() => {
    context = setUpLedger();
    keyCounter = 0;
  });

  afterEach(() => {
    context.dispose();
  });

  function nextKey(): string {
    keyCounter += 1;
    return `lifecycle-${keyCounter}`;
  }

  function addTask(
    actor: LedgerActorRef = context.chat,
    key: string = nextKey(),
  ): LedgerCommandReceipt {
    return context.repository.addEntry(addInput(context, actor, TASK, key));
  }

  function startTask(
    receipt: LedgerCommandReceipt,
    key: string = nextKey(),
  ): LedgerCommandReceipt {
    return context.repository.updateEntry(
      updateInput(
        context,
        context.chat,
        {
          entryId: receipt.entry.entryId,
          expectedRevision: receipt.entry.revision,
          status: 'IN_PROGRESS',
        },
        key,
      ),
    );
  }

  function setLifecycle(
    state: LedgerScopeLifecycleState,
    ledgerId: string = context.ledgerId,
  ): LedgerScopeRecord {
    return context.repository.setScopeLifecycle({ ledgerId, state });
  }

  function rebindToRestored(
    ledgerId: string = context.ledgerId,
  ): LedgerScopeRecord {
    return context.repository.rebindScope({
      ledgerId,
      container: RESTORED_CONTAINER,
      containerCreatedAt: RESTORED_CREATED_AT,
    });
  }

  function bindWorktree(
    container: LedgerContainer,
    containerCreatedAt: string = CONTAINER_CREATED_AT,
  ): LedgerScopeRecord {
    return context.repository.bindScope({
      authorityId: AUTHORITY_ID,
      container,
      containerCreatedAt,
      accountId: 'account-1',
    }).scope;
  }

  function readEntry(entryId: string): LedgerEntry {
    return context.repository.getEntry({ ledgerId: context.ledgerId, entryId })
      .entry;
  }

  describe('setScopeLifecycle', () => {
    it('archives a scope: every write fails SCOPE_RETIRED and reads keep working', () => {
      const created = addTask();
      const started = startTask(created);
      const archived = setLifecycle('archived');
      expect(archived).toMatchObject({
        scope: { ledgerId: context.ledgerId, container: WORKTREE_CONTAINER },
        lifecycleState: 'archived',
      });
      const counts = context.repository.getStorageCounts();

      const writes: (() => unknown)[] = [
        (): unknown => addTask(),
        (): unknown => startTask(started),
        (): unknown =>
          context.repository.publishSummary({
            ledgerId: context.ledgerId,
            helper: context.helper,
            helperDetails: NO_DETAILS,
            params: SUMMARY,
            idempotencyKey: `summary:${context.ledgerId}:snapshot-1`,
          }),
        (): unknown =>
          registerTestActor(
            context.repository,
            context.ledgerId,
            'chat',
            'chat:9',
            'Chat 9',
          ),
      ];
      for (const write of writes) {
        expect(captureLedgerError(write).reason).toBe('SCOPE_RETIRED');
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);

      expect(readEntry(created.entry.entryId)).toEqual(started.entry);
      expect(
        context.repository.searchEntries({
          ledgerId: context.ledgerId,
          query: 'Nightjar',
        }).entries,
      ).toHaveLength(1);
      expect(
        context.repository.listChanges({
          ledgerId: context.ledgerId,
          afterSequence: '0',
        }).changes,
      ).toHaveLength(2);
      expect(context.repository.listActors(context.ledgerId)).toHaveLength(5);
      // Existing actors resolve; exact replays return their stored receipts.
      expect(
        registerTestActor(
          context.repository,
          context.ledgerId,
          'chat',
          'chat:1',
          'Chat 1',
        ),
      ).toEqual(context.chat);
      expect(
        context.repository.addEntry(
          addInput(context, context.chat, TASK, 'lifecycle-1'),
        ),
      ).toEqual(created);
    });

    it('restores an archived scope in place, and writes work again', () => {
      const created = addTask();
      setLifecycle('archived');
      const restored = setLifecycle('active');
      expect(restored).toMatchObject({
        scope: { ledgerId: context.ledgerId, container: WORKTREE_CONTAINER },
        containerCreatedAt: CONTAINER_CREATED_AT,
        lifecycleState: 'active',
      });
      expect(startTask(created).entry).toMatchObject({
        revision: 2,
        status: 'IN_PROGRESS',
      });
    });

    it('changes nothing when the scope is already in the requested state', () => {
      const active = context.repository.getScope(context.ledgerId);
      expect(setLifecycle('active')).toEqual(active);
      const archived = setLifecycle('archived');
      const counts = context.repository.getStorageCounts();
      expect(setLifecycle('archived')).toEqual(archived);
      expect(context.repository.getStorageCounts()).toEqual(counts);
      setLifecycle('retirement_pending');
      const retiring = context.repository.getScope(context.ledgerId);
      expect(setLifecycle('retirement_pending')).toEqual(retiring);
    });

    it.each<LedgerScopeLifecycleState>(['active', 'archived'])(
      'retires a scope from %s, and it never comes back',
      (from) => {
        const created = addTask();
        setLifecycle(from);
        expect(setLifecycle('retirement_pending').lifecycleState).toBe(
          'retirement_pending',
        );
        const retiring = context.repository.getScope(context.ledgerId);
        const counts = context.repository.getStorageCounts();

        for (const state of ['active', 'archived'] as const) {
          expect(captureLedgerError(() => setLifecycle(state))).toMatchObject({
            reason: 'SCOPE_RETIRED',
            field: undefined,
          });
        }
        expect(captureLedgerError(() => addTask()).reason).toBe(
          'SCOPE_RETIRED',
        );
        expect(context.repository.getScope(context.ledgerId)).toEqual(retiring);
        expect(context.repository.getStorageCounts()).toEqual(counts);
        expect(readEntry(created.entry.entryId)).toEqual(created.entry);
      },
    );

    it('rejects unknown scopes and malformed requests without writing', () => {
      const counts = context.repository.getStorageCounts();
      const archive: LedgerSetScopeLifecycleInput = {
        ledgerId: context.ledgerId,
        state: 'archived',
      };
      expect(
        captureLedgerError(() => setLifecycle('archived', UNKNOWN_LEDGER_ID)),
      ).toMatchObject({ reason: 'NOT_FOUND', field: 'ledgerId' });
      for (const state of ['purged', 'deleted', 'ACTIVE', null]) {
        expect(
          captureLedgerError(() =>
            context.repository.setScopeLifecycle(
              withUncheckedFields(archive, { state }),
            ),
          ),
        ).toMatchObject({ reason: 'INVALID_INPUT', field: 'state' });
      }
      for (const ledgerId of [7, '', null]) {
        expect(
          captureLedgerError(() =>
            context.repository.setScopeLifecycle(
              withUncheckedFields(archive, { ledgerId }),
            ),
          ),
        ).toMatchObject({ reason: 'INVALID_INPUT', field: 'ledgerId' });
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);
      expect(
        context.repository.getScope(context.ledgerId)?.lifecycleState,
      ).toBe('active');
    });

    it('rolls back a lifecycle change that fails before commit', () => {
      const before = context.repository.getScope(context.ledgerId);
      const counts = context.repository.getStorageCounts();
      context.faults.failNext('setScopeLifecycle');
      expect(captureLedgerError(() => setLifecycle('archived')).reason).toBe(
        'STORAGE_UNAVAILABLE',
      );
      expect(context.repository.getScope(context.ledgerId)).toEqual(before);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('numbers archive and restore events in the scope sequence, but not retirement', () => {
      addTask();
      setLifecycle('archived');
      setLifecycle('active');
      const retiring = setLifecycle('retirement_pending');
      // Six registrations, one entry, the archive and the restore.
      expect(retiring.sequence).toBe('9');
      context.repository.close();

      const events = readOutbox(context.databasePath, context.ledgerId);
      expect(events.map((event) => [event.sequence, event.kind])).toEqual([
        [1, 'scope_registered'],
        [2, 'actor_registered'],
        [3, 'actor_registered'],
        [4, 'actor_registered'],
        [5, 'actor_registered'],
        [6, 'actor_registered'],
        [7, 'entry_revision'],
        [8, 'scope_archived'],
        [9, 'scope_restored'],
      ]);
      const scope = {
        ledgerId: context.ledgerId,
        authorityId: AUTHORITY_ID,
        container: WORKTREE_CONTAINER,
      };
      expect(events.slice(7).map((event) => event.payload)).toEqual([
        { scope, containerCreatedAt: CONTAINER_CREATED_AT },
        { scope, containerCreatedAt: CONTAINER_CREATED_AT },
      ]);
    });
  });

  describe('rebindScope', () => {
    it('moves an archived scope to the restored container, keeping its ledger, entries, revisions and actors', () => {
      const created = addTask();
      const started = startTask(created);
      const actors = context.repository.listActors(context.ledgerId);
      const archived = setLifecycle('archived');

      const rebound = rebindToRestored();

      expect(rebound).toEqual({
        ...archived,
        scope: { ...archived.scope, container: RESTORED_CONTAINER },
        containerCreatedAt: RESTORED_CREATED_AT,
        lifecycleState: 'active',
        // The archive and the restore are both replicated.
        sequence: String(Number(started.localSequence) + 2),
      });
      expect(context.repository.listActors(context.ledgerId)).toEqual(actors);
      const current = context.repository.getEntry({
        ledgerId: context.ledgerId,
        entryId: created.entry.entryId,
        includeHistory: true,
      });
      expect(current.entry).toEqual({ ...started.entry, scope: rebound.scope });
      expect(current.history?.mutations.map((m) => m.revision)).toEqual([1, 2]);
    });

    it('reports the new container on every read while stored revisions and receipts stay as written', () => {
      const created = addTask();
      const started = startTask(created);
      setLifecycle('archived');
      const rebound = rebindToRestored();

      // Exact replays return the stored receipts verbatim.
      expect(
        context.repository.addEntry(
          addInput(context, context.chat, TASK, 'lifecycle-1'),
        ),
      ).toEqual(created);
      expect(created.entry.scope.container).toEqual(WORKTREE_CONTAINER);
      expect(startTask(created, 'lifecycle-2')).toEqual(started);

      // Reads report the scope's current container.
      const seen: LedgerContainer[] = [];
      const search = context.repository.searchEntries({
        ledgerId: context.ledgerId,
        query: 'Nightjar',
        resolveSourceAvailability: (entry) => {
          seen.push(entry.scope.container);
          return 'available';
        },
      });
      expect(search.entries).toHaveLength(1);
      expect(seen).toEqual([RESTORED_CONTAINER]);
      const conflict = captureLedgerError(() => startTask(created));
      expect(conflict.reason).toBe('REVISION_CONFLICT');
      expect(conflict.currentEntry?.scope).toEqual(rebound.scope);
      const noop = context.repository.updateEntry(
        updateInput(
          context,
          context.chat,
          {
            entryId: created.entry.entryId,
            expectedRevision: 2,
            status: 'IN_PROGRESS',
          },
          nextKey(),
        ),
      );
      expect(noop).toMatchObject({ changed: false, entry: { revision: 2 } });
      expect(noop.entry.scope).toEqual(rebound.scope);

      // New revisions and entries are written under the new container.
      const completed = context.repository.updateEntry(
        updateInput(
          context,
          context.chat,
          {
            entryId: created.entry.entryId,
            expectedRevision: 2,
            status: 'COMPLETED',
          },
          nextKey(),
        ),
      );
      expect(completed.entry.scope).toEqual(rebound.scope);
      expect(addTask().entry.scope).toEqual(rebound.scope);
      context.repository.close();

      const versions = readLedgerDatabase(context.databasePath, (raw) =>
        raw
          .prepare(
            'SELECT projection_json FROM ledger_entry_versions WHERE entry_id = ? ORDER BY revision',
          )
          .all(created.entry.entryId)
          .map((row) =>
            LedgerEntrySchema.parse(JSON.parse(String(row.projection_json))),
          ),
      );
      expect(versions.map((version) => version.scope.container)).toEqual([
        WORKTREE_CONTAINER,
        WORKTREE_CONTAINER,
        RESTORED_CONTAINER,
      ]);
    });

    it('frees the old incarnation and finds the scope under the restored one', () => {
      setLifecycle('archived');
      rebindToRestored();

      expect(
        context.repository.findScope({
          container: RESTORED_CONTAINER,
          containerCreatedAt: '2026-09-20T11:30:00+02:00',
        })?.scope.ledgerId,
      ).toBe(context.ledgerId);
      expect(
        context.repository.findScope({
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        }),
      ).toBeNull();
      const rebound = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: RESTORED_CONTAINER,
        containerCreatedAt: RESTORED_CREATED_AT,
        accountId: 'account-2',
      });
      expect(rebound).toMatchObject({
        created: false,
        scope: {
          scope: { ledgerId: context.ledgerId },
          accountId: 'account-1',
        },
      });
      const reused = bindWorktree(WORKTREE_CONTAINER);
      expect(reused.scope.ledgerId).not.toBe(context.ledgerId);
    });

    it('treats a repeat of a completed rebind as a no-op', () => {
      setLifecycle('archived');
      const rebound = rebindToRestored();
      const counts = context.repository.getStorageCounts();
      expect(rebindToRestored()).toEqual(rebound);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('restores in place when pointed at its own incarnation', () => {
      setLifecycle('archived');
      expect(
        context.repository.rebindScope({
          ledgerId: context.ledgerId,
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        }),
      ).toMatchObject({
        scope: { container: WORKTREE_CONTAINER },
        lifecycleState: 'active',
        sequence: '8',
      });
    });

    it('rejects a scope that is not archived, changing nothing', () => {
      const active = context.repository.getScope(context.ledgerId);
      const counts = context.repository.getStorageCounts();
      expect(captureLedgerError(() => rebindToRestored())).toMatchObject({
        reason: 'FORBIDDEN',
        field: 'ledgerId',
      });
      expect(context.repository.getScope(context.ledgerId)).toEqual(active);
      expect(context.repository.getStorageCounts()).toEqual(counts);

      const retiring = setLifecycle('retirement_pending');
      expect(captureLedgerError(() => rebindToRestored())).toMatchObject({
        reason: 'SCOPE_RETIRED',
      });
      expect(context.repository.getScope(context.ledgerId)).toEqual(retiring);
    });

    it('rejects an incarnation that already has its own ledger, changing nothing', () => {
      const occupant = bindWorktree(RESTORED_CONTAINER, RESTORED_CREATED_AT);
      const archived = setLifecycle('archived');
      const counts = context.repository.getStorageCounts();

      expect(captureLedgerError(() => rebindToRestored())).toMatchObject({
        reason: 'FORBIDDEN',
        field: 'container',
      });
      expect(context.repository.getScope(context.ledgerId)).toEqual(archived);
      expect(context.repository.getScope(occupant.scope.ledgerId)).toEqual(
        occupant,
      );
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('rejects a change of container kind, changing nothing', () => {
      const archived = setLifecycle('archived');
      const containers: LedgerContainer[] = [
        {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'entry-1',
        },
        {
          kind: 'advisor_entry',
          appWorkspaceId: 'app-advisor',
          entryId: 'e-1',
        },
      ];
      for (const container of containers) {
        expect(
          captureLedgerError(() =>
            context.repository.rebindScope({
              ledgerId: context.ledgerId,
              container,
              containerCreatedAt: RESTORED_CREATED_AT,
            }),
          ),
        ).toMatchObject({ reason: 'INVALID_INPUT', field: 'container.kind' });
      }
      expect(context.repository.getScope(context.ledgerId)).toEqual(archived);
    });

    it('rejects unknown scopes and malformed targets', () => {
      setLifecycle('archived');
      expect(
        captureLedgerError(() => rebindToRestored(UNKNOWN_LEDGER_ID)),
      ).toMatchObject({ reason: 'NOT_FOUND', field: 'ledgerId' });
      expect(
        captureLedgerError(() =>
          context.repository.rebindScope({
            ledgerId: context.ledgerId,
            container: worktreeContainer('', 'workspace-1'),
            containerCreatedAt: RESTORED_CREATED_AT,
          }),
        ),
      ).toMatchObject({
        reason: 'INVALID_INPUT',
        field: 'container.worktreeId',
      });
      expect(
        captureLedgerError(() =>
          context.repository.rebindScope({
            ledgerId: context.ledgerId,
            container: RESTORED_CONTAINER,
            containerCreatedAt: 'after the restore',
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'containerCreatedAt' });
      expect(
        context.repository.getScope(context.ledgerId)?.lifecycleState,
      ).toBe('archived');
    });

    it('rolls back a rebind that fails before commit', () => {
      const archived = setLifecycle('archived');
      context.faults.failNext('rebindScope');
      expect(captureLedgerError(() => rebindToRestored()).reason).toBe(
        'STORAGE_UNAVAILABLE',
      );
      expect(context.repository.getScope(context.ledgerId)).toEqual(archived);
      expect(
        context.repository.findScope({
          container: RESTORED_CONTAINER,
          containerCreatedAt: RESTORED_CREATED_AT,
        }),
      ).toBeNull();
    });

    it('replicates the rebind as a restore naming the new container', () => {
      setLifecycle('archived');
      rebindToRestored();
      context.repository.close();

      const events = readOutbox(context.databasePath, context.ledgerId);
      expect(events[events.length - 1]).toEqual({
        sequence: 8,
        kind: 'scope_restored',
        payload: {
          scope: {
            ledgerId: context.ledgerId,
            authorityId: AUTHORITY_ID,
            container: RESTORED_CONTAINER,
          },
          containerCreatedAt: RESTORED_CREATED_AT,
        },
      });
    });
  });

  describe('purgeScope', () => {
    /** Another worktree's scope with an actor and an entry. */
    function seedOtherScope(): {
      readonly ledgerId: string;
      readonly receipt: LedgerCommandReceipt;
    } {
      const ledgerId = bindWorktree(worktreeContainer('worktree-2')).scope
        .ledgerId;
      const chat = registerTestActor(
        context.repository,
        ledgerId,
        'chat',
        'chat:other',
        'Other chat',
      );
      const receipt = context.repository.addEntry(
        addInput({ ledgerId }, chat, TASK, 'other-task'),
      );
      return { ledgerId, receipt };
    }

    /** Entries, revisions, receipts and a summary in the test scope. */
    function fillScope(): void {
      const first = addTask();
      startTask(first);
      addTask(context.user);
      context.repository.publishSummary({
        ledgerId: context.ledgerId,
        helper: context.helper,
        helperDetails: NO_DETAILS,
        params: SUMMARY,
        idempotencyKey: `summary:${context.ledgerId}:snapshot-1`,
      });
      setLifecycle('archived');
    }

    it('removes every row of a retiring scope and leaves other scopes untouched', () => {
      const initial = context.repository.getStorageCounts();
      const other = seedOtherScope();
      const otherCounts = subtractCounts(
        context.repository.getStorageCounts(),
        initial,
      );
      const otherScope = context.repository.getScope(other.ledgerId);
      fillScope();
      setLifecycle('retirement_pending');

      expect(context.repository.purgeScope(context.ledgerId)).toEqual({
        purged: true,
      });

      expect(context.repository.getStorageCounts()).toEqual(otherCounts);
      expect(context.repository.getScope(context.ledgerId)).toBeNull();
      expect(context.repository.listScopes()).toEqual([otherScope]);
      expect(
        context.repository.getEntry({
          ledgerId: other.ledgerId,
          entryId: other.receipt.entry.entryId,
        }).entry,
      ).toEqual(other.receipt.entry);
      expect(
        context.repository
          .searchEntries({ ledgerId: other.ledgerId, query: 'Nightjar' })
          .entries.map((item) => item.entryId),
      ).toEqual([other.receipt.entry.entryId]);
      context.repository.close();

      readLedgerDatabase(context.databasePath, (raw) => {
        expect(countScopedRows(raw, context.ledgerId)).toEqual({
          ledger_scopes: 0,
          ledger_actors: 0,
          ledger_entries: 0,
          ledger_entry_versions: 0,
          ledger_mutations: 0,
          ledger_command_receipts: 0,
          ledger_outbox: 0,
        });
        // The full-text index holds only the other scope's entry.
        expect(countRows(raw, 'ledger_search')).toBe(1);
        expect(countRows(raw, 'ledger_search_docsize')).toBe(1);
        expect(
          raw
            .prepare(
              'SELECT rowid FROM ledger_search WHERE ledger_search MATCH ?',
            )
            .all('"Nightjar"')
            .map((row) => Number(row.rowid)),
        ).toEqual(
          raw
            .prepare(
              'SELECT entry_rowid FROM ledger_entries WHERE ledger_id = ?',
            )
            .all(other.ledgerId)
            .map((row) => Number(row.entry_rowid)),
        );
      });
    });

    it('purges only retiring scopes', () => {
      fillScope();
      setLifecycle('active');
      const counts = context.repository.getStorageCounts();
      for (const state of ['active', 'archived'] as const) {
        setLifecycle(state);
        expect(
          captureLedgerError(() =>
            context.repository.purgeScope(context.ledgerId),
          ),
        ).toMatchObject({ reason: 'FORBIDDEN', field: 'ledgerId' });
      }
      expect(
        context.repository.getScope(context.ledgerId)?.lifecycleState,
      ).toBe('archived');
      // Only the second archive's event was added.
      expect(context.repository.getStorageCounts()).toEqual({
        ...counts,
        outbox: counts.outbox + 1,
      });
    });

    it('reports an unknown or already purged scope as not purged', () => {
      expect(context.repository.purgeScope(UNKNOWN_LEDGER_ID)).toEqual({
        purged: false,
      });
      setLifecycle('retirement_pending');
      expect(context.repository.purgeScope(context.ledgerId)).toEqual({
        purged: true,
      });
      expect(context.repository.purgeScope(context.ledgerId)).toEqual({
        purged: false,
      });
      expect(captureLedgerError(() => setLifecycle('archived')).reason).toBe(
        'NOT_FOUND',
      );
      expect(
        captureLedgerError(() => context.repository.purgeScope('')),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'ledgerId' });
    });

    it('frees the container incarnation for a new ledger', () => {
      setLifecycle('retirement_pending');
      context.repository.purgeScope(context.ledgerId);
      expect(
        context.repository.findContainerScopes(WORKTREE_CONTAINER),
      ).toEqual([]);
      const reminted = bindWorktree(WORKTREE_CONTAINER);
      expect(reminted.scope.ledgerId).not.toBe(context.ledgerId);
      expect(reminted.sequence).toBe('1');
    });

    it('rolls back a purge that fails before commit', () => {
      fillScope();
      const retiring = setLifecycle('retirement_pending');
      const counts = context.repository.getStorageCounts();
      context.faults.failNext('purgeScope');
      expect(
        captureLedgerError(() =>
          context.repository.purgeScope(context.ledgerId),
        ).reason,
      ).toBe('STORAGE_UNAVAILABLE');
      expect(context.repository.getScope(context.ledgerId)).toEqual(retiring);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('reaches every row, and every row its deletes check, through an index', () => {
      context.repository.close();
      expect(
        unindexedPurgeSteps(context.databasePath, context.ledgerId),
      ).toEqual([]);
    });
  });

  describe('listScopes and findContainerScopes', () => {
    it('lists every scope in the order it was minted, whatever its state', () => {
      const other = bindWorktree(worktreeContainer('worktree-2'));
      const cowork = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'worktree-1',
        },
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      }).scope;
      setLifecycle('archived');
      const retiring = setLifecycle('retirement_pending', other.scope.ledgerId);
      expect(context.repository.listScopes()).toEqual([
        context.repository.getScope(context.ledgerId),
        retiring,
        cowork,
      ]);
    });

    it('finds every incarnation of one container in mint order, and nothing else', () => {
      const later = bindWorktree(WORKTREE_CONTAINER, '2026-09-10T08:00:00Z');
      // Minted after `later`, for an older incarnation.
      const earlier = bindWorktree(WORKTREE_CONTAINER, '2026-08-01T08:00:00Z');
      bindWorktree(worktreeContainer('worktree-1', 'workspace-2'));
      bindWorktree(worktreeContainer('worktree-2'));
      context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'worktree-1',
        },
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      });
      const counts = context.repository.getStorageCounts();

      expect(
        context.repository
          .findContainerScopes(WORKTREE_CONTAINER)
          .map((record) => [record.scope.ledgerId, record.containerCreatedAt]),
      ).toEqual([
        [context.ledgerId, CONTAINER_CREATED_AT],
        [later.scope.ledgerId, '2026-09-10T08:00:00.000Z'],
        [earlier.scope.ledgerId, '2026-08-01T08:00:00.000Z'],
      ]);
      expect(
        context.repository.findContainerScopes(worktreeContainer('none')),
      ).toEqual([]);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('lists a rebound scope under its restored container only', () => {
      setLifecycle('archived');
      const rebound = rebindToRestored();
      expect(
        context.repository.findContainerScopes(WORKTREE_CONTAINER),
      ).toEqual([]);
      expect(
        context.repository.findContainerScopes(RESTORED_CONTAINER),
      ).toEqual([rebound]);
    });

    it('rejects a malformed container', () => {
      expect(
        captureLedgerError(() =>
          context.repository.findContainerScopes(
            withUncheckedFields(WORKTREE_CONTAINER, { kind: 'folder' }),
          ),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'container.kind' });
    });
  });

  describe('global scopes', () => {
    /** A global Ledger with an actor and an entry, and its outbox so far. */
    function seedGlobalScope(): {
      readonly scope: LedgerScopeRecord;
      readonly receipt: LedgerCommandReceipt;
    } {
      const scope = bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      const ledgerId = scope.scope.ledgerId;
      const agent = registerTestActor(
        context.repository,
        ledgerId,
        'pipeline_agent',
        'pipeline:attempt-1',
        'Review step',
      );
      const receipt = context.repository.addEntry(
        addInput({ ledgerId }, agent, TASK, 'global-task'),
      );
      return {
        scope: context.repository.getScope(ledgerId) ?? scope,
        receipt,
      };
    }

    it('is always active: every lifecycle move is refused without writing', () => {
      const { scope } = seedGlobalScope();
      const ledgerId = scope.scope.ledgerId;
      const counts = context.repository.getStorageCounts();
      const states: LedgerScopeLifecycleState[] = [
        'archived',
        'retirement_pending',
        'active',
      ];
      for (const state of states) {
        expect(
          captureLedgerError(() => setLifecycle(state, ledgerId)),
        ).toMatchObject({ reason: 'FORBIDDEN', field: 'container.kind' });
      }
      expect(context.repository.getScope(ledgerId)).toEqual(scope);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('is never moved to another container', () => {
      const { scope } = seedGlobalScope();
      const ledgerId = scope.scope.ledgerId;
      const counts = context.repository.getStorageCounts();
      for (const [container, containerCreatedAt] of [
        [scope.scope.container, scope.containerCreatedAt],
        [globalContainer(ORGANIZATION_OWNER), RESTORED_CREATED_AT],
        [RESTORED_CONTAINER, RESTORED_CREATED_AT],
      ] as const) {
        expect(
          captureLedgerError(() =>
            context.repository.rebindScope({
              ledgerId,
              container,
              containerCreatedAt,
            }),
          ),
        ).toMatchObject({ reason: 'FORBIDDEN', field: 'container.kind' });
      }
      expect(context.repository.getScope(ledgerId)).toEqual(scope);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('never rebinds a task scope to a global container', () => {
      setLifecycle('archived');
      const counts = context.repository.getStorageCounts();
      expect(
        captureLedgerError(() =>
          context.repository.rebindScope({
            ledgerId: context.ledgerId,
            container: globalContainer(PERSONAL_OWNER),
            containerCreatedAt: RESTORED_CREATED_AT,
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'container.kind' });
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('is never purged', () => {
      const { scope, receipt } = seedGlobalScope();
      const ledgerId = scope.scope.ledgerId;
      const counts = context.repository.getStorageCounts();
      expect(
        captureLedgerError(() => context.repository.purgeScope(ledgerId)),
      ).toMatchObject({ reason: 'FORBIDDEN', field: 'container.kind' });
      expect(context.repository.getScope(ledgerId)).toEqual(scope);
      expect(
        context.repository.getEntry({
          ledgerId,
          entryId: receipt.entry.entryId,
        }).entry,
      ).toEqual(receipt.entry);
      expect(context.repository.getStorageCounts()).toEqual(counts);
      context.repository.close();
      expect(readGlobalBindings(context.databasePath)).toHaveLength(1);
    });

    it('is listed with the other scopes, as a global container', () => {
      const { scope } = seedGlobalScope();
      expect(
        context.repository
          .listScopes()
          .map((record) => [record.scope.ledgerId, record.scope.container]),
      ).toEqual([
        [context.ledgerId, WORKTREE_CONTAINER],
        [scope.scope.ledgerId, globalContainer(PERSONAL_OWNER)],
      ]);
    });
  });
});
