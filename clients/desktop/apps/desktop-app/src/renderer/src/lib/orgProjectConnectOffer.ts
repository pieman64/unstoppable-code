import type { OrgProjectsStoreState } from '@canopy/app-state';
import { useGitHubConnectOfferStore } from '@/stores/githubConnectOfferStore';

// CAN-4466: an org project setup whose clone fails on GitHub credentials
// offers the GitHub sign-in, then continues the same setup once.

/** The org projects store members a watched setup start uses. */
export type OrgProjectSetupStore = {
  getState(): Pick<
    OrgProjectsStoreState,
    'startSetup' | 'setupProgress' | 'accountEpoch'
  >;
  subscribe(listener: () => void): () => void;
};

const GITHUB_NOT_AUTHENTICATED = 'github-not-authenticated';

/**
 * Starts setup and resolves once the start is accepted, as `startSetup`
 * does. Meanwhile it watches this setup's outcome: a clone that failed on
 * GitHub credentials offers the sign-in, unless this start is already that
 * offer's continuation. The watch ends on the outcome, when the project's
 * progress disappears, or when the account changes.
 */
export async function startOrgProjectSetupWithGitHubOffer(
  store: OrgProjectSetupStore,
  projectId: string,
  destinationRoot: string | undefined,
  options?: { continuation?: boolean },
): Promise<void> {
  const initial = store.getState();
  const baseline = initial.setupProgress[projectId]?.updatedAt ?? '';
  const { accountEpoch } = initial;
  let sawProgress = baseline !== '';
  // Subscribe first so a fast outcome is not missed.
  const unsubscribe = store.subscribe((): void => {
    const state = store.getState();
    const progress = state.setupProgress[projectId];
    if (state.accountEpoch !== accountEpoch || (sawProgress && !progress)) {
      unsubscribe();
      return;
    }
    if (!progress) return;
    sawProgress = true;
    if (progress.updatedAt <= baseline) return;
    if (
      progress.state !== 'ready' &&
      progress.state !== 'failed' &&
      progress.state !== 'cancelled'
    )
      return;
    unsubscribe();
    if (
      progress.state !== 'failed' ||
      progress.errorCode !== GITHUB_NOT_AUTHENTICATED ||
      options?.continuation
    )
      return;
    // A busy or coalesced offer leaves the row failed with Retry.
    useGitHubConnectOfferStore.getState().requestOffer({
      kind: 'org-project-setup',
      operationId: crypto.randomUUID(),
      projectId,
      ...(destinationRoot === undefined ? {} : { destinationRoot }),
      accountEpoch,
    });
  });
  try {
    await initial.startSetup(projectId, destinationRoot);
  } catch (error: unknown) {
    unsubscribe();
    throw error;
  }
}
