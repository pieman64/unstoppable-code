import {
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { ChatTab, WorktreeChatState } from '@/stores/chatStore';
import type { WorktreePipelineEntry } from '@/stores/pipelineRunsStore';
import {
  overviewChatRouteAction,
  projectDesktopOverview,
  type DesktopOverviewProjection,
} from '../desktopOverviewProjector';

function makeTab(overrides: Partial<ChatTab>): ChatTab {
  return {
    id: overrides.id ?? 'tab-1',
    title: overrides.title ?? 'Chat',
    messages: overrides.messages ?? [],
    status: overrides.status ?? 'idle',
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? '2026-07-15T12:00:00.000Z',
    queuedMessages: overrides.queuedMessages ?? [],
    planMode: overrides.planMode ?? false,
    thinkingLevel: overrides.thinkingLevel ?? 'high',
    proposalMode: overrides.proposalMode ?? 'optional',
    modelConfig: {
      thinkingLevel: overrides.thinkingLevel ?? 'high',
      speed: 'standard',
      fastMode: false,
    },
    fastModeExplicit: false,
    unread: overrides.unread,
    pendingPlanExit: overrides.pendingPlanExit,
    lastEventAt: overrides.lastEventAt,
  };
}

function projects(): SidebarItem[] {
  return [
    {
      type: 'single-repo',
      id: 'project-1',
      name: 'Project One',
      repoPath: '/tmp/project-one',
      color: '#123456',
      collapsed: false,
      order: 0,
      worktrees: [
        {
          id: 'worktree-1',
          branchName: 'feature/one',
          createdAt: '2026-07-15T12:00:00.000Z',
        },
      ],
    },
  ];
}

function pipelineEntry(
  id: string,
  status: WorktreePipelineEntry['status'],
): WorktreePipelineEntry {
  return {
    id,
    name: `Pipeline ${id}`,
    status,
    completedAt: `2026-07-15T12:00:${id.padStart(2, '0')}.000Z`,
  };
}

function syntheticRoute(
  projection: DesktopOverviewProjection,
): DesktopOverviewProjection['chatRoutes'][string] | undefined {
  const synthetic = projection.snapshot.worktrees.find((worktree) =>
    worktree.localId.startsWith('overview-chat:'),
  );
  return synthetic ? projection.chatRoutes[synthetic.localId] : undefined;
}

describe('projectDesktopOverview', () => {
  it('omits chat and pipeline records whose workspace is outside the supplied project scope', () => {
    const foreignChat: WorktreeChatState = {
      activeTabId: 'foreign-tab',
      tabs: [
        makeTab({
          id: 'foreign-tab',
          title: 'Foreign title',
          unread: true,
          status: 'streaming',
        }),
      ],
    };
    const projection = projectDesktopOverview({
      projects: projects(),
      worktreeChats: { 'project-foreign/worktree-foreign': foreignChat },
      unreadWorktreeKeys: new Set(['project-foreign/worktree-foreign']),
      runningExecutionsByWorktree: {
        'project-foreign/worktree-foreign': new Set(['foreign-run']),
      },
      unseenPipelineWorktreeKeys: new Set(['project-foreign/worktree-foreign']),
      pipelineSummariesByWorktree: {
        'project-foreign/worktree-foreign': [
          { id: 'foreign-run', name: 'Foreign pipeline', status: 'running' },
        ],
      },
      resolvePlanExplore: () => undefined,
    });

    expect(projection.snapshot.chatSummaries).toEqual([]);
    expect(projection.snapshot.pipelineRuns).toEqual([]);
  });

  it('projects exact chat routes and approval state into synthetic shared rows', () => {
    const worktreeChat: WorktreeChatState = {
      activeTabId: 'tab-1',
      tabs: [
        makeTab({
          id: 'tab-1',
          title: 'Review me',
          unread: true,
          status: 'streaming',
          pendingPlanExit: { plan: 'approve' },
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'The review is ready.' }],
              timestamp: 1,
            },
          ],
          lastEventAt: 12,
        }),
      ],
    };
    const projection = projectDesktopOverview({
      projects: projects(),
      worktreeChats: { 'project-1/worktree-1': worktreeChat },
      unreadWorktreeKeys: new Set(['project-1/worktree-1']),
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(),
      pipelineSummariesByWorktree: {},
      resolvePlanExplore: () => undefined,
    });

    const synthetic = projection.snapshot.worktrees.find((worktree) =>
      worktree.localId.startsWith('overview-chat:'),
    );
    expect(synthetic).toMatchObject({
      workspaceLocalId: 'project-1',
      hasUnread: true,
      isStreaming: true,
      awaitingApproval: true,
      label: 'feature/one',
    });
    expect(projection.snapshot.chatSummaries).toContainEqual(
      expect.objectContaining({
        chatId: synthetic?.localId,
        worktreeLocalId: synthetic?.localId,
        title: 'Review me',
        description: 'The review is ready.',
        planMode: false,
      }),
    );
    expect(projection.chatRoutes[synthetic?.localId ?? '']).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
    });
  });

  it('preserves plan-explore context for the shared card icon and route', () => {
    const projection = projectDesktopOverview({
      projects: projects(),
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'plan-tab',
          tabs: [
            makeTab({
              id: 'plan-tab',
              title: 'Explore plan',
              unread: true,
              messages: [
                {
                  id: 'assistant-plan',
                  role: 'assistant',
                  blocks: [{ type: 'text', text: 'Plan feedback is ready.' }],
                  timestamp: 1,
                },
              ],
            }),
          ],
        },
      },
      unreadWorktreeKeys: new Set([`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]),
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(),
      pipelineSummariesByWorktree: {},
      resolvePlanExplore: () => ({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    });

    const synthetic = projection.snapshot.worktrees.find((worktree) =>
      worktree.localId.startsWith('overview-chat:'),
    );
    expect(projection.snapshot.chatSummaries).toContainEqual(
      expect.objectContaining({
        chatId: synthetic?.localId,
        title: 'Explore plan',
        description: 'Plan feedback is ready.',
        planMode: true,
      }),
    );
    expect(projection.chatRoutes[synthetic?.localId ?? '']).toEqual({
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-1',
      tabId: 'plan-tab',
      planExplore: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        planId: 'plan-1',
      },
    });
  });

  it('omits a legacy plan chat card when its plan has no known owner', () => {
    const projection = projectDesktopOverview({
      projects: projects(),
      worktreeChats: {
        [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
          activeTabId: 'plan-tab',
          tabs: [
            makeTab({ id: 'plan-tab', title: 'Explore plan', unread: true }),
          ],
        },
      },
      unreadWorktreeKeys: new Set([`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]),
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(),
      pipelineSummariesByWorktree: {},
      resolvePlanExplore: () => undefined,
    });

    // Without an owner its workspace is outside every project scope
    // (CAN-3461), so there is no card to select.
    expect(syntheticRoute(projection)).toBeUndefined();
    // A route to the retired plan-chat scope is never treated as a worktree
    // (it has no surface and no Plan panel owner to open).
    expect(
      overviewChatRouteAction({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        tabId: 'plan-tab',
      }),
    ).toEqual({ kind: 'none' });
  });

  it('routes a resolved plan chat card to its plan and a chat card to its tab', () => {
    expect(
      overviewChatRouteAction({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        tabId: 'plan-tab',
        planExplore: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          planId: 'plan-1',
        },
      }),
    ).toEqual({
      kind: 'plan',
      ref: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        planId: 'plan-1',
      },
    });
    expect(
      overviewChatRouteAction({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
      }),
    ).toEqual({
      kind: 'chat',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
    });
  });

  it('keeps terminal pipeline seen-state and the five-card cap authoritative', () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      pipelineEntry(String(index + 1), 'success'),
    );
    const visible = projectDesktopOverview({
      projects: projects(),
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(['project-1/worktree-1']),
      pipelineSummariesByWorktree: {
        'project-1/worktree-1': entries,
      },
      resolvePlanExplore: () => undefined,
    });
    expect(visible.snapshot.pipelineRuns).toHaveLength(5);
    expect(
      visible.snapshot.pipelineRuns.every((run) => run.status === 'success'),
    ).toBe(true);
    expect(visible.pipelineHiddenCounts).toEqual({ '4': 3 });

    const seen = projectDesktopOverview({
      projects: projects(),
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
      runningExecutionsByWorktree: {},
      unseenPipelineWorktreeKeys: new Set(),
      pipelineSummariesByWorktree: {
        'project-1/worktree-1': entries,
      },
      resolvePlanExplore: () => undefined,
    });
    expect(seen.snapshot.pipelineRuns).toHaveLength(0);
  });

  it('keeps pending and running executions active beside terminal unread runs', () => {
    const projection = projectDesktopOverview({
      projects: projects(),
      worktreeChats: {},
      unreadWorktreeKeys: new Set(),
      runningExecutionsByWorktree: {
        'project-1/worktree-1': new Set(['run-pending', 'run-1']),
      },
      unseenPipelineWorktreeKeys: new Set(['project-1/worktree-1']),
      pipelineSummariesByWorktree: {
        'project-1/worktree-1': [
          { id: 'run-pending', name: 'Queued', status: 'pending' },
          { id: 'run-1', name: 'Build', status: 'running' },
          pipelineEntry('2', 'failure'),
        ],
      },
      resolvePlanExplore: () => undefined,
    });
    expect(projection.snapshot.pipelineRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localId: 'run-pending',
          status: 'pending',
        }),
        expect.objectContaining({ localId: 'run-1', status: 'running' }),
        expect.objectContaining({ localId: '2', status: 'failure' }),
      ]),
    );
  });
});
