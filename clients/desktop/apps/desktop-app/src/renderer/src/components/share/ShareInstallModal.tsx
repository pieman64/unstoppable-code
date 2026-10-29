import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import { useCallback, useEffect, useMemo, useRef, type JSX } from 'react';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import {
  shareInstallActionLabel,
  shareInstallDefaultDescription,
  shareInstallEntityNoun,
  shareInstallPlaceholderTitle,
  shareInstallTypeLabel,
  type ShareInstallEntity,
} from '@canopy/ui-app/sharing/share-install-copy';
import { InstalledShareMenu } from '@canopy/ui-shared/components/InstalledShareMenu';
import {
  ShareInstallDialog,
  type ShareInstallDialogPrimary,
} from '@canopy/ui-shared/components/ShareInstallDialog';
import { markdownDescriptionToPlainText } from '@canopy/ui-shared/lib/markdown-plain-text';
import { LoadingPlaceholder } from '../shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  useNavigationStore,
  type PendingShareInstall,
  type ShareInstallOrigin,
} from '@/stores/navigationStore';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import { toInstallWorkspaceOptions } from '@/lib/installWorkspaceOptions';
import { parseSkillSource } from '@/lib/skillFrontmatter';
import {
  InstallSharedAutomationModal,
  type AutomationProjectCreationRequest,
  type InstallAutomationOutcome,
} from '@/components/automations/InstallSharedAutomationModal';
import {
  usePublicShareLanding,
  type PublicShareInstalledTarget,
  type PublicShareLanding,
} from './usePublicShareLanding';
import { shareLandingErrorCopy } from './shareLandingErrorCopy';
import { openInstallReveal, openInstalledResult } from './installReveal';
import { SharedContainerLinkLandingModal } from '@/components/shared-containers/SharedContainerLinkLandingModal';

/**
 * The install review for every shared resource (CAN-3710): a share deep link
 * from the web and an in-app Add or Install open the same small dialog. It
 * names the item, says who shared it, describes it in a line or three, and
 * offers exactly one primary action. Nothing installs without that click.
 * A finished install closes the review and lands on the result.
 *
 * All landing behavior lives in `usePublicShareLanding`; this shell only
 * renders its phases through the shared `ShareInstallDialog`.
 */

interface ShareInstallModalProps {
  link: DeepLinkShareOpenEvent;
  origin: ShareInstallOrigin;
  onClose: () => void;
}

/**
 * The item's own description, as plain text. A skill's comes from its
 * SKILL.md frontmatter when the share has none; agents carry none.
 */
function shareInstallDescription(
  snapshot: PublicShareSnapshot,
): string | undefined {
  switch (snapshot.entity) {
    case 'agent':
      return undefined;
    case 'skill': {
      if (snapshot.description) {
        return markdownDescriptionToPlainText(snapshot.description);
      }
      const listed = parseSkillSource(snapshot.rawSkill).frontmatter
        ?.description;
      return typeof listed === 'string'
        ? markdownDescriptionToPlainText(listed)
        : undefined;
    }
    case 'automation':
      return markdownDescriptionToPlainText(snapshot.automation.description);
    case 'workspace':
      return markdownDescriptionToPlainText(snapshot.template.description);
    case 'collection':
      return markdownDescriptionToPlainText(snapshot.collection.description);
    default:
      return markdownDescriptionToPlainText(snapshot.description);
  }
}

function snapshotName(
  snapshot: PublicShareSnapshot | null,
): string | undefined {
  if (!snapshot) return undefined;
  // Agents and workspace templates carry their display fields on a nested
  // portable document rather than on the snapshot itself.
  switch (snapshot.entity) {
    case 'automation':
      return snapshot.automation.name;
    case 'agent':
      return snapshot.agent.name;
    case 'workspace':
      return snapshot.template.name;
    case 'collection':
      return snapshot.collection.name;
    default:
      return snapshot.name;
  }
}

function installedStatus(
  installed: PublicShareInstalledTarget,
  installStatus: string,
): string {
  if (installStatus !== '') return installStatus;
  if (installed.entity === 'workspace') return 'Added to your projects.';
  if (
    (installed.entity === 'automation' || installed.entity === 'pipeline') &&
    installed.updateAvailable === true
  ) {
    return 'Installed. An update is available.';
  }
  if (installed.entity === 'skill') {
    return `Installed as “${installed.skillName}”.`;
  }
  return 'Installed.';
}

/** An entity whose installed copy offers Uninstall from the ⋯ menu. */
function offersUninstall(installed: PublicShareInstalledTarget): boolean {
  // Plugin removal is owned by the Plugins page (a marketplace can carry
  // several plugins); a project is user data once it exists; a collection is
  // managed on its own detail page.
  return (
    installed.entity !== 'plugin' &&
    installed.entity !== 'workspace' &&
    installed.entity !== 'collection'
  );
}

/**
 * Every field of the two links matches: a repeat of the same request (a
 * second Install click on the web), not a new one.
 */
function isSameShareLink(
  a: DeepLinkShareOpenEvent,
  b: DeepLinkShareOpenEvent,
): boolean {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
  return keys.every((key) => Reflect.get(a, key) === Reflect.get(b, key));
}

/** Entities whose `intent=try` stages something after the install. */
function hasTryNow(entity: DeepLinkShareOpenEvent['entity']): boolean {
  return (
    entity !== 'agent' &&
    entity !== 'workspace' &&
    entity !== 'collection' &&
    entity !== 'shared-container'
  );
}

export function ShareInstallModal({
  link,
  origin,
  onClose,
}: ShareInstallModalProps): JSX.Element {
  const landing = usePublicShareLanding(link, {
    onAutoNavigate: onClose,
    reportHandoffEvents: origin === 'deep-link',
  });
  const { snapshot, installReview } = landing;
  // Offer the same in-context projects as the Automations page (CAN-3448).
  const { projectsInContext } = useAutomationScope();
  const installWorkspaces = useMemo(
    () => toInstallWorkspaceOptions(projectsInContext),
    [projectsInContext],
  );

  // CAN-3651: a finished automation install or update leaves this flow for
  // the exact local copy on Workflows → Library. The wizard calls `onDone`
  // and then `onClose`; once completion is handled, that trailing close (and
  // any repeated callback) is a no-op, so the preview is never restored and
  // the handoff is reported once. A callback from a landing that was closed
  // or replaced by a newer link must not redirect the user or close that
  // link.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);
  const completedLinkRef = useRef<DeepLinkShareOpenEvent | null>(null);
  const currentReviewRef = useRef(installReview);
  currentReviewRef.current = installReview;
  const isCurrentLanding = useCallback(
    (): boolean =>
      mountedRef.current &&
      completedLinkRef.current !== link &&
      useNavigationStore.getState().pendingShareInstall?.link === link &&
      installReview !== null &&
      currentReviewRef.current === installReview,
    [link, installReview],
  );
  const { closeInstallReview, completeInstallReview } = landing;
  // An automation link opens straight into the review, so dismissing the
  // review dismisses the whole flow rather than revealing the landing.
  const handleInstallReviewClose = useCallback((): void => {
    if (!isCurrentLanding()) return;
    // Invalidate synchronously; a late result in the same React batch must
    // not complete an abandoned review or affect a newly opened one.
    currentReviewRef.current = null;
    closeInstallReview();
    onClose();
  }, [closeInstallReview, isCurrentLanding, onClose]);
  // `onDone` arrives while the wizard is still writing. Settle the write
  // before closing: a link held during it opens in place of this review
  // instead of being closed with it. A repeat of this same link is already
  // served, so the review still closes.
  const settleAndClose = useCallback((): void => {
    const navigation = useNavigationStore.getState();
    const held = navigation.heldShareInstall;
    navigation.setShareInstallBusy(false);
    if (held === undefined || isSameShareLink(held.link, link)) onClose();
  }, [link, onClose]);
  const handleInstallReviewDone = useCallback(
    (activityId?: string, outcome?: InstallAutomationOutcome): void => {
      if (!isCurrentLanding()) return;
      if (!activityId) {
        currentReviewRef.current = null;
        closeInstallReview();
        settleAndClose();
        return;
      }
      completedLinkRef.current = link;
      currentReviewRef.current = null;
      completeInstallReview(activityId);
      useNavigationStore.getState().openAutomationReveal({
        activityId,
        outcome:
          outcome ??
          (installReview?.staleActivity !== undefined
            ? 'updated'
            : 'installed'),
      });
      settleAndClose();
    },
    [
      closeInstallReview,
      completeInstallReview,
      installReview?.staleActivity,
      isCurrentLanding,
      link,
      settleAndClose,
    ],
  );
  // CAN-3980: creating a project closes this landing before the continued
  // install finishes, so the landing's own completion guard above would drop
  // it. The continuation carries a landing-independent completion instead: a
  // finished install records the handoff and reveals the copy exactly once.
  // A cancelled or failed install never calls it, and a completion without a
  // copy reveals nothing.
  const handleCreateProject = useCallback(
    (request: AutomationProjectCreationRequest): void => {
      onClose();
      const fallbackOutcome: InstallAutomationOutcome =
        request.staleActivities !== undefined &&
        request.staleActivities.length > 0
          ? 'updated'
          : 'installed';
      let completed = false;
      requestAutomationProjectCreation({
        ...request,
        // Deliberately replaces `request.onDone`: that is the landing's own
        // completion, which its closed-landing guard would reject. Anything a
        // completion must do on this path belongs here.
        onDone: (activityId, outcome): void => {
          if (completed || !activityId) return;
          completed = true;
          completeInstallReview(activityId);
          useNavigationStore.getState().openAutomationReveal({
            activityId,
            outcome: outcome ?? fallbackOutcome,
          });
        },
      });
    },
    [completeInstallReview, onClose],
  );

  const handleInstall = useInstallAndLand(link, landing, onClose);
  // An uninstall from the ⋯ menu is a write too: a newer request waits for
  // it the same way it waits for an install.
  const { uninstall } = landing;
  const handleUninstall = useCallback(async (): Promise<boolean> => {
    const navigation = useNavigationStore.getState();
    if (navigation.shareInstallBusy) return false;
    navigation.setShareInstallBusy(true);
    try {
      return await uninstall();
    } finally {
      useNavigationStore.getState().setShareInstallBusy(false);
    }
  }, [uninstall]);
  // The wizard writes on its own, so it marks the review busy itself: a newer
  // link is held until the write settles (see `openShareInstall`).
  const handleSubmittingChange = useCallback((submitting: boolean): void => {
    useNavigationStore.getState().setShareInstallBusy(submitting);
  }, []);

  // The author is a person: replay records a box for the name only.
  const publisher = snapshot?.authorUsername ? (
    <>
      Shared by{' '}
      <span className={POSTHOG_REPLAY_BLOCK_CLASS}>
        {snapshot.authorUsername}
      </span>
    </>
  ) : undefined;

  // Swap, not nest: two `DialogModal`s would stack two scrims, two focus
  // traps, and two Escape handlers over each other.
  if (installReview !== null && snapshot?.entity === 'automation') {
    return (
      <InstallSharedAutomationModal
        onCreateProject={handleCreateProject}
        detail={{
          id: snapshot.externalId,
          contentHash: snapshot.contentHash,
          automation: snapshot.automation,
        }}
        source={
          snapshot.sourceKind === 'curated'
            ? 'curated'
            : link.audience === 'TEAM' || link.audience === 'ORGANIZATION'
              ? 'shared'
              : 'public'
        }
        {...(installReview.staleActivity
          ? { staleActivities: [installReview.staleActivity] }
          : {})}
        workspaces={installWorkspaces}
        {...(publisher !== undefined ? { subtitle: publisher } : {})}
        onSubmittingChange={handleSubmittingChange}
        onClose={handleInstallReviewClose}
        onDone={handleInstallReviewDone}
      />
    );
  }

  // `shared-container` never reaches this shell (the host routes it to its
  // own landing), so every entity here installs.
  const entity: ShareInstallEntity =
    link.entity === 'shared-container' ? 'workspace' : link.entity;
  const noun = shareInstallEntityNoun(entity);
  const placeholder = shareInstallPlaceholderTitle(entity);
  const title = snapshotName(snapshot) ?? placeholder;
  const typeLabel = shareInstallTypeLabel(entity);
  const {
    state,
    installed,
    installing,
    uninstalling,
    installError,
    installProgress,
    installStatus,
    detecting,
    agentReadinessLoading,
    agentReviewLoading,
  } = landing;

  const description =
    snapshot !== null
      ? (shareInstallDescription(snapshot) ??
        shareInstallDefaultDescription(entity))
      : undefined;

  let primary: ShareInstallDialogPrimary | undefined;
  let blocker: string | undefined;
  let status: JSX.Element | undefined;
  let menu: JSX.Element | undefined;

  if (state.phase === 'error') {
    blocker = shareLandingErrorCopy(state.reason);
    if (state.reason === 'client-upgrade-required') {
      primary = {
        label: 'Check for updates',
        testId: 'deep-link-share-update-app',
        onClick: (): void => {
          void window.api.update.checkForUpdates().catch(() => {
            // Best effort: the update surface reports its own errors.
          });
        },
      };
    }
  } else if (state.phase === 'ready' && snapshot !== null) {
    const opensReview = landing.openingInstallReview;
    const updateAvailable =
      installed !== null &&
      (installed.entity === 'pipeline' || installed.entity === 'automation') &&
      installed.updateAvailable === true;
    if (installed === null || updateAvailable) {
      primary = {
        label: shareInstallActionLabel(
          entity,
          updateAvailable ? 'update' : 'install',
        ),
        busyLabel: shareInstallActionLabel(
          entity,
          updateAvailable ? 'updating' : 'installing',
        ),
        testId: updateAvailable
          ? 'deep-link-share-update'
          : 'deep-link-share-install',
        busy: installing,
        disabled:
          detecting ||
          agentReadinessLoading ||
          agentReviewLoading ||
          opensReview,
        onClick: (): void => {
          void handleInstall(updateAvailable ? 'updated' : 'installed');
        },
      };
    } else {
      primary = {
        label: shareInstallActionLabel(entity, 'open'),
        testId: 'deep-link-share-open',
        disabled: uninstalling,
        onClick: (): void => {
          onClose();
          openInstalledResult(installed);
        },
      };
    }
    if (installed !== null) {
      status = (
        <span data-testid="deep-link-share-installed-status">
          {installedStatus(installed, installStatus)}
        </span>
      );
      menu = (
        <InstalledShareMenu
          busy={installing || uninstalling}
          placement="above"
          uninstallTitle={`Uninstall this ${noun}?`}
          testIds={{
            kebab: 'deep-link-share-kebab',
            menu: 'deep-link-share-menu',
            manage: 'deep-link-share-manage',
            uninstall: 'deep-link-share-uninstall',
            uninstallConfirm: 'deep-link-share-uninstall-confirm',
            uninstallDialog: 'deep-link-share-uninstall-dialog',
          }}
          onManage={(): void => {
            landing.manage(onClose);
          }}
          {...(offersUninstall(installed)
            ? { onUninstall: handleUninstall }
            : {})}
        />
      );
    }
    if (installing && installProgress !== '') blocker = installProgress;
    if (installError !== '') blocker = installError;
  }

  return (
    <ShareInstallDialog
      title={title}
      typeLabel={typeLabel}
      publisher={publisher}
      description={description}
      loading={
        state.phase === 'loading' ||
        (state.phase === 'ready' && landing.openingInstallReview) ? (
          <LoadingPlaceholder label={`Loading ${placeholder.toLowerCase()}…`} />
        ) : undefined
      }
      blocker={blocker}
      status={status}
      statusTestId="share-install-status"
      primary={primary}
      menu={menu}
      // An uninstall from the ⋯ menu is a write too; it is not abandoned.
      busy={installing || uninstalling}
      onClose={onClose}
      titleId="deep-link-share-landing-title"
      dataTestId="deep-link-share-landing"
    />
  );
}

/**
 * The review's one write: install, then close and land on the result. While
 * it writes, a newer request is held (see `openShareInstall`); a failure keeps
 * the review open on its error so the same primary retries.
 */
function useInstallAndLand(
  link: DeepLinkShareOpenEvent,
  landing: PublicShareLanding,
  onClose: () => void,
): (outcome: 'installed' | 'updated') => Promise<void> {
  const { install } = landing;
  return useCallback(
    async (outcome: 'installed' | 'updated'): Promise<void> => {
      // A try link from the web already chose Try: the landing stages it as
      // soon as the install is known and closes the review through
      // `onAutoNavigate`, instead of revealing the result. The review stays
      // mounted until then, or the landing's staging effect never runs.
      const stagesTry = link.intent === 'try' && hasTryNow(link.entity);
      const navigation = useNavigationStore.getState();
      // One write at a time: a second click before the busy render must not
      // settle the first write's hold.
      if (navigation.shareInstallBusy) return;
      navigation.setShareInstallBusy(true);
      let result: Awaited<ReturnType<typeof install>> = null;
      try {
        result = await install();
      } finally {
        // Settling applies a request that arrived during the write. A repeat
        // of this same link is already served, so the review still closes.
        const held = useNavigationStore.getState().heldShareInstall;
        useNavigationStore.getState().setShareInstallBusy(false);
        const opensHeld =
          held !== undefined && !isSameShareLink(held.link, link);
        if (result !== null && !opensHeld && !stagesTry) onClose();
      }
      if (result === null || stagesTry) return;
      openInstallReveal({
        target: result.target,
        outcome,
        status: result.status,
        partial: result.partial,
      });
    },
    [install, link, onClose],
  );
}

/**
 * Self-gating App-level host (same pattern as `AddWorkspaceModalHost`):
 * renders the install review while a request is parked in the navigation
 * store and consumes it on close.
 */
export function ShareInstallModalHost(): JSX.Element | null {
  const pending: PendingShareInstall | undefined = useNavigationStore(
    (s) => s.pendingShareInstall,
  );
  const handleClose = useCallback((): void => {
    useNavigationStore.getState().consumeShareInstall();
  }, []);
  if (!pending) return null;
  const { link, origin } = pending;
  // A shared container's link is a capability, not a public share: it has its
  // own landing (summary, claim, the read-only viewer) and never goes through
  // the public-share resolve path. The key is deliberately not the token.
  if (link.entity === 'shared-container') {
    return (
      <SharedContainerLinkLandingModal
        token={link.externalId}
        onClose={handleClose}
      />
    );
  }
  return (
    <ShareInstallModal
      // The same share under another audience resolves differently, so it
      // re-resolves rather than reusing this review.
      key={`${link.entity}:${link.externalId}:${link.audience ?? 'PUBLIC'}`}
      link={link}
      origin={origin}
      onClose={handleClose}
    />
  );
}
