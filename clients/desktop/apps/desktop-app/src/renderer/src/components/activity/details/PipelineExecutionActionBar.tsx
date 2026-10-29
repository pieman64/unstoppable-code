import type { JSX, ReactNode } from 'react';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import {
  ChatIcon,
  PipelineIcon,
  PlanModeIcon,
  RerunIcon,
  RetryIcon,
} from '@canopy/ui-shared/icons';
import { FileIcon as AppCatalogFileIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  canRetryExecution,
  canRerunExecution,
  hasRerunReplayData,
} from '@/lib/execution-actions';
import { WatcherManagementButton } from '@/components/watchers/WatcherManagementButton';
import { isPipelineExecutionActiveStatus } from '../utils';
import type { PipelineExecutionActions } from '../usePipelineExecutionActions';
import type { PipelineDetailDestination } from './pipelineDetailTypes';

function ReportIcon(): JSX.Element {
  return <AppCatalogFileIcon width="14" height="14" aria-hidden="true" />;
}

/**
 * Live run actions above the detail body: watchers, retry, start over,
 * debug, plan and report follow-ups, and cancel. Every command goes through
 * the shared execution-action controller for the run shown. Opening another
 * surface reports it through `onNavigatedAway`; closing is the host's call.
 * A host that shows the report inline handles View Report itself
 * (`onViewReport`), so it neither opens the dialog nor navigates away.
 * Archived runs never render this bar.
 *
 * `leading` is a full-height cell before the actions (a panel's job-list
 * toggle). With it, the bar always renders so the cell keeps its place, and
 * the actions wrap beside it at narrow widths. The leading cell draws its own
 * share of the bar's bottom rule, so a hover target it owns reaches the edge
 * of the content below with no gap.
 */
export function PipelineExecutionActionBar({
  executionId,
  state,
  summary,
  actions,
  watchers,
  onNavigatedAway,
  onViewReport,
  leading,
}: {
  executionId: string;
  state: ExecutionState;
  summary?: ExecutionSummary;
  actions: PipelineExecutionActions;
  watchers: AppAdvisorWatcherSummary[];
  onNavigatedAway?: (destination: PipelineDetailDestination) => void;
  /**
   * Shows the report in place of opening the report dialog. Hosts that
   * render the report inline (a panel's Summary) supply it; without it,
   * View Report opens the dialog through the controller.
   */
  onViewReport?: () => void;
  leading?: ReactNode;
}): JSX.Element | null {
  const canPlanFollowUp =
    summary?.has_plan === true || state.plan_hash_after !== undefined;
  const canOpenTrackedPlan = Boolean(state.planId ?? summary?.planId);
  const canReportFollowUp = Boolean(
    state.report_outputs?.report_file || state.report_outputs?.report_json_file,
  );
  const canRetry = canRetryExecution(state);
  const canRerun = canRerunExecution(state) && hasRerunReplayData(state);
  const debugVisible = state.status === 'failure';
  const cancelVisible = isPipelineExecutionActiveStatus(state.status);
  const isRetrying = actions.retryingIds.has(executionId);
  const isRerunning = actions.rerunningIds.has(executionId);
  const isCancelling = actions.cancellingId === executionId;
  const chatFollowUpDisabled = actions.chatFollowUpInProgress;

  const hasFollowUpActions =
    canRetry ||
    canRerun ||
    debugVisible ||
    canPlanFollowUp ||
    canReportFollowUp ||
    cancelVisible;
  const hasWatcherIndicator = watchers.length > 0;
  // Watchers count as a reason to render the bar so the watcher icon has a
  // stable far-left anchor even on watched executions with no other actions.
  if (!hasFollowUpActions && !hasWatcherIndicator && leading === undefined) {
    return null;
  }

  const content = (
    <>
      {hasWatcherIndicator && (
        // Watcher indicator stays anchored far-left; `mr-auto` pushes the
        // follow-up action buttons to the right.
        <div className="mr-auto">
          <WatcherManagementButton
            watchers={watchers}
            modalTitle="Pipeline watchers"
            modalEmptyMessage="No active watchers for this pipeline."
            ariaLabel="Manage pipeline watchers"
            dataTestId={`pipeline-detail-watchers-${executionId}`}
          />
        </div>
      )}
      {canRetry && (
        <button
          type="button"
          data-testid={`pipeline-detail-retry-${executionId}`}
          onClick={() => void actions.retry(executionId)}
          disabled={isRetrying}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-line-attention/40 bg-warning-subtle px-2.5 py-1.5 text-2xs font-medium fg-warning transition hover:bg-warning-subtle/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RetryIcon width={13} height={13} />
          {isRetrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
      {canRerun && (
        <button
          type="button"
          data-testid={`pipeline-detail-rerun-${executionId}`}
          onClick={() => void actions.rerun(executionId)}
          disabled={isRerunning}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border bg-fg-primary/[0.04] px-2.5 py-1.5 text-2xs font-medium fg-primary/80 transition hover:bg-fg-primary/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RerunIcon width={13} height={13} />
          {isRerunning ? 'Starting over…' : 'Start over'}
        </button>
      )}
      {debugVisible && (
        <button
          type="button"
          data-testid={`pipeline-detail-debug-failure-${executionId}`}
          aria-label="Debug failed pipeline with App Advisor"
          onClick={() => {
            onNavigatedAway?.('debug');
            void actions.debugFailure(executionId);
          }}
          disabled={actions.debuggingFailureId !== null}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border bg-fg-primary/[0.04] px-2.5 py-1.5 text-2xs font-medium fg-primary/80 transition hover:bg-fg-primary/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChatIcon width={13} height={13} />
          {actions.debuggingFailureId === executionId ? 'Opening…' : 'Debug'}
        </button>
      )}
      {canPlanFollowUp && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xs font-medium fg-secondary">Plan</span>
          <button
            type="button"
            data-testid={`pipeline-detail-chat-follow-up-${executionId}`}
            disabled={chatFollowUpDisabled}
            onClick={() => {
              onNavigatedAway?.('chat');
              void actions.chatFollowUp(executionId);
            }}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-2xs font-medium fg-primary transition hover:bg-sky-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChatIcon width={13} height={13} />
            Chat
          </button>
          <button
            type="button"
            data-testid={`pipeline-detail-pipeline-follow-up-${executionId}`}
            onClick={() => {
              onNavigatedAway?.('pipeline-follow-up');
              void actions.pipelineFollowUp(executionId);
            }}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-2xs font-medium fg-primary transition hover:bg-sky-500/18"
          >
            <PipelineIcon width={13} height={13} />
            Pipeline
          </button>
          {canOpenTrackedPlan && (
            <button
              type="button"
              data-testid={`pipeline-detail-plan-${executionId}`}
              onClick={() => {
                onNavigatedAway?.('plan');
                void actions.openPlan(executionId);
              }}
              className="focus-ring inline-flex items-center gap-1.5 rounded-md border bg-fg-primary/[0.04] px-2.5 py-1.5 text-2xs font-medium fg-primary/80 transition hover:bg-fg-primary/[0.08]"
            >
              <PlanModeIcon width={13} height={13} />
              View plan
            </button>
          )}
        </div>
      )}
      {canReportFollowUp && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-3xs font-medium fg-secondary">Report</span>
          <button
            type="button"
            data-testid={`pipeline-detail-report-chat-follow-up-${executionId}`}
            disabled={chatFollowUpDisabled}
            onClick={() => {
              onNavigatedAway?.('report-chat');
              void actions.reportChatFollowUp(executionId);
            }}
            className="focus-ring rounded-md border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-2xs font-medium fg-primary transition hover:bg-sky-500/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Chat
          </button>
          <button
            type="button"
            data-testid={`pipeline-detail-view-report-${executionId}`}
            onClick={() => {
              if (onViewReport !== undefined) {
                onViewReport();
                return;
              }
              onNavigatedAway?.('report');
              actions.openReport(executionId);
            }}
            className="focus-ring inline-flex items-center gap-1.5 rounded-md border bg-fg-primary/[0.04] px-2.5 py-1.5 text-2xs font-medium fg-primary/80 transition hover:bg-fg-primary/[0.08]"
          >
            <ReportIcon />
            View report
          </button>
        </div>
      )}
      {cancelVisible && (
        <button
          type="button"
          data-testid={`pipeline-detail-cancel-${executionId}`}
          onClick={() => void actions.cancel(executionId)}
          disabled={isCancelling}
          className="focus-ring rounded-md border border-line-destructive px-2.5 py-1.5 text-2xs font-medium fg-destructive transition hover:bg-destructive-subtle disabled:cursor-wait disabled:opacity-60"
        >
          {isCancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
    </>
  );

  if (leading === undefined) {
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-b px-5 py-2">
        {content}
      </div>
    );
  }
  // The row's bottom rule is drawn by each cell rather than the row, so the
  // leading cell owns the rule beneath it (see `leading`).
  return (
    <div
      className="flex shrink-0 items-stretch"
      data-testid="pipeline-detail-toolbar"
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 border-b py-2 pl-2 pr-3">
        {content}
      </div>
    </div>
  );
}
