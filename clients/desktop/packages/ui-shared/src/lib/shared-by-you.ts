import { formatMonthDay } from './billing-format';

/**
 * Copy for the "Shared by you" section of a Marketplace detail (CAN-4842):
 * one row per audience you shared the item with, each with its own Unshare.
 */
export const SHARED_BY_YOU_TITLE = 'Shared by you';

/** Name of the public-link audience row. */
export const SHARED_BY_YOU_PUBLIC_LINK_LABEL = 'Public link';

/** When the audience got the item, for example "Since Oct 12". */
export function sharedByYouSinceLabel(iso: string): string {
  return `Since ${formatMonthDay(iso)}`;
}

/** Accessible name of an account audience row's Unshare button. */
export function sharedByYouUnshareAriaLabel(
  name: string,
  audienceName: string,
): string {
  return `Unshare ${name} with ${audienceName}`;
}

/** Accessible name of the public-link row's Unshare button. */
export function sharedByYouRemoveLinkAriaLabel(name: string): string {
  return `Remove the public link for ${name}`;
}

/** Inline error when removing the public link fails; the dialog stays open. */
export const SHARED_BY_YOU_REMOVE_LINK_ERROR =
  'Couldn’t remove the public link. Try again.';

/** Success notice after removing the public link. */
export function publicLinkRemovedNotice(name: string): string {
  return `Removed the public link for “${name}”`;
}

/**
 * Label of the owner's Copy link for an account audience (CAN-5452), on the
 * Shared by you row and in a skill page's ⋯ menu. Copying never changes who
 * can open the item.
 */
export const SHARED_BY_YOU_COPY_LINK_LABEL = 'Copy link';

/** Accessible name of an account audience row's Copy link button. */
export function sharedByYouCopyLinkAriaLabel(
  name: string,
  audienceName: string,
): string {
  return `Copy the ${audienceName} link for ${name}`;
}

/** Warning when the member link could not be written to the clipboard. */
export const SHARED_BY_YOU_COPY_LINK_ERROR =
  'Couldn’t copy the link. Try again.';

/**
 * Success notice after copying an account audience's link. It describes who
 * can open the link now; with a public link still active it says so, rather
 * than implying the item became members-only.
 */
export function sharedByYouLinkCopiedNotice(input: {
  readonly audience: 'team' | 'organization';
  readonly audienceName: string;
  /** The owner's Personal organization; its name is not shown. */
  readonly personal: boolean;
  readonly hasPublicLink: boolean;
}): string {
  const { audience, audienceName, personal, hasPublicLink } = input;
  if (personal) {
    const base = 'Link copied. Existing sharing permissions apply.';
    return hasPublicLink ? `${base} A public link is also active.` : base;
  }
  if (audience === 'team') {
    return hasPublicLink
      ? `Link copied for members of the ${audienceName} team. A public link is also active.`
      : `Link copied. Only members of the ${audienceName} team can open it.`;
  }
  return hasPublicLink
    ? `Link copied for ${audienceName} members. A public link is also active.`
    : `Link copied. Only ${audienceName} members can open it.`;
}

/** The owner's action that publishes a public link, naming its audience. */
export const PUBLISH_PUBLIC_LINK_LABEL =
  'Publish public link (anyone with the link)';

/** The publish action's label while it runs. */
export const PUBLISHING_PUBLIC_LINK_LABEL = 'Publishing…';
