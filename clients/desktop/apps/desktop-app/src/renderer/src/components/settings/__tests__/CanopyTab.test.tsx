/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CliPathStatus, UpdateState } from '@canopy/desktop-shared/types';
import { useUpdateState } from '@/hooks/useUpdateState';
import { useGitHubCliStatus } from '@/hooks/useGitHubCliStatus';
import { CanopyTab } from '../CanopyTab';
import { useRepoRulesModalStore } from '@/stores/repoRulesModalStore';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// The tips row reads the shared tip store, which needs a client provider;
// its own coverage is ShowTipsAgainRow.test.tsx.
jest.mock('../ShowTipsAgainRow', () => ({
  ShowTipsAgainRow: (): null => null,
}));
jest.mock('@/hooks/useGitHubCliStatus', () => ({
  useGitHubCliStatus: jest.fn(() => ({
    authenticated: true,
    username: 'tester',
    error: null,
    tokenSource: 'gh',
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: true,
  })),
}));

jest.mock('@/hooks/useUpdateState', () => ({
  useUpdateState: jest.fn(),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

jest.mock('@/components/onboarding/AppLoadingScreen', () => ({
  AppLoadingScreen: (): null => null,
}));

const FALLBACK_DIR = '/Users/jane.doe/.canopy';
const PRIMARY_DIR = '/Users/jane.doe/.testbrand';

function byTestId(testId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!found) throw new Error(`Missing ${testId}`);
  return found;
}

function mockUpdateState(state: UpdateState): void {
  jest.mocked(useUpdateState).mockReturnValue({
    appVersion: 'internal-88',
    dependencyVersions: null,
    state,
    refresh: jest.fn(),
  });
}

describe('CanopyTab error messages', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousReleaseFlavor: string;
  let api: {
    cli: {
      getStatus: jest.Mock;
      installToPath: jest.Mock;
      uninstallFromPath: jest.Mock;
    };
    loadGitHubPat: jest.Mock;
    onPreferencesSynced: jest.Mock;
    loadPreferences: jest.Mock;
    savePreferences: jest.Mock;
    createPrimaryDataDir: jest.Mock;
    restartApp: jest.Mock;
    update: {
      listVersions: jest.Mock;
      checkForUpdates: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.mocked(useGitHubCliStatus).mockReturnValue({
      authenticated: true,
      username: 'tester',
      error: null,
      tokenSource: 'gh',
      envOverride: false,
      envOverrideName: null,
      hasCredentialStoreLogin: true,
    });
    previousReleaseFlavor = __CANOPY_RELEASE_FLAVOR__;
    Object.defineProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__', {
      configurable: true,
      writable: true,
      value: 'internal',
    });
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 0;
      });
    mockUpdateState({ phase: 'idle' });
    api = {
      cli: {
        getStatus: jest.fn().mockResolvedValue({
          state: 'foreign-symlink',
          symlinkPath: '/usr/local/bin/canopy',
          symlinkTarget: '/Users/jane.doe/bin/other-cli',
          bundledCliPath: '/Users/jane.doe/Applications/Canopy.app/cli',
        }),
        installToPath: jest.fn(),
        uninstallFromPath: jest.fn(),
      },
      loadGitHubPat: jest.fn().mockResolvedValue(''),
      onPreferencesSynced: jest.fn(() => jest.fn()),
      loadPreferences: jest.fn().mockResolvedValue({
        auditRetentionDays: 7,
        autoDownloadUpdates: true,
        __dataDir: {
          path: FALLBACK_DIR,
          source: 'fallback',
          allCandidates: [PRIMARY_DIR, FALLBACK_DIR],
        },
      }),
      savePreferences: jest.fn().mockResolvedValue(undefined),
      createPrimaryDataDir: jest
        .fn()
        .mockRejectedValue(
          new Error(`EACCES: permission denied ${PRIMARY_DIR}`),
        ),
      restartApp: jest.fn().mockResolvedValue(true),
      update: {
        listVersions: jest.fn(),
        checkForUpdates: jest.fn().mockResolvedValue(undefined),
      },
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it.each(['stable', 'internal', 'rc'])(
    'shows the private update auth hint only when required on %s',
    async (flavor) => {
      Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', flavor);
      jest.mocked(useGitHubCliStatus).mockReturnValue({
        authenticated: false,
        username: null,
        error: null,
        tokenSource: null,
        envOverride: false,
        envOverrideName: null,
        hasCredentialStoreLogin: false,
      });
      await act(async () => {
        root.render(<CanopyTab />);
        await Promise.resolve();
      });
      expect(
        container.textContent?.includes(
          'Private release checks need GitHub access',
        ),
      ).toBe(flavor !== 'stable');
    },
  );

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__', {
      configurable: true,
      writable: true,
      value: previousReleaseFlavor,
    });
    Reflect.deleteProperty(window, 'api');
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  async function renderTab(): Promise<void> {
    await act(async () => {
      root.render(<CanopyTab />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  // CAN-2053: Settings has no workspace context, so the review asks the user
  // to choose one instead of picking one.
  it('opens the Cursor rules review without choosing a workspace', async () => {
    useRepoRulesModalStore.getState().close();
    await renderTab();
    act(() => byTestId('settings-canopy-import-editor-setup-open').click());
    expect(useRepoRulesModalStore.getState().target).toEqual({
      source: 'settings',
    });
    useRepoRulesModalStore.getState().close();
  });

  it('warns where imported Code project chats open', async () => {
    await renderTab();
    const row = byTestId('settings-canopy-import-projects').textContent ?? '';
    expect(row).toContain('Source folders stay where they are.');
    expect(row).toContain(
      'Chats from a Code project open in a new worktree based on the default branch from your remote when available.',
    );
    expect(row).toContain(
      'Uncommitted or unpushed changes stay in the original folder.',
    );
  });

  it('shows the folder creation error', async () => {
    await renderTab();
    act(() => byTestId('settings-data-dir-create-primary').click());

    await act(async () => {
      byTestId('settings-data-dir-confirm-create').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const error = byTestId('settings-data-dir-error');
    expect(error.textContent).toContain('EACCES');
  });

  it('shows a failed shell integration message', async () => {
    api.cli.getStatus.mockResolvedValue({
      state: 'missing',
      symlinkPath: '/usr/local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: null,
    });
    api.cli.installToPath.mockResolvedValue({
      success: false,
      error: 'Permission denied: /Users/jane.doe/bin',
    });
    await renderTab();
    await act(async () => {
      byTestId('settings-shell-integration-action').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const message = byTestId('settings-shell-integration-message');
    expect(message.textContent).toContain('/Users/jane.doe/bin');
  });

  it('offers Linux installation, refreshes an outdated CLI and then offers removal', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const status = {
      state: 'missing',
      symlinkPath: '/home/test/.local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/opt/canopy/resources/cli/canopy',
    };
    api.cli.getStatus.mockResolvedValue(status);
    api.cli.installToPath.mockResolvedValue({ success: true, error: null });
    await renderTab();
    const button = byTestId('settings-shell-integration-action');
    expect(button.hasAttribute('disabled')).toBe(false);
    api.cli.getStatus.mockResolvedValue({ ...status, state: 'outdated' });
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(api.cli.installToPath).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Update CLI');
    expect(byTestId('settings-shell-integration').textContent).toContain(
      'outdated',
    );
    api.cli.getStatus.mockResolvedValue({
      ...status,
      state: 'correct-symlink',
    });
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(api.cli.installToPath).toHaveBeenCalledTimes(2);
    expect(api.cli.uninstallFromPath).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Remove CLI');
  });

  it('refreshes the Linux package status when Settings regains focus', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const status = {
      state: 'correct-symlink',
      symlinkPath: '/home/test/.local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/opt/canopy/resources/cli/canopy',
    };
    api.cli.getStatus.mockResolvedValue(status);
    await renderTab();
    expect(byTestId('settings-shell-integration-action').textContent).toBe(
      'Remove CLI',
    );
    api.cli.getStatus.mockResolvedValue({ ...status, state: 'outdated' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(byTestId('settings-shell-integration-action').textContent).toBe(
      'Update CLI',
    );
  });

  it('ignores an earlier CLI status read that settles after a newer focus refresh', async () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    const status: CliPathStatus = {
      state: 'correct-symlink',
      symlinkPath: '/home/test/.local/bin/canopy',
      symlinkTarget: null,
      bundledCliPath: '/opt/canopy/resources/cli/canopy',
    };
    api.cli.getStatus.mockResolvedValue(status);
    await renderTab();
    let resolveStale: ((value: CliPathStatus) => void) | undefined;
    const stale = new Promise<CliPathStatus>((resolve) => {
      resolveStale = resolve;
    });
    api.cli.getStatus
      .mockReturnValueOnce(stale)
      .mockResolvedValue({ ...status, state: 'outdated' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    if (!resolveStale) throw new Error('Missing deferred status resolver');
    const settle = resolveStale;
    await act(async () => {
      settle({ ...status, state: 'missing' });
      await Promise.resolve();
    });
    expect(byTestId('settings-shell-integration-action').textContent).toBe(
      'Update CLI',
    );
  });

  it('shows an updater error message', async () => {
    mockUpdateState({
      phase: 'error',
      message: 'ENOENT: /Users/jane.doe/Library/Caches/update.zip',
    });
    await renderTab();
    act(() => byTestId('settings-update-check').click());
    const status = byTestId('settings-update-status');
    expect(status.textContent).toContain('ENOENT');
  });
});
