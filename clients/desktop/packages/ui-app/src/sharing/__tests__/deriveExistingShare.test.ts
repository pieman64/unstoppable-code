import {
  deriveExistingShare,
  existingShareAudienceLabel,
  publicAudienceLocked,
  shareOwnerFields,
} from '../deriveExistingShare';

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

const userOwner = { type: 'user', id: 'user-1', name: 'Aaron' } as const;

describe('deriveExistingShare', () => {
  it('reads a private share with no public link as a first share', () => {
    expect(
      deriveExistingShare({ shareScope: 'private', owner: userOwner }),
    ).toBeUndefined();
    expect(deriveExistingShare({ shareScope: undefined })).toBeUndefined();
  });

  it('reads a team share with its team as the target', () => {
    expect(
      deriveExistingShare({ shareScope: 'team', owner: teamOwner }),
    ).toEqual({
      audience: 'team',
      target: {
        id: 'team-1',
        name: 'Growth',
        organizationId: 'org-1',
        secondaryLabel: 'Acme',
      },
      targetAudience: 'team',
    });
  });

  it('reads an organization share with its organization as the target', () => {
    expect(
      deriveExistingShare({
        shareScope: 'organization',
        owner: organizationOwner,
      }),
    ).toEqual({
      audience: 'organization',
      target: { id: 'org-1', name: 'Acme' },
      targetAudience: 'organization',
    });
  });

  it('reads a personal share with a public link as Public with no target', () => {
    expect(
      deriveExistingShare({
        shareScope: 'private',
        owner: userOwner,
        publicShare: { upToDate: true },
        link: { url: 'https://cloud.test/share/skills/abc', kind: 'public' },
      }),
    ).toEqual({
      audience: 'public',
      link: { url: 'https://cloud.test/share/skills/abc', kind: 'public' },
    });
  });

  it('reads a team share that also has a public link as Public and keeps the team', () => {
    // The legacy dual state: Remove public link must stay reachable, and the
    // team is still the owner an Update has to preserve.
    expect(
      deriveExistingShare({
        shareScope: 'team',
        owner: teamOwner,
        publicShare: { upToDate: true },
      }),
    ).toEqual({
      audience: 'public',
      target: {
        id: 'team-1',
        name: 'Growth',
        organizationId: 'org-1',
        secondaryLabel: 'Acme',
      },
      targetAudience: 'team',
    });
  });

  it('flags a public link that no longer matches the cloud copy', () => {
    expect(
      deriveExistingShare({
        shareScope: 'private',
        publicShare: { upToDate: false },
      }),
    ).toEqual({ audience: 'public', publicLinkStale: true });
  });

  it('names an owner whose display name the server withheld', () => {
    expect(
      deriveExistingShare({
        shareScope: 'team',
        owner: { type: 'team', id: 'team-1', name: null, organization: null },
      })?.target,
    ).toEqual({ id: 'team-1', name: 'Shared team' });
    expect(
      deriveExistingShare({
        shareScope: 'organization',
        owner: { type: 'organization', id: 'org-1', name: null },
      })?.target,
    ).toEqual({ id: 'org-1', name: 'Shared organization' });
  });

  it('never treats a user or system owner as a share target', () => {
    expect(
      deriveExistingShare({
        shareScope: 'team',
        owner: { type: 'system' },
      }),
    ).toEqual({ audience: 'team' });
  });
});

describe('shareOwnerFields', () => {
  it('sends the picked team or organization', () => {
    expect(shareOwnerFields({ scope: 'team', teamId: 'team-2' })).toEqual({
      shareScope: 'team',
      teamId: 'team-2',
    });
    expect(
      shareOwnerFields({ scope: 'organization', organizationId: 'org-2' }),
    ).toEqual({ shareScope: 'organization', organizationId: 'org-2' });
  });

  it('stores a new public share as a personal copy', () => {
    expect(shareOwnerFields({ scope: 'public' })).toEqual({
      shareScope: 'private',
    });
  });

  it('normalizes an explicit Public update of a legacy team share', () => {
    expect(
      shareOwnerFields(
        { scope: 'public' },
        {
          shareScope: 'team',
          owner: teamOwner,
          publicShare: { upToDate: true },
        },
      ),
    ).toEqual({ shareScope: 'private' });
  });

  it('normalizes an explicit Public update of a legacy organization share', () => {
    expect(
      shareOwnerFields(
        { scope: 'public' },
        {
          shareScope: 'organization',
          owner: organizationOwner,
          publicShare: { upToDate: false },
        },
      ),
    ).toEqual({ shareScope: 'private' });
  });

  it('moves a team share to a personal copy when the author switches it to Public', () => {
    // No public link yet: Public is an explicit audience change, not an
    // update of the legacy dual state.
    expect(
      shareOwnerFields(
        { scope: 'public' },
        { shareScope: 'team', owner: teamOwner, publicShare: null },
      ),
    ).toEqual({ shareScope: 'private' });
  });

  it('follows the stored scope, not the owner name, when they disagree', () => {
    // A personal copy is stored `private` whatever owner the row reports.
    expect(
      shareOwnerFields(
        { scope: 'public' },
        {
          shareScope: 'private',
          owner: organizationOwner,
          publicShare: { upToDate: true },
        },
      ),
    ).toEqual({ shareScope: 'private' });
  });

  it('lets an explicit team pick replace the existing owner', () => {
    expect(
      shareOwnerFields(
        { scope: 'team', teamId: 'team-2' },
        {
          shareScope: 'team',
          owner: teamOwner,
          publicShare: { upToDate: true },
        },
      ),
    ).toEqual({ shareScope: 'team', teamId: 'team-2' });
  });
});

describe('existingShareAudienceLabel', () => {
  it('names the audience a list row shows after the resource name', () => {
    expect(
      existingShareAudienceLabel({ shareScope: 'team', owner: teamOwner }),
    ).toEqual({ audience: 'team', teamName: 'Growth' });
    expect(
      existingShareAudienceLabel({
        shareScope: 'organization',
        owner: organizationOwner,
      }),
    ).toEqual({ audience: 'organization' });
    expect(
      existingShareAudienceLabel({
        shareScope: 'private',
        publicShare: { upToDate: true },
      }),
    ).toEqual({ audience: 'public' });
  });

  it('has no label for a resource that is not shared', () => {
    expect(existingShareAudienceLabel({ shareScope: 'private' })).toBeNull();
  });
});

describe('current Personal owner projection', () => {
  const facts = {
    shareScope: 'organization',
    owner: organizationOwner,
  } as const;
  it('keeps wire ownership while naming the current personal target', () => {
    expect(deriveExistingShare(facts, 'org-1')?.target).toEqual({
      id: 'org-1',
      name: 'Personal',
    });
    expect(existingShareAudienceLabel(facts, 'org-1')).toEqual({
      audience: 'organization',
      personal: true,
    });
    expect(existingShareAudienceLabel(facts, null)).toEqual({
      audience: 'organization',
    });
    expect(existingShareAudienceLabel(facts, 'replacement')).toEqual({
      audience: 'organization',
    });
  });
});

describe('publicAudienceLocked', () => {
  const organizationTarget = { id: 'org-1', name: 'Acme' };
  const teamTarget = {
    id: 'team-1',
    name: 'Growth',
    organizationId: 'org-1',
  };

  it('locks Public for organization ownership outside the Personal organization', () => {
    expect(
      publicAudienceLocked(
        deriveExistingShare({
          shareScope: 'organization',
          owner: organizationOwner,
        }),
        'personal-org',
      ),
    ).toBe(true);
  });

  it('locks Public for team ownership outside the Personal organization', () => {
    expect(
      publicAudienceLocked(
        deriveExistingShare({ shareScope: 'team', owner: teamOwner }),
        'personal-org',
      ),
    ).toBe(true);
  });

  it('keeps Public for Personal-organization ownership and its teams', () => {
    expect(
      publicAudienceLocked(
        deriveExistingShare(
          { shareScope: 'organization', owner: organizationOwner },
          'org-1',
        ),
        'org-1',
      ),
    ).toBe(false);
    expect(
      publicAudienceLocked(
        deriveExistingShare({ shareScope: 'team', owner: teamOwner }),
        'org-1',
      ),
    ).toBe(false);
  });

  it('locks a team with no parent organization, even when its id matches the Personal organization', () => {
    expect(
      publicAudienceLocked(
        {
          audience: 'team',
          target: { id: 'personal-org', name: 'Team' },
          targetAudience: 'team',
        },
        'personal-org',
      ),
    ).toBe(true);
  });

  it('cannot establish the Personal exception without a Personal organization id', () => {
    expect(
      publicAudienceLocked(
        {
          audience: 'organization',
          target: organizationTarget,
          targetAudience: 'organization',
        },
        null,
      ),
    ).toBe(true);
  });

  it('follows ownership for a legacy public link on a scoped owner', () => {
    const legacy = deriveExistingShare({
      shareScope: 'organization',
      owner: organizationOwner,
      publicShare: { upToDate: false },
    });
    expect(legacy?.audience).toBe('public');
    expect(publicAudienceLocked(legacy, 'personal-org')).toBe(true);
    expect(publicAudienceLocked(legacy, 'org-1')).toBe(false);
  });

  it('reads ownership from the audience when targetAudience is missing', () => {
    expect(
      publicAudienceLocked(
        { audience: 'organization', target: organizationTarget },
        'org-1',
      ),
    ).toBe(false);
    expect(
      publicAudienceLocked({ audience: 'team', target: teamTarget }, 'org-1'),
    ).toBe(false);
    expect(
      publicAudienceLocked({ audience: 'team', target: teamTarget }, 'other'),
    ).toBe(true);
  });

  it("uses a legacy public target's known team parent without targetAudience", () => {
    expect(
      publicAudienceLocked({ audience: 'public', target: teamTarget }, 'org-1'),
    ).toBe(false);
    expect(
      publicAudienceLocked({ audience: 'public', target: teamTarget }, 'other'),
    ).toBe(true);
  });

  it('keeps the restriction when a public share cannot say what owns its target', () => {
    expect(
      publicAudienceLocked(
        { audience: 'public', target: organizationTarget },
        'org-1',
      ),
    ).toBe(true);
  });

  it('leaves personal, never-shared, and owner-less shares unlocked', () => {
    expect(
      publicAudienceLocked(
        deriveExistingShare({
          shareScope: 'private',
          owner: userOwner,
          publicShare: { upToDate: true },
        }),
        'personal-org',
      ),
    ).toBe(false);
    expect(publicAudienceLocked(undefined, 'personal-org')).toBe(false);
    expect(
      publicAudienceLocked({ audience: 'organization' }, 'personal-org'),
    ).toBe(false);
  });
});
