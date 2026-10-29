/** @jest-environment jsdom */
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import type * as TerminalStoreModule from '@/stores/terminalStore';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import type { TerminalSession } from '@canopy/desktop-shared/types';
import { initTerminalPanelSync } from '../terminal-panel-sync';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import { ipcTerminalClient } from '@/client/ipc-terminal-client';

const disposeInstance = jest.fn();
jest.mock('@/stores/terminalStore', () => {
  const actual = jest.requireActual<typeof TerminalStoreModule>(
    '@/stores/terminalStore',
  );
  return { ...actual, ensureTerminalWorktreeHydrated: jest.fn() };
});
const mockedEnsureTerminalWorktreeHydrated = jest.mocked(
  ensureTerminalWorktreeHydrated,
);
jest.mock('@/lib/terminal-instances', () => ({
  disposeInstance: (...args: unknown[]): unknown => disposeInstance(...args),
}));

const KEY = 'project-1/worktree-1';

function session(): TerminalSession {
  return {
    id: 'terminal-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/tmp',
    createdAt: 1,
  };
}

describe('terminal panel lifecycle sync', () => {
  const kill = jest.fn().mockResolvedValue(undefined);
  let disposeTerminalClient: (() => void) | undefined;

  beforeEach(() => {
    disposeTerminalClient = bindTerminalClient(ipcTerminalClient);
    mockedEnsureTerminalWorktreeHydrated.mockReset();
    mockedEnsureTerminalWorktreeHydrated.mockResolvedValue(undefined);
  });

  beforeAll(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        terminal: {
          kill,
          saveWorktreeState: jest.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  afterEach(() => {
    const panels = usePanelLayoutStore.getState();
    for (const key of Object.keys(panels.layouts)) panels.disposeLayout(key);
    disposeTerminalClient?.();
    kill.mockClear();
    disposeInstance.mockClear();
  });

  it('kills and forgets only the session whose outer panel was closed', async () => {
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal-1',
          instance: { terminalId: 'terminal-1' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    useTerminalStore.getState().addGroupWithTerminal(session());
    initTerminalPanelSync();

    usePanelLayoutStore
      .getState()
      .closeTab(KEY, 'group-terminal', 'panel-terminal-1');
    await Promise.resolve();

    expect(kill).toHaveBeenCalledWith({ terminalId: 'terminal-1' });
    expect(disposeInstance).toHaveBeenCalledWith('terminal-1');
    expect(useTerminalStore.getState().worktrees[KEY]?.sessions).toEqual({});
  });

  it('waits for hydration before closing a bound terminal session', async () => {
    let resolveHydration: (() => void) | undefined;
    mockedEnsureTerminalWorktreeHydrated.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHydration = resolve;
      }),
    );
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal-1',
          instance: { terminalId: 'terminal-1' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    await Promise.resolve();
    initTerminalPanelSync();

    usePanelLayoutStore
      .getState()
      .closeTab(KEY, 'group-terminal', 'panel-terminal-1');
    await Promise.resolve();
    expect(kill).not.toHaveBeenCalled();

    useTerminalStore.getState().addGroupWithTerminal(session());
    resolveHydration?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(kill).toHaveBeenCalledWith({ terminalId: 'terminal-1' });
    expect(useTerminalStore.getState().worktrees[KEY]?.sessions).toEqual({});
  });

  it('kills the bound PTY when hydration fails during close', async () => {
    mockedEnsureTerminalWorktreeHydrated.mockRejectedValueOnce(
      new Error('hydrate failed'),
    );
    usePanelLayoutStore.getState().initializeLayout(KEY, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'terminal',
          groupId: 'group-terminal',
          panelId: 'panel-terminal-1',
          instance: { terminalId: 'terminal-1' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    await Promise.resolve();
    initTerminalPanelSync();

    usePanelLayoutStore
      .getState()
      .closeTab(KEY, 'group-terminal', 'panel-terminal-1');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(kill).toHaveBeenCalledWith({ terminalId: 'terminal-1' });
    expect(disposeInstance).toHaveBeenCalledWith('terminal-1');
  });
});
