import { memo, Suspense, useCallback, useRef, type JSX } from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { useDiagramFind, type DiagramSearchHandle } from '@canopy/ui-app/find';
import { HeaderActionButton } from '@canopy/ui-shared';
import { LazyPlanVisualizerPanel } from '@/components/plan-explore/lazyPlanVisualizer';
import { usePlanComments } from '@/components/plan-explore/usePlanComments';
import { usePlanDiagramRevealRequest } from '@/components/plan-explore/usePlanDiagramRevealRequest';
import { useSharedPlanCommentPull } from '@/components/plan-explore/usePlanViewData';
import { LoadingPlaceholder } from '@/components/shared/StatusBlocks';
import {
  planDiagramPanelTitle,
  useIsPlanPanelOnScreen,
} from '@/lib/panels/plan-panel-identity';
import { openPlanPanel } from '@/lib/panels/plan-panel-open';
import { planViewKey } from '@/stores/planViewStore';

export interface PlanDiagramPanelViewProps {
  /** The latest tracked plan. */
  readonly plan: TrackedPlanData;
  /** Read-only scopes cannot comment on diagram nodes. */
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

/**
 * A tracked plan's diagram split into its own panel; Cmd/Ctrl+F opens the
 * shared find bar in diagram mode over the shown diagram. Node comments go
 * to the same shared comment store as the document's, so drafts survive a
 * split or a merge. Closing this panel is the merge: the document panel
 * shows its Diagram tab again. **Show document** appears while the plan's
 * document is off screen. Pointer or focus inside it makes its plan the
 * worktree's active plan.
 */
export const PlanDiagramPanelView = memo(function PlanDiagramPanelView({
  plan,
  readOnly,
  isVisible,
  onActivate,
}: PlanDiagramPanelViewProps): JSX.Element {
  const { projectId, worktreeId, id: planId } = plan;
  const comments = usePlanComments(plan);
  useSharedPlanCommentPull(plan);
  const viewKey = planViewKey(projectId, worktreeId, planId);
  const revealRequest = usePlanDiagramRevealRequest(viewKey, true);
  const documentOnScreen = useIsPlanPanelOnScreen(
    `${projectId}/${worktreeId}`,
    'plan',
    planId,
  );
  const showDocument = useCallback((): void => {
    void openPlanPanel({ projectId, worktreeId }, planId, { intent: 'auto' });
  }, [projectId, worktreeId, planId]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const diagramRef = useRef<DiagramSearchHandle | null>(null);
  const find = useDiagramFind({
    enabled: isVisible,
    scopeKey: viewKey,
    title: planDiagramPanelTitle(plan),
    rootRef,
    handleRef: diagramRef,
  });

  return (
    <div
      ref={rootRef}
      data-testid="plan-diagram-panel-view"
      data-plan-id={planId}
      {...find.surfaceProps}
      // The toolbar is recorded; the visualizer blocks its diagrams.
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none"
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      {/* Only while Show document is needed; otherwise the visualizer's own
          toolbar is the panel's first row. */}
      {!documentOnScreen && (
        <div
          data-testid="plan-diagram-panel-top-row"
          className="electron-no-drag flex shrink-0 items-center justify-end gap-2 border-b px-4 py-2"
        >
          <HeaderActionButton
            tone="neutral"
            data-testid="plan-diagram-show-document"
            onClick={showDocument}
          >
            Show document
          </HeaderActionButton>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Suspense
          fallback={
            <LoadingPlaceholder label="Loading diagram…" className="flex-1" />
          }
        >
          <LazyPlanVisualizerPanel
            ref={diagramRef}
            plan={plan}
            onAddNodeComment={readOnly ? undefined : comments.addNodeComment}
            revealNodeRequest={revealRequest}
            onSearchContextChange={find.refresh}
          />
        </Suspense>
      </div>
    </div>
  );
});
