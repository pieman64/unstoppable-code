import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { ensureWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { discardOpenedBrowser } from '@/lib/panels/browser-panel-sync';
import { useBrowserStore } from '@/stores/browserStore';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { autoOpenDevServerHit, openDevServerHit } from '../devServerOpen';

jest.mock('@/lib/browserPanelActivation', () => ({
  requestBrowserPanel: jest.fn(),
}));

jest.mock('@/lib/panels/browser-panel-activation', () => ({
  initBrowserPanelActivation: jest.fn(),
}));

jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
}));

jest.mock('@/stores/panelLayoutStore', () => ({
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
}));

jest.mock('@/lib/panels/browser-panel-sync', () => ({
  discardOpenedBrowser: jest.fn(),
}));

jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: {
    getState: jest.fn(),
  },
}));

const openExternal = jest.fn();
const openUrlFromDevServer = jest.fn();
const destroyBrowser = jest.fn();
const requestBrowserPanelMock = jest.mocked(requestBrowserPanel);
const ensureWorktreePanelLayoutMock = jest.mocked(ensureWorktreePanelLayout);
const discardOpenedBrowserMock = jest.mocked(discardOpenedBrowser);

function hit(overrides: Partial<DevServerHit> = {}): DevServerHit {
  return {
    url: 'http://localhost:5173/',
    displayUrl: 'http://localhost:5173',
    patternIndex: 0,
    firstSeenAt: 1,
    openTarget: 'in-app',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        browser: {
          openExternal,
        },
      },
    },
  });
  // The backend session is still being created: `ready` never settles here,
  // so everything asserted below happened before it existed.
  openUrlFromDevServer.mockReturnValue({
    browserId: 'browser-dev',
    createdNewSession: true,
    ready: new Promise(() => undefined),
  });
  destroyBrowser.mockResolvedValue(undefined);
  discardOpenedBrowserMock.mockResolvedValue(undefined);
  requestBrowserPanelMock.mockResolvedValue(true);
  ensureWorktreePanelLayoutMock.mockResolvedValue(undefined);
  jest.mocked(useBrowserStore.getState).mockReturnValue({
    openUrlFromDevServer,
    destroyBrowser,
    localServersOnly: true,
    worktrees: {},
  } as unknown as ReturnType<typeof useBrowserStore.getState>);
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('openDevServerHit', () => {
  it('hydrates an unvisited worktree before auto-opening its browser', async () => {
    let completeHydration: (() => void) | undefined;
    ensureWorktreePanelLayoutMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeHydration = resolve;
        }),
    );

    const opened = autoOpenDevServerHit(hit(), {
      projectId: 'project-1',
      worktreeId: 'worktree-2',
    });

    expect(ensureWorktreePanelLayoutMock).toHaveBeenCalledWith(
      'project-1/worktree-2',
    );
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    completeHydration?.();
    await opened;
    await flush();
    expect(openUrlFromDevServer).toHaveBeenCalled();
    expect(requestBrowserPanelMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-2',
      'browser-dev',
      undefined,
      { placement: 'content-panel' },
    );
    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('opens external dev-server targets through the browser IPC', () => {
    openDevServerHit(hit({ openTarget: 'external' }), {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    expect(openExternal).toHaveBeenCalledWith({
      url: 'http://localhost:5173/',
    });
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    expect(requestBrowserPanelMock).not.toHaveBeenCalled();
  });

  it('places the exact bound Browser panel on the click, before the session exists', () => {
    const devServerHit = hit();
    openDevServerHit(devServerHit, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });

    // Synchronously, with no await: the tab is placed on the click itself.
    expect(openUrlFromDevServer).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      devServerHit,
    );
    // Placed like a pipeline run opened from the Activity list, never in
    // the group of the Scripts panel or top bar control that was clicked.
    expect(requestBrowserPanelMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-dev',
      undefined,
      { placement: 'content-panel' },
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('discards the opened session when panel placement rejects', async () => {
    requestBrowserPanelMock.mockRejectedValueOnce(
      new Error('panel placement failed'),
    );

    openDevServerHit(hit(), {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await flush();

    expect(requestBrowserPanelMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-dev',
      undefined,
      { placement: 'content-panel' },
    );
    expect(discardOpenedBrowserMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-dev',
    );
  });

  it('discards the opened session when panel placement fails', async () => {
    requestBrowserPanelMock.mockResolvedValueOnce(false);

    openDevServerHit(hit(), {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await flush();

    expect(discardOpenedBrowserMock).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-dev',
    );
    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('keeps the placed tab when the session is still opening', async () => {
    openDevServerHit(hit(), {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await flush();

    expect(discardOpenedBrowserMock).not.toHaveBeenCalled();
    expect(destroyBrowser).not.toHaveBeenCalled();
  });

  it('falls back to the browser IPC for non-loopback in-app targets', () => {
    openDevServerHit(
      hit({
        url: 'https://example.com/',
        displayUrl: 'https://example.com',
      }),
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    );

    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://example.com/',
    });
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    expect(requestBrowserPanelMock).not.toHaveBeenCalled();
  });

  it('opens remote in-app targets when local-only browsing is disabled', async () => {
    const devServerHit = hit({
      url: 'https://example.com/',
      displayUrl: 'https://example.com',
    });

    jest.mocked(useBrowserStore.getState).mockReturnValue({
      openUrlFromDevServer,
      localServersOnly: false,
      worktrees: {},
    } as unknown as ReturnType<typeof useBrowserStore.getState>);

    openDevServerHit(devServerHit, {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await flush();

    expect(openUrlFromDevServer).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      devServerHit,
    );
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('dev-server opens in a window that shows another computer', () => {
  // The other computer's in-app browser and system browser are both blocked
  // there, and its local servers are not reachable from this computer.
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          browser: { openExternal },
          remoteControl: {
            getContext: (): unknown => ({
              mode: 'remote',
              deviceId: 'device-b',
              name: 'Studio',
              platform: 'darwin',
            }),
          },
        },
      },
    });
  });

  it.each([
    ['in-app', hit()],
    [
      'non-loopback in-app',
      hit({ url: 'https://example.com/', displayUrl: 'https://example.com' }),
    ],
    ['external', hit({ openTarget: 'external' })],
  ])('does not auto-open a %s hit', async (_label, devServerHit) => {
    await autoOpenDevServerHit(devServerHit, {
      projectId: 'project-1',
      worktreeId: 'worktree-2',
    });
    await flush();

    expect(ensureWorktreePanelLayoutMock).not.toHaveBeenCalled();
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    expect(requestBrowserPanelMock).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['in-app', hit()],
    ['external', hit({ openTarget: 'external' })],
  ])(
    'places no Browser panel when a %s Open is clicked',
    async (_label, devServerHit) => {
      openDevServerHit(devServerHit, {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
      await flush();

      expect(openUrlFromDevServer).not.toHaveBeenCalled();
      expect(requestBrowserPanelMock).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    },
  );
});
