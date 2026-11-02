/**
 * @jest-environment jsdom
 */
import type {
  ChatTabPluginSelections,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  homeDraftChatPluginSelections,
  resolveHomeFastMode,
  resolveHomeSpeed,
  splitHomeDraftPluginSelections,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { dispatchHomeSend } from '@/components/home/homeSend';
import { createEmptySelections } from '@/lib/pluginSelections';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  initCodexModels,
} from '@canopy/desktop-shared/types';

jest.mock('@/lib/chatAttachments', () => ({
  importChatAttachments: jest.fn(),
}));
jest.mock('@/lib/automationToasts', () => ({
  showAutomationCreatedToast: jest.fn(),
}));
jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/lib/chatPluginEditing', () => ({
  applyNewChatPluginSelections: jest.fn(() => Promise.resolve()),
}));

function selections(
  mcpServerRefs: { serverId: string; configId: string }[],
): ChatTabPluginSelections {
  return { ...createEmptySelections(), mcpServerRefs };
}

function seedProject(defaults: ChatTabPluginSelections | undefined): void {
  // Always start from a clean project: spreading the previous seed would let
  // one test's `defaultPluginSelections` leak into the next.
  const project: SingleRepoSidebarItem = {
    id: 'ws',
    name: 'ws',
    type: 'single-repo',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...(defaults ? { defaultPluginSelections: defaults } : {}),
  };
  useProjectsStore.setState((state) => ({
    ...state,
    projects: [project],
  }));
}

describe('syncWorkspaceDefaultPluginSelections', () => {
  beforeEach(() => {
    useHomeComposerStore.getState().reset();
    seedProject(undefined);
  });

  it('rebases an unedited working set when defaults arrive after selection', () => {
    // selectWorkspace runs before the async projects load resolves defaults:
    // the seeded working set is empty.
    useHomeComposerStore.getState().selectWorkspace('ws');
    expect(
      useHomeComposerStore.getState().pluginSelections?.mcpServerRefs ?? [],
    ).toHaveLength(0);

    // Defaults finish loading; the unedited draft must pick them up so
    // suggestion eligibility and the send path agree.
    seedProject(selections([{ serverId: 'github', configId: 'default' }]));
    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(
      (
        useHomeComposerStore.getState().pluginSelections?.mcpServerRefs ?? []
      ).map((r) => r.serverId),
    ).toEqual(['github']);
  });

  it('never overrides an explicitly edited working set', () => {
    seedProject(selections([{ serverId: 'github', configId: 'default' }]));
    useHomeComposerStore.getState().selectWorkspace('ws');
    // The user explicitly removes the workspace-default server.
    useHomeComposerStore.getState().setPluginSelections(selections([]));

    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(
      useHomeComposerStore.getState().pluginSelections?.mcpServerRefs ?? [],
    ).toHaveLength(0);
  });

  it('is a no-op without a selected project', () => {
    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(useHomeComposerStore.getState().pluginSelections).toBeNull();
  });
});

describe('plugin selections for a Cursor draft', () => {
  beforeEach(() => {
    useHomeComposerStore.getState().reset();
    seedProject(undefined);
  });

  it('keeps a picker save when the draft runs on Cursor', () => {
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore.getState().setModel('cursor-default');
    useHomeComposerStore
      .getState()
      .setPluginSelections(
        selections([{ serverId: 'e2e', configId: 'default' }]),
      );
    expect(
      useHomeComposerStore.getState().pluginSelections?.mcpServerRefs,
    ).toEqual([{ serverId: 'e2e', configId: 'default' }]);
    expect(useHomeComposerStore.getState().pluginSelectionsEdited).toBe(true);
  });

  it('applies workspace default MCP servers to a Cursor draft', () => {
    seedProject(selections([{ serverId: 'default-server', configId: 'a' }]));
    useHomeComposerStore.getState().setModel('cursor-default');
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(
      useHomeComposerStore.getState().pluginSelections?.mcpServerRefs,
    ).toEqual([{ serverId: 'default-server', configId: 'a' }]);
  });
});

describe('a Cursor draft keeps skills and Collections', () => {
  const selected = {
    collectionIds: ['col-a'],
    skillRefs: [{ sourceId: 'custom:local', skillName: 'review' }],
  };

  beforeEach(() => {
    useHomeComposerStore.getState().reset();
    seedProject(undefined);
  });

  it('applies workspace default skills to a Cursor draft when defaults sync', () => {
    seedProject({
      ...createEmptySelections(),
      ...selected,
      mcpServerRefs: [{ serverId: 'd', configId: 'a' }],
    });
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore.getState().setModel('cursor-default');
    useHomeComposerStore.getState().syncWorkspaceDefaultPluginSelections();
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject({
      ...selected,
      mcpServerRefs: [{ serverId: 'd', configId: 'a' }],
    });
  });

  it('keeps skills from a picker save for a Cursor draft', () => {
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore.getState().setModel('cursor-default');
    useHomeComposerStore.getState().setPluginSelections({
      ...createEmptySelections(),
      ...selected,
      mcpServerRefs: [{ serverId: 'e2e', configId: 'default' }],
    });
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject({
      ...selected,
      mcpServerRefs: [{ serverId: 'e2e', configId: 'default' }],
    });
  });

  it('keeps a workspace default the user removed while on Cursor removed after leaving Cursor', () => {
    seedProject({ ...createEmptySelections(), ...selected });
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore.getState().setModel('cursor-default');
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject(
      selected,
    );
    // The picker save is the user's whole working set: everything unchecked.
    useHomeComposerStore
      .getState()
      .setPluginSelections(createEmptySelections());
    useHomeComposerStore.getState().setModel('sonnet');
    expect(useHomeComposerStore.getState().pluginSelections).toEqual(
      createEmptySelections(),
    );
  });

  it('carries an edited selection unchanged across a switch to and from Cursor', () => {
    useHomeComposerStore.getState().selectWorkspace('ws');
    useHomeComposerStore
      .getState()
      .setPluginSelections({ ...createEmptySelections(), ...selected });
    useHomeComposerStore.getState().setModel('cursor-default');
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject(
      selected,
    );
    useHomeComposerStore.getState().setModel('sonnet');
    expect(useHomeComposerStore.getState().pluginSelections).toMatchObject(
      selected,
    );
  });
});

describe('Home draft plugin selections for the created chat', () => {
  const chatSelections = (
    mcpServerRefs: { serverId: string; configId: string }[],
  ): ChatTabPluginSelections => ({
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs,
  });

  beforeEach(() => {
    useHomeComposerStore.getState().reset();
    seedProject(undefined);
  });

  it('keeps workspace defaults out of the chat and turns removed ones off', () => {
    const defaults = selections([
      { serverId: 'github', configId: 'default' },
      { serverId: 'linear', configId: 'default' },
    ]);
    const draft = selections([
      { serverId: 'github', configId: 'default' },
      { serverId: 'slack', configId: 'default' },
    ]);

    expect(splitHomeDraftPluginSelections(draft, defaults)).toEqual({
      pluginSelections: chatSelections([
        { serverId: 'slack', configId: 'default' },
      ]),
      disabledGlobalPluginSelections: {
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      },
    });
  });

  it('omits tombstones when the draft keeps every default', () => {
    const defaults = selections([{ serverId: 'github', configId: 'default' }]);

    expect(splitHomeDraftPluginSelections(defaults, defaults)).toEqual({
      pluginSelections: chatSelections([]),
    });
  });

  it('splits against the selected workspace defaults the draft was seeded from', () => {
    seedProject(selections([{ serverId: 'github', configId: 'default' }]));
    useHomeComposerStore.getState().selectWorkspace('ws');
    const draft = useHomeComposerStore.getState().pluginSelections;

    expect(homeDraftChatPluginSelections(draft, 'ws')).toEqual({
      pluginSelections: chatSelections([]),
    });
    expect(homeDraftChatPluginSelections(null, 'ws')).toBeNull();
  });

  it('keeps the whole draft for surfaces that do not inherit defaults', () => {
    const draft = selections([{ serverId: 'github', configId: 'default' }]);

    expect(
      homeDraftChatPluginSelections(draft, APP_ADVISOR_PROJECT_ID),
    ).toEqual({ pluginSelections: draft });
  });
});

describe('Home Codex speed draft', () => {
  const CODEX_MODEL = 'gpt-6-sol';

  function setCodexDefaults(codex: {
    speed?: 'standard' | 'fast' | 'ultrafast';
    fastMode?: boolean;
  }): void {
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'codex',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: { model: 'claude-sonnet-4-6', thinkingLevel: 'high' },
          codex: { model: CODEX_MODEL, thinkingLevel: 'high' },
          ollama: null,
        },
        modelConfigDefaultsByProvider: { codex },
      },
    });
  }

  beforeAll(() => {
    initCodexModels([{ id: CODEX_MODEL, label: 'Codex' }]);
  });

  beforeEach(() => {
    useHomeComposerStore.getState().reset();
    useChatStore.setState({ modelDefaults: null });
    seedProject(undefined);
  });

  afterEach(() => {
    useHomeComposerStore.getState().reset();
    useChatStore.setState({ modelDefaults: null });
  });

  it('stages an exact speed across destinations with its legacy projection', () => {
    setCodexDefaults({ speed: 'fast', fastMode: true });
    expect(resolveHomeSpeed(CODEX_MODEL, useHomeComposerStore.getState())).toBe(
      'fast',
    );

    useHomeComposerStore.getState().setSpeed('ultrafast');
    useHomeComposerStore.getState().selectWorkspace('ws');

    expect(useHomeComposerStore.getState()).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(resolveHomeSpeed(CODEX_MODEL, useHomeComposerStore.getState())).toBe(
      'ultrafast',
    );
    expect(
      resolveHomeFastMode(
        CODEX_MODEL,
        useHomeComposerStore.getState().fastMode,
      ),
    ).toBe(false);
    expect(
      resolveHomeSpeed('sonnet', useHomeComposerStore.getState()),
    ).toBeUndefined();

    // The legacy boolean control replaces the staged speed.
    useHomeComposerStore.getState().setFastMode(true);
    expect(useHomeComposerStore.getState()).toMatchObject({
      speed: 'fast',
      fastMode: true,
    });

    useHomeComposerStore.getState().reset();
    expect(useHomeComposerStore.getState().speed).toBeUndefined();
  });

  it('reads an Ultra fast provider default speed-first', () => {
    setCodexDefaults({ speed: 'ultrafast', fastMode: false });

    expect(resolveHomeSpeed(CODEX_MODEL, {})).toBe('ultrafast');
    expect(resolveHomeFastMode(CODEX_MODEL, undefined)).toBe(false);
    // An explicit legacy choice still beats an Ultra fast default.
    expect(resolveHomeSpeed(CODEX_MODEL, { fastMode: false })).toBe('standard');
  });

  it('carries a staged Ultra fast speed and attachments into the created chat', async () => {
    const createStandaloneChatWithMessage = jest.fn<
      Promise<string>,
      Parameters<
        ReturnType<
          typeof useStandaloneChatStore.getState
        >['createStandaloneChatWithMessage']
      >
    >(() => Promise.resolve('chat-1'));
    useStandaloneChatStore.setState({ createStandaloneChatWithMessage });
    useNavigationStore.setState({ navigate: jest.fn() });
    const attachment = { filename: 'spec.md', absolutePath: '/tmp/spec.md' };
    useHomeComposerStore.setState({
      workspaceId: STANDALONE_CHAT_PROJECT_ID,
      text: 'ship it',
      model: CODEX_MODEL,
      thinkingLevel: 'high',
      approvalMode: 'auto',
      attachments: [attachment],
    });
    useHomeComposerStore.getState().setSpeed('ultrafast');

    await expect(dispatchHomeSend()).resolves.toBe(true);

    expect(createStandaloneChatWithMessage).toHaveBeenCalledTimes(1);
    const request = createStandaloneChatWithMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      chatProjectId: STANDALONE_CHAT_PROJECT_ID,
      message: 'ship it',
      config: {
        model: CODEX_MODEL,
        thinkingLevel: 'high',
        speed: 'ultrafast',
        approvalMode: 'auto',
        attachments: [attachment],
        attachmentPaths: ['/tmp/spec.md'],
      },
    });
    // The exact speed is the only speed input; no lossy boolean rides along.
    expect(request?.config).not.toHaveProperty('fastMode');
    expect(useHomeComposerStore.getState().speed).toBeUndefined();
  });
});
