import { resolveSelectedDestinationAccess } from '../share-destination-access';

const acme = { id: 'org-1', name: 'Acme' };
const beta = { id: 'org-2', name: 'Beta' };
const platform = { id: 'team-1', name: 'Platform', organizationId: 'org-1' };
const account = {
  organizationAccess: [
    {
      organizationId: 'org-1',
      organizationName: 'Acme Inc',
      teamsEntitled: false,
      canChoosePlan: true,
    },
    { organizationId: 'org-2', teamsEntitled: true },
  ],
};

describe('resolveSelectedDestinationAccess', () => {
  it('resolves a lapsed selected organization with its facts', () => {
    expect(
      resolveSelectedDestinationAccess(account, 'organization', null, acme),
    ).toEqual({
      status: 'lapsed',
      organizationId: 'org-1',
      organizationName: 'Acme Inc',
      canChoosePlan: true,
    });
  });

  it('follows the selected organization among healthy and lapsed memberships', () => {
    expect(
      resolveSelectedDestinationAccess(account, 'organization', null, beta),
    ).toEqual({ status: 'entitled', organizationId: 'org-2' });
  });

  it('governs a team by its own organization', () => {
    expect(
      resolveSelectedDestinationAccess(account, 'team', platform, beta).status,
    ).toBe('lapsed');
  });

  it('treats an organization absent from the facts as unknown', () => {
    expect(
      resolveSelectedDestinationAccess(
        account,
        'team',
        { ...platform, organizationId: 'org-9' },
        null,
      ),
    ).toEqual({ status: 'unknown', organizationId: 'org-9' });
    expect(
      resolveSelectedDestinationAccess(
        account,
        'team',
        { id: 'team-2', name: 'Legacy' },
        null,
      ),
    ).toEqual({ status: 'unknown' });
  });

  it('never gates free access, a legacy host, or a non-scoped audience', () => {
    expect(
      resolveSelectedDestinationAccess(
        { ...account, freeAccess: true },
        'organization',
        null,
        acme,
      ).status,
    ).toBe('entitled');
    expect(
      resolveSelectedDestinationAccess({}, 'organization', null, acme).status,
    ).toBe('unknown');
    expect(
      resolveSelectedDestinationAccess(null, 'organization', null, acme).status,
    ).toBe('unknown');
    expect(
      resolveSelectedDestinationAccess(account, 'public', null, acme).status,
    ).toBe('none');
  });
});
