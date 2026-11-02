import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AppAdvisorWatcherSummary,
  type ChatSearchCatalogEntry,
  type ChatSearchResult,
  type ScheduledActivity,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type { ChatTab, WorktreeChatState } from '@/stores/chat/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import {
  buildAgentItems,
  buildArchivedContainerItems,
  buildAutomationItems,
  buildChatContentItems,
  buildChatItems,
  buildCommandItems,
  buildPipelineItems,
  buildPlanItems,
  buildPluginItems,
  buildSettingItems,
  buildSkillItems,
  buildWatcherItems,
  buildWorktreeItems,
  buildWorktreeLabelIndex,
  collectContentDedupeIds,
  navigateToChatCatalogEntry,
} from '../paletteProviders';
import type { PaletteCommand } from '../paletteCommands';
import type { PaletteItem } from '../paletteItems';
import { rankPaletteItems } from '../paletteRanking';

jest.mock('@/lib/plans/open-tracked-plan', () => ({
  openTrackedPlan: jest.fn(),
}));

function makeChatTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-a',
    title: 'Login chat',
    createdAt: '2026-07-11T00:00:00.000Z',
    messages: [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false, speed: 'standard' },
    fastModeExplicit: false,
    proposalMode: 'optional',
    ...overrides,
  };
}

function makeAgent(
  overrides: Partial<AgentModelDefinition> = {},
): AgentModelDefinition {
  return {
    id: 'ag1',
    name: 'Reviewer',
    baseModel: 'opus',
    instructions: 'Review code carefully.\nMore detail here.',
    pluginSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    },
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'Formatter',
    description: 'Formats code',
    marketplaceId: 'mkt-1',
    sourcePath: '/plugins/formatter',
    providerSupport: { claude: 'native', codex: 'none' },
    facets: {},
    ...overrides,
  };
}

function makeWatcher(): AppAdvisorWatcherSummary {
  return {
    id: 'w1',
    label: 'PR watcher',
    trigger: 'worktree_pipeline_completion',
    status: 'active',
    target: {
      kind: 'worktree_pipeline',
      projectId: 'p',
      worktreeId: 'w',
    },
    destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeProjects(): SidebarItem[] {
  return [
    {
      type: 'single-repo',
      id: 'proj-1',
      name: 'Acme',
      repoPath: '/repos/acme',
      color: '#3366ff',
      collapsed: false,
      order: 0,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/login',
          createdAt: '2026-07-10T00:00:00.000Z',
          status: 'active',
        },
        {
          id: 'wt-2',
          branchName: 'feature/hidden',
          createdAt: '2026-07-10T00:00:00.000Z',
          hidden: true,
        },
        {
          id: 'wt-3',
          branchName: 'chore/cleanup',
          label: 'Cleanup',
          createdAt: '2026-07-10T00:00:00.000Z',
          status: 'done',
        },
      ],
    },
    {
      type: 'cowork',
      id: 'cowork-1',
      name: 'Scratchpad',
      color: '#ff6633',
      collapsed: false,
      order: 1,
    },
  ];
}

describe('buildWorktreeItems', () => {
  it('emits visible worktrees only, joining project name and status dot', () => {
    const items = buildWorktreeItems(makeProjects());
    expect(items.map((i) => i.title)).toEqual(['feature/login', 'Cleanup']);

    const login = items[0];
    expect(login.id).toBe('worktree:proj-1/wt-1');
    expect(login.kind).toBe('worktree');
    expect(login.subtitle).toBe('Acme');
    expect(login.worktreeStatus).toBe('idle');
    expect(login.keywords).toContain('feature/login');

    expect(items[1].worktreeStatus).toBe('done');
  });

  it('skips cowork projects (no worktrees)', () => {
    const items = buildWorktreeItems(makeProjects());
    expect(items.every((i) => i.id.startsWith('worktree:proj-1/'))).toBe(true);
  });

  it('indexes the worktree label and generated summary description', () => {
    const items = buildWorktreeItems(makeProjects(), {
      'proj-1/wt-3': {
        title: 'Dependency cleanup',
        description: 'Removes the obsolete glacier adapter',
        highlights: ['Deletes the compatibility shim'],
        generatedAt: '2026-07-11T00:00:00.000Z',
        turnCountAtGeneration: 4,
        lastFullRefreshAt: '2026-07-11T00:00:00.000Z',
        lastFullRefreshTurnCount: 4,
      },
    });
    const cleanup = items.find((item) => item.id === 'worktree:proj-1/wt-3');

    expect(cleanup?.title).toBe('Cleanup');
    expect(cleanup?.subtitle).toContain('Removes the obsolete glacier adapter');
    // Generated summaries draw on chat and diff content.
    expect(cleanup?.subtitleReplayBlocked).toBe(true);
    expect(
      items.find((item) => item.id === 'worktree:proj-1/wt-1')
        ?.subtitleReplayBlocked,
    ).toBe(false);
    expect(cleanup?.keywords).toEqual(
      expect.arrayContaining([
        'Cleanup',
        'Dependency cleanup',
        'Removes the obsolete glacier adapter',
      ]),
    );
  });
});

describe('buildWorktreeLabelIndex', () => {
  it('resolves worktree keys and cowork project names', () => {
    const index = buildWorktreeLabelIndex(makeProjects());
    expect(index.byKey.get('proj-1/wt-1')).toEqual({
      workspaceName: 'Acme',
      branchLabel: 'feature/login',
    });
    expect(index.byKey.get('proj-1/wt-3')?.branchLabel).toBe('Cleanup');
    expect(index.byProject.get('cowork-1')).toBe('Scratchpad');
  });
});

describe('buildArchivedContainerItems', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds a clearly archived row and opens the retained container', () => {
    const entry: ChatSearchCatalogEntry = {
      docId: 'proj-1/archive-1/__container__/archived-container',
      projectId: 'proj-1',
      worktreeId: 'archive-1',
      chatId: '__container__',
      source: 'archived-container',
      documentKind: 'archived-container',
      title: 'Retired glacier work',
      description: 'Removed the frozen transport adapter',
      updatedAt: 9,
      archivedAt: 8,
      messageCount: 2,
    };
    const openViewer = jest
      .spyOn(useArchivedContainersStore.getState(), 'openViewer')
      .mockImplementation();
    const index = buildWorktreeLabelIndex(makeProjects(), [entry]);
    const [item] = buildArchivedContainerItems([entry], index);

    expect(item).toEqual(
      expect.objectContaining({
        id: 'archive:proj-1/archive-1',
        kind: 'archive',
        title: 'Retired glacier work',
        subtitle: 'Acme • Removed the frozen transport adapter',
        archived: true,
        // No retention deadline in the catalog ⇒ locked ⇒ "Archived".
        archiveState: 'archived',
      }),
    );

    void item.execute();
    expect(openViewer).toHaveBeenCalledWith('proj-1', 'archive-1', undefined);
  });

  it('badges a container with a retention deadline as Deleted, and its chats too', () => {
    const containerEntry: ChatSearchCatalogEntry = {
      docId: 'proj-1/archive-2/__container__/archived-container',
      projectId: 'proj-1',
      worktreeId: 'archive-2',
      chatId: '__container__',
      source: 'archived-container',
      documentKind: 'archived-container',
      title: 'Deleted worktree',
      updatedAt: 9,
      archivedAt: 8,
      expiresAt: 99,
      messageCount: 2,
    };
    const chatEntry: ChatSearchCatalogEntry = {
      docId: 'proj-1/archive-2/chat-1/archived-container',
      projectId: 'proj-1',
      worktreeId: 'archive-2',
      chatId: 'chat-1',
      source: 'archived-container',
      documentKind: 'chat',
      title: 'Chat inside a deleted worktree',
      updatedAt: 9,
      archivedAt: 8,
      expiresAt: 99,
      messageCount: 2,
    };
    const index = buildWorktreeLabelIndex(makeProjects(), [containerEntry]);
    const [containerItem] = buildArchivedContainerItems(
      [containerEntry],
      index,
    );
    expect(containerItem.archiveState).toBe('deleted');
    const chatItems = buildChatItems({}, [chatEntry], index);
    expect(chatItems[0]?.archived).toBe(true);
    expect(chatItems[0]?.archiveState).toBe('deleted');
  });

  it('leaves legacy per-chat archives on the plain Archived badge', () => {
    const legacy: ChatSearchCatalogEntry = {
      docId: 'proj-1/wt-1/chat-z/worktree-archive',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-z',
      source: 'worktree-archive',
      title: 'Archived chat',
      updatedAt: 2,
      archivedAt: 2,
      expiresAt: 50,
      messageCount: 9,
    };
    const index = buildWorktreeLabelIndex(makeProjects());
    const [item] = buildChatItems({}, [legacy], index);
    expect(item.archived).toBe(true);
    expect(item.archiveState).toBeUndefined();
  });
});

describe('buildChatItems', () => {
  const index = buildWorktreeLabelIndex(makeProjects());

  function liveChat(overrides: Partial<ChatTab>): ChatTab {
    return makeChatTab(overrides);
  }

  const worktreeChats: Record<string, WorktreeChatState> = {
    'proj-1/wt-1': {
      activeTabId: 'chat-a',
      tabs: [
        liveChat({ id: 'chat-a', title: 'Login chat', providerType: 'claude' }),
        liveChat({ id: 'file-tab', title: 'README.md', kind: 'file' }),
      ],
    },
    [`${STANDALONE_CHAT_PROJECT_ID}/home`]: {
      activeTabId: 'c1',
      tabs: [liveChat({ id: 'c1', title: 'Cowork chat' })],
    },
  };

  it('builds live chat rows, joins project • branch, and filters file tabs', () => {
    const items = buildChatItems(worktreeChats, [], index);
    expect(items).toHaveLength(1);
    const chat = items[0];
    expect(chat.id).toBe('chat:proj-1/wt-1/chat-a');
    expect(chat.title).toBe('Login chat');
    expect(chat.subtitle).toBe('Acme • feature/login');
    expect(chat.providerType).toBe('claude');
    expect(chat.archived).toBe(false);
  });

  it('finds custom names in live results and clears back to existing title fields', () => {
    const renamed = liveChat({
      title: 'Original',
      description: 'Generated name',
      customTitle: 'Zebracorn',
    });
    const items = buildChatItems(
      { 'proj-1/wt-1': { activeTabId: renamed.id, tabs: [renamed] } },
      [],
      index,
    );
    expect(items[0]?.title).toBe('Zebracorn');
    expect(
      rankPaletteItems(items, 'Zebracorn')
        .sections.flatMap((section) => section.items)
        .map((row) => row.item.title),
    ).toEqual(['Zebracorn']);
    const cleared = { ...renamed, description: 'Latest generated name' };
    delete cleared.customTitle;
    const clearedItems = buildChatItems(
      { 'proj-1/wt-1': { activeTabId: cleared.id, tabs: [cleared] } },
      [],
      index,
    );
    expect(clearedItems[0]?.title).toBe('Original');
    expect(clearedItems[0]?.keywords).toContain('Latest generated name');
    expect(rankPaletteItems(clearedItems, 'Zebracorn').sections).toEqual([]);
  });

  it('excludes cowork worktree keys from tier 0', () => {
    const items = buildChatItems(worktreeChats, [], index);
    expect(items.some((i) => i.id.includes(STANDALONE_CHAT_PROJECT_ID))).toBe(
      false,
    );
  });

  it('excludes modal-only chat scopes from tier 0', () => {
    const modalChats: Record<string, WorktreeChatState> = {
      [`${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1`]: {
        activeTabId: 'plan-chat',
        tabs: [liveChat({ id: 'plan-chat', title: 'Plan chat' })],
      },
      [`${CODE_REVIEW_CHAT_PROJECT_ID}/review-1`]: {
        activeTabId: 'review-chat',
        tabs: [liveChat({ id: 'review-chat', title: 'Review chat' })],
      },
    };

    expect(buildChatItems(modalChats, [], index)).toEqual([]);
  });

  it('excludes modal-only chat scopes from catalog title rows', () => {
    const catalog = [
      {
        docId: `${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1/plan-chat/live`,
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        chatId: 'plan-chat',
        source: 'live',
        title: 'Plan chat',
        updatedAt: 1,
        messageCount: 1,
      },
      {
        docId: `${CODE_REVIEW_CHAT_PROJECT_ID}/review-1/review-chat/live`,
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-1',
        chatId: 'review-chat',
        source: 'live',
        title: 'Review chat',
        updatedAt: 1,
        messageCount: 1,
      },
    ] satisfies ChatSearchCatalogEntry[];

    expect(buildChatItems({}, catalog, index)).toEqual([]);
  });

  it('merges catalog entries and prefers live store data on dedupe', () => {
    const catalog: ChatSearchCatalogEntry[] = [
      {
        docId: 'proj-1/wt-1/chat-a/live',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-a',
        source: 'live',
        title: 'Stale catalog title',
        updatedAt: 1,
        messageCount: 3,
      },
      {
        docId: 'proj-1/wt-1/chat-z/worktree-archive',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-z',
        source: 'worktree-archive',
        title: 'Archived chat',
        updatedAt: 2,
        archivedAt: 2,
        messageCount: 9,
      },
    ];
    const items = buildChatItems(worktreeChats, catalog, index);
    const live = items.find((i) => i.id === 'chat:proj-1/wt-1/chat-a');
    const archived = items.find((i) => i.id === 'chat:proj-1/wt-1/chat-z');
    // Live store row wins over the stale catalog entry.
    expect(live?.title).toBe('Login chat');
    expect(archived?.title).toBe('Archived chat');
    expect(archived?.archived).toBe(true);
  });

  it('routes mirrored live App Advisor chats through the App Advisor action', async () => {
    const openAppAdvisor = jest
      .spyOn(useNavigationStore.getState(), 'openAppAdvisor')
      .mockImplementation();
    const mirrored: Record<string, WorktreeChatState> = {
      [`${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}`]: {
        activeTabId: 'advisor-chat',
        tabs: [liveChat({ id: 'advisor-chat', title: 'Advisor chat' })],
      },
    };
    const catalog: ChatSearchCatalogEntry[] = [
      {
        docId: `${APP_ADVISOR_PROJECT_ID}/${APP_ADVISOR_WORKTREE_ID}/advisor-chat/live`,
        projectId: APP_ADVISOR_PROJECT_ID,
        worktreeId: APP_ADVISOR_WORKTREE_ID,
        chatId: 'advisor-chat',
        source: 'live',
        title: 'Advisor chat',
        updatedAt: 1,
        messageCount: 1,
      },
    ];

    const [item] = buildChatItems(mirrored, catalog, index);
    await item.execute();

    // Target-level: the matched chat id is passed so the App Advisor window
    // opens focused on that exact chat's tab.
    expect(openAppAdvisor).toHaveBeenCalledTimes(1);
    expect(openAppAdvisor).toHaveBeenCalledWith({ chatId: 'advisor-chat' });
  });
});

describe('collectContentDedupeIds', () => {
  it('collects the item ids of chat, plan, and archive title rows', () => {
    const index = buildWorktreeLabelIndex(makeProjects());
    const items = buildChatItems(
      {
        'proj-1/wt-1': {
          activeTabId: 'a',
          tabs: [makeChatTab({ id: 'a', title: 'A', createdAt: '' })],
        },
      },
      [],
      index,
    );
    const archiveItem: PaletteItem = {
      id: 'archive:proj-1/archive-1',
      kind: 'archive',
      navigation: {
        type: 'archive',
        projectId: 'proj-1',
        containerId: 'archive-1',
      },
      title: 'Archived worktree',
      subtitle: 'Archive',
      execute: jest.fn(),
    };
    expect(collectContentDedupeIds([...items, archiveItem])).toEqual(
      new Set(['chat:proj-1/wt-1/a', 'archive:proj-1/archive-1']),
    );
  });
});

describe('buildPlanItems', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const planEntry: ChatSearchCatalogEntry = {
    docId: 'proj-1/wt-1/plan-1/plan',
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    chatId: 'plan-1',
    source: 'plan',
    title: 'Search rollout plan',
    updatedAt: 9,
    messageCount: 0,
    reviewStatus: 'approved',
  };

  it('builds plan rows from plan catalog entries only', () => {
    const index = buildWorktreeLabelIndex(makeProjects());
    const items = buildPlanItems(
      [
        planEntry,
        {
          docId: 'proj-1/wt-1/chat-a/live',
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-a',
          source: 'live',
          title: 'A chat',
          updatedAt: 1,
          messageCount: 1,
        },
      ],
      index,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: 'plan:proj-1/wt-1/plan-1',
        kind: 'plan',
        title: 'Search rollout plan',
        subtitle: 'Acme • feature/login',
        statusBadge: 'approved',
        timestamp: 9,
      }),
    );
  });

  it('excludes plan entries from chat rows', () => {
    const index = buildWorktreeLabelIndex(makeProjects());
    const items = buildChatItems({}, [planEntry], index);
    expect(items).toHaveLength(0);
  });

  it('opens the plan in its Plan panel through the tracked-plan opener', () => {
    const openPlan = jest.mocked(openTrackedPlan);
    openPlan.mockResolvedValue({ status: 'unavailable' });

    const index = buildWorktreeLabelIndex(makeProjects());
    const [item] = buildPlanItems([planEntry], index);
    void item.execute();

    // The opener navigates to the owning worktree itself (default
    // `navigate`), so the palette passes only the plan's ref.
    expect(openPlan).toHaveBeenCalledTimes(1);
    expect(openPlan).toHaveBeenCalledWith({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      planId: 'plan-1',
    });
  });

  it('opens a plan content result through the tracked-plan opener', () => {
    const openPlan = jest.mocked(openTrackedPlan);
    openPlan.mockResolvedValue({ status: 'unavailable' });
    const index = buildWorktreeLabelIndex(makeProjects());
    const [item] = buildChatContentItems(
      [{ ...planEntry, snippet: 'rollout', matchRanges: [] }],
      index,
      new Set(),
    );
    void item.execute();

    expect(openPlan).toHaveBeenCalledWith({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      planId: 'plan-1',
    });
  });

  it('opens an archived plan at the exact retained document', () => {
    const openViewer = jest
      .spyOn(useArchivedContainersStore.getState(), 'openViewer')
      .mockImplementation();
    const archivedPlan: ChatSearchCatalogEntry = {
      ...planEntry,
      docId: 'proj-1/archive-1/plan-1/archived-container-plan',
      worktreeId: 'archive-1',
      source: 'archived-container',
      documentKind: 'plan',
      expiresAt: 99,
    };
    const index = buildWorktreeLabelIndex(makeProjects());
    const [item] = buildPlanItems([archivedPlan], index);

    expect(item.archived).toBe(true);
    // Plans inside a Deleted container carry the container's state too.
    expect(item.archiveState).toBe('deleted');
    void item.execute();
    expect(openViewer).toHaveBeenCalledWith('proj-1', 'archive-1', {
      tab: 'plans',
      planId: 'plan-1',
    });
  });

  it('routes plan content results to plan rows with the snippet', () => {
    const index = buildWorktreeLabelIndex(makeProjects());
    const planResult: ChatSearchResult = {
      ...planEntry,
      snippet: 'the palindrome milestone',
      matchRanges: [{ start: 4, end: 14 }],
    };
    const items = buildChatContentItems([planResult], index, new Set());
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(
      expect.objectContaining({
        id: 'plan-content:proj-1/wt-1/plan-1',
        kind: 'plan',
        subtitle: 'the palindrome milestone',
        subtitleMatchRanges: [{ start: 4, end: 14 }],
      }),
    );

    expect(
      buildChatContentItems(
        [planResult],
        index,
        new Set(['plan:proj-1/wt-1/plan-1']),
      ),
    ).toHaveLength(0);
  });
});

describe('navigateToChatCatalogEntry', () => {
  const originalChatState = useChatStore.getState();
  const originalCoworkState = useStandaloneChatStore.getState();
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
    jest.restoreAllMocks();
    useChatStore.setState(originalChatState);
    useStandaloneChatStore.setState(originalCoworkState);
  });

  it('switches to the owning cowork project and opens its archive on the chat page', async () => {
    registerCoworkWorkspaceIds(['cowork-other']);
    let finishOpening: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      finishOpening = resolve;
    });
    const openArchive = jest
      .spyOn(useStandaloneChatStore.getState(), 'openArchivedChatFromSidebar')
      .mockReturnValue(opening);
    const navigate = jest.spyOn(useNavigationStore.getState(), 'navigate');

    const navigation = navigateToChatCatalogEntry({
      docId: 'cowork-other/home/archived/cowork-archive',
      projectId: 'cowork-other',
      worktreeId: 'home',
      chatId: 'archived',
      source: 'cowork-archive',
      title: 'Other workspace archive',
      updatedAt: 1,
      archivedAt: 1,
      messageCount: 1,
    });

    expect(openArchive).toHaveBeenCalledWith('cowork-other', 'archived');
    expect(navigate).not.toHaveBeenCalled();
    finishOpening?.();
    await navigation;
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  it('opens the owning cowork work entry before selecting a live chat', async () => {
    registerCoworkWorkspaceIds(['cowork-other']);
    const openEntry = jest
      .spyOn(useStandaloneChatStore.getState(), 'openWorkEntryFromSidebar')
      .mockImplementation(() => {
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-other',
          activeWorkEntryId: 'entry-1',
        });
        useChatStore.setState({
          worktreeChats: {
            'cowork-other/entry-1': {
              tabs: [makeChatTab({ id: 'chat-1' })],
              activeTabId: 'chat-1',
            },
          },
        });
        return Promise.resolve();
      });
    const switchTab = jest.spyOn(useChatStore.getState(), 'switchTab');
    const navigate = jest.spyOn(useNavigationStore.getState(), 'navigate');

    await navigateToChatCatalogEntry({
      docId: 'cowork-other/entry-1/chat-1/live',
      projectId: 'cowork-other',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      source: 'live',
      title: 'Cowork chat',
      updatedAt: 1,
      messageCount: 1,
    });

    expect(openEntry).toHaveBeenCalledWith('cowork-other', 'entry-1');
    expect(switchTab).toHaveBeenCalledWith('chat-1', {
      projectId: 'cowork-other',
      worktreeId: 'entry-1',
    });
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  it('hydrates a worktree before selecting and switching to its live chat', async () => {
    useProjectsStore.setState({
      projects: makeProjects(),
      hasHydratedProjects: true,
    });
    const calls: string[] = [];
    jest
      .spyOn(useChatStore.getState(), 'loadTabsForTarget')
      .mockImplementation(() => {
        calls.push('hydrate');
        useChatStore.setState({
          worktreeChats: {
            'proj-1/wt-1': {
              tabs: [makeChatTab({ id: 'chat-1' })],
              activeTabId: 'chat-1',
            },
          },
        });
        return Promise.resolve();
      });
    jest
      .spyOn(useChatStore.getState(), 'selectWorktree')
      .mockImplementation(() => {
        calls.push('select');
      });
    jest.spyOn(useChatStore.getState(), 'switchTab').mockImplementation(() => {
      calls.push('switch');
    });

    await navigateToChatCatalogEntry({
      docId: 'proj-1/wt-1/live/chat-1',
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      source: 'live',
      title: 'Hydrated chat',
      updatedAt: 1,
      archivedAt: null,
      messageCount: 1,
    });

    expect(calls).toEqual(['hydrate', 'select', 'switch']);
  });
});

describe('buildChatContentItems', () => {
  const index = buildWorktreeLabelIndex(makeProjects());
  const result: ChatSearchResult = {
    docId: 'proj-1/wt-1/chat-a/live',
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    chatId: 'chat-a',
    source: 'live',
    title: 'Login chat',
    updatedAt: 5,
    messageCount: 4,
    snippet: 'we should fix the login bug',
    matchRanges: [{ start: 17, end: 22 }],
  };

  it('maps FTS results to chat-content rows with snippet + ranges', () => {
    const items = buildChatContentItems([result], index, new Set());
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('chat-content');
    expect(items[0].id).toBe('chat-content:proj-1/wt-1/chat-a');
    expect(items[0].subtitle).toBe('we should fix the login bug');
    expect(items[0].subtitleMatchRanges).toEqual([{ start: 17, end: 22 }]);
  });

  it('drops transcript rows whose chat already appears as a title match', () => {
    const items = buildChatContentItems(
      [result],
      index,
      new Set(['chat:proj-1/wt-1/chat-a']),
    );
    expect(items).toHaveLength(0);
  });

  it('badges content rows owned by a retained container with its state', () => {
    const deletedChat: ChatSearchResult = {
      ...result,
      docId: 'proj-1/archive-1/chat-x/archived-container',
      worktreeId: 'archive-1',
      chatId: 'chat-x',
      source: 'archived-container',
      documentKind: 'chat',
      archivedAt: 4,
      expiresAt: 99,
    };
    const archivedPlan: ChatSearchResult = {
      ...result,
      docId: 'proj-1/archive-1/plan-1/archived-container-plan',
      worktreeId: 'archive-1',
      chatId: 'plan-1',
      source: 'archived-container',
      documentKind: 'plan',
      archivedAt: 4,
      expiresAt: null,
    };
    const containerRow: ChatSearchResult = {
      ...result,
      docId: 'proj-1/archive-1/__container__/archived-container',
      worktreeId: 'archive-1',
      chatId: '__container__',
      source: 'archived-container',
      documentKind: 'archived-container',
      archivedAt: 4,
      expiresAt: 99,
    };
    const items = buildChatContentItems(
      [deletedChat, archivedPlan, containerRow],
      index,
      new Set(),
    );
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get('chat-content:proj-1/archive-1/chat-x')?.archiveState).toBe(
      'deleted',
    );
    expect(byId.get('plan-content:proj-1/archive-1/plan-1')?.archiveState).toBe(
      'archived',
    );
    expect(byId.get('archive-content:proj-1/archive-1')?.archiveState).toBe(
      'deleted',
    );
  });

  it('excludes modal-only chat scopes from transcript rows', () => {
    const results: ChatSearchResult[] = [
      {
        ...result,
        docId: `${PLAN_EXPLORE_CHAT_PROJECT_ID}/plan-1/plan-chat/live`,
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-1',
        chatId: 'plan-chat',
      },
      {
        ...result,
        docId: `${CODE_REVIEW_CHAT_PROJECT_ID}/review-1/review-chat/live`,
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'review-1',
        chatId: 'review-chat',
      },
    ];

    expect(buildChatContentItems(results, index, new Set())).toEqual([]);
  });
});

describe('entity providers', () => {
  it('builds pipeline items without a source badge', () => {
    const pipelines: PipelineInfo[] = [
      {
        id: 'p1',
        name: 'Deploy',
        filename: 'p1.yaml',
        description: 'Ship it',
        icon: 'rocket',
        source: 'user',
        readonly: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        filePath: '/x/p1.yaml',
      },
    ];
    const [item] = buildPipelineItems(pipelines);
    expect(item).toMatchObject({
      id: 'pipeline:p1',
      kind: 'pipeline',
      title: 'Deploy',
      subtitle: 'Ship it',
    });
    expect(item).not.toHaveProperty('badge');
    expect(item.statusBadge).toBeUndefined();
    expect(item.timestamp).toBe(Date.parse('2026-07-01T00:00:00.000Z'));
  });

  it('builds automation items with a schedule subtitle and OFF badge', () => {
    const activities: ScheduledActivity[] = [
      {
        version: 1,
        id: 'a1',
        name: 'Nightly',
        enabled: false,
        schedule: { kind: 'cron', expression: '0 0 * * *', timezone: 'local' },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'proj-1',
          pipelineId: 'p1',
        },
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
        failureCount: 0,
      },
    ];
    const [item] = buildAutomationItems(activities);
    expect(item.title).toBe('Nightly');
    expect(item.subtitle).toContain('0 0 * * *');
    expect(item.statusBadge).toBe('OFF');
  });

  it('builds watcher items from label + trigger', () => {
    const watchers: AppAdvisorWatcherSummary[] = [makeWatcher()];
    const [item] = buildWatcherItems(watchers);
    expect(item).toMatchObject({ id: 'watcher:w1', title: 'PR watcher' });
    expect(item.statusBadge).toBeUndefined();
  });

  it('builds agent items using the first instruction line as subtitle', () => {
    const agents: AgentModelDefinition[] = [makeAgent()];
    const [item] = buildAgentItems(agents);
    expect(item.title).toBe('Reviewer');
    expect(item.subtitle).toBe('Review code carefully.');
    expect(item.subtitleReplayBlocked).toBe(true);
  });

  it('flags a watcher follow-up prompt subtitle for session replay', () => {
    const [prompted] = buildWatcherItems([
      { ...makeWatcher(), followUpInstruction: 'Summarize the failure' },
    ]);
    expect(prompted.subtitle).toBe('Summarize the failure');
    expect(prompted.subtitleReplayBlocked).toBe(true);
    const [plain] = buildWatcherItems([
      { ...makeWatcher(), followUpInstruction: undefined },
    ]);
    expect(plain.subtitleReplayBlocked).toBe(false);
  });

  it.each([
    [undefined, 'Alpha Tool'],
    ['   ', 'Alpha Tool'],
    ['dbt labs', 'dbt labs'],
  ])('normalizes plugin palette title %p', (displayName, expected): void => {
    const [item] = buildPluginItems([
      makePlugin({ name: 'alpha-tool', displayName }),
    ]);
    expect(item.title).toBe(expected);
    expect(item.navigation).toMatchObject({ pluginName: 'alpha-tool' });
  });

  it('builds plugin items keyed by marketplace + lowercased name', () => {
    const plugins: PluginInfo[] = [
      makePlugin({ category: 'tools', displayName: 'Code Formatter' }),
    ];
    const [item] = buildPluginItems(plugins);
    expect(item.id).toBe('plugin:mkt-1:formatter');
    expect(item.title).toBe('Code Formatter');
    expect(item.navigation).toMatchObject({ pluginName: 'Formatter' });
    expect(item).not.toHaveProperty('badge');
    expect(item.statusBadge).toBeUndefined();
  });

  it('finds an official wrapper by its product vendor', () => {
    // OpenAI's feed names itself author of the Teams wrapper, so searching
    // "Microsoft" in the palette missed Teams while the Plugins page, which
    // credits the vendor, found it.
    const [item] = buildPluginItems([
      makePlugin({
        name: 'teams',
        marketplaceId: 'openai-curated',
        author: 'OpenAI',
        providerSupport: { claude: 'none', codex: 'native' },
      }),
    ]);

    expect(item.keywords).toContain('Microsoft');
    // The marketplace id stays searchable, so "openai" still finds it.
    expect(item.keywords).toContain('openai-curated');
  });

  it('keeps the declared author searchable alongside the credited vendor', () => {
    // Keywords are matched, never displayed, so crediting the vendor must not
    // cost the search the feed's own author: a listing credited to Microsoft
    // but declared by "OpenAI Codex" should still answer to "codex".
    const [item] = buildPluginItems([
      makePlugin({
        name: 'teams',
        marketplaceId: 'openai-curated',
        author: 'OpenAI Codex',
        providerSupport: { claude: 'none', codex: 'native' },
      }),
    ]);

    expect(item.keywords).toContain('Microsoft');
    expect(item.keywords).toContain('OpenAI Codex');
  });

  it("keeps a plugin's own author outside the official feed", () => {
    const [item] = buildPluginItems([
      makePlugin({
        name: 'teams',
        marketplaceId: 'community-marketplace',
        author: 'Some Reseller',
      }),
    ]);

    expect(item.keywords).toContain('Some Reseller');
  });

  it('builds skill items with a viewer-ready identity', () => {
    const skills: InstalledSkillInfo[] = [
      {
        name: 'deep-research',
        sourceId: 'canopy',
        description: 'Research harness',
        source: 'canopy',
        installedAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
        updateAvailable: false,
        custom: true,
      },
    ];
    const [item] = buildSkillItems(skills);
    expect(item.id).toBe('skill:canopy:deep-research');
    expect(item).not.toHaveProperty('badge');
    expect(item.statusBadge).toBeUndefined();
  });

  it('builds settings items from the visible nav sections', () => {
    const items = buildSettingItems([
      { key: 'display', label: 'Display' },
      { key: 'git', label: 'Git' },
    ]);
    expect(items.map((i) => i.id)).toEqual(['setting:display', 'setting:git']);
    expect(items[0]).toMatchObject({ kind: 'setting', subtitle: 'Settings' });
  });

  it('wraps palette commands, carrying shortcuts without category badges', () => {
    const commands: PaletteCommand[] = [
      {
        id: 'open-settings',
        commandKey: 'open-settings',
        title: 'Open settings',
        category: 'settings',
        keywords: ['prefs'],
        shortcut: '⌘,',
        priority: 0,
        execute: (): { closePalette: boolean } => ({ closePalette: true }),
      },
    ];
    const [item] = buildCommandItems(commands);
    expect(item).toMatchObject({
      id: 'command:open-settings',
      kind: 'command',
      shortcut: '⌘,',
    });
    expect(item).not.toHaveProperty('badge');
    expect(item.statusBadge).toBeUndefined();
    expect(item.keywords).toEqual(['settings', 'prefs']);
  });
});
