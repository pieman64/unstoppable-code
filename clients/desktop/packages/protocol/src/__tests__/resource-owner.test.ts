import {
  isResourceOwner,
  resourceOwnerContext,
  type ResourceOwner,
} from '../resource-owner';

const owners: ResourceOwner[] = [
  { type: 'system' },
  { type: 'user', id: 'user-1', name: null },
  {
    type: 'team',
    id: 'team-1',
    name: 'Same',
    slug: null,
    organization: { id: 'org-1', name: null },
  },
  { type: 'organization', id: 'org-2', name: 'Same', slug: 'org' },
];

describe('ResourceOwner', (): void => {
  it.each(owners)('accepts $type owners', (owner): void => {
    expect(isResourceOwner(owner)).toBe(true);
  });
  it.each([
    undefined,
    null,
    [],
    'user',
    {},
    { type: 'USER', id: 'u', name: null },
    { type: 'private' },
    { type: 'user', id: '', name: null },
    { type: 'user', id: 'u' },
    { type: 'user', id: 'u', name: 1 },
    { type: 'user', id: 'u', name: null, slug: 1 },
    { type: 'organization', id: ' ', name: null },
    { type: 'team', id: 't', name: null },
    { type: 'team', id: 't', name: null, organization: { id: 'o' } },
    { type: 'team', id: 't', name: null, organization: { id: '', name: null } },
    { type: 'team', id: 't', name: null, organization: { id: 'o', name: 42 } },
  ])('rejects malformed wire ownership: %j', (owner): void => {
    expect(isResourceOwner(owner)).toBe(false);
  });
  it('allows richer organization summaries', (): void => {
    expect(
      isResourceOwner({
        type: 'team',
        id: 't',
        name: null,
        organization: {
          id: 'o',
          name: 'Organization',
          createdAt: 'date',
          updatedAt: 'date',
        },
      }),
    ).toBe(true);
  });
  it('maps each variant to its context using IDs', (): void => {
    expect(owners.map(resourceOwnerContext)).toEqual([
      'global',
      'personal',
      { organizationId: 'org-1' },
      { organizationId: 'org-2' },
    ]);
  });
});
