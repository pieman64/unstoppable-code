/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CanopyApi,
  ChatTabPluginSelections,
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import type { McpWorkspaceDefaultsChoice } from '@canopy/ui-app';
import {
  addMcpServerToWorkspaceDefaults,
  removeMcpServerFromWorkspaceDefaults,
  useMcpWorkspaceDefaultChoices,
  useWorkspaceDefaultTarget,
} from '../workspaceDefaultMcp';

const saveWorkspaceDefaultPlugins = jest.fn();
const saveProjectDefaultPlugins = jest.fn();
const updateChatProject = jest.fn();
const loadProjects = jest.fn();

const EXISTING: ChatTabPluginSelections = {
  collectionIds: ['col-1'],
  skillRefs: [],
  pluginRefs: [],
  mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
};
const REF = { serverId: 'custom:abc', configId: 'default' };

function multiRepo(): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: 'ws-multi',
    name: 'Acme',
    color: '#111111',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 0,
    defaultPluginSelections: EXISTING,
    alwaysShow: false,
  };
}

function singleRepo(): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'ws-single',
    name: 'Solo',
    repoPath: '/repo',
    color: '#111111',
    worktrees: [],
    collapsed: false,
    order: 1,
  };
}

function cowork(): CoworkSidebarItem {
  return {
    type: 'cowork',
    id: 'ws-cowork',
    name: 'Notes',
    color: '#111111',
    collapsed: false,
    order: 2,
    defaultPluginSelections: EXISTING,
    alwaysShow: true,
  };
}

describe('addMcpServerToWorkspaceDefaults', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        saveWorkspaceDefaultPlugins,
        saveProjectDefaultPlugins,
        chatProject: { update: updateChatProject },
      } satisfies Partial<Record<keyof CanopyApi, unknown>>,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    saveWorkspaceDefaultPlugins.mockResolvedValue(undefined);
    saveProjectDefaultPlugins.mockResolvedValue(undefined);
    updateChatProject.mockResolvedValue({});
    loadProjects.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [multiRepo(), singleRepo(), cowork()],
      loadProjects,
    });
  });

  it('appends the ref to a multi-repo workspace and leaves alwaysShow alone', async () => {
    await addMcpServerToWorkspaceDefaults('ws-multi', REF);
    expect(saveWorkspaceDefaultPlugins).toHaveBeenCalledWith({
      projectId: 'ws-multi',
      defaultPluginSelections: {
        ...EXISTING,
        mcpServerRefs: [...(EXISTING.mcpServerRefs ?? []), REF],
      },
    });
    expect(saveProjectDefaultPlugins).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
  });

  it('saves a single-repo project through the project channel', async () => {
    await addMcpServerToWorkspaceDefaults('ws-single', REF);
    expect(saveProjectDefaultPlugins).toHaveBeenCalledWith({
      projectId: 'ws-single',
      defaultPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [REF],
        mcpHttpAuthPreferences: [],
      },
    });
    expect(saveWorkspaceDefaultPlugins).not.toHaveBeenCalled();
  });

  it('updates a cowork project without touching alwaysShow', async () => {
    await addMcpServerToWorkspaceDefaults('ws-cowork', REF);
    expect(updateChatProject).toHaveBeenCalledWith({
      projectId: 'ws-cowork',
      defaultPluginSelections: {
        ...EXISTING,
        mcpServerRefs: [...(EXISTING.mcpServerRefs ?? []), REF],
      },
    });
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
  });

  it('skips the save when the server is already a default', async () => {
    await addMcpServerToWorkspaceDefaults('ws-multi', {
      serverId: 'github',
      configId: 'default',
    });
    expect(saveWorkspaceDefaultPlugins).not.toHaveBeenCalled();
    expect(loadProjects).not.toHaveBeenCalled();
  });

  it('applies overlapping adds and removes one after another', async () => {
    const second = { serverId: 'custom:def', configId: 'default' };
    const saved: ChatTabPluginSelections[] = [];
    saveWorkspaceDefaultPlugins.mockImplementation(
      async (request: {
        projectId: string;
        defaultPluginSelections: ChatTabPluginSelections;
      }): Promise<void> => {
        saved.push(request.defaultPluginSelections);
        await Promise.resolve();
        loadProjects.mockImplementationOnce((): Promise<void> => {
          useProjectsStore.setState({
            projects: useProjectsStore.getState().projects.map((project) =>
              project.id === request.projectId
                ? {
                    ...project,
                    defaultPluginSelections: request.defaultPluginSelections,
                  }
                : project,
            ),
          });
          return Promise.resolve();
        });
      },
    );
    await Promise.all([
      addMcpServerToWorkspaceDefaults('ws-multi', REF),
      addMcpServerToWorkspaceDefaults('ws-multi', second),
      removeMcpServerFromWorkspaceDefaults('ws-multi', {
        serverId: 'github',
        configId: 'default',
      }),
    ]);
    expect(saved.map((selections) => selections.mcpServerRefs)).toEqual([
      [...(EXISTING.mcpServerRefs ?? []), REF],
      [...(EXISTING.mcpServerRefs ?? []), REF, second],
      [REF, second],
    ]);
  });

  it('keeps later updates going after one fails', async () => {
    saveWorkspaceDefaultPlugins
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const results = await Promise.allSettled([
      addMcpServerToWorkspaceDefaults('ws-multi', REF),
      addMcpServerToWorkspaceDefaults('ws-multi', REF),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
    ]);
    expect(saveWorkspaceDefaultPlugins).toHaveBeenCalledTimes(2);
  });

  it('rejects when the workspace no longer exists', async () => {
    await expect(
      addMcpServerToWorkspaceDefaults('missing', REF),
    ).rejects.toThrow('Project not found');
    expect(saveWorkspaceDefaultPlugins).not.toHaveBeenCalled();
  });
});

describe('removeMcpServerFromWorkspaceDefaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveWorkspaceDefaultPlugins.mockResolvedValue(undefined);
    updateChatProject.mockResolvedValue({});
    loadProjects.mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [multiRepo(), singleRepo(), cowork()],
      loadProjects,
    });
  });

  it('drops only that server from the defaults', async () => {
    await removeMcpServerFromWorkspaceDefaults('ws-cowork', {
      serverId: 'github',
      configId: 'default',
    });
    expect(updateChatProject).toHaveBeenCalledWith({
      projectId: 'ws-cowork',
      defaultPluginSelections: { ...EXISTING, mcpServerRefs: [] },
    });
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
  });

  it('skips the save when the server is not a default', async () => {
    await removeMcpServerFromWorkspaceDefaults('ws-multi', REF);
    expect(saveWorkspaceDefaultPlugins).not.toHaveBeenCalled();
    expect(loadProjects).not.toHaveBeenCalled();
  });
});

describe('useMcpWorkspaceDefaultChoices', () => {
  let seen: McpWorkspaceDefaultsChoice[] = [];

  function Probe({
    serverRef,
  }: {
    serverRef: { serverId: string; configId: string } | null;
  }): JSX.Element {
    seen = useMcpWorkspaceDefaultChoices(serverRef);
    return <></>;
  }

  function render(
    serverRef: { serverId: string; configId: string } | null,
  ): void {
    const root = createRoot(document.createElement('div'));
    act((): void => root.render(<Probe serverRef={serverRef} />));
    act((): void => root.unmount());
  }

  beforeEach(() => {
    useProjectsStore.setState({
      projects: [
        { ...multiRepo(), id: 'ws-temp', name: 'Temp', temporary: true },
        multiRepo(),
        singleRepo(),
        cowork(),
      ],
    });
  });

  it('lists the current project first and marks where the server is a default', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'ws-single', worktreeId: 'wt-1' },
    });
    render({ serverId: 'github', configId: 'default' });
    expect(seen).toEqual([
      { id: 'ws-single', name: 'Solo', enabled: false },
      { id: 'ws-multi', name: 'Acme', enabled: true },
      { id: 'ws-cowork', name: 'Notes', enabled: true },
    ]);
  });

  it('keeps store order outside a project and lists nothing without a server', () => {
    useChatStore.setState({ selectedWorktree: null });
    render(REF);
    expect(seen.map((choice) => choice.id)).toEqual([
      'ws-multi',
      'ws-single',
      'ws-cowork',
    ]);
    render(null);
    expect(seen).toEqual([]);
  });
});

describe('useWorkspaceDefaultTarget', () => {
  let seen: { id: string; name: string } | null | undefined;

  function Probe(): JSX.Element {
    seen = useWorkspaceDefaultTarget();
    return <></>;
  }

  function render(): void {
    const root = createRoot(document.createElement('div'));
    act((): void => root.render(<Probe />));
    act((): void => root.unmount());
  }

  beforeEach(() => {
    seen = undefined;
    useProjectsStore.setState({ projects: [multiRepo(), cowork()] });
  });

  it('resolves the selected workspace', () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'ws-multi', worktreeId: 'wt-1' },
    });
    render();
    expect(seen).toEqual({ id: 'ws-multi', name: 'Acme' });
  });

  it('is null without a registered workspace selected', () => {
    useChatStore.setState({ selectedWorktree: null });
    render();
    expect(seen).toBeNull();
    useChatStore.setState({
      selectedWorktree: { projectId: 'standalone', worktreeId: 'chat' },
    });
    render();
    expect(seen).toBeNull();
  });
});
