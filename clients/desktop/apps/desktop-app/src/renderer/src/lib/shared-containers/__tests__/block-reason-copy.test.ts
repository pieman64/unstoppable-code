import type { SharedContainerAccessBlockReason } from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { sharedContainerBlockReasonCopy } from '../block-reason-copy';

const NAMED_REPOSITORY = 'acme/tower-defense';

describe('sharedContainerBlockReasonCopy', () => {
  describe('repository-access-missing', () => {
    it('names the canonical repository and directs the recipient to the sharer', () => {
      expect(
        sharedContainerBlockReasonCopy(
          'repository-access-missing',
          NAMED_REPOSITORY,
        ),
      ).toEqual({
        title: 'GitHub access to acme/tower-defense is required',
        detail: `This project was shared with you in ${brandText.appName}, but its files are in the private GitHub repository acme/tower-defense. Ask the person who shared this project with you for access to that repository, then re-check access.`,
      });
    });

    it('falls back to generic copy when a legacy state has no repository', () => {
      expect(
        sharedContainerBlockReasonCopy('repository-access-missing'),
      ).toEqual({
        title: 'GitHub access to this repository is required',
        detail: `This project was shared with you in ${brandText.appName}, but its files are in a private GitHub repository. Ask the person who shared this project with you for access to that repository, then re-check access.`,
      });
    });

    it.each(['', '   ', '\n\t'])(
      'falls back to generic copy for a blank repository %j',
      (repository) => {
        expect(
          sharedContainerBlockReasonCopy(
            'repository-access-missing',
            repository,
          ),
        ).toEqual(sharedContainerBlockReasonCopy('repository-access-missing'));
      },
    );

    it('uses the brand helper for the app name', () => {
      const { detail } = sharedContainerBlockReasonCopy(
        'repository-access-missing',
        NAMED_REPOSITORY,
      );
      expect(detail).toContain(`shared with you in ${brandText.appName},`);
    });
  });

  describe('other reasons', () => {
    const UNCHANGED: Record<
      Exclude<SharedContainerAccessBlockReason, 'repository-access-missing'>,
      { title: string; detail: string }
    > = {
      'update-required': {
        title: `Update ${brandText.appName} to open this share`,
        detail:
          'This share uses a newer format. Update the app, then re-check access.',
      },
      'unsupported-remote-host': {
        title: 'This repository host is not supported',
        detail: `The share points at a git host ${brandText.appName} cannot read. Ask the person who shared it to publish from a supported host.`,
      },
      'github-not-connected': {
        title: 'Connect GitHub to view this share',
        detail:
          'Connect your GitHub account in Settings, then re-check access.',
      },
      'commit-unavailable': {
        title: 'The shared commit is not available',
        detail:
          'The commit this share is based on could not be fetched. It may have been removed or force-pushed away.',
      },
      'lfs-unsupported': {
        title: 'Git LFS content is not supported',
        detail:
          'This share depends on Git LFS objects, which shared containers cannot read yet.',
      },
      'symlink-unsupported': {
        title: 'Symbolic links are not supported on this device',
        detail:
          'This share contains symbolic links, which shared containers cannot open on Windows. Ask the person who shared it to publish without symbolic links.',
      },
      'git-credentials-missing': {
        title: 'Git credentials are missing',
        detail: `${brandText.appName} could not find credentials for this repository. Sign in to GitHub in Settings, then re-check access.`,
      },
    };

    it.each(Object.entries(UNCHANGED))(
      'keeps %s copy verbatim and ignores repository context',
      (reason, expected) => {
        const typedReason = Object.keys(UNCHANGED).find(
          (candidate): candidate is keyof typeof UNCHANGED =>
            candidate === reason,
        );
        expect(typedReason).toBeDefined();
        if (typedReason === undefined) return;
        expect(sharedContainerBlockReasonCopy(typedReason)).toEqual(expected);
        expect(
          sharedContainerBlockReasonCopy(typedReason, NAMED_REPOSITORY),
        ).toEqual(expected);
      },
    );
  });
});
