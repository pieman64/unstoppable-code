/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';
import { MAX_MANAGED_DELEGATION_CONCURRENCY } from '@canopy/protocol/delegation/discovery';
import { makeTestPreferences } from '@/test-utils/preferences';
import { ManagedDelegationSettings } from '../ManagedDelegationSettings';
import { emitManagedDelegationPreferenceUpdated } from '@/lib/managedDelegationPreferenceEvents';

const reportUiState = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (
    key: string,
    value: Record<string, unknown>,
  ): void => {
    reportUiState(key, value);
  },
}));

describe('ManagedDelegationSettings', () => {
  let container: HTMLElement;
  let root: Root;
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  const savePreferences = jest.fn();
  let preferencesSynced:
    | ((preferences: PreferencesSaveResult) => void)
    | undefined;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'platform',
    );
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        savePreferences,
        onPreferencesSynced: jest.fn(
          (callback: (preferences: PreferencesSaveResult) => void) => {
            preferencesSynced = callback;
            return jest.fn();
          },
        ),
      },
    });
    savePreferences.mockReset();
    reportUiState.mockClear();
    preferencesSynced = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
    if (originalPlatformDescriptor)
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    else Reflect.deleteProperty(window, 'platform');
  });

  it('preserves an incomplete shutdown warning when settings remount', () => {
    act(() => {
      root.render(
        <ManagedDelegationSettings
          initialMode="off"
          initialRevocationIncomplete
        />,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      {
        loaded: true,
        mode: 'off',
        maxDepth: 1,
        revocationIncomplete: true,
      },
    );
  });

  it('defaults depth to one, saves ten, and follows external preference changes', async () => {
    act(() =>
      root.render(<ManagedDelegationSettings initialMode="proactive" />),
    );
    const depth = container.querySelector<HTMLSelectElement>(
      '[data-testid="settings-managed-delegation-depth"]',
    );
    expect(depth?.value).toBe('1');
    if (!depth) throw new Error('Expected depth selector');
    expect(depth.options.length).toBe(10);
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      expect.objectContaining({ maxDepth: 1 }),
    );
    savePreferences.mockResolvedValue({
      ...makeTestPreferences(),
      managedDelegationMaxDepth: 10,
    });
    await act(async () => {
      await Promise.resolve();
      depth.value = '10';
      depth.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(savePreferences).toHaveBeenCalledWith({
      managedDelegationMaxDepth: 10,
    });
    expect(depth.value).toBe('10');
    act(() =>
      preferencesSynced?.({
        ...makeTestPreferences(),
        managedDelegationMaxDepth: 2,
      }),
    );
    expect(depth.value).toBe('2');
  });

  it('offers every concurrency value up to the app limit and says extra tasks queue', () => {
    act(() =>
      root.render(<ManagedDelegationSettings initialMode="proactive" />),
    );
    const concurrency = container.querySelector<HTMLSelectElement>(
      '[data-testid="settings-managed-delegation-concurrency"]',
    );
    if (!concurrency) throw new Error('Expected concurrency selector');
    expect(concurrency.options.length).toBe(MAX_MANAGED_DELEGATION_CONCURRENCY);
    const help = container.querySelector(
      '[data-testid="settings-managed-delegation-concurrency-help"]',
    );
    expect(help?.textContent).toContain(
      'Tasks over the limit wait their turn and start automatically.',
    );
    expect(help?.textContent).toContain(
      `The application-wide limit is ${MAX_MANAGED_DELEGATION_CONCURRENCY}.`,
    );
    expect(help?.textContent).not.toContain('limit is 16.');
  });

  const windowsNote = (): HTMLElement | null =>
    container.querySelector(
      '[data-testid="settings-managed-delegation-windows-codex"]',
    );

  it('enables managed delegation on Windows and says Codex tasks run unsandboxed', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });

    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((select) => !select.disabled)).toBe(true);
    expect(windowsNote()?.textContent).toBe(
      "On Windows, Codex tasks run without the Codex sandbox and follow this chat's approval settings.",
    );
  });

  it('keeps managed delegation unavailable on other platforms', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'linux',
    });
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });

    const selects = Array.from(container.querySelectorAll('select'));
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(container.textContent).toContain(
      'Managed delegation is currently available on macOS and Windows.',
    );
    expect(windowsNote()).toBeNull();
  });

  it('warns and retries when turning consultation off cannot stop every child', async () => {
    savePreferences
      .mockResolvedValueOnce({
        ...makeTestPreferences({ managedDelegationMode: 'off' }),
        __managedDelegationRevocationIncomplete: true,
      })
      .mockResolvedValueOnce(
        makeTestPreferences({ managedDelegationMode: 'off' }),
      );
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="proactive" />);
    });
    const select = container.querySelector<HTMLSelectElement>('select');
    if (!select) throw new Error('Expected consultation select');
    // The shared settings dropdown draws its outline with the secondary
    // hairline ring, because a `border-<color>` utility never paints over
    // the base border rule.
    expect(select.classList.contains('ring-line-secondary')).toBe(true);
    expect(select.classList.contains('border-border')).toBe(false);

    await act(async () => {
      select.value = 'off';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(select.value).toBe('off');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry shutdown',
    );
    if (!retry) throw new Error('Expected retry shutdown button');
    // The shared secondary button draws its outline with a ring, because a
    // `border-<color>` utility never paints over the base border rule.
    expect(retry.classList.contains('ring-line-secondary')).toBe(true);
    expect(retry.classList.contains('border-border')).toBe(false);
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reflects preference changes saved through App Advisor', () => {
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });
    if (!preferencesSynced) throw new Error('Expected preferences listener');
    act(() => {
      preferencesSynced?.(
        makeTestPreferences({ managedDelegationMode: 'explicit-only' }),
      );
    });
    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe(
      'explicit-only',
    );
    act(() => {
      emitManagedDelegationPreferenceUpdated({
        mode: 'proactive',
        revocationIncomplete: false,
      });
    });

    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe(
      'proactive',
    );
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      {
        loaded: true,
        mode: 'proactive',
        maxDepth: 1,
        revocationIncomplete: false,
      },
    );
  });

  it('preserves the effective fallback and synchronizes revocation status', () => {
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="explicit-only" />);
    });
    if (!preferencesSynced) throw new Error('Expected preferences listener');

    act(() => {
      preferencesSynced?.({
        ...makeTestPreferences({ managedDelegationMode: undefined }),
        __managedDelegationRevocationIncomplete: true,
      });
    });

    expect(container.querySelector<HTMLSelectElement>('select')?.value).toBe(
      'explicit-only',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
  });
});
