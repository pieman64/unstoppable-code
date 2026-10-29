import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { discardOpenedBrowser } from '@/lib/panels/browser-panel-sync';
import { useBrowserStore } from '@/stores/browserStore';
import { openOnboardingAuthorizationUrl } from '../openOnboardingAuthorizationUrl';

jest.mock('@/lib/browserPanelActivation', () => ({
  requestBrowserPanel: jest.fn(),
}));
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  discardOpenedBrowser: jest.fn(),
}));
jest.mock('@/stores/browserStore', () => ({
  useBrowserStore: { getState: jest.fn() },
}));

const openBrowser = jest.fn();

function liveSnapshot(): BrowserSessionSnapshot {
  return {
    id: 'browser-auth',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 1,
    url: 'https://auth.openai.com/oauth/authorize?state=x',
    title: '',
    status: 'loading',
    canGoBack: false,
    canGoForward: false,
    loading: true,
    themeMode: 'light',
    pickMode: false,
    recording: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  openBrowser.mockReturnValue({
    browserId: 'browser-auth',
    ready: Promise.resolve(liveSnapshot()),
  });
  jest.mocked(discardOpenedBrowser).mockResolvedValue(undefined);
  jest.mocked(requestBrowserPanel).mockResolvedValue(true);
  jest.mocked(useBrowserStore.getState).mockReturnValue({
    openBrowser,
  } as unknown as ReturnType<typeof useBrowserStore.getState>);
});

describe('openOnboardingAuthorizationUrl', () => {
  const target = {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
  const url = 'https://auth.openai.com/oauth/authorize?state=x';

  it('places and focuses an exact Browser panel beside the new task before its session exists', async () => {
    let finish: (value: BrowserSessionSnapshot | null) => void = () =>
      undefined;
    openBrowser.mockReturnValue({
      browserId: 'browser-auth',
      ready: new Promise((resolve) => {
        finish = resolve;
      }),
    });

    const result = openOnboardingAuthorizationUrl(target, url);
    await Promise.resolve();

    expect(openBrowser).toHaveBeenCalledWith('project-1', 'worktree-1', {
      url,
    });
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-auth',
      'chat-1',
      { focus: true },
    );
    finish(liveSnapshot());
    await expect(result).resolves.toBe(true);
    expect(discardOpenedBrowser).not.toHaveBeenCalled();
  });

  it('discards the opened session when panel placement fails', async () => {
    jest.mocked(requestBrowserPanel).mockResolvedValue(false);
    await expect(openOnboardingAuthorizationUrl(target, url)).resolves.toBe(
      false,
    );
    expect(discardOpenedBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-auth',
    );
  });

  it('removes the tab and reports failure when the session cannot be created', async () => {
    openBrowser.mockReturnValue({
      browserId: 'browser-auth',
      ready: Promise.resolve(null),
    });
    await expect(openOnboardingAuthorizationUrl(target, url)).resolves.toBe(
      false,
    );
    expect(discardOpenedBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-auth',
    );
  });
});
