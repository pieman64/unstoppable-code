import type { SidebarItemsFile } from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  readPortalSidebarItems,
  readPortalWorkspace,
} from '../portal-workspace-reads';

jest.mock('../portal-session-manager', () => ({
  getCanopyPortalState: (): { sessionId: string } => ({
    sessionId: 'session-1',
  }),
}));

const sidebar: SidebarItemsFile = {
  version: 1,
  items: [
    {
      type: 'single-repo',
      id: 'ws-1',
      name: 'Workspace',
      color: 'blue',
      collapsed: false,
      order: 0,
      repoPath: '/secret/repo',
      worktrees: [],
    },
  ],
};

it('routes Portal workspace reads with session identity and exact legacy values', async () => {
  const readAllSidebarItems = jest.fn().mockResolvedValue(sidebar);
  const config = { version: 1, type: 'single-repo', repos: [] };
  const readWorkspaceConfig = jest.fn().mockResolvedValue(config);
  const runtime = createDesktopRuntime({
    workspaceServices: {
      readAllSidebarItems,
      readWorkspaceConfig,
      readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
        id: 'ws-1',
        name: 'Workspace',
        type: 'single-repo',
      }),
      readEffectiveWorkspaceConfig: jest.fn().mockResolvedValue({ repos: [] }),
    },
  });
  setDesktopCanopyRuntime(runtime);
  try {
    expect(await readPortalSidebarItems()).toBe(sidebar);
    expect(await readPortalWorkspace('ws-1')).toBe(config);
    expect(readAllSidebarItems).toHaveBeenCalledTimes(1);
    expect(readWorkspaceConfig).toHaveBeenCalledTimes(1);
  } finally {
    setDesktopCanopyRuntime(null);
    await runtime.shutdown();
  }
});
