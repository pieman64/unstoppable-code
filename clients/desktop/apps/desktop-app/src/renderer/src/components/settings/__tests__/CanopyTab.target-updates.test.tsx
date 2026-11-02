/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyApi, UpdateState } from '@canopy/desktop-shared/types';
import { useUpdateState } from '@/hooks/useUpdateState';
import { makeTestPreferences } from '@/test-utils/preferences';
import { CanopyTab } from '../CanopyTab';

type TargetUpdateApiDouble = Pick<
  CanopyApi,
  'loadGitHubPat' | 'onPreferencesSynced' | 'loadPreferences'
> & {
  cli: Pick<CanopyApi['cli'], 'getStatus'>;
  update: Pick<
    CanopyApi['update'],
    | 'listVersions'
    | 'checkForVersion'
    | 'checkForUpdates'
    | 'installUpdate'
    | 'scheduleUpdate'
    | 'cancelScheduledUpdate'
  >;
};

const installUpdateMock = jest
  .fn<
    ReturnType<CanopyApi['update']['installUpdate']>,
    Parameters<CanopyApi['update']['installUpdate']>
  >()
  .mockResolvedValue(undefined);
const scheduleUpdateMock = jest
  .fn<
    ReturnType<NonNullable<CanopyApi['update']['scheduleUpdate']>>,
    Parameters<NonNullable<CanopyApi['update']['scheduleUpdate']>>
  >()
  .mockResolvedValue(undefined);
const cancelScheduledUpdateMock = jest
  .fn<
    ReturnType<NonNullable<CanopyApi['update']['cancelScheduledUpdate']>>,
    Parameters<NonNullable<CanopyApi['update']['cancelScheduledUpdate']>>
  >()
  .mockResolvedValue(undefined);

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
  useUpdateState: jest.fn(() => ({
    appVersion: 'internal-88',
    dependencyVersions: {
      claudeCli: '1.0.0',
      claudeSdk: '1.0.0',
      codexCli: '1.0.0',
      ghCli: '1.0.0',
      rtkCli: '1.0.0',
      octokit: '1.0.0',
    },
    state: { phase: 'idle' },
    refresh: jest.fn(),
  })),
}));

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

describe('CanopyTab targeted update dialogs', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousReleaseFlavor: string;

  beforeEach(() => {
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
    jest.mocked(useUpdateState).mockReturnValue({
      appVersion: 'internal-88',
      dependencyVersions: {
        claudeCli: '1.0.0',
        claudeSdk: '1.0.0',
        codexCli: '1.0.0',
        ghCli: '1.0.0',
        rtkCli: '1.0.0',
        octokit: '1.0.0',
      },
      state: { phase: 'idle' },
      refresh: jest.fn(),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getStatus: jest.fn().mockResolvedValue({
            state: 'unsupported',
            reason: 'dev',
          }),
        },
        loadGitHubPat: jest.fn().mockResolvedValue(''),
        onPreferencesSynced: jest.fn(() => jest.fn()),
        loadPreferences: jest.fn().mockResolvedValue({
          ...makeTestPreferences({
            auditRetentionDays: 7,
            autoDownloadUpdates: true,
          }),
          __dataDir: {
            path: '/mock/home/.canopy',
            source: 'fallback',
            allCandidates: ['/mock/home/.testbrand', '/mock/home/.canopy'],
          },
        }),
        update: {
          listVersions: jest.fn().mockResolvedValue({
            items: [
              {
                tag: 'internal-80',
                version: 'internal-80',
                relation: 'downgrade',
              },
            ],
            nextCursor: null,
          }),
          checkForVersion: jest.fn().mockResolvedValue(undefined),
          checkForUpdates: jest.fn().mockResolvedValue(undefined),
          installUpdate: installUpdateMock,
          scheduleUpdate: scheduleUpdateMock,
          cancelScheduledUpdate: cancelScheduledUpdateMock,
        },
      } satisfies TargetUpdateApiDouble,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__', {
      configurable: true,
      writable: true,
      value: previousReleaseFlavor,
    });
    Reflect.deleteProperty(window, 'api');
    jest.clearAllMocks();
  });

  it('applies the elevated overlay class to targeted update dialogs', async () => {
    await act(async () => {
      root.render(<CanopyTab />);
      await Promise.resolve();
    });

    const selectVersion = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-update-select-version"]',
    );
    expect(selectVersion).not.toBeNull();

    await act(async () => {
      selectVersion?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const picker = document.querySelector<HTMLElement>(
      '[data-testid="settings-update-version-picker-modal"]',
    );
    expect(picker?.parentElement?.classList.contains('z-modal')).toBe(true);

    const downgrade = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-update-version-option"]',
    );
    expect(downgrade).not.toBeNull();

    act(() => downgrade?.click());

    const confirmation = document.querySelector<HTMLElement>(
      '[data-testid="settings-update-downgrade-modal"]',
    );
    expect(confirmation?.parentElement?.classList.contains('z-modal')).toBe(
      true,
    );
  });

  it('applies the elevated overlay class to the data-folder confirmation', async () => {
    await act(async () => {
      root.render(<CanopyTab />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const usePrimaryFolder = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-data-dir-create-primary"]',
    );
    expect(usePrimaryFolder).not.toBeNull();

    act(() => usePrimaryFolder?.click());

    const confirmation = document.querySelector<HTMLElement>(
      '[data-testid="settings-data-dir-confirm-modal"]',
    );
    expect(confirmation?.parentElement?.classList.contains('z-modal')).toBe(
      true,
    );
  });

  it.each<{
    state: UpdateState;
    actionLabel: string;
    apiAction: 'scheduleUpdate' | 'cancelScheduledUpdate';
  }>([
    {
      state: {
        phase: 'downloaded',
        installPending: false,
        info: { version: 'internal-89' },
      },
      actionLabel: 'Install when idle',
      apiAction: 'scheduleUpdate',
    },
    {
      state: {
        phase: 'downloaded',
        installPending: true,
        info: { version: 'internal-89' },
      },
      actionLabel: 'Cancel scheduled update',
      apiAction: 'cancelScheduledUpdate',
    },
  ])(
    'keeps downloaded update actions available in Settings: $actionLabel',
    async ({ state, actionLabel, apiAction }) => {
      jest.mocked(useUpdateState).mockReturnValue({
        appVersion: 'internal-88',
        dependencyVersions: null,
        state,
        refresh: jest.fn(),
      });

      await act(async () => {
        root.render(<CanopyTab />);
        await Promise.resolve();
      });

      const installNow = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-update-install-now"]',
      );
      const scheduleAction = container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-update-schedule-action"]',
      );

      expect(installNow).not.toBeNull();
      expect(scheduleAction?.textContent).toBe(actionLabel);

      act(() => {
        installNow?.click();
        scheduleAction?.click();
      });

      const secondaryActionMocks = {
        scheduleUpdate: scheduleUpdateMock,
        cancelScheduledUpdate: cancelScheduledUpdateMock,
      };
      expect(installUpdateMock).toHaveBeenCalledTimes(1);
      expect(secondaryActionMocks[apiAction]).toHaveBeenCalledTimes(1);
    },
  );
});
