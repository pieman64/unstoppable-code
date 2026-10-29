import {
  memo,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import {
  useDiagramFind,
  useDomTextFind,
  type DiagramSearchHandle,
} from '@canopy/ui-app/find';
import {
  HeaderActionButton,
  RailTabBar,
  type RailTabBarTab,
} from '@canopy/ui-shared';
import { PlanDocumentPanel } from '@/components/plan-explore/PlanDocumentPanel';
import { PlanViewHeader } from '@/components/plan-explore/PlanViewHeader';
import {
  PlanVisualizer,
  preloadPlanVisualizer,
} from '@/components/plan-explore/lazyPlanVisualizer';
import {
  usePlanComments,
  type UsePlanComments,
} from '@/components/plan-explore/usePlanComments';
import { usePlanDiagramRevealRequest } from '@/components/plan-explore/usePlanDiagramRevealRequest';
import { usePlanFollowUpActions } from '@/components/plan-explore/usePlanFollowUpActions';
import { usePlanPanelCommentSubmit } from '@/components/plan-explore/usePlanPanelCommentSubmit';
import { useSharedPlanCommentPull } from '@/components/plan-explore/usePlanViewData';
import { LoadingPlaceholder } from '@/components/shared/StatusBlocks';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import {
  planDiagramPanelTitle,
  planPanelTitle,
  useIsPlanDiagramSplit,
  useIsPlanPanelOnScreen,
} from '@/lib/panels/plan-panel-identity';
import {
  revealPlanDiagram,
  revealPlanDiagramNode,
  revealWorktreeActivityPanel,
  revealWorktreeChatPanel,
  splitPlanDiagram,
} from '@/lib/panels/plan-panel-open';
import { useActivePlanStore } from '@/stores/activePlanStore';
import {
  planViewKey,
  usePlanViewStore,
  type PlanDiagramKind,
  type PlanViewInnerTab,
} from '@/stores/planViewStore';

export interface PlanPanelViewProps {
  /** The latest tracked plan. */
  readonly plan: TrackedPlanData;
  /**
   * Read-only scopes (shared-container recipients) show the document and its
   * comments only: no Diagram tab, Split, follow-up actions, new comments, or
   * submitting comments to chat.
   */
  readonly readOnly: boolean;
  /** Whether the panel is the active tab of the active group. */
  readonly isActive: boolean;
  /** Whether the panel is on screen. */
  readonly isVisible: boolean;
  /**
   * Make this plan the worktree's active plan; called on pointer or focus
   * inside the panel. A no-op for views that do not register (read-only).
   */
  readonly onActivate: () => void;
}

/** The rendered document the find bar's plan mode searches and scrolls. */
const PLAN_DOCUMENT_FIND_SELECTOR = '[data-testid="plan-explore-plan-panel"]';

const DOCUMENT_TAB: RailTabBarTab<PlanViewInnerTab> = {
  id: 'document',
  label: 'Document',
  dataTestId: 'plan-panel-tab-document',
};
const DOCUMENT_TABS: readonly RailTabBarTab<PlanViewInnerTab>[] = [
  DOCUMENT_TAB,
];
const DOCUMENT_AND_DIAGRAM_TABS: readonly RailTabBarTab<PlanViewInnerTab>[] = [
  DOCUMENT_TAB,
  { id: 'diagram', label: 'Diagram', dataTestId: 'plan-panel-tab-diagram' },
];

interface PlanPanelSplitActionProps {
  readonly split: boolean;
  /** Whether the split diagram is on screen, so needs no Show diagram. */
  readonly diagramOnScreen: boolean;
  readonly onSplit: () => void;
  readonly onShowDiagram: () => void;
}

/**
 * Split the diagram into its own panel, or bring the split diagram up while
 * it is off screen.
 */
function PlanPanelSplitAction({
  split,
  diagramOnScreen,
  onSplit,
  onShowDiagram,
}: PlanPanelSplitActionProps): JSX.Element | null {
  if (split && diagramOnScreen) {
    return null;
  }
  return split ? (
    <HeaderActionButton
      tone="neutral"
      data-testid="plan-panel-show-diagram"
      onClick={onShowDiagram}
    >
      Show diagram
    </HeaderActionButton>
  ) : (
    <HeaderActionButton
      tone="neutral"
      data-testid="plan-panel-split"
      tooltipLabel="Open diagram in its own panel"
      onClick={onSplit}
    >
      Split
    </HeaderActionButton>
  );
}

/**
 * Record the older revision this panel shows, so an active-plan send can tell
 * the agent which revision the user was reading; cleared while the latest is
 * shown and when the panel unmounts. Read-only panels never register a view
 * of the plan, so they record nothing.
 */
function useRecordViewedRevision(
  plan: Pick<TrackedPlanData, 'projectId' | 'worktreeId' | 'id'>,
  viewedRevision: number | null,
  readOnly: boolean,
): void {
  const { projectId, worktreeId, id: planId } = plan;
  useEffect(() => {
    if (readOnly) {
      return undefined;
    }
    const scope = { projectId, worktreeId };
    useActivePlanStore
      .getState()
      .setViewedRevision(scope, planId, viewedRevision);
    return (): void => {
      useActivePlanStore.getState().setViewedRevision(scope, planId, null);
    };
  }, [projectId, worktreeId, planId, viewedRevision, readOnly]);
}

/** The revision's content: the latest plan, or an older revision. */
function viewedPlanContent(
  plan: TrackedPlanData,
  viewedRevision: number | null,
): string {
  if (viewedRevision === null) {
    return plan.content;
  }
  return (
    plan.revisions.find(
      (revision) => revision.revisionNumber === viewedRevision,
    )?.content ?? plan.content
  );
}

interface PlanPanelActionsState {
  readonly selectTab: (tab: PlanViewInnerTab) => void;
  readonly split: () => void;
  readonly showDiagram: () => void;
  readonly revealDiagramNode: (kind: PlanDiagramKind, nodeId: string) => void;
  readonly revealChat: (chatId: string) => void;
  readonly revealRuns: () => void;
  readonly openExecution: (executionId: string) => void;
}

/** Stable handlers bound to one plan's identity. */
function usePlanPanelActions(plan: TrackedPlanData): PlanPanelActionsState {
  const { projectId, worktreeId, id: planId } = plan;
  return useMemo((): PlanPanelActionsState => {
    const scope = { projectId, worktreeId };
    const viewKey = planViewKey(projectId, worktreeId, planId);
    return {
      selectTab: (tab): void => {
        usePlanViewStore.getState().setInnerTab(viewKey, tab);
      },
      split: (): void => {
        void splitPlanDiagram(scope, planId);
      },
      showDiagram: (): void => {
        revealPlanDiagram(scope, planId);
      },
      revealDiagramNode: (kind, nodeId): void => {
        revealPlanDiagramNode(scope, planId, kind, nodeId);
      },
      // Implement reached the plan's own worktree chat; bring that chat up
      // and keep this panel open.
      revealChat: (chatId): void => {
        revealWorktreeChatPanel(scope, chatId);
      },
      // A plan_ready run started; bring up the worktree's pipeline runs,
      // where its run card appears, and keep this panel open.
      revealRuns: (): void => {
        revealWorktreeActivityPanel(scope);
      },
      // The run opens in its own panel; the plan's owner is the hint the
      // opener checks against the run.
      openExecution: (executionId): void => {
        void openPipelineExecutionFromUi({ executionId, owner: scope });
      },
    };
  }, [projectId, worktreeId, planId]);
}

interface PlanPanelBodyProps {
  readonly plan: TrackedPlanData;
  readonly tab: PlanViewInnerTab;
  readonly diagramRef: RefObject<DiagramSearchHandle | null>;
  readonly documentView: ReactNode;
  readonly onAddNodeComment: UsePlanComments['addNodeComment'];
  /** The shown diagram changed under an open find; re-run its query. */
  readonly onDiagramSearchContextChange: () => void;
}

/**
 * The Document stays mounted while hidden (it keeps its scroll position,
 * anchors, and draft); the diagram mounts only while its tab is shown.
 */
function PlanPanelBody({
  plan,
  tab,
  diagramRef,
  documentView,
  onAddNodeComment,
  onDiagramSearchContextChange,
}: PlanPanelBodyProps): JSX.Element {
  const revealRequest = usePlanDiagramRevealRequest(
    planViewKey(plan.projectId, plan.worktreeId, plan.id),
    tab === 'diagram',
  );
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={
          tab === 'document' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'
        }
      >
        {documentView}
      </div>
      {tab === 'diagram' && (
        <div
          data-testid="plan-panel-diagram-body"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <Suspense
            fallback={
              <LoadingPlaceholder label="Loading diagram…" className="flex-1" />
            }
          >
            <PlanVisualizer
              ref={diagramRef}
              plan={plan}
              onAddNodeComment={onAddNodeComment}
              revealNodeRequest={revealRequest}
              onSearchContextChange={onDiagramSearchContextChange}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * A tracked plan's document panel: the shared plan header with its
 * follow-up actions, Document and Diagram tabs (Diagram only while the
 * diagram is not split into its own panel), and the plan document with its
 * comments. Follow-ups keep the panel open and bring up where they led:
 * Implement the owning chat, a started pipeline the worktree's runs. Comments are created and staged in shared storage here, and
 * **Submit N comments** hands the pending ones to the ordinary chat of the
 * worktree that owns the plan, then brings that chat forward. Submitting stays
 * available while an older revision is shown, since drafts belong to the
 * latest one; the submission tells the agent which revision was on screen.
 * Pointer or focus inside the panel makes its plan the worktree's active plan.
 * Read-only recipients can read comments but not submit them. Cmd/Ctrl+F
 * opens the shared find bar on the shown tab: plan mode over the document,
 * diagram mode over the joined Diagram tab.
 */
export const PlanPanelView = memo(function PlanPanelView({
  plan,
  readOnly,
  isVisible,
  onActivate,
}: PlanPanelViewProps): JSX.Element {
  const { projectId, worktreeId, id: planId } = plan;
  const viewKey = planViewKey(projectId, worktreeId, planId);
  const [viewedRevision, setViewedRevision] = useState<number | null>(null);
  // Choosing the latest revision by number is still reading the latest.
  const viewedOlderRevision =
    viewedRevision === plan.latestRevisionNumber ? null : viewedRevision;
  useRecordViewedRevision(plan, viewedOlderRevision, readOnly);
  const comments = usePlanComments(plan);
  const submitComments = usePlanPanelCommentSubmit(
    plan,
    comments.submit,
    viewedOlderRevision,
  );
  useSharedPlanCommentPull(plan);
  const actions = usePlanPanelActions(plan);
  const followUps = usePlanFollowUpActions(plan, {
    viewedRevision,
    onImplemented: actions.revealChat,
    onPipelineStarted: actions.revealRuns,
  });
  const worktreeKey = `${projectId}/${worktreeId}`;
  const split = useIsPlanDiagramSplit(worktreeKey, planId);
  const diagramOnScreen = useIsPlanPanelOnScreen(
    worktreeKey,
    'plan-diagram',
    planId,
  );
  const innerTab = usePlanViewStore(
    (state) => state.entries[viewKey]?.innerTab ?? 'document',
  );
  const combined = !readOnly && !split;
  const tab: PlanViewInnerTab = combined ? innerTab : 'document';
  // The Diagram tab mounts the visualizer on demand; with its code loaded
  // ahead, the first switch shows the diagram without a loading pause.
  useEffect(() => {
    if (combined) void preloadPlanVisualizer();
  }, [combined]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const diagramRef = useRef<DiagramSearchHandle | null>(null);
  // One find surface at a time, for the shown tab: switching tabs closes an
  // open bar, as hiding any panel does. The comments tray is not searched.
  const planFind = useDomTextFind({
    mode: 'plan',
    enabled: isVisible && tab === 'document',
    scopeKey: viewKey,
    title: planPanelTitle(plan),
    rootRef,
    contentSelector: PLAN_DOCUMENT_FIND_SELECTOR,
    visibleOnly: true,
  });
  const diagramFind = useDiagramFind({
    enabled: isVisible && combined && tab === 'diagram',
    scopeKey: viewKey,
    title: planDiagramPanelTitle(plan),
    rootRef,
    handleRef: diagramRef,
  });

  const locked = readOnly || viewedRevision !== null;
  const documentView = (
    <PlanDocumentPanel
      plan={plan}
      displayContent={viewedPlanContent(plan, viewedRevision)}
      readOnly={locked}
      threads={comments.threads}
      stagedCount={comments.stagedCount}
      addDocumentComment={comments.addDocumentComment}
      addReply={comments.addReply}
      editStagedComment={comments.editStagedComment}
      deleteStagedComment={comments.deleteStagedComment}
      toggleResolved={comments.toggleResolved}
      onSubmit={readOnly ? undefined : submitComments}
      onRevealDiagramNode={readOnly ? undefined : actions.revealDiagramNode}
    />
  );

  return (
    <div
      ref={rootRef}
      data-testid="plan-panel-view"
      data-plan-id={planId}
      data-plan-inner-tab={tab}
      {...planFind.surfaceProps}
      {...diagramFind.surfaceProps}
      // The plan header (title, revision, actions) and tabs are recorded; the
      // document panel and the visualizer block the plan and its diagrams.
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none"
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <style>{planFind.highlightStyle}</style>
      <PlanViewHeader
        plan={plan}
        actions={followUps}
        viewedRevision={viewedRevision}
        onViewedRevisionChange={setViewedRevision}
        readOnly={readOnly}
        testIdPrefix="plan-panel"
        responsive
        onOpenExecution={actions.openExecution}
      />
      <RailTabBar
        tabs={combined ? DOCUMENT_AND_DIAGRAM_TABS : DOCUMENT_TABS}
        activeTab={tab}
        onTabChange={actions.selectTab}
        actions={
          readOnly ? undefined : (
            <PlanPanelSplitAction
              split={split}
              diagramOnScreen={diagramOnScreen}
              onSplit={actions.split}
              onShowDiagram={actions.showDiagram}
            />
          )
        }
      />
      <PlanPanelBody
        plan={plan}
        tab={tab}
        diagramRef={diagramRef}
        documentView={documentView}
        onAddNodeComment={comments.addNodeComment}
        onDiagramSearchContextChange={diagramFind.refresh}
      />
    </div>
  );
});
