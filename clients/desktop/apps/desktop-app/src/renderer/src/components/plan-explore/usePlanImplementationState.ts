import { useMemo } from 'react';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  resolvePlanDisplayStatus,
  type PlanDisplayStatus,
  type PlanExecutionEvidence,
  type PlanExecutionOutcome,
} from '@canopy/ui-shared/lib';
import { useChatStore } from '@/stores/chatStore';
import type { ChatState } from '@/stores/chat/state';
import type { ChatTab } from '@/stores/chat/types';
import { hasPendingTrackedPlanReview } from '@/stores/chat/plan-utils';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { planLinkedExecutionIds } from '@/lib/plans/linked-executions';

/** A navigation target beside the status: a pipeline run or a chat. */
export type PlanStatusNoteTarget =
  | { readonly kind: 'run'; readonly executionId: string }
  | { readonly kind: 'chat'; readonly chatId: string };

export interface PlanStatusNoteModel {
  /** Outcome text, for example `Workflow failed`. */
  readonly text?: string;
  readonly linkLabel: 'View run' | 'View chat';
  readonly target: PlanStatusNoteTarget;
}

export interface PlanImplementationState {
  readonly status: PlanDisplayStatus;
  readonly notes: readonly PlanStatusNoteModel[];
  /** Relevant root attempt to open, independently of the review label. */
  readonly navigationExecutionId?: string;
  /** The plan's chat is revising it; Execute waits for the new revision. */
  readonly revising: boolean;
}

function pipelineOutcome(
  status: ExecutionSummary['status'],
): PlanExecutionOutcome | null {
  switch (status) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'active';
    case 'success':
      return 'succeeded';
    case 'failure':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Pipeline attempts for a plan: its persisted links plus live summaries that
 * reference it, each once. Nested runs contribute through their root's
 * outcome. A run whose summary is not loaded contributes no evidence, so it
 * cannot manufacture a status.
 */
export function collectPlanPipelineEvidence(
  plan: Pick<
    TrackedPlanData,
    'id' | 'projectId' | 'worktreeId' | 'linkedExecutionIds'
  >,
  summaries: readonly ExecutionSummary[],
): PlanExecutionEvidence[] {
  const ids = planLinkedExecutionIds(plan, summaries);
  const evidence: PlanExecutionEvidence[] = [];
  for (const summary of summaries) {
    if (summary.parent_execution_id || !ids.has(summary.id)) continue;
    const outcome = pipelineOutcome(summary.status);
    if (!outcome) continue;
    evidence.push({
      kind: 'pipeline',
      id: summary.id,
      outcome,
      startedAt: summary.started_at,
    });
  }
  return evidence;
}

/** Notes beside the status: the latest failed attempt, the run, or the chat. */
export function buildPlanStatusNotes(
  status: PlanDisplayStatus,
  chatId: string | undefined,
): PlanStatusNoteModel[] {
  const notes: PlanStatusNoteModel[] = [];
  const failed = status.latestUnsuccessful;
  if (failed?.kind === 'pipeline') {
    notes.push({
      text:
        failed.outcome === 'cancelled'
          ? 'Workflow cancelled'
          : 'Workflow failed',
      linkLabel: 'View run',
      target: { kind: 'run', executionId: failed.id },
    });
  }
  if (
    status.selected?.kind === 'pipeline' &&
    status.selected.id !== failed?.id
  ) {
    notes.push({
      linkLabel: 'View run',
      target: { kind: 'run', executionId: status.selected.id },
    });
  }
  if (chatId && status.kind === 'approved') {
    notes.push({ linkLabel: 'View chat', target: { kind: 'chat', chatId } });
  }
  return notes;
}

function currentRevisionCreatedAt(plan: TrackedPlanData): string | undefined {
  return plan.revisions.find(
    (revision) => revision.revisionNumber === plan.latestRevisionNumber,
  )?.createdAt;
}

/** Execute's tooltip while the plan's chat works on a revision (CAN-5431). */
export const PLAN_REVISING_EXECUTE_TITLE = 'The agent is revising this plan.';

type PlanRef = Pick<TrackedPlanData, 'id' | 'projectId' | 'worktreeId'>;

/**
 * The open chat tracking this plan in its worktree, chosen by newest
 * creation then id so collection order never decides.
 */
function selectPlanChat(
  state: Pick<ChatState, 'worktreeChats'>,
  plan: PlanRef,
): ChatTab | undefined {
  let chosen: ChatTab | undefined;
  for (const tab of state.worktreeChats[`${plan.projectId}/${plan.worktreeId}`]
    ?.tabs ?? []) {
    if (tab.trackedPlanId !== plan.id) continue;
    if (
      !chosen ||
      tab.createdAt > chosen.createdAt ||
      (tab.createdAt === chosen.createdAt && tab.id > chosen.id)
    ) {
      chosen = tab;
    }
  }
  return chosen;
}

/**
 * Whether the plan's chat is revising it: the review is still pending, its
 * request was retired by an accepted or optimistic turn, and that turn is
 * still in flight (starting, streaming, or paused on a tool approval). A fresh
 * plan request ends it, even while the turn's cleanup runs.
 */
export function selectPlanRevisionInProgress(
  state: Pick<ChatState, 'worktreeChats'>,
  plan: PlanRef,
): boolean {
  const tab = selectPlanChat(state, plan);
  return (
    tab !== undefined &&
    hasPendingTrackedPlanReview(tab) &&
    tab.pendingPlanExit === undefined &&
    (tab.status === 'streaming' || tab.sendingLease?.state === 'pending')
  );
}

/**
 * Execute's availability for the plan's controls, shared by the plan header
 * and the Activity Plans card. An existing restriction keeps its own
 * explanation; revising adds its title only when it is the sole reason.
 */
export function planExecuteAvailability(
  plan: Pick<TrackedPlanData, 'source'>,
  implementation: Pick<PlanImplementationState, 'revising'>,
): { executeDisabled: boolean; executeTitle?: string } {
  if (isCursorPlanExecutionUnavailable(plan)) return { executeDisabled: true };
  return implementation.revising
    ? { executeDisabled: true, executeTitle: PLAN_REVISING_EXECUTE_TITLE }
    : { executeDisabled: false };
}

/**
 * The plan chat's id. Selectors return primitives so streaming updates
 * elsewhere in the chat store do not re-render callers.
 */
function usePlanChatId(plan: TrackedPlanData): string | undefined {
  return useChatStore((state) => selectPlanChat(state, plan)?.id);
}

/**
 * The plan's display status and navigation notes, shared by the plan header
 * and the Activity Plans card so both surfaces apply the same rules.
 *
 * Only linked pipeline runs provide execution evidence. A chat
 * implementation has no reliable turn linkage or terminal outcome yet, so it
 * keeps the plan Approved and offers View chat instead of a guessed state.
 */
export function usePlanImplementationState(
  plan: TrackedPlanData,
): PlanImplementationState {
  const summaries = usePipelineRunsStore((state) => state.summaries);
  const chatId = usePlanChatId(plan);
  const revising = useChatStore((state) =>
    selectPlanRevisionInProgress(state, plan),
  );
  return useMemo((): PlanImplementationState => {
    const executionStatus = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      currentRevisionNumber: plan.latestRevisionNumber,
      currentRevisionCreatedAt: currentRevisionCreatedAt(plan),
      evidence: collectPlanPipelineEvidence(plan, summaries),
    });
    const status =
      plan.reviewStatus === 'approved'
        ? executionStatus
        : resolvePlanDisplayStatus({ reviewStatus: plan.reviewStatus });
    const navigation =
      executionStatus.selected ?? executionStatus.latestUnsuccessful;
    return {
      status,
      notes: buildPlanStatusNotes(status, chatId),
      navigationExecutionId: navigation?.id,
      revising,
    };
  }, [plan, summaries, chatId, revising]);
}
