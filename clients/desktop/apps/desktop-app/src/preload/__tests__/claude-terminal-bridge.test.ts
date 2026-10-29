import type { IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type ClaudeTerminalErrorEvent,
  type ClaudeTerminalLaunchRequest,
  type ClaudeTerminalLaunchResponse,
  type ClaudeTerminalRuntimeState,
  type TranscriptSyncResult,
} from '@canopy/desktop-shared/types';
import {
  createClaudeTerminalBridge,
  type ClaudeTerminalIpcRenderer,
} from '../claude-terminal-bridge';

type IpcHandler = (event: IpcRendererEvent, ...args: unknown[]) => void;

function makeFakeIpc(): {
  ipc: ClaudeTerminalIpcRenderer;
  invoke: jest.Mock;
  listeners: Map<string, Set<IpcHandler>>;
  emit: (channel: string, payload: unknown) => void;
} {
  const invoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>(() =>
    Promise.resolve(undefined),
  );
  const listeners = new Map<string, Set<IpcHandler>>();
  const ipc: ClaudeTerminalIpcRenderer = {
    invoke: ((channel: string, ...args: unknown[]) =>
      invoke(channel, ...args)) as ClaudeTerminalIpcRenderer['invoke'],
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set<IpcHandler>();
      set.add(handler as IpcHandler);
      listeners.set(channel, set);
      return this;
    },
    removeListener(channel, handler) {
      listeners.get(channel)?.delete(handler as IpcHandler);
      return this;
    },
  };
  const emit = (channel: string, payload: unknown): void => {
    for (const handler of Array.from(
      listeners.get(channel) ?? new Set<IpcHandler>(),
    )) {
      handler({} as IpcRendererEvent, payload);
    }
  };
  return { ipc, invoke, listeners, emit };
}

describe('claude terminal preload bridge', () => {
  it('routes launch / cleanup / getState / interrupt through the correct IPC channels', async () => {
    const { ipc, invoke } = makeFakeIpc();
    const bridge = createClaudeTerminalBridge(ipc);

    const launchRequest: ClaudeTerminalLaunchRequest = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      cols: 80,
      rows: 24,
    };
    const launchResponse: ClaudeTerminalLaunchResponse = {
      terminalId: 't',
      sessionKey: 'sk',
      sdkSessionId: 'sdk-1',
      state: { turnState: 'idle' },
    };
    invoke.mockResolvedValueOnce(launchResponse);
    await expect(bridge.launch(launchRequest)).resolves.toBe(launchResponse);
    expect(invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.claudeTerminalLaunch,
      launchRequest,
    );

    invoke.mockResolvedValueOnce(undefined);
    await bridge.cleanup({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      reason: 'manual',
    });
    expect(invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.claudeTerminalCleanup,
      {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        reason: 'manual',
      },
    );

    const stateSnapshot: ClaudeTerminalRuntimeState = { turnState: 'running' };
    invoke.mockResolvedValueOnce(stateSnapshot);
    await expect(bridge.getState('p', 'w', 'c')).resolves.toBe(stateSnapshot);
    expect(invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.claudeTerminalGetState,
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    );

    invoke.mockResolvedValueOnce(undefined);
    await bridge.interrupt({
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
    });
    expect(invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.claudeTerminalInterrupt,
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    );

    invoke.mockResolvedValueOnce({ chatId: 'c', importedEventCount: 1 });
    await expect(
      bridge.syncTranscript({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
      }),
    ).resolves.toEqual({ chatId: 'c', importedEventCount: 1 });
    expect(invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.claudeTerminalSyncTranscript,
      { projectId: 'p', worktreeId: 'w', chatId: 'c' },
    );
  });

  it('rethrows typed launch rejection envelopes', async () => {
    const { ipc, invoke } = makeFakeIpc();
    const bridge = createClaudeTerminalBridge(ipc);

    invoke.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'unsupported_provider',
        message:
          'Claude Code terminal mode is only available for Claude chats.',
      },
    });

    await expect(
      bridge.launch({
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_provider',
      message: 'Claude Code terminal mode is only available for Claude chats.',
    });
  });

  it.each([
    ['onStateChanged', IPC_CHANNELS.claudeTerminalStateChanged],
    ['onSyncCompleted', IPC_CHANNELS.claudeTerminalSyncCompleted],
    ['onError', IPC_CHANNELS.claudeTerminalError],
  ] as const)(
    '%s registers exactly one IPC listener and removes it on unsubscribe',
    (method, expectedChannel) => {
      const { ipc, listeners, emit } = makeFakeIpc();
      const bridge = createClaudeTerminalBridge(ipc);

      const listener = jest.fn();
      const unsubscribe = (
        bridge[method as keyof typeof bridge] as (
          cb: (data: unknown) => void,
        ) => () => void
      )(listener);

      expect(listeners.get(expectedChannel)?.size ?? 0).toBe(1);
      const samplePayloads = {
        [IPC_CHANNELS.claudeTerminalStateChanged]: {
          turnState: 'idle',
        } satisfies ClaudeTerminalRuntimeState,
        [IPC_CHANNELS.claudeTerminalSyncCompleted]: {
          chatId: 'c',
          importedEventCount: 1,
        } satisfies TranscriptSyncResult,
        [IPC_CHANNELS.claudeTerminalError]: {
          chatId: 'c',
          message: 'boom',
        } satisfies ClaudeTerminalErrorEvent,
      };
      emit(expectedChannel, samplePayloads[expectedChannel]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenLastCalledWith(
        samplePayloads[expectedChannel],
      );

      unsubscribe();
      expect(listeners.get(expectedChannel)?.size ?? 0).toBe(0);

      // After unsubscribe, further emits must not invoke the listener.
      emit(expectedChannel, samplePayloads[expectedChannel]);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  it('does not leak listeners across repeated subscribe/unsubscribe cycles', () => {
    const { ipc, listeners } = makeFakeIpc();
    const bridge = createClaudeTerminalBridge(ipc);

    const noop = (): void => {};
    for (let i = 0; i < 10; i++) {
      const unsubscribeState = bridge.onStateChanged(noop);
      const unsubscribeSync = bridge.onSyncCompleted(noop);
      const unsubscribeError = bridge.onError(noop);
      unsubscribeState();
      unsubscribeSync();
      unsubscribeError();
    }

    expect(
      listeners.get(IPC_CHANNELS.claudeTerminalStateChanged)?.size ?? 0,
    ).toBe(0);
    expect(
      listeners.get(IPC_CHANNELS.claudeTerminalSyncCompleted)?.size ?? 0,
    ).toBe(0);
    expect(listeners.get(IPC_CHANNELS.claudeTerminalError)?.size ?? 0).toBe(0);
  });
});
