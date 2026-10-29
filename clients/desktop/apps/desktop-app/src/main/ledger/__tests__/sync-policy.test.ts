import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import {
  desiredLedgerAudience,
  isLedgerAudienceApplied,
  ledgerAccountHold,
  ledgerSyncPolicyKey,
  resolveLedgerSyncDisposition,
  type LedgerSyncAccount,
  type LedgerSyncScope,
  type LedgerWorkspaceOwner,
} from '../sync-policy';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000c2';
const ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000b1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';
const LAPSED_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000b3';
const WORKTREE: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
};
const PERSONAL: LedgerWorkspaceOwner = { kind: 'personal' };
const ORGANIZATION: LedgerWorkspaceOwner = {
  kind: 'organization',
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};

function scope(
  accountId: string | null = ACCOUNT_ID,
  container: LedgerContainer = WORKTREE,
): LedgerSyncScope {
  return { accountId, container };
}

function account(
  overrides: Partial<LedgerSyncAccount> = {},
): LedgerSyncAccount {
  return {
    id: ACCOUNT_ID,
    organizationIds: new Set([ORGANIZATION_ID]),
    lapsedOrganizationIds: new Set(),
    summaries: 'organization',
    summariesProhibited: false,
    ...overrides,
  };
}

describe('resolveLedgerSyncDisposition', () => {
  it('shares an organization project with the organization', () => {
    expect(
      resolveLedgerSyncDisposition(scope(), account(), ORGANIZATION),
    ).toEqual({
      kind: 'sync',
      audience: { kind: 'organization', trackedWorkspaceId: PROJECT_ID },
    });
  });

  it('keeps everything else that syncs private', () => {
    const privately = { kind: 'sync', audience: { kind: 'private' } };
    for (const [record, signedIn, owner] of [
      // A Personal workspace, whatever the sharing choice.
      [scope(), account(), PERSONAL],
      // "Just me".
      [scope(), account({ summaries: 'private' }), ORGANIZATION],
      // An owner that could not be read is not assumed to be an organization.
      [scope(), account(), { kind: 'unknown' }],
      // No longer a member.
      [scope(), account({ organizationIds: new Set() }), ORGANIZATION],
      // The organization's teams capability lapsed.
      [
        scope(),
        account({ lapsedOrganizationIds: new Set([ORGANIZATION_ID]) }),
        ORGANIZATION,
      ],
      // An Advisor entry belongs to no project.
      [
        scope(ACCOUNT_ID, {
          kind: 'advisor_entry',
          appWorkspaceId: 'app-advisor',
          entryId: 'entry-1',
        }),
        account(),
        ORGANIZATION,
      ],
      // A project the mirror could not name.
      [scope(), account(), { ...ORGANIZATION, projectId: 'project-1' }],
    ] as const) {
      expect(resolveLedgerSyncDisposition(record, signedIn, owner)).toEqual(
        privately,
      );
    }
  });

  it('keeps a scope on this device while its own account is not signed in', () => {
    const waiting = { kind: 'hold', hold: 'local_only', canNarrow: false };
    for (const [record, signedIn] of [
      // First used signed out: never attached to an account that signs in.
      [scope(null), account()],
      // Signed out now.
      [scope(), null],
      // Another account is signed in.
      [scope(OTHER_ACCOUNT_ID), account()],
      // An account the mirror could not name.
      [scope('account-1'), account({ id: 'account-1' })],
    ] as const) {
      expect(
        resolveLedgerSyncDisposition(record, signedIn, ORGANIZATION),
      ).toEqual(waiting);
    }
  });

  it('holds uploads under a prohibition or with sharing off, and can still narrow', () => {
    expect(
      resolveLedgerSyncDisposition(
        scope(),
        // A prohibition pins sharing off; it is reported as the policy it is.
        account({ summaries: 'off', summariesProhibited: true }),
        ORGANIZATION,
      ),
    ).toEqual({ kind: 'hold', hold: 'policy_restricted', canNarrow: true });
    expect(
      resolveLedgerSyncDisposition(
        scope(),
        account({ summaries: 'off' }),
        ORGANIZATION,
      ),
    ).toEqual({ kind: 'hold', hold: 'local_only', canNarrow: true });
  });
});

describe('ledgerAccountHold', () => {
  it('names why an account uploads nothing, or null when it does', () => {
    expect(ledgerAccountHold(account())).toBeNull();
    expect(ledgerAccountHold(account({ summaries: 'private' }))).toBeNull();
    expect(ledgerAccountHold(account({ summaries: 'off' }))).toBe('local_only');
    expect(ledgerAccountHold(account({ summariesProhibited: true }))).toBe(
      'policy_restricted',
    );
  });
});

describe('the audience the mirror should hold', () => {
  it('is private for a scope that waits', () => {
    expect(
      desiredLedgerAudience({
        kind: 'hold',
        hold: 'local_only',
        canNarrow: true,
      }),
    ).toEqual({ kind: 'private' });
    const shared = {
      kind: 'organization',
      trackedWorkspaceId: PROJECT_ID,
    } as const;
    expect(desiredLedgerAudience({ kind: 'sync', audience: shared })).toBe(
      shared,
    );
  });

  it('is applied once the mirror holds the same project, or private', () => {
    const lease = {
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
      trackedWorkspaceId: PROJECT_ID,
      expiresAt: '2026-10-04T12:00:00.000Z',
    } as const;
    const shared = {
      kind: 'organization',
      trackedWorkspaceId: PROJECT_ID,
    } as const;

    expect(isLedgerAudienceApplied(shared, lease)).toBe(true);
    expect(
      isLedgerAudienceApplied({ kind: 'private' }, { kind: 'private' }),
    ).toBe(true);
    // Nothing confirmed yet, another project, or the other kind.
    expect(isLedgerAudienceApplied({ kind: 'private' }, null)).toBe(false);
    expect(isLedgerAudienceApplied(shared, { kind: 'private' })).toBe(false);
    expect(isLedgerAudienceApplied({ kind: 'private' }, lease)).toBe(false);
    expect(
      isLedgerAudienceApplied(
        { kind: 'organization', trackedWorkspaceId: ORGANIZATION_ID },
        lease,
      ),
    ).toBe(false);
  });
});

describe('ledgerSyncPolicyKey', () => {
  const sharing = account({
    organizationIds: new Set([ORGANIZATION_ID, LAPSED_ORGANIZATION_ID]),
    lapsedOrganizationIds: new Set([LAPSED_ORGANIZATION_ID]),
    summaries: 'organization',
  });

  it('ignores the order organizations were read in', () => {
    expect(
      ledgerSyncPolicyKey({
        ...sharing,
        organizationIds: new Set([LAPSED_ORGANIZATION_ID, ORGANIZATION_ID]),
      }),
    ).toBe(ledgerSyncPolicyKey(sharing));
  });

  it('changes with anything that decides what may sync, and where', () => {
    const keys = new Set(
      [
        sharing,
        { ...sharing, id: OTHER_ACCOUNT_ID },
        { ...sharing, organizationIds: new Set([ORGANIZATION_ID]) },
        { ...sharing, lapsedOrganizationIds: new Set<string>() },
        { ...sharing, summaries: 'private' as const },
        { ...sharing, summariesProhibited: true },
        null,
      ].map(ledgerSyncPolicyKey),
    );

    expect(keys.size).toBe(7);
  });
});
