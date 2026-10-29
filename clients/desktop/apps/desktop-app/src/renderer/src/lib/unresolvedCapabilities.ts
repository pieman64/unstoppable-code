/**
 * Copy for portable refs a shared workspace template (Blueprint) named but
 * that this device could not resolve to a local capability — an unavailable
 * marketplace, a plugin the account cannot reach, a skill that is not
 * installed here.
 *
 * Unmet requirements warn, they never block: the project still lands with
 * everything that did resolve, and the count tells the user how much of the
 * template is missing without pretending the create failed.
 *
 * Shared by the public-share landing (`usePublicShareLanding`) and the curated
 * Blueprint seed in the create-project modal so both report the same outcome
 * in the same words.
 */
export function formatUnresolvedCapabilitiesNotice(count: number): string {
  return `Added with ${count} item${
    count === 1 ? '' : 's'
  } unavailable on this device.`;
}
