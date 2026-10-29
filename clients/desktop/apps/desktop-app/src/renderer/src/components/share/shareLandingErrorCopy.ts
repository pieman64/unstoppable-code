import { brandText } from '@/lib/brand';

/** Why a shared resource could not be resolved, as one line for the reader. */
export function shareLandingErrorCopy(
  reason:
    | 'not-found'
    | 'cloud-unreachable'
    | 'client-upgrade-required'
    | 'share-changed',
): string {
  if (reason === 'not-found') {
    return 'This share is no longer available. It may have been revoked by its author.';
  }
  if (reason === 'client-upgrade-required') {
    // Never offer a YAML-only fallback here: the share is packaged, and
    // installing the definition alone would be an incomplete install
    // presented as a success.
    return `This shared pipeline includes dependencies that this version of ${brandText.appName} cannot install. Update to the latest version to continue.`;
  }
  if (reason === 'share-changed') {
    return 'This share changed. Return to the share page to review the updated version.';
  }
  return `Couldn't reach ${brandText.serverName}. Check your connection and try again.`;
}
