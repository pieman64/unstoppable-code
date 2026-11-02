/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { ClaudeTab } from '../ClaudeTab';
import { makeTestPreferences } from '../../../test-utils/preferences';
import { invalidateClaudeAuthStatusCache } from '@/hooks/useClaudeAuthStatus';
import { emitPreferencesUpdated } from '@/lib/preferences-events';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';

const mockLoadModelDefaults = jest.fn<Promise<void>, []>();

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { loadModelDefaults: () => Promise<void> }) => unknown,
  ): unknown => selector({ loadModelDefaults: mockLoadModelDefaults }),
}));

describe('ClaudeTab', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    window,
    'platform',
  );
  const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();
  const savePreferencesMock = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >();
  const getClaudeAuthStatusMock = jest.fn();

  function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
      resolve = innerResolve;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
    getClaudeAuthStatusMock.mockReset();
    invalidateClaudeAuthStatusCache();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    mockLoadModelDefaults.mockReset();
    mockLoadModelDefaults.mockResolvedValue(undefined);
    getClaudeAuthStatusMock.mockResolvedValue({
      authenticated: true,
      accountLabel: 'dev@example.com',
      detail: null,
      error: null,
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
        getClaudeAuthStatus: getClaudeAuthStatusMock,
      },
    });
    setPlatform('darwin');
  });

  afterEach(() => {
    invalidateClaudeAuthStatusCache();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
  });

  it('keeps Claude turn settings available on Windows with terminal flags disabled', async () => {
    setPlatform('win32');
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key] =
      false;
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key] =
      false;
    useFeatureFlagsStore.setState({ snapshot });
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const rendered = await renderTab();
    try {
      const input = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-max-turns"]',
      );
      expect(input?.value).toBe('500');
    } finally {
      rendered.cleanup();
    }
  });

  it('updates mounted turn-limit controls when App Advisor saves preferences', async () => {
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const rendered = await renderTab();
    try {
      act(() => {
        emitPreferencesUpdated(makeTestPreferences({ claudeMaxTurns: 250 }));
      });
      expect(
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-max-turns"]',
        )?.value,
      ).toBe('250');
      act(() => {
        emitPreferencesUpdated(makeTestPreferences({ claudeMaxTurns: null }));
      });
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-max-turns"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('turns the limit off with the click that blurs an edited number', async () => {
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const numberSave = createDeferred<PreferencesData>();
    savePreferencesMock
      .mockReturnValueOnce(numberSave.promise)
      .mockResolvedValueOnce(makeTestPreferences({ claudeMaxTurns: null }));
    const rendered = await renderTab();
    try {
      const input = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-max-turns"]',
      );
      const toggle = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-claude-limit-turns"]',
      );
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.bind(input);
      if (!input || !toggle || !setValue)
        throw new Error('Missing turn controls');
      act(() => {
        setValue('750');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(
          new FocusEvent('focusout', { bubbles: true, relatedTarget: toggle }),
        );
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenCalledWith({ claudeMaxTurns: 750 });
      act(() => {
        toggle.click();
      });
      expect(savePreferencesMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        numberSave.resolve(makeTestPreferences({ claudeMaxTurns: 750 }));
        await numberSave.promise;
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        claudeMaxTurns: null,
      });
      expect(toggle.getAttribute('aria-checked')).toBe('false');
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-max-turns"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('renders both interface-mode options and highlights the persisted choice', async () => {
    loadPreferencesMock.mockResolvedValue(
      makeTestPreferences({
        defaultChatInterfaceMode: 'claude-code',
        defaultStandaloneChatInterfaceMode: 'canopy',
        defaultAppAdvisorInterfaceMode: 'claude-code',
      }),
    );
    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector('[data-testid="settings-tab-claude"]'),
      ).not.toBeNull();
      const canopyRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-canopy"]',
      );
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-claude-code"]',
      );
      expect(canopyRadio?.checked).toBe(false);
      expect(terminalRadio?.checked).toBe(true);
      const standaloneCanopyRadio =
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-default-standalone-chat-mode-canopy"]',
        );
      const standaloneTerminalRadio =
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-default-standalone-chat-mode-claude-code"]',
        );
      expect(standaloneCanopyRadio?.checked).toBe(true);
      expect(standaloneTerminalRadio?.checked).toBe(false);
      const appAdvisorCanopyRadio =
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-default-app-advisor-chat-mode-canopy"]',
        );
      const appAdvisorTerminalRadio =
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-default-app-advisor-chat-mode-claude-code"]',
        );
      expect(appAdvisorCanopyRadio?.checked).toBe(false);
      expect(appAdvisorTerminalRadio?.checked).toBe(true);
    } finally {
      rendered.cleanup();
    }
  });

  it('persists the chosen mode through defaultChatInterfaceMode', async () => {
    const initial = makeTestPreferences({
      defaultChatInterfaceMode: 'canopy',
    });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...initial, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-claude-code"]',
      );
      if (!terminalRadio) throw new Error('Terminal radio not found');
      act(() => {
        terminalRadio.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        defaultChatInterfaceMode: 'claude-code',
      });
      expect(mockLoadModelDefaults).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('disables terminal mode choices when Claude is not authenticated', async () => {
    getClaudeAuthStatusMock.mockResolvedValue({
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: 'Claude is not authenticated.',
    });
    const initial = makeTestPreferences({
      defaultChatInterfaceMode: 'canopy',
      pipelinesMode: 'canopy',
    });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...initial, ...patch }),
    );
    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-auth-required"]',
        ),
      ).toBeNull();
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-claude-code"]',
      );
      const autoRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-auto"]',
      );
      const pipelineTerminalRadio =
        rendered.container.querySelector<HTMLInputElement>(
          '[data-testid="settings-claude-pipelines-mode-terminal"]',
        );
      expect(terminalRadio?.disabled).toBe(true);
      expect(autoRadio?.disabled).toBe(true);
      expect(pipelineTerminalRadio?.disabled).toBe(true);

      act(() => {
        terminalRadio?.click();
        pipelineTerminalRadio?.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps terminal mode disabled during forced refresh with stale cached auth', async () => {
    const initial = makeTestPreferences({
      defaultChatInterfaceMode: 'canopy',
    });
    loadPreferencesMock.mockResolvedValue(initial);
    const firstRender = await renderTab();
    await act(async () => {
      await Promise.resolve();
    });
    firstRender.cleanup();

    const pendingAuth = createDeferred<{
      authenticated: true;
      accountLabel: string;
      detail: null;
      error: null;
    }>();
    getClaudeAuthStatusMock.mockReturnValueOnce(pendingAuth.promise);
    loadPreferencesMock.mockResolvedValue(
      makeTestPreferences({
        defaultChatInterfaceMode: 'claude-code',
      }),
    );

    const rendered = await renderTab();

    try {
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-chat-mode-claude-code"]',
      );
      expect(terminalRadio?.disabled).toBe(true);
      expect(savePreferencesMock).not.toHaveBeenCalled();

      pendingAuth.resolve({
        authenticated: true,
        accountLabel: 'dev@example.com',
        detail: null,
        error: null,
      });
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('persists the standalone mode through defaultStandaloneChatInterfaceMode', async () => {
    const initial = makeTestPreferences({
      defaultStandaloneChatInterfaceMode: 'canopy',
    });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...initial, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-standalone-chat-mode-claude-code"]',
      );
      if (!terminalRadio)
        throw new Error('Standalone terminal radio not found');
      act(() => {
        terminalRadio.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        defaultStandaloneChatInterfaceMode: 'claude-code',
      });
      expect(mockLoadModelDefaults).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('persists the App Advisor mode through defaultAppAdvisorInterfaceMode', async () => {
    const initial = makeTestPreferences({
      defaultAppAdvisorInterfaceMode: 'canopy',
    });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...initial, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const terminalRadio = rendered.container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-default-app-advisor-chat-mode-claude-code"]',
      );
      if (!terminalRadio)
        throw new Error('App Advisor terminal radio not found');
      act(() => {
        terminalRadio.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        defaultAppAdvisorInterfaceMode: 'claude-code',
      });
      expect(mockLoadModelDefaults).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  describe('idle timeout', () => {
    function idleInput(container: HTMLElement): HTMLInputElement {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="settings-claude-idle-timeout-minutes"]',
      );
      if (!input) throw new Error('Missing Claude idle timeout input');
      return input;
    }

    async function enter(
      input: HTMLInputElement,
      value: string,
    ): Promise<void> {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.bind(input);
      if (!setValue) throw new Error('Missing value setter');
      act(() => {
        setValue(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        for (let index = 0; index < 5; index += 1) await Promise.resolve();
      });
    }

    it('shows the Claude-only idle timeout and saves a clamped value', async () => {
      const initial = makeTestPreferences();
      loadPreferencesMock.mockResolvedValue(initial);
      savePreferencesMock.mockImplementation((patch) =>
        Promise.resolve({ ...initial, ...patch }),
      );
      const rendered = await renderTab();
      try {
        const input = idleInput(rendered.container);
        expect(input.value).toBe('10');
        expect(input.min).toBe('1');
        expect(input.max).toBe('120');
        expect(rendered.container.textContent).toContain('Idle chats');
        expect(rendered.container.textContent).toContain(
          'Stop the Claude process of an idle chat after this long. Applies to Claude chats and to Ollama chats that run on Claude. Your next message resumes the chat. Chats that run on Codex use the Codex setting.',
        );

        await enter(input, '500');

        expect(savePreferencesMock).toHaveBeenCalledWith({
          claudeSessionIdleTimeoutMinutes: 120,
        });
        expect(input.value).toBe('120');
      } finally {
        rendered.cleanup();
      }
    });

    it('restores the saved timeout when saving fails or the entry is not a number', async () => {
      loadPreferencesMock.mockResolvedValue(
        makeTestPreferences({ claudeSessionIdleTimeoutMinutes: 25 }),
      );
      savePreferencesMock.mockRejectedValue(new Error('disk'));
      const rendered = await renderTab();
      try {
        const input = idleInput(rendered.container);
        expect(input.value).toBe('25');

        await enter(input, '0');
        expect(savePreferencesMock).toHaveBeenCalledWith({
          claudeSessionIdleTimeoutMinutes: 1,
        });
        expect(input.value).toBe('25');
        expect(
          rendered.container.querySelector(
            '[data-testid="settings-claude-save-error"]',
          ),
        ).not.toBeNull();

        savePreferencesMock.mockClear();
        await enter(input, '');
        expect(input.value).toBe('25');
        expect(savePreferencesMock).not.toHaveBeenCalled();
      } finally {
        rendered.cleanup();
      }
    });
  });

  it('persists preventClaudeNativeCaffeinate on macOS', async () => {
    const initial = makeTestPreferences({
      preventClaudeNativeCaffeinate: true,
    });
    loadPreferencesMock.mockResolvedValue(initial);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...initial, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const toggle = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-claude-prevent-native-caffeinate"]',
      );
      if (!toggle) throw new Error('Native caffeinate toggle not found');
      expect(toggle.getAttribute('role')).toBe('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      act(() => {
        toggle.click();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith({
        preventClaudeNativeCaffeinate: false,
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('links the native caffeinate setting to Performance settings', async () => {
    const onOpenPerformanceSettings = jest.fn();
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const rendered = await renderTab({ onOpenPerformanceSettings });

    try {
      expect(
        rendered.container.textContent?.includes('Improves performance.'),
      ).toBe(true);
      expect(
        rendered.container.textContent?.includes(
          'Canopy "Keep system awake" setting.',
        ),
      ).toBe(true);
      const button = rendered.container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-claude-open-performance"]',
      );
      if (!button) throw new Error('Performance settings button not found');
      act(() => {
        button.click();
      });
      expect(onOpenPerformanceSettings).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('renders native caffeinate first without a section divider', async () => {
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const rendered = await renderTab();

    try {
      const nativeCaffeinate = rendered.container.querySelector<HTMLElement>(
        '[data-testid="settings-claude-native-caffeinate"]',
      );
      const defaultChatMode = rendered.container.querySelector<HTMLElement>(
        '[data-testid="settings-claude-default-chat-mode-canopy"]',
      );
      const workersSection = rendered.container.querySelector<HTMLElement>(
        '[data-testid="settings-claude-workers-section"]',
      );
      expect(nativeCaffeinate).not.toBeNull();
      expect(defaultChatMode).not.toBeNull();
      expect(workersSection).not.toBeNull();
      if (!nativeCaffeinate || !defaultChatMode || !workersSection) {
        throw new Error('Expected the Claude settings sections to be rendered');
      }
      expect(nativeCaffeinate.className).not.toContain('border-t');
      expect(nativeCaffeinate.className).not.toContain('pt-8');
      expect(nativeCaffeinate.compareDocumentPosition(defaultChatMode)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(nativeCaffeinate.compareDocumentPosition(workersSection)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('hides preventClaudeNativeCaffeinate outside macOS', async () => {
    setPlatform('win32');
    loadPreferencesMock.mockResolvedValue(makeTestPreferences());
    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-native-caffeinate"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-prevent-native-caffeinate"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('hides Claude Workers settings when the TUI workers flag is disabled', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key] =
      false;
    useFeatureFlagsStore.setState({ snapshot });
    loadPreferencesMock.mockResolvedValue(
      makeTestPreferences({
        canopyBackgroundProcessesMode: 'terminal',
        pipelinesMode: 'terminal',
        workerConcurrencyLimit: 12,
      }),
    );

    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-workers-section"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-pipelines-mode-terminal"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-worker-concurrency"]',
        ),
      ).toBeNull();
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });

  it('hides Claude chat mode settings when the TUI chats flag is disabled', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot('ready');
    snapshot.values[CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiChats.key] =
      false;
    useFeatureFlagsStore.setState({ snapshot });
    loadPreferencesMock.mockResolvedValue(
      makeTestPreferences({
        defaultChatInterfaceMode: 'claude-code',
        defaultStandaloneChatInterfaceMode: 'auto',
        defaultAppAdvisorInterfaceMode: 'claude-code',
      }),
    );

    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-default-chat-mode-claude-code"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-default-standalone-chat-mode-auto"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-claude-default-app-advisor-chat-mode-claude-code"]',
        ),
      ).toBeNull();
      expect(savePreferencesMock).not.toHaveBeenCalled();
    } finally {
      rendered.cleanup();
    }
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

async function renderTab(
  props: {
    onOpenPerformanceSettings?: () => void;
  } = {},
): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<ClaudeTab {...props} />);
    await Promise.resolve();
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}
