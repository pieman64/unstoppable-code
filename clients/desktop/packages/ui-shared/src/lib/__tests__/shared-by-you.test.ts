import {
  SHARED_BY_YOU_PUBLIC_LINK_LABEL,
  SHARED_BY_YOU_REMOVE_LINK_ERROR,
  SHARED_BY_YOU_TITLE,
  publicLinkRemovedNotice,
  sharedByYouCopyLinkAriaLabel,
  sharedByYouLinkCopiedNotice,
  sharedByYouRemoveLinkAriaLabel,
  sharedByYouSinceLabel,
  sharedByYouUnshareAriaLabel,
} from '../shared-by-you';

describe('Shared by you copy', () => {
  it('names the section and the public-link row', () => {
    expect(SHARED_BY_YOU_TITLE).toBe('Shared by you');
    expect(SHARED_BY_YOU_PUBLIC_LINK_LABEL).toBe('Public link');
  });

  it('states when the audience got the item as a month and day', () => {
    expect(sharedByYouSinceLabel('2026-10-12T12:00:00Z')).toMatch(
      /^Since Oct 12$/,
    );
  });

  it('distinguishes the two Unshare buttons by accessible name', () => {
    expect(sharedByYouUnshareAriaLabel('Slack', 'Northwind')).toBe(
      'Unshare Slack with Northwind',
    );
    expect(sharedByYouRemoveLinkAriaLabel('Slack')).toBe(
      'Remove the public link for Slack',
    );
  });

  it('words the public-link error and success notice', () => {
    expect(SHARED_BY_YOU_REMOVE_LINK_ERROR).toBe(
      'Couldn’t remove the public link. Try again.',
    );
    expect(publicLinkRemovedNotice('Slack')).toBe(
      'Removed the public link for “Slack”',
    );
  });
});

// CAN-5452: the notice describes who can open the copied link now, and never
// claims members-only access while a public link is active.
describe('Shared by you Copy link notices', () => {
  it('names which link the row copies', () => {
    expect(sharedByYouCopyLinkAriaLabel('Deploy', 'Acme')).toBe(
      'Copy the Acme link for Deploy',
    );
  });

  it.each([
    ['organization', false, 'Link copied. Only Acme members can open it.'],
    [
      'organization',
      true,
      'Link copied for Acme members. A public link is also active.',
    ],
    ['team', false, 'Link copied. Only members of the Acme team can open it.'],
    [
      'team',
      true,
      'Link copied for members of the Acme team. A public link is also active.',
    ],
  ] as const)(
    'describes a %s audience (public link %s)',
    (audience, hasPublicLink, expected) => {
      expect(
        sharedByYouLinkCopiedNotice({
          audience,
          audienceName: 'Acme',
          personal: false,
          hasPublicLink,
        }),
      ).toBe(expected);
    },
  );

  it('keeps a Personal row neutral without naming the organization', () => {
    const personal = {
      audience: 'organization',
      audienceName: 'Aaron’s organization',
      personal: true,
    } as const;
    expect(
      sharedByYouLinkCopiedNotice({ ...personal, hasPublicLink: false }),
    ).toBe('Link copied. Existing sharing permissions apply.');
    expect(
      sharedByYouLinkCopiedNotice({ ...personal, hasPublicLink: true }),
    ).toBe(
      'Link copied. Existing sharing permissions apply. A public link is also active.',
    );
  });
});
