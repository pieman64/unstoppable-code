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
