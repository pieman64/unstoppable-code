import { W5AuthorityUnreachableError } from '@canopy/core-runtime/node/w5/file-store';
import type { SidebarItemsFile } from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from '../../canopy-runtime/desktop-runtime-access';
import {
  readPortalSidebarItems,
  readPortalWorkspace,
} from '../portal-workspace-reads';
import { allowsW5ProjectionOnlyRead } from '../../lib/w5-fallback-read';

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
  const projectionPermissions: boolean[] = [];
  const readAllSidebarItems = jest.fn().mockResolvedValue(sidebar);
  const config = { version: 1, type: 'single-repo', repos: [] };
  const readWorkspaceConfig = jest.fn().mockResolvedValue(config);
  const runtime = createDesktopRuntime({
    workspaceServices: {
      readAllSidebarItems,
      readWorkspaceConfig,
      readView: (_request, work) => {
        projectionPermissions.push(allowsW5ProjectionOnlyRead());
        return work({ status: 'uncaptured', reason: 'direct-store' });
      },
      readWorkspaceIndexEntry: jest.fn().mockResolvedValue({
        id: 'ws-1',
        name: 'Workspace',
        type: 'single-repo',
      }),
      readWorkspaceWorktrees: jest.fn().mockResolvedValue([]),
      readEffectiveWorkspaceConfig: jest.fn().mockResolvedValue({ repos: [] }),
    },
  });
  setDesktopCanopyRuntime(runtime);
  try {
    expect(await readPortalSidebarItems()).toBe(sidebar);
    expect(await readPortalWorkspace('ws-1')).toBe(config);
    expect(readAllSidebarItems).toHaveBeenCalledTimes(1);
    expect(readWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(projectionPermissions).toEqual([false, false]);
  } finally {
    setDesktopCanopyRuntime(null);
    await runtime.shutdown();
  }
});

it.each(['connect', 'w5_host_unavailable'] as const)(
  'keeps Portal inventories fail-closed on %s without reading projection rows',
  async (reason) => {
    const unreachable = new W5AuthorityUnreachableError('refused', reason);
    const readAllSidebarItems = jest.fn().mockResolvedValue({
      ...sidebar,
      stale: true,
    });
    let available = false;
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems,
        readWorkspaceIndexEntry: jest.fn().mockResolvedValue(null),
        readWorkspaceConfig: jest.fn().mockResolvedValue({
          version: 1,
          type: 'single-repo',
          repos: [],
        }),
        readWorkspaceWorktrees: jest.fn().mockResolvedValue([]),
        readEffectiveWorkspaceConfig: jest
          .fn()
          .mockResolvedValue({ repos: [] }),
        readView: (_request, work) => {
          if (available)
            return work({ status: 'uncaptured', reason: 'direct-store' });
          if (allowsW5ProjectionOnlyRead())
            return work({ status: 'uncaptured', reason: 'daemon-unavailable' });
          throw unreachable;
        },
      },
    });
    setDesktopCanopyRuntime(runtime);
    try {
      await expect(readPortalSidebarItems()).rejects.toBe(unreachable);
      expect(readAllSidebarItems).not.toHaveBeenCalled();
      available = true;
      readAllSidebarItems.mockResolvedValue(sidebar);
      await expect(readPortalSidebarItems()).resolves.toBe(sidebar);
    } finally {
      setDesktopCanopyRuntime(null);
      await runtime.shutdown();
    }
  },
);
