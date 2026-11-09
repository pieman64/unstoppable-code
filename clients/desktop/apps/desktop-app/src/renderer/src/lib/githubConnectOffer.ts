import { settleGitHubLogin } from '@/lib/githubConnection';
import { getOrgProjectAddStore } from '@/lib/orgProjectCatalogAdd';
import { startOrgProjectSetupWithGitHubOffer } from '@/lib/orgProjectConnectOffer';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import {
  isGitHubActionContinuation,
  useGitHubConnectOfferStore,
  type GitHubActionContinuation,
  type GitHubConnectContinuation,
  type HomeLinkAddProjectContinuation,
  type OrgProjectSetupContinuation,
} from '@/stores/githubConnectOfferStore';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';

/** Wait only for the operation that offered login, or stop waiting on cancel. */
function waitForOriginalGitHubAction(
  continuation: GitHubActionContinuation,
): Promise<void> {
  const { operationId, projectId, worktreeId } = continuation;
  const key = worktreeKey(projectId, worktreeId);
  return new Promise((resolve) => {
    const released = (): boolean =>
      useGitHubStore.getState().gitActionOperationIds[key] !== operationId ||
      useGitHubConnectOfferStore.getState().offer?.continuation.operationId !==
        operationId;
    if (released()) {
      resolve();
      return;
    }
    const release = (): void => {
      if (!released()) return;
      unsubscribeAction();
      unsubscribeOffer();
      resolve();
    };
    const unsubscribeAction = useGitHubStore.subscribe(release);
    const unsubscribeOffer = useGitHubConnectOfferStore.subscribe(release);
    release();
  });
}

/** A push or PR toast belongs to its worktree; a project add has none yet. */
function offerToastMeta(continuation: GitHubConnectContinuation): {
  category: 'GitHub';
  projectId?: string;
  worktreeId?: string;
} {
  if (!isGitHubActionContinuation(continuation)) return { category: 'GitHub' };
  const { projectId, worktreeId } = continuation;
  return { category: 'GitHub', projectId, worktreeId };
}

/**
 * Runs when the connect offer's sign-in closes, however it closed. Settles
 * credentials once; when GitHub is now connected, claims and clears the offer
 * before running its one continuation, so a repeated close, connection event
 * or click never retries twice.
 */
export async function settleGitHubConnectOffer(): Promise<void> {
  const offers = useGitHubConnectOfferStore.getState();
  const offer = offers.offer;
  if (!offer) return;
  const { operationId } = offer.continuation;
  if (!offers.beginSettle(operationId)) return;

  let connection: Awaited<ReturnType<typeof settleGitHubLogin>> = 'unknown';
  try {
    connection = await settleGitHubLogin();
  } catch {
    // settleGitHubLogin does not reject; stay on the unknown path if it does.
  }
  if (
    connection === 'connected' &&
    isGitHubActionContinuation(offer.continuation)
  ) {
    await waitForOriginalGitHubAction(offer.continuation);
  }
  const continuation =
    connection === 'connected'
      ? useGitHubConnectOfferStore.getState().claimRetry(operationId)
      : null;
  useGitHubConnectOfferStore.getState().clearOffer(operationId);

  if (!continuation) {
    if (connection === 'connected') return;
    const offered = offer.continuation;
    useGitHubStore
      .getState()
      .addToast(
        connection === 'disconnected'
          ? 'GitHub is not connected. Connect and try again.'
          : 'Couldn’t confirm the GitHub connection. Try again.',
        'info',
        undefined,
        offerToastMeta(offered),
      );
    abandonGitHubConnectOffer(offered);
    return;
  }
  try {
    await continueAfterGitHubConnect(continuation);
  } catch (error: unknown) {
    reportRendererConsoleError('GitHub connect continuation failed', {
      kind: continuation.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Runs the one continuation of an offer whose sign-in connected GitHub. */
async function continueAfterGitHubConnect(
  continuation: GitHubConnectContinuation,
): Promise<void> {
  switch (continuation.kind) {
    case 'push':
    case 'pr':
      await useGitHubStore.getState().continueAfterGitHubConnect(continuation);
      return;
    case 'org-project-setup':
      await continueOrgProjectSetup(continuation);
      return;
    case 'home-link-add-project':
      await continueHomeLinkAddProject(continuation);
      return;
    default: {
      const unreachable: never = continuation;
      return unreachable;
    }
  }
}

/**
 * Restarts the setup with the destination the member already consented to,
 * only under the account it was offered for and while its row remains.
 */
async function continueOrgProjectSetup(
  continuation: OrgProjectSetupContinuation,
): Promise<void> {
  const store = getOrgProjectAddStore();
  if (!store) return;
  const state = store.getState();
  if (
    state.accountEpoch !== continuation.accountEpoch ||
    !state.setupProgress[continuation.projectId]
  )
    return;
  await startOrgProjectSetupWithGitHubOffer(
    store,
    continuation.projectId,
    continuation.destinationRoot,
    { continuation: true },
  );
}

/** How long a resend waits for the link check that connecting started. */
const HOME_LINK_RESOLVE_WAIT_MS = 10_000;

/**
 * Re-resolves the link, or resends the composer once while it still holds
 * the submitted chat draft for the same link; otherwise the original failure
 * comes back. Connecting re-checks the link, and the send gate stops a link
 * that is still being checked, so the resend waits for that check first.
 */
async function continueHomeLinkAddProject(
  continuation: HomeLinkAddProjectContinuation,
): Promise<void> {
  if (continuation.resume === 'resolve') {
    useHomeComposerStore.getState().retryLinkTarget();
    return;
  }
  await homeLinkCheckSettled(continuation.linkKey);
  const composer = useHomeComposerStore.getState();
  const { linkTarget } = composer;
  if (
    linkTarget.status === 'ready' &&
    linkTarget.key === continuation.linkKey &&
    composer.mode === 'chat' &&
    composer.text === continuation.draftText &&
    !composer.isSending
  ) {
    composer.requestGitHubConnectResume();
    return;
  }
  abandonGitHubConnectOffer(continuation);
}

function homeLinkKey(): string | undefined {
  const { linkTarget } = useHomeComposerStore.getState();
  return linkTarget.status === 'idle' ? undefined : linkTarget.key;
}

/** Resolves once the composer stops checking `linkKey`, or after the wait. */
function homeLinkCheckSettled(linkKey: string | undefined): Promise<void> {
  const checking = (): boolean => {
    const { linkTarget } = useHomeComposerStore.getState();
    return linkTarget.status === 'resolving' && linkTarget.key === linkKey;
  };
  if (!checking()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(finish, HOME_LINK_RESOLVE_WAIT_MS);
    const unsubscribe = useHomeComposerStore.subscribe((): void => {
      if (!checking()) finish();
    });
  });
}

/**
 * Runs when an offer ends without a continuation: cancelled, or GitHub is
 * still not connected. Only a Home send has something to restore, its
 * original failure with Try again, while the composer still targets its link.
 */
export function abandonGitHubConnectOffer(
  continuation: GitHubConnectContinuation,
): void {
  switch (continuation.kind) {
    case 'push':
    case 'pr':
    case 'org-project-setup':
      return;
    case 'home-link-add-project':
      if (
        continuation.resume === 'send' &&
        continuation.failureMessage &&
        homeLinkKey() === continuation.linkKey
      ) {
        useHomeComposerStore.setState({
          sendError: { error: continuation.failureMessage },
          sendErrorRetryable: true,
        });
      }
      return;
    default: {
      const unreachable: never = continuation;
      return unreachable;
    }
  }
}
