import { openSubagentsInSidePanel } from '../subagents-side-panel-open';

const mockOpenSubagentsPanel = jest.fn();
const mockFindSubagentsPanel = jest.fn();
const mockEnsureMinimalDestination = jest.fn();
let mockMode: 'minimal' | 'advanced' = 'minimal';
let mockGroups: Record<string, unknown> = {};

const mockSetSelectedRoot = jest.fn();
const mockSetFilter = jest.fn();
let mockActiveTabId: string | undefined = 'chat-current';

jest.mock('@canopy/ui-app/subagents', () => ({
  useSubagentViewStateStore: {
    getState: (): unknown => ({
      setSelectedRoot: mockSetSelectedRoot,
      setFilter: mockSetFilter,
    }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({
      worktreeChats: {
        'p/w': mockActiveTabId ? { activeTabId: mockActiveTabId } : undefined,
      },
    }),
  },
}));
jest.mock('../subagent-panel-open', () => ({
  openSubagentsPanel: (...args: unknown[]): unknown =>
    mockOpenSubagentsPanel(...args),
  findSubagentsPanel: (...args: unknown[]): unknown =>
    mockFindSubagentsPanel(...args),
}));
jest.mock('../minimal-layout', () => ({
  ensureMinimalDestination: (...args: unknown[]): unknown =>
    mockEnsureMinimalDestination(...args),
}));
jest.mock('@/stores/workspaceLayoutModeStore', () => ({
  getWorkspaceLayoutMode: (): string => mockMode,
}));
jest.mock('@/stores/panelLayoutStore', () => ({
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    `${projectId}:${worktreeId}`,
  usePanelLayoutStore: {
    getState: (): unknown => ({
      layouts: { 'p:w': { groups: mockGroups } },
    }),
  },
}));

const SCOPE = { projectId: 'p', worktreeId: 'w' };

beforeEach(() => {
  mockSetSelectedRoot.mockReset();
  mockSetFilter.mockReset();
  mockActiveTabId = 'chat-current';
  mockOpenSubagentsPanel.mockReset().mockResolvedValue({ status: 'opened' });
  mockFindSubagentsPanel.mockReset().mockReturnValue(null);
  mockEnsureMinimalDestination.mockReset().mockReturnValue('group-extras');
  mockMode = 'minimal';
  mockGroups = {};
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe('openSubagentsInSidePanel', () => {
  it('shows the current chat’s subagents that are still at work', async () => {
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockSetSelectedRoot).toHaveBeenCalledWith('p/w', 'chat-current');
    expect(mockSetFilter).toHaveBeenCalledWith('p/w', 'active');
  });

  it('keeps the panel’s own root choice without a current chat', async () => {
    mockActiveTabId = undefined;
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockSetSelectedRoot).not.toHaveBeenCalled();
    expect(mockSetFilter).toHaveBeenCalledWith('p/w', 'active');
  });

  it('opens Subagents in the Side Panel of a Minimal layout', async () => {
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockEnsureMinimalDestination).toHaveBeenCalledWith(
      'p:w',
      'subagents',
    );
    expect(mockOpenSubagentsPanel).toHaveBeenCalledWith(SCOPE, {
      intent: { groupId: 'group-extras' },
    });
  });

  it('reveals Subagents where it already is', async () => {
    mockFindSubagentsPanel.mockReturnValue({ groupId: 'group-chat' });
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockEnsureMinimalDestination).not.toHaveBeenCalled();
    expect(mockOpenSubagentsPanel).toHaveBeenCalledWith(SCOPE);
  });

  it('uses the right-hand group of an Advanced layout when it has one', async () => {
    mockMode = 'advanced';
    mockGroups = { 'group-extras': {} };
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockEnsureMinimalDestination).not.toHaveBeenCalled();
    expect(mockOpenSubagentsPanel).toHaveBeenCalledWith(SCOPE, {
      intent: { groupId: 'group-extras' },
    });
  });

  it('uses the Activity column of an Advanced layout without a Side Panel', async () => {
    mockMode = 'advanced';
    mockGroups = { 'group-chat': {}, 'group-activity': {} };
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockOpenSubagentsPanel).toHaveBeenCalledWith(SCOPE, {
      intent: { groupId: 'group-activity' },
    });
  });

  it('lets an Advanced layout without one place it as usual', async () => {
    mockMode = 'advanced';
    openSubagentsInSidePanel(SCOPE);
    await settle();
    expect(mockOpenSubagentsPanel).toHaveBeenCalledWith(SCOPE, {
      intent: 'auto',
    });
  });
});
