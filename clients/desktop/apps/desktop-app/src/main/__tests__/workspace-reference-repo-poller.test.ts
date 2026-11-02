import type * as PollerModule from '../lib/workspace-reference-repo-poller';
import type * as HealthModule from '../lib/workspace-reference-repo-health';
import type {
  SidebarItem,
  WorkspaceReferenceRepoStatus,
} from '@canopy/desktop-shared/types';
import type { SendableBrowserWindow } from '../lib/window-send';
import { unusedGitReadRuntime } from './helpers/unused-git-read-runtime';

jest.mock('../lib/workspace-reference-repo-health', () => ({
  inspectReferenceRepo: jest.fn(),
}));

// Inspection is mocked; the poller only hands its dispatcher through.
const gitDispatcher = unusedGitReadRuntime().dispatcher;

function createStatus(
  overrides: Partial<WorkspaceReferenceRepoStatus> = {},
): WorkspaceReferenceRepoStatus {
  return {
    referenceRepoPath: '/mock/reference',
    healthy: true,
    warnings: [],
    lastCheckedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

async function importFreshPoller(): Promise<{
  poller: typeof PollerModule;
  mockedInspectReferenceRepo: jest.MockedFunction<
    typeof HealthModule.inspectReferenceRepo
  >;
}> {
  jest.resetModules();
  const poller = await import('../lib/workspace-reference-repo-poller');
  const health = await import('../lib/workspace-reference-repo-health');
  return {
    poller,
    mockedInspectReferenceRepo: jest.mocked(health.inspectReferenceRepo),
  };
}

function createWorkspace(id: string): SidebarItem {
  return {
    type: 'multi-repo',
    id,
    name: id,
    color: '#000',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 0,
    sourceRepoPath: `/mock/${id}`,
  };
}

function createWindow(send: jest.Mock = jest.fn()): SendableBrowserWindow {
  return {
    isDestroyed: (): boolean => false,
    webContents: {
      send,
      isDestroyed: (): boolean => false,
      isCrashed: (): boolean => false,
      mainFrame: {
        isDestroyed: (): boolean => false,
        detached: false,
      },
    },
  };
}

describe('workspace-reference-repo-poller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('checks tracked projects in FIFO order on the gradual queue', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    mockedInspectReferenceRepo.mockResolvedValue(createStatus());

    const window = createWindow();

    poller.startPolling(() => window, gitDispatcher);
    poller.syncTrackedWorkspaces([
      createWorkspace('workspace-a'),
      createWorkspace('workspace-b'),
    ]);
    poller.requestRefresh('workspace-a', true);
    poller.requestRefresh('workspace-b', true);

    await jest.advanceTimersByTimeAsync(1_000);
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockedInspectReferenceRepo).toHaveBeenNthCalledWith(
      1,
      gitDispatcher,
      'workspace-b',
    );
    expect(mockedInspectReferenceRepo).toHaveBeenNthCalledWith(
      2,
      gitDispatcher,
      'workspace-a',
    );

    poller.stopPolling();
  });

  it('retains polling for projects preserved after a partial load', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    mockedInspectReferenceRepo.mockResolvedValue(createStatus());

    poller.startPolling(() => createWindow(), gitDispatcher);
    poller.syncTrackedWorkspaces([createWorkspace('workspace-a')]);
    poller.syncTrackedWorkspaces([], new Set(['workspace-a']));

    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockedInspectReferenceRepo).toHaveBeenCalledWith(
      gitDispatcher,
      'workspace-a',
    );

    poller.stopPolling();
  });

  it('emits didUpdateReferenceRepo when inspection auto-pulls', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    mockedInspectReferenceRepo.mockResolvedValue(
      createStatus({ didAutoPull: true }),
    );

    const send = jest.fn();
    const window = createWindow(send);

    poller.startPolling(() => window, gitDispatcher);
    poller.syncTrackedWorkspaces([createWorkspace('workspace-a')]);
    poller.requestRefresh('workspace-a', true);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(send).toHaveBeenCalledWith(
      'workspace:reference-repo-status-event',
      expect.objectContaining({
        workspaceId: 'workspace-a',
        didUpdateReferenceRepo: true,
      }),
    );

    poller.stopPolling();
  });

  it('stores refreshed status in the cache', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    const status = createStatus({
      healthy: false,
      warnings: [
        {
          code: 'shadow-sync-failed',
          message: 'shadow sync failed',
        },
      ],
    });
    mockedInspectReferenceRepo.mockResolvedValue(status);

    const window = createWindow();

    poller.startPolling(() => window, gitDispatcher);
    poller.syncTrackedWorkspaces([createWorkspace('workspace-a')]);
    poller.requestRefresh('workspace-a', true);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(poller.getCachedStatus('workspace-a')).toEqual(status);

    poller.stopPolling();
  });

  it('logs and recovers from scheduled tick failures', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockedInspectReferenceRepo
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(createStatus());

    const send = jest.fn();
    const window = createWindow(send);

    poller.startPolling(() => window, gitDispatcher);
    poller.syncTrackedWorkspaces([createWorkspace('workspace-a')]);
    poller.requestRefresh('workspace-a', true);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(warnSpy).toHaveBeenCalledWith(
      'workspace reference repo poller tick failed',
      expect.any(Error),
    );

    poller.requestRefresh('workspace-a', true);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockedInspectReferenceRepo).toHaveBeenCalledWith(
      gitDispatcher,
      'workspace-a',
    );
    expect(send).toHaveBeenCalledWith(
      'workspace:reference-repo-status-event',
      expect.objectContaining({
        workspaceId: 'workspace-a',
      }),
    );

    poller.stopPolling();
    warnSpy.mockRestore();
  });

  it('resolveWarning only triggers a forced refresh regardless of code', async () => {
    const { poller, mockedInspectReferenceRepo } = await importFreshPoller();
    mockedInspectReferenceRepo.mockResolvedValue(createStatus());

    const window = createWindow();

    poller.startPolling(() => window, gitDispatcher);
    poller.syncTrackedWorkspaces([createWorkspace('workspace-a')]);
    poller.requestRefresh('workspace-a', true);
    await jest.advanceTimersByTimeAsync(1_000);
    mockedInspectReferenceRepo.mockClear();

    await poller.resolveWarning('workspace-a', 'shadow-sync-failed');
    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockedInspectReferenceRepo).toHaveBeenCalledWith(
      gitDispatcher,
      'workspace-a',
    );

    poller.stopPolling();
  });
});
