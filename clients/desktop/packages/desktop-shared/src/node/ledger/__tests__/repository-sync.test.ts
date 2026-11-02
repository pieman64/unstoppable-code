import { createHash } from 'node:crypto';

import type {
  LedgerAddEntryParams,
  LedgerGlobalOwner,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from '../errors';
import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  ORGANIZATION_OWNER,
  PERSONAL_OWNER,
  addInput,
  bindGlobal,
  readGlobalBindings,
  readLedgerDatabase,
  registerTestActor,
  setUpLedger,
  updateInput,
  withUncheckedFields,
  worktreeContainer,
  type LedgerTestContext,
} from './ledger-test-harness';

/*
 * What the store keeps for sync: how far the mirror acknowledged each scope,
 * the audience it last confirmed, why a scope stopped syncing, and which
 * outbox events are still to send. Policy (whether a scope may sync at all)
 * belongs to the host; the store reports what it knows.
 */

const TASK: LedgerAddEntryParams = {
  type: 'TASK',
  title: 'Write the release notes',
  content: 'Cover the Ledger panel.',
};
const ORGANIZATION_AUDIENCE = {
  kind: 'organization' as const,
  organizationId: '00000000-0000-4000-8000-0000000000b1',
  trackedWorkspaceId: '00000000-0000-4000-8000-0000000000b2',
  expiresAt: '2026-10-01T12:00:00.000Z',
};

function reason(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerStoreError) return error.reason;
    throw error;
  }
  throw new Error('Expected a store error');
}

describe('LedgerRepository sync bookkeeping', () => {
  let context: LedgerTestContext;

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  it('lists every scope with nothing acknowledged at first', () => {
    const { repository, ledgerId } = context;

    expect(repository.listSyncScopes()).toEqual([
      {
        scope: repository.getScope(ledgerId),
        // The scope and its five actors are events 1 to 6.
        acknowledgedSequence: '0',
        mirrorAudience: null,
        audienceConfirmedAt: null,
        repairReason: null,
      },
    ]);
    expect(repository.getScope(ledgerId)?.sequence).toBe('6');
    expect(repository.getScopeSync(ledgerId)).toEqual(
      repository.listSyncScopes()[0],
    );
    expect(
      repository.getScopeSync('00000000-0000-4000-8000-00000000ffff'),
    ).toBeNull();
  });

  it('reads the outbox in order, as the canonical text its hashes cover', () => {
    const { repository, ledgerId } = context;
    repository.addEntry(addInput(context, context.user, TASK, 'sync-1'));

    const events = repository.readOutbox({
      ledgerId,
      afterSequence: '0',
      limit: 100,
    });

    expect(events.map((event) => event.kind)).toEqual([
      'scope_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'actor_registered',
      'entry_revision',
    ]);
    expect(events.map((event) => event.scopeSequence)).toEqual(
      events.map((_event, index) => String(index + 1)),
    );
    for (const event of events) {
      expect(
        createHash('sha256').update(event.payloadJson, 'utf8').digest('hex'),
      ).toBe(event.payloadHash);
    }
    expect(events.at(-1)).toMatchObject({ entryRevision: 1 });
    expect(events.at(-1)?.entryId).toEqual(expect.any(String));
    expect(events[0]).toMatchObject({ entryId: null, entryRevision: null });
  });

  it('bounds an outbox read by events and by bytes, never below one event', () => {
    const { repository, ledgerId } = context;
    const all = repository.readOutbox({
      ledgerId,
      afterSequence: '0',
      limit: 100,
    });
    const [first, second] = all;
    if (first === undefined || second === undefined) {
      throw new Error('Missing events');
    }

    expect(
      repository
        .readOutbox({ ledgerId, afterSequence: '2', limit: 2 })
        .map((event) => event.scopeSequence),
    ).toEqual(['3', '4']);
    // Two events fit the budget; the third would pass it.
    const twoEvents =
      Buffer.byteLength(first.payloadJson) +
      Buffer.byteLength(second.payloadJson);
    expect(
      repository.readOutbox({
        ledgerId,
        afterSequence: '0',
        limit: 100,
        maxPayloadBytes: twoEvents,
      }),
    ).toHaveLength(2);
    // An event larger than the budget still travels, alone.
    expect(
      repository.readOutbox({
        ledgerId,
        afterSequence: '0',
        limit: 100,
        maxPayloadBytes: 1,
      }),
    ).toEqual([first]);
    expect(
      repository.readOutbox({ ledgerId, afterSequence: '6', limit: 100 }),
    ).toEqual([]);
    for (const input of [
      { ledgerId, afterSequence: '0', limit: 0 },
      { ledgerId, afterSequence: '0', limit: 101 },
      { ledgerId, afterSequence: '-1', limit: 1 },
      { ledgerId, afterSequence: '0', limit: 1, maxPayloadBytes: 0 },
    ]) {
      expect(reason(() => repository.readOutbox(input))).toBe('INVALID_INPUT');
    }
  });

  it('acknowledges events once, drops them from the outbox and never goes back', () => {
    const { repository, ledgerId } = context;
    const before = repository.getStorageCounts().outbox;

    expect(
      repository.acknowledgeOutbox({ ledgerId, sequence: '4' }),
    ).toMatchObject({ acknowledgedSequence: '4' });
    expect(repository.getStorageCounts().outbox).toBe(before - 4);
    expect(
      repository
        .readOutbox({ ledgerId, afterSequence: '0', limit: 100 })
        .map((event) => event.scopeSequence),
    ).toEqual(['5', '6']);

    // A late answer for an earlier batch changes nothing.
    expect(
      repository.acknowledgeOutbox({ ledgerId, sequence: '2' }),
    ).toMatchObject({ acknowledgedSequence: '4' });
    // The mirror cannot have acknowledged what was never written.
    expect(
      reason(() => repository.acknowledgeOutbox({ ledgerId, sequence: '7' })),
    ).toBe('INVALID_INPUT');
    expect(
      reason(() =>
        repository.acknowledgeOutbox({
          ledgerId: '00000000-0000-4000-8000-00000000ffff',
          sequence: '1',
        }),
      ),
    ).toBe('NOT_FOUND');

    const reopened = ((): string => {
      repository.close();
      const next = context.reopen();
      return next.getScopeSync(ledgerId)?.acknowledgedSequence ?? '';
    })();
    expect(reopened).toBe('4');
  });

  it('reports each revision as waiting until the mirror has it', () => {
    const { repository, ledgerId } = context;
    const created = repository.addEntry(
      addInput(context, context.user, TASK, 'sync-1'),
    );
    expect(created).toMatchObject({ localSequence: '7', syncState: 'pending' });
    const read = (): unknown[] => [
      repository.getEntry({ ledgerId, entryId: created.entry.entryId })
        .syncState,
      repository.searchEntries({ ledgerId }).entries[0]?.syncState,
      // A replay reports where the entry stands now, not when it committed.
      repository.addEntry(addInput(context, context.user, TASK, 'sync-1'))
        .syncState,
    ];
    expect(read()).toEqual(['pending', 'pending', 'pending']);

    repository.acknowledgeOutbox({ ledgerId, sequence: '7' });
    expect(read()).toEqual(['mirrored', 'mirrored', 'mirrored']);

    // The next revision waits again, and its snapshot row with it.
    const updated = repository.updateEntry(
      updateInput(
        context,
        context.user,
        {
          entryId: created.entry.entryId,
          expectedRevision: 1,
          status: 'IN_PROGRESS',
        },
        'sync-2',
        { mayUpdateAnyOpenEntry: true },
      ),
    );
    expect(updated).toMatchObject({ localSequence: '8', syncState: 'pending' });
    expect(
      repository.getEntry({ ledgerId, entryId: created.entry.entryId })
        .syncState,
    ).toBe('pending');
    expect(repository.searchEntries({ ledgerId }).entries[0]?.syncState).toBe(
      'pending',
    );
    // A change that changes nothing reports its entry's state.
    expect(
      repository.updateEntry(
        updateInput(
          context,
          context.user,
          {
            entryId: created.entry.entryId,
            expectedRevision: 2,
            status: 'IN_PROGRESS',
          },
          'sync-3',
          { mayUpdateAnyOpenEntry: true },
        ),
      ),
    ).toMatchObject({ changed: false, syncState: 'pending' });
  });

  it('replays a change that changed nothing with the state of the revision it returned', () => {
    const { repository, ledgerId } = context;
    const created = repository.addEntry(
      addInput(context, context.user, TASK, 'sync-1'),
    );
    repository.acknowledgeOutbox({ ledgerId, sequence: '7' });
    // A later entry the mirror does not have yet.
    repository.addEntry(
      addInput(context, context.user, { ...TASK, title: 'Later' }, 'sync-2'),
    );
    const noop = (): unknown =>
      repository.updateEntry(
        updateInput(
          context,
          context.user,
          {
            entryId: created.entry.entryId,
            expectedRevision: 1,
            status: 'TODO',
          },
          'sync-3',
          { mayUpdateAnyOpenEntry: true },
        ),
      );

    const original = noop();
    const replayed = noop();

    expect(original).toMatchObject({
      changed: false,
      localSequence: '8',
      syncState: 'mirrored',
    });
    expect(replayed).toEqual(original);
  });

  it('marks what a scope in need of repair has not sent, and nothing else', () => {
    const { repository, ledgerId } = context;
    const sent = repository.addEntry(
      addInput(context, context.user, TASK, 'sent'),
    );
    repository.acknowledgeOutbox({ ledgerId, sequence: '7' });
    const waiting = repository.addEntry(
      addInput(context, context.user, TASK, 'waiting'),
    );

    expect(
      repository.setScopeRepair({ ledgerId, reason: 'stale_writer' }),
    ).toMatchObject({
      repairReason: 'stale_writer',
      acknowledgedSequence: '7',
    });
    const state = (entryId: string): unknown =>
      repository.getEntry({ ledgerId, entryId }).syncState;
    expect(state(sent.entry.entryId)).toBe('mirrored');
    expect(state(waiting.entry.entryId)).toBe('repair_needed');
    expect(
      repository.addEntry(addInput(context, context.user, TASK, 'later'))
        .syncState,
    ).toBe('repair_needed');

    expect(repository.setScopeRepair({ ledgerId, reason: null })).toMatchObject(
      { repairReason: null },
    );
    expect(state(waiting.entry.entryId)).toBe('pending');
    expect(
      reason(() =>
        repository.setScopeRepair(
          // Not a reason the store knows.
          withUncheckedFields(
            { ledgerId, reason: null },
            { reason: 'who knows' },
          ),
        ),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('keeps a scope first used signed out on this device', () => {
    const { repository } = context;
    const container = worktreeContainer('worktree-signed-out');
    const signedOut = repository.bindScope({
      authorityId: AUTHORITY_ID,
      container,
      containerCreatedAt: CONTAINER_CREATED_AT,
      accountId: null,
    }).scope.scope.ledgerId;
    const user = registerTestActor(
      repository,
      signedOut,
      'user',
      'user:local',
      'You',
    );

    const created = repository.addEntry(
      addInput({ ledgerId: signedOut }, user, TASK, 'local-1'),
    );

    expect(created.syncState).toBe('local_only');
    expect(
      repository.getEntry({
        ledgerId: signedOut,
        entryId: created.entry.entryId,
      }).syncState,
    ).toBe('local_only');
    expect(
      repository.searchEntries({ ledgerId: signedOut }).entries[0]?.syncState,
    ).toBe('local_only');
  });

  it('remembers the audience the mirror confirmed, and when', () => {
    const { repository, ledgerId, clock } = context;

    expect(
      repository.recordMirrorAudience({
        ledgerId,
        audience: ORGANIZATION_AUDIENCE,
      }),
    ).toMatchObject({
      mirrorAudience: ORGANIZATION_AUDIENCE,
      audienceConfirmedAt: clock.iso(),
    });
    clock.advance(60_000);
    expect(
      repository.recordMirrorAudience({
        ledgerId,
        audience: { kind: 'private' },
      }),
    ).toMatchObject({
      mirrorAudience: { kind: 'private' },
      audienceConfirmedAt: clock.iso(),
      acknowledgedSequence: '0',
    });
    expect(
      reason(() =>
        repository.recordMirrorAudience(
          withUncheckedFields(
            { ledgerId, audience: { kind: 'private' as const } },
            { audience: { kind: 'everyone' } },
          ),
        ),
      ),
    ).toBe('INVALID_INPUT');
  });

  it('moves the scopes of a merged guest account, and only those', () => {
    const { repository, ledgerId } = context;
    const bind = (worktreeId: string, accountId: string | null): string =>
      repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer(worktreeId),
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId,
      }).scope.scope.ledgerId;
    const guestScope = bind('worktree-guest', 'guest-account');
    const otherScope = bind('worktree-other', 'other-account');
    const signedOutScope = bind('worktree-signed-out', null);

    expect(
      repository.rebindAccount({
        fromAccountId: 'guest-account',
        toAccountId: 'real-account',
      }),
    ).toEqual({ rebound: 1 });

    const accountOf = (id: string): unknown =>
      repository.getScope(id)?.accountId;
    expect(accountOf(guestScope)).toBe('real-account');
    expect(accountOf(otherScope)).toBe('other-account');
    expect(accountOf(signedOutScope)).toBeNull();
    expect(accountOf(ledgerId)).toBe('account-1');
    // Its first event still names the guest: events are never rewritten.
    expect(
      repository.readOutbox({
        ledgerId: guestScope,
        afterSequence: '0',
        limit: 1,
      })[0]?.payloadJson,
    ).toContain('"accountId":"guest-account"');
    // Again, it moves nothing.
    expect(
      repository.rebindAccount({
        fromAccountId: 'guest-account',
        toAccountId: 'real-account',
      }),
    ).toEqual({ rebound: 0 });
    for (const input of [
      { fromAccountId: '', toAccountId: 'real-account' },
      { fromAccountId: 'guest-account', toAccountId: '' },
      { fromAccountId: 'same-account', toAccountId: 'same-account' },
    ]) {
      expect(reason(() => repository.rebindAccount(input))).toBe(
        'INVALID_INPUT',
      );
    }
  });

  describe('global bindings on a guest merge', () => {
    /** A global Ledger with one agent entry, as a pipeline run leaves it. */
    function seedGlobal(
      owner: LedgerGlobalOwner,
      accountId: string | null,
    ): { readonly ledgerId: string; readonly entryId: string } {
      const ledgerId = bindGlobal(context.repository, owner, accountId).scope
        .ledgerId;
      const agent = registerTestActor(
        context.repository,
        ledgerId,
        'pipeline_agent',
        'pipeline:attempt-1',
        'Review step',
      );
      const entryId = context.repository.addEntry(
        addInput({ ledgerId }, agent, TASK, `global-${ledgerId}`),
      ).entry.entryId;
      return { ledgerId, entryId };
    }

    function find(
      owner: LedgerGlobalOwner,
      accountId: string | null,
    ): string | undefined {
      return context.repository.findGlobalScope({ owner, accountId })?.scope
        .ledgerId;
    }

    it('moves a guest binding the destination account lacks', () => {
      const { repository } = context;
      const personal = seedGlobal(PERSONAL_OWNER, 'guest-account');
      const organization = seedGlobal(ORGANIZATION_OWNER, 'guest-account');
      const signedOut = seedGlobal(PERSONAL_OWNER, null);
      const counts = repository.getStorageCounts();

      expect(
        repository.rebindAccount({
          fromAccountId: 'guest-account',
          toAccountId: 'real-account',
        }),
      ).toEqual({ rebound: 2 });

      expect(find(PERSONAL_OWNER, 'real-account')).toBe(personal.ledgerId);
      expect(find(ORGANIZATION_OWNER, 'real-account')).toBe(
        organization.ledgerId,
      );
      expect(find(PERSONAL_OWNER, 'guest-account')).toBeUndefined();
      expect(find(ORGANIZATION_OWNER, 'guest-account')).toBeUndefined();
      expect(repository.getScope(personal.ledgerId)?.accountId).toBe(
        'real-account',
      );
      // Signed-out use is never part of a merge (LD02).
      expect(find(PERSONAL_OWNER, null)).toBe(signedOut.ledgerId);
      expect(repository.getScope(signedOut.ledgerId)?.accountId).toBeNull();
      expect(repository.getStorageCounts()).toEqual(counts);
      // The moved binding keeps answering binds for the new account.
      expect(
        repository.bindGlobalScope({
          authorityId: AUTHORITY_ID,
          owner: PERSONAL_OWNER,
          accountId: 'real-account',
        }).created,
      ).toBe(false);
    });

    it('keeps the destination binding and both Ledgers when the destination is already bound', () => {
      const { repository, databasePath } = context;
      const destination = seedGlobal(PERSONAL_OWNER, 'real-account');
      const guest = seedGlobal(PERSONAL_OWNER, 'guest-account');
      const guestOrganization = seedGlobal(ORGANIZATION_OWNER, 'guest-account');
      const counts = repository.getStorageCounts();
      const guestOutbox = repository.readOutbox({
        ledgerId: guest.ledgerId,
        afterSequence: '0',
        limit: 100,
      });

      expect(
        repository.rebindAccount({
          fromAccountId: 'guest-account',
          toAccountId: 'real-account',
        }),
      ).toEqual({ rebound: 2 });

      // New entries go to the destination's own Ledger...
      expect(find(PERSONAL_OWNER, 'real-account')).toBe(destination.ledgerId);
      expect(find(ORGANIZATION_OWNER, 'real-account')).toBe(
        guestOrganization.ledgerId,
      );
      expect(find(PERSONAL_OWNER, 'guest-account')).toBeUndefined();
      // ...and the guest's Ledger keeps its entries, actors and outbox,
      // addressed by its ledger ID, under the account it merged into.
      expect(repository.getScope(guest.ledgerId)?.accountId).toBe(
        'real-account',
      );
      expect(
        repository.getEntry({
          ledgerId: guest.ledgerId,
          entryId: guest.entryId,
        }).entry.scope.ledgerId,
      ).toBe(guest.ledgerId);
      expect(repository.listActors(guest.ledgerId)).toHaveLength(1);
      expect(
        repository.readOutbox({
          ledgerId: guest.ledgerId,
          afterSequence: '0',
          limit: 100,
        }),
      ).toEqual(guestOutbox);
      expect(repository.getStorageCounts()).toEqual(counts);
      repository.close();
      expect(readGlobalBindings(databasePath)).toEqual([
        {
          ownerKey: 'org:00000000-0000-4000-8000-00000000a001',
          accountKey: 'account:real-account',
          ledgerId: guestOrganization.ledgerId,
        },
        {
          ownerKey: 'personal',
          accountKey: 'account:real-account',
          ledgerId: destination.ledgerId,
        },
      ]);
    });

    it('leaves every binding as it was when the merge fails before commit', () => {
      const { repository, databasePath } = context;
      seedGlobal(PERSONAL_OWNER, 'real-account');
      const guest = seedGlobal(PERSONAL_OWNER, 'guest-account');
      seedGlobal(ORGANIZATION_OWNER, 'guest-account');
      context.faults.failNext('rebindAccount');
      expect(
        reason(() =>
          repository.rebindAccount({
            fromAccountId: 'guest-account',
            toAccountId: 'real-account',
          }),
        ),
      ).toBe('STORAGE_UNAVAILABLE');
      expect(find(PERSONAL_OWNER, 'guest-account')).toBe(guest.ledgerId);
      expect(repository.getScope(guest.ledgerId)?.accountId).toBe(
        'guest-account',
      );
      repository.close();
      expect(
        readGlobalBindings(databasePath).map((row) => row.accountKey),
      ).toEqual([
        'account:guest-account',
        'account:guest-account',
        'account:real-account',
      ]);
    });
  });

  it('removes a purged scope from the sync bookkeeping', () => {
    const { repository, ledgerId, databasePath } = context;
    repository.acknowledgeOutbox({ ledgerId, sequence: '3' });
    repository.setScopeLifecycle({ ledgerId, state: 'retirement_pending' });

    expect(repository.purgeScope(ledgerId)).toEqual({ purged: true });

    expect(repository.listSyncScopes()).toEqual([]);
    repository.close();
    expect(
      readLedgerDatabase(databasePath, (raw) =>
        raw.prepare('SELECT COUNT(*) AS total FROM ledger_scope_sync').get(),
      ),
    ).toEqual({ total: 0 });
  });
});
