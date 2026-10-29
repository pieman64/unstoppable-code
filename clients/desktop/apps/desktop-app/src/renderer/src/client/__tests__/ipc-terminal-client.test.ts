/**
 * @jest-environment jsdom
 */
import type {
  LoadWorktreeTerminalStateResponse,
  SaveWorktreeTerminalStateRequest,
  TerminalAttachRequest,
  TerminalExitEvent,
  TerminalKillRequest,
  TerminalOutputEvent,
  TerminalResizeRequest,
  TerminalRestoreRequest,
  TerminalRunningChangedEvent,
  TerminalSession,
  TerminalSpawnRequest,
  TerminalWriteRequest,
} from '@canopy/protocol/terminal';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as TerminalStateModule from '@canopy/app-state/terminal';
import {
  ensureTerminalWorktreeHydrated,
  requireTerminalClient,
  requireTerminalClientLifetime,
  subscribeTerminalActivityFeed,
  useTerminalActivityStore,
  useTerminalStore,
} from '@canopy/app-state/terminal';

import { ipcTerminalClient } from '../ipc-terminal-client';
import { DesktopTerminalRuntime } from '../DesktopTerminalRuntime';

const SESSION_ONE: TerminalSession = {
  id: 'terminal-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  shell: '/bin/zsh',
  shellBasename: 'zsh',
  cwd: '/tmp/project-1/worktree-1',
  createdAt: 1,
};

const SESSION_TWO: TerminalSession = {
  ...SESSION_ONE,
  id: 'terminal-2',
  worktreeId: 'worktree-2',
};

const SESSION_THREE: TerminalSession = {
  ...SESSION_ONE,
  id: 'terminal-3',
  projectId: 'project-2',
};

const WORKTREE_STATE: LoadWorktreeTerminalStateResponse = {
  drawerCollapsed: false,
  groups: [],
  activeGroupId: null,
  nextGroupOrdinal: 1,
  groupOrdinals: {},
  terminalCustomNames: {},
  groupCustomNames: {},
  terminals: [],
  liveTerminalIds: ['terminal-1'],
};

interface TerminalBridgeHarness {
  readonly bridge: {
    list: jest.Mock<Promise<TerminalSession[]>, []>;
    loadWorktreeState: jest.Mock<
      Promise<LoadWorktreeTerminalStateResponse>,
      [{ projectId: string; worktreeId: string }]
    >;
    spawn: jest.Mock<Promise<TerminalSession>, [TerminalSpawnRequest]>;
    attach: jest.Mock<
      Promise<{
        session: TerminalSession;
        replay: Uint8Array;
        seq: number;
      }>,
      [TerminalAttachRequest]
    >;
    write: jest.Mock<Promise<'already_written'>, [TerminalWriteRequest]>;
    resize: jest.Mock<Promise<void>, [TerminalResizeRequest]>;
    kill: jest.Mock<Promise<void>, [TerminalKillRequest]>;
    restore: jest.Mock<Promise<TerminalSession>, [TerminalRestoreRequest]>;
    saveWorktreeState: jest.Mock<
      Promise<void>,
      [SaveWorktreeTerminalStateRequest]
    >;
    onOutput: jest.Mock<() => void, [(event: TerminalOutputEvent) => void]>;
    onExit: jest.Mock<() => void, [(event: TerminalExitEvent) => void]>;
    onRunningChanged: jest.Mock<
      () => void,
      [(event: TerminalRunningChangedEvent) => void]
    >;
  };
  readonly emitOutput: (event: TerminalOutputEvent) => void;
  readonly emitExit: (event: TerminalExitEvent) => void;
  readonly emitRunningChanged: (event: TerminalRunningChangedEvent) => void;
  readonly outputUnsubscribe: jest.Mock<void, []>;
  readonly exitUnsubscribe: jest.Mock<void, []>;
  readonly runningUnsubscribe: jest.Mock<void, []>;
}

function createTerminalBridgeHarness(): TerminalBridgeHarness {
  let outputListener: ((event: TerminalOutputEvent) => void) | undefined;
  let exitListener: ((event: TerminalExitEvent) => void) | undefined;
  let runningListener:
    | ((event: TerminalRunningChangedEvent) => void)
    | undefined;
  const outputUnsubscribe = jest.fn<void, []>();
  const exitUnsubscribe = jest.fn<void, []>();
  const runningUnsubscribe = jest.fn<void, []>();

  return {
    bridge: {
      list: jest.fn(
        (): Promise<TerminalSession[]> =>
          Promise.resolve([SESSION_ONE, SESSION_TWO, SESSION_THREE]),
      ),
      loadWorktreeState: jest.fn(() => Promise.resolve(WORKTREE_STATE)),
      spawn: jest.fn(() => Promise.resolve(SESSION_ONE)),
      attach: jest.fn(() =>
        Promise.resolve({
          session: SESSION_ONE,
          replay: new Uint8Array([1, 2]),
          seq: 2,
        }),
      ),
      write: jest.fn(() => Promise.resolve('already_written')),
      resize: jest.fn(() => Promise.resolve()),
      kill: jest.fn(() => Promise.resolve()),
      restore: jest.fn(() => Promise.resolve(SESSION_ONE)),
      saveWorktreeState: jest.fn(() => Promise.resolve()),
      onOutput: jest.fn((listener): (() => void) => {
        outputListener = listener;
        return outputUnsubscribe;
      }),
      onExit: jest.fn((listener): (() => void) => {
        exitListener = listener;
        return exitUnsubscribe;
      }),
      onRunningChanged: jest.fn((listener): (() => void) => {
        runningListener = listener;
        return runningUnsubscribe;
      }),
    },
    emitOutput: (event): void => outputListener?.(event),
    emitExit: (event): void => exitListener?.(event),
    emitRunningChanged: (event): void => runningListener?.(event),
    outputUnsubscribe,
    exitUnsubscribe,
    runningUnsubscribe,
  };
}

function installTerminalBridge(
  bridge: TerminalBridgeHarness['bridge'],
  loadCanopyCloudAccount?: () => Promise<CanopyCloudAccountPublicState>,
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { terminal: bridge, loadCanopyCloudAccount },
  });
}

describe('ipcTerminalClient', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not replace an owned terminal binding when the adapter is imported', () => {
    jest.isolateModules(() => {
      const terminalState: typeof TerminalStateModule = jest.requireActual(
        '@canopy/app-state/terminal',
      );
      const dispose = terminalState.bindTerminalClient(ipcTerminalClient);
      const lifetime = terminalState.requireTerminalClientLifetime();
      try {
        jest.requireActual('../ipc-terminal-client');
        expect(lifetime.isCurrent()).toBe(true);
      } finally {
        dispose();
      }
    });
  });

  it('delegates every terminal command and preserves results', async () => {
    const harness = createTerminalBridgeHarness();
    installTerminalBridge(harness.bridge);
    const spawn = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      cols: 80,
      rows: 24,
    };
    const attach = { terminalId: 'terminal-1' };
    const write = { terminalId: 'terminal-1', data: 'ls\r' };
    const resize = { terminalId: 'terminal-1', cols: 120, rows: 40 };
    const kill = { terminalId: 'terminal-1' };
    const restore = { terminalId: 'terminal-1', cols: 100, rows: 30 };
    const save = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      drawerCollapsed: false,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    };

    await expect(
      ipcTerminalClient.command('terminal.spawn', spawn),
    ).resolves.toBe(SESSION_ONE);
    await expect(
      ipcTerminalClient.command('terminal.attach', attach),
    ).resolves.toEqual({
      session: SESSION_ONE,
      replay: new Uint8Array([1, 2]),
      seq: 2,
    });
    await expect(
      ipcTerminalClient.command('terminal.write', write),
    ).resolves.toBe('already_written');
    await expect(
      ipcTerminalClient.command('terminal.resize', resize),
    ).resolves.toBeUndefined();
    await expect(
      ipcTerminalClient.command('terminal.kill', kill),
    ).resolves.toBeUndefined();
    await expect(
      ipcTerminalClient.command('terminal.restore', restore),
    ).resolves.toBe(SESSION_ONE);
    await expect(
      ipcTerminalClient.command('terminal.worktreeState.save', save),
    ).resolves.toBeUndefined();

    expect(harness.bridge.spawn).toHaveBeenCalledWith(spawn);
    expect(harness.bridge.attach).toHaveBeenCalledWith(attach);
    expect(harness.bridge.write).toHaveBeenCalledWith(write);
    expect(harness.bridge.resize).toHaveBeenCalledWith(resize);
    expect(harness.bridge.kill).toHaveBeenCalledWith(kill);
    expect(harness.bridge.restore).toHaveBeenCalledWith(restore);
    expect(harness.bridge.saveWorktreeState).toHaveBeenCalledWith(save);
  });

  it('loads worktree state and scopes the global list after invoking it', async () => {
    const harness = createTerminalBridgeHarness();
    installTerminalBridge(harness.bridge);

    await expect(
      ipcTerminalClient.query('terminal.worktreeState.get', {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toBe(WORKTREE_STATE);
    await expect(ipcTerminalClient.query('terminal.list', {})).resolves.toEqual(
      [SESSION_ONE, SESSION_TWO, SESSION_THREE],
    );
    await expect(
      ipcTerminalClient.query('terminal.list', { projectId: 'project-1' }),
    ).resolves.toEqual([SESSION_ONE, SESSION_TWO]);
    await expect(
      ipcTerminalClient.query('terminal.list', { worktreeId: 'worktree-1' }),
    ).resolves.toEqual([SESSION_ONE, SESSION_THREE]);
    await expect(
      ipcTerminalClient.query('terminal.list', {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toEqual([SESSION_ONE]);

    expect(harness.bridge.loadWorktreeState).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(harness.bridge.list).toHaveBeenCalledTimes(4);
    expect(harness.bridge.list).toHaveBeenCalledWith();
  });

  it('reads the terminal bridge lazily for each call', async () => {
    const first = createTerminalBridgeHarness();
    installTerminalBridge(first.bridge);
    await ipcTerminalClient.query('terminal.list', {});

    const second = createTerminalBridgeHarness();
    second.bridge.list.mockResolvedValue([SESSION_THREE]);
    installTerminalBridge(second.bridge);

    await expect(ipcTerminalClient.query('terminal.list', {})).resolves.toEqual(
      [SESSION_THREE],
    );
    expect(first.bridge.list).toHaveBeenCalledTimes(1);
    expect(second.bridge.list).toHaveBeenCalledTimes(1);
  });

  it('preserves raw output identity while filtering by pane scope', () => {
    const harness = createTerminalBridgeHarness();
    installTerminalBridge(harness.bridge);
    const received: TerminalOutputEvent[] = [];
    const unsubscribe = ipcTerminalClient.subscribe(
      'terminal.output',
      (event) => received.push(event),
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    const wrongWorktree: TerminalOutputEvent = {
      projectId: 'project-1',
      worktreeId: 'worktree-2',
      terminalId: 'terminal-2',
      data: new Uint8Array([1]),
      seq: 1,
    };
    const matching: TerminalOutputEvent = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      terminalId: 'terminal-1',
      data: new Uint8Array([2]),
      seq: 2,
    };

    harness.emitOutput(wrongWorktree);
    harness.emitOutput(matching);

    expect(received).toEqual([matching]);
    expect(received[0]).toBe(matching);
    expect('occurredAt' in matching).toBe(false);
    unsubscribe();
    expect(harness.outputUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('timestamps exit and running events and preserves bridge unsubscriptions', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T10:20:30.000Z'));
    const harness = createTerminalBridgeHarness();
    installTerminalBridge(harness.bridge);
    const exits: Array<TerminalExitEvent & { occurredAt: string }> = [];
    const running: Array<TerminalRunningChangedEvent & { occurredAt: string }> =
      [];
    const unsubscribeExit = ipcTerminalClient.subscribe(
      'terminal.exit',
      (event) => exits.push(event),
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    const unsubscribeRunning = ipcTerminalClient.subscribe(
      'terminal.running-changed',
      (event) => running.push(event),
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );

    harness.emitExit({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      terminalId: 'terminal-1',
      exitCode: 0,
      signal: null,
    });
    harness.emitRunningChanged({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      terminalId: 'terminal-1',
      running: true,
      processName: 'npm',
    });

    expect(exits).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
        occurredAt: '2026-09-22T10:20:30.000Z',
      },
    ]);
    expect(running).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        terminalId: 'terminal-1',
        running: true,
        processName: 'npm',
        occurredAt: '2026-09-22T10:20:30.000Z',
      },
    ]);

    unsubscribeExit();
    unsubscribeRunning();
    expect(harness.exitUnsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.runningUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not wrap terminal bridge rejections', async () => {
    const harness = createTerminalBridgeHarness();
    const failure = new Error('pty unavailable');
    harness.bridge.attach.mockRejectedValue(failure);
    installTerminalBridge(harness.bridge);

    await expect(
      ipcTerminalClient.command('terminal.attach', {
        terminalId: 'terminal-1',
      }),
    ).rejects.toBe(failure);
  });
});

describe('DesktopTerminalRuntime', () => {
  let root: Root;
  let container: HTMLDivElement;
  let harness: TerminalBridgeHarness;
  let loadAccount: jest.Mock<Promise<CanopyCloudAccountPublicState>, []>;

  function account(id: string | null): CanopyCloudAccountPublicState {
    return {
      read: 'ok',
      hasApiKey: id !== null,
      authMode: id === null ? null : 'oauth',
      credentialSource: id === null ? null : 'oauth_desktop',
      capabilities: [],
      storageAvailable: true,
      ...(id === null
        ? {}
        : {
            account: {
              id,
              name: id,
              email: `${id}@example.test`,
              role: 'DEVELOPER',
            },
          }),
    };
  }

  function TerminalConsumer(): null {
    useLayoutEffect(() => {
      // This sibling runs before passive effects. The desktop owner must
      // make local IPC available without waiting for an account lookup.
      requireTerminalClient();
      return subscribeTerminalActivityFeed();
    }, []);
    return null;
  }

  async function mount(): Promise<void> {
    await act(async () => {
      root.render([
        createElement(DesktopTerminalRuntime, { key: 'runtime' }),
        createElement(TerminalConsumer, { key: 'consumer' }),
      ]);
      await Promise.resolve();
    });
  }

  async function refresh(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    harness = createTerminalBridgeHarness();
    loadAccount = jest.fn(() => Promise.resolve(account('first')));
    installTerminalBridge(harness.bridge, loadAccount);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('binds before sibling layout effects while cloud identity is unavailable', async () => {
    loadAccount.mockImplementation(() => new Promise(() => undefined));
    await mount();

    await expect(
      requireTerminalClient().query('terminal.list', {}),
    ).resolves.toHaveLength(3);
    expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(1);
  });

  it('disposes feeds and both stores on unmount and supports remount', async () => {
    await mount();
    await ensureTerminalWorktreeHydrated('project-1', 'worktree-1');
    harness.emitRunningChanged({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      terminalId: 'terminal-1',
      running: true,
      processName: 'npm',
    });
    const lifetime = requireTerminalClientLifetime();
    expect(
      useTerminalStore.getState().worktrees['project-1/worktree-1'],
    ).toBeDefined();
    expect(useTerminalActivityStore.getState().runningWorktreeKeys.size).toBe(
      1,
    );

    act(() => root.render(null));
    expect(lifetime.isCurrent()).toBe(false);
    expect(() => requireTerminalClient()).toThrow('Terminal host is not bound');
    expect(harness.runningUnsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.exitUnsubscribe).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().worktrees).toEqual({});
    expect(useTerminalActivityStore.getState().entriesByWorktree).toEqual({});

    await mount();
    expect(requireTerminalClient()).toBe(ipcTerminalClient);
    expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'second'])(
    'releases the prior identity and rebinds local terminals for %s',
    async (id) => {
      await mount();
      await ensureTerminalWorktreeHydrated('project-1', 'worktree-1');
      const lifetime = requireTerminalClientLifetime();
      loadAccount.mockResolvedValue(account(id));

      await refresh();

      expect(lifetime.isCurrent()).toBe(false);
      expect(harness.runningUnsubscribe).toHaveBeenCalledTimes(1);
      expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(2);
      expect(useTerminalStore.getState().worktrees).toEqual({});
      await expect(
        requireTerminalClient().command('terminal.spawn', {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          cols: 80,
          rows: 24,
        }),
      ).resolves.toBe(SESSION_ONE);
    },
  );

  it('preserves local terminals on same-account refresh and inconclusive reads', async () => {
    await mount();
    const lifetime = requireTerminalClientLifetime();
    await refresh();
    loadAccount.mockResolvedValue({ ...account(null), read: 'unavailable' });
    await refresh();
    loadAccount.mockRejectedValue(new Error('offline'));
    await refresh();

    expect(lifetime.isCurrent()).toBe(true);
    expect(harness.runningUnsubscribe).not.toHaveBeenCalled();
    expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores an account read overtaken by sign-out', async () => {
    await mount();
    let resolveOldRead:
      | ((value: CanopyCloudAccountPublicState) => void)
      | undefined;
    loadAccount.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRead = resolve;
        }),
    );
    await refresh();
    loadAccount.mockResolvedValue(account(null));
    await refresh();
    const signedOutLifetime = requireTerminalClientLifetime();

    await act(async () => {
      resolveOldRead?.(account('first'));
      await Promise.resolve();
    });

    expect(signedOutLifetime.isCurrent()).toBe(true);
    expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(2);
  });

  it('does not rebind when an account read finishes after unmount', async () => {
    let resolveRead:
      | ((value: CanopyCloudAccountPublicState) => void)
      | undefined;
    loadAccount.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    await mount();
    act(() => root.render(null));
    await act(async () => {
      resolveRead?.(account('first'));
      await Promise.resolve();
    });

    expect(() => requireTerminalClient()).toThrow('Terminal host is not bound');
    expect(harness.bridge.onRunningChanged).toHaveBeenCalledTimes(1);
  });
});
