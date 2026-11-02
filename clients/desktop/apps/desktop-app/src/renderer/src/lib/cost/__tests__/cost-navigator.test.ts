import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import type { CostNavigator } from '@canopy/app-core';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import { openAutomationRunDestination } from '@/components/automations/resolveAutomationRunDestination';
import { requestChatPanelReveal } from '@/lib/chatPanelReveal';
import { openPipelineExecutionFromUi } from '@/lib/panels/open-pipeline-execution';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { loadChatTranscriptPage } from '@/stores/chat/transcript-pages';
import { openCostPanel, openSessionBreakdownPanel } from '../open-cost-panels';
import {
  costEntryScope,
  DESKTOP_COST_NAVIGATOR,
  openCostChat,
  subagentKindForCostTarget,
} from '../cost-navigator';

jest.mock('@/components/automations/resolveAutomationRunDestination', () => ({
  openAutomationRunDestination: jest.fn(),
}));
jest.mock('@/lib/chatPanelReveal', () => ({
  requestChatPanelReveal: jest.fn(),
}));
jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: jest.fn(),
}));
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: jest.fn(),
}));
jest.mock('@/stores/chat/transcript-pages', () => ({
  loadChatTranscriptPage: jest.fn(() => Promise.resolve()),
}));
jest.mock('../open-cost-panels', () => ({
  openCostPanel: jest.fn(),
  openSessionBreakdownPanel: jest.fn(),
}));

const ENTRY: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const RETAINED: CostScopeRef = {
  kind: 'retained',
  projectId: 'project-1',
  containerId: 'archive-1',
};

function requireCostNavigatorMethod<K extends keyof CostNavigator>(
  name: K,
): NonNullable<CostNavigator[K]> {
  const method = DESKTOP_COST_NAVIGATOR[name];
  if (method === undefined) {
    throw new Error(`Desktop cost navigator does not implement ${name}`);
  }
  return method;
}

beforeEach(() => {
  jest.clearAllMocks();
  useChatStore.setState({
    selectedWorktree: null,
    worktreeChats: {},
    archivedChats: {},
    loadTabsForTarget: jest.fn(() => Promise.resolve()),
    loadArchivedChats: jest.fn(() => Promise.resolve()),
    restoreArchivedChat: jest.fn(() => Promise.resolve()),
  });
});

test('returns an entry scope only for active entries', () => {
  expect(costEntryScope(ENTRY)).toEqual({
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  });
  expect(costEntryScope(RETAINED)).toBeNull();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

test('routes every navigator target to the desktop destination', async () => {
  requireCostNavigatorMethod('openSessionBreakdown')(ENTRY, 'chat-1');
  expect(openSessionBreakdownPanel).toHaveBeenCalledWith(
    { projectId: 'project-1', worktreeId: 'worktree-1' },
    'chat-1',
  );

  requireCostNavigatorMethod('openCostPanel')(ENTRY);
  expect(openCostPanel).toHaveBeenCalledWith({
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  });

  requireCostNavigatorMethod('openPipelineRun')(ENTRY, 'run-1');
  expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
    executionId: 'run-1',
    owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
    target: { entry: 'cost' },
  });

  requireCostNavigatorMethod('openPipelineJob')(ENTRY, 'run-2', 'job-3');
  expect(openPipelineExecutionFromUi).toHaveBeenCalledWith({
    executionId: 'run-2',
    owner: { projectId: 'project-1', worktreeId: 'worktree-1' },
    target: { jobId: 'job-3' },
  });

  requireCostNavigatorMethod('openSubagent')(ENTRY, {
    chatId: 'root-1',
    subagentId: 'agent-1',
    kind: 'claude_task',
  });
  await flush();
  expect(openSubagentChatPanel).toHaveBeenCalledWith(
    { projectId: 'project-1', worktreeId: 'worktree-1' },
    {
      rootChatId: 'root-1',
      subagentId: 'agent-1',
      subagentKind: 'claude-native',
      title: '',
    },
  );
});

describe('opening a subagent', () => {
  function seedRootChat(tab: Partial<ChatTab>): void {
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          tabs: [{ id: 'root-1', title: 'Root', messages: [], ...tab }],
          activeTabId: 'other-chat',
        },
      },
    } as unknown as Partial<ReturnType<typeof useChatStore.getState>>);
  }

  it('loads a root chat whose transcript is not loaded before opening the panel', async () => {
    seedRootChat({
      transcript: { transcriptRevision: 1 },
      transcriptLoaded: false,
    } as Partial<ChatTab>);
    const order: string[] = [];
    jest.mocked(loadChatTranscriptPage).mockImplementationOnce(() => {
      order.push('load-root');
      return Promise.resolve();
    });
    jest.mocked(openSubagentChatPanel).mockImplementationOnce(() => {
      order.push('open-panel');
      return Promise.resolve({ status: 'failed' });
    });

    requireCostNavigatorMethod('openSubagent')(ENTRY, {
      chatId: 'root-1',
      subagentId: 'agent-1',
      kind: 'delegation',
    });
    await flush();

    expect(loadChatTranscriptPage).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-1',
    });
    expect(order).toEqual(['load-root', 'open-panel']);
  });

  it('opens the panel without a read when the root chat is already loaded', async () => {
    seedRootChat({
      transcript: { transcriptRevision: 1 },
      transcriptLoaded: true,
    } as Partial<ChatTab>);

    requireCostNavigatorMethod('openSubagent')(ENTRY, {
      chatId: 'root-1',
      subagentId: 'agent-1',
      kind: 'delegation',
    });
    await flush();

    expect(loadChatTranscriptPage).not.toHaveBeenCalled();
    expect(openSubagentChatPanel).toHaveBeenCalledTimes(1);
  });

  it('still opens the panel when the root chat cannot be read', async () => {
    seedRootChat({
      transcript: { transcriptRevision: 1 },
      transcriptLoaded: false,
    } as Partial<ChatTab>);
    jest
      .mocked(loadChatTranscriptPage)
      .mockRejectedValueOnce(new Error('offline'));

    requireCostNavigatorMethod('openSubagent')(ENTRY, {
      chatId: 'root-1',
      subagentId: 'agent-1',
      kind: 'delegation',
    });
    await flush();

    expect(openSubagentChatPanel).toHaveBeenCalledTimes(1);
  });
});

test('opens an archived root chat read-only instead of a subagent panel that cannot load', async () => {
  const dispatched: string[] = [];
  const originalWindow: unknown = Reflect.get(globalThis, 'window');
  const originalFrame: unknown = Reflect.get(
    globalThis,
    'requestAnimationFrame',
  );
  Reflect.set(globalThis, 'window', {
    dispatchEvent: (event: Event): boolean => {
      dispatched.push(event.type);
      return true;
    },
  });
  Reflect.set(
    globalThis,
    'requestAnimationFrame',
    (run: () => void): number => {
      run();
      return 0;
    },
  );
  const selectWorktree = jest.fn();
  useChatStore.setState({
    worktreeChats: {},
    archivedChats: {
      'project-1/worktree-1': [
        {
          chatId: 'root-archived',
          title: 'Archived root',
          turnCount: 1,
          archivedAt: '2026-10-01T00:00:00.000Z',
          createdAt: '2026-09-30T00:00:00.000Z',
          restorable: true,
          unread: false,
        },
      ],
    },
    selectWorktree,
  });
  try {
    requireCostNavigatorMethod('openSubagent')(ENTRY, {
      chatId: 'root-archived',
      subagentId: 'agent-1',
      kind: 'claude_task',
    });
    await flush();
    await flush();

    expect(openSubagentChatPanel).not.toHaveBeenCalled();
    expect(selectWorktree).toHaveBeenCalledWith('project-1', 'worktree-1');
    expect(dispatched).toHaveLength(1);
    // Opening the subagent never restores the chat; Open chat does that.
    expect(useChatStore.getState().restoreArchivedChat).not.toHaveBeenCalled();
  } finally {
    Reflect.set(globalThis, 'window', originalWindow);
    Reflect.set(globalThis, 'requestAnimationFrame', originalFrame);
  }
});

describe('an archived Cowork chat', () => {
  const COWORK_SCOPE = { projectId: 'cowork-1', worktreeId: 'entry-1' };
  const navigate = jest.fn();
  const selectWorktree = jest.fn();
  let originalNavigate: ReturnType<
    typeof useNavigationStore.getState
  >['navigate'];
  let originalProjects: ReturnType<
    typeof useProjectsStore.getState
  >['projects'];
  let originalWindow: unknown;
  let originalFrame: unknown;

  function seedArchivedChat(restorable: boolean): void {
    useChatStore.setState({
      worktreeChats: {},
      archivedChats: {
        'cowork-1/entry-1': [
          {
            chatId: 'cowork-archived',
            title: 'Archived Cowork chat',
            turnCount: 1,
            archivedAt: '2026-10-01T00:00:00.000Z',
            createdAt: '2026-09-30T00:00:00.000Z',
            restorable,
            unread: false,
          },
        ],
      },
      selectWorktree,
    });
  }

  beforeEach(() => {
    navigate.mockReset();
    selectWorktree.mockReset();
    originalNavigate = useNavigationStore.getState().navigate;
    originalProjects = useProjectsStore.getState().projects;
    // The Code page's path raises a window event on the next frame.
    originalWindow = Reflect.get(globalThis, 'window');
    originalFrame = Reflect.get(globalThis, 'requestAnimationFrame');
    Reflect.set(globalThis, 'window', { dispatchEvent: (): boolean => true });
    Reflect.set(globalThis, 'requestAnimationFrame', (): number => 0);
    useNavigationStore.setState({ navigate });
    useProjectsStore.setState({
      projects: [
        { id: 'cowork-1', type: 'cowork', worktrees: [] },
      ] as unknown as ReturnType<typeof useProjectsStore.getState>['projects'],
    });
    jest.mocked(openAutomationRunDestination).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    useNavigationStore.setState({ navigate: originalNavigate });
    useProjectsStore.setState({ projects: originalProjects });
    Reflect.set(globalThis, 'window', originalWindow);
    Reflect.set(globalThis, 'requestAnimationFrame', originalFrame);
  });

  it('opens read-only on the Cowork page, never on the Code page', async () => {
    seedArchivedChat(false);

    await openCostChat(COWORK_SCOPE, 'cowork-archived');

    expect(openAutomationRunDestination).toHaveBeenCalledTimes(1);
    expect(openAutomationRunDestination).toHaveBeenCalledWith({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'cowork-archived',
    });
    expect(navigate).not.toHaveBeenCalledWith('main');
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().restoreArchivedChat).not.toHaveBeenCalled();
  });

  it('opens its archived root chat on the Cowork page for a subagent', async () => {
    seedArchivedChat(true);

    requireCostNavigatorMethod('openSubagent')(
      { kind: 'entry', ...COWORK_SCOPE },
      { chatId: 'cowork-archived', subagentId: 'agent-1', kind: 'delegation' },
    );
    await flush();
    await flush();

    expect(openSubagentChatPanel).not.toHaveBeenCalled();
    expect(openAutomationRunDestination).toHaveBeenCalledWith({
      kind: 'cowork-chat',
      workspaceId: 'cowork-1',
      chatId: 'cowork-archived',
    });
    expect(navigate).not.toHaveBeenCalledWith('main');
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(useChatStore.getState().restoreArchivedChat).not.toHaveBeenCalled();
  });
});

test('maps cost subagent kinds to their panel kinds', () => {
  expect(subagentKindForCostTarget('claude_task')).toBe('claude-native');
  expect(subagentKindForCostTarget('codex_agent')).toBe('codex-native');
  expect(subagentKindForCostTarget('delegation')).toBe('managed');
});

test('ignores every navigation request for a retained scope', () => {
  requireCostNavigatorMethod('openSessionBreakdown')(RETAINED, 'chat-1');
  requireCostNavigatorMethod('openCostPanel')(RETAINED);
  requireCostNavigatorMethod('openPipelineRun')(RETAINED, 'run-1');
  requireCostNavigatorMethod('openPipelineJob')(RETAINED, 'run-1', 'job-1');
  requireCostNavigatorMethod('openSubagent')(RETAINED, {
    chatId: 'root-1',
    subagentId: 'agent-1',
    kind: 'delegation',
  });
  requireCostNavigatorMethod('openChat')(RETAINED, 'chat-1');

  expect(openSessionBreakdownPanel).not.toHaveBeenCalled();
  expect(openCostPanel).not.toHaveBeenCalled();
  expect(openPipelineExecutionFromUi).not.toHaveBeenCalled();
  expect(openSubagentChatPanel).not.toHaveBeenCalled();
  expect(openAutomationRunDestination).not.toHaveBeenCalled();
});

test('restores a restorable archived chat before opening and revealing it', async () => {
  const order: string[] = [];
  const key = 'project-1/worktree-1';
  const restoreArchivedChat = jest.fn((): Promise<void> => {
    order.push('restore');
    return Promise.resolve();
  });
  useChatStore.setState({
    selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    worktreeChats: {},
    archivedChats: {
      [key]: [
        {
          chatId: 'archived-chat',
          title: 'Archived title',
          turnCount: 1,
          archivedAt: '2026-10-01T00:00:00.000Z',
          createdAt: '2026-09-30T00:00:00.000Z',
          restorable: true,
          unread: false,
        },
      ],
    },
    loadTabsForTarget: jest.fn(() => Promise.resolve()),
    loadArchivedChats: jest.fn(() => Promise.resolve()),
    restoreArchivedChat,
  });
  jest.mocked(openAutomationRunDestination).mockImplementation(() => {
    order.push('open');
    return Promise.resolve({ ok: true });
  });
  jest.mocked(requestChatPanelReveal).mockImplementation(() => {
    order.push('reveal');
  });

  await openCostChat(
    { projectId: 'project-1', worktreeId: 'worktree-1' },
    'archived-chat',
  );

  expect(order).toEqual(['restore', 'open', 'reveal']);
  expect(openAutomationRunDestination).toHaveBeenCalledWith({
    kind: 'worktree-chat',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'archived-chat',
  });
});

test('opens a live App Advisor chat without loading an archive', async () => {
  const key = `${APP_ADVISOR_PROJECT_ID}/entry-1`;
  const chat = {
    id: 'chat-1',
    title: 'Advisor chat',
    messages: [],
    status: 'idle' as const,
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional' as const,
    thinkingLevel: 'high' as const,
    modelConfig: {
      thinkingLevel: 'high' as const,
      speed: 'standard' as const,
      fastMode: false,
    },
    fastModeExplicit: false,
  };
  useChatStore.setState({
    worktreeChats: {
      [key]: { activeTabId: 'chat-1', tabs: [chat] },
    },
  });
  jest.mocked(openAutomationRunDestination).mockResolvedValue({ ok: true });

  await openCostChat(
    { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry-1' },
    'chat-1',
  );

  expect(openAutomationRunDestination).toHaveBeenCalledWith({
    kind: 'app-advisor-chat',
    chatId: 'chat-1',
  });
});
