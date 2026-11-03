import { type JSX, useCallback, useEffect, useRef, useState } from 'react';
import type { SharedContainerLinkLanding } from '@canopy/protocol/shared-containers';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Button,
  DialogModal,
  LoadingSpinner,
  SHARED_CONTAINER_ACCEPT_CONSENT,
  SHARED_CONTAINER_READ_ONLY_NOTICE,
  SharedContainerAcceptSummary,
} from '@canopy/ui-shared/components';
import { useSharedContainersStore } from '@/stores/sharedContainersStore';
import { openSharedContainerInOwningContext } from '@/lib/openSharedContainerInOwningContext';

/**
 * Landing for a shared container's capability link, opened from the web
 * lander's Open button through the OS deep link.
 *
 * Nothing runs until the user clicks: the link is resolved to a summary, and
 * only Open claims it (turning the link into a grant for this account),
 * records this device's consent, and opens the existing read-only viewer.
 *
 * The token is a capability. It is sent to main for the two link calls and is
 * never logged, reported to App Advisor, or rendered.
 *
 * One primary action and no Cancel (CAN-3710): the close button, Escape and
 * the backdrop dismiss it. Only a dead end, with nothing to do, keeps a
 * footer Close. The body keeps its contents and accept consent, so it stays
 * on `DialogModal` rather than the install review's lighter chrome.
 */

export const LINK_LANDING_FALLBACK_TITLE = 'Shared project';
// Owned by the shared accept summary, which the invitation dialog renders too.
export const LINK_LANDING_READ_ONLY_NOTICE = SHARED_CONTAINER_READ_ONLY_NOTICE;
export const LINK_LANDING_CONSENT = SHARED_CONTAINER_ACCEPT_CONSENT;
export const LINK_LANDING_UNAVAILABLE =
  'This link no longer works. Ask the person who shared it for a new one.';
export const LINK_LANDING_NOT_ELIGIBLE =
  "You don't have access to this link. Ask the person who shared it to invite you.";
export const LINK_LANDING_SIGN_IN = 'Sign in to see what’s shared.';
export const LINK_LANDING_OPEN_FAILED = "Couldn't open this. Try again.";
const OPEN_LABEL = 'Open';
const ACCEPT_AND_OPEN_LABEL = 'Accept and open';
const OPENING_LABEL = 'Opening…';
const SIGN_IN_LABEL = 'Sign in';
const SIGNING_IN_LABEL = 'Signing in…';
const CLOSE_LABEL = 'Close';

const TEST_ID = 'shared-container-link-landing';

type LandingPhase =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'resolved'; landing: SharedContainerLinkLanding };

function plural(count: number, singular: string, many: string): string {
  return `${String(count)} ${count === 1 ? singular : many}`;
}

export interface SharedContainerLinkLandingModalProps {
  token: string;
  onClose: () => void;
}

export function SharedContainerLinkLandingModal({
  token,
  onClose,
}: SharedContainerLinkLandingModalProps): JSX.Element {
  const accountKind = useSharedContainersStore((s) => s.accountKind);
  const accountHydrated = useSharedContainersStore((s) => s.accountHydrated);
  const hydrateAccount = useSharedContainersStore((s) => s.hydrateAccount);
  const [phase, setPhase] = useState<LandingPhase>({ kind: 'loading' });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [resolveNonce, setResolveNonce] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const signedOut = accountKind === 'disconnected' || accountKind === 'guest';

  // The account decides between Sign in and the summary, and nothing else on
  // screen is guaranteed to have read it yet.
  useEffect(() => {
    if (!accountHydrated) void hydrateAccount();
  }, [accountHydrated, hydrateAccount]);

  useEffect(() => {
    if (!accountHydrated || signedOut) return undefined;
    let cancelled = false;
    setPhase({ kind: 'loading' });
    void (async (): Promise<void> => {
      try {
        const landing = await window.api.sharedContainers.resolveLink({
          token,
        });
        if (!cancelled) setPhase({ kind: 'resolved', landing });
      } catch {
        // A removed, reset, or unknown link and a policy-suspended one all
        // read the same: the server does not say which.
        if (!cancelled) setPhase({ kind: 'unavailable' });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [token, accountHydrated, signedOut, resolveNonce]);

  // Signing in elsewhere (the account menu, Settings) re-reads the account and
  // re-asks the question.
  useEffect(() => {
    const refresh = (): void => {
      void hydrateAccount({ refreshAfterCurrent: true }).finally(() => {
        if (mountedRef.current) setResolveNonce((current) => current + 1);
      });
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, [hydrateAccount]);

  const handleSignIn = useCallback((): void => {
    if (signingIn) return;
    setSigningIn(true);
    void window.api
      .startCanopyCloudOAuthLogin()
      .then((result) => {
        if (result.status.authenticated && result.status.account != null) {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setSigningIn(false);
      });
  }, [signingIn]);

  const landing = phase.kind === 'resolved' ? phase.landing : null;
  const ready =
    landing?.state === 'ready' && landing.eligible !== false ? landing : null;
  const showSignIn = signedOut || landing?.state === 'sign-in-required';
  const notEligible =
    !showSignIn &&
    (landing?.state === 'not-eligible' ||
      (landing?.state === 'ready' && landing.eligible === false));

  const handleOpen = useCallback((): void => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    void (async (): Promise<void> => {
      try {
        // Main claims the link and records this device's consent in one
        // call; a grant the account already holds is left as it is.
        await openSharedContainerInOwningContext({
          mode: 'accept',
          resolveAccess: async () =>
            ready?.alreadyHasAccess && ready.existingAccess
              ? ready.existingAccess
              : window.api.sharedContainers.claimLink({ token }),
        });
        onClose();
      } catch {
        if (!mountedRef.current) return;
        setOpening(false);
        setOpenError(LINK_LANDING_OPEN_FAILED);
      }
    })();
  }, [onClose, opening, ready, token]);

  const title = ready?.title ?? LINK_LANDING_FALLBACK_TITLE;
  // The owner is a person: replay records a box for the name only.
  const subtitle = ready ? (
    <>
      Shared by{' '}
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{ready.owner.name}</span>
      {ready.organizationName ? ` · ${ready.organizationName}` : null}
    </>
  ) : undefined;

  let body: JSX.Element;
  let primary: JSX.Element | null = null;
  if (showSignIn) {
    body = (
      <p className="text-s fg-secondary" data-testid={`${TEST_ID}-sign-in`}>
        {LINK_LANDING_SIGN_IN}
      </p>
    );
    primary = (
      <Button
        variant="primary"
        size="sm"
        onClick={handleSignIn}
        aria-disabled={signingIn}
        data-testid={`${TEST_ID}-sign-in-action`}
      >
        {signingIn ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
      </Button>
    );
  } else if (phase.kind === 'loading') {
    body = (
      <div
        className="flex justify-center py-6"
        data-testid={`${TEST_ID}-loading`}
      >
        <LoadingSpinner tone="secondary" />
      </div>
    );
  } else if (phase.kind === 'unavailable') {
    body = (
      <p className="text-s fg-secondary" data-testid={`${TEST_ID}-unavailable`}>
        {LINK_LANDING_UNAVAILABLE}
      </p>
    );
  } else if (notEligible || !ready) {
    body = (
      <p
        className="text-s fg-secondary"
        data-testid={`${TEST_ID}-not-eligible`}
      >
        {LINK_LANDING_NOT_ELIGIBLE}
      </p>
    );
  } else {
    const { contents } = ready;
    const items = [
      ready.containerType === 'CODE_WORKTREE' && contents.repositoryCount > 0
        ? `${plural(contents.repositoryCount, 'repository', 'repositories')}${
            contents.repositoryNames.length > 0
              ? `: ${contents.repositoryNames.join(', ')}`
              : ''
          }`
        : null,
      plural(contents.chatCount, 'chat', 'chats'),
      plural(contents.fileCount, 'file', 'files'),
    ].filter((item): item is string => item !== null);
    body = (
      <div className="space-y-4" data-testid={`${TEST_ID}-summary`}>
        <section className="space-y-1">
          <h3 className="text-s font-medium fg-primary">What’s inside</h3>
          <ul className="space-y-0.5" data-testid={`${TEST_ID}-contents`}>
            {items.map((item) => (
              <li key={item} className="truncate text-s fg-secondary">
                {item}
              </li>
            ))}
          </ul>
        </section>
        <SharedContainerAcceptSummary
          testIdPrefix={TEST_ID}
          error={openError}
        />
      </div>
    );
    primary = (
      <Button
        variant="primary"
        size="sm"
        onClick={handleOpen}
        aria-disabled={opening}
        data-testid={`${TEST_ID}-open`}
      >
        {opening
          ? OPENING_LABEL
          : ready.alreadyHasAccess
            ? OPEN_LABEL
            : ACCEPT_AND_OPEN_LABEL}
      </Button>
    );
  }

  return (
    <DialogModal
      inset="flush"
      title={title}
      {...(subtitle ? { subtitle } : {})}
      maxWidth="md"
      onClose={opening ? (): void => {} : onClose}
      closeOnBackdrop={!opening}
      dataTestId={TEST_ID}
    >
      <div className="px-6 py-4">{body}</div>
      <div className="flex justify-end gap-2 border-t px-6 py-3">
        {primary ?? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid={`${TEST_ID}-close`}
          >
            {CLOSE_LABEL}
          </Button>
        )}
      </div>
    </DialogModal>
  );
}
