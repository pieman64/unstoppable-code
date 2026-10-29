/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ChatTabPluginSelections,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ChatPluginsSection } from '../ChatPluginsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function selections(
  pluginRefs: ChatTabPluginSelections['pluginRefs'],
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs, mcpServerRefs: [] };
}

const PROJECT_TOOL = { marketplaceId: 'mkt', pluginName: 'project-tool' };
const GLOBAL_TOOL = { marketplaceId: 'mkt', pluginName: 'global-tool' };
const SHARED_TOOL = { marketplaceId: 'mkt', pluginName: 'shared-tool' };
const LOCAL_TOOL = { marketplaceId: 'mkt', pluginName: 'local-tool' };

describe('ChatPluginsSection inherited defaults', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: {
        loadMarketplacesCacheOnly: jest.fn(() =>
          Promise.resolve({ success: false }),
        ),
      },
    });
    const project: SidebarItem = {
      type: 'single-repo',
      id: 'project',
      name: 'Project',
      repoPath: '/workspace',
      color: '#000000',
      collapsed: false,
      order: 0,
      worktrees: [],
      defaultPluginSelections: selections([PROJECT_TOOL, SHARED_TOOL]),
    };
    useProjectsStore.setState({ projects: [project] });
    useGlobalPluginDefaultsStore.setState({
      hydrated: true,
      selections: selections([GLOBAL_TOOL, SHARED_TOOL]),
    });
    const tab: ChatTab = {
      ...createEmptyTab({}),
      id: 'chat',
      pluginSelections: selections([LOCAL_TOOL]),
      inheritedPluginDefaultsVersion: 1,
    };
    useChatStore.setState({
      worktreeDefaultPlugins: {},
      worktreeChats: {
        'project/worktree': { activeTabId: 'chat', tabs: [tab] },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('labels each row with the default layer it comes from', () => {
    act(() => {
      root.render(
        <ChatPluginsSection projectId="project" worktreeId="worktree" />,
      );
    });

    const layerFor = (name: string): string | null => {
      const row = Array.from(
        container.querySelectorAll('[data-activity-item-row]'),
      ).find((candidate) => candidate.textContent?.includes(name));
      return (
        row
          ?.querySelector('[data-testid="activity-plugin-avatar"]')
          ?.getAttribute('data-inherited-default') ?? null
      );
    };
    const titleFor = (name: string): string | null =>
      Array.from(container.querySelectorAll('[data-activity-item-row] [title]'))
        .find((candidate) => candidate.textContent?.includes(name))
        ?.getAttribute('title') ?? null;

    expect(layerFor('project-tool')).toBe('project');
    expect(titleFor('project-tool')).toBe('mkt · Project default');
    expect(layerFor('global-tool')).toBe('global');
    expect(titleFor('global-tool')).toBe('mkt · Global default');
    expect(layerFor('shared-tool')).toBe('project');
    expect(layerFor('local-tool')).toBeNull();
    expect(titleFor('local-tool')).toBe('mkt');
  });

  it('leaves out a global the project turned off and never labels it a global default', () => {
    act(() => {
      root.render(
        <ChatPluginsSection projectId="project" worktreeId="worktree" />,
      );
    });
    expect(container.textContent).toContain('global-tool');

    act(() => {
      useProjectsStore.setState({
        projects: useProjectsStore.getState().projects.map((project) => ({
          ...project,
          disabledGlobalPluginSelections: { pluginRefs: [GLOBAL_TOOL] },
        })),
      });
    });
    expect(container.textContent).not.toContain('global-tool');
    expect(container.textContent).toContain('local-tool');

    act(() => {
      useChatStore.setState({
        worktreeChats: {
          'project/worktree': {
            activeTabId: 'chat',
            tabs: [
              {
                ...createEmptyTab({}),
                id: 'chat',
                pluginSelections: selections([LOCAL_TOOL, GLOBAL_TOOL]),
                inheritedPluginDefaultsVersion: 1,
              },
            ],
          },
        },
      });
    });
    const globalRow = Array.from(
      container.querySelectorAll('[data-activity-item-row]'),
    ).find((candidate) => candidate.textContent?.includes('global-tool'));
    expect(
      globalRow
        ?.querySelector('[data-testid="activity-plugin-avatar"]')
        ?.hasAttribute('data-inherited-default'),
    ).toBe(false);
    expect(globalRow?.querySelector('[title]')?.getAttribute('title')).toBe(
      'mkt',
    );
  });

  it('updates when the project defaults change', () => {
    act(() => {
      root.render(
        <ChatPluginsSection projectId="project" worktreeId="worktree" />,
      );
    });
    expect(container.textContent).toContain('project-tool');

    act(() => {
      useChatStore.setState({
        worktreeDefaultPlugins: {
          'project/worktree': selections([]),
        },
      });
    });

    expect(container.textContent).not.toContain('project-tool');
    expect(container.textContent).toContain('local-tool');
  });
});
