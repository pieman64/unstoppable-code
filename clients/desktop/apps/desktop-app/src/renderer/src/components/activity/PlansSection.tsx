import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import {
  HeaderActionButton,
  Markdown,
  PlanProvenance,
  PlanReviewStatusBadge,
  PlanStatusNote,
} from '@canopy/ui-shared/components';
import type { PipelineData } from '@canopy/desktop-shared/types/pipeline';
import { PlanReadyPipelineModal } from '@/components/chat/PlanReadyPipelineModal';
import type { PipelinePluginCollectionRunContext } from '@/components/activity/PipelineTriggerModal';
import { PlanActionControls } from '@/components/shared/PlanActionControls';
import {
  SharePlanModal,
  type SharePlanShareRequest,
} from '@/components/shared/SharePlanModal';
import {
  hasVisiblePlanShare,
  shareButtonLabel,
} from '@/components/shared/planShareLabel';
import { useShareAccess } from '@/hooks/useShareAccess';
import { SHARE_PLAN_GATE_CONTEXT } from '@/lib/share-gate-context';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { extractIpcErrorMessage } from '@/lib/errors';
import { resolveSharedPlanUrl } from '@/lib/share-links';
import { useTeamOrgShareEntryVisible } from '@/lib/share-targets';
import { buildPlanReadyExecuteOptions } from '@/lib/planReadyPipelineExecuteOptions';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { implementTrackedPlan } from '@/lib/plans/plan-follow-up';
import { PLAN_DISPATCH_BUSY_MESSAGE } from '@/stores/chat/plan-utils';
import { reconcileExecutedPlan } from '@/lib/plans/reconcile-tracked-plans';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import {
  planExecuteAvailability,
  usePlanImplementationState,
  beginPlanWorkflowDispatch,
  type PlanStatusNoteTarget,
} from '@/components/plan-explore/usePlanImplementationState';
import {
  useActivitySectionChrome,
  FRAMELESS_HIDDEN_GROUP_MAX_H,
  type CollapsedIconColor,
} from '@/components/shared/panel-section';
import { ActivitySection } from './ActivitySection';
import { PlanSourceMark } from './PlanSourceMark';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import { usePanelWorktreeSelection } from '@/lib/panels/panel-worktree-context';
import { PlansEmptyMessage } from '@canopy/ui-app/plans';
import {
  INLINE_PLAN_MARKDOWN_OPTIONS,
  PLAN_MARKDOWN_OPTIONS,
  stripPlanTitleLine,
} from '@canopy/ui-app/plan-markdown';
import {
  EyeIcon,
  EyeOffIcon,
  PipelineIcon,
  PlanModeIcon,
  PlusIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Button } from '@canopy/ui-shared/components';

const EMPTY_TRACKED_PLANS: TrackedPlanData[] = [];
const EMPTY_DETECTED_PLANS: DetectedPlanEntry[] = [];

export function PlansIcon(): JSX.Element {
  return <PlanModeIcon />;
}

interface PlanCardProps {
  plan: TrackedPlanData;
  readOnly?: boolean;
  onOpen: () => void;
  onToggleHidden: () => void;
  onExplore: () => void;
  onChatFollowUp: () => void;
  onPipelineFollowUp: () => void;
  onShare?: () => void;
  shareBusy: boolean;
  onOpenExecution: (executionId: string) => void;
}

function PlanCard({
  plan,
  readOnly = false,
  onOpen,
  onToggleHidden,
  onExplore,
  onChatFollowUp,
  onPipelineFollowUp,
  onShare,
  shareBusy,
  onOpenExecution,
}: PlanCardProps): JSX.Element {
  const shareEntryVisible = useTeamOrgShareEntryVisible(
    hasVisiblePlanShare(plan),
  );
  const body = stripPlanTitleLine(plan.content);
  const implementation = usePlanImplementationState(plan);
  const navigationExecution = usePipelineRunsStore((state) =>
    state.summaries.find(
      (summary) => summary.id === implementation.navigationExecutionId,
    ),
  );
  const openTarget = implementation.openTarget;
  // Open already reaches the selected run, like an outcome note's link.
  const executionHasOutcomeLink =
    (openTarget?.kind === 'run' &&
      openTarget.executionId === navigationExecution?.id) ||
    implementation.notes.some(
      (note) =>
        note.text &&
        note.target.kind === 'run' &&
        note.target.executionId === navigationExecution?.id,
    );
  const openNoteTarget = (target: PlanStatusNoteTarget): void => {
    if (target.kind === 'run') {
      onOpenExecution(target.executionId);
    } else {
      revealWorktreeChatPanel(
        { projectId: plan.projectId, worktreeId: plan.worktreeId },
        target.chatId,
      );
    }
  };

  return (
    <div
      key={plan.id}
      role="button"
      tabIndex={0}
      data-testid={`activity-plan-row-${plan.id}`}
      onClick={onOpen}
      onKeyDown={(e): void => {
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group/plan focus-ring relative w-full cursor-pointer rounded-lg border bg-fg-primary/[0.03] p-3 text-left transition-colors hover:bg-fg-primary/[0.06]"
    >
      {!readOnly && (
        <div className="absolute right-2 top-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/plan:opacity-100">
          <Button
            variant="ghost-overlay"
            size="compact"
            iconOnly
            data-testid={`activity-plan-toggle-hidden-${plan.id}`}
            onClick={(event): void => {
              event.stopPropagation();
              onToggleHidden();
            }}
            aria-label={plan.hidden ? 'Show plan' : 'Hide plan'}
          >
            {plan.hidden ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
        </div>
      )}

      <div className="flex items-start gap-2 pr-6">
        <PlanSourceMark
          source={plan.source}
          size={14}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-s font-semibold fg-primary">
            <Markdown options={INLINE_PLAN_MARKDOWN_OPTIONS}>
              {plan.title}
            </Markdown>
          </div>
          {body && (
            <div className="prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert mt-1 line-clamp-3 max-w-none text-xs leading-5 fg-secondary prose-p:my-0 prose-pre:my-0 prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:text-xs prose-headings:fg-primary/80 prose-strong:fg-primary/80 prose-li:my-0">
              <Markdown options={PLAN_MARKDOWN_OPTIONS}>{body}</Markdown>
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs fg-secondary">
        <span className="shrink-0">Rev {plan.latestRevisionNumber}</span>
        <PlanReviewStatusBadge
          className="shrink-0"
          status={implementation.status}
          data-testid={`activity-plan-status-${plan.id}`}
        />
        {/* The run link already sits beside the status, so only outcome
            and chat notes are added here. */}
        {!readOnly &&
          implementation.notes
            .filter((note) => note.text || note.target.kind === 'chat')
            .map((note) => (
              <PlanStatusNote
                key={`${note.target.kind}-${note.target.kind === 'run' ? note.target.executionId : note.target.chatId}-${note.text ?? ''}`}
                text={note.text}
                data-testid={`activity-plan-status-note-${plan.id}`}
                link={{
                  label: note.linkLabel,
                  onSelect: (): void => openNoteTarget(note.target),
                  'data-testid': `activity-plan-status-note-${note.target.kind}-${plan.id}`,
                }}
              />
            ))}
        <PlanProvenance
          source={plan.source}
          sourceFilePath={plan.sourceFilePath}
        />
        {!readOnly && navigationExecution && !executionHasOutcomeLink ? (
          <button
            type="button"
            data-testid={`activity-plan-execution-${plan.id}`}
            onClick={(event): void => {
              event.stopPropagation();
              onOpenExecution(navigationExecution.id);
            }}
            className="focus-ring inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs fg-info transition-colors hover:bg-fg-primary/[0.06]"
          >
            <PipelineIcon width={11} height={11} className="shrink-0" />
            <span className="truncate">
              {navigationExecution.pipeline_name}
            </span>
          </button>
        ) : null}
      </div>

      {!readOnly && !plan.hidden && (
        <div
          className="mt-2 flex items-center justify-end"
          onClick={(event): void => event.stopPropagation()}
        >
          <PlanActionControls
            dataTestIdPrefix={`activity-plan-${plan.id}`}
            planContent={plan.content}
            {...planExecuteAvailability(plan, implementation)}
            executeEmphasis={implementation.status.executeEmphasis}
            primaryAction={implementation.status.primaryAction}
            openVenue={openTarget?.kind === 'run' ? 'pipeline' : 'chat'}
            onOpen={
              openTarget ? (): void => openNoteTarget(openTarget) : undefined
            }
            onExplore={onExplore}
            onImplement={onChatFollowUp}
            onPipeline={onPipelineFollowUp}
            onShare={shareEntryVisible ? onShare : undefined}
            shareLabel={shareButtonLabel(plan, shareBusy)}
            shareBusy={shareBusy}
          />
        </div>
      )}
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePlansHeaderChrome(scope?: {
  projectId: string;
  worktreeId: string;
}): {
  subtitle: string;
  collapsedIconColor: CollapsedIconColor;
} {
  const storedWorktree = useChatStore((state) => state.selectedWorktree);
  const readOnly = useWorkspaceIsReadOnly();
  const panelWorktree = usePanelWorktreeSelection();
  const selectedWorktree =
    scope ?? (readOnly && panelWorktree ? panelWorktree : storedWorktree);
  const key = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : '';
  const plans = useActivityStore((state) =>
    key
      ? (state.trackedPlans[key] ?? EMPTY_TRACKED_PLANS)
      : EMPTY_TRACKED_PLANS,
  );
  if (!selectedWorktree) {
    return { subtitle: 'No worktree selected', collapsedIconColor: 'muted' };
  }
  if (plans.length === 0) {
    return { subtitle: 'No tracked plans yet', collapsedIconColor: 'muted' };
  }
  const visibleCount = plans.filter((plan) => !plan.hidden).length;
  const hiddenCount = plans.length - visibleCount;
  return {
    subtitle:
      hiddenCount > 0
        ? `${visibleCount} tracked · ${hiddenCount} hidden`
        : `${visibleCount} tracked`,
    collapsedIconColor: 'blue',
  };
}

export function PlansSection(): JSX.Element {
  // A read-only scope (the shared-container recipient) is not the chat
  // store's selected worktree, so it reads the panel's owning scope instead.
  const readOnly = useWorkspaceIsReadOnly();
  const panelWorktree = usePanelWorktreeSelection();
  const storedWorktree = useChatStore((state) => state.selectedWorktree);
  const selectedWorktree =
    readOnly && panelWorktree ? panelWorktree : storedWorktree;
  const headerChrome = usePlansHeaderChrome(selectedWorktree ?? undefined);
  const markTrackedPlanExecuted = useChatStore(
    (state) => state.markTrackedPlanExecuted,
  );
  const key = selectedWorktree
    ? `${selectedWorktree.projectId}/${selectedWorktree.worktreeId}`
    : '';
  const plans = useActivityStore((state) =>
    key
      ? (state.trackedPlans[key] ?? EMPTY_TRACKED_PLANS)
      : EMPTY_TRACKED_PLANS,
  );
  const loadTrackedPlans = useActivityStore((state) => state.loadTrackedPlans);
  const togglePlanHidden = useActivityStore((state) => state.togglePlanHidden);
  const shareTrackedPlan = useActivityStore((state) => state.shareTrackedPlan);
  const addToast = useGitHubStore((state) => state.addToast);
  const openImportModal = useActivityStore((state) => state.openImportModal);
  const loadDetectedPlans = useActivityStore(
    (state) => state.loadDetectedPlans,
  );
  const pendingSuggestionCount = useActivityStore(
    (state) =>
      (key
        ? (state.detectedPlans[key] ?? EMPTY_DETECTED_PLANS)
        : EMPTY_DETECTED_PLANS
      ).filter((entry) => entry.status === 'detected').length,
  );
  const [pipelinePlan, setPipelinePlan] = useState<TrackedPlanData | null>(
    null,
  );
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineRunError, setPipelineRunError] = useState<string | null>(null);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [sharePlan, setSharePlan] = useState<TrackedPlanData | null>(null);
  const [sharingPlanId, setSharingPlanId] = useState<string | null>(null);
  const { requestShare, shareGateModal } = useShareAccess();
  const chrome = useActivitySectionChrome();
  const frameless = chrome === 'frameless';
  const sectionClassName = frameless ? 'flex min-h-0 flex-1 flex-col' : '';
  // In body-only chrome the shared section wrapper carries the container
  // testid (via the adapter's dataTestId override); emitting it here too
  // would duplicate the id.
  const sectionTestId =
    chrome === 'body-only' ? undefined : 'activity-plans-section';

  const visiblePlans = useMemo(() => plans.filter((p) => !p.hidden), [plans]);
  const hiddenPlans = useMemo(
    () => plans.filter((p) => p.hidden === true),
    [plans],
  );

  useEffect(() => {
    if (!selectedWorktree) {
      return;
    }

    void loadTrackedPlans(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    );
  }, [loadTrackedPlans, selectedWorktree]);

  // Plan files agents wrote in chats, for the empty state's suggestion chip.
  // A worktree with plans never shows the chip, so the read waits until the
  // tracked inventory confirms it has none. Results are stored per worktree,
  // so a late reply for a previous worktree cannot replace this one's.
  const trackedPlansLoaded = useActivityStore(
    (state) => key !== '' && state.trackedPlanInventoryLoaded[key] === true,
  );
  const isEmpty = trackedPlansLoaded && plans.length === 0;
  useEffect(() => {
    if (!selectedWorktree || readOnly || !isEmpty) {
      return;
    }
    void loadDetectedPlans(
      selectedWorktree.projectId,
      selectedWorktree.worktreeId,
    ).catch((): void => undefined);
  }, [isEmpty, loadDetectedPlans, readOnly, selectedWorktree]);

  // The list lives in the plan's worktree surface, so its Plan panel opens
  // there, beside that worktree's active chat, without navigating.
  const handleOpenPlan = useCallback((plan: TrackedPlanData): void => {
    void openTrackedPlan(
      {
        projectId: plan.projectId,
        worktreeId: plan.worktreeId,
        planId: plan.id,
      },
      { navigate: false },
    );
  }, []);

  // Implement in the plan's own worktree chat, never the selected worktree's.
  const handleChatFollowUp = useCallback(
    async (plan: TrackedPlanData): Promise<void> => {
      try {
        await implementTrackedPlan(plan);
      } catch (error: unknown) {
        addToast(
          error instanceof Error
            ? error.message
            : 'Failed to start chat follow-up',
          'error',
          undefined,
          {
            category: 'Chat',
            projectId: plan.projectId,
            worktreeId: plan.worktreeId,
          },
        );
      }
    },
    [addToast],
  );

  const handlePipelineFollowUp = useCallback((plan: TrackedPlanData): void => {
    setPipelinePlan(plan);
    setPipelineRunError(null);
  }, []);

  // Fire the "Plan shared." success toast, resolving the plan's shareable link
  // so the notification hands the user the URL directly. Best-effort: the toast
  // still fires without a link when the cloud base URL is unavailable or the
  // plan has no server copy yet.
  const emitPlanSharedToast = useCallback(
    (plan: TrackedPlanData): void => {
      const remoteId = plan.share?.remoteId;
      if (!remoteId) {
        addToast('Plan shared.', 'success', undefined, {
          projectId: plan.projectId,
          worktreeId: plan.worktreeId,
        });
        return;
      }
      void resolveSharedPlanUrl(remoteId).then((shareUrl) => {
        addToast('Plan shared.', 'success', undefined, {
          projectId: plan.projectId,
          worktreeId: plan.worktreeId,
          ...(shareUrl ? { link: { url: shareUrl, signedIn: true } } : {}),
        });
      });
    },
    [addToast],
  );

  const handleShare = useCallback(
    (plan: TrackedPlanData): void => {
      if (!hasVisiblePlanShare(plan)) {
        setSharePlan(plan);
        return;
      }
      setSharingPlanId(plan.id);
      void shareTrackedPlan(plan.projectId, plan.worktreeId, plan.id)
        .then((updated) => {
          if (!updated) {
            addToast('Failed to share plan.', 'error', undefined, {
              projectId: plan.projectId,
              worktreeId: plan.worktreeId,
            });
            return;
          }
          emitPlanSharedToast(updated);
        })
        .catch(() => {
          addToast('Failed to share plan.', 'error', undefined, {
            projectId: plan.projectId,
            worktreeId: plan.worktreeId,
          });
        })
        .finally(() => {
          setSharingPlanId(null);
        });
    },
    [addToast, emitPlanSharedToast, shareTrackedPlan],
  );

  const handleShareSubmit = useCallback(
    async (request: SharePlanShareRequest): Promise<TrackedPlanData | null> => {
      if (!sharePlan) {
        return null;
      }
      const target = sharePlan;
      setSharingPlanId(target.id);
      try {
        return await shareTrackedPlan(
          target.projectId,
          target.worktreeId,
          target.id,
          request,
        );
      } finally {
        setSharingPlanId(null);
      }
    },
    [shareTrackedPlan, sharePlan],
  );

  const handlePipelineRun = useCallback(
    async (
      _pipelineId: string,
      pipeline: PipelineData,
      inputs: Record<string, string> | undefined,
      selectedRepoId: string | undefined,
      pluginCollectionContext: PipelinePluginCollectionRunContext,
    ): Promise<void> => {
      if (!selectedWorktree || !pipelinePlan) {
        setPipelineRunError('Missing worktree or plan context');
        return;
      }

      const release = beginPlanWorkflowDispatch(pipelinePlan);
      if (!release) {
        setPipelineRunError(PLAN_DISPATCH_BUSY_MESSAGE);
        return;
      }

      setPipelineRunning(true);
      setPipelineRunError(null);

      try {
        const cwd = await window.api.getWorktreePath({
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
          repoId: selectedRepoId,
        });
        const result = await window.pipelines.execute(
          pipeline.content,
          buildPlanReadyExecuteOptions({
            cwd,
            pipeline,
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
            planId: pipelinePlan.id,
            planContent: pipelinePlan.content,
            inputs,
            pluginCollectionContext,
          }),
        );

        if (!result.success) {
          setPipelineRunError(result.error ?? 'Workflow execution failed');
          return;
        }

        markTrackedPlanExecuted({
          projectId: selectedWorktree.projectId,
          worktreeId: selectedWorktree.worktreeId,
          planId: pipelinePlan.id,
        });
        // Implicit plan approval is performed authoritatively in the main
        // process (`startPipelineExecutionFromMain`) for every `plan_ready`
        // run, so the renderer no longer emits a duplicate approval. The
        // refetch below pulls the already-approved state back from main.
        await reconcileExecutedPlan(selectedWorktree, pipelinePlan.id);
        setPipelinePlan(null);
      } catch (error: unknown) {
        setPipelineRunError(extractIpcErrorMessage(error));
      } finally {
        release();
        setPipelineRunning(false);
      }
    },
    [markTrackedPlanExecuted, pipelinePlan, selectedWorktree],
  );

  // A plan's run opens in its own panel; the plan's worktree is the owner
  // hint the opener checks against the run.
  const handleOpenExecution = useCallback(
    (executionId: string): void => {
      void openPipelineExecutionFromUi({
        executionId,
        ...(selectedWorktree
          ? {
              owner: {
                projectId: selectedWorktree.projectId,
                worktreeId: selectedWorktree.worktreeId,
              },
            }
          : {}),
      });
    },
    [selectedWorktree],
  );

  const importAction =
    selectedWorktree && !readOnly ? (
      <HeaderActionButton
        iconOnly
        data-testid="activity-plans-import"
        onClick={(event): void => {
          event.stopPropagation();
          openImportModal({
            projectId: selectedWorktree.projectId,
            worktreeId: selectedWorktree.worktreeId,
          });
        }}
        aria-label="Import plan"
      >
        <PlusIcon size={16} />
      </HeaderActionButton>
    ) : undefined;

  if (!selectedWorktree) {
    return (
      <div data-testid={sectionTestId} className={sectionClassName}>
        <ActivitySection
          icon={<PlansIcon />}
          title="Plans"
          subtitle={headerChrome.subtitle}
          collapsedIconColor={headerChrome.collapsedIconColor}
          headerAction={importAction}
          hasExpandableContent={plans.length > 0}
          actionOnlyLabel="Import"
        />
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <>
        <div data-testid={sectionTestId} className={sectionClassName}>
          <ActivitySection
            icon={<PlansIcon />}
            title="Plans"
            subtitle={headerChrome.subtitle}
            collapsedIconColor={headerChrome.collapsedIconColor}
            headerAction={importAction}
            // Read-only scopes have no import card, so their explanation
            // renders as the section body instead.
            hasExpandableContent={readOnly}
            actionOnlyCard
            actionOnlyLabel="Import plan"
            showBodyWithActionCard
          >
            <div
              data-testid="activity-plans-empty"
              className="space-y-2 text-xs fg-secondary"
            >
              <PlansEmptyMessage canImport={!readOnly} />
              {!readOnly && pendingSuggestionCount > 0 && (
                <Button
                  size="compact"
                  data-testid="activity-plans-suggestions-chip"
                  onClick={(event): void => {
                    event.stopPropagation();
                    openImportModal({
                      projectId: selectedWorktree.projectId,
                      worktreeId: selectedWorktree.worktreeId,
                    });
                  }}
                >
                  {pendingSuggestionCount} found in chats
                </Button>
              )}
            </div>
          </ActivitySection>
        </div>
      </>
    );
  }

  return (
    <>
      <div data-testid={sectionTestId} className={sectionClassName}>
        <ActivitySection
          icon={<PlansIcon />}
          title="Plans"
          subtitle={headerChrome.subtitle}
          collapsedIconColor={headerChrome.collapsedIconColor}
          headerAction={importAction}
          hasExpandableContent
          actionOnlyLabel="Import"
          framelessBody={frameless ? 'flex' : undefined}
        >
          <div
            className={
              frameless ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2'
            }
          >
            <div
              data-testid="plans-primary-list"
              className={
                frameless
                  ? 'min-h-0 flex-1 space-y-2 overflow-y-auto'
                  : 'max-h-76 space-y-2 overflow-y-auto'
              }
            >
              {visiblePlans.map((plan) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  readOnly={readOnly}
                  onOpen={(): void => handleOpenPlan(plan)}
                  onToggleHidden={(): void => void togglePlanHidden(plan)}
                  onExplore={(): void => handleOpenPlan(plan)}
                  onChatFollowUp={(): void => void handleChatFollowUp(plan)}
                  onPipelineFollowUp={(): void => handlePipelineFollowUp(plan)}
                  onShare={(): void =>
                    requestShare(SHARE_PLAN_GATE_CONTEXT, () =>
                      handleShare(plan),
                    )
                  }
                  shareBusy={sharingPlanId === plan.id}
                  onOpenExecution={handleOpenExecution}
                />
              ))}
            </div>

            {hiddenPlans.length > 0 && (
              <div className={frameless ? 'shrink-0' : 'mt-1'}>
                <button
                  type="button"
                  onClick={(): void => setHiddenExpanded(!hiddenExpanded)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs fg-secondary transition-colors hover:bg-fg-primary/[0.04] hover:fg-secondary"
                  data-testid="activity-plans-hidden-toggle"
                >
                  <AppCatalogChevronRightMediumIcon
                    width="12"
                    height="12"
                    className={`shrink-0 transition-transform ${hiddenExpanded ? 'rotate-90' : ''}`}
                  />
                  <EyeOffIcon />
                  <span>{hiddenPlans.length} hidden</span>
                </button>
                {hiddenExpanded && (
                  <div
                    className={
                      frameless
                        ? `mt-2 ${FRAMELESS_HIDDEN_GROUP_MAX_H} space-y-2 overflow-y-auto`
                        : 'mt-2 max-h-76 space-y-2 overflow-y-auto'
                    }
                  >
                    {hiddenPlans.map((plan) => (
                      <PlanCard
                        key={plan.id}
                        plan={plan}
                        readOnly={readOnly}
                        onOpen={(): void => handleOpenPlan(plan)}
                        onToggleHidden={(): void => void togglePlanHidden(plan)}
                        onExplore={(): void => handleOpenPlan(plan)}
                        onChatFollowUp={(): void =>
                          void handleChatFollowUp(plan)
                        }
                        onPipelineFollowUp={(): void =>
                          handlePipelineFollowUp(plan)
                        }
                        onShare={(): void =>
                          requestShare(SHARE_PLAN_GATE_CONTEXT, () =>
                            handleShare(plan),
                          )
                        }
                        shareBusy={sharingPlanId === plan.id}
                        onOpenExecution={handleOpenExecution}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </ActivitySection>
      </div>

      {/* Both dialogs portal themselves through DialogModal. */}
      {pipelinePlan && (
        <PlanReadyPipelineModal
          projectId={selectedWorktree?.projectId}
          worktreeId={selectedWorktree?.worktreeId}
          onClose={(): void => {
            if (pipelineRunning) {
              return;
            }
            setPipelinePlan(null);
            setPipelineRunError(null);
          }}
          onRun={handlePipelineRun}
          isRunning={pipelineRunning}
          runError={pipelineRunError}
        />
      )}

      {sharePlan && (
        <SharePlanModal
          planId={sharePlan.id}
          planTitle={sharePlan.title}
          existingShare={sharePlan.share}
          onClose={(): void => {
            if (sharingPlanId) {
              return;
            }
            setSharePlan(null);
          }}
          onShare={handleShareSubmit}
        />
      )}

      {shareGateModal}
    </>
  );
}
