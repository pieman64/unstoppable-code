import {
  sharedByYouAudienceCount,
  sharedByYouAudiences,
  type SharedByYouFacts,
  type SharedByYouPorts,
} from '../sharedByYouAudiences';

const teamOwner = {
  type: 'team',
  id: 'team-1',
  name: 'Growth',
  organization: { id: 'org-1', name: 'Acme' },
} as const;

const organizationOwner = {
  type: 'organization',
  id: 'org-1',
  name: 'Acme',
} as const;

const personalOwner = {
  type: 'organization',
  id: 'org-personal',
  name: 'Aaron’s organization',
} as const;

const userOwner = { type: 'user', id: 'user-1', name: 'Aaron' } as const;

const deleteShare = async (): Promise<void> => {};
const revokePublicLink = async (): Promise<void> => {};
const ports: SharedByYouPorts = {
  deleteShare: { available: true, run: deleteShare },
  revokePublicLink: { available: false, reason: 'Not here.' },
};

const link = {
  externalId: 'pub-1',
  upToDate: true,
  createdAt: '2026-10-14T12:00:00Z',
};

const fixtures: Record<string, SharedByYouFacts> = {
  orgNoLink: {
    canDelete: true,
    shareScope: 'organization',
    owner: organizationOwner,
    createdAt: '2026-10-12T12:00:00Z',
    publicShare: null,
  },
  teamWithLink: {
    canDelete: true,
    shareScope: 'team',
    owner: teamOwner,
    createdAt: '2026-10-12T12:00:00Z',
    publicShare: link,
  },
  privateWithLink: {
    canDelete: true,
    shareScope: 'private',
    owner: userOwner,
    publicShare: link,
  },
  unscopedWithStaleLink: {
    canDelete: true,
    owner: userOwner,
    publicShare: { ...link, upToDate: false },
  },
  privateNoLink: { canDelete: true, shareScope: 'private', owner: userOwner },
  personalOrg: {
    canDelete: true,
    shareScope: 'organization',
    owner: personalOwner,
  },
  foreign: {
    canDelete: false,
    shareScope: 'organization',
    owner: organizationOwner,
    publicShare: link,
  },
  canDeleteUnknown: {
    shareScope: 'organization',
    owner: organizationOwner,
  },
};

describe('sharedByYouAudiences', () => {
  it('lists one account row for a team or organization share with no link', () => {
    expect(sharedByYouAudiences(fixtures.orgNoLink, null, ports)).toEqual([
      {
        id: 'account',
        audience: 'organization',
        name: 'Acme',
        sinceIso: '2026-10-12T12:00:00Z',
        action: ports.deleteShare,
        alsoRevokesPublicLink: false,
      },
    ]);
  });

  it('lists the account row, then the public link, for a scoped share with a link', () => {
    expect(sharedByYouAudiences(fixtures.teamWithLink, null, ports)).toEqual([
      {
        id: 'account',
        audience: 'team',
        name: 'Growth',
        sinceIso: '2026-10-12T12:00:00Z',
        action: ports.deleteShare,
        alsoRevokesPublicLink: true,
      },
      {
        id: 'public',
        audience: 'public',
        name: 'Public link',
        linkId: 'pub-1',
        sinceIso: '2026-10-14T12:00:00Z',
        action: ports.revokePublicLink,
        remainingAudience: { name: 'Growth' },
      },
    ]);
  });

  it('lists only the public link for a private share with a link', () => {
    expect(sharedByYouAudiences(fixtures.privateWithLink, null, ports)).toEqual(
      [
        {
          id: 'public',
          audience: 'public',
          name: 'Public link',
          linkId: 'pub-1',
          sinceIso: '2026-10-14T12:00:00Z',
          action: ports.revokePublicLink,
        },
      ],
    );
  });

  it('treats a missing scope as private and a stale link as a link', () => {
    const rows = sharedByYouAudiences(
      fixtures.unscopedWithStaleLink,
      null,
      ports,
    );
    expect(rows.map((row) => row.id)).toEqual(['public']);
  });

  it('lists nothing for a private share with no link', () => {
    expect(sharedByYouAudiences(fixtures.privateNoLink, null, ports)).toEqual(
      [],
    );
  });

  it('preserves the Personal organization’s raw name and marks it personal', () => {
    expect(
      sharedByYouAudiences(fixtures.personalOrg, 'org-personal', ports),
    ).toEqual([
      expect.objectContaining({
        id: 'account',
        audience: 'organization',
        name: 'Aaron’s organization',
        personal: true,
      }),
    ]);
  });

  it('carries the account row’s name and Personal flag onto the public row', () => {
    const rows = sharedByYouAudiences(
      { ...fixtures.personalOrg, publicShare: link },
      'org-personal',
      ports,
    );
    expect(rows.find((row) => row.id === 'public')).toMatchObject({
      remainingAudience: { name: 'Aaron’s organization', personal: true },
    });
  });

  it.each([
    ['team', 'Shared team'],
    ['organization', 'Shared organization'],
  ] as const)(
    'keeps the %s fallback as the remaining audience',
    (shareScope, name) => {
      const rows = sharedByYouAudiences(
        { canDelete: true, shareScope, publicShare: link },
        null,
        ports,
      );
      expect(rows.find((row) => row.id === 'public')).toMatchObject({
        remainingAudience: { name },
      });
    },
  );

  it('carries the resolved organization name onto the public row', () => {
    const rows = sharedByYouAudiences(
      { ...fixtures.orgNoLink, publicShare: link },
      null,
      ports,
    );
    expect(rows.find((row) => row.id === 'public')).toMatchObject({
      remainingAudience: { name: 'Acme' },
    });
  });

  it('omits since when the share has no creation time', () => {
    const [row] = sharedByYouAudiences(fixtures.personalOrg, null, ports);
    expect(row).not.toHaveProperty('sinceIso');
    expect(row).not.toHaveProperty('personal');
  });

  it('lists nothing unless the viewer can delete the share', () => {
    expect(sharedByYouAudiences(fixtures.foreign, null, ports)).toEqual([]);
    expect(
      sharedByYouAudiences(fixtures.canDeleteUnknown, null, ports),
    ).toEqual([]);
  });

  it('counts the same rows without ports', () => {
    for (const facts of Object.values(fixtures)) {
      expect(sharedByYouAudienceCount(facts, 'org-personal')).toBe(
        sharedByYouAudiences(facts, 'org-personal', ports).length,
      );
    }
  });

  it('wires each row to its own port', () => {
    const available: SharedByYouPorts = {
      deleteShare: { available: true, run: deleteShare },
      revokePublicLink: { available: true, run: revokePublicLink },
    };
    const [account, publicRow] = sharedByYouAudiences(
      fixtures.teamWithLink,
      null,
      available,
    );
    expect(account?.action).toBe(available.deleteShare);
    expect(publicRow?.action).toBe(available.revokePublicLink);
  });
});
