import type { JSX } from 'react';
import type { SharedContainerPublicationState } from '@canopy/desktop-shared/types';
import {
  LoadingSpinner,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import { DoneCheckIcon } from '@canopy/ui-shared/icons';
import {
  PUBLISHED_LABEL,
  PUBLISHING_LABEL,
  PUBLISH_FAILED_LABEL,
  NOT_PUBLISHED_LABEL,
  containerNoun,
  publicationErrorRemedy,
} from './shareCopy';
import {
  type ResolvedPublishStatus,
  resolvePublishStatus,
  resolveRevision,
} from './publishStatus';
import { ShareBudgetPushAction } from './ShareBudgetPushAction';
import type { ShareBudgetPush } from './useSharePreview';

const PUBLICATION_STATE_TEST_ID =
  'shared-container-invite-modal-publication-state';

export interface SharePublishStatusProps {
  publicationState: SharedContainerPublicationState | undefined;
  serverRevision: number | null;
  /**
   * The recipient list has loaded and is empty — not "has not loaded yet".
   * The caller must not conflate the two: during the post-invite refetch the
   * list is briefly empty while a recipient certainly exists, and treating
   * that as "nobody has access" would blink this status off mid-invite.
   */
  recipientsKnownEmpty?: boolean;
}

export interface SharePublishIssueProps extends SharePublishStatusProps {
  /**
   * The one-click push offered with an `artifact-budget` refusal. Optional so
   * a caller without a preview renders the remedy copy alone.
   */
  budgetPush?: ShareBudgetPush;
  onRetry: () => void;
  retrying?: boolean;
}

type PublishView =
  | { kind: 'none' }
  | {
      kind: 'publishing' | 'published' | 'resting' | 'error';
      status: Exclude<ResolvedPublishStatus, 'unknown'>;
      queued: boolean;
      revision: number | null;
    };

/**
 * What the publish status asserts, if anything.
 *
 * `not-published` splits in two, and only the local record means work is
 * pending — see `publishStatus.ts` steps 4 and 5:
 *
 * - **Local record → queued.** `sharedContainersInvite` calls
 *   `markNotPublished()` and `scheduler.schedule()` in the same handler, and
 *   `scheduler.recover()` re-runs the record after a restart. A publish really
 *   is on its way, so the owner sees the spinner the moment they invite,
 *   rather than a static line while main sits on its idle debounce.
 * - **`serverRevision === 0`, no record → resting.** Nothing is queued on this
 *   machine: the share was invited from another machine, or from the other
 *   runtime-mode data dir, or it never published and every recipient was then
 *   revoked. People with access renders whenever a container id exists — on
 *   modal open, not only after an invite — so keying the spinner off the
 *   resolved status alone would leave the manage view spinning forever here.
 */
function resolvePublishView({
  publicationState,
  serverRevision,
  recipientsKnownEmpty,
}: {
  publicationState: SharedContainerPublicationState | undefined;
  serverRevision: number | null;
  recipientsKnownEmpty: boolean;
}): PublishView {
  const status = resolvePublishStatus(publicationState, serverRevision);
  // Never assert a state we do not know.
  if (status === 'unknown') return { kind: 'none' };

  // Nobody has access, so there is nothing true to say about publishing this
  // revision — and specifically no publish is queued, whatever the local
  // record still says. `SharedContainerPublishScheduler.run()` returns early
  // when a target has no recipients and no live link, and leaves the
  // `not-published` record
  // untouched, and revoking a recipient never rewrites it, so an owner who
  // invites and then revokes their only recipient inside the publish debounce
  // strands a record that claims work is pending forever. `NO_RECIPIENTS_LABEL`
  // already states the real situation. `published`/`error` still render:
  // those describe what happened to the contents, which stays true after
  // everyone is revoked — but see the `error` scope line, which has to drop
  // its access claims in this same state.
  if (status === 'not-published' && recipientsKnownEmpty) {
    return { kind: 'none' };
  }

  // Both halves matter. The local record is what proves a publish is scheduled
  // on this machine, but the resolved status has to agree: when the server
  // already reports `revision >= 1` and a stale local record still says
  // `not-published` — published from another machine, or a `listSharedByMe`
  // result landing ahead of the local write — the record alone would report a
  // queued publish next to a `published` status. Keeping the resolved status
  // in the derivation is what makes `data-publish-queued` mean what its name
  // says.
  const queued =
    status === 'not-published' && publicationState?.status === 'not-published';
  const revision = resolveRevision(publicationState, serverRevision);
  const kind =
    status === 'publishing' || queued
      ? 'publishing'
      : status === 'published'
        ? 'published'
        : status === 'not-published'
          ? 'resting'
          : 'error';
  return { kind, status, queued, revision };
}

function dataAttributes(
  view: Exclude<PublishView, { kind: 'none' }>,
): Record<string, string> {
  return {
    'data-publish-status': view.status,
    'data-publish-queued': view.queued ? 'true' : 'false',
  };
}

/**
 * The publish status on the People with access heading: a spinner with
 * "Publishing changes…", then "Up to date".
 *
 * It replaced a task list that narrated every transition at the owner. The
 * revision number lives in the `title`, not the label: it is a detail the
 * owner occasionally wants and never needs. A failed publish is not a heading
 * status - {@link SharePublishIssue} renders it as a notice in the section
 * body.
 *
 * `data-publish-status` still reports the resolved status verbatim;
 * `data-publish-queued` tells the two not-published paths apart for
 * diagnostics and tests.
 */
export function SharePublishStatus({
  publicationState,
  serverRevision,
  recipientsKnownEmpty = false,
}: SharePublishStatusProps): JSX.Element | null {
  const view = resolvePublishView({
    publicationState,
    serverRevision,
    recipientsKnownEmpty,
  });
  if (view.kind === 'none' || view.kind === 'error') return null;
  const className = 'inline-flex items-center gap-1.5 text-xs fg-secondary';
  if (view.kind === 'publishing') {
    return (
      <span
        role="status"
        className={className}
        data-testid={PUBLICATION_STATE_TEST_ID}
        {...dataAttributes(view)}
      >
        <LoadingSpinner tone="secondary" />
        {PUBLISHING_LABEL}
      </span>
    );
  }
  if (view.kind === 'published') {
    return (
      <span
        role="status"
        className={className}
        data-testid={PUBLICATION_STATE_TEST_ID}
        {...(view.revision !== null
          ? { title: `Revision ${String(view.revision)}` }
          : {})}
        {...dataAttributes(view)}
      >
        <DoneCheckIcon className="h-3.5 w-3.5 fg-success" aria-hidden="true" />
        {PUBLISHED_LABEL}
      </span>
    );
  }
  return (
    <span
      role="status"
      className={className}
      data-testid={PUBLICATION_STATE_TEST_ID}
      {...dataAttributes(view)}
    >
      {NOT_PUBLISHED_LABEL}
    </span>
  );
}

/**
 * What the heading status cannot say in two words: why a resting share has
 * no contents yet, or a failed publish with its remedy.
 *
 * A failure is a warning notice inside People with access, never the dialog's
 * error region: the share itself landed, and only its contents are behind.
 */
export function SharePublishIssue({
  publicationState,
  serverRevision,
  recipientsKnownEmpty = false,
  budgetPush,
  onRetry,
  retrying = false,
}: SharePublishIssueProps): JSX.Element | null {
  const view = resolvePublishView({
    publicationState,
    serverRevision,
    recipientsKnownEmpty,
  });
  const noun = containerNoun();
  if (view.kind === 'resting') {
    return (
      <p className="text-xs fg-secondary">
        {/* No timing promise: nothing is queued on this machine, so the UI
            cannot say when — or whether — a publish will happen. */}
        {`Access is granted. This ${noun}'s contents haven't been published yet.`}
      </p>
    );
  }
  if (view.kind !== 'error') return null;

  const { revision } = view;
  const remedy =
    publicationState?.status === 'error' && publicationState.errorReason
      ? publicationErrorRemedy(
          publicationState.errorReason,
          noun,
          publicationState.error,
        )
      : null;
  const offerBudgetPush =
    remedy !== null &&
    budgetPush !== undefined &&
    publicationState?.status === 'error' &&
    publicationState.errorReason === 'artifact-budget';
  const rawError =
    remedy === null && publicationState?.status === 'error'
      ? publicationState.error
      : undefined;
  return (
    <Notice
      intent="attention"
      title={PUBLISH_FAILED_LABEL}
      data-testid={PUBLICATION_STATE_TEST_ID}
      {...dataAttributes(view)}
      detail={
        remedy ? (
          <span data-testid="shared-container-invite-modal-publication-error-reason">
            {remedy}
          </span>
        ) : rawError ? (
          <span data-testid="shared-container-invite-modal-publication-error">
            {rawError}
          </span>
        ) : undefined
      }
      actions={
        <>
          <NoticeButton
            variant={offerBudgetPush ? 'secondary' : 'primary'}
            disabled={retrying}
            aria-busy={retrying}
            data-testid="shared-container-invite-modal-publication-retry"
            onClick={onRetry}
          >
            {retrying && <LoadingSpinner decorative />}
            {retrying ? 'Trying again…' : 'Try again'}
          </NoticeButton>
          {offerBudgetPush && (
            <ShareBudgetPushAction
              budgetPush={budgetPush}
              dataTestId="shared-container-invite-modal-publication-budget-push"
            />
          )}
        </>
      }
    >
      {/*
        Access and contents are separate facts. A failed publish never
        revokes a grant, and whether recipients are looking at a stale
        revision or at nothing at all is the owner's actual question.

        Both of those sentences are claims about access, so neither can be
        made once the recipient list is known-empty: on the
        revoke-the-last-recipient path, "Access remains granted" would tell an
        owner who just clicked Remove access that the grant survived, and
        "Recipients can still access revision N" would name recipients who no
        longer exist. With nobody holding a grant the only true thing left is
        what happened to the contents.
      */}
      <span data-testid="shared-container-invite-modal-publication-error-scope">
        {recipientsKnownEmpty
          ? revision === null
            ? `This ${noun}'s contents were never published.`
            : `Revision ${String(revision)} was published, but newer changes could not be.`
          : revision === null
            ? `Access remains granted, but this ${noun}'s contents are not available to recipients.`
            : `Recipients can still access revision ${String(revision)}, but newer changes could not be published.`}
      </span>
    </Notice>
  );
}
