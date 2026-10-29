/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_LOCAL_MEMORY_MODEL,
  initClaudeModels,
  initCodexModels,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { LocalMemorySettings } from '../LocalMemorySettings';

type PreferencesSyncedCallback = (preferences: PreferencesData) => void;

interface MockApi {
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
  openMemoryDir: jest.Mock<Promise<void>, [string?]>;
  onPreferencesSynced: jest.Mock<() => void, [PreferencesSyncedCallback]>;
}

describe('LocalMemorySettings', () => {
  let container: HTMLElement;
  let root: Root;
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let api: MockApi;
  let syncedCallbacks: PreferencesSyncedCallback[];
  let unsubscribePreferencesSynced: jest.Mock<void, []>;

  beforeAll(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: DEFAULT_LOCAL_MEMORY_MODEL, label: 'GPT 6.1 Sol' }]);
  });

  beforeEach(async () => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    const preferences = makeTestPreferences();
    syncedCallbacks = [];
    unsubscribePreferencesSynced = jest.fn<void, []>();
    api = {
      loadPreferences: jest
        .fn<Promise<PreferencesData>, []>()
        .mockResolvedValue(preferences),
      savePreferences: jest.fn((patch) =>
        Promise.resolve(makeTestPreferences(patch)),
      ),
      openMemoryDir: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
      onPreferencesSynced: jest.fn((callback: PreferencesSyncedCallback) => {
        syncedCallbacks.push(callback);
        return unsubscribePreferencesSynced;
      }),
    };
    Object.defineProperty(window, 'api', { configurable: true, value: api });
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<LocalMemorySettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('optimistically toggles and persists the local memory preference', () => {
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-memory-enabled-toggle"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    act(() => toggle?.click());

    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(api.savePreferences).toHaveBeenCalledWith({
      localMemoryEnabled: false,
      localMemoryEnabledSetByUser: true,
    });
  });

  it('shows the memory model and saves a new model with a clamped thinking level', () => {
    const model = container.querySelector<HTMLSelectElement>(
      '[data-testid="local-memory-model"]',
    );
    expect(model?.value).toBe(DEFAULT_LOCAL_MEMORY_MODEL);
    expect(model?.disabled).toBe(false);

    act(() => {
      if (!model) return;
      model.value = 'claude-sonnet-4-6';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(api.savePreferences).toHaveBeenCalledWith({
      localMemoryModel: 'claude-sonnet-4-6',
      localMemoryModelSetByUser: true,
      localMemoryThinkingLevel: 'high',
    });
    expect(model?.value).toBe('claude-sonnet-4-6');
  });

  it('follows a synced memory model and disables it while memory is off', () => {
    act(() => {
      syncedCallbacks[0](
        makeTestPreferences({
          localMemoryEnabled: false,
          localMemoryModel: 'claude-sonnet-4-6',
          localMemoryThinkingLevel: 'high',
        }),
      );
    });
    const model = container.querySelector<HTMLSelectElement>(
      '[data-testid="local-memory-model"]',
    );
    expect(model?.value).toBe('claude-sonnet-4-6');
    expect(model?.disabled).toBe(true);
  });

  it('opens the local memory folder through the main-process bridge', () => {
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-memory-open-folder"]',
    );

    act(() => button?.click());

    expect(api.openMemoryDir).toHaveBeenCalledTimes(1);
  });

  it('does not offer a manual memory import control', () => {
    expect(
      container.querySelector('[data-testid="local-memory-import-claude"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Import Claude Code');
  });

  it('reports the panel state to the App Advisor and clears it on unmount', async () => {
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toEqual({ loaded: true, enabled: true });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-memory-enabled-toggle"]',
    );
    act(() => toggle?.click());
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toEqual({ loaded: true, enabled: false });

    act(() => root.unmount());
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toBeUndefined();
    await act(async () => {
      root = createRoot(container);
      root.render(<LocalMemorySettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('updates the switch when a preferences-synced broadcast arrives', () => {
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-memory-enabled-toggle"]',
    );
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(syncedCallbacks).toHaveLength(1);

    act(() => {
      syncedCallbacks[0](makeTestPreferences({ localMemoryEnabled: false }));
    });

    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toEqual({ loaded: true, enabled: false });

    act(() => {
      syncedCallbacks[0](makeTestPreferences({ localMemoryEnabled: true }));
    });

    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toEqual({ loaded: true, enabled: true });
  });

  it('ignores a late initial-load response after a synced value arrived', async () => {
    act(() => root.unmount());

    let resolveLoad: ((preferences: PreferencesData) => void) | undefined;
    api.loadPreferences.mockImplementation(
      () =>
        new Promise<PreferencesData>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    syncedCallbacks = [];

    await act(async () => {
      root = createRoot(container);
      root.render(<LocalMemorySettings />);
      await Promise.resolve();
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="local-memory-enabled-toggle"]',
    );
    expect(syncedCallbacks).toHaveLength(1);
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    // The synced broadcast lands before the initial load resolves.
    act(() => {
      syncedCallbacks[0](makeTestPreferences({ localMemoryEnabled: false }));
    });
    expect(toggle?.getAttribute('aria-checked')).toBe('false');

    // The stale initial-load response must not clobber the synced value.
    await act(async () => {
      resolveLoad?.(makeTestPreferences({ localMemoryEnabled: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.settings?.localMemory,
    ).toEqual({ loaded: true, enabled: false });
  });

  it('unsubscribes from the preferences-synced broadcast on unmount', async () => {
    expect(api.onPreferencesSynced).toHaveBeenCalledTimes(1);
    expect(unsubscribePreferencesSynced).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(unsubscribePreferencesSynced).toHaveBeenCalledTimes(1);

    await act(async () => {
      root = createRoot(container);
      root.render(<LocalMemorySettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});
