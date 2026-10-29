/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
import type { ClaudeTerminalChatSummaryScheduler } from '../integration/claude-terminal-session-service';

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../terminal/pty-manager', () => ({
  ptyManager: {
    setEventSender: jest.fn(),
    spawn: jest.fn(),
    restore: jest.fn(),
    attach: jest.fn(),
    write: jest.fn(),
    chatIdOf: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    list: jest.fn(),
  },
  prewarmLinuxTerminalShell: jest.fn(() => Promise.resolve()),
  listAvailableTerminalProfiles: jest.fn(() => [
    { id: 'zsh', label: 'zsh', isDefault: true },
    { id: 'bash', label: 'bash', isDefault: false },
  ]),
}));

jest.mock('../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (
    sender: { id?: unknown } | null,
  ): string | null => (sender?.id === 'bridge' ? 'controller-1' : null),
}));

jest.mock('../terminal/persistence', () => ({
  terminalPersistenceStore: {
    loadWorktreeState: jest.fn(),
    saveWorktreeState: jest.fn(),
    getPersistedTerminalEntry: jest.fn(),
  },
}));

jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/bin/claude'),
}));

jest.mock('../lib/git-executable', () => ({
  detectGitExecutable: jest.fn(() =>
    Promise.resolve({
      ready: true,
      path: null,
      version: null,
      source: 'not-found',
      platform: 'darwin',
      required: false,
      checkedAt: '2026-06-30T00:00:00.000Z',
      wingetAvailable: false,
    }),
  ),
}));

const mockAuthorizeTerminalAgentWrite = jest.fn<
  Promise<void> | undefined,
  [string, string | undefined]
>();
const mockClaudeTerminalLaunch = jest.fn();
const mockClaudeTerminalGetState = jest.fn();
const mockClaudeTerminalInterrupt = jest.fn();
type ClaudeTerminalEventSender = (channel: string, payload: unknown) => void;
const mockClaudeTerminalSetEventSender = jest.fn<
  void,
  [ClaudeTerminalEventSender]
>();
const mockClaudeTerminalSetChatSummaryScheduler = jest.fn<
  void,
  [ClaudeTerminalChatSummaryScheduler]
>();
const mockScheduleChatSummary = jest.fn();

jest.mock('../lib/worktree-chat-turn', () => ({
  scheduleChatSummary: (...args: unknown[]): unknown =>
    mockScheduleChatSummary(...args),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/worktree'),
}));
jest.mock('../lib/workspace-registry', () => ({
  isCoworkWorkspace: jest.fn(() => false),
}));

jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: jest.fn(() => ({
    launch: mockClaudeTerminalLaunch,
    authorizeAgentInputTerminalWrite: mockAuthorizeTerminalAgentWrite,
    cleanup: jest.fn(),
    getState: mockClaudeTerminalGetState,
    interrupt: mockClaudeTerminalInterrupt,
    setEventSender: mockClaudeTerminalSetEventSender,
    setChatSummaryScheduler: mockClaudeTerminalSetChatSummaryScheduler,
  })),
}));

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  ClaudeTerminalLaunchError,
  IPC_CHANNELS,
  TERMINAL_USER_CLOSE_SIGNAL,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerTerminalHandlers } from '../ipc/terminal';
import {
  chatDriver,
  resetChatDriversForTests,
} from '../remote-control/host/chat-drivers';
import { sendToWindow } from '../lib/window-send';
import { prewarmLinuxTerminalShell, ptyManager } from '../terminal/pty-manager';
import { terminalPersistenceStore } from '../terminal/persistence';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../services/split-lock-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedPtyManager = jest.mocked(ptyManager);
const mockedTerminalPersistenceStore = jest.mocked(terminalPersistenceStore);

type HandlerFn = (...args: unknown[]) => unknown;

function getRegisteredHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Missing registered handler for ${channel}`);
  }

  const handler: unknown = call[1];
  if (typeof handler !== 'function') {
    throw new Error(`Invalid handler for ${channel}`);
  }

  return (...args: unknown[]): unknown => handler(...args);
}

describe('registerTerminalHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerTerminalHandlers(() => null);
  });

  it('registers the terminal IPC handlers', () => {
    expect(mockedPtyManager.setEventSender).toHaveBeenCalledTimes(1);
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalSpawn,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalAttach,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalRestore,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalWrite,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalResize,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalKill,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalLoadWorktreeState,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalSaveWorktreeState,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalList,
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.terminalListProfiles,
      expect.any(Function),
    );
  });

  it('routes untargeted Claude terminal events only to the main window', () => {
    const eventSender = mockClaudeTerminalSetEventSender.mock.calls[0]?.[0] as
      | ((channel: string, payload: unknown) => void)
      | undefined;

    eventSender?.(IPC_CHANNELS.claudeTerminalError, {
      chatId: 'chat-1',
      message: 'boom',
    });

    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.claudeTerminalError,
      {
        chatId: 'chat-1',
        message: 'boom',
      },
    );
  });

  it('forwards a terminal session owner to its queued chat summary', async () => {
    const scheduler =
      mockClaudeTerminalSetChatSummaryScheduler.mock.calls[0]?.[0];
    const workOwner = Promise.resolve({ kind: 'personal' as const });

    scheduler?.({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      text: 'Summarize this terminal chat.',
      workOwner,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockScheduleChatSummary).toHaveBeenCalledWith(
      expect.objectContaining({ workOwner }),
    );
  });

  it('routes targeted App Advisor Claude terminal events to both windows', () => {
    jest.clearAllMocks();
    const mainWindow = {} as never;
    const appAdvisorWindow = {} as never;
    registerTerminalHandlers({
      getMainWindow: () => mainWindow,
      getAppAdvisorWindow: () => appAdvisorWindow,
    } as never);
    const eventSender = mockClaudeTerminalSetEventSender.mock.calls[0]?.[0] as
      | ((channel: string, payload: unknown) => void)
      | undefined;
    const payload = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      chatId: 'chat-1',
      importedEventCount: 0,
    };

    eventSender?.(IPC_CHANNELS.claudeTerminalSyncCompleted, payload);

    expect(mockedSendToWindow).toHaveBeenCalledTimes(2);
    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      1,
      mainWindow,
      IPC_CHANNELS.claudeTerminalSyncCompleted,
      payload,
    );
    expect(mockedSendToWindow).toHaveBeenNthCalledWith(
      2,
      appAdvisorWindow,
      IPC_CHANNELS.claudeTerminalSyncCompleted,
      payload,
    );
  });

  it('routes App Advisor entry PTY events to both windows without misclassifying foreign global targets', () => {
    jest.clearAllMocks();
    const mainWindow = {} as never;
    const appAdvisorWindow = {} as never;
    registerTerminalHandlers({
      getMainWindow: () => mainWindow,
      getAppAdvisorWindow: () => appAdvisorWindow,
    } as never);
    const eventSender = mockedPtyManager.setEventSender.mock.calls[0]?.[0] as
      | ((channel: string, payload: Record<string, unknown>) => void)
      | undefined;
    const appAdvisorPayload = {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: 'entry-app-advisor',
      terminalId: 'terminal-1',
      data: 'output',
    };

    eventSender?.(IPC_CHANNELS.terminalOutput, appAdvisorPayload);
    expect(mockedSendToWindow).toHaveBeenCalledTimes(2);

    jest.clearAllMocks();
    const foreignPayload = {
      projectId: 'foreign-project',
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      terminalId: 'terminal-2',
      data: 'output',
    };
    eventSender?.(IPC_CHANNELS.terminalOutput, foreignPayload);

    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      mainWindow,
      IPC_CHANNELS.terminalOutput,
      foreignPayload,
    );
  });

  it('sends PTY output per frame, an idle echo at once, and held output before exit', () => {
    jest.useFakeTimers();
    try {
      jest.clearAllMocks();
      const mainWindow = {} as never;
      registerTerminalHandlers(() => mainWindow);
      const eventSender = mockedPtyManager.setEventSender.mock.calls[0]?.[0] as
        | ((channel: string, payload: Record<string, unknown>) => void)
        | undefined;
      let seq = 0;
      const output = (text: string): Record<string, unknown> => {
        const data = new TextEncoder().encode(text);
        seq += data.length;
        return {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          terminalId: 'terminal-1',
          data,
          seq,
        };
      };
      const sentOutput = (): string[] =>
        mockedSendToWindow.mock.calls
          .filter(([, channel]) => channel === IPC_CHANNELS.terminalOutput)
          .map(([, , payload]) =>
            new TextDecoder().decode((payload as { data: Uint8Array }).data),
          );

      eventSender?.(IPC_CHANNELS.terminalOutput, output('e'));
      expect(sentOutput()).toEqual(['e']);
      for (const chunk of ['1', '2', '3'])
        eventSender?.(IPC_CHANNELS.terminalOutput, output(chunk));
      expect(sentOutput()).toEqual(['e']);
      jest.advanceTimersByTime(16);
      expect(sentOutput()).toEqual(['e', '123']);

      eventSender?.(IPC_CHANNELS.terminalOutput, output('4'));
      eventSender?.(IPC_CHANNELS.terminalExit, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalId: 'terminal-1',
        exitCode: 0,
        signal: null,
      });
      expect(
        mockedSendToWindow.mock.calls.map(([, channel]) => channel),
      ).toEqual([
        IPC_CHANNELS.terminalOutput,
        IPC_CHANNELS.terminalOutput,
        IPC_CHANNELS.terminalOutput,
        IPC_CHANNELS.terminalExit,
      ]);
      expect(sentOutput()).toEqual(['e', '123', '4']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('forwards selected repo ids on spawn requests', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);
    mockedPtyManager.spawn.mockReturnValue({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp/frontend',
      createdAt: 1,
    });

    const result = await spawnHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      selectedRepoId: 'frontend',
      cols: 120,
      rows: 40,
    });

    expect(mockedPtyManager.spawn).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      120,
      40,
      'frontend',
    );
    expect(result).toEqual({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp/frontend',
      createdAt: 1,
    });
  });

  it('awaits the Linux account-shell prewarm before a Default spawn and a profile list, but not for explicit or managed spawns', async () => {
    const order: string[] = [];
    jest.mocked(prewarmLinuxTerminalShell).mockImplementation(() => {
      order.push('prewarm');
      return Promise.resolve();
    });
    mockedPtyManager.spawn.mockImplementation(() => {
      order.push('spawn');
      return {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/bash',
        shellBasename: 'bash',
        cwd: '/tmp',
        createdAt: 1,
      };
    });
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);
    const base = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      cols: 80,
      rows: 24,
    };

    await spawnHandler(null, base);
    await spawnHandler(null, { ...base, terminalProfileId: 'default' });
    expect(order).toEqual(['prewarm', 'spawn', 'prewarm', 'spawn']);

    order.length = 0;
    await spawnHandler(null, { ...base, terminalProfileId: 'bash' });
    expect(order).toEqual(['spawn']);

    order.length = 0;
    await getRegisteredHandler(IPC_CHANNELS.terminalListProfiles)(null);
    expect(order).toEqual(['prewarm']);
  });

  it('forwards explicit terminal profile ids on spawn requests', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);
    mockedPtyManager.spawn.mockReturnValue({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/bash',
      shellBasename: 'bash',
      cwd: '/tmp/frontend',
      createdAt: 1,
    });

    await spawnHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      terminalProfileId: 'bash',
      cols: 120,
      rows: 40,
    });

    expect(mockedPtyManager.spawn).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      120,
      40,
      undefined,
      undefined,
      undefined,
      'bash',
    );
  });

  it('rejects invalid terminal profile ids before they reach the PTY manager', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);

    await expect(
      spawnHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        terminalProfileId: '../bash',
        cols: 120,
        rows: 40,
      }),
    ).rejects.toThrow('Invalid terminal profile id');
    expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
  });

  it('lists available terminal profiles', async () => {
    const listProfilesHandler = getRegisteredHandler(
      IPC_CHANNELS.terminalListProfiles,
    );

    await expect(listProfilesHandler(null)).resolves.toEqual([
      { id: 'zsh', label: 'zsh', isDefault: true },
      { id: 'bash', label: 'bash', isDefault: false },
    ]);
  });

  it('rejects invalid selected repo ids before they reach the PTY manager', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);

    await expect(
      spawnHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        selectedRepoId: '../oops',
        cols: 120,
        rows: 40,
      }),
    ).rejects.toThrow('Invalid selectedRepoId');
    expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
  });

  it('rejects invalid managed terminal commands before they reach the PTY manager', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);

    await expect(
      spawnHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        cols: 120,
        rows: 40,
        managedCommand: {
          executable: '/usr/local/bin/claude',
          args: [],
          title: 'Claude Code',
          kind: 'claude-code',
        },
      }),
    ).rejects.toThrow('must use the bundled Claude binary');
    expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
  });

  it('accepts claude-worker managed terminal commands', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);
    mockedPtyManager.spawn.mockReturnValue({
      id: 'worker-terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/claude',
      shellBasename: 'claude',
      cwd: '/tmp/frontend',
      createdAt: 1,
    });

    const managedCommand = {
      executable: '/bin/claude',
      args: ['--print'],
      title: 'Claude Worker',
      kind: 'claude-worker',
    } as const;

    const result = await spawnHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      cols: 120,
      rows: 40,
      managedCommand,
    });

    expect(mockedPtyManager.spawn).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      120,
      40,
      undefined,
      managedCommand,
    );
    expect(result).toEqual({
      id: 'worker-terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/claude',
      shellBasename: 'claude',
      cwd: '/tmp/frontend',
      createdAt: 1,
    });
  });

  it('rejects managed terminal env keys that can override execution context', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);

    await expect(
      spawnHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        cols: 120,
        rows: 40,
        managedCommand: {
          executable: '/bin/claude',
          args: [],
          env: {
            PATH: '/tmp/evil',
          },
          title: 'Claude Code',
          kind: 'claude-code',
        },
      }),
    ).rejects.toThrow('blocked key PATH');
    expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
  });

  it('rejects renderer-supplied managed terminal path overrides', async () => {
    const spawnHandler = getRegisteredHandler(IPC_CHANNELS.terminalSpawn);

    await expect(
      spawnHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        cols: 120,
        rows: 40,
        managedCommand: {
          executable: '/bin/claude',
          args: [],
          pathPrepend: ['/tmp/evil'],
          title: 'Claude Code',
          kind: 'claude-code',
        },
      }),
    ).rejects.toThrow('only internal launches may set path overrides');
    expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
  });

  it('rejects oversized terminal writes before they reach the PTY manager', () => {
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    const oversizedWrite = 'a'.repeat(64 * 1024 + 1);

    expect((): unknown =>
      writeHandler(null, {
        terminalId: 'terminal-1',
        data: oversizedWrite,
      }),
    ).toThrow('Terminal write exceeds maximum data size');
    expect(mockedPtyManager.write).not.toHaveBeenCalled();
  });

  it('blocks an unauthorized retained agent paste before any PTY write and preserves successful replay receipts', async () => {
    const handler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'agent-terminal',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);
    const request = {
      terminalId: 'agent-terminal',
      data: 'unchanged paste',
      idempotencyKey: 'accepted-agent-paste',
    };
    try {
      mockAuthorizeTerminalAgentWrite.mockImplementationOnce(() =>
        Promise.reject(
          new Error(
            'The agent that sent this message can no longer reach this chat.',
          ),
        ),
      );
      await expect(
        Promise.resolve().then(() => handler(null, request)),
      ).rejects.toThrow('can no longer reach');
      expect(mockedPtyManager.write).not.toHaveBeenCalled();
      mockAuthorizeTerminalAgentWrite.mockReturnValue(undefined);
      expect(await handler(null, request)).toBe('written');
      expect(mockedPtyManager.write).toHaveBeenCalledWith(
        'agent-terminal',
        'unchanged paste',
      );
      expect(await handler(null, request)).toBe('already_written');
      expect(mockedPtyManager.write).toHaveBeenCalledTimes(1);
    } finally {
      mockAuthorizeTerminalAgentWrite.mockReset();
    }
  });

  it('records who drives a chat from writes to its terminal', () => {
    resetChatDriversForTests();
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
        chatId: 'chat-1',
      },
    ]);
    mockedPtyManager.chatIdOf.mockReturnValue('chat-1');

    writeHandler(
      { sender: { id: 'bridge' } },
      {
        terminalId: 'terminal-1',
        data: 'hi',
      },
    );
    expect(chatDriver('chat-1')).toBe('controller-1');

    // A viewer's emulator answering a cursor-position or mode query is not
    // input.
    for (const reply of ['\u001b[12;40R', '\u001b[?2026;2$y']) {
      writeHandler(
        { sender: { id: 'app-window' } },
        { terminalId: 'terminal-1', data: reply },
      );
      expect(chatDriver('chat-1')).toBe('controller-1');
    }

    writeHandler(
      { sender: { id: 'app-window' } },
      {
        terminalId: 'terminal-1',
        data: 'hi',
      },
    );
    expect(chatDriver('chat-1')).toBeNull();
    mockedPtyManager.chatIdOf.mockReset();
  });

  it('keeps the driver when another window opens a chat whose terminal is live', async () => {
    resetChatDriversForTests();
    const launchHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalLaunch,
    );
    const request = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cols: 80,
      rows: 24,
    };
    const liveState = { terminalId: 'terminal-1', turnState: 'running' };
    mockClaudeTerminalLaunch.mockResolvedValue({
      terminalId: 'terminal-1',
      sessionKey: 'session-key',
      sdkSessionId: 'sdk-session',
      initialPromptSubmitted: false,
      state: liveState,
    });

    await launchHandler({ sender: { id: 'bridge' } }, request);
    expect(chatDriver('chat-1')).toBe('controller-1');

    // Viewing the chat here only shows the terminal that is already running.
    mockClaudeTerminalGetState.mockReturnValue(liveState);
    await launchHandler({ sender: { id: 'app-window' } }, request);
    expect(chatDriver('chat-1')).toBe('controller-1');

    // A launch that spawns the terminal again makes this window its driver.
    mockClaudeTerminalGetState.mockReturnValue({
      terminalId: 'terminal-1',
      turnState: 'exited',
    });
    await launchHandler({ sender: { id: 'app-window' } }, request);
    expect(chatDriver('chat-1')).toBeNull();

    mockClaudeTerminalGetState.mockReset();
    mockClaudeTerminalLaunch.mockReset();
  });

  it('forwards valid terminal writes to the PTY manager', () => {
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);

    writeHandler(null, {
      terminalId: 'terminal-1',
      data: 'echo hi',
    });

    expect(mockedPtyManager.write).toHaveBeenCalledWith(
      'terminal-1',
      'echo hi',
    );
  });

  it('deduplicates terminal writes after the main process accepts them', () => {
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);
    const request = {
      terminalId: 'terminal-1',
      data: 'watcher prompt',
      idempotencyKey: 'watcher-delivery-1-paste',
    };

    expect(writeHandler(null, request)).toBe('written');
    expect(writeHandler(null, request)).toBe('already_written');
    expect(mockedPtyManager.write).toHaveBeenCalledTimes(1);
  });

  it('deduplicates live writes after an initial watcher prompt launch', async () => {
    const launchHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalLaunch,
    );
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-launch',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);
    mockClaudeTerminalLaunch.mockResolvedValueOnce({
      terminalId: 'terminal-launch',
      sessionKey: 'session-key',
      sdkSessionId: 'sdk-session',
      initialPromptSubmitted: true,
      state: { turnState: 'idle' },
    });

    await launchHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cols: 80,
      rows: 24,
      initialPrompt: 'Watcher prompt',
      initialPromptIdempotencyKey: 'watcher-delivery-launch',
    });

    for (const idempotencyKey of [
      'watcher-delivery-launch-clear-0',
      'watcher-delivery-launch-clear-1',
      'watcher-delivery-launch-clear-2',
      'watcher-delivery-launch-paste',
      'watcher-delivery-launch-submit',
    ]) {
      expect(
        writeHandler(null, {
          terminalId: 'terminal-launch',
          data: 'replayed input',
          idempotencyKey,
        }),
      ).toBe('already_written');
    }
    expect(mockedPtyManager.write).not.toHaveBeenCalled();
  });

  it('retries idempotent terminal writes that the PTY rejected', () => {
    const writeHandler = getRegisteredHandler(IPC_CHANNELS.terminalWrite);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);
    mockedPtyManager.write.mockImplementationOnce(() => {
      throw new Error('terminal unavailable');
    });
    const request = {
      terminalId: 'terminal-1',
      data: 'watcher prompt',
      idempotencyKey: 'watcher-delivery-2-paste',
    };

    expect(() => writeHandler(null, request)).toThrow('terminal unavailable');
    expect(writeHandler(null, request)).toBe('written');
    expect(mockedPtyManager.write).toHaveBeenCalledTimes(2);
  });

  it('marks renderer terminal closes as user-initiated', () => {
    const killHandler = getRegisteredHandler(IPC_CHANNELS.terminalKill);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-1',
        projectId: 'project-1',
        worktreeId: 'wt-1',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);

    killHandler(null, { terminalId: 'terminal-1' });

    expect(mockedPtyManager.kill).toHaveBeenCalledWith('terminal-1', {
      signalOverride: TERMINAL_USER_CLOSE_SIGNAL,
    });
  });

  it('forwards restore requests to the PTY manager', async () => {
    const restoreHandler = getRegisteredHandler(IPC_CHANNELS.terminalRestore);
    mockedPtyManager.list.mockReturnValue([]);
    mockedPtyManager.restore.mockReturnValue({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
    });

    const result = await restoreHandler(null, {
      terminalId: 'terminal-1',
      cols: 120,
      rows: 40,
    });

    expect(mockedPtyManager.restore).toHaveBeenCalledWith(
      'terminal-1',
      120,
      40,
    );
    expect(result).toEqual({
      id: 'terminal-1',
      projectId: 'project-1',
      worktreeId: 'wt-1',
      shell: '/bin/zsh',
      shellBasename: 'zsh',
      cwd: '/tmp',
      createdAt: 1,
    });
  });

  it('refuses restore for a split-locked worktree', async () => {
    const restoreHandler = getRegisteredHandler(IPC_CHANNELS.terminalRestore);
    mockedPtyManager.list.mockReturnValue([
      {
        id: 'terminal-locked',
        projectId: 'project-locked',
        worktreeId: 'wt-locked',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
    ]);
    acquireSplitLock('project-locked', 'wt-locked');
    try {
      await expect(
        restoreHandler(null, {
          terminalId: 'terminal-locked',
          cols: 120,
          rows: 40,
        }),
      ).rejects.toThrow(SplitLockError);
      expect(mockedPtyManager.restore).not.toHaveBeenCalled();
    } finally {
      releaseSplitLock('project-locked', 'wt-locked');
    }
  });

  it('refuses restore for a persisted terminal in a split-locked worktree', async () => {
    const restoreHandler = getRegisteredHandler(IPC_CHANNELS.terminalRestore);
    mockedPtyManager.list.mockReturnValue([]);
    mockedTerminalPersistenceStore.getPersistedTerminalEntry.mockReturnValue({
      session: {
        id: 'terminal-locked',
        projectId: 'project-locked',
        worktreeId: 'wt-locked',
        shell: '/bin/zsh',
        shellBasename: 'zsh',
        cwd: '/tmp',
        createdAt: 1,
      },
      scrollbackLines: [],
      exitCode: null,
      signal: 'app-quit',
    });
    acquireSplitLock('project-locked', 'wt-locked');
    try {
      await expect(
        restoreHandler(null, {
          terminalId: 'terminal-locked',
          cols: 120,
          rows: 40,
        }),
      ).rejects.toThrow(SplitLockError);
      expect(mockedPtyManager.restore).not.toHaveBeenCalled();
    } finally {
      releaseSplitLock('project-locked', 'wt-locked');
    }
  });

  it('loads persisted worktree terminal state through the persistence store', () => {
    const loadHandler = getRegisteredHandler(
      IPC_CHANNELS.terminalLoadWorktreeState,
    );
    mockedTerminalPersistenceStore.loadWorktreeState.mockReturnValue({
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
      terminals: [],
      liveTerminalIds: [],
    });

    const result = loadHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });

    expect(
      mockedTerminalPersistenceStore.loadWorktreeState,
    ).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(result).toEqual({
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
      terminals: [],
      liveTerminalIds: [],
    });
  });

  it('saves persisted worktree terminal state through the persistence store', () => {
    const saveHandler = getRegisteredHandler(
      IPC_CHANNELS.terminalSaveWorktreeState,
    );

    saveHandler(null, {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    });

    expect(
      mockedTerminalPersistenceStore.saveWorktreeState,
    ).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      drawerCollapsed: true,
      groups: [],
      activeGroupId: null,
      nextGroupOrdinal: 1,
      groupOrdinals: {},
      terminalCustomNames: {},
      groupCustomNames: {},
    });
  });

  it('returns typed Claude terminal launch rejection envelopes', async () => {
    const launchHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalLaunch,
    );
    mockClaudeTerminalLaunch.mockRejectedValueOnce(
      new ClaudeTerminalLaunchError(
        'unsupported_provider',
        'Claude Code terminal mode is only available for Claude chats.',
      ),
    );

    await expect(
      launchHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        cols: 80,
        rows: 24,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'unsupported_provider',
        message:
          'Claude Code terminal mode is only available for Claude chats.',
      },
    });
  });

  it('leaves canonical-history resolution of a terminal snapshot to the session service', async () => {
    mockClaudeTerminalLaunch.mockClear();
    mockClaudeTerminalLaunch.mockResolvedValueOnce({
      terminalId: 'terminal-1',
      sessionKey: 'session-1',
      sdkSessionId: 'sdk-1',
      state: {},
      initialPromptSubmitted: false,
    });
    const launchHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalLaunch,
    );
    const request = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      cols: 80,
      rows: 24,
      tabSnapshot: {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-10-16T00:00:00.000Z',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Existing history' }],
            timestamp: 1,
            userMessageSource: 'agent',
          },
        ],
      },
    };

    await expect(launchHandler(null, request)).resolves.toMatchObject({
      terminalId: 'terminal-1',
    });

    const windowMatcher: unknown = expect.any(Function);
    expect(mockClaudeTerminalLaunch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ getWindow: windowMatcher }),
    );
  });

  it('rejects forged launch request fields before reaching the session service', async () => {
    mockClaudeTerminalLaunch.mockClear();
    const launchHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalLaunch,
    );

    await expect(
      launchHandler(
        null,
        Object.assign(
          {
            projectId: 'project-1',
            worktreeId: 'wt-1',
            chatId: 'chat-1',
            cols: 80,
            rows: 24,
          },
          { agentSent: { sender: { kind: 'bot' } } },
        ),
      ),
    ).rejects.toThrow('agentSent');

    expect(mockClaudeTerminalLaunch).not.toHaveBeenCalled();
  });

  it('routes Claude terminal interrupt requests through the session service', async () => {
    const interruptHandler = getRegisteredHandler(
      IPC_CHANNELS.claudeTerminalInterrupt,
    );

    await expect(
      interruptHandler(null, {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
      }),
    ).resolves.toBeUndefined();

    expect(mockClaudeTerminalInterrupt).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
    });
  });
});

describe('relative terminal target authority', () => {
  it('rejects relative-directory requests for an untracked worktree before spawn', async () => {
    const persistence = await import('../lib/workspace-persistence');
    const terminal = await import('../services/terminal-service');
    const config = jest
      .spyOn(persistence, 'readWorkspaceConfigDetailed')
      .mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
        config: { version: 1, type: 'multi-repo', repos: [], alwaysShow: true },
      });
    const trees = jest
      .spyOn(persistence, 'readWorkspaceWorktrees')
      .mockResolvedValue([]);
    mockedPtyManager.spawn.mockClear();
    try {
      await expect(
        terminal.spawnTerminalAfterShellPrewarm({
          projectId: 'project-1',
          worktreeId: 'unknown',
          relativeCwd: 'apps/web',
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
    } finally {
      config.mockRestore();
      trees.mockRestore();
    }
  });
  it('rejects a repository outside the authoritative workspace membership', async () => {
    const persistence = await import('../lib/workspace-persistence');
    const terminal = await import('../services/terminal-service');
    const config = jest
      .spyOn(persistence, 'readWorkspaceConfigDetailed')
      .mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
        config: { version: 1, type: 'multi-repo', repos: [], alwaysShow: true },
      });
    const trees = jest
      .spyOn(persistence, 'readWorkspaceWorktrees')
      .mockResolvedValue([
        { id: 'wt-1', branchName: 'main', createdAt: '2026-10-21' },
      ]);
    mockedPtyManager.spawn.mockClear();
    try {
      await expect(
        terminal.spawnTerminalAfterShellPrewarm({
          projectId: 'project-1',
          worktreeId: 'wt-1',
          selectedRepoId: 'unknown',
          relativeCwd: 'apps/web',
          cols: 80,
          rows: 24,
        }),
      ).rejects.toMatchObject({ code: 'invalid_target' });
      expect(mockedPtyManager.spawn).not.toHaveBeenCalled();
    } finally {
      config.mockRestore();
      trees.mockRestore();
    }
  });
  it('passes only a contained package directory to the real spawn boundary', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const persistence = await import('../lib/workspace-persistence');
    const resolver = await import('../lib/resolve-worktree');
    const terminal = await import('../services/terminal-service');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-target-'));
    await fs.mkdir(path.join(root, 'apps/web'), { recursive: true });
    const config = jest
      .spyOn(persistence, 'readWorkspaceConfigDetailed')
      .mockResolvedValue({
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
        config: {
          version: 1,
          type: 'multi-repo',
          repos: [{ id: 'repo', name: 'Repo', repoPath: root }],
          alwaysShow: true,
        },
      });
    const trees = jest
      .spyOn(persistence, 'readWorkspaceWorktrees')
      .mockResolvedValue([
        { id: 'wt-1', branchName: 'main', createdAt: '2026-10-21' },
      ]);
    jest.mocked(resolver.resolveWorktreeCwd).mockReturnValue(root);
    mockedPtyManager.spawn.mockClear();
    try {
      await terminal.spawnTerminalAfterShellPrewarm({
        projectId: 'project-1',
        worktreeId: 'wt-1',
        selectedRepoId: 'repo',
        relativeCwd: 'apps/web',
        cols: 80,
        rows: 24,
      });
      expect(mockedPtyManager.spawn).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
        80,
        24,
        'repo',
        undefined,
        await fs.realpath(path.join(root, 'apps/web')),
        undefined,
        undefined,
      );
    } finally {
      config.mockRestore();
      trees.mockRestore();
      jest.mocked(resolver.resolveWorktreeCwd).mockReturnValue('/worktree');
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
