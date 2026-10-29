/** @jest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ScriptCompleteEvent,
  ScriptOutputEvent,
  TerminalSession,
} from '@canopy/desktop-shared/types';

const addGroupWithTerminal = jest.fn();
const mockAutoOpenDevServerHit = jest.fn<Promise<void>, unknown[]>(() =>
  Promise.resolve(),
);
jest.mock('@/components/activity/devServerOpen', () => ({
  openDevServerHit: jest.fn(),
  autoOpenDevServerHit: (...args: unknown[]): Promise<void> =>
    mockAutoOpenDevServerHit(...args),
}));
const markTerminalLive = jest.fn();
const ensureTerminalWorktreeHydrated = jest.fn(() => Promise.resolve());
const selectBucket = jest.fn();
const ensureTerminalPanelVisible = jest.fn();
const makeWorktreePanelKey = jest.fn(
  (projectId: string, worktreeId: string) => `${projectId}/${worktreeId}`,
);

jest.mock('@/stores/scriptsStore', () => {
  const state = {
    appendOutput: jest.fn(),
    startRunFromEvent: jest.fn(),
    completeRunFromEvent: jest.fn(),
  };
  return {
    useScriptsStore: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

jest.mock('@/stores/terminalStore', () => ({
  useTerminalStore: {
    getState: (): {
      addGroupWithTerminal: typeof addGroupWithTerminal;
      markTerminalLive: typeof markTerminalLive;
    } => ({ addGroupWithTerminal, markTerminalLive }),
  },
  ensureTerminalWorktreeHydrated,
  selectBucket,
}));

jest.mock('@/lib/panels/terminal-panel-activation', () => ({
  ensureTerminalPanelVisible,
}));

jest.mock('@/stores/panelLayoutStore', () => ({ makeWorktreePanelKey }));

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: jest.fn() }),
  },
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): {
      tearingDownWorktrees: Set<string>;
      projects: never[];
    } => ({ tearingDownWorktrees: new Set(), projects: [] }),
  },
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { queueWorktreeTabDiscoveryRefresh: jest.Mock } => ({
      queueWorktreeTabDiscoveryRefresh: jest.fn(),
    }),
  },
}));

jest.mock('@/stores/fileListStore', () => ({
  useFileListStore: {
    getState: (): { invalidate: jest.Mock } => ({ invalidate: jest.fn() }),
  },
}));

import {
  shouldInvalidateFileCacheAfterScriptComplete,
  shouldToastAfterScriptCompleteFailure,
  useScriptEventSubscriptions,
} from '../useScriptEventSubscriptions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function SubscriptionHarness(): ReturnType<typeof createElement> {
  useScriptEventSubscriptions();
  return createElement('div');
}

function createScriptCompleteEvent(
  overrides: Partial<ScriptCompleteEvent['result']>,
): ScriptCompleteEvent {
  return {
    projectId: 'project-a',
    worktreeId: 'wt-1',
    script: {
      scriptKey: 'project:setup:run',
      scriptName: 'setup',
      label: 'Setup',
      command: 'npm install',
      lifecycle: 'setup',
      target: 'project',
    },
    invocation: 'automatic-setup',
    result: {
      success: true,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1000,
      ...overrides,
    },
  };
}

describe('shouldInvalidateFileCacheAfterScriptComplete', () => {
  it('invalidates after a successful script', () => {
    expect(
      shouldInvalidateFileCacheAfterScriptComplete(
        createScriptCompleteEvent({ success: true, exitCode: 0 }),
      ),
    ).toBe(true);
  });

  it('does not invalidate after a failed script', () => {
    expect(
      shouldInvalidateFileCacheAfterScriptComplete(
        createScriptCompleteEvent({ success: false, exitCode: 1 }),
      ),
    ).toBe(false);
  });

  it('does not invalidate after a timed-out script', () => {
    expect(
      shouldInvalidateFileCacheAfterScriptComplete(
        createScriptCompleteEvent({
          success: false,
          exitCode: null,
          timedOut: true,
        }),
      ),
    ).toBe(false);
  });

  it('invalidates after a successful non-setup lifecycle (e.g. manual run)', () => {
    // Confirms that file-cache invalidation does not depend on the
    // discovery-refresh gate — any successful script invalidates.
    const event = createScriptCompleteEvent({ success: true, exitCode: 0 });
    event.script.lifecycle = 'custom';
    expect(shouldInvalidateFileCacheAfterScriptComplete(event)).toBe(true);
  });
});

describe('shouldToastAfterScriptCompleteFailure', () => {
  it('does not toast after a cancelled script stop', () => {
    expect(
      shouldToastAfterScriptCompleteFailure(
        createScriptCompleteEvent({
          success: false,
          exitCode: null,
          timedOut: false,
        }),
      ),
    ).toBe(false);
  });

  it('toasts after a failed script', () => {
    expect(
      shouldToastAfterScriptCompleteFailure(
        createScriptCompleteEvent({ success: false, exitCode: 1 }),
      ),
    ).toBe(true);
  });

  it('toasts after a timed-out script', () => {
    expect(
      shouldToastAfterScriptCompleteFailure(
        createScriptCompleteEvent({
          success: false,
          exitCode: null,
          timedOut: true,
        }),
      ),
    ).toBe(true);
  });
});

describe('script terminal spawn subscription', () => {
  let spawnedListener: ((session: TerminalSession) => void) | undefined;
  let resolveHydration: (() => void) | undefined;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    addGroupWithTerminal.mockReset();
    markTerminalLive.mockReset();
    ensureTerminalPanelVisible.mockReset();
    selectBucket.mockReset();
    resolveHydration = undefined;
    ensureTerminalWorktreeHydrated.mockReset();
    ensureTerminalWorktreeHydrated.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveHydration = resolve;
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: {
          onSpawned: (listener: (session: TerminalSession) => void) => {
            spawnedListener = listener;
            return (): void => undefined;
          },
        },
        onScriptStarted: () => (): void => undefined,
        onScriptOutput: () => (): void => undefined,
        onScriptComplete: () => (): void => undefined,
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(SubscriptionHarness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('hydrates the worktree before persisting and focusing a manually spawned script terminal', async () => {
    const session: TerminalSession & { focusOnSpawn: boolean } = {
      id: 'script-terminal-1',
      projectId: 'project-a',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
      kind: 'script',
      focusOnSpawn: true,
    };

    act(() => spawnedListener?.(session));
    expect(ensureTerminalWorktreeHydrated).toHaveBeenCalledWith(
      'project-a',
      'wt-1',
    );
    expect(addGroupWithTerminal).not.toHaveBeenCalled();

    await act(async () => {
      resolveHydration?.();
      await Promise.resolve();
    });

    expect(addGroupWithTerminal).toHaveBeenCalledWith(session, {
      activate: true,
    });
    expect(ensureTerminalPanelVisible).toHaveBeenCalledWith(
      'project-a/wt-1',
      undefined,
      {
        terminalId: 'script-terminal-1',
        title: 'Terminal',
        focus: true,
        focusOwnerDocument: document,
      },
    );
  });

  it('does not overwrite an exited terminal after hydration', async () => {
    const session: TerminalSession = {
      id: 'restored-script-terminal',
      projectId: 'project-a',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
      kind: 'script',
    };
    selectBucket.mockReturnValue({
      sessions: { [session.id]: { session } },
    });

    act(() => spawnedListener?.(session));
    await act(async () => {
      resolveHydration?.();
      await Promise.resolve();
    });

    expect(addGroupWithTerminal).not.toHaveBeenCalled();
    expect(markTerminalLive).not.toHaveBeenCalled();
  });

  it('does not focus an automatically spawned script terminal', async () => {
    const session: TerminalSession & { focusOnSpawn: boolean } = {
      id: 'automatic-script-terminal',
      projectId: 'project-a',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
      kind: 'script',
      focusOnSpawn: false,
    };

    act(() => spawnedListener?.(session));
    await act(async () => {
      resolveHydration?.();
      await Promise.resolve();
    });

    expect(addGroupWithTerminal).toHaveBeenCalledWith(session, {
      activate: false,
    });
    expect(ensureTerminalPanelVisible).toHaveBeenCalledWith(
      'project-a/wt-1',
      undefined,
      {
        terminalId: 'automatic-script-terminal',
        title: 'Terminal',
        focus: false,
      },
    );
  });
});

describe('script dev-server auto-open', () => {
  let outputListener: ((event: ScriptOutputEvent) => void) | undefined;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  function outputEvent(): ScriptOutputEvent {
    return {
      projectId: 'project-b',
      worktreeId: 'wt-mocks',
      invocation: 'manual-run',
      runId: 'run-1',
      script: {
        scriptKey: 'project:ui-mocks',
        scriptName: 'ui-mocks',
        label: 'UI Mocks',
        command: 'npm run mocks',
        lifecycle: 'launch',
        target: 'project',
        devServerPattern: { pattern: 'https?://\\S+', autoOpen: true },
      },
      lines: ['Mocks ready at http://localhost:5199/'],
    };
  }

  function mount(remoteControl?: { getContext: () => unknown }): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: { onSpawned: () => (): void => undefined },
        onScriptStarted: () => (): void => undefined,
        onScriptOutput: (listener: (event: ScriptOutputEvent) => void) => {
          outputListener = listener;
          return (): void => undefined;
        },
        onScriptComplete: () => (): void => undefined,
        ...(remoteControl === undefined ? {} : { remoteControl }),
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(SubscriptionHarness)));
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  beforeEach(() => {
    mockAutoOpenDevServerHit.mockClear();
    outputListener = undefined;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('auto-opens a matching URL in a window that shows this computer', async () => {
    mount();
    outputListener?.(outputEvent());
    await settle();

    expect(mockAutoOpenDevServerHit).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:5199/' }),
      { projectId: 'project-b', worktreeId: 'wt-mocks' },
    );
  });

  it('opens nothing in a window that shows another computer', async () => {
    mount({
      getContext: () => ({
        mode: 'remote',
        deviceId: 'device-b',
        name: 'Studio',
        platform: 'darwin',
      }),
    });
    outputListener?.(outputEvent());
    await settle();

    expect(outputListener).toBeDefined();
    expect(mockAutoOpenDevServerHit).not.toHaveBeenCalled();
  });
});
