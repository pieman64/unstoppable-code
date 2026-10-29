/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type ChatTabPluginSelections,
  type PluginSelectionTombstones,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useResolvedChatPluginSelections } from '../useResolvedChatPluginSelections';

const PROJECT_MCP = { serverId: 'project-mcp', configId: 'default' };
const GLOBAL_MCP = { serverId: 'global-mcp', configId: 'default' };
const SCOPED_MCP = { serverId: 'scoped-mcp', configId: 'default' };
const OWN_MCP = { serverId: 'own-mcp', configId: 'default' };

function selections(
  mcpServerRefs: NonNullable<ChatTabPluginSelections['mcpServerRefs']>,
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], mcpServerRefs };
}

function seedProject(
  id: string,
  defaults: ChatTabPluginSelections | undefined,
  disabledGlobals?: PluginSelectionTombstones,
): void {
  const project: SidebarItem = {
    type: 'single-repo',
    id,
    name: 'Project',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...(defaults ? { defaultPluginSelections: defaults } : {}),
    ...(disabledGlobals
      ? { disabledGlobalPluginSelections: disabledGlobals }
      : {}),
  };
  useProjectsStore.setState({ projects: [project] });
}

function seedChat(
  projectId: string,
  worktreeId: string,
  overrides: Partial<ChatTab> = {},
): void {
  // Chats the app creates now carry the live-defaults stamp.
  const tab: ChatTab = {
    ...createEmptyTab({ inheritedPluginDefaultsVersion: 1 }),
    id: 'chat',
    ...overrides,
  };
  useChatStore.setState({
    worktreeChats: {
      [`${projectId}/${worktreeId}`]: { activeTabId: tab.id, tabs: [tab] },
    },
  });
}

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  current: ChatTabPluginSelections | null;
}

interface HarnessProps {
  probe: Probe;
  projectId: string | null;
  worktreeId: string | null;
  chatId: string | null;
}

function Harness({
  probe,
  projectId,
  worktreeId,
  chatId,
}: HarnessProps): JSX.Element {
  probe.current = useResolvedChatPluginSelections(
    projectId,
    worktreeId,
    chatId,
  );
  return <></>;
}

const roots: Root[] = [];

function renderResolved(
  projectId: string | null,
  worktreeId: string | null,
  chatId: string | null,
): Probe {
  const probe: Probe = { current: null };
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(
      <Harness
        probe={probe}
        projectId={projectId}
        worktreeId={worktreeId}
        chatId={chatId}
      />,
    );
  });
  return probe;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
});

function mcpServerIds(
  result: ChatTabPluginSelections | null,
): string[] | undefined {
  return result?.mcpServerRefs?.map((ref) => ref.serverId).sort();
}

beforeEach(() => {
  useGlobalPluginDefaultsStore.setState({
    hydrated: true,
    selections: selections([GLOBAL_MCP]),
  });
  useChatStore.setState({ worktreeDefaultPlugins: {}, worktreeChats: {} });
  seedProject('project', selections([PROJECT_MCP]));
});

describe('useResolvedChatPluginSelections', () => {
  it('resolves an inheriting chat to its own, project, and global selections', () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([OWN_MCP]),
    });

    const result = renderResolved('project', 'worktree', null);

    expect(mcpServerIds(result.current)).toEqual([
      'global-mcp',
      'own-mcp',
      'project-mcp',
    ]);
  });

  it('leaves out defaults the chat turned off', () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([OWN_MCP]),
      disabledGlobalPluginSelections: {
        mcpServerRefs: [PROJECT_MCP, GLOBAL_MCP],
      },
    });

    const result = renderResolved('project', 'worktree', 'chat');

    expect(mcpServerIds(result.current)).toEqual(['own-mcp']);
  });

  it('leaves out globals the project turned off unless the chat chose one', () => {
    seedProject('project', selections([PROJECT_MCP]), {
      mcpServerRefs: [GLOBAL_MCP],
    });
    seedChat('project', 'worktree');

    const result = renderResolved('project', 'worktree', null);
    expect(mcpServerIds(result.current)).toEqual(['project-mcp']);

    act(() => {
      seedChat('project', 'worktree', {
        pluginSelections: selections([GLOBAL_MCP]),
      });
    });
    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'project-mcp']);
  });

  it('follows the globals the project turns off', () => {
    seedChat('project', 'worktree');
    const result = renderResolved('project', 'worktree', null);
    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'project-mcp']);

    act(() => {
      seedProject('project', selections([PROJECT_MCP]), {
        mcpServerRefs: [GLOBAL_MCP],
      });
    });
    expect(mcpServerIds(result.current)).toEqual(['project-mcp']);
  });

  it('keeps a chat from before live project defaults on its own selection', () => {
    seedChat('project', 'worktree', {
      pluginSelections: selections([OWN_MCP]),
      inheritedPluginDefaultsVersion: undefined,
    });

    const result = renderResolved('project', 'worktree', null);

    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'own-mcp']);
  });

  it('prefers the scoped project defaults over the project record', () => {
    useChatStore.setState({
      worktreeDefaultPlugins: {
        'project/worktree': selections([SCOPED_MCP]),
      },
    });
    seedChat('project', 'worktree');

    const result = renderResolved('project', 'worktree', null);

    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'scoped-mcp']);
  });

  it('inherits defaults before any chat is loaded and skips unhydrated globals', () => {
    useGlobalPluginDefaultsStore.setState({ hydrated: false });

    const result = renderResolved('project', 'worktree', null);

    expect(mcpServerIds(result.current)).toEqual(['project-mcp']);
  });

  it('follows default and tombstone changes', () => {
    seedChat('project', 'worktree');
    const result = renderResolved('project', 'worktree', null);
    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'project-mcp']);

    act(() => {
      seedProject('project', selections([SCOPED_MCP]));
    });
    expect(mcpServerIds(result.current)).toEqual(['global-mcp', 'scoped-mcp']);

    act(() => {
      seedChat('project', 'worktree', {
        disabledGlobalPluginSelections: { mcpServerRefs: [GLOBAL_MCP] },
      });
    });
    expect(mcpServerIds(result.current)).toEqual(['scoped-mcp']);
  });

  it('keeps the explicit resolution order on surfaces that do not inherit', () => {
    seedProject(APP_ADVISOR_PROJECT_ID, selections([PROJECT_MCP]));
    seedChat(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID, {
      pluginSelections: selections([OWN_MCP]),
    });

    const withTab = renderResolved(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      null,
    );
    expect(mcpServerIds(withTab.current)).toEqual(['own-mcp']);

    act(() => {
      useChatStore.setState({ worktreeChats: {} });
    });
    const withoutTab = renderResolved(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      null,
    );
    expect(mcpServerIds(withoutTab.current)).toEqual(['project-mcp']);
  });

  it('returns null without a worktree binding', () => {
    const result = renderResolved(null, null, null);

    expect(result.current).toBeNull();
  });
});
