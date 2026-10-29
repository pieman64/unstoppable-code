import {
  isSameWorkspaceContext,
  normalizePersonalOrganizationId,
  isWorkspaceContext,
  isWorkspaceContextState,
  PERSONAL_WORKSPACE_CONTEXT,
  parseWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '../index';

const ORG_ID = '3f7a2c1e-8b4d-4c6a-9e2f-1a2b3c4d5e6f';

describe('workspace context contract', () => {
  it('serializes Personal and organization contexts to stable strings', () => {
    expect(serializeWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT)).toBe(
      'personal',
    );
    expect(
      serializeWorkspaceContext({
        kind: 'organization',
        organizationId: ORG_ID,
      }),
    ).toBe(`org:${ORG_ID}`);
  });

  it('round-trips through parse', () => {
    const organization: WorkspaceContext = {
      kind: 'organization',
      organizationId: ORG_ID,
    };
    expect(parseWorkspaceContext('personal')).toEqual(
      PERSONAL_WORKSPACE_CONTEXT,
    );
    expect(
      parseWorkspaceContext(serializeWorkspaceContext(organization)),
    ).toEqual(organization);
  });

  it('normalizes organization ids to lower case on parse', () => {
    expect(parseWorkspaceContext(`org:${ORG_ID.toUpperCase()}`)).toEqual({
      kind: 'organization',
      organizationId: ORG_ID,
    });
  });

  it('rejects malformed serialized contexts', () => {
    expect(parseWorkspaceContext('')).toBeNull();
    expect(parseWorkspaceContext('Personal')).toBeNull();
    expect(parseWorkspaceContext('org:')).toBeNull();
    expect(parseWorkspaceContext('org:not-a-uuid')).toBeNull();
    expect(parseWorkspaceContext(`organization:${ORG_ID}`)).toBeNull();
    expect(parseWorkspaceContext(`org:${ORG_ID}/extra`)).toBeNull();
  });

  it('compares contexts by kind and organization id only', () => {
    expect(
      isSameWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT, { kind: 'personal' }),
    ).toBe(true);
    expect(
      isSameWorkspaceContext(
        { kind: 'organization', organizationId: ORG_ID },
        { kind: 'organization', organizationId: ORG_ID },
      ),
    ).toBe(true);
    expect(
      isSameWorkspaceContext(
        { kind: 'organization', organizationId: ORG_ID },
        { kind: 'organization', organizationId: ORG_ID.toUpperCase() },
      ),
    ).toBe(true);
    expect(
      isSameWorkspaceContext(PERSONAL_WORKSPACE_CONTEXT, {
        kind: 'organization',
        organizationId: ORG_ID,
      }),
    ).toBe(false);
    expect(
      isSameWorkspaceContext(
        { kind: 'organization', organizationId: ORG_ID },
        {
          kind: 'organization',
          organizationId: '00000000-0000-4000-8000-000000000000',
        },
      ),
    ).toBe(false);
  });

  it('guards wire payloads for contexts and context state', () => {
    expect(isWorkspaceContext({ kind: 'personal' })).toBe(true);
    expect(
      isWorkspaceContext({ kind: 'organization', organizationId: ORG_ID }),
    ).toBe(true);
    expect(isWorkspaceContext({ kind: 'organization' })).toBe(false);
    expect(
      isWorkspaceContext({ kind: 'organization', organizationId: 'nope' }),
    ).toBe(false);
    // The guard never normalizes, so a non-canonical id must be rejected
    // rather than let through to persistence and cache keys.
    expect(
      isWorkspaceContext({
        kind: 'organization',
        organizationId: ORG_ID.toUpperCase(),
      }),
    ).toBe(false);
    expect(
      isWorkspaceContext({
        kind: 'organization',
        organizationId: ` ${ORG_ID}`,
      }),
    ).toBe(false);
    expect(isWorkspaceContext({ kind: 'team', organizationId: ORG_ID })).toBe(
      false,
    );
    expect(isWorkspaceContext(null)).toBe(false);
    expect(isWorkspaceContext('personal')).toBe(false);

    expect(
      isWorkspaceContextState({
        context: { kind: 'personal' },
        revision: 3,
        organizations: [{ id: ORG_ID, name: 'Acme', role: 'MEMBER' }],
      }),
    ).toBe(true);
    expect(
      isWorkspaceContextState({
        context: { kind: 'personal' },
        revision: -1,
        organizations: [],
      }),
    ).toBe(false);
    expect(
      isWorkspaceContextState({
        context: { kind: 'personal' },
        revision: 0,
        organizations: [{ id: ORG_ID, name: 'Acme', role: 'GUEST' }],
      }),
    ).toBe(false);
    expect(
      isWorkspaceContextState({
        context: { kind: 'personal' },
        revision: 0,
      }),
    ).toBe(false);
  });
});

describe('personal organization resource context', () => {
  it('matches the complete owner/context truth table and promotion', async () => {
    const { contextOrganizationId, isOwnerInContext } =
      await import('../index');
    const personal = { kind: 'personal' } as const;
    const mine = { kind: 'organization', organizationId: 'mine' } as const;
    const team = { kind: 'organization', organizationId: 'team' } as const;
    expect(contextOrganizationId(personal, 'mine')).toBe('mine');
    expect(contextOrganizationId(personal, null)).toBeNull();
    expect(contextOrganizationId(team, 'mine')).toBe('team');
    for (const context of [personal, mine, team])
      expect(isOwnerInContext(personal, context, 'mine')).toBe(true);
    expect(isOwnerInContext(mine, personal, 'mine')).toBe(true);
    expect(isOwnerInContext(mine, mine, 'mine')).toBe(false);
    expect(isOwnerInContext(mine, team, 'mine')).toBe(false);
    expect(isOwnerInContext(team, personal, 'mine')).toBe(false);
    expect(isOwnerInContext(team, team, 'mine')).toBe(true);
    expect(isOwnerInContext(mine, personal, null)).toBe(false);
    expect(isOwnerInContext(mine, mine, null)).toBe(true);
    expect(isOwnerInContext(mine, personal, 'replacement')).toBe(false);
    expect(isOwnerInContext(mine, mine, 'replacement')).toBe(true);
  });
});

it('normalizes the optional Personal account identifier and fails closed for old or malformed responses', () => {
  expect(normalizePersonalOrganizationId(ORG_ID.toUpperCase())).toBe(ORG_ID);
  for (const value of [undefined, null, 7, '', 'personal', 'not-a-uuid'])
    expect(normalizePersonalOrganizationId(value)).toBeNull();
});
