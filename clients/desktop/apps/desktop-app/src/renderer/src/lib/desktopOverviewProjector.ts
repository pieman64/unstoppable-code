import type { SessionViewModel } from '@canopy/app-core';
import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { WorktreeChatState } from '@/stores/chatStore';
import type { WorktreePipelineEntry } from '@/stores/pipelineRunsStore';
import {
  selectInProgressChatCards,
  selectInProgressPipelineCards,
  selectUnreadChatCards,
  selectUnreadPipelineCards,
  type OverviewChatCard,
  type PlanExploreOriginResolver,
} from '@/lib/overviewSelectors';

export interface DesktopOverviewSource {
  readonly projects: SidebarItem[];
  readonly worktreeChats: Record<string, WorktreeChatState>;
  readonly unreadWorktreeKeys: Set<string>;
  readonly runningExecutionsByWorktree: Record<string, Set<string>>;
  readonly unseenPipelineWorktreeKeys: Set<string>;
  readonly pipelineSummariesByWorktree: Record<string, WorktreePipelineEntry[]>;
  readonly resolvePlanExplore: PlanExploreOriginResolver;
}

export interface DesktopOverviewChatRoute {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly tabId: string;
  readonly planExplore?: NonNullable<OverviewChatCard['planExplore']>;
}

/** What selecting an Overview chat card does. */
export type OverviewChatRouteAction =
  | {
      readonly kind: 'plan';
      readonly ref: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly planId: string;
      };
    }
  | {
      readonly kind: 'chat';
      readonly projectId: string;
      readonly worktreeId: string;
      readonly tabId: string;
    }
  | { readonly kind: 'none' };

/**
 * Resolve what selecting an Overview chat card does. A legacy plan chat
 * (the retired plan-explore scope) opens its plan's Plan panel when the
 * plan's owning worktree is known, and does nothing otherwise: the
 * synthetic scope is not a worktree and has no surface to show.
 */
export function overviewChatRouteAction(
  route: DesktopOverviewChatRoute,
): OverviewChatRouteAction {
  if (route.planExplore) {
    return { kind: 'plan', ref: route.planExplore };
  }
  if (route.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return { kind: 'none' };
  }
  return {
    kind: 'chat',
    projectId: route.projectId,
    worktreeId: route.worktreeId,
    tabId: route.tabId,
  };
}

export interface DesktopOverviewProjection {
  readonly snapshot: SessionViewModel;
  readonly chatRoutes: Readonly<Record<string, DesktopOverviewChatRoute>>;
  /** Extra terminal runs hidden by the desktop's five-card worktree cap. */
  readonly pipelineHiddenCounts: Readonly<Record<string, number>>;
}

interface ProjectedChat {
  card: OverviewChatCard;
  unread: boolean;
  streaming: boolean;
  awaitingApproval: boolean;
}

function emptySnapshot(): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
  };
}

function addChatCards(
  target: Map<string, ProjectedChat>,
  cards: OverviewChatCard[],
  kind: 'unread' | 'streaming',
): void {
  for (const card of cards) {
    const current = target.get(card.key) ?? {
      card,
      unread: false,
      streaming: false,
      awaitingApproval: false,
    };
    current[kind] = true;
    current.awaitingApproval ||= card.hasPendingPlanReview;
    target.set(card.key, current);
  }
}

/**
 * Project the desktop's authoritative overview selectors into the neutral
 * shared snapshot. The local selectors intentionally remain responsible for
 * unread/seen semantics and the terminal-pipeline five-card cap; this adapter
 * only reshapes their output.
 */
export function projectDesktopOverview(
  source: DesktopOverviewSource,
): DesktopOverviewProjection {
  const snapshot = emptySnapshot();
  const allowedProjectIds = new Set(
    source.projects.map((project) => project.id),
  );
  const chatIsInScope = (card: OverviewChatCard): boolean =>
    allowedProjectIds.has(card.planExplore?.projectId ?? card.projectId);
  snapshot.workspaces = source.projects.map((project) => ({
    localId: project.id,
    name: project.name,
    type: project.type,
    color: project.color,
    order: project.order,
    collapsed: project.collapsed,
    alwaysShow: project.alwaysShow,
    ...(project.type === 'multi-repo' ? { temporary: project.temporary } : {}),
  }));

  snapshot.worktrees = source.projects.flatMap((project) =>
    project.type === 'cowork'
      ? []
      : project.worktrees.map((worktree) => ({
          localId: worktree.id,
          workspaceLocalId: project.id,
          branch: worktree.branchName,
          label: worktree.label,
          hidden: worktree.hidden,
          status: worktree.status,
          createdAt: worktree.createdAt,
        })),
  );

  const projectedChats = new Map<string, ProjectedChat>();
  addChatCards(
    projectedChats,
    selectUnreadChatCards(
      source.worktreeChats,
      source.unreadWorktreeKeys,
      source.projects,
      source.resolvePlanExplore,
    ).filter(chatIsInScope),
    'unread',
  );
  addChatCards(
    projectedChats,
    selectInProgressChatCards(
      source.worktreeChats,
      source.projects,
      source.resolvePlanExplore,
    ).filter(chatIsInScope),
    'streaming',
  );

  const chatRoutes: Record<string, DesktopOverviewChatRoute> = {};
  for (const [key, projected] of Array.from(projectedChats.entries())) {
    const { card } = projected;
    const localId = `overview-chat:${key}`;
    const workspaceLocalId = card.planExplore?.projectId ?? card.projectId;
    snapshot.worktrees.push({
      localId,
      workspaceLocalId,
      branch: card.worktreeName,
      label: card.worktreeName,
      hasUnread: projected.unread,
      isStreaming: projected.streaming,
      awaitingApproval: projected.awaitingApproval,
    });
    snapshot.chatSummaries.push({
      localId,
      chatId: localId,
      scope: 'worktree',
      workspaceLocalId,
      worktreeLocalId: localId,
      title: card.tabTitle,
      description: card.preview || undefined,
      planMode: card.planExplore !== undefined,
    });
    chatRoutes[localId] = {
      projectId: card.projectId,
      worktreeId: card.worktreeId,
      tabId: card.tabId,
      ...(card.planExplore ? { planExplore: card.planExplore } : {}),
    };
  }

  const runningPipelines = selectInProgressPipelineCards(
    source.runningExecutionsByWorktree,
    source.pipelineSummariesByWorktree,
    source.projects,
  ).filter((card) => allowedProjectIds.has(card.projectId));
  const unreadPipelines = selectUnreadPipelineCards(
    source.pipelineSummariesByWorktree,
    source.unseenPipelineWorktreeKeys,
    source.projects,
  ).filter((card) => allowedProjectIds.has(card.projectId));
  const pipelineHiddenCounts: Record<string, number> = {};
  for (const card of unreadPipelines) {
    if (card.hiddenCount !== undefined && card.hiddenCount > 0) {
      pipelineHiddenCounts[card.executionId] = card.hiddenCount;
    }
  }
  snapshot.pipelineRuns = [...runningPipelines, ...unreadPipelines].map(
    (card) => ({
      localId: card.executionId,
      pipelineName: card.pipelineName,
      status: card.status,
      workspaceLocalId: card.projectId,
      worktreeLocalId: card.worktreeId,
      startedAt: card.startedAt,
      finishedAt: card.completedAt,
    }),
  );

  return { snapshot, chatRoutes, pipelineHiddenCounts };
}
