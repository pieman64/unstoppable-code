import type { LedgerContainer } from '@canopy/protocol/canopy-core';

import { LEDGER_SCHEMA_VERSION } from '../schema';
import {
  AUTHORITY_ID,
  CONTAINER_CREATED_AT,
  WORKTREE_CONTAINER,
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
