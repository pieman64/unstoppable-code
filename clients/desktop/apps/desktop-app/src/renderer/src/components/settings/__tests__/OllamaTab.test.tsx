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
  OllamaConnectionTestResult,
  OllamaInstallProgress,
  OllamaState,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { OllamaTab } from '../OllamaTab';

function makeState(overrides: Partial<OllamaState> = {}): OllamaState {
  return {
    port: 11534,
    status: 'stopped',
    models: [],
    mode: 'managed',
    installation: {
      platform: 'darwin',
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      checkedAt: '2026-07-14T00:00:00.000Z',
      automaticInstallSupported: true,
    },
    ...overrides,
  };
}

interface OllamaApiMock {
  getOllamaState: jest.Mock;
  refreshOllamaModels: jest.Mock;
  setOllamaConfiguration: jest.Mock;
  testOllamaConnection: jest.Mock;
  redetectOllamaInstallation: jest.Mock;
  browseOllamaInstallation: jest.Mock;
  installOllama: jest.Mock;
  pullOllamaModel: jest.Mock;
  deleteOllamaModel: jest.Mock;
  onOllamaStatus: jest.Mock;
  onOllamaPullProgress: jest.Mock;
  onOllamaInstallProgress: jest.Mock;
  browser: { openExternal: jest.Mock };
}

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  window,
  'platform',
);

let api: OllamaApiMock;
let installProgressCb: ((progress: OllamaInstallProgress) => void) | null;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

beforeEach(() => {
  installProgressCb = null;
  api = {
    getOllamaState: jest.fn().mockResolvedValue(makeState()),
    refreshOllamaModels: jest.fn().mockResolvedValue(makeState()),
    setOllamaConfiguration: jest.fn().mockResolvedValue(makeState()),
    testOllamaConnection: jest.fn(),
    redetectOllamaInstallation: jest.fn().mockResolvedValue(makeState()),
    browseOllamaInstallation: jest.fn().mockResolvedValue(makeState()),
    installOllama: jest.fn().mockResolvedValue(makeState()),
    pullOllamaModel: jest.fn().mockResolvedValue(undefined),
    deleteOllamaModel: jest.fn(),
    onOllamaStatus: jest.fn().mockReturnValue(() => undefined),
    onOllamaPullProgress: jest.fn().mockReturnValue(() => undefined),
    onOllamaInstallProgress: jest.fn(
      (cb: (progress: OllamaInstallProgress) => void): (() => void) => {
        installProgressCb = cb;
        return () => undefined;
      },
    ),
    browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  setPlatform('darwin');
});

afterEach(() => {
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

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<OllamaTab />);
    await Promise.resolve();
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

function query(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(el: Element | null): Promise<void> {
  if (!(el instanceof HTMLElement)) {
    throw new Error('Expected a clickable element');
  }
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function requireInput(el: Element | null): HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) {
    throw new Error('Expected an input element');
  }
  return el;
}

function requireButton(el: Element | null): HTMLButtonElement {
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error('Expected a button element');
  }
  return el;
}

// Update a controlled input the way React expects: set the value through the
// prototype's native setter (bypassing React's per-instance value tracker) and
// dispatch a bubbling `input` event so React's synthetic onChange fires.
async function setInputValue(
  input: HTMLInputElement,
  value: string,
): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  );
  // Read the native value setter; it is invoked with an explicit `this` via
  // `.call` below, so the unbound-method concern does not apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = descriptor?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('OllamaTab loading', () => {
  it('shows the loading placeholder while state is resolving', async () => {
    const stateResolver: {
      current: ((state: OllamaState) => void) | null;
    } = { current: null };
    api.getOllamaState.mockReturnValue(
      new Promise<OllamaState>((resolve) => {
        stateResolver.current = resolve;
      }),
    );
    const { container, cleanup } = await mount();
    try {
      // The page's shape depends on the answer, so it shows one centered
      // spinner with no visible copy.
      expect(
        query(container, 'ollama-loading')?.querySelector(
          '[role="status"][data-testid="centered-loading-spinner"]',
        ),
      ).not.toBeNull();
      expect(query(container, 'ollama-loading')?.textContent).not.toContain(
        'Checking for Ollama',
      );
      expect(query(container, 'settings-tab-ollama')).toBeNull();
    } finally {
      // Resolve so the pending promise doesn't leak into other tests.
      stateResolver.current?.(makeState());
      cleanup();
    }
  });
});

describe('OllamaTab managed installation states', () => {
  it('renders the not-installed state with Install / Browse / Detect actions', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    const { container, cleanup } = await mount();
    try {
      expect(query(container, 'ollama-managed-setup')?.textContent).toContain(
        "Ollama isn't installed",
      );
      expect(query(container, 'ollama-install')).not.toBeNull();
      expect(query(container, 'ollama-browse')).not.toBeNull();
      expect(query(container, 'ollama-redetect')).not.toBeNull();

      await click(query(container, 'ollama-install'));
      expect(api.installOllama).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('renders the ready state with version, executable path and tooltip', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({
        status: 'running-managed',
        installation: {
          platform: 'darwin',
          ready: true,
          path: '/usr/local/bin/ollama',
          version: '0.14.1',
          source: 'auto-detected',
          checkedAt: '2026-07-14T00:00:00.000Z',
          automaticInstallSupported: true,
        },
      }),
    );
    const { container, cleanup } = await mount();
    try {
      expect(query(container, 'ollama-version')?.textContent).toBe(
        'Ollama 0.14.1',
      );
      const path = query(container, 'ollama-executable-path');
      expect(path?.textContent).toBe('/usr/local/bin/ollama');
      expect(path?.getAttribute('title')).toBe('/usr/local/bin/ollama');
      expect(query(container, 'ollama-browse')).not.toBeNull();
      expect(query(container, 'ollama-redetect')).not.toBeNull();
      // No Install button in the ready state.
      expect(query(container, 'ollama-install')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('renders install progress and disables mode switching while installing', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    // Keep the install promise pending so the installing flag stays true.
    api.installOllama.mockReturnValue(
      new Promise<OllamaState>(() => undefined),
    );
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-install'));
      await act(async () => {
        installProgressCb?.({
          phase: 'downloading',
          message: 'Downloading Ollama…',
          downloadedBytes: 50,
          totalBytes: 100,
        });
        await Promise.resolve();
      });
      const progress = query(container, 'ollama-install-progress');
      expect(progress?.textContent).toContain('Downloading Ollama');
      expect(progress?.querySelector('[role="progressbar"]')).not.toBeNull();
      // Mode choices disabled while installing.
      const managedRadio = requireButton(
        query(container, 'ollama-mode-managed'),
      );
      expect(managedRadio.disabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('enters the installing state for externally triggered install progress', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        installProgressCb?.({
          phase: 'starting',
          message: 'Preparing to install Ollama…',
        });
        await Promise.resolve();
      });

      const progress = query(container, 'ollama-install-progress');
      const progressbar = progress?.querySelector('[role="progressbar"]');
      expect(progress).not.toBeNull();
      expect(progressbar?.getAttribute('aria-valuenow')).toBeNull();
      expect(
        requireButton(query(container, 'ollama-mode-managed')).disabled,
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('reports backend service errors as visible to the App Advisor', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({ error: 'The Ollama service failed to start.' }),
    );
    const { cleanup } = await mount();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.settings?.ollama
          ?.errorVisible,
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('renders the failure state with the reason and recovery actions', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    const { container, cleanup } = await mount();
    try {
      await act(async () => {
        installProgressCb?.({
          phase: 'failure',
          message: 'Install failed: network unreachable',
          error: 'network unreachable',
        });
        await Promise.resolve();
      });
      expect(query(container, 'ollama-install-failure')?.textContent).toContain(
        'network unreachable',
      );
      expect(query(container, 'ollama-install')).not.toBeNull();
      expect(query(container, 'ollama-browse')).not.toBeNull();
      expect(query(container, 'ollama-redetect')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('renders the incompatible-version state with a Download link and Detect', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({
        installation: {
          platform: 'darwin',
          ready: true,
          path: '/usr/local/bin/ollama',
          version: '0.9.0',
          source: 'auto-detected',
          checkedAt: '2026-07-14T00:00:00.000Z',
          automaticInstallSupported: true,
        },
      }),
    );
    const { container, cleanup } = await mount();
    try {
      const warning = query(container, 'ollama-incompatible');
      expect(warning?.textContent).toContain(
        'Ollama server not supported. Update Ollama 0.9.0 to 0.14.0 or newer',
      );
      expect(warning?.textContent).toContain('Ollama 0.9.0');
      expect(query(container, 'ollama-redetect')).not.toBeNull();

      await click(query(container, 'ollama-download'));
      expect(api.browser.openExternal).toHaveBeenCalledWith({
        url: 'https://ollama.com/download',
      });
    } finally {
      cleanup();
    }
  });
});

describe('OllamaTab manual mode', () => {
  it('renders manual instructions, the port mismatch guidance and the macOS command', async () => {
    setPlatform('darwin');
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'manual' }));
    const { container, cleanup } = await mount();
    try {
      const instructions = query(container, 'ollama-manual-instructions');
      expect(instructions?.textContent).toContain(
        'Install Ollama from ollama.com',
      );
      // 11434 mismatch guidance.
      expect(instructions?.textContent).toContain('11434');
      expect(query(container, 'ollama-manual-command')?.textContent).toBe(
        'OLLAMA_HOST=127.0.0.1:11534 ollama serve',
      );
    } finally {
      cleanup();
    }
  });

  it('renders the Windows PowerShell command on win32', async () => {
    setPlatform('win32');
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'manual' }));
    const { container, cleanup } = await mount();
    try {
      expect(query(container, 'ollama-manual-command')?.textContent).toBe(
        '$env:OLLAMA_HOST="127.0.0.1:11534"; ollama serve',
      );
    } finally {
      cleanup();
    }
  });

  it('opens the official download URL through the safe external browser', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'manual' }));
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-download'));
      expect(api.browser.openExternal).toHaveBeenCalledWith({
        url: 'https://ollama.com/download',
      });
    } finally {
      cleanup();
    }
  });

  it('shows upgrade guidance for an incompatible manual server', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({ mode: 'manual', status: 'stopped' }),
    );
    api.testOllamaConnection.mockResolvedValue({
      ok: true,
      host: '127.0.0.1',
      port: 11534,
      checkedAt: '2026-07-14T00:00:00.000Z',
      latencyMs: 2,
      version: '0.13.9',
    } satisfies OllamaConnectionTestResult);
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-test-connection'));
      expect(query(container, 'ollama-incompatible')?.textContent).toContain(
        'Ollama server not supported. Update Ollama 0.13.9 to 0.14.0 or newer',
      );
      expect(
        requireButton(query(container, 'ollama-refresh-models')).disabled,
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('OllamaTab port + connection controls', () => {
  it('shows an inline error and does not save when the port is invalid', async () => {
    api.getOllamaState.mockResolvedValue(makeState());
    const { container, cleanup } = await mount();
    try {
      const input = requireInput(query(container, 'ollama-port-input'));
      await setInputValue(input, '99999');
      await click(query(container, 'ollama-save'));
      expect(query(container, 'ollama-port-error')?.textContent).toBe(
        'Port must be a whole number between 1 and 65535.',
      );
      expect(api.setOllamaConfiguration).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('reports a successful connection test without saving', async () => {
    api.getOllamaState.mockResolvedValue(makeState());
    const result: OllamaConnectionTestResult = {
      ok: true,
      host: '127.0.0.1',
      port: 11534,
      checkedAt: '2026-07-14T00:00:00.000Z',
      latencyMs: 4,
      version: '0.14.1',
    };
    api.testOllamaConnection.mockResolvedValue(result);
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-test-connection'));
      expect(api.testOllamaConnection).toHaveBeenCalledWith(11534);
      expect(api.setOllamaConfiguration).not.toHaveBeenCalled();
      expect(query(container, 'ollama-connection-result')?.textContent).toBe(
        'Connected to Ollama 0.14.1 on port 11534.',
      );
    } finally {
      cleanup();
    }
  });

  it('reports a failed connection test with recovery guidance', async () => {
    api.getOllamaState.mockResolvedValue(makeState());
    const result: OllamaConnectionTestResult = {
      ok: false,
      host: '127.0.0.1',
      port: 11534,
      checkedAt: '2026-07-14T00:00:00.000Z',
      latencyMs: 1,
      error: 'connection refused',
    };
    api.testOllamaConnection.mockResolvedValue(result);
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-test-connection'));
      expect(
        query(container, 'ollama-connection-result')?.textContent,
      ).toContain("Couldn't connect to Ollama on port 11534.");
    } finally {
      cleanup();
    }
  });

  it('clears stale connection success when the port input changes', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({ mode: 'manual', status: 'stopped' }),
    );
    api.testOllamaConnection.mockResolvedValue({
      ok: true,
      host: '127.0.0.1',
      port: 11534,
      checkedAt: '2026-07-14T00:00:00.000Z',
      latencyMs: 2,
      version: '0.14.1',
    } satisfies OllamaConnectionTestResult);
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-test-connection'));
      expect(query(container, 'ollama-connection-result')).not.toBeNull();
      await setInputValue(
        requireInput(query(container, 'ollama-port-input')),
        '11535',
      );
      expect(query(container, 'ollama-connection-result')).toBeNull();
      expect(
        requireButton(query(container, 'ollama-refresh-models')).disabled,
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('OllamaTab model management gating', () => {
  it('disables model actions and shows the managed empty state when setup is incomplete', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    const { container, cleanup } = await mount();
    try {
      expect(
        requireButton(query(container, 'ollama-refresh-models')).disabled,
      ).toBe(true);
      expect(requireInput(query(container, 'ollama-pull-input')).disabled).toBe(
        true,
      );
      expect(query(container, 'ollama-model-empty')?.textContent).toContain(
        'Set up Ollama above to view and manage local models.',
      );
    } finally {
      cleanup();
    }
  });

  it('shows the manual untested empty state when the external server is unreachable', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({ mode: 'manual', status: 'stopped' }),
    );
    const { container, cleanup } = await mount();
    try {
      expect(query(container, 'ollama-model-empty')?.textContent).toContain(
        'Start your external Ollama server and test the connection to view models.',
      );
    } finally {
      cleanup();
    }
  });

  it('enables model actions when the server is reachable', async () => {
    api.getOllamaState.mockResolvedValue(
      makeState({ mode: 'manual', status: 'running-external' }),
    );
    const { container, cleanup } = await mount();
    try {
      expect(
        requireButton(query(container, 'ollama-refresh-models')).disabled,
      ).toBe(false);
      expect(query(container, 'ollama-model-empty')?.textContent).toContain(
        'No models installed.',
      );
    } finally {
      cleanup();
    }
  });
});

describe('OllamaTab mode switching and branding', () => {
  it('persists the selected mode through setOllamaConfiguration', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    api.setOllamaConfiguration.mockResolvedValue(makeState({ mode: 'manual' }));
    const { container, cleanup } = await mount();
    try {
      await click(query(container, 'ollama-mode-manual'));
      expect(api.setOllamaConfiguration).toHaveBeenCalledWith({
        mode: 'manual',
        port: 11534,
      });
      // After switching, the manual instructions render.
      expect(query(container, 'ollama-manual-instructions')).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('derives product copy from the brand runtime', async () => {
    api.getOllamaState.mockResolvedValue(makeState({ mode: 'managed' }));
    const { container, cleanup } = await mount();
    try {
      const setup = query(container, 'ollama-setup');
      expect(setup?.textContent).toContain(`Managed by ${brandText.appName}`);
    } finally {
      cleanup();
    }
  });
});
