import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import type {
  ChatMessage,
  ChatTab,
  WorktreeChatState,
} from '../stores/chatStore';
import { getTextBlocks } from '../stores/chatStore';
import type { WorktreePipelineEntry } from '../stores/pipelineRunsStore';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';

/**
 * Resolves a plan-explore scope's plan id to the real worktree it runs against
 * (backed by chatStore's plan-explore origin registry). Lets overview cards show
 * the owning workspace/worktree and navigate to the plan instead of exposing the
 * synthetic `plan-explore-chat` scope and raw plan id.
 */
export type PlanExploreOriginResolver = (
  planId: string,
) => { projectId: string; worktreeId: string } | undefined;

const noPlanExploreOrigin: PlanExploreOriginResolver = () => undefined;

export interface WorktreeLabel {
  projectId: string;
  worktreeId: string;
  workspaceName: string;
  worktreeName: string;
}

export interface OverviewChatCard {
  key: string;
  projectId: string;
  worktreeId: string;
  tabId: string;
  tabTitle: string;
  preview: string;
  workspaceName: string;
  worktreeName: string;
  lastEventAt: number;
  isStreaming: boolean;
  hasPendingPlanReview: boolean;
  /**
   * Present when this card is a plan-explore chat. Carries the real worktree and
   * plan id so the card can render a plan icon and open the plan's Explore modal
   * on click. `projectId`/`worktreeId` on the card itself stay the synthetic
   * plan-explore scope so dismissal targets the right tab.
   */
  planExplore?: { projectId: string; worktreeId: string; planId: string };
}

export interface OverviewPipelineCard {
  key: string;
  projectId: string;
  worktreeId: string;
  executionId: string;
  pipelineName: string;
  status: ExecutionState['status'];
  startedAt?: string;
  completedAt?: string;
  workspaceName: string;
  worktreeName: string;
  hiddenCount?: number;
}

const CHAT_PREVIEW_CHAR_LIMIT = 240;
const TERMINAL_CARDS_PER_WORKTREE_CAP = 5;

function stripPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, CHAT_PREVIEW_CHAR_LIMIT);
}

function findLastAssistantPreview(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const joined = getTextBlocks(message).join(' ').trim();
    if (joined) {
      return stripPreview(joined);
    }
  }
  return '';
}

function findLastAnyPreview(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'system') continue;
    const joined = getTextBlocks(message).join(' ').trim();
    if (joined) {
      return stripPreview(joined);
    }
  }
  return '';
}

function hasPendingTrackedPlanReview(tab: ChatTab): boolean {
  return (
    tab.trackedPlanId !== undefined && tab.trackedPlanReviewStatus === 'pending'
  );
}

function hasPlanReviewSurface(tab: ChatTab): boolean {
  return tab.pendingPlanExit !== undefined || hasPendingTrackedPlanReview(tab);
}

function tabNeedsUnreadCard(tab: ChatTab): boolean {
  if (tab.unread === true) return true;
  if (tab.attentionDismissedAt !== undefined) return false;
  return hasPlanReviewSurface(tab);
}

function splitWorktreeKey(
  key: string,
): { projectId: string; worktreeId: string } | null {
  const separatorIndex = key.indexOf('/');
  if (separatorIndex < 0) return null;
  const projectId = key.slice(0, separatorIndex);
  const worktreeId = key.slice(separatorIndex + 1);
  if (!projectId || !worktreeId) return null;
  return { projectId, worktreeId };
}

function buildWorktreeLabel(
  projects: SidebarItem[],
  projectId: string,
  worktreeId: string,
): WorktreeLabel {
  const project = projects.find((item) => item.id === projectId);
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find((item) => item.id === worktreeId)
      : undefined;
  return {
    projectId,
    worktreeId,
    workspaceName: project?.name ?? projectId,
    worktreeName: worktree?.branchName ?? worktreeId,
  };
}

/**
 * For a plan-explore scope key, resolve the real worktree label and the
 * navigation/plan context. Returns null for non-plan-explore scopes so callers
 * fall back to the plain worktree label.
 */
function resolvePlanExploreContext(
  parts: { projectId: string; worktreeId: string },
  projects: SidebarItem[],
  resolvePlanExplore: PlanExploreOriginResolver,
): {
  label: WorktreeLabel;
  planExplore: OverviewChatCard['planExplore'];
} | null {
  if (parts.projectId !== PLAN_EXPLORE_CHAT_PROJECT_ID) return null;
  const planId = parts.worktreeId;
  const origin = resolvePlanExplore(planId);
  if (!origin) {
    // Origin unknown (plan never opened this session). Card is still included
    // but without a resolved worktree label, plan icon, or navigation target.
    return {
      label: buildWorktreeLabel(projects, parts.projectId, parts.worktreeId),
      planExplore: undefined,
    };
  }
  return {
    label: buildWorktreeLabel(projects, origin.projectId, origin.worktreeId),
    planExplore: {
      projectId: origin.projectId,
      worktreeId: origin.worktreeId,
      planId,
    },
  };
}

export function selectUnreadChatCards(
  worktreeChats: Record<string, WorktreeChatState>,
  unreadWorktreeKeys: Set<string>,
  projects: SidebarItem[],
  resolvePlanExplore: PlanExploreOriginResolver = noPlanExploreOrigin,
): OverviewChatCard[] {
  const cards: OverviewChatCard[] = [];
  for (const key of Array.from(unreadWorktreeKeys)) {
    const parts = splitWorktreeKey(key);
    if (!parts) continue;
    const chat = worktreeChats[key];
    if (!chat) continue;

    const planContext = resolvePlanExploreContext(
      parts,
      projects,
      resolvePlanExplore,
    );
    const label =
      planContext?.label ??
      buildWorktreeLabel(projects, parts.projectId, parts.worktreeId);
    const planExplore = planContext?.planExplore;
    const attentionTabs = chat.tabs.filter(tabNeedsUnreadCard);
    const activeTab = chat.tabs.find((tab) => tab.id === chat.activeTabId);
    const tabsForCards =
      attentionTabs.length > 0
        ? attentionTabs
        : activeTab !== undefined &&
            activeTab.attentionDismissedAt === undefined
          ? [activeTab]
          : [];
    for (const tab of tabsForCards) {
      cards.push({
        key: `${key}#${tab.id}`,
        projectId: parts.projectId,
        worktreeId: parts.worktreeId,
        tabId: tab.id,
        tabTitle: tab.title,
        preview: findLastAssistantPreview(tab.messages),
        workspaceName: label.workspaceName,
        worktreeName: label.worktreeName,
        lastEventAt: tab.lastEventAt ?? 0,
        isStreaming: tab.status === 'streaming',
        hasPendingPlanReview: hasPlanReviewSurface(tab),
        ...(planExplore ? { planExplore } : {}),
      });
    }
  }
  cards.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return cards;
}

export function selectInProgressChatCards(
  worktreeChats: Record<string, WorktreeChatState>,
  projects: SidebarItem[],
  resolvePlanExplore: PlanExploreOriginResolver = noPlanExploreOrigin,
): OverviewChatCard[] {
  const cards: OverviewChatCard[] = [];
  for (const [key, chat] of Object.entries(worktreeChats)) {
    const parts = splitWorktreeKey(key);
    if (!parts) continue;
    const planContext = resolvePlanExploreContext(
      parts,
      projects,
      resolvePlanExplore,
    );
    const label =
      planContext?.label ??
      buildWorktreeLabel(projects, parts.projectId, parts.worktreeId);
    const planExplore = planContext?.planExplore;
    for (const tab of chat.tabs) {
      if (tab.status !== 'streaming') continue;
      cards.push({
        key: `${key}#${tab.id}`,
        projectId: parts.projectId,
        worktreeId: parts.worktreeId,
        tabId: tab.id,
        tabTitle: tab.title,
        preview: findLastAnyPreview(tab.messages),
        workspaceName: label.workspaceName,
        worktreeName: label.worktreeName,
        lastEventAt: tab.lastEventAt ?? 0,
        isStreaming: true,
        hasPendingPlanReview: hasPlanReviewSurface(tab),
        ...(planExplore ? { planExplore } : {}),
      });
    }
  }
  cards.sort((a, b) => b.lastEventAt - a.lastEventAt);
  return cards;
}

function isTerminalStatus(status: ExecutionState['status']): boolean {
  return (
    status === 'paused' ||
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled'
  );
}

function entryCompletedAtMs(entry: WorktreePipelineEntry): number {
  if (!entry.completedAt) return 0;
  const ms = Date.parse(entry.completedAt);
  return Number.isFinite(ms) ? ms : 0;
}

export function selectUnreadPipelineCards(
  pipelineSummariesByWorktree: Record<string, WorktreePipelineEntry[]>,
  unseenPipelineWorktreeKeys: Set<string>,
  projects: SidebarItem[],
): OverviewPipelineCard[] {
  const cards: OverviewPipelineCard[] = [];
  for (const key of Array.from(unseenPipelineWorktreeKeys)) {
    const parts = splitWorktreeKey(key);
    if (!parts) continue;
    const entries = pipelineSummariesByWorktree[key];
    if (!entries) continue;
    const label = buildWorktreeLabel(
      projects,
      parts.projectId,
      parts.worktreeId,
    );

    const terminalEntries = entries
      .filter((entry) => isTerminalStatus(entry.status))
      .slice()
      .sort((a, b) => entryCompletedAtMs(b) - entryCompletedAtMs(a));
    const visibleEntries = terminalEntries.slice(
      0,
      TERMINAL_CARDS_PER_WORKTREE_CAP,
    );
    const hiddenCount = terminalEntries.length - visibleEntries.length;

    for (let index = 0; index < visibleEntries.length; index += 1) {
      const entry = visibleEntries[index];
      if (!entry) continue;
      cards.push({
        key: `${key}#${entry.id}`,
        projectId: parts.projectId,
        worktreeId: parts.worktreeId,
        executionId: entry.id,
        pipelineName: entry.name,
        status: entry.status,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        workspaceName: label.workspaceName,
        worktreeName: label.worktreeName,
        hiddenCount:
          hiddenCount > 0 && index === visibleEntries.length - 1
            ? hiddenCount
            : undefined,
      });
    }
  }
  cards.sort(
    (a, b) =>
      (b.completedAt ? Date.parse(b.completedAt) : 0) -
      (a.completedAt ? Date.parse(a.completedAt) : 0),
  );
  return cards;
}

export function selectInProgressPipelineCards(
  runningExecutionsByWorktree: Record<string, Set<string>>,
  pipelineSummariesByWorktree: Record<string, WorktreePipelineEntry[]>,
  projects: SidebarItem[],
): OverviewPipelineCard[] {
  const cards: OverviewPipelineCard[] = [];
  for (const [key, executionIds] of Object.entries(
    runningExecutionsByWorktree,
  )) {
    const parts = splitWorktreeKey(key);
    if (!parts) continue;
    const label = buildWorktreeLabel(
      projects,
      parts.projectId,
      parts.worktreeId,
    );
    const summaryEntries = pipelineSummariesByWorktree[key] ?? [];
    const summariesById = new Map(
      summaryEntries.map((entry) => [entry.id, entry]),
    );

    for (const executionId of Array.from(executionIds)) {
      const summary = summariesById.get(executionId);
      cards.push({
        key: `${key}#${executionId}`,
        projectId: parts.projectId,
        worktreeId: parts.worktreeId,
        executionId,
        pipelineName: summary?.name ?? 'Pipeline',
        status: summary?.status ?? 'running',
        startedAt: summary?.startedAt,
        completedAt: summary?.completedAt,
        workspaceName: label.workspaceName,
        worktreeName: label.worktreeName,
      });
    }
  }
  cards.sort(
    (a, b) =>
      (b.startedAt ? Date.parse(b.startedAt) : 0) -
      (a.startedAt ? Date.parse(a.startedAt) : 0),
  );
  return cards;
}

/**
 * Returns all execution IDs that appear in `runningExecutionsByWorktree` but
 * do not yet have a hydrated `ExecutionState` in `statesById`. Used by
 * OverviewPage to fan out `loadExecutionDetails` calls with bounded
 * parallelism on mount.
 */
export function selectRunningExecutionIdsMissingState(
  runningExecutionsByWorktree: Record<string, Set<string>>,
  statesById: Record<string, ExecutionState>,
): string[] {
  const missing: string[] = [];
  for (const ids of Object.values(runningExecutionsByWorktree)) {
    for (const id of Array.from(ids)) {
      if (!statesById[id]) {
        missing.push(id);
      }
    }
  }
  return missing;
}
