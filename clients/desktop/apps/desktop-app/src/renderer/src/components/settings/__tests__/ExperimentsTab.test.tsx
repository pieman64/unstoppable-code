/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CodeGraphPreferences,
  PreferencesData,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { ExperimentsTab } from '../ExperimentsTab';

const DEFAULT_CODE_GRAPH: CodeGraphPreferences = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: 30,
};

interface MockApi {
  loadPreferences: jest.Mock<Promise<PreferencesLoadResult>, []>;
  loadCanopyCloudAccount: jest.Mock<Promise<CanopyCloudAccountPublicState>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
}

let originalApiDescriptor: PropertyDescriptor | undefined;

function installApi(codeGraph: CodeGraphPreferences): MockApi {
  const prefs = makeTestPreferences({ codeGraph });
  const api: MockApi = {
    loadPreferences: jest
      .fn<Promise<PreferencesData>, []>()
      .mockResolvedValue(prefs),
    loadCanopyCloudAccount: jest
      .fn<Promise<CanopyCloudAccountPublicState>, []>()
      .mockResolvedValue({
        hasApiKey: false,
        authMode: 'oauth',
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
        account: null,
      }),
    savePreferences: jest.fn((patch) =>
      Promise.resolve(makeTestPreferences({ codeGraph, ...patch })),
    ),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

async function renderTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<ExperimentsTab />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe('ExperimentsTab', () => {
  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    useProjectsStore.setState({ projects: [] });
  });

  afterEach(() => {
    useProjectsStore.setState({ projects: [] });
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useRemoteControlStore.setState({ context: { mode: 'local' } });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it.each(['off', 'explicit-only', 'proactive'] as const)(
    'hydrates managed delegation policy %s in its own section',
    async (managedDelegationMode) => {
      const api = installApi(DEFAULT_CODE_GRAPH);
      api.loadPreferences.mockResolvedValue(
        makeTestPreferences({
          managedDelegationMode,
        }),
      );
      const { container, cleanup } = await renderTab();
      const section = container.querySelector(
        '[data-testid="managed-delegation-settings"]',
      );
      expect(section?.querySelector('h2')?.textContent).toBe(
        'Managed delegation',
      );
      expect(section?.querySelector('select')?.value).toBe(
        managedDelegationMode,
      );
      cleanup();
    },
  );

  it('hydrates an incomplete delegation shutdown when Experiments opens', async () => {
    const api = installApi(DEFAULT_CODE_GRAPH);
    api.loadPreferences.mockResolvedValue({
      ...makeTestPreferences({ managedDelegationMode: 'off' }),
      __managedDelegationRevocationIncomplete: true,
    });
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector(
        '[data-testid="managed-delegation-settings"] [role="alert"]',
      )?.textContent,
    ).toContain('some child sessions could not be stopped');
    cleanup();
  });

  it('keeps memory controls in their own settings section', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector('[data-testid="local-memory-settings"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="org-memory-settings"]'),
    ).toBeNull();
    cleanup();
  });

  it('hosts the faster window opening experiment', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="settings-renderer-code-cache"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('no longer offers the foreground-first delivery experiment', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // A retained section rendered, so the absence below is meaningful.
      expect(
        container.querySelector('[data-testid="settings-renderer-code-cache"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="settings-foreground-first-delivery"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="foreground-first-delivery-toggle"]',
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('no longer offers the interface-scale shortcuts experiment', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // A retained section rendered, so the absence below is meaningful.
      expect(
        container.querySelector('[data-testid="settings-renderer-code-cache"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="settings-interface-scale-shortcuts"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="interface-scale-shortcuts-toggle"]',
        ),
      ).toBeNull();
      expect(container.textContent).not.toContain('Resize the interface');
    } finally {
      cleanup();
    }
  });

  it('hosts the live step window setting, off by default', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container
        .querySelector('[data-testid="chat-live-step-window-toggle"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false');
    cleanup();
  });

  it('no longer offers the chat storage experiment', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    try {
      expect(
        container.querySelector('[data-testid="settings-chat-delta-journal"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain(
        'Reduce disk work while chats stream',
      );
    } finally {
      cleanup();
    }
  });

  describe('remote control switch', () => {
    const selector = '[data-testid="settings-experiments-remote-control"]';

    function setRemoteControlFlag(enabled: boolean): void {
      const snapshot = getDefaultFeatureFlagSnapshot();
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyDeviceRemoteControl.key]: enabled,
          },
        },
      });
    }

    it('is offered with the saved choice while its flag is on', async () => {
      const api = installApi(DEFAULT_CODE_GRAPH);
      api.loadPreferences.mockResolvedValue(
        makeTestPreferences({ remoteControlEnabled: false }),
      );
      setRemoteControlFlag(true);
      const { container, cleanup } = await renderTab();
      expect(container.querySelector(selector)).not.toBeNull();
      expect(
        container
          .querySelector('[data-testid="remote-control-opt-in-toggle"]')
          ?.getAttribute('aria-checked'),
      ).toBe('false');
      cleanup();
    });

    it('reads as on when no choice is saved', async () => {
      const api = installApi(DEFAULT_CODE_GRAPH);
      const prefs = makeTestPreferences({});
      delete prefs.remoteControlEnabled;
      api.loadPreferences.mockResolvedValue(prefs);
      setRemoteControlFlag(true);
      const { container, cleanup } = await renderTab();
      expect(
        container
          .querySelector('[data-testid="remote-control-opt-in-toggle"]')
          ?.getAttribute('aria-checked'),
      ).toBe('true');
      cleanup();
    });

    it('keeps a saved change when its flag goes off and back on', async () => {
      installApi(DEFAULT_CODE_GRAPH);
      setRemoteControlFlag(true);
      const { container, cleanup } = await renderTab();
      const toggle = (): HTMLElement | null =>
        container.querySelector<HTMLElement>(
          '[data-testid="remote-control-opt-in-toggle"]',
        );
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');

      await act(async () => {
        toggle()?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');

      act(() => setRemoteControlFlag(false));
      expect(toggle()).toBeNull();
      act(() => setRemoteControlFlag(true));
      expect(toggle()?.getAttribute('aria-checked')).toBe('false');
      cleanup();
    });

    it('is hidden while its flag is off', async () => {
      installApi(DEFAULT_CODE_GRAPH);
      setRemoteControlFlag(false);
      const { container, cleanup } = await renderTab();
      expect(container.querySelector(selector)).toBeNull();
      cleanup();
    });

    it('is hidden in a window that shows another computer', async () => {
      installApi(DEFAULT_CODE_GRAPH);
      setRemoteControlFlag(true);
      useRemoteControlStore.setState({
        context: {
          mode: 'remote',
          deviceId: 'device-b',
          name: 'Studio',
          platform: 'darwin',
        },
      });
      const { container, cleanup } = await renderTab();
      expect(container.querySelector(selector)).toBeNull();
      cleanup();
    });
  });

  it('no longer hosts the Code Graph settings', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector('[data-testid="code-graph-mode-enabled"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="code-graph-generation-timeout"]'),
    ).toBeNull();
    cleanup();
  });
});
