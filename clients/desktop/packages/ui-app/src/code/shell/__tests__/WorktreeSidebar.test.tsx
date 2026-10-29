import { renderToString } from 'react-dom/server';
import type { ActivityState } from '@canopy/app-state';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import type { WorkspacesSidebarSectionsProps } from '../WorkspacesSidebarSections';

let mockActivity: ActivityState;
let capturedSectionsProps: WorkspacesSidebarSectionsProps | undefined;
jest.mock('@canopy/app-state', () => ({
  __esModule: true,
  useActivityStore: <T,>(selector: (state: ActivityState) => T): T =>
    selector(mockActivity),
  useCapabilities: (): CanopyCapabilities => ({
    localExecution: true,
    terminalPty: true,
    fileSystemAccess: 'read-write',
    voice: false,
    settingsScope: 'full',
    pipelines: 'execute',
    routing: 'in-memory',
    overviewNotifications: true,
  }),
}));
jest.mock('../WorkspacesSidebarSections', () => ({
  __esModule: true,
  WorkspacesSidebarSections: (
    props: WorkspacesSidebarSectionsProps,
  ): JSX.Element => {
    capturedSectionsProps = props;
    return <div data-testid="shared-workspace-sections" />;
  },
}));

import { WorktreeSidebar } from '../WorktreeSidebar';

function activity(snapshot: PortalSessionShellState | null): ActivityState {
  return {
    snapshot,
    sectionOrderOverrides: {},
    hydrate: (): void => {},
    setSectionOrder: (): void => {},
  };
}

const snapshot = {
  workspaces: [
    {
      localId: 'workspace',
      name: 'Workspace',
      type: 'single-repo' as const,
    },
  ],
  worktrees: [],
} as PortalSessionShellState;

describe('WorktreeSidebar', () => {
  it('owns chrome and composes the shared project sections', () => {
    mockActivity = activity(snapshot);
    const output = renderToString(
      <WorktreeSidebar onSelectWorktree={(): void => {}} />,
    );
    expect(output).toContain('data-testid="worktree-sidebar"');
    expect(output).toContain('data-testid="shared-workspace-sections"');
  });

  it('uses the public creation callback and disables creation without it', async () => {
    mockActivity = activity(snapshot);
    const onAddWorktree = jest.fn();
    renderToString(
      <WorktreeSidebar
        onSelectWorktree={(): void => {}}
        onAddWorktree={onAddWorktree}
      />,
    );
    expect(capturedSectionsProps?.creationEnabled).toBe(true);
    await capturedSectionsProps?.onCreateWorktree('workspace');
    expect(onAddWorktree).toHaveBeenCalledWith('workspace');

    renderToString(<WorktreeSidebar onSelectWorktree={(): void => {}} />);
    expect(capturedSectionsProps?.creationEnabled).toBe(false);
  });

  it('supplies no per-row capability resolver, so every row uses the flat set', () => {
    // The desktop host fronts one backend: rows must keep resolving from the
    // single `useCapabilities()` object exactly as they did before REG-2816.
    mockActivity = activity(snapshot);
    renderToString(<WorktreeSidebar onSelectWorktree={(): void => {}} />);
    expect(capturedSectionsProps?.capabilitiesFor).toBeUndefined();
    expect(capturedSectionsProps?.capabilities.settingsScope).toBe('full');
  });

  it('keeps the whole-sidebar empty state and top actions', () => {
    mockActivity = activity(null);
    const empty = renderToString(
      <WorktreeSidebar onSelectWorktree={(): void => {}} />,
    );
    expect(empty).toContain('data-testid="worktree-sidebar-empty"');

    const withAction = renderToString(
      <WorktreeSidebar
        onSelectWorktree={(): void => {}}
        onCreateTask={(): void => {}}
      />,
    );
    expect(withAction).toContain('data-testid="worktree-sidebar-actions"');
  });
});
