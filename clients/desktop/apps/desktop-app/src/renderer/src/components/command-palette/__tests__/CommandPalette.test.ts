import {
  COMMAND_DEFINITIONS,
  dispatchOpenWorktreeSettingsEvent,
} from '@/lib/keyboardShortcuts';
import type * as KeyboardShortcutsModule from '@/lib/keyboardShortcuts';
import type { CommandDefinition } from '@/lib/keyboardShortcuts';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  useProjectsStore,
  type CreateWorktreeOptions,
} from '@/stores/projectsStore';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  getPaletteCommandAvailability,
  isPaletteCommandAvailable,
} from '../paletteAvailability';
import type { ChatTab } from '@/stores/chat/types';
import {
  buildBaseCommands,
  buildContextSwitchCommands,
  buildProjectCommands,
} from '../paletteCommands';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';

const originalCreateWorktree = useProjectsStore.getState().createWorktree;

jest.mock('@/lib/keyboardShortcuts', () => {
  const actual: typeof KeyboardShortcutsModule = jest.requireActual(
    '@/lib/keyboardShortcuts',
  );
  return {
    ...actual,
    dispatchOpenWorktreeSettingsEvent: jest.fn(),
  };
});

function findCommandDefinition(id: string): CommandDefinition {
  const definition = COMMAND_DEFINITIONS.find(
    (commandDefinition) => commandDefinition.id === id,
  );

  if (!definition) {
    throw new Error(`Missing command definition for ${id}`);
  }

  return definition;
}

describe('CommandPalette availability', () => {
  it('hides worktree-only commands when a normal worktree is not selected', () => {
    const newChatTabDefinition = findCommandDefinition('new-chat-tab');
    expect(
      isPaletteCommandAvailable(
        newChatTabDefinition,
        {
          hasNormalSelectedWorktree: false,
          hasActiveChatTab: false,
        },
        ['new-chat-tab'],
      ),
    ).toBe(false);
  });

  it('hides close chat tab until the selected worktree has an active tab', () => {
    const closeChatTabDefinition = findCommandDefinition('close-chat-tab');
    expect(
      isPaletteCommandAvailable(
        closeChatTabDefinition,
        {
          hasNormalSelectedWorktree: true,
          hasActiveChatTab: false,
        },
        ['close-chat-tab'],
      ),
    ).toBe(false);
    expect(
      isPaletteCommandAvailable(
        closeChatTabDefinition,
        {
          hasNormalSelectedWorktree: true,
          hasActiveChatTab: true,
        },
        ['close-chat-tab'],
      ),
    ).toBe(true);
  });
});

describe('CommandPalette availability for a file tab', () => {
  const worktreeKey = 'proj:wt';
  const chatTab: ChatTab = {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
  };
  const originalWorktreeChats = useChatStore.getState().worktreeChats;

  afterEach(() => {
    useChatStore.setState({ worktreeChats: originalWorktreeChats });
  });

  it('keeps Close Tab while a file tab is active, but not Session breakdown', () => {
    useChatStore.setState({
      worktreeChats: {
        [worktreeKey]: {
          tabs: [chatTab, { ...chatTab, id: 'file-1', kind: 'file' }],
          activeTabId: 'file-1',
        },
      },
    });
    const availability = getPaletteCommandAvailability(
      { projectId: 'proj', worktreeId: 'wt' },
      worktreeKey,
    );
    const available = (id: string): boolean =>
      isPaletteCommandAvailable(findCommandDefinition(id), availability, [
        'close-chat-tab',
        'open-session-breakdown',
      ]);

    expect(available('close-chat-tab')).toBe(true);
    expect(available('open-session-breakdown')).toBe(false);

    useChatStore.setState({
      worktreeChats: {
        [worktreeKey]: { tabs: [chatTab], activeTabId: 'chat-1' },
      },
    });
    const onChat = getPaletteCommandAvailability(
      { projectId: 'proj', worktreeId: 'wt' },
      worktreeKey,
    );
    expect(
      isPaletteCommandAvailable(
        findCommandDefinition('open-session-breakdown'),
        onChat,
        ['open-session-breakdown'],
      ),
    ).toBe(true);
  });
});

function resetNavigationStore(): void {
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    settingsInitialSection: undefined,
    commandPaletteOpen: false,
    commandPaletteInitialQuery: '',
    appAdvisorQuickPromptOpen: false,
    fileSearchPaletteOpen: false,
    fileSearchPaletteInitialQuery: '',
    workflowEdit: undefined,
  });
}

describe('CommandPalette worktree settings commands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetNavigationStore();
    useChatStore.setState(useChatStore.getInitialState());
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useProjectsStore.setState({ createWorktree: originalCreateWorktree });
    resetLabsExperimentsStoreForTest();
  });

  it('activates a project-scoped worktree at registration', async () => {
    let resolveCreate:
      | ((created: { id: string } | undefined) => void)
      | undefined;
    let onRegistered: ((worktree: WorktreeData) => void) | undefined;
    const createWorktree = jest.fn(
      (
        _projectId: string,
        options?: CreateWorktreeOptions,
      ): Promise<{ id: string } | undefined> =>
        new Promise((resolve) => {
          resolveCreate = resolve;
          onRegistered = options?.onRegistered;
        }),
    );
    useProjectsStore.setState({ createWorktree });
    const project: SidebarItem = {
      id: 'project-a',
      type: 'single-repo',
      name: 'Project A',
      repoPath: '/tmp/project-a',
      color: '#123456',
      order: 0,
      collapsed: false,
      worktrees: [],
      scripts: {},
      effectiveScripts: {},
      hooks: {},
      effectiveHooks: {},
    };
    const command = buildProjectCommands([project])[0];
    if (!command) {
      throw new Error('Missing project-scoped new worktree command');
    }

    const execution = command.execute();
    expect(useNavigationStore.getState().activePage).toBe('overview');

    onRegistered?.({
      id: 'wt-new',
      branchName: 'wt-new',
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    expect(useNavigationStore.getState().activePage).toBe('main');

    resolveCreate?.({ id: 'wt-new' });
    await expect(execution).resolves.toEqual({ closePalette: true });
  });

  it('navigates to main before opening worktree scripts', async () => {
    useNavigationStore.setState({ activePage: 'chat' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    const command = buildBaseCommands({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    }).find((candidate) => candidate.commandKey === 'open-worktree-scripts');

    if (!command) {
      throw new Error('Missing open-worktree-scripts command');
    }

    await expect(command.execute()).resolves.toEqual({ closePalette: true });
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(jest.mocked(dispatchOpenWorktreeSettingsEvent)).toHaveBeenCalledWith(
      'scripts',
    );
  });

  it('navigates to main before opening worktree hooks', async () => {
    useNavigationStore.setState({ activePage: 'plugins' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    const command = buildBaseCommands({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    }).find((candidate) => candidate.commandKey === 'open-worktree-hooks');

    if (!command) {
      throw new Error('Missing open-worktree-hooks command');
    }

    await expect(command.execute()).resolves.toEqual({ closePalette: true });
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(jest.mocked(dispatchOpenWorktreeSettingsEvent)).toHaveBeenCalledWith(
      'hooks',
    );
  });

  it('navigates to main and opens the file search palette', async () => {
    useNavigationStore.setState({ activePage: 'pipelines' });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'wt-1' },
    });

    const command = buildBaseCommands({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    }).find((candidate) => candidate.commandKey === 'open-file-search-palette');

    if (!command) {
      throw new Error('Missing open-file-search-palette command');
    }

    await expect(command.execute()).resolves.toEqual({ closePalette: true });
    expect(useNavigationStore.getState().activePage).toBe('main');
    expect(useNavigationStore.getState().fileSearchPaletteOpen).toBe(true);
  });

  it('blocks the file search palette command without a normal worktree', () => {
    useChatStore.setState({ selectedWorktree: null });

    const command = buildBaseCommands(null).find(
      (candidate) => candidate.commandKey === 'open-file-search-palette',
    );

    // requiresWorktree filters this command out entirely when no worktree is
    // selected, so it must not surface in the palette.
    expect(command).toBeUndefined();
    expect(useNavigationStore.getState().fileSearchPaletteOpen).toBe(false);
  });

  it('offers no Agents navigation command, only Marketplace (CAN-4266)', () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key] = true;
    useFeatureFlagsStore.setState({ snapshot });
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
    );

    const commands = buildBaseCommands(null);

    expect(
      commands.find((candidate) => candidate.commandKey === 'navigate-agents'),
    ).toBeUndefined();
    expect(
      commands.find((candidate) => candidate.commandKey === 'navigate-plugins'),
    ).toBeDefined();
  });

  it('offers the Labs page commands only while their experiments are on (CAN-3678)', () => {
    const labsCommands = [
      'navigate-overview',
      'navigate-audit',
      'navigate-statistics',
    ];
    const offered = (): string[] =>
      buildBaseCommands(null)
        .map((command) => command.commandKey)
        .filter((key) => labsCommands.includes(key));

    expect(offered()).toEqual([]);

    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ experiments: pageExperimentsOn() }),
    );
    expect(offered().sort()).toEqual([...labsCommands].sort());
  });
});

describe('CommandPalette context switch commands (CAN-2953)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function seed(
    enabled: boolean,
    organizations: Array<{ id: string; name: string }>,
  ): void {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = enabled;
    useFeatureFlagsStore.setState({ snapshot });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: organizations.map((organization) => ({
          ...organization,
          role: 'MEMBER' as const,
        })),
      },
      hydrated: true,
    });
  }

  afterEach(() => {
    seed(false, []);
  });

  it('offers nothing while the flag is off or the account has no organizations', () => {
    seed(false, [{ id: ORG_A, name: 'Acme' }]);
    expect(
      buildContextSwitchCommands(
        useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
        useWorkspaceContextStore.getState().state,
        useWorkspaceContextStore.getState().setContext,
      ),
    ).toEqual([]);
    seed(true, []);
    expect(
      buildContextSwitchCommands(
        useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
        useWorkspaceContextStore.getState().state,
        useWorkspaceContextStore.getState().setContext,
      ),
    ).toEqual([]);
    expect(
      buildBaseCommands(null).some((command) =>
        command.commandKey.startsWith('switch-context-'),
      ),
    ).toBe(false);
  });

  it('distinguishes duplicate organization titles without suffixing unique names', async (): Promise<void> => {
    seed(true, [
      { id: ORG_A, name: 'Acme' },
      { id: ORG_B, name: 'Acme' },
      { id: 'org-cccccc', name: 'Zen' },
    ]);
    const setContext = jest.fn().mockResolvedValue(undefined);
    const commands = buildContextSwitchCommands(
      true,
      useWorkspaceContextStore.getState().state,
      setContext,
    );
    expect(commands.map((command) => command.title)).toEqual([
      'Switch to Personal',
      'Switch to Acme aaaaaa',
      'Switch to Acme bbbbbb',
      'Switch to Zen',
    ]);
    await commands[2]?.execute();
    expect(setContext).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: ORG_B,
    });
  });

  it('lists Personal first, then organizations by name, and switches through the store', async () => {
    seed(true, [
      { id: ORG_B, name: 'Zen' },
      { id: ORG_A, name: 'Acme' },
    ]);
    const setContext = jest.fn().mockResolvedValue({
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 2,
      organizations: [],
    });
    useWorkspaceContextStore.setState({ setContext });

    const commands = buildContextSwitchCommands(
      true,
      useWorkspaceContextStore.getState().state,
      setContext,
    ).filter((command) => command.commandKey.startsWith('switch-context-'));
    expect(commands.map((command) => command.title)).toEqual([
      'Switch to Personal',
      'Switch to Acme',
      'Switch to Zen',
    ]);
    expect(commands[0]?.subtitle).toBe('Current context');

    await expect(commands[1]?.execute()).resolves.toEqual({
      closePalette: true,
    });
    expect(setContext).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: ORG_A,
    });

    setContext.mockRejectedValueOnce(new Error('stale-revision'));
    await expect(commands[2]?.execute()).resolves.toMatchObject({
      closePalette: false,
      error: "Couldn't switch context. Try again.",
    });
  });
});
