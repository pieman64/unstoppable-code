import type { LedgerContainer } from '@canopy/protocol/canopy-core';

import { LEDGER_SCHEMA_VERSION } from '../schema';
import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  ORGANIZATION_OWNER,
  OTHER_ORGANIZATION_OWNER,
  PERSONAL_OWNER,
  WORKTREE_CONTAINER,
  bindGlobal,
  globalContainer,
  organizationOwner,
  readGlobalBindings,
  withUncheckedFields,
  worktreeContainer,
  captureLedgerError,
  setUpLedger,
  type LedgerTestContext,
} from './ledger-test-harness';

describe('LedgerRepository scopes and actors', () => {
  let context: LedgerTestContext;

  beforeEach(() => {
    context = setUpLedger();
  });

  afterEach(() => {
    context.dispose();
  });

  describe('bindScope', () => {
    it('returns the same ledger for the same container incarnation', () => {
      const again = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: WORKTREE_CONTAINER,
        // The same instant in another offset is the same incarnation.
        containerCreatedAt: '2026-09-01T10:00:00+02:00',
        accountId: 'account-1',
      });
      expect(again.created).toBe(false);
      expect(again.scope.scope).toEqual({
        ledgerId: context.ledgerId,
        authorityId: AUTHORITY_ID,
        container: WORKTREE_CONTAINER,
      });
      expect(again.scope.containerCreatedAt).toBe(CONTAINER_CREATED_AT);
      expect(again.scope.lifecycleState).toBe('active');
    });

    it('mints a new ledger when a container ID is reused with a new creation time', () => {
      const reused = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: WORKTREE_CONTAINER,
        containerCreatedAt: '2026-09-20T08:00:00.000Z',
        accountId: 'account-1',
      });
      expect(reused.created).toBe(true);
      expect(reused.scope.scope.ledgerId).not.toBe(context.ledgerId);
      expect(context.repository.getScope(context.ledgerId)).not.toBeNull();
    });

    it('distinguishes container kinds that share identifiers', () => {
      const containers: LedgerContainer[] = [
        {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'worktree-1',
        },
        {
          kind: 'advisor_entry',
          appWorkspaceId: 'app-advisor',
          entryId: 'worktree-1',
        },
      ];
      const ledgerIds = containers.map(
        (container: LedgerContainer): string =>
          context.repository.bindScope({
            authorityId: AUTHORITY_ID,
            container,
            containerCreatedAt: CONTAINER_CREATED_AT,
            accountId: null,
          }).scope.scope.ledgerId,
      );
      expect(new Set([context.ledgerId, ...ledgerIds]).size).toBe(3);
      expect(
        context.repository.findScope({
          container: containers[1] ?? WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        })?.scope.container,
      ).toEqual(containers[1]);
    });

    it('keeps the account registered at first use', () => {
      const rebound = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: WORKTREE_CONTAINER,
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: 'account-2',
      });
      expect(rebound.scope.accountId).toBe('account-1');

      const signedOut = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer('worktree-2'),
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: null,
      });
      expect(signedOut.scope.accountId).toBeNull();
    });

    it('refuses to bind an existing ledger under another authority', () => {
      expect(
        captureLedgerError(() =>
          context.repository.bindScope({
            authorityId: 'another-authority',
            container: WORKTREE_CONTAINER,
            containerCreatedAt: CONTAINER_CREATED_AT,
            accountId: 'account-1',
          }),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN', field: 'authorityId' });
    });

    it('rejects malformed containers and creation times', () => {
      expect(
        captureLedgerError(() =>
          context.repository.bindScope({
            authorityId: AUTHORITY_ID,
            container: worktreeContainer('worktree-1', ''),
            containerCreatedAt: CONTAINER_CREATED_AT,
            accountId: null,
          }),
        ),
      ).toMatchObject({
        reason: 'INVALID_INPUT',
        field: 'container.workspaceId',
      });
      expect(
        captureLedgerError(() =>
          context.repository.bindScope({
            authorityId: AUTHORITY_ID,
            container: WORKTREE_CONTAINER,
            containerCreatedAt: 'last week',
            accountId: null,
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'containerCreatedAt' });
    });

    it('finds scopes without minting them', () => {
      const before = context.repository.getStorageCounts();
      expect(
        context.repository.findScope({
          container: worktreeContainer('never-used'),
          containerCreatedAt: CONTAINER_CREATED_AT,
        }),
      ).toBeNull();
      expect(context.repository.getStorageCounts()).toEqual(before);
      expect(
        context.repository.findScope({
          container: WORKTREE_CONTAINER,
          containerCreatedAt: CONTAINER_CREATED_AT,
        })?.scope.ledgerId,
      ).toBe(context.ledgerId);
      expect(
        context.repository.getScope('00000000-0000-4000-8000-00000000ffff'),
      ).toBeNull();
    });
  });

  describe('bindGlobalScope', () => {
    /** The scope's `scope_registered` payload, from the outbox. */
    function registration(ledgerId: string): unknown {
      const event = context.repository.readOutbox({
        ledgerId,
        afterSequence: '0',
        limit: 1,
      })[0];
      return event === undefined ? undefined : JSON.parse(event.payloadJson);
    }

    it('binds one global Ledger per owner and account and returns it again', () => {
      const first = context.repository.bindGlobalScope({
        authorityId: AUTHORITY_ID,
        owner: PERSONAL_OWNER,
        accountId: 'account-1',
      });
      expect(first.created).toBe(true);
      expect(first.scope).toMatchObject({
        scope: {
          authorityId: AUTHORITY_ID,
          container: { kind: 'global', owner: PERSONAL_OWNER },
        },
        containerCreatedAt: context.clock.iso(),
        accountId: 'account-1',
        lifecycleState: 'active',
        sequence: '1',
      });
      expect(registration(first.scope.scope.ledgerId)).toEqual({
        scope: first.scope.scope,
        containerCreatedAt: first.scope.containerCreatedAt,
        accountId: 'account-1',
      });

      // Repeated binds, even after the clock moved, find the same Ledger.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        context.clock.advance(60_000);
        const counts = context.repository.getStorageCounts();
        const again = context.repository.bindGlobalScope({
          authorityId: AUTHORITY_ID,
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        });
        expect(again).toEqual({ scope: first.scope, created: false });
        expect(context.repository.getStorageCounts()).toEqual(counts);
      }
      expect(
        context.repository.findGlobalScope({
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        }),
      ).toEqual(first.scope);
      context.repository.close();
      expect(readGlobalBindings(context.databasePath)).toEqual([
        {
          ownerKey: 'personal',
          accountKey: 'account:account-1',
          ledgerId: first.scope.scope.ledgerId,
        },
      ]);
    });

    it('keeps Personal and each organization apart', () => {
      const owners = [
        PERSONAL_OWNER,
        ORGANIZATION_OWNER,
        OTHER_ORGANIZATION_OWNER,
      ];
      const ledgerIds = owners.map(
        (owner) => bindGlobal(context.repository, owner, 'account-1').scope,
      );
      expect(new Set(ledgerIds.map((ref) => ref.ledgerId)).size).toBe(3);
      expect(ledgerIds.map((ref) => ref.container)).toEqual(
        owners.map(globalContainer),
      );
      owners.forEach((owner, index) => {
        expect(
          context.repository.findGlobalScope({ owner, accountId: 'account-1' })
            ?.scope,
        ).toEqual(ledgerIds[index]);
      });
      context.repository.close();
      expect(
        readGlobalBindings(context.databasePath).map((row) => row.ownerKey),
      ).toEqual([
        'org:00000000-0000-4000-8000-00000000a001',
        'org:00000000-0000-4000-8000-00000000a002',
        'personal',
      ]);
    });

    it('never shares a global Ledger between accounts or with signed-out use', () => {
      const accounts = ['account-1', 'account-2', null];
      const scopes = accounts.map((accountId) =>
        bindGlobal(context.repository, ORGANIZATION_OWNER, accountId),
      );
      expect(new Set(scopes.map((scope) => scope.scope.ledgerId)).size).toBe(3);
      expect(scopes.map((scope) => scope.accountId)).toEqual(accounts);
      accounts.forEach((accountId, index) => {
        expect(
          context.repository.findGlobalScope({
            owner: ORGANIZATION_OWNER,
            accountId,
          }),
        ).toEqual(scopes[index]);
      });
      const counts = context.repository.getStorageCounts();
      expect(
        context.repository.findGlobalScope({
          owner: ORGANIZATION_OWNER,
          accountId: 'account-3',
        }),
      ).toBeNull();
      expect(
        context.repository.findGlobalScope({
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        }),
      ).toBeNull();
      expect(context.repository.getStorageCounts()).toEqual(counts);
      context.repository.close();
      expect(
        readGlobalBindings(context.databasePath).map((row) => row.accountKey),
      ).toEqual(['account:account-1', 'account:account-2', 'signed_out']);
    });

    it('mints a unique incarnation when the clock repeats or goes backwards', () => {
      const start = context.clock.iso();
      const first = bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      // The same instant again.
      const second = bindGlobal(
        context.repository,
        PERSONAL_OWNER,
        'account-2',
      );
      // An earlier instant that collides with neither, then one that does.
      context.clock.advance(-5);
      const earlier = bindGlobal(context.repository, PERSONAL_OWNER, null);
      context.clock.advance(5);
      const third = bindGlobal(context.repository, PERSONAL_OWNER, 'account-3');
      const startMs = Date.parse(start);
      expect(
        [first, second, earlier, third].map((scope) =>
          Date.parse(scope.containerCreatedAt),
        ),
      ).toEqual([startMs, startMs + 1, startMs - 5, startMs + 2]);
      // Another owner is a separate container and may reuse the instant.
      expect(
        bindGlobal(context.repository, ORGANIZATION_OWNER, 'account-1')
          .containerCreatedAt,
      ).toBe(start);
    });

    it('keeps a global binding across restart', () => {
      const bound = bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      context.repository.close();
      context.clock.advance(3_600_000);
      const reopened = context.reopen();
      expect(
        reopened.findGlobalScope({
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        }),
      ).toEqual(bound);
      expect(
        reopened.bindGlobalScope({
          authorityId: AUTHORITY_ID,
          owner: PERSONAL_OWNER,
          accountId: 'account-1',
        }),
      ).toEqual({ scope: bound, created: false });
      expect(
        reopened.listScopes().map((scope) => scope.scope.container.kind),
      ).toEqual(['code_worktree', 'global']);
    });

    it('refuses an existing global Ledger under another authority', () => {
      bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      expect(
        captureLedgerError(() =>
          context.repository.bindGlobalScope({
            authorityId: 'another-authority',
            owner: PERSONAL_OWNER,
            accountId: 'account-1',
          }),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN', field: 'authorityId' });
    });

    it('rejects malformed owners, accounts and authorities without writing', () => {
      const counts = context.repository.getStorageCounts();
      const invalid: [() => unknown, string][] = [
        [
          (): unknown =>
            bindGlobal(
              context.repository,
              organizationOwner('00000000-0000-4000-8000-00000000A001'),
              'account-1',
            ),
          'owner.organizationId',
        ],
        [
          (): unknown =>
            bindGlobal(
              context.repository,
              withUncheckedFields(PERSONAL_OWNER, { kind: 'team' }),
              'account-1',
            ),
          'owner.kind',
        ],
        [
          (): unknown =>
            bindGlobal(
              context.repository,
              withUncheckedFields(PERSONAL_OWNER, { extra: true }),
              'account-1',
            ),
          'owner',
        ],
        [
          (): unknown => bindGlobal(context.repository, PERSONAL_OWNER, ''),
          'accountId',
        ],
        [
          (): unknown =>
            context.repository.bindGlobalScope({
              authorityId: '',
              owner: PERSONAL_OWNER,
              accountId: null,
            }),
          'authorityId',
        ],
        [
          (): unknown =>
            context.repository.findGlobalScope({
              owner: organizationOwner('not-a-uuid'),
              accountId: null,
            }),
          'owner.organizationId',
        ],
      ];
      for (const [run, field] of invalid) {
        expect(captureLedgerError(run)).toMatchObject({
          reason: 'INVALID_INPUT',
          field,
        });
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('is the only way to mint a global Ledger', () => {
      const bound = bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      const counts = context.repository.getStorageCounts();
      // Not a new incarnation, nor the one an existing binding minted.
      for (const [container, containerCreatedAt] of [
        [globalContainer(ORGANIZATION_OWNER), CONTAINER_CREATED_AT],
        [bound.scope.container, bound.containerCreatedAt],
      ] as const) {
        expect(
          captureLedgerError(() =>
            context.repository.bindScope({
              authorityId: AUTHORITY_ID,
              container,
              containerCreatedAt,
              accountId: 'account-2',
            }),
          ),
        ).toMatchObject({ reason: 'INVALID_INPUT', field: 'container.kind' });
      }
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });

    it('reads a bound global Ledger by ledger ID and by its incarnation', () => {
      const first = bindGlobal(context.repository, PERSONAL_OWNER, 'account-1');
      const second = bindGlobal(
        context.repository,
        PERSONAL_OWNER,
        'account-2',
      );
      bindGlobal(context.repository, ORGANIZATION_OWNER, 'account-1');
      const counts = context.repository.getStorageCounts();
      expect(context.repository.getScope(first.scope.ledgerId)).toEqual(first);
      expect(
        context.repository.findScope({
          container: first.scope.container,
          containerCreatedAt: first.containerCreatedAt,
        }),
      ).toEqual(first);
      expect(
        context.repository.findScope({
          container: first.scope.container,
          containerCreatedAt: '2020-01-01T00:00:00.000Z',
        }),
      ).toBeNull();
      // Every incarnation of the owner's container, whichever account.
      expect(
        context.repository.findContainerScopes(globalContainer(PERSONAL_OWNER)),
      ).toEqual([first, second]);
      expect(context.repository.getStorageCounts()).toEqual(counts);
    });
  });

  describe('registerActor', () => {
    it('registers each actor once per origin key, keeping its first snapshot', () => {
      const again = context.repository.registerActor({
        ledgerId: context.ledgerId,
        kind: 'chat',
        authorityId: AUTHORITY_ID,
        originKey: 'chat:1',
        displayName: 'Renamed chat',
      });
      expect(again.created).toBe(false);
      expect(again.actor.actor).toEqual(context.chat);
      expect(again.actor.displayName).toBe('Chat 1');
    });

    it('scopes actors to their ledger', () => {
      const otherLedger = context.repository.bindScope({
        authorityId: AUTHORITY_ID,
        container: worktreeContainer('worktree-2'),
        containerCreatedAt: CONTAINER_CREATED_AT,
        accountId: 'account-1',
      }).scope.scope.ledgerId;
      const otherUser = context.repository.registerActor({
        ledgerId: otherLedger,
        kind: 'user',
        authorityId: AUTHORITY_ID,
        originKey: 'user:local',
        displayName: 'You',
      });
      expect(otherUser.created).toBe(true);
      expect(otherUser.actor.actor.actorId).not.toBe(context.user.actorId);
    });

    it('rejects a repeat registration with another kind or authority', () => {
      expect(
        captureLedgerError(() =>
          context.repository.registerActor({
            ledgerId: context.ledgerId,
            kind: 'pipeline_agent',
            authorityId: AUTHORITY_ID,
            originKey: 'chat:1',
            displayName: 'Chat 1',
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'kind' });
      expect(
        captureLedgerError(() =>
          context.repository.registerActor({
            ledgerId: context.ledgerId,
            kind: 'chat',
            authorityId: 'another-authority',
            originKey: 'chat:1',
            displayName: 'Chat 1',
          }),
        ),
      ).toMatchObject({ reason: 'FORBIDDEN', field: 'authorityId' });
    });

    it('requires an existing ledger and valid input', () => {
      expect(
        captureLedgerError(() =>
          context.repository.registerActor({
            ledgerId: '00000000-0000-4000-8000-00000000ffff',
            kind: 'chat',
            authorityId: AUTHORITY_ID,
            originKey: 'chat:9',
            displayName: 'Chat 9',
          }),
        ),
      ).toMatchObject({ reason: 'NOT_FOUND' });
      expect(
        captureLedgerError(() =>
          context.repository.registerActor({
            ledgerId: context.ledgerId,
            kind: 'chat',
            authorityId: AUTHORITY_ID,
            originKey: 'chat:9',
            displayName: 'Line one\nline two',
          }),
        ),
      ).toMatchObject({ reason: 'INVALID_INPUT', field: 'displayName' });
    });

    it('lists actors in registration order', () => {
      expect(
        context.repository
          .listActors(context.ledgerId)
          .map((record) => [record.actor.kind, record.originKey]),
      ).toEqual([
        ['user', 'user:local'],
        ['chat', 'chat:1'],
        ['chat', 'chat:2'],
        ['background', 'summary:generation-1'],
        ['ledger_sidecar', 'sidecar:1'],
      ]);
    });
  });

  it('numbers scope and actor registrations in the scope sequence', () => {
    // One scope registration plus five actor registrations.
    expect(context.repository.getScope(context.ledgerId)?.sequence).toBe('6');
    expect(context.repository.getStorageCounts()).toMatchObject({
      scopes: 1,
      actors: 5,
      outbox: 6,
      entries: 0,
    });
  });

  it('persists scopes and actors across reopen', () => {
    context.repository.close();
    const reopened = context.reopen();
    expect(reopened.getScope(context.ledgerId)?.scope.container).toEqual(
      WORKTREE_CONTAINER,
    );
    expect(reopened.listActors(context.ledgerId)).toHaveLength(5);
    expect(reopened.schema).toEqual({
      version: LEDGER_SCHEMA_VERSION,
      readOnly: false,
    });
  });

  it('rejects use after close', () => {
    context.repository.close();
    context.repository.close();
    expect(context.repository.isOpen).toBe(false);
    expect(
      captureLedgerError(() => context.repository.getScope(context.ledgerId)),
    ).toMatchObject({
      reason: 'STORAGE_UNAVAILABLE',
      diagnosticCode: 'closed',
    });
  });
});
