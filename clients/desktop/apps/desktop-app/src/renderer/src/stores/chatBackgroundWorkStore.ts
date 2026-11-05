import { useMemo } from 'react';
import { create } from 'zustand';
import {
  githubWorkflowRunRowStatus,
  type BackgroundTrayAgent,
  type BackgroundTrayAgentStep,
} from '@canopy/ui-app';
import {
  isSameAgentArtifactCarryReceipt,
  latestGitHubRunObservation,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import type {
  AgentArtifactReceiptV1,
  GitHubPullRequestWatchProgress,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';

export type ChatBackgroundRunReceipt =
  | PipelineRunArtifactReceiptV1
  | GitHubWorkflowRunArtifactReceiptV1;

type RunsByKey = Readonly<Record<string, ChatBackgroundRunReceipt>>;

/**
 * Each chat's background work for the composer's background drawer,
 * published by its transcript from what it already computes, so the drawer
 * need not project the messages again: the runs it follows (background
 * drawer Phase 05) and the live background subagents (Phase 04). Also keeps
 * which finished runs the drawer may show: only runs it saw running in this
 * session, until the user dismisses them.
 */
/** A watched pull request as its watcher last observed it. */
export interface ChatBackgroundPullRequest {
  readonly watcherId: string;
  readonly pr: GitHubPullRequestWatchProgress;
}

/** What a listed delegate's own transcript adds to its drawer row. */
export interface ChatBackgroundAgentLive {
  readonly steps: readonly BackgroundTrayAgentStep[];
  readonly status: BackgroundTrayAgent['status'];
}

interface ChatBackgroundWorkState {
  /**
   * Every pipeline and GitHub run receipt the chat published as live this
   * session, by dedupe key, the newest kept. A run stays after it leaves
   * the live set, so the drawer can show how it finished.
   */
  readonly byChat: Readonly<Record<string, RunsByKey>>;
  readonly agentsByChat: Readonly<
    Record<string, readonly BackgroundTrayAgent[]>
  >;
  /**
   * A listed delegate's steps and live status, read from its own transcript
   * (its log and live snapshot), by `${chatKey}\0${agentId}`; the parent's
   * transcript has no steps, and its saved card no pending approval.
   */
  readonly agentLive: Readonly<Record<string, ChatBackgroundAgentLive>>;
  /**
   * Every pull request the chat's watchers followed this session, by row
   * key, the newest observation kept: a finished one outlives its watcher's
   * summaries (the fire history is capped) until it is dismissed.
   */
  readonly pullRequestsByChat: Readonly<
    Record<string, Readonly<Record<string, ChatBackgroundPullRequest>>>
  >;
  /** `${chatKey}\0${dedupeKey}` → true for runs seen running. */
  readonly seenLive: Readonly<Record<string, true>>;
  /** `${chatKey}\0${dedupeKey}` → true for dismissed finished runs. */
  readonly dismissed: Readonly<Record<string, true>>;
}

export const useChatBackgroundWorkStore = create<ChatBackgroundWorkState>(
  () => ({
    byChat: {},
    agentsByChat: {},
    agentLive: {},
    pullRequestsByChat: {},
    seenLive: {},
    dismissed: {},
  }),
);

export function chatBackgroundWorkKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return JSON.stringify([projectId, worktreeId, chatId]);
}

export function chatBackgroundRunKey(chatKey: string, runKey: string): string {
  return `${chatKey}\0${runKey}`;
}

function isRunReceipt(
  receipt: AgentArtifactReceiptV1,
): receipt is ChatBackgroundRunReceipt {
  return (
    receipt.kind === 'pipeline_run' || receipt.kind === 'github_workflow_run'
  );
}

/**
 * Merges a chat's run receipts into what the drawer knows, by dedupe key; a
 * receipt the drawer already holds, or an equal one, changes nothing. A
 * GitHub snapshot older than the held one never replaces it: the transcript
 * carries a run's last in-progress snapshot after the drawer saw it finish.
 */
export function publishChatBackgroundRuns(
  chatKey: string,
  receipts: readonly AgentArtifactReceiptV1[],
): void {
  useChatBackgroundWorkStore.setState((state) => {
    const current = state.byChat[chatKey] ?? {};
    let next: Record<string, ChatBackgroundRunReceipt> | null = null;
    for (const receipt of receipts) {
      const held = current[receipt.dedupeKey];
      if (
        !isRunReceipt(receipt) ||
        (held !== undefined &&
          (isSameAgentArtifactCarryReceipt(held, receipt) ||
            (held.kind === 'github_workflow_run' &&
              receipt.kind === 'github_workflow_run' &&
              latestGitHubRunObservation(receipt).localeCompare(
                latestGitHubRunObservation(held),
              ) < 0)))
      ) {
        continue;
      }
      next ??= { ...current };
      next[receipt.dedupeKey] = receipt;
    }
    return next === null
      ? state
      : { byChat: { ...state.byChat, [chatKey]: next } };
  });
}

function sameSteps(
  a: readonly BackgroundTrayAgentStep[],
  b: readonly BackgroundTrayAgentStep[],
): boolean {
  return (
    a.length === b.length &&
    a.every((step, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        step.id === other.id &&
        step.toolName === other.toolName &&
        step.input === other.input
      );
    })
  );
}

function sameAgent(a: BackgroundTrayAgent, b: BackgroundTrayAgent): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.status === b.status &&
    a.activity === b.activity &&
    a.startedAt === b.startedAt &&
    a.prompt === b.prompt &&
    a.meta === b.meta &&
    a.taskId === b.taskId &&
    a.canStop === b.canStop &&
    a.stopsDescendants === b.stopsDescendants &&
    a.target?.kind === b.target?.kind &&
    a.target?.id === b.target?.id &&
    a.target?.title === b.target?.title &&
    sameSteps(a.steps, b.steps)
  );
}

/**
 * Publishes a chat's live background subagents. The transcript maps them on
 * every render; the store changes only when a row does, so streaming that
 * leaves the agents alone never re-renders the drawer.
 */
export function publishChatBackgroundAgents(
  chatKey: string,
  agents: readonly BackgroundTrayAgent[],
): void {
  useChatBackgroundWorkStore.setState((state) => {
    const current = state.agentsByChat[chatKey];
    if (
      current !== undefined &&
      current.length === agents.length &&
      current.every((agent, index) => {
        const next = agents[index];
        return next !== undefined && sameAgent(agent, next);
      })
    ) {
      return state;
    }
    return { agentsByChat: { ...state.agentsByChat, [chatKey]: agents } };
  });
}

/**
 * Publishes a listed delegate's steps and live status, or clears them
 * (`null`) once its row goes; changes the store only when one does.
 */
export function publishChatBackgroundAgentLive(
  chatKey: string,
  agentId: string,
  live: ChatBackgroundAgentLive | null,
): void {
  const key = `${chatKey}\0${agentId}`;
  useChatBackgroundWorkStore.setState((state) => {
    const current = state.agentLive[key];
    if (live === null) {
      if (current === undefined) return state;
      const agentLive = { ...state.agentLive };
      delete agentLive[key];
      return { agentLive };
    }
    if (
      current !== undefined &&
      current.status === live.status &&
      sameSteps(current.steps, live.steps)
    )
      return state;
    return { agentLive: { ...state.agentLive, [key]: live } };
  });
}

/**
 * Merges the pull requests the chat's watchers report into what the drawer
 * holds, by row key; an older observation never replaces a newer one.
 */
export function publishChatBackgroundPullRequests(
  chatKey: string,
  pullRequests: ReadonlyMap<string, ChatBackgroundPullRequest>,
): void {
  useChatBackgroundWorkStore.setState((state) => {
    const current = state.pullRequestsByChat[chatKey] ?? {};
    let next: Record<string, ChatBackgroundPullRequest> | null = null;
    for (const [key, entry] of Array.from(pullRequests)) {
      const held = current[key];
      if (
        held !== undefined &&
        (held.pr.observedAt.localeCompare(entry.pr.observedAt) > 0 ||
          (held.watcherId === entry.watcherId &&
            JSON.stringify(held.pr) === JSON.stringify(entry.pr)))
      ) {
        continue;
      }
      next ??= { ...current };
      next[key] = { watcherId: entry.watcherId, pr: entry.pr };
    }
    return next === null
      ? state
      : {
          pullRequestsByChat: { ...state.pullRequestsByChat, [chatKey]: next },
        };
  });
}

/**
 * Marks runs the drawer saw live. A run live again (a reopened pull request
 * under a new watch) also loses an earlier dismissal, so its new result shows.
 */
export function markChatBackgroundRunsSeenLive(
  chatKey: string,
  runKeys: readonly string[],
): void {
  useChatBackgroundWorkStore.setState((state) => {
    const keys = runKeys.map((runKey) => chatBackgroundRunKey(chatKey, runKey));
    const unseen = keys.filter((key) => state.seenLive[key] !== true);
    const undismissed = keys.filter((key) => state.dismissed[key] === true);
    if (unseen.length === 0 && undismissed.length === 0) return state;
    const seenLive: Record<string, true> = { ...state.seenLive };
    for (const key of unseen) seenLive[key] = true;
    if (undismissed.length === 0) return { seenLive };
    const dismissed: Record<string, true> = { ...state.dismissed };
    for (const key of undismissed) delete dismissed[key];
    return { seenLive, dismissed };
  });
}

export function dismissChatBackgroundRun(
  chatKey: string,
  runKey: string,
): void {
  useChatBackgroundWorkStore.setState((state) => ({
    dismissed: {
      ...state.dismissed,
      [chatBackgroundRunKey(chatKey, runKey)]: true,
    },
  }));
}

const NO_RUN_KEYS: ReadonlySet<string> = new Set();

/**
 * The dedupe keys of the runs the chat's drawer holds: published runs it saw
 * live and the user has not dismissed. With the live keys they keep turn
 * records from listing a run the drawer lists (background drawer D3). A
 * GitHub run still in progress is held by neither: its watcher makes it
 * live, and with no watcher the drawer drops it, so it goes back to its
 * turn. A chat without a drawer (`null`) holds none. Subscribes through a
 * string, so other chats' changes never re-render the caller.
 */
export function useChatHeldRunKeys(
  chatKey: string | null,
): ReadonlySet<string> {
  const joined = useChatBackgroundWorkStore((state) => {
    if (chatKey === null) return '';
    const runs = state.byChat[chatKey];
    if (runs === undefined) return '';
    return Object.entries(runs)
      .filter(([runKey, receipt]) => {
        const key = chatBackgroundRunKey(chatKey, runKey);
        return (
          state.seenLive[key] === true &&
          state.dismissed[key] !== true &&
          (receipt.kind !== 'github_workflow_run' ||
            !githubWorkflowRunRowStatus(receipt.state).active)
        );
      })
      .map(([runKey]) => runKey)
      .sort()
      .join('\n');
  });
  return useMemo(
    () => (joined === '' ? NO_RUN_KEYS : new Set(joined.split('\n'))),
    [joined],
  );
}
