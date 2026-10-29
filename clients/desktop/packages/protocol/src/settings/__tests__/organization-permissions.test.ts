import {
  TeamServiceError,
  assertNotLastOwner,
  canAssignRole,
  canEditOrg,
  canManageMembers,
  canManageSubTeams,
  canManageProjects,
  canRemoveMember,
  roleRank,
} from '../organization-permissions';

describe('roleRank', () => {
  it('orders OWNER > ADMIN > MEMBER', () => {
    expect(roleRank('OWNER')).toBeGreaterThan(roleRank('ADMIN'));
    expect(roleRank('ADMIN')).toBeGreaterThan(roleRank('MEMBER'));
  });
});

describe('capability gates (ADMIN+)', () => {
  it.each([
    ['OWNER', true],
    ['ADMIN', true],
    ['MEMBER', false],
  ] as const)('canEditOrg(%s) === %s', (role, expected) => {
    expect(canEditOrg(role)).toBe(expected);
    expect(canManageSubTeams(role)).toBe(expected);
    expect(canManageProjects(role)).toBe(expected);
    expect(canManageMembers(role)).toBe(expected);
  });
});

describe('canAssignRole', () => {
  it('lets an OWNER assign any role including transferring OWNER', () => {
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
    expect(canAssignRole('OWNER', 'ADMIN')).toBe(true);
    expect(canAssignRole('OWNER', 'MEMBER')).toBe(true);
  });

  it('forbids ADMIN and MEMBER from assigning any role', () => {
    expect(canAssignRole('ADMIN', 'MEMBER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('MEMBER', 'MEMBER')).toBe(false);
  });
});

describe('canRemoveMember', () => {
  it('lets an OWNER remove ADMINs and MEMBERs but not other OWNERs', () => {
    expect(canRemoveMember('OWNER', 'ADMIN')).toBe(true);
    expect(canRemoveMember('OWNER', 'MEMBER')).toBe(true);
    expect(canRemoveMember('OWNER', 'OWNER')).toBe(false);
  });

  it('lets an ADMIN remove only MEMBERs', () => {
    expect(canRemoveMember('ADMIN', 'MEMBER')).toBe(true);
    expect(canRemoveMember('ADMIN', 'ADMIN')).toBe(false);
    expect(canRemoveMember('ADMIN', 'OWNER')).toBe(false);
  });

  it('never lets a MEMBER remove anyone', () => {
    expect(canRemoveMember('MEMBER', 'MEMBER')).toBe(false);
  });
});

describe('assertNotLastOwner', () => {
  it('throws 409 when the final owner would be lost', () => {
    expect(() =>
      assertNotLastOwner({ targetIsOwner: true, ownerCount: 1 }),
    ).toThrow(TeamServiceError);
    try {
      assertNotLastOwner({ targetIsOwner: true, ownerCount: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(TeamServiceError);
      expect((error as TeamServiceError).status).toBe(409);
    }
  });

  it('allows the operation when another owner remains', () => {
    expect(() =>
      assertNotLastOwner({ targetIsOwner: true, ownerCount: 2 }),
    ).not.toThrow();
  });

  it('allows the operation when the target is not an owner', () => {
    expect(() =>
      assertNotLastOwner({ targetIsOwner: false, ownerCount: 1 }),
    ).not.toThrow();
  });
});
