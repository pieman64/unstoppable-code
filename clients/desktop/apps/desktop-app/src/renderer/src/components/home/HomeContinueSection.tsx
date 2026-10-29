import { useLayoutEffect, useMemo, type JSX } from 'react';
import { SuggestionRow } from '@canopy/ui-shared';
import {
  CloseMediumIcon,
  HistoryIcon,
  WarningIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useInterruptedSessions } from '@/hooks/useInterruptedSessions';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { shouldShowInterruptedSessionsBanner } from '@/lib/interruptedSessions';
import { dispatchAppAction } from '@/lib/app-actions/dispatcher';
import { useHomeInterruptedSessionsBannerStore } from '@/stores/homeInterruptedSessionsBannerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore, useWorktreeChatRenderState } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import { setOnboardingHomeResumePending } from '@/stores/onboardingSuggestionSurfacesStore';
import { useBranchDisplayStore } from '@/stores/branchDisplayStore';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';
import type { StartupResumeTarget } from '@/lib/startup-resume';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export interface HomeContinueSectionProps {
  /** Page-variant Home only polls the interrupted-session registry. */
  interruptedActive: boolean;
  /**
   * Only the page-variant instance reports the `home.interruptedSessionsBanner`
   * App Advisor slice. The slice is a single key-addressed entry, so an
   * embedded HomeSurface (the always-mounted MainPage keeps one alive) would
   * otherwise overwrite it with `visible: false` or clear it on unmount while
   * the row is still on screen.
   */
  isPageVariant?: boolean;
}

interface ResumeDetails {
  workspaceName: string;
  /** Cowork descriptor or final fallback when no worktree/chat name exists. */
  targetName: string;
  /** Worktree label, falling back to its branch display name. */
  worktreeName?: string;
  /** Active chat tab title, when it has already hydrated. */
  chatTitle?: string;
}

/**
 * Performs the navigation the old startup auto-restore used to do. Worktree
 * targets select synchronously; cowork targets tolerate failure (e.g. the
 * workspace was deleted mid-session) and still land on the chat page, where
 * StandaloneChatPage initializes a default cowork workspace on mount.
 */
function resumeTarget(offer: StartupResumeTarget): void {
  if (offer.kind === 'worktree') {
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree(offer.projectId, offer.worktreeId);
    return;
  }
  void (async (): Promise<void> => {
    try {
      const standaloneChatStore = useStandaloneChatStore.getState();
      if (!standaloneChatStore.chatProjectsLoaded) {
        await standaloneChatStore.loadChatProjects();
      }
      await useStandaloneChatStore
        .getState()
        .switchChatProject(offer.workspaceId, offer.workEntryId);
    } catch {
      // Tolerated — StandaloneChatPage initializes to a default cowork
      // workspace on mount when this resume attempt fails.
    }
    useNavigationStore.getState().navigate('chat');
  })();
}

/**
 * Shared "Continue" recommendation list below the Home composer. Hosts the
 * interrupted-sessions row and the startup resume row so both read as one
 * family with suggested prompts and project setup — shared {@link SuggestionRow}
 * rows, not a floating banner.
 */
function InterruptedSessionsUiStateReporter({
  visible,
  count,
}: {
  readonly visible: boolean;
  readonly count: number;
}): null {
  useCurrentUiStateReporter('home.interruptedSessionsBanner', {
    visible,
    count,
  });
  return null;
}

export function HomeContinueSection({
  interruptedActive,
  isPageVariant = false,
}: HomeContinueSectionProps): JSX.Element | null {
  const { isInContext } = useContextScopedWorkspaces();
  const summary = useInterruptedSessions(interruptedActive, isInContext);
  const dismissedSignature = useHomeInterruptedSessionsBannerStore(
    (s) => s.dismissedSignature,
  );
  const dismissInterrupted = useHomeInterruptedSessionsBannerStore(
    (s) => s.dismiss,
  );
  const interruptedVisible = shouldShowInterruptedSessionsBanner(
    summary,
    dismissedSignature,
  );

  const offer = useStartupResumeStore((s) => s.offer);
  const clearOffer = useStartupResumeStore((s) => s.clearOffer);
  const projects = useProjectsStore((s) => s.projects);
  const getBranchDisplayName = useBranchDisplayStore((s) => s.getDisplayName);
  const branchMappingsVersion = useBranchDisplayStore((s) => s.mappingsVersion);
  const chatState = useWorktreeChatRenderState(
    offer?.kind === 'worktree'
      ? `${offer.projectId}/${offer.worktreeId}`
      : null,
    (worktreeChat) => worktreeChat,
  );

  const resumeDetails = useMemo((): ResumeDetails | null => {
    if (!offer) {
      return null;
    }
    const offerWorkspaceId =
      offer.kind === 'worktree' ? offer.projectId : offer.workspaceId;
    if (!isInContext(offerWorkspaceId)) return null;
    if (offer.kind === 'cowork') {
      const workspace = projects.find(
        (project) =>
          project.id === offer.workspaceId && project.type === 'cowork',
      );
      if (!workspace) {
        return null;
      }
      return {
        workspaceName: getWorkspaceDisplayName(workspace),
        targetName: 'Cowork chat',
      };
    }

    const workspace = projects.find(
      (project) => project.id === offer.projectId,
    );
    if (!workspace || workspace.type === 'cowork') {
      return null;
    }
    const worktree = workspace.worktrees.find(
      (candidate) => candidate.id === offer.worktreeId,
    );
    if (!worktree) {
      return null;
    }
    const activeTab = chatState?.tabs.find(
      (tab) => tab.id === chatState.activeTabId,
    );
    const branchName = getWorktreeBranchDisplayName({
      rawBranch: worktree.branchName,
      worktreeId: worktree.id,
      hasMultipleBranches: false,
      getBranchDisplayName,
    });
    return {
      workspaceName: getWorkspaceDisplayName(workspace),
      targetName: branchName,
      worktreeName: worktree.label?.trim() || branchName,
      ...(activeTab?.title ? { chatTitle: activeTab.title } : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- branchMappingsVersion invalidates the display-name cache
  }, [
    offer,
    projects,
    chatState,
    getBranchDisplayName,
    branchMappingsVersion,
    isInContext,
  ]);

  const destinationName = resumeDetails
    ? (resumeDetails.worktreeName ??
      resumeDetails.chatTitle ??
      resumeDetails.targetName)
    : null;
  // The exact predicate that renders the resume row below, so Getting
  // started collapses only while Continue is actually on screen.
  const resumeRowVisible = Boolean(offer && resumeDetails && destinationName);

  // Page Home alone owns the flag: an embedded instance (MainPage keeps one
  // alive) must neither publish nor clear it. A layout effect so the
  // suggestions collapse in the same frame Continue appears.
  useLayoutEffect(() => {
    if (!isPageVariant || !resumeRowVisible) return;
    setOnboardingHomeResumePending(true);
    return (): void => setOnboardingHomeResumePending(false);
  }, [isPageVariant, resumeRowVisible]);

  const uiStateReporter = isPageVariant ? (
    <InterruptedSessionsUiStateReporter
      visible={interruptedVisible}
      count={summary.count}
    />
  ) : null;

  if (!interruptedVisible && !resumeRowVisible) {
    return uiStateReporter;
  }

  return (
    <>
      {uiStateReporter}
      <section
        data-testid="home-resume-card"
        aria-label="Continue where you left off"
        className="flex w-full flex-col gap-3"
      >
        <h2 className="px-4 text-m font-medium fg-primary">Continue</h2>
        <ul className="flex flex-col">
          {interruptedVisible ? (
            <li
              role="status"
              aria-live="polite"
              data-testid="home-interrupted-sessions-banner"
              className="group relative flex items-center rounded-full"
            >
              <SuggestionRow
                icon={<WarningIcon size={16} aria-hidden="true" />}
                data-testid="home-interrupted-sessions-resume"
                aria-label="Resume interrupted sessions"
                trailingControl
                onClick={(): void => {
                  void dispatchAppAction({
                    requestId: `ui-usage.open_resume_modal-${Date.now()}`,
                    source: 'ui',
                    action: { type: 'usage.open_resume_modal' },
                  });
                }}
              >
                <span data-testid="home-interrupted-sessions-details">
                  Resume {summary.count} interrupted session
                  {summary.count === 1 ? '' : 's'}
                </span>
              </SuggestionRow>
              <button
                type="button"
                aria-label="Dismiss"
                data-testid="home-interrupted-sessions-dismiss"
                onClick={(): void => dismissInterrupted(summary.signature)}
                className="focus-ring absolute right-2 top-1/2 z-10 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-full fg-secondary transition-colors hover:bg-muted hover:fg-primary"
              >
                <CloseMediumIcon width={16} height={16} />
              </button>
            </li>
          ) : null}
          {offer && resumeDetails && destinationName ? (
            <li data-testid="home-resume-details">
              <SuggestionRow
                icon={<HistoryIcon size={16} aria-hidden="true" />}
                data-testid="home-resume-button"
                aria-label={`Resume ${destinationName}`}
                onClick={(): void => {
                  clearOffer();
                  resumeTarget(offer);
                }}
              >
                <span
                  data-testid="home-resume-destination"
                  className={POSTHOG_REPLAY_MASK_CLASS}
                >
                  {destinationName}
                </span>
                <span
                  className={`${POSTHOG_REPLAY_MASK_CLASS} ml-2 fg-quaternary`}
                >
                  {resumeDetails.workspaceName}
                </span>
              </SuggestionRow>
            </li>
          ) : null}
        </ul>
      </section>
    </>
  );
}
