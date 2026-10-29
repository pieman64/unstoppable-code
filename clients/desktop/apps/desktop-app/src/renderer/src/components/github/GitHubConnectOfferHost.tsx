import type { JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import { AuthLoginModal } from '@/components/settings/AuthLoginModal';
import {
  abandonGitHubConnectOffer,
  settleGitHubConnectOffer,
} from '@/lib/githubConnectOffer';
import {
  useGitHubConnectOfferStore,
  type GitHubConnectOfferKind,
} from '@/stores/githubConnectOfferStore';

const OFFER_INTRO: Record<GitHubConnectOfferKind, string> = {
  push: 'Connect GitHub to continue pushing this branch.',
  pr: 'Connect GitHub to continue opening this pull request.',
  'org-project-setup': 'Connect GitHub to continue setting up this project.',
  'home-link-add-project': 'Connect GitHub to continue adding this project.',
};

/**
 * The one app-level GitHub sign-in offered when a push, pull request or
 * project add first needs GitHub (CAN-4006, CAN-4466). Closing it settles
 * credentials and continues the interrupted action once.
 */
export function GitHubConnectOfferHost(): JSX.Element | null {
  const { githubConnection } = useCapabilities();
  const offer = useGitHubConnectOfferStore((state) => state.offer);
  if (githubConnection !== true || offer?.phase !== 'offered') return null;
  const { kind } = offer.continuation;
  return (
    <AuthLoginModal
      key={offer.continuation.operationId}
      provider="github"
      intro={OFFER_INTRO[kind]}
      introTestId={`github-connect-offer-${kind}`}
      onCancel={(): void => {
        useGitHubConnectOfferStore
          .getState()
          .clearOffer(offer.continuation.operationId);
        abandonGitHubConnectOffer(offer.continuation);
      }}
      onClose={(): void => {
        void settleGitHubConnectOffer();
      }}
    />
  );
}
