/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ActivityChangedFilesResponse,
  ChatTabPluginSelections,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type { McpHttpAuthTarget } from '@canopy/desktop-shared/types/mcp-servers';
import { setMcpHttpAuthPreference } from '@canopy/desktop-shared/lib/mcp-http-auth';
import {
  DEFAULT_ACTIVITY_SECTION_ORDER,
  isActivitySectionId,
} from '@canopy/desktop-shared/constants/activity';
import {
  ACTIVITY_SECTIONS,
  getActivitySectionDefinition,
  getActivitySectionsForSurface,
  type ActivitySectionRenderProps,
} from '../activity-sections';
import { PanelHostContext } from '@/lib/panels/panel-host-context';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useDetectedMcpServers } from '@/hooks/useDetectedMcpServers';
import { PullRequestSection } from '../PullRequestSection';
import { ChangedFilesSection } from '../ChangedFilesSection';
import {
  ChangedFilesHostSection,
  useChangedFilesSectionHostModel,
} from '../ChangedFilesSection';
import { ScriptsSection } from '../ScriptsSection';
import { HooksSection } from '../HooksSection';
import { PipelineRunsSection } from '../PipelineRunsSection';
import { useDispatchPipelineModal } from '../useDispatchPipelineModal';

// Stub the leaf section components (they reach IPC/stores deeply); the tests
// assert the CONTAINER layer — how activity-sections parameterizes each
// section from the worktree binding, the stores, and PanelHostContext.
jest.mock('../SummarySection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    SummarySection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-summary' }),
    ),
  };
});
jest.mock('../PlansSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PlansSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-plans' }),
    ),
  };
});
jest.mock('../TodoSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    TodoSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-todo' }),
    ),
  };
});
jest.mock('../MemorySection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    MemorySection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-memory' }),
    ),
  };
});
jest.mock('../NotesSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    NotesSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-notes' }),
    ),
  };
});
jest.mock('../PromptsSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PromptsSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-prompts' }),
    ),
  };
});
jest.mock('../AttachmentsSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    AttachmentsSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-attachments' }),
    ),
  };
});
jest.mock('../PullRequestSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PullRequestSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-pull-request' }),
    ),
  };
});
jest.mock('../BackgroundProcessesSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    BackgroundProcessesSection: jest.fn((): unknown =>
      react.createElement('div', {
        'data-testid': 'stub-background-processes',
      }),
    ),
  };
});
jest.mock('../ChangedFilesSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ChangedFilesSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-changed-files' }),
    ),
    ChangedFilesHostSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-changed-files-host' }),
    ),
    useChangedFilesSectionHostModel: jest.fn((): object => ({
      changedFiles: {
        worktreeLocalId: 'worktree-1',
        uncommitted: [],
        committed: [],
      },
    })),
  };
});
jest.mock('../PipelineRunsSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    PipelineRunsSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-pipeline-runs' }),
    ),
  };
});
jest.mock('../ScriptsSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    ScriptsSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-scripts' }),
    ),
  };
});
jest.mock('../HooksSection', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    HooksSection: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-hooks' }),
    ),
  };
});
jest.mock('../RevertConfirmModal', () => ({
  RevertConfirmModal: jest.fn((): null => null),
}));
jest.mock('@/components/mcp/McpServersPanelCard', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    McpServersPanelCard: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-mcp-servers' }),
    ),
  };
});
jest.mock('@/hooks/useDetectedMcpServers', () => ({
  useDetectedMcpServers: jest.fn(() => ({
    servers: [],
    warnings: [],
    loading: false,
    error: null,
    connectingKey: null,
    proxyUpdatingKey: null,
    connect: jest.fn(() => Promise.resolve()),
    refresh: jest.fn(() => Promise.resolve()),
    setCanopyProxyEnabled: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../useDispatchPipelineModal', () => ({
  useDispatchPipelineModal: jest.fn(),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const RENDER_PROPS: ActivitySectionRenderProps = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

function mustGetSection(sectionId: string): {
  render: (props: ActivitySectionRenderProps) => JSX.Element;
} {
  const section = getActivitySectionDefinition(sectionId);
  if (!section) {
    throw new Error(`section ${sectionId} is not registered`);
  }
  return section;
}

describe('ACTIVITY_SECTIONS registration source', () => {
  it('registers every ActivitySectionId exactly once with a non-empty title', () => {
    const ids = ACTIVITY_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The desktop-native activity registry intentionally omits `terminals`: on
    // desktop, terminal sessions live in the terminal drawer, so `terminals` is
    // a section only in the shared/web ActivityPanel (adopted by desktop in
    // CAN-749). It stays in DEFAULT_ACTIVITY_SECTION_ORDER purely so persisted
    // orders survive that adoption, so exclude it from the native registry check.
    const nativeRegistryIds = DEFAULT_ACTIVITY_SECTION_ORDER.filter(
      (id) => id !== 'terminals',
    );
    expect([...ids].sort()).toEqual([...nativeRegistryIds].sort());
    for (const section of ACTIVITY_SECTIONS) {
      expect(isActivitySectionId(section.id)).toBe(true);
      expect(section.title.trim().length).toBeGreaterThan(0);
      expect(typeof section.render).toBe('function');
    }
  });

  it('getActivitySectionDefinition resolves known ids and rejects unknown ids', () => {
    expect(getActivitySectionDefinition('summary')?.title).toBe('Summary');
    expect(getActivitySectionDefinition('todo')?.title).toBe('Agent Tasks');
    expect(getActivitySectionDefinition('cost')?.title).toBe('Cost');
    expect(getActivitySectionDefinition('bogus')).toBeUndefined();
  });

  it('exposes every section on the worktree surface', () => {
    expect(getActivitySectionsForSurface('worktree').map((s) => s.id)).toEqual(
      ACTIVITY_SECTIONS.map((s) => s.id),
    );
    const ids = getActivitySectionsForSurface('worktree').map((s) => s.id);
    expect(ids.indexOf('cost')).toBe(ids.indexOf('pipeline-runs') + 1);
  });

  it('hides git/worktree-bound sections from the cowork surface', () => {
    const coworkIds = getActivitySectionsForSurface('cowork').map((s) => s.id);
    // Git/worktree-bound sections stay worktree-only.
    for (const excluded of [
      'changed-files',
      'pull-request',
      'plans',
      'scripts',
      'hooks',
    ]) {
      expect(coworkIds).not.toContain(excluded);
    }
    // Everything Cowork gains from the alignment is present.
    for (const included of [
      'summary',
      'background-processes',
      'mcp-servers',
      'pipeline-runs',
      'cost',
      'todo',
      'memory',
      'notes',
      'prompts',
      'attachments',
    ]) {
      expect(coworkIds).toContain(included);
    }
  });
});

describe('section render parameterization', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useDispatchPipelineModal).mockReturnValue({
      openDispatchPipelineModal: jest.fn(),
      openWorkflowsRunModal: jest.fn<void, []>(() => undefined),
      dispatchPipelineModal: null,
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useActivityStore.setState({ changedFiles: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderSection(sectionId: string): void {
    const content = mustGetSection(sectionId).render(RENDER_PROPS);
    act(() => {
      root.render(content);
    });
  }

  it('pull-request threads the worktree binding straight to the section', () => {
    renderSection('pull-request');
    const props = jest.mocked(PullRequestSection).mock.calls[0][0];
    expect(props.projectId).toBe('project-1');
    expect(props.worktreeId).toBe('worktree-1');
  });

  it('changed-files uses the rich desktop host model', () => {
    const changedFiles: ActivityChangedFilesResponse = {
      uncommitted: [
        { path: 'src/a.ts', status: 'modified', insertions: 1, deletions: 0 },
      ],
      committed: [
        { path: 'src/b.ts', status: 'added', insertions: 5, deletions: 0 },
      ],
    };
    useActivityStore.setState({
      changedFiles: { 'project-1/worktree-1': changedFiles },
    });
    renderSection('changed-files');
    expect(useChangedFilesSectionHostModel).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(ChangedFilesHostSection).toHaveBeenCalled();
    expect(ChangedFilesSection).not.toHaveBeenCalled();
  });

  it('scripts and hooks read the settings callback from PanelHostContext', () => {
    const onOpenSettingsTab = jest.fn();
    act(() => {
      root.render(
        <PanelHostContext.Provider
          value={{ viewMode: 'list', viewModeReady: true, onOpenSettingsTab }}
        >
          {mustGetSection('scripts').render(RENDER_PROPS)}
          {mustGetSection('hooks').render(RENDER_PROPS)}
        </PanelHostContext.Provider>,
      );
    });
    const scriptsProps = jest.mocked(ScriptsSection).mock.calls[0][0];
    expect(scriptsProps.projectId).toBe('project-1');
    expect(scriptsProps.worktreeId).toBe('worktree-1');
    expect(scriptsProps.onOpenSettings).toBe(onOpenSettingsTab);
    const hooksProps = jest.mocked(HooksSection).mock.calls[0][0];
    expect(hooksProps.onOpenSettings).toBe(onOpenSettingsTab);
  });

  it('mcp-servers detects the chat’s inherited defaults and toggles only its own choices', async () => {
    const mcpSelections = (serverIds: string[]): ChatTabPluginSelections => ({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: serverIds.map((serverId) => ({
        serverId,
        configId: 'default',
      })),
    });
    const project: SidebarItem = {
      type: 'single-repo',
      id: 'project-1',
      name: 'Project',
      repoPath: '/workspace',
      color: '#000000',
      collapsed: false,
      order: 0,
      worktrees: [],
      defaultPluginSelections: mcpSelections(['project-mcp']),
    };
    useProjectsStore.setState({ projects: [project] });
    useGlobalPluginDefaultsStore.setState({
      hydrated: true,
      selections: mcpSelections(['global-mcp']),
    });
    useChatStore.setState({
      worktreeDefaultPlugins: {},
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat',
          tabs: [
            {
              ...createEmptyTab({}),
              id: 'chat',
              pluginSelections: mcpSelections(['own-mcp']),
              inheritedPluginDefaultsVersion: 1,
            },
          ],
        },
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chat: {
          updatePlugins: jest.fn(
            (request: { pluginSelections: ChatTabPluginSelections }) =>
              Promise.resolve({ pluginSelections: request.pluginSelections }),
          ),
        },
        discoverWorktreeEnv: jest.fn(() => Promise.resolve()),
      },
    });

    renderSection('mcp-servers');

    const [detected, options] =
      jest.mocked(useDetectedMcpServers).mock.calls.at(-1) ?? [];
    expect(detected?.mcpServerRefs?.map((ref) => ref.serverId).sort()).toEqual([
      'global-mcp',
      'own-mcp',
      'project-mcp',
    ]);

    const target: McpHttpAuthTarget = {
      kind: 'standalone',
      serverId: 'project-mcp',
      configId: 'default',
    };
    await act(async () => {
      await options?.onSelectionsChange?.(
        setMcpHttpAuthPreference(
          detected ?? mcpSelections([]),
          target,
          'provider',
        ),
      );
    });

    const tab =
      useChatStore.getState().worktreeChats['project-1/worktree-1']?.tabs[0];
    expect(tab?.pluginSelections).toEqual({
      ...mcpSelections(['own-mcp']),
      mcpHttpAuthPreferences: [{ target, handler: 'provider' }],
    });
  });

  it('pipeline-runs owns its dispatch-pipeline modal controller', () => {
    const openDispatchPipelineModal = jest.fn();
    jest.mocked(useDispatchPipelineModal).mockReturnValue({
      openDispatchPipelineModal,
      openWorkflowsRunModal: jest.fn<void, []>(() => undefined),
      dispatchPipelineModal: <div data-testid="stub-dispatch-modal" />,
    });
    renderSection('pipeline-runs');
    const props = jest.mocked(PipelineRunsSection).mock.calls[0][0];
    expect(props.onDispatchPipeline).toBe(openDispatchPipelineModal);
    expect(
      container.querySelector('[data-testid="stub-dispatch-modal"]'),
    ).not.toBeNull();
  });
});
