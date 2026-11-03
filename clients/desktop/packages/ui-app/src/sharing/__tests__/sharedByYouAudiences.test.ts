import {
  sharedByYouAudienceCount,
  sharedByYouAudiences,
  sharedByYouScopedLink,
  type SharedByYouFacts,
  type SharedByYouPorts,
} from '../sharedByYouAudiences';
import { copySharedByYouScopedLink } from '../sharedByYouScopedLink';

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

// CAN-5452: the owner's member link, from the same facts as the account row.
describe('sharedByYouScopedLink', () => {
  const SHARE_ID = '3F2B8C1E-5D4A-4E6F-9A7B-1C2D3E4F5A6B';
  const target = {
    scheme: 'canopy',
    kind: 'skill',
    shareId: SHARE_ID,
  } as const;

  it('builds the organization member link with the lowercased share id', () => {
    expect(sharedByYouScopedLink(fixtures.orgNoLink, null, target)).toEqual({
      url: `canopy://share/skills/${SHARE_ID.toLowerCase()}?audience=ORGANIZATION`,
      audience: 'organization',
      audienceName: 'Acme',
      personal: false,
      hasPublicLink: false,
    });
  });

  it('builds a team link that knows a public link is also active', () => {
    expect(
      sharedByYouScopedLink(fixtures.teamWithLink, null, target),
    ).toMatchObject({
      url: `canopy://share/skills/${SHARE_ID.toLowerCase()}?audience=TEAM`,
      audience: 'team',
      audienceName: 'Growth',
      hasPublicLink: true,
    });
  });

  it.each([
    ['skill', 'skills'],
    ['plugin', 'plugins'],
    ['agent', 'agents'],
    ['collection', 'collections'],
  ] as const)('links a %s with the brand scheme', (kind, segment) => {
    expect(
      sharedByYouScopedLink(fixtures.orgNoLink, null, {
        scheme: 'unstoppable-code',
        kind,
        shareId: SHARE_ID,
      })?.url,
    ).toBe(
      `unstoppable-code://share/${segment}/${SHARE_ID.toLowerCase()}?audience=ORGANIZATION`,
    );
  });

  it('marks a Personal organization share without dropping it', () => {
    expect(
      sharedByYouScopedLink(fixtures.personalOrg, 'org-personal', target),
    ).toMatchObject({ audience: 'organization', personal: true });
  });

  it.each([
    'privateWithLink',
    'privateNoLink',
    'unscopedWithStaleLink',
    'foreign',
    'canDeleteUnknown',
  ])('offers no link for %s', (fixture) => {
    const facts = fixtures[fixture];
    if (!facts) throw new Error(`missing fixture ${fixture}`);
    expect(sharedByYouScopedLink(facts, null, target)).toBeNull();
  });

  it('withholds copying for an invalid brand scheme', () => {
    expect(
      sharedByYouScopedLink(fixtures.orgNoLink, null, {
        ...target,
        scheme: '9invalid',
      }),
    ).toBeNull();
  });

  it('returns null rather than throwing for an id that is not a UUID', () => {
    expect(
      sharedByYouScopedLink(fixtures.orgNoLink, null, {
        ...target,
        shareId: 'skill-1',
      }),
    ).toBeNull();
  });

  it.each([
    undefined,
    null,
    { type: 'organization', name: 'Acme' },
    { type: 'organization', id: '', name: 'Acme' },
    { type: 'organization', id: 'org-1' },
    { type: 'organization', id: 'org-1', name: '  ' },
    { type: 'team', id: 'team-1', name: 'Growth' },
    { type: 'user', id: 'user-1', name: 'Aaron' },
  ] satisfies SharedByYouFacts['owner'][])(
    'withholds both entry points for incomplete or conflicting owner facts: %j',
    (owner) => {
      const facts: SharedByYouFacts = {
        canDelete: true,
        shareScope: 'organization',
        owner,
      };
      expect(sharedByYouScopedLink(facts, null, target)).toBeNull();
      const [row] = sharedByYouAudiences(facts, null, {
        ...ports,
        copyLink: { target, write: jest.fn(), notify: jest.fn() },
      });
      expect(row).not.toHaveProperty('copyLink');
      expect(sharedByYouAudienceCount(facts, null)).toBe(1);
    },
  );

  it('attaches Copy link to the account row only, leaving counts alone', () => {
    const write = jest.fn(() => Promise.resolve(true));
    const notify = jest.fn();
    const audiences = sharedByYouAudiences(fixtures.teamWithLink, null, {
      ...ports,
      copyLink: { target, write, notify },
    });
    expect(audiences.map((audience) => audience.id)).toEqual([
      'account',
      'public',
    ]);
    const [accountRow, publicRow] = audiences;
    if (accountRow?.id !== 'account') throw new Error('account row missing');
    expect(accountRow.copyLink).toEqual({
      link: sharedByYouScopedLink(fixtures.teamWithLink, null, target),
      port: { write, notify },
    });
    expect(publicRow).not.toHaveProperty('copyLink');
    expect(sharedByYouAudienceCount(fixtures.teamWithLink, null)).toBe(2);
  });

  it('leaves the account row without Copy link when the host has no port', () => {
    const [accountRow] = sharedByYouAudiences(fixtures.orgNoLink, null, ports);
    expect(accountRow).not.toHaveProperty('copyLink');
  });
});

describe('copySharedByYouScopedLink', () => {
  const link = {
    url: 'canopy://share/skills/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b?audience=ORGANIZATION',
    audience: 'organization',
    audienceName: 'Acme',
    personal: false,
    hasPublicLink: false,
  } as const;

  it('notifies success once, after the write succeeds', async () => {
    const write = jest.fn(() => Promise.resolve(true));
    const notify = jest.fn();
    await expect(
      copySharedByYouScopedLink(link, { write, notify }),
    ).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith(link.url);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Link copied. Only Acme members can open it.',
      blockMessageFromReplay: true,
    });
  });

  it('warns and resolves false when the write rejects', async () => {
    const write = jest.fn(() => Promise.reject(new Error('denied')));
    const notify = jest.fn();
    await expect(
      copySharedByYouScopedLink(link, { write, notify }),
    ).resolves.toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'warning' }),
    );
  });

  it('posts nothing once the page moved on to another item', async () => {
    const write = jest.fn(() => Promise.resolve(true));
    const notify = jest.fn();
    await copySharedByYouScopedLink(link, { write, notify }, () => false);
    expect(notify).not.toHaveBeenCalled();
  });
});
