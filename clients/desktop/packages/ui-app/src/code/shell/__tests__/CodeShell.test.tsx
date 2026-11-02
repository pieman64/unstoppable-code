/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { CanopyCapabilities, NavigationLocation } from '@canopy/app-core';
import type { ActivityState } from '@canopy/app-state';
import type { PortalSessionShellState } from '@canopy/protocol/portal';

// Stub ChatPanel so the chat-center path renders without a chat-store mock
// (ChatPanel has its own suite).
jest.mock('../../ChatPanel', () => ({
  ChatPanel: ({
    chatId,
    composer,
  }: {
    chatId: string;
    composer?: { slashTriggerCharacters?: readonly string[] };
  }): JSX.Element => (
    <div
      data-testid="chat-panel-stub"
      data-slash-triggers={composer?.slashTriggerCharacters?.join(',')}
    >
      {chatId}
    </div>
  ),
}));

interface NavResult {
  location: NavigationLocation;
  navigate: (location: NavigationLocation) => void;
}

let mockActivity: ActivityState;
let mockCaps: CanopyCapabilities;
let mockNav: NavResult;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useActivityStore: <T,>(selector: (state: ActivityState) => T): T =>
      selector(mockActivity),
    useCapabilities: (): CanopyCapabilities => mockCaps,
    useWorkspaceCapabilities: (): CanopyCapabilities => mockCaps,
    useNavigation: (): NavResult => mockNav,
  };
});

import { CodeShell } from '../CodeShell';

const CAPS: CanopyCapabilities = {
  localExecution: true,
  terminalPty: true,
  fileSystemAccess: 'read-write',
  voice: false,
  settingsScope: 'full',
  pipelines: 'execute',
  routing: 'in-memory',
  overviewNotifications: true,
};

function shell(
  partial: Partial<PortalSessionShellState>,
): PortalSessionShellState {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...partial,
  };
}

function activity(snapshot: PortalSessionShellState | null): ActivityState {
  return {
    snapshot,
    sectionOrderOverrides: {},
    hydrate: (): void => {},
    patch: (): void => {},
    setSectionOrder: (): void => {},
  };
}

const POPULATED = shell({
  workspaces: [
    { localId: 'ws1', name: 'My Project', type: 'single-repo', repos: [] },
  ],
  worktrees: [{ localId: 'wt1', workspaceLocalId: 'ws1', branch: 'main' }],
});

beforeEach(() => {
  mockCaps = CAPS;
  mockNav = { location: { page: 'main' }, navigate: (): void => {} };
});

describe('CodeShell', () => {
  it('renders sidebar + empty center with no selection', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(<CodeShell onSelectWorktree={(): void => {}} />);
    expect(out).toContain('data-testid="code-shell"');
    expect(out).toContain('data-testid="worktree-sidebar"');
    expect(out).toContain('data-testid="code-shell-empty"');
    // No worktree selected → no activity rail.
    expect(out).not.toContain('data-testid="activity-panel"');
  });

  it('mounts the activity rail for a selected worktree (no chat id → no-chat center)', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
      />,
    );
    expect(out).toContain('data-testid="code-shell"');
    expect(out).toContain('data-testid="activity-panel"');
    expect(out).toContain('data-testid="code-shell-no-chat"');
    expect(out).toContain('main');
  });

  it('renders the chat center when a chat id is supplied', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        chatId="chat-1"
        onSelectWorktree={(): void => {}}
      />,
    );
    expect(out).toContain('data-testid="chat-panel-stub"');
    expect(out).toContain('chat-1');
    expect(out).not.toContain('data-testid="code-shell-no-chat"');
  });

  it.each([
    ['Codex', 'codex', '/,$'],
    ['a non-Codex provider', 'claude', '/'],
  ])(
    'gates built-in composer triggers for %s',
    (_label, providerType, expectedTriggers) => {
      mockActivity = activity(POPULATED);
      const out = renderToString(
        <CodeShell
          selectedWorkspaceLocalId="ws1"
          selectedWorktreeLocalId="wt1"
          chatId="chat-1"
          providerType={providerType}
          onSelectWorktree={(): void => {}}
        />,
      );

      expect(out).toContain(`data-slash-triggers="${expectedTriggers}"`);
    },
  );

  it('renders center/right, status, action, and sidebar extension seams', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
        centerContent={<div>Host center</div>}
        rightPanelContent={<div>Host right</div>}
        header={<div>Host header</div>}
        topStatus={<div>Connecting</div>}
        bottomStatus={<div>Offline</div>}
        workspaceActions={<button type="button">More</button>}
        sidebarNavigationExtension={<div>Standalone chat</div>}
      />,
    );
    expect(out).toContain('Host center');
    expect(out).toContain('Host right');
    expect(out).toContain('Host header');
    expect(out).toContain('Connecting');
    expect(out).toContain('Offline');
    expect(out).toContain('More');
    expect(out).toContain('Standalone chat');
    expect(out).not.toContain('data-testid="activity-panel"');
  });

  it('suppresses the right rail entirely for rightPanelContent={null}', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
        rightPanelContent={null}
      />,
    );
    // No empty fixed-width rail: neither the built-in ActivityPanel nor the
    // host wrapper node renders.
    expect(out).not.toContain('data-testid="activity-panel"');
    expect(out).not.toContain('data-testid="code-shell-right-panel"');
  });

  it('keeps the built-in left panel when its seam is undefined', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(<CodeShell onSelectWorktree={(): void => {}} />);
    expect(out).toContain('data-testid="worktree-sidebar"');
    expect(out).toContain('data-testid="code-shell-left-panel"');
  });

  it('suppresses the left panel entirely for a null seam', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell onSelectWorktree={(): void => {}} leftPanelContent={null} />,
    );
    expect(out).not.toContain('data-testid="worktree-sidebar"');
    expect(out).not.toContain('data-testid="code-shell-left-panel"');
  });

  it('renders a host replacement inside the left panel wrapper', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        leftPanelContent={<div>Host left</div>}
      />,
    );
    expect(out).toContain('Host left');
    expect(out).toContain('data-testid="code-shell-left-panel"');
    expect(out).not.toContain('data-testid="worktree-sidebar"');
  });

  it('propagates the resolved left panel to responsive hosts', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        leftPanelContent={<div>Responsive left</div>}
        renderResponsiveShell={(regions) => (
          <div data-testid="responsive-regions">{regions.leftPanel}</div>
        )}
      />,
    );
    expect(out).toContain('data-testid="responsive-regions"');
    expect(out).toContain('Responsive left');
    expect(out).toContain('data-testid="code-shell-left-panel"');
  });

  it('fires workspace-level action callbacks', () => {
    mockActivity = activity(POPULATED);
    const onAddWorkspace = jest.fn<void, []>();
    const onCreateTask = jest.fn<void, []>();
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <CodeShell
          onSelectWorktree={(): void => {}}
          onAddWorkspace={onAddWorkspace}
          onCreateTask={onCreateTask}
        />,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    act(() => {
      buttons.find((button) => button.textContent === 'Add project')?.click();
      buttons.find((button) => button.textContent === 'Create task')?.click();
    });
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('lets the host compose responsive drawers and exposes touch sizing', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        touchTargets
        renderResponsiveShell={(regions) => (
          <div data-testid="mobile-shell">
            <aside className={regions.touchTargetClassName}>
              {regions.leftPanel}
            </aside>
            <main>{regions.center}</main>
            <aside>{regions.rightPanel}</aside>
          </div>
        )}
      />,
    );
    expect(out).toContain('data-testid="mobile-shell"');
    expect(out).toContain('min-h-11 min-w-11');
    expect(out).not.toContain('[&amp;_button]:min-h-11');
    expect(out).not.toContain('[&amp;_button]:min-w-11');
  });

  it('supports structural test-id overrides and aliases', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        testIds={{
          shell: { id: 'portal-shell', aliases: ['legacy-shell'] },
          center: { id: 'portal-center', aliases: ['legacy-center'] },
        }}
      />,
    );
    expect(out).toContain('data-testid="portal-shell"');
    expect(out).toContain('data-testid-aliases="legacy-shell"');
    expect(out).toContain('data-testid="portal-center"');
    expect(out).not.toContain('data-testid="code-shell"');
  });

  it('omits the worktree top bar with no selection even when a node is supplied', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        worktreeTopBar={<div data-testid="host-top-bar">Top bar</div>}
      />,
    );
    expect(out).not.toContain('data-testid="host-top-bar"');
  });

  it('renders the worktree top bar once for a selected workspace/worktree', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
        worktreeTopBar={<div data-testid="host-top-bar">Top bar</div>}
      />,
    );
    expect(out.split('data-testid="host-top-bar"')).toHaveLength(2);
  });

  it('propagates the resolved worktreeTopBar region to responsive hosts', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
        worktreeTopBar={<div data-testid="host-top-bar">Top bar</div>}
        renderResponsiveShell={(regions) => (
          <div data-testid="responsive-regions">
            {regions.worktreeTopBar}
            {regions.center}
          </div>
        )}
      />,
    );
    expect(out).toContain('data-testid="responsive-regions"');
    expect(out).toContain('data-testid="host-top-bar"');
  });

  it('resolves worktreeTopBar to null for responsive hosts without a selection', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        onSelectWorktree={(): void => {}}
        worktreeTopBar={<div data-testid="host-top-bar">Top bar</div>}
        renderResponsiveShell={(regions) => (
          <div data-testid="responsive-regions">
            {regions.worktreeTopBar}
            {regions.center}
          </div>
        )}
      />,
    );
    expect(out).toContain('data-testid="responsive-regions"');
    expect(out).not.toContain('data-testid="host-top-bar"');
  });

  it('accepts clean panel width overrides', () => {
    mockActivity = activity(POPULATED);
    const out = renderToString(
      <CodeShell
        selectedWorkspaceLocalId="ws1"
        selectedWorktreeLocalId="wt1"
        onSelectWorktree={(): void => {}}
        leftPanelWidth="18rem"
        rightPanelWidth="24rem"
      />,
    );
    expect(out).toContain('width:18rem');
    expect(out).toContain('width:24rem');
  });
});
