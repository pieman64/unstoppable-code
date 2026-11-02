'use client';

import { memo, useCallback, useMemo, useState, type JSX } from 'react';
import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import {
  PipelineRunTreeRow,
  type PipelineRunExecutionState,
  type PipelineRunRenderSlot,
  type PipelineRunSummary,
  type PipelineRunTreeRowProps,
} from '../activity/pipeline/PipelineRunRows';
import {
  pipelineRunReceiptView,
  type PipelineRunReceiptLiveOverride,
} from './pipeline-run-receipt';

/**
 * The run actions a host can perform. An absent action renders no control
 * (row clicks without `onOpenDetail` do nothing).
 */
export type PipelineRunReceiptActions = Partial<
  Pick<
    PipelineRunTreeRowProps,
    | 'onOpenDetail'
    | 'onCancel'
    | 'onResume'
    | 'onRetry'
    | 'onRerun'
    | 'onOpenPlan'
    | 'onChatFollowUp'
    | 'onReportChatFollowUp'
    | 'onViewReport'
    | 'onPipelineFollowUp'
    | 'onDebugFailure'
    | 'onOpenSource'
  >
>;

export interface PipelineRunReceiptPending {
  readonly cancellingId?: string | null;
  readonly resumingId?: string | null;
  readonly debuggingFailureId?: string | null;
  readonly retryingIds?: ReadonlySet<string>;
  readonly rerunningIds?: ReadonlySet<string>;
  readonly mutatingPendingIds?: ReadonlySet<string>;
}

export interface PipelineRunReceiptCardProps {
  readonly receipt: PipelineRunArtifactReceiptV1;
  /** The host's run summaries; the receipt snapshot stands in without them. */
  readonly summaries?: readonly PipelineRunSummary[];
  readonly statesById?: Readonly<
    Record<string, PipelineRunExecutionState | undefined>
  >;
  readonly liveOverride?: PipelineRunReceiptLiveOverride;
  /** Controlled sub-pipeline expansion; uncontrolled internal state when omitted. */
  readonly expandedIds?: ReadonlySet<string>;
  readonly onToggleExpand?: (executionId: string) => void;
  /** Must be memoized by the host, or the card re-renders on every update. */
  readonly actions?: PipelineRunReceiptActions;
  /** Must be memoized by the host, or the card re-renders on every update. */
  readonly pending?: PipelineRunReceiptPending;
  readonly renderAdvisorBadge?: PipelineRunRenderSlot;
  readonly renderWatcherButton?: PipelineRunRenderSlot;
}

const EMPTY_SUMMARIES: readonly PipelineRunSummary[] = [];
const EMPTY_STATES: Readonly<
  Record<string, PipelineRunExecutionState | undefined>
> = {};
const EMPTY_IDS: ReadonlySet<string> = new Set();
const NO_ACTIONS: PipelineRunReceiptActions = {};
const NO_PENDING: PipelineRunReceiptPending = {};
const ROOT_CHAIN: PipelineRunTreeRowProps['parentChain'] = [];
const ignoreOpenDetail: PipelineRunTreeRowProps['onOpenDetail'] = () =>
  undefined;
const ignoreOpenSource: PipelineRunTreeRowProps['onOpenSource'] = () =>
  undefined;

function toggled(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * One `pipeline_run` receipt as the shared run row, with the host's live run
 * state overlaid on the receipt snapshot. Hosts own the transport and supply
 * only the actions they can perform.
 */
export const PipelineRunReceiptCard = memo(function PipelineRunReceiptCard({
  receipt,
  summaries = EMPTY_SUMMARIES,
  statesById = EMPTY_STATES,
  liveOverride,
  expandedIds,
  onToggleExpand,
  actions = NO_ACTIONS,
  pending = NO_PENDING,
  renderAdvisorBadge,
  renderWatcherButton,
}: PipelineRunReceiptCardProps): JSX.Element {
  // The tree build walks every summary the host has, so it runs only when
  // the receipt, the summaries or the live overlay change.
  const view = useMemo(
    () => pipelineRunReceiptView(receipt, summaries, liveOverride),
    [liveOverride, receipt, summaries],
  );
  const [localExpandedIds, setLocalExpandedIds] =
    useState<ReadonlySet<string>>(EMPTY_IDS);
  const controlled = expandedIds !== undefined;
  const handleToggleExpand = useCallback(
    (executionId: string): void => {
      if (!controlled)
        setLocalExpandedIds((current) => toggled(current, executionId));
      onToggleExpand?.(executionId);
    },
    [controlled, onToggleExpand],
  );
  return (
    <PipelineRunTreeRow
      node={view.node}
      expandedIds={expandedIds ?? localExpandedIds}
      onToggleExpand={handleToggleExpand}
      statesById={statesById}
      cancellingId={pending.cancellingId ?? null}
      resumingId={pending.resumingId ?? null}
      onOpenDetail={actions.onOpenDetail ?? ignoreOpenDetail}
      onCancel={actions.onCancel}
      onResume={actions.onResume}
      onChatFollowUp={actions.onChatFollowUp}
      onReportChatFollowUp={actions.onReportChatFollowUp}
      onViewReport={actions.onViewReport}
      onPipelineFollowUp={actions.onPipelineFollowUp}
      onOpenPlan={actions.onOpenPlan}
      onRetry={actions.onRetry}
      onRerun={actions.onRerun}
      onDebugFailure={actions.onDebugFailure}
      chatFollowUpDisabled={false}
      retryingIds={pending.retryingIds ?? EMPTY_IDS}
      rerunningIds={pending.rerunningIds ?? EMPTY_IDS}
      mutatingPendingIds={pending.mutatingPendingIds}
      debuggingFailureId={pending.debuggingFailureId ?? null}
      summaryLookup={view.summaryLookup}
      onOpenSource={actions.onOpenSource ?? ignoreOpenSource}
      parentChain={ROOT_CHAIN}
      renderAdvisorBadge={renderAdvisorBadge}
      renderWatcherButton={renderWatcherButton}
    />
  );
});
