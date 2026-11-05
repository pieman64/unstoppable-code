import type {
  LedgerAgentAncestryState,
  LedgerAgentLiveState,
  LedgerLiveQuestion,
  LedgerLiveSnapshot,
  LedgerLiveStateSource,
  LedgerLiveWait,
} from '@canopy/app-core';
import { deriveChatWorkflowCapabilities } from '@canopy/app-core';
import { LEDGER_AGENT_WAIT_KINDS } from '@canopy/app-core';
import type { LedgerViewActorHost } from '@canopy/protocol/ledger-view';
import type {
  ApprovalRequestEvent,
  ChatIngestionLag,
} from '@canopy/desktop-shared/types';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { backgroundTaskCount } from '@canopy/desktop-shared/lib/background-work';
import {
  ledgerAgentIsResting,
  projectAgentLiveState,
} from '@canopy/app-state/ledger-feed';
import type { LedgerChatLiveInput } from '@canopy/app-state/ledger-feed';
import type { PendingPlanExit, PendingQuestion } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import {
  chatDelegationKey,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  liveBackgroundTaskKey,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import {
  INGESTION_LAG_STALE_AFTER_MS,
  useIngestionLagStore,
  visibleCatchingUpLag,
} from '@/stores/ingestionLagStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import {
  acquireSubagentTree,
  getSubagentTreeSnapshot,
  subscribeSubagentTree,
} from '@/components/subagents/subagent-tree-store';

export interface LedgerLiveStoreReader<State> {
  getState(): State;
  subscribe(listener: () => void): () => void;
}

export interface LedgerLiveChatTab {
  readonly id: string;
  readonly kind?: string;
  readonly status: string;
  readonly unread?: boolean;
  readonly interfaceMode?: string;
  readonly pendingPlanExit?: Record<string, unknown>;
  readonly pendingPlanExitRequestId?: string;
  /** Deliberately excluded from the live key: streaming text is not row state. */
  readonly messages?: readonly unknown[];
}

export interface LedgerLiveChatState {
  readonly worktreeChats: Readonly<
    Record<string, { readonly tabs: readonly LedgerLiveChatTab[] }>
  >;
  readonly pendingQuestions: Readonly<Record<string, PendingQuestion>>;
  readonly pendingPlanExits: Readonly<Record<string, PendingPlanExit>>;
  readonly pendingApprovals: Readonly<Record<string, ApprovalRequestEvent>>;
}

export interface LedgerLiveDelegationActivityState {
  readonly byChat: Readonly<
    Record<
      string,
      | {
          readonly projectId: string;
          readonly worktreeId: string;
          readonly chatId: string;
          readonly live: number;
          readonly queued: number;
        }
      | undefined
    >
  >;
}

export interface LedgerLiveProviderTaskState {
  readonly byChat: Readonly<
    Record<
      string,
      | {
          readonly projectId: string;
          readonly worktreeId: string;
          readonly chatId: string;
          readonly liveTasks: readonly { readonly taskType?: string }[];
        }
      | undefined
    >
  >;
}

export interface LedgerLiveIngestionLagState {
  readonly lagByChat: Readonly<
    Record<
      string,
      | {
          readonly projectId: string;
          readonly worktreeId: string;
          readonly chatId: string;
          readonly lag: ChatIngestionLag;
        }
      | undefined
    >
  >;
}

export type LedgerPipelineRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'success'
  | 'failure'
  | 'cancelled';

/** The store's run projection, normalized without deriving a live phase. */
export interface LedgerPipelineRunFact {
  readonly id: string;
  readonly name: string;
  readonly status: LedgerPipelineRunStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly projectId?: string;
  readonly worktreeId?: string;
}

export interface LedgerLivePipelineRunsState {
  readonly runsByWorktree: Readonly<
    Record<string, readonly LedgerPipelineRunFact[] | undefined>
  >;
  readonly currentRuns: readonly LedgerPipelineRunFact[];
  readonly statesById: Readonly<
    Record<string, LedgerPipelineRunFact | undefined>
  >;
  /** Store-owned rule: terminal failures in unseen, unselected worktrees. */
  readonly unseenFailedWorktreeKeys: ReadonlySet<string>;
}

export interface LedgerLiveDelegationTreeEntry {
  readonly snapshot: {
    readonly delegationId: string;
    readonly status: string;
  };
  readonly runGeneration: number;
  readonly sequence: number;
}

export interface LedgerLiveDelegationTreeSnapshot {
  readonly managedEntries: ReadonlyMap<string, LedgerLiveDelegationTreeEntry>;
}

export interface LedgerLiveDelegationTreeReader {
  getSnapshot(
    scope: { readonly projectId: string; readonly worktreeId: string } | null,
    rootChatId: string | null,
  ): LedgerLiveDelegationTreeSnapshot;
  subscribe(
    scope: { readonly projectId: string; readonly worktreeId: string },
    rootChatId: string,
    listener: () => void,
  ): () => void;
  acquire(
    scope: { readonly projectId: string; readonly worktreeId: string },
    rootChatId: string,
  ): () => void;
}

export interface LedgerLiveStateClock {
  now(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** Injectable renderer-store seam for deterministic tests. */
export interface LedgerLiveStateDependencies {
  readonly chatStore: LedgerLiveStoreReader<LedgerLiveChatState>;
  readonly delegationActivityStore: LedgerLiveStoreReader<LedgerLiveDelegationActivityState>;
  readonly liveBackgroundTaskStore: LedgerLiveStoreReader<LedgerLiveProviderTaskState>;
  readonly ingestionLagStore: LedgerLiveStoreReader<LedgerLiveIngestionLagState>;
  readonly pipelineRunsStore: LedgerLiveStoreReader<LedgerLivePipelineRunsState>;
  readonly delegationTreeStore: LedgerLiveDelegationTreeReader;
  readonly clock: LedgerLiveStateClock;
}

interface DelegationTreeSubscription {
  readonly scope: { readonly projectId: string; readonly worktreeId: string };
  readonly rootChatId: string;
  readonly unsubscribe: () => void;
  readonly release: () => void;
}

interface PendingPlanWait {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly toolInput: Record<string, unknown>;
}

const DEFAULT_DELEGATION_TREE_SNAPSHOT: LedgerLiveDelegationTreeSnapshot = {
  managedEntries: new Map(),
};

function defaultPipelineRunsState(): LedgerLivePipelineRunsState {
  const state = usePipelineRunsStore.getState();
  const runsByWorktree: Record<string, readonly LedgerPipelineRunFact[]> = {};
  for (const [key, runs] of Object.entries(state.pipelineSummariesByWorktree)) {
    runsByWorktree[key] = runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.completedAt === undefined
        ? {}
        : { completedAt: run.completedAt }),
    }));
  }
  const currentRuns = state.summaries.map((run: ExecutionSummary) => ({
    id: run.id,
    name: run.pipeline_name,
    status: run.status,
    ...(run.started_at === undefined ? {} : { startedAt: run.started_at }),
    ...(run.completed_at === undefined
      ? {}
      : { completedAt: run.completed_at }),
    ...(run.project_id === undefined ? {} : { projectId: run.project_id }),
    ...(run.worktree_id === undefined ? {} : { worktreeId: run.worktree_id }),
  }));
  const statesById: Record<string, LedgerPipelineRunFact> = {};
  for (const [id, run] of Object.entries(state.statesById)) {
    statesById[id] = {
      id,
      name: run.pipeline_snapshot.name,
      status: run.status,
      startedAt: run.started_at,
      ...(run.completed_at === undefined
        ? {}
        : { completedAt: run.completed_at }),
      projectId: run.project_id,
      worktreeId: run.worktree_id,
    };
  }
  for (const [id, row] of Object.entries(state.rowStatesById)) {
    if (statesById[id] !== undefined || row === undefined) continue;
    const run = currentRuns.find((candidate) => candidate.id === id);
    if (run !== undefined) statesById[id] = { ...run, status: row.status };
  }
  return {
    runsByWorktree,
    currentRuns,
    statesById,
    unseenFailedWorktreeKeys: state.unseenFailedPipelineWorktreeKeys,
  };
}

function defaultDependencies(): LedgerLiveStateDependencies {
  return {
    chatStore: {
      getState: () => useChatStore.getState(),
      subscribe: (listener) => useChatStore.subscribe(listener),
    },
    delegationActivityStore: {
      getState: () => useDelegationActivityStore.getState(),
      subscribe: (listener) => useDelegationActivityStore.subscribe(listener),
    },
    liveBackgroundTaskStore: {
      getState: () => useLiveBackgroundTaskStore.getState(),
      subscribe: (listener) => useLiveBackgroundTaskStore.subscribe(listener),
    },
    ingestionLagStore: {
      getState: () => useIngestionLagStore.getState(),
      subscribe: (listener) => useIngestionLagStore.subscribe(listener),
    },
    pipelineRunsStore: {
      getState: defaultPipelineRunsState,
      subscribe: (listener) => usePipelineRunsStore.subscribe(listener),
    },
    delegationTreeStore: {
      getSnapshot: (scope, rootChatId) =>
        scope === null || rootChatId === null
          ? DEFAULT_DELEGATION_TREE_SNAPSHOT
          : getSubagentTreeSnapshot(scope, rootChatId),
      subscribe: (scope, rootChatId, listener) =>
        subscribeSubagentTree(scope, rootChatId, listener),
      acquire: (scope, rootChatId) => acquireSubagentTree(scope, rootChatId),
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hostContentKey(
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
): string {
  return JSON.stringify(
    Object.keys(actorHosts)
      .sort(compareText)
      .map((actorId) => {
        const host = actorHosts[actorId];
        if (host === undefined) return [actorId];
        switch (host.kind) {
          case 'chat':
            return [
              actorId,
              host.kind,
              host.projectId,
              host.worktreeId,
              host.chatId,
            ];
          case 'delegation':
            return [
              actorId,
              host.kind,
              host.projectId,
              host.worktreeId,
              host.delegationId,
              host.rootChatId,
            ];
          case 'pipeline':
            return [
              actorId,
              host.kind,
              host.projectId,
              host.worktreeId,
              host.executionId,
            ];
        }
      }),
  );
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function chatStoreKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${worktreeKey(projectId, worktreeId)}/${chatId}`;
}

function planText(toolInput: Record<string, unknown>): string {
  return typeof toolInput.plan === 'string'
    ? toolInput.plan
    : JSON.stringify(toolInput, null, 2);
}

function planTitle(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  return (
    heading?.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') ??
    lines.find((line) => line.length > 0) ??
    ''
  );
}

function questionForWait(
  question: PendingQuestion['questions'][number],
): LedgerLiveQuestion {
  return {
    ...(question.id === undefined ? {} : { id: question.id }),
    ...(question.header === undefined ? {} : { header: question.header }),
    question: question.question,
    options: [...question.options],
    ...(question.optionDescriptions === undefined
      ? {}
      : { optionDescriptions: [...question.optionDescriptions] }),
    multiSelect: question.multiSelect ?? false,
    allowOther: question.allowOther !== false,
    secret: question.secret ?? false,
    ...(question.control === undefined ? {} : { control: question.control }),
    ...(question.required === undefined ? {} : { required: question.required }),
    ...(question.placeholder === undefined
      ? {}
      : { placeholder: question.placeholder }),
  };
}

function actorForChat(
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
  projectId: string,
  worktreeId: string,
  chatId: string,
): string | null {
  return (
    Object.keys(actorHosts)
      .sort(compareText)
      .find((actorId) => {
        const host = actorHosts[actorId];
        return (
          host?.kind === 'chat' &&
          host.projectId === projectId &&
          host.worktreeId === worktreeId &&
          host.chatId === chatId
        );
      }) ?? null
  );
}

function actorForPipeline(
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
  projectId: string,
  worktreeId: string,
  executionId: string,
): string | null {
  return (
    Object.keys(actorHosts)
      .sort(compareText)
      .find((actorId) => {
        const host = actorHosts[actorId];
        return (
          host?.kind === 'pipeline' &&
          host.projectId === projectId &&
          host.worktreeId === worktreeId &&
          host.executionId === executionId
        );
      }) ?? null
  );
}

function waitTime(wait: LedgerLiveWait): number | null {
  if (wait.since === null) return null;
  const time = Date.parse(wait.since);
  return Number.isFinite(time) ? time : null;
}

function sortWaits(waits: LedgerLiveWait[]): LedgerLiveWait[] {
  return waits.sort((left, right) => {
    const kindOrder =
      LEDGER_AGENT_WAIT_KINDS.indexOf(left.kind) -
      LEDGER_AGENT_WAIT_KINDS.indexOf(right.kind);
    if (kindOrder !== 0) return kindOrder;
    const leftTime = waitTime(left);
    const rightTime = waitTime(right);
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (leftTime === null && rightTime !== null) return 1;
    if (leftTime !== null && rightTime === null) return -1;
    return (
      compareText(left.id, right.id) ||
      compareText(left.projectId, right.projectId) ||
      compareText(left.worktreeId, right.worktreeId)
    );
  });
}

function mappedWaitQuestions(
  pending: PendingQuestion,
): readonly LedgerLiveQuestion[] {
  return pending.questions.map(questionForWait);
}

function planApprovalAllowed(
  source: string | undefined,
  toolInput: Record<string, unknown>,
  tab: LedgerLiveChatTab,
): boolean {
  const inputSource = toolInput.source;
  return deriveChatWorkflowCapabilities({
    resolvedProvider:
      source ?? (typeof inputSource === 'string' ? inputSource : 'claude'),
    interfaceMode: tab.interfaceMode ?? 'canopy',
    target: 'worktree',
    capabilities: ipcCanopyClient.capabilities,
  }).planImplementation;
}

function planWaitSources(state: LedgerLiveChatState): PendingPlanWait[] {
  const seenIds = new Set<string>();
  const waits: PendingPlanWait[] = [];
  const addWait = (wait: PendingPlanWait): void => {
    if (seenIds.has(wait.id)) return;
    seenIds.add(wait.id);
    waits.push(wait);
  };
  for (const pending of Object.values(state.pendingPlanExits)) {
    const tab = state.worktreeChats[
      worktreeKey(pending.projectId, pending.worktreeId)
    ]?.tabs.find((candidate) => candidate.id === pending.chatId);
    if (
      tab === undefined ||
      tab.kind === 'file' ||
      !planApprovalAllowed(pending.source, pending.toolInput, tab)
    ) {
      continue;
    }
    addWait({
      id: pending.requestId,
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
      chatId: pending.chatId,
      toolInput: pending.toolInput,
    });
  }
  for (const [scopeKey, chats] of Object.entries(state.worktreeChats)) {
    const separator = scopeKey.indexOf('/');
    if (separator < 0) continue;
    const projectId = scopeKey.slice(0, separator);
    const worktreeId = scopeKey.slice(separator + 1);
    for (const tab of chats.tabs) {
      if (tab.kind === 'file' || tab.pendingPlanExit === undefined) continue;
      if (!planApprovalAllowed(undefined, tab.pendingPlanExit, tab)) continue;
      const id =
        tab.pendingPlanExitRequestId ??
        `plan:${projectId}/${worktreeId}/${tab.id}`;
      addWait({
        id,
        projectId,
        worktreeId,
        chatId: tab.id,
        toolInput: tab.pendingPlanExit,
      });
    }
  }
  return waits;
}

function parseWorktreeKey(
  key: string,
): { readonly projectId: string; readonly worktreeId: string } | null {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    projectId: key.slice(0, separator),
    worktreeId: key.slice(separator + 1),
  };
}

function pipelineRunStatus(
  status: LedgerPipelineRunStatus | undefined,
): 'running' | 'waiting_approval' | 'failed' | 'idle' {
  if (status === 'pending' || status === 'running') return 'running';
  if (status === 'paused') return 'waiting_approval';
  if (status === 'failure') return 'failed';
  return 'idle';
}

function pipelineRunForHost(
  state: LedgerLivePipelineRunsState,
  host: Extract<LedgerViewActorHost, { kind: 'pipeline' }>,
): LedgerPipelineRunFact | undefined {
  const stateFact = state.statesById[host.executionId];
  if (stateFact !== undefined) return stateFact;
  const current = state.currentRuns.find((run) => run.id === host.executionId);
  if (current !== undefined) return current;
  return state.runsByWorktree[
    worktreeKey(host.projectId, host.worktreeId)
  ]?.find((run) => run.id === host.executionId);
}

function pipelineWaits(
  state: LedgerLivePipelineRunsState,
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
): LedgerLiveWait[] {
  const waits: LedgerLiveWait[] = [];
  state.unseenFailedWorktreeKeys.forEach((worktree: string): void => {
    const scope = parseWorktreeKey(worktree);
    if (scope === null) return;
    for (const run of state.runsByWorktree[worktree] ?? []) {
      if (run.status !== 'failure') continue;
      // Pipeline retries retain their execution id. Prefer the current store
      // projection so a retry that has started or succeeded clears this wait.
      const latest =
        state.statesById[run.id] ??
        state.currentRuns.find((candidate) => candidate.id === run.id) ??
        run;
      if (latest.status !== 'failure') continue;
      waits.push({
        kind: 'failed_run',
        id: run.id,
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: null,
        executionId: run.id,
        actorId: actorForPipeline(
          actorHosts,
          scope.projectId,
          scope.worktreeId,
          run.id,
        ),
        title: latest.name || run.name,
        since: latest.completedAt ?? run.completedAt ?? null,
      });
    }
  });
  return waits;
}

function liveWaits(
  chat: LedgerLiveChatState,
  pipelines: LedgerLivePipelineRunsState,
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
): LedgerLiveWait[] {
  const waits: LedgerLiveWait[] = [];
  for (const pending of Object.values(chat.pendingQuestions)) {
    if (pending.answeredAt !== undefined || pending.dismissedAt !== undefined) {
      continue;
    }
    waits.push({
      kind: 'question',
      id: pending.requestId,
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
      chatId: pending.chatId,
      actorId: actorForChat(
        actorHosts,
        pending.projectId,
        pending.worktreeId,
        pending.chatId,
      ),
      title: pending.questions[0]?.question ?? '',
      since: null,
      questions: mappedWaitQuestions(pending),
    });
  }
  for (const pending of planWaitSources(chat)) {
    const text = planText(pending.toolInput);
    waits.push({
      kind: 'plan',
      id: pending.id,
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
      chatId: pending.chatId,
      actorId: actorForChat(
        actorHosts,
        pending.projectId,
        pending.worktreeId,
        pending.chatId,
      ),
      title: planTitle(text),
      since: null,
      detail: text,
    });
  }
  for (const pending of Object.values(chat.pendingApprovals)) {
    waits.push({
      kind: 'approval',
      id: pending.requestId,
      projectId: pending.projectId,
      worktreeId: pending.worktreeId,
      chatId: pending.chatId,
      actorId: actorForChat(
        actorHosts,
        pending.projectId,
        pending.worktreeId,
        pending.chatId,
      ),
      title: pending.title,
      since: null,
    });
  }
  waits.push(...pipelineWaits(pipelines, actorHosts));
  return sortWaits(waits);
}

function chatLiveInput(
  host: Extract<LedgerViewActorHost, { kind: 'chat' }>,
  chat: LedgerLiveChatState,
  delegations: LedgerLiveDelegationActivityState,
  providers: LedgerLiveProviderTaskState,
  lags: LedgerLiveIngestionLagState,
  nowMs: number,
): { readonly input: LedgerChatLiveInput; readonly lagSampledAtMs?: number } {
  const scopeChats =
    chat.worktreeChats[worktreeKey(host.projectId, host.worktreeId)];
  const tab = scopeChats?.tabs.find(
    (candidate) => candidate.id === host.chatId && candidate.kind !== 'file',
  );
  const unanswered = Object.values(chat.pendingQuestions).some(
    (pending) =>
      pending.projectId === host.projectId &&
      pending.worktreeId === host.worktreeId &&
      pending.chatId === host.chatId &&
      pending.answeredAt === undefined &&
      pending.dismissedAt === undefined,
  );
  const planPending =
    Object.values(chat.pendingPlanExits).some(
      (pending) =>
        pending.projectId === host.projectId &&
        pending.worktreeId === host.worktreeId &&
        pending.chatId === host.chatId,
    ) || tab?.pendingPlanExit !== undefined;
  const approvalPending = Object.values(chat.pendingApprovals).some(
    (pending) =>
      pending.projectId === host.projectId &&
      pending.worktreeId === host.worktreeId &&
      pending.chatId === host.chatId,
  );
  const key = chatStoreKey(host.projectId, host.worktreeId, host.chatId);
  const delegation =
    delegations.byChat[
      chatDelegationKey(host.projectId, host.worktreeId, host.chatId)
    ];
  const providerTasks =
    providers.byChat[
      liveBackgroundTaskKey(host.projectId, host.worktreeId, host.chatId)
    ]?.liveTasks ?? [];
  const lag = lags.lagByChat[key]?.lag;
  const visibleLag = visibleCatchingUpLag(lag, nowMs);
  return {
    input: {
      kind: 'chat' as const,
      turnRunning: tab?.status === 'streaming',
      pendingQuestion: unanswered,
      pendingPlan: planPending,
      pendingApproval: approvalPending,
      backgroundTasks: backgroundTaskCount(delegation, providerTasks),
      unread: tab?.unread === true,
      catchingUp: visibleLag !== null,
    },
    ...(visibleLag === null ? {} : { lagSampledAtMs: visibleLag.sampledAtMs }),
  };
}

function delegationRunning(
  host: Extract<LedgerViewActorHost, { kind: 'delegation' }>,
  trees: LedgerLiveDelegationTreeReader,
): boolean {
  if (host.rootChatId === null) return false;
  const entry = trees
    .getSnapshot(
      { projectId: host.projectId, worktreeId: host.worktreeId },
      host.rootChatId,
    )
    .managedEntries.get(host.delegationId);
  return (
    entry?.snapshot.status === 'pending' || entry?.snapshot.status === 'running'
  );
}

/**
 * Records whether one line of agents (keyed by its top: a root chat or a
 * pipeline run) is active now, and returns its ancestry state.
 */
type LedgerAncestryTracker = (
  key: string,
  active: boolean,
) => LedgerAgentAncestryState;

function snapshotFor(
  deps: LedgerLiveStateDependencies,
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
  trackAncestry: LedgerAncestryTracker,
): LedgerLiveSnapshot {
  const chat = deps.chatStore.getState();
  const delegations = deps.delegationActivityStore.getState();
  const providers = deps.liveBackgroundTaskStore.getState();
  const lags = deps.ingestionLagStore.getState();
  const pipelines = deps.pipelineRunsStore.getState();
  const nowMs = deps.clock.now();
  const chatState = (
    host: Extract<LedgerViewActorHost, { kind: 'chat' }>,
  ): LedgerAgentLiveState =>
    projectAgentLiveState(
      chatLiveInput(host, chat, delegations, providers, lags, nowMs).input,
    );
  // Each line is read once per snapshot, from its top alone, so every actor
  // on it (and every reader) sees the same answer and no read restamps it.
  const lines = new Map<string, LedgerAgentAncestryState>();
  const line = (
    key: string,
    active: () => boolean,
  ): LedgerAgentAncestryState => {
    const known = lines.get(key);
    if (known !== undefined) return known;
    const ancestry = trackAncestry(key, active());
    lines.set(key, ancestry);
    return ancestry;
  };
  const agents: Record<string, LedgerAgentLiveState> = {};
  for (const actorId of Object.keys(actorHosts).sort(compareText)) {
    const host = actorHosts[actorId];
    if (host === undefined) continue;
    // When no matching tab, run or delegation row and no separately sourced
    // wait/background task exists, the actor projects idle. Durable chat
    // requests can still make a chat wait without a matching tab.
    switch (host.kind) {
      case 'chat': {
        const state = chatState(host);
        // A chat's delegates and background tasks count in its own state.
        agents[actorId] = {
          ...state,
          ancestry: line(
            `chat:${chatStoreKey(host.projectId, host.worktreeId, host.chatId)}`,
            () => !ledgerAgentIsResting(state),
          ),
        };
        break;
      }
      case 'delegation': {
        const state = projectAgentLiveState({
          kind: 'delegation',
          running: delegationRunning(host, deps.delegationTreeStore),
        });
        // Its root chat counts every delegate under it as background work,
        // so the root's state decides for the whole line. The delegate's own
        // run, read from a store that refreshes later, only keeps its row
        // from reading as idle.
        const rootChatId = host.rootChatId;
        const ancestry =
          rootChatId === null
            ? line(
                `delegation:${host.delegationId}`,
                () => !ledgerAgentIsResting(state),
              )
            : line(
                `chat:${chatStoreKey(host.projectId, host.worktreeId, rootChatId)}`,
                () =>
                  !ledgerAgentIsResting(
                    chatState({
                      kind: 'chat',
                      projectId: host.projectId,
                      worktreeId: host.worktreeId,
                      chatId: rootChatId,
                    }),
                  ),
              );
        agents[actorId] = {
          ...state,
          ancestry: ledgerAgentIsResting(state) ? ancestry : { idle: false },
        };
        break;
      }
      case 'pipeline': {
        const state = projectAgentLiveState({
          kind: 'pipeline',
          status: pipelineRunStatus(
            pipelineRunForHost(pipelines, host)?.status,
          ),
        });
        agents[actorId] = {
          ...state,
          ancestry: line(
            `pipeline:${host.executionId}`,
            () => !ledgerAgentIsResting(state),
          ),
        };
        break;
      }
    }
  }
  return { agents, waits: liveWaits(chat, pipelines, actorHosts) };
}

function snapshotContentKey(snapshot: LedgerLiveSnapshot): string {
  return JSON.stringify([
    Object.keys(snapshot.agents)
      .sort(compareText)
      .map((actorId) => [actorId, snapshot.agents[actorId]]),
    snapshot.waits,
  ]);
}

function delegationRoots(
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
): Map<
  string,
  {
    readonly projectId: string;
    readonly worktreeId: string;
    readonly rootChatId: string;
  }
> {
  const roots = new Map<
    string,
    {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly rootChatId: string;
    }
  >();
  for (const host of Object.values(actorHosts)) {
    if (host.kind !== 'delegation' || host.rootChatId === null) continue;
    const key = `${host.projectId}\u0000${host.worktreeId}\u0000${host.rootChatId}`;
    roots.set(key, {
      projectId: host.projectId,
      worktreeId: host.worktreeId,
      rootChatId: host.rootChatId,
    });
  }
  return roots;
}

/** How many readers' actor sets the source keeps snapshots for. */
const RETAINED_LIVE_READERS = 8;

interface LedgerLiveReader {
  readonly hosts: Readonly<Record<string, LedgerViewActorHost>>;
  snapshot: LedgerLiveSnapshot | undefined;
  contentKey: string | undefined;
}

/**
 * Reads desktop stores used by the sidebar, tabs, activity and pipeline
 * surfaces. The subscription is shared lazily by all Feed consumers; live
 * token/transcript writes are omitted from its projected key.
 */
export function createDesktopLedgerLiveStateSource(
  injected?: Partial<LedgerLiveStateDependencies>,
): LedgerLiveStateSource {
  const defaults = defaultDependencies();
  const deps: LedgerLiveStateDependencies = { ...defaults, ...injected };
  const listeners = new Set<() => void>();
  const storeUnsubscribers: Array<() => void> = [];
  const treeSubscriptions = new Map<string, DelegationTreeSubscription>();
  // Each reader (the Feed page, each Feed panel) asks for its own actors and
  // keeps its own snapshot; the stores are watched for all of them at once.
  const readers = new Map<string, LedgerLiveReader>();
  let actorHosts: Readonly<Record<string, LedgerViewActorHost>> = {};
  let observedContentKey: string | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  // shortcut: one entry per line of agents ever read, kept for the window's
  // life; prune by the readers' hosts if that ever grows large.
  const ancestries = new Map<
    string,
    { readonly active: boolean; readonly lastActiveAt?: number }
  >();
  const trackAncestry: LedgerAncestryTracker = (key, active) => {
    const nowMs = deps.clock.now();
    const previous = ancestries.get(key);
    if (active) {
      ancestries.set(key, { active: true, lastActiveAt: nowMs });
      return { idle: false };
    }
    // Seen active until now: it rests from this moment.
    const lastActiveAt =
      previous?.active === true ? nowMs : previous?.lastActiveAt;
    ancestries.set(
      key,
      lastActiveAt === undefined
        ? { active: false }
        : { active: false, lastActiveAt },
    );
    return lastActiveAt === undefined
      ? { idle: true }
      : { idle: true, lastActiveAt: new Date(lastActiveAt).toISOString() };
  };

  const currentSnapshot = (): LedgerLiveSnapshot =>
    snapshotFor(deps, actorHosts, trackAncestry);

  const clearStaleTimer = (): void => {
    if (staleTimer === undefined) return;
    deps.clock.clearTimeout(staleTimer);
    staleTimer = undefined;
  };

  const scheduleStaleTimer = (): void => {
    clearStaleTimer();
    let nextStaleAt: number | null = null;
    for (const entry of Object.values(
      deps.ingestionLagStore.getState().lagByChat,
    )) {
      if (entry === undefined) continue;
      const visible = visibleCatchingUpLag(entry.lag, deps.clock.now());
      if (visible === null) continue;
      const staleAt = visible.sampledAtMs + INGESTION_LAG_STALE_AFTER_MS + 1;
      if (nextStaleAt === null || staleAt < nextStaleAt) {
        nextStaleAt = staleAt;
      }
    }
    if (nextStaleAt === null) return;
    staleTimer = deps.clock.setTimeout(
      (): void => {
        staleTimer = undefined;
        onStoreChange();
      },
      Math.max(0, nextStaleAt - deps.clock.now()),
    );
  };

  const onStoreChange = (): void => {
    const next = currentSnapshot();
    const nextKey = snapshotContentKey(next);
    scheduleStaleTimer();
    if (observedContentKey === nextKey) return;
    observedContentKey = nextKey;
    listeners.forEach((listener: () => void): void => listener());
  };

  const syncDelegationTreeRoots = (): void => {
    const required = delegationRoots(actorHosts);
    treeSubscriptions.forEach(
      (current: DelegationTreeSubscription, key: string): void => {
        if (required.has(key)) return;
        current.unsubscribe();
        current.release();
        treeSubscriptions.delete(key);
      },
    );
    required.forEach((root, key): void => {
      if (treeSubscriptions.has(key)) return;
      const scope = {
        projectId: root.projectId,
        worktreeId: root.worktreeId,
      };
      const unsubscribe = deps.delegationTreeStore.subscribe(
        scope,
        root.rootChatId,
        onStoreChange,
      );
      const release = deps.delegationTreeStore.acquire(scope, root.rootChatId);
      treeSubscriptions.set(key, {
        scope,
        rootChatId: root.rootChatId,
        unsubscribe,
        release,
      });
    });
  };

  const attachStores = (): void => {
    storeUnsubscribers.push(
      deps.chatStore.subscribe(onStoreChange),
      deps.delegationActivityStore.subscribe(onStoreChange),
      deps.liveBackgroundTaskStore.subscribe(onStoreChange),
      deps.ingestionLagStore.subscribe(onStoreChange),
      deps.pipelineRunsStore.subscribe(onStoreChange),
    );
    syncDelegationTreeRoots();
    observedContentKey = snapshotContentKey(currentSnapshot());
    scheduleStaleTimer();
  };

  const detachStores = (): void => {
    for (const unsubscribe of storeUnsubscribers.splice(0)) unsubscribe();
    treeSubscriptions.forEach((current: DelegationTreeSubscription): void => {
      current.unsubscribe();
      current.release();
    });
    treeSubscriptions.clear();
    clearStaleTimer();
    observedContentKey = undefined;
  };

  const readerFor = (
    nextHosts: Readonly<Record<string, LedgerViewActorHost>>,
  ): LedgerLiveReader => {
    const key = hostContentKey(nextHosts);
    const existing = readers.get(key);
    if (existing !== undefined) {
      readers.delete(key);
      readers.set(key, existing);
      return existing;
    }
    const reader: LedgerLiveReader = {
      hosts: Object.fromEntries(
        Object.keys(nextHosts)
          .sort(compareText)
          .flatMap((actorId) => {
            const host = nextHosts[actorId];
            return host === undefined ? [] : [[actorId, { ...host }]];
          }),
      ),
      snapshot: undefined,
      contentKey: undefined,
    };
    readers.set(key, reader);
    // shortcut: more simultaneous readers than this evict each other; raise it
    // if a window ever shows more Feed panels at once.
    while (readers.size > RETAINED_LIVE_READERS) {
      const oldest = readers.keys().next().value;
      if (oldest === undefined) break;
      readers.delete(oldest);
    }
    actorHosts = Object.fromEntries(
      Array.from(readers.values()).flatMap((current) =>
        Object.entries(current.hosts),
      ),
    );
    if (listeners.size > 0) {
      syncDelegationTreeRoots();
      observedContentKey = snapshotContentKey(currentSnapshot());
    }
    return reader;
  };

  return {
    subscribe: (listener): (() => void) => {
      const wasEmpty = listeners.size === 0;
      listeners.add(listener);
      if (wasEmpty) attachStores();
      return (): void => {
        listeners.delete(listener);
        if (listeners.size === 0) detachStores();
      };
    },
    getSnapshot: (nextHosts): LedgerLiveSnapshot => {
      const reader = readerFor(nextHosts);
      const snapshot = snapshotFor(deps, reader.hosts, trackAncestry);
      const contentKey = snapshotContentKey(snapshot);
      if (reader.snapshot !== undefined && reader.contentKey === contentKey) {
        return reader.snapshot;
      }
      reader.snapshot = snapshot;
      reader.contentKey = contentKey;
      return snapshot;
    },
  };
}

let singleton: LedgerLiveStateSource | undefined;

/** Lazily creates the renderer's shared desktop implementation. */
export const desktopLedgerLiveStateSource: LedgerLiveStateSource = {
  subscribe: (listener): (() => void) => {
    singleton ??= createDesktopLedgerLiveStateSource();
    return singleton.subscribe(listener);
  },
  getSnapshot: (actorHosts): LedgerLiveSnapshot => {
    singleton ??= createDesktopLedgerLiveStateSource();
    return singleton.getSnapshot(actorHosts);
  },
};
