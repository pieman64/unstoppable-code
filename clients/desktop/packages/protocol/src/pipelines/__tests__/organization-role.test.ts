import {
  CANOPY_ORGANIZATION_ROLES,
  isCanopyOrganizationRole,
  type CanopyOrganizationSummary,
} from '../index';

describe('organization role on CanopyOrganizationSummary', () => {
  it('pins the role vocabulary to the server enum', () => {
    expect(CANOPY_ORGANIZATION_ROLES).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
  });

  it('guards role values without a cast', () => {
    expect(isCanopyOrganizationRole('OWNER')).toBe(true);
    expect(isCanopyOrganizationRole('ADMIN')).toBe(true);
    expect(isCanopyOrganizationRole('MEMBER')).toBe(true);
    expect(isCanopyOrganizationRole('member')).toBe(false);
    expect(isCanopyOrganizationRole('GUEST')).toBe(false);
    expect(isCanopyOrganizationRole(undefined)).toBe(false);
    expect(isCanopyOrganizationRole(null)).toBe(false);
    expect(isCanopyOrganizationRole(1)).toBe(false);
  });

  it('keeps role optional so older servers stay compatible', () => {
    const withoutRole: CanopyOrganizationSummary = {
      id: 'org-1',
      name: 'Acme',
      createdAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-10T00:00:00.000Z',
    };
    const withRole: CanopyOrganizationSummary = {
      ...withoutRole,
      role: 'ADMIN',
    };
    expect(withoutRole.role).toBeUndefined();
    expect(withRole.role).toBe('ADMIN');
  });
});
