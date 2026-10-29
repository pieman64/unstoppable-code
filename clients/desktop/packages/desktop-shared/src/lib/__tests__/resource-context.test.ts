import { classifyResourceOwner } from '../resource-context';

describe('classifyResourceOwner', (): void => {
  it.each([true, false])(
    'classifies complete wire owners (strict=%s)',
    (strict): void => {
      expect(classifyResourceOwner({ type: 'system' }, { strict })).toBe(
        'global',
      );
      expect(
        classifyResourceOwner(
          { type: 'user', id: 'u', name: null },
          { strict },
        ),
      ).toBe('personal');
      expect(
        classifyResourceOwner(
          {
            type: 'team',
            id: 't',
            name: null,
            organization: { id: 'org-a', name: null },
          },
          { strict },
        ),
      ).toEqual({ organizationId: 'org-a' });
      expect(
        classifyResourceOwner(
          { type: 'organization', id: 'org-b', name: null },
          { strict },
        ),
      ).toEqual({ organizationId: 'org-b' });
    },
  );
  it.each([
    undefined,
    null,
    {},
    [],
    'personal',
    { type: 'future' },
    { type: 'team', id: 't', name: 'Team' },
    { type: 'team', id: 't', name: 'Team', organization: { id: 'o' } },
    { type: 'organization', name: 'Organization' },
    { type: 'organization', id: 'o' },
    { type: 'user', id: '' },
    { type: 'team', shareScope: 'private' },
  ])('fails closed for incomplete provenance: %j', (owner): void => {
    expect(classifyResourceOwner(owner, { strict: true })).toBe('unknown');
  });
  it.each([
    { type: 'user', id: 'u' },
    { ownerType: 'USER', ownerUserId: 7 },
    { shareScope: 'private' },
  ])('recognizes explicit legacy private ownership: %j', (owner): void => {
    expect(classifyResourceOwner(owner, { strict: true })).toBe('personal');
  });
  it('keeps legacy unscoped inventory lenient', (): void => {
    expect(classifyResourceOwner(undefined, { strict: false })).toBe(
      'personal',
    );
    expect(
      classifyResourceOwner(
        { type: 'team', id: 't', name: null },
        { strict: false },
      ),
    ).toBe('personal');
  });
});
