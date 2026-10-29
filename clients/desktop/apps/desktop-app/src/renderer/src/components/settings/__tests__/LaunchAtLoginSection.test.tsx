/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  LaunchAtLoginSetResult,
  LaunchAtLoginStatus,
} from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { useLaunchAtLoginStore } from '@/stores/launchAtLoginStore';
import { LaunchAtLoginSection } from '../LaunchAtLoginSection';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

function status(
  overrides: Partial<LaunchAtLoginStatus> = {},
): LaunchAtLoginStatus {
  return {
    platform: 'darwin',
    supported: true,
    enabled: false,
    pendingApproval: false,
    ...overrides,
  };
}

const mockGetStatus = jest.fn<Promise<LaunchAtLoginStatus>, []>();
const mockSetEnabled = jest.fn<Promise<LaunchAtLoginSetResult>, [boolean]>();
const mockOpenSystemSettings = jest.fn<Promise<void>, []>();
let pushStatus: ((next: LaunchAtLoginStatus) => void) | null = null;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  pushStatus = null;
  useLaunchAtLoginStore.setState({
    status: null,
    hydrated: false,
    busy: false,
    error: null,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      launchAtLogin: {
        getStatus: mockGetStatus,
        setEnabled: mockSetEnabled,
        openSystemSettings: mockOpenSystemSettings,
        onStatusChanged: (cb: (next: LaunchAtLoginStatus) => void) => {
          pushStatus = cb;
          return (): void => {
            pushStatus = null;
          };
        },
      },
    },
  });
  mockGetStatus.mockResolvedValue(status());
  mockOpenSystemSettings.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(LaunchAtLoginSection));
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function text(testId: string): string {
  return query(testId)?.textContent ?? '';
}

function toggle(): HTMLElement {
  const element = query('launch-at-login-toggle');
  if (!(element instanceof HTMLElement)) throw new Error('missing toggle');
  return element;
}

async function click(testId: string): Promise<void> {
  const element = query(testId);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${testId}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LaunchAtLoginSection', () => {
  it('names the Mac and shows the OS state off', async () => {
    await render();
    expect(query('settings-canopy-launch-at-login')).not.toBeNull();
    expect(container.textContent).toContain(
      `Open ${brandText.appName} when you sign in to your Mac`,
    );
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().hasAttribute('disabled')).toBe(false);
  });

  it('names Windows on Windows', async () => {
    mockGetStatus.mockResolvedValue(status({ platform: 'win32' }));
    await render();
    expect(container.textContent).toContain(
      `Open ${brandText.appName} when you sign in to Windows`,
    );
  });

  it('shows the OS state on', async () => {
    mockGetStatus.mockResolvedValue(status({ enabled: true }));
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('turns it on through the OS and shows the read-back', async () => {
    mockSetEnabled.mockResolvedValue({
      ok: true,
      status: status({ enabled: true }),
    });
    await render();
    await click('launch-at-login-toggle');
    expect(mockSetEnabled).toHaveBeenCalledWith(true);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(query('launch-at-login-error')).toBeNull();
  });

  it('turns it off', async () => {
    mockGetStatus.mockResolvedValue(status({ enabled: true }));
    mockSetEnabled.mockResolvedValue({ ok: true, status: status() });
    await render();
    await click('launch-at-login-toggle');
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('follows a change pushed from another surface', async () => {
    await render();
    await act(async () => {
      pushStatus?.(status({ enabled: true }));
      await Promise.resolve();
    });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('re-reads the OS state when the window regains focus', async () => {
    await render();
    mockGetStatus.mockResolvedValue(status({ enabled: true }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('asks for approval when macOS is waiting on System Settings', async () => {
    mockGetStatus.mockResolvedValue(status({ pendingApproval: true }));
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(text('launch-at-login-needs-approval')).toContain(
      `Allow ${brandText.appName} in System Settings to finish turning this on.`,
    );
    await click('launch-at-login-open-system-settings');
    expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the OS state and explains a refused turn-on', async () => {
    mockSetEnabled.mockResolvedValue({
      ok: false,
      reason: 'refused',
      status: status(),
    });
    await render();
    await click('launch-at-login-toggle');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(text('launch-at-login-error')).toContain(
      'Could not turn this on. Try again.',
    );
    // macOS has no Startup apps pane to point at.
    expect(query('launch-at-login-open-startup-apps')).toBeNull();
  });

  it('explains a failed turn-off', async () => {
    mockGetStatus.mockResolvedValue(status({ enabled: true }));
    mockSetEnabled.mockRejectedValue(new Error('ipc down'));
    await render();
    await click('launch-at-login-toggle');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(text('launch-at-login-error')).toContain(
      'Could not turn this off. Try again.',
    );
  });

  it('points Windows users at Startup apps after a refusal', async () => {
    mockGetStatus.mockResolvedValue(status({ platform: 'win32' }));
    mockSetEnabled.mockResolvedValue({
      ok: false,
      reason: 'refused',
      status: status({ platform: 'win32' }),
    });
    await render();
    await click('launch-at-login-toggle');
    expect(text('launch-at-login-open-startup-apps')).toBe('Open Startup apps');
    await click('launch-at-login-open-startup-apps');
    expect(mockOpenSystemSettings).toHaveBeenCalledTimes(1);
  });

  it('is disabled in a build that is not installed', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        supported: false,
        unsupportedReason: 'development-build',
      }),
    );
    await render();
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(text('launch-at-login-unavailable')).toBe(
      'Available in the installed app.',
    );
  });

  it('is hidden on Linux', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        platform: 'linux',
        supported: false,
        unsupportedReason: 'platform',
      }),
    );
    await render();
    expect(query('settings-canopy-launch-at-login')).toBeNull();
  });

  it('reports its state to App Advisor', async () => {
    mockGetStatus.mockResolvedValue(status({ pendingApproval: true }));
    await render();
    expect(useCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'settings.launchAtLogin',
      {
        loaded: true,
        supported: true,
        unsupportedReason: null,
        enabled: false,
        pendingApproval: true,
        busy: false,
        error: null,
      },
    );
  });
});
