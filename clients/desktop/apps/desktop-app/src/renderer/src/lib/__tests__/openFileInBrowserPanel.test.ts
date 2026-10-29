import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { discardOpenedBrowser } from '@/lib/panels/browser-panel-sync';
import {
  absolutePathToFileUrl,
  openFileInBrowserPanel,
} from '../openFileInBrowserPanel';

const mockGetState = jest.fn();

jest.mock('@/lib/browserPanelActivation', () => ({
  requestBrowserPanel: jest.fn(),
}));
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  discardOpenedBrowser: jest.fn(),
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: { getState: (): unknown => mockGetState() },
}));

const openUrlFromDevServer = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requestBrowserPanel).mockResolvedValue(true);
  jest.mocked(discardOpenedBrowser).mockResolvedValue(undefined);
  mockGetState.mockReturnValue({
    openUrlFromDevServer,
  });
});

describe('openFileInBrowserPanel', () => {
  it('carries background selection protection to the browser activation bridge', async () => {
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-page',
      createdNewSession: true,
      ready: Promise.resolve(null),
    });
    await openFileInBrowserPanel('p', 'w', '/site/index.html', {
      focus: false,
      preserveSelection: true,
    });
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'p',
      'w',
      'browser-page',
      undefined,
      {
        focus: false,
        preserveSelection: true,
      },
    );
  });

  it('reveals the tab without waiting for its session', async () => {
    // The session never finishes opening in this test.
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-page',
      createdNewSession: true,
      ready: new Promise(() => undefined),
    });

    await expect(
      openFileInBrowserPanel('p', 'w', '/site/index.html', {
        originChatTabId: 'chat-1',
      }),
    ).resolves.toBe('browser-page');

    expect(openUrlFromDevServer).toHaveBeenCalledWith('p', 'w', {
      url: 'file:///site/index.html',
    });
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'p',
      'w',
      'browser-page',
      'chat-1',
      undefined,
    );
    expect(discardOpenedBrowser).not.toHaveBeenCalled();
  });

  it('removes the tab and reports null when awaited and the session fails', async () => {
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-page',
      createdNewSession: true,
      ready: Promise.resolve(null),
    });

    await expect(
      openFileInBrowserPanel('p', 'w', '/site/index.html', {
        awaitReady: true,
      }),
    ).resolves.toBeNull();
    expect(discardOpenedBrowser).toHaveBeenCalledWith('p', 'w', 'browser-page');
  });

  it('discards the session when panel placement rejects', async () => {
    jest
      .mocked(requestBrowserPanel)
      .mockRejectedValue(new Error('layout disposed'));
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-page',
      createdNewSession: true,
      ready: new Promise(() => undefined),
    });

    await expect(
      openFileInBrowserPanel('p', 'w', '/site/index.html'),
    ).resolves.toBeNull();
    expect(discardOpenedBrowser).toHaveBeenCalledWith('p', 'w', 'browser-page');
  });

  it('discards the session when the panel cannot be placed', async () => {
    jest.mocked(requestBrowserPanel).mockResolvedValue(false);
    openUrlFromDevServer.mockReturnValue({
      browserId: 'browser-page',
      createdNewSession: true,
      ready: new Promise(() => undefined),
    });

    await expect(
      openFileInBrowserPanel('p', 'w', '/site/index.html'),
    ).resolves.toBeNull();
    expect(discardOpenedBrowser).toHaveBeenCalledWith('p', 'w', 'browser-page');
  });
});

describe('absolutePathToFileUrl', () => {
  it('encodes POSIX paths segment by segment', () => {
    expect(absolutePathToFileUrl('/replica/repos/app/blog/my page.html')).toBe(
      'file:///replica/repos/app/blog/my%20page.html',
    );
  });

  it('keeps the drive letter and adds the leading slash on Windows', () => {
    expect(absolutePathToFileUrl('C:\\replica\\blog\\index.html')).toBe(
      'file:///C:/replica/blog/index.html',
    );
  });

  it('percent-encodes characters that would change the URL meaning', () => {
    expect(absolutePathToFileUrl('/replica/a#b?c.html')).toBe(
      'file:///replica/a%23b%3Fc.html',
    );
  });
});

describe('explicit file browser reuse', () => {
  it('reuses only the previously returned browser identity in the same scope and URL', async () => {
    const openUrlFromDevServer = jest.fn().mockReturnValue({
      browserId: 'new',
      createdNewSession: true,
      ready: Promise.resolve({ id: 'new' }),
    });
    mockGetState.mockReturnValue({
      worktrees: {
        'project/worktree': {
          browsers: { existing: { url: 'file:///report.html' } },
        },
      },
      openUrlFromDevServer,
    });
    jest.mocked(requestBrowserPanel).mockResolvedValue(true);
    await expect(
      openFileInBrowserPanel('project', 'worktree', '/report.html', {
        reuseBrowserId: 'existing',
      }),
    ).resolves.toBe('existing');
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    await expect(
      openFileInBrowserPanel('project', 'other', '/report.html', {
        reuseBrowserId: 'existing',
      }),
    ).resolves.toBe('new');
    await expect(
      openFileInBrowserPanel('project', 'worktree', '/different.html', {
        reuseBrowserId: 'existing',
      }),
    ).resolves.toBe('new');
    await expect(
      openFileInBrowserPanel('project', 'worktree', '/report.html'),
    ).resolves.toBe('new');
    expect(openUrlFromDevServer).toHaveBeenCalledTimes(3);
  });
});
