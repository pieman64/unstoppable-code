import { useMemo, useSyncExternalStore } from 'react';
import {
  beginPlanDispatch,
  hasPendingTrackedPlanReview,
  isPlanDispatching,
  subscribePlanDispatch,
} from '@/stores/chat/plan-utils';
import type {
  ChatRuntimeState,
  PersistedChatTab,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  resolvePlanDisplayStatus,
  type PlanDisplayStatus,
  type PlanExecutionEvidence,
  type PlanExecutionOutcome,
} from '@canopy/ui-shared/lib';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { chatRuntimeStatusToTabStatus } from '@/stores/chat/canonical-changes';
import type { ChatState } from '@/stores/chat/state';
import type { ChatTab } from '@/stores/chat/types';
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
  readonly dispatchInFlight: boolean;
  readonly status: PlanDisplayStatus;
  readonly notes: readonly PlanStatusNoteModel[];
  /**
   * The selected attempt Open navigates to, present exactly when the status
   * offers Open instead of Execute.
   */
  readonly openTarget?: PlanStatusNoteTarget;
  /** Relevant root attempt to open, independently of the review label. */
  readonly navigationExecutionId?: string;
  /** The plan's chat is revising it; Execute waits for the new revision. */
  readonly revising: boolean;
}

/** One chat attempt's evidence and the chat that owns it. */
export interface PlanChatAttempt {
  readonly evidence: PlanExecutionEvidence;
  readonly chatId: string;
}

type PlanChatEvidenceTab = Pick<
  PersistedChatTab,
  | 'id'
  | 'trackedPlanId'
  | 'trackedPlanImplementation'
  | 'turnEnds'
  | 'unacceptedTurnEnds'
>;

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

function chatOutcome(
  outcome: 'completed' | 'failed' | 'cancelled',
): PlanExecutionOutcome {
  return outcome === 'completed' ? 'succeeded' : outcome;
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

/**
 * The chat attempt a tab's implementation link records for `plan`, or
 * `null`. Terminal facts come from the main-settled link, then the matching
 * turn end, then a matching unaccepted end. Otherwise the attempt is active
 * only while live runtime runs or queues that exact user message. Idle
 * state, assistant text, or another turn's completion never yield evidence.
 */
export function collectPlanChatEvidence(
  plan: Pick<TrackedPlanData, 'id'>,
  tab: PlanChatEvidenceTab,
  runtime: ChatRuntimeState | undefined,
): PlanChatAttempt | null {
  const link = tab.trackedPlanImplementation;
  if (!link || link.planId !== plan.id || tab.trackedPlanId !== plan.id) {
    return null;
  }
  const attempt = {
    kind: 'chat' as const,
    id: `${tab.id}:${link.userMessageId}`,
    startedAt: link.startedAt,
    revisionNumber: link.revisionNumber,
  };
  const ended = (
    outcome: PlanExecutionOutcome,
    endedAt?: string,
  ): PlanChatAttempt => ({
    chatId: tab.id,
    evidence: { ...attempt, outcome, ...(endedAt ? { endedAt } : {}) },
  });
  if (link.outcome) return ended(chatOutcome(link.outcome), link.endedAt);
  const turnEnd = tab.turnEnds?.[link.userMessageId];
  if (turnEnd) {
    return ended(
      chatOutcome(turnEnd.outcome),
      new Date(turnEnd.endedAt).toISOString(),
    );
  }
  const unaccepted = tab.unacceptedTurnEnds?.[link.userMessageId];
  if (unaccepted) return ended(unaccepted);
  const running =
    runtime !== undefined &&
    runtime.activeTurn?.userMessageId === link.userMessageId &&
    chatRuntimeStatusToTabStatus(runtime) === 'streaming';
  const queued =
    runtime?.queuedMessages?.some(
      (entry) => entry.request.userMessageId === link.userMessageId,
    ) === true;
  return running || queued ? ended('active') : null;
}

/** Notes beside the status: the latest failed attempt, or the chat. */
export function buildPlanStatusNotes(
  status: PlanDisplayStatus,
  chatId: string | undefined,
  chatAttempts: readonly PlanChatAttempt[] = [],
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
  const failedChatId =
    failed?.kind === 'chat'
      ? chatAttempts.find((attempt) => attempt.evidence.id === failed.id)
          ?.chatId
      : undefined;
  if (failed && failedChatId) {
    notes.push({
      text: failed.outcome === 'cancelled' ? 'Chat stopped' : 'Chat failed',
      linkLabel: 'View chat',
      target: { kind: 'chat', chatId: failedChatId },
    });
  }
  // Open already navigates to the selected attempt, so it gets no note.
  if (chatId && status.kind === 'approved' && chatId !== failedChatId) {
    notes.push({ linkLabel: 'View chat', target: { kind: 'chat', chatId } });
  }
  return notes;
}

/** Where Open goes for the selected attempt; never another chat or run. */
function openTargetFor(
  status: PlanDisplayStatus,
  chatAttempts: readonly PlanChatAttempt[],
): PlanStatusNoteTarget | undefined {
  const selected = status.selected;
  if (status.primaryAction !== 'open' || !selected) return undefined;
  if (selected.kind === 'pipeline') {
    return { kind: 'run', executionId: selected.id };
  }
  const chatId = chatAttempts.find(
    (attempt) => attempt.evidence.id === selected.id,
  )?.chatId;
  return chatId ? { kind: 'chat', chatId } : undefined;
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
 * and the Activity Plans card. An existing restriction, a dispatch in flight
 * or an active implementation keeps its own explanation; revising adds its
 * title only when it is the sole reason.
 */
export function planExecuteAvailability(
  plan: Pick<TrackedPlanData, 'source'>,
  implementation: Pick<
    PlanImplementationState,
    'revising' | 'dispatchInFlight'
  > & { readonly status: Pick<PlanDisplayStatus, 'kind'> },
): { executeDisabled: boolean; executeTitle?: string } {
  if (
    isCursorPlanExecutionUnavailable(plan) ||
    implementation.dispatchInFlight ||
    implementation.status.kind === 'implementing'
  ) {
    return { executeDisabled: true };
  }
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

function collectWorktreePlanChatAttempts(
  state: ReturnType<typeof useChatStore.getState>,
  plan: TrackedPlanData,
): PlanChatAttempt[] {
  const attempts: PlanChatAttempt[] = [];
  for (const tab of state.worktreeChats[`${plan.projectId}/${plan.worktreeId}`]
    ?.tabs ?? []) {
    const attempt = collectPlanChatEvidence(
      plan,
      tab,
      state.runtimeByChatId[tab.id],
    );
    if (attempt) attempts.push(attempt);
  }
  return attempts;
}

/** Every field an attempt contributes, so equal keys mean equal attempts. */
function attemptKey({ chatId, evidence }: PlanChatAttempt): string {
  return [
    chatId,
    evidence.id,
    evidence.outcome,
    evidence.startedAt,
    evidence.endedAt ?? '',
    evidence.revisionNumber ?? '',
  ].join('\u0000');
}

/**
 * Chat attempts for the plan across its worktree's loaded tabs. The selector
 * returns a primitive key, so streaming updates that leave every attempt
 * unchanged do not re-render callers.
 */
function usePlanChatAttempts(plan: TrackedPlanData): PlanChatAttempt[] {
  const key = useChatStore((state) =>
    collectWorktreePlanChatAttempts(state, plan).map(attemptKey).join('\n'),
  );
  return useMemo(
    (): PlanChatAttempt[] =>
      key ? collectWorktreePlanChatAttempts(useChatStore.getState(), plan) : [],
    // The key captures every attempt field; `plan` identity selects them.
    [key, plan],
  );
}

/**
 * The plan's display status, navigation notes and Open target, shared by
 * the plan header and the Activity Plans card so both surfaces apply the
 * same rules.
 *
 * Linked pipeline runs and linked chat implementation turns provide
 * execution evidence. A chat that merely tracks the plan, without a linked
 * turn or a known outcome, keeps it Approved and offers View chat instead
 * of a guessed state.
 */
export function usePlanImplementationState(
  plan: TrackedPlanData,
): PlanImplementationState {
  const dispatchInFlight = useSyncExternalStore(subscribePlanDispatch, () =>
    isPlanDispatching(plan),
  );
  const summaries = usePipelineRunsStore((state) => state.summaries);
  const chatId = usePlanChatId(plan);
  const chatAttempts = usePlanChatAttempts(plan);
  const revising = useChatStore((state) =>
    selectPlanRevisionInProgress(state, plan),
  );
  return useMemo((): PlanImplementationState => {
    const executionStatus = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      currentRevisionNumber: plan.latestRevisionNumber,
      currentRevisionCreatedAt: currentRevisionCreatedAt(plan),
      evidence: [
        ...collectPlanPipelineEvidence(plan, summaries),
        ...chatAttempts.map((attempt) => attempt.evidence),
      ],
    });
    const status =
      plan.reviewStatus === 'approved'
        ? executionStatus
        : resolvePlanDisplayStatus({ reviewStatus: plan.reviewStatus });
    const navigation =
      executionStatus.selected ?? executionStatus.latestUnsuccessful;
    const openTarget = openTargetFor(status, chatAttempts);
    return {
      dispatchInFlight,
      status,
      notes: buildPlanStatusNotes(status, chatId, chatAttempts),
      ...(openTarget ? { openTarget } : {}),
      navigationExecutionId:
        navigation?.kind === 'pipeline' ? navigation.id : undefined,
      revising,
    };
  }, [plan, summaries, chatId, chatAttempts, dispatchInFlight, revising]);
}

/** Recheck live evidence when an already-open execution dialog confirms. */
export function beginPlanWorkflowDispatch(
  plan: TrackedPlanData,
): (() => void) | undefined {
  const currentPlan =
    useActivityStore
      .getState()
      .trackedPlans[
        `${plan.projectId}/${plan.worktreeId}`
      ]?.find((candidate) => candidate.id === plan.id) ?? plan;
  const active =
    resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      currentRevisionNumber: currentPlan.latestRevisionNumber,
      currentRevisionCreatedAt: currentRevisionCreatedAt(currentPlan),
      evidence: [
        ...collectPlanPipelineEvidence(
          currentPlan,
          usePipelineRunsStore.getState().summaries,
        ),
        ...collectWorktreePlanChatAttempts(
          useChatStore.getState(),
          currentPlan,
        ).map((attempt) => attempt.evidence),
      ],
    }).kind === 'implementing';
  return active ? undefined : beginPlanDispatch(currentPlan);
}
