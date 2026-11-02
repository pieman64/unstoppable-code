import {
  SHARED_BY_YOU_PUBLIC_LINK_LABEL,
  SHARED_BY_YOU_REMOVE_LINK_ERROR,
  SHARED_BY_YOU_TITLE,
  publicLinkRemovedNotice,
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
