/**
 * Confirmation copy for removing a share's public link (CAN-5221). Desktop
 * and web render the same confirmation, so the wording lives here once.
 */

/**
 * The account audience that keeps the resource once its public link goes.
 * `name` is the share's resolved display name, the same one its audience row
 * shows. `personal` marks the account's own Personal organization, read from
 * its identity rather than its name.
 */
export type RemovePublicLinkRemainingAudience = {
  readonly name: string;
  readonly personal?: boolean;
};

/**
 * What removing the link does. With no remaining audience the resource
 * becomes private-only and leaves shared lists. A team or organization keeps
 * access through its scoped reads, which also serve links its members already
 * have; nothing is promised about copies already installed. Personal is not a
 * member group, so its body never names one.
 */
export function removePublicLinkMessage(
  remaining?: RemovePublicLinkRemainingAudience,
): string {
  if (remaining === undefined) {
    return "Anyone with the link will lose access, and it won't show up in shared lists anymore. You can share it again later.";
  }
  if (remaining.personal === true) {
    return 'Anyone else with the link will lose access. It stays in your Personal context.';
  }
  const { name } = remaining;
  return `People outside ${name} who have the link will lose access. ${name} members keep access, including through links they already have.`;
}
