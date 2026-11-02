import {
  isLedgerGlobalContainer,
  isSameLedgerGlobalOwner,
  ledgerGlobalOwnerKey,
  LedgerContainerSchema,
  LedgerGlobalOwnerSchema,
  parseLedgerGlobalOwner,
} from '../index';

const ORG_ID = '0b4f8a52-7c1d-4e8a-9f3b-2d6c1e5a7b90';

describe('global Ledger owner and container', () => {
  it('accepts a Personal and an organization global container', () => {
    expect(
      LedgerContainerSchema.parse({
        kind: 'global',
        owner: { kind: 'personal' },
      }),
    ).toEqual({ kind: 'global', owner: { kind: 'personal' } });
    const organization = LedgerContainerSchema.parse({
      kind: 'global',
      owner: { kind: 'organization', organizationId: ORG_ID },
    });
    expect(isLedgerGlobalContainer(organization)).toBe(true);
  });

  it('rejects unknown keys, non-UUID ids and mixed-case ids', () => {
    expect(
      LedgerContainerSchema.safeParse({
        kind: 'global',
        owner: { kind: 'personal' },
        workspaceId: 'w',
      }).success,
    ).toBe(false);
    expect(
      LedgerGlobalOwnerSchema.safeParse({ kind: 'personal', extra: true })
        .success,
    ).toBe(false);
    expect(
      LedgerGlobalOwnerSchema.safeParse({
        kind: 'organization',
        organizationId: 'org-1',
      }).success,
    ).toBe(false);
    expect(
      LedgerGlobalOwnerSchema.safeParse({
        kind: 'organization',
        organizationId: ORG_ID.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      LedgerGlobalOwnerSchema.safeParse({ kind: 'organization' }).success,
    ).toBe(false);
  });

  it('keeps existing container variants unchanged', () => {
    expect(
      isLedgerGlobalContainer(
        LedgerContainerSchema.parse({
          kind: 'code_worktree',
          workspaceId: 'w',
          worktreeId: 't',
        }),
      ),
    ).toBe(false);
  });

  it('keys owners as personal or org:<lowercase uuid>', () => {
    expect(ledgerGlobalOwnerKey({ kind: 'personal' })).toBe('personal');
    expect(
      ledgerGlobalOwnerKey({ kind: 'organization', organizationId: ORG_ID }),
    ).toBe(`org:${ORG_ID}`);
    expect(
      isSameLedgerGlobalOwner(
        { kind: 'organization', organizationId: ORG_ID },
        { kind: 'personal' },
      ),
    ).toBe(false);
  });

  describe('parseLedgerGlobalOwner', () => {
    it('reads an absent context as Personal', () => {
      expect(parseLedgerGlobalOwner(undefined)).toEqual({
        ok: true,
        owner: { kind: 'personal' },
      });
      expect(parseLedgerGlobalOwner(null)).toEqual({
        ok: true,
        owner: { kind: 'personal' },
      });
    });

    it('reads personal and normalizes an organization id', () => {
      expect(parseLedgerGlobalOwner('personal')).toEqual({
        ok: true,
        owner: { kind: 'personal' },
      });
      expect(parseLedgerGlobalOwner(`org:${ORG_ID.toUpperCase()}`)).toEqual({
        ok: true,
        owner: { kind: 'organization', organizationId: ORG_ID },
      });
    });

    it.each(['', 'Personal', 'org:', 'org:not-a-uuid', ORG_ID, 'team:x'])(
      'fails closed on %j',
      (value) => {
        expect(parseLedgerGlobalOwner(value)).toEqual({
          ok: false,
          reason: 'malformed_owner',
        });
      },
    );
  });
});
