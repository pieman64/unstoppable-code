/**
 * Recipient-facing copy for every access-block reason the shared-container
 * gate can report. Each pairs a plain description with what the recipient can
 * actually do, because re-checking access is the only control the notice
 * offers.
 */
import type { SharedContainerAccessBlockReason } from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';

export interface SharedContainerBlockReasonCopy {
  title: string;
  detail: string;
}

/**
 * Select the notice copy for a blocked replica.
 *
 * `repository` is the structured canonical GitHub `owner/name` the replica
 * carries for `repository-access-missing`. It is ignored for every other
 * reason, and a blank or absent value (legacy state) gets generic copy. The
 * diagnostic `message` is never an input: names are not parsed from it.
 */
export function sharedContainerBlockReasonCopy(
  reason: SharedContainerAccessBlockReason,
  repository?: string,
): SharedContainerBlockReasonCopy {
  switch (reason) {
    case 'update-required':
      return {
        title: `Update ${brandText.appName} to open this share`,
        detail:
          'This share uses a newer format. Update the app, then re-check access.',
      };
    case 'unsupported-remote-host':
      return {
        title: 'This repository host is not supported',
        detail: `The share points at a git host ${brandText.appName} cannot read. Ask the person who shared it to publish from a supported host.`,
      };
    case 'github-not-connected':
      return {
        title: 'Connect GitHub to view this share',
        detail:
          'Connect your GitHub account in Settings, then re-check access.',
      };
    case 'repository-access-missing':
      return repositoryAccessMissingCopy(repository);
    case 'commit-unavailable':
      return {
        title: 'The shared commit is not available',
        detail:
          'The commit this share is based on could not be fetched. It may have been removed or force-pushed away.',
      };
    case 'lfs-unsupported':
      return {
        title: 'Git LFS content is not supported',
        detail:
          'This share depends on Git LFS objects, which shared containers cannot read yet.',
      };
    case 'symlink-unsupported':
      return {
        title: 'Symbolic links are not supported on this device',
        detail:
          'This share contains symbolic links, which shared containers cannot open on Windows. Ask the person who shared it to publish without symbolic links.',
      };
    case 'git-credentials-missing':
      return {
        title: 'Git credentials are missing',
        detail: `${brandText.appName} could not find credentials for this repository. Sign in to GitHub in Settings, then re-check access.`,
      };
    default:
      return assertNever(reason);
  }
}

/**
 * Sharing a project in the app does not grant GitHub access, so the notice
 * says so, names the repository when known, and points the recipient at the
 * person who shared it rather than a repository owner they may not know.
 */
function repositoryAccessMissingCopy(
  repository: string | undefined,
): SharedContainerBlockReasonCopy {
  const named = repository?.trim();
  const ask =
    'Ask the person who shared this project with you for access to that repository, then re-check access.';
  if (named === undefined || named === '') {
    return {
      title: 'GitHub access to this repository is required',
      detail: `This project was shared with you in ${brandText.appName}, but its files are in a private GitHub repository. ${ask}`,
    };
  }
  return {
    title: `GitHub access to ${named} is required`,
    detail: `This project was shared with you in ${brandText.appName}, but its files are in the private GitHub repository ${named}. ${ask}`,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled shared-container block reason: ${String(value)}`);
}
