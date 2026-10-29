import type { IpcRendererEvent } from 'electron';
import {
  ClaudeTerminalLaunchError,
  IPC_CHANNELS,
  isClaudeTerminalLaunchRejectedResponse,
  type ClaudeTerminalApi,
  type ClaudeTerminalCleanupRequest,
  type ClaudeTerminalErrorEvent,
  type ClaudeTerminalInterruptRequest,
  type ClaudeTerminalLaunchRequest,
  type ClaudeTerminalLaunchResponse,
  type ClaudeTerminalRuntimeState,
  type ClaudeTerminalSyncTranscriptRequest,
  type ClaudeTerminalSyncTranscriptResponse,
  type TranscriptSyncResult,
} from '@canopy/desktop-shared/types';

/**
 * Minimal subset of {@link IpcRenderer} used by the Claude Code terminal
 * preload bridge. Extracted so unit tests can supply a lightweight fake
 * without having to mock the entire Electron module.
 */
export interface ClaudeTerminalIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: IpcRendererEvent, ...args: unknown[]) => void,
  ): unknown;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isClaudeTerminalTranscriptSyncEventData(value: unknown): boolean {
  if (!isUnknownRecord(value)) {
    return false;
  }
  return (
    value.type === 'claude_terminal_transcript_sync' &&
    Array.isArray(value.messages) &&
    typeof value.importedEventCount === 'number' &&
    (value.transcriptPath === undefined ||
      typeof value.transcriptPath === 'string') &&
    (value.replayedFromStart === undefined ||
      typeof value.replayedFromStart === 'boolean') &&
    (value.compactionAppended === undefined ||
      typeof value.compactionAppended === 'boolean') &&
    (value.errors === undefined || isStringArray(value.errors))
  );
}

function isClaudeTerminalSyncTranscriptResponse(
  value: unknown,
): value is ClaudeTerminalSyncTranscriptResponse {
  if (!isUnknownRecord(value)) {
    return false;
  }
  return (
    (value.projectId === undefined || typeof value.projectId === 'string') &&
    (value.worktreeId === undefined || typeof value.worktreeId === 'string') &&
    typeof value.chatId === 'string' &&
    typeof value.importedEventCount === 'number' &&
    (value.transcriptPath === undefined ||
      typeof value.transcriptPath === 'string') &&
    (value.replayedFromStart === undefined ||
      typeof value.replayedFromStart === 'boolean') &&
    (value.compactionAppended === undefined ||
      typeof value.compactionAppended === 'boolean') &&
    (value.errors === undefined || isStringArray(value.errors)) &&
    (value.event === undefined ||
      isClaudeTerminalTranscriptSyncEventData(value.event))
  );
}

/**
 * Construct the renderer-facing {@link ClaudeTerminalApi} object that is
 * exposed on `window.api.claudeTerminal`.
 *
 * The bridge is the ONLY sanctioned surface for the renderer — renderer code
 * MUST NOT reach for `ipcRenderer` directly. The `npm run check:electron-boundary`
 * job enforces this rule by scanning renderer imports.
 */
export function createClaudeTerminalBridge(
  ipc: ClaudeTerminalIpcRenderer,
): ClaudeTerminalApi {
  function subscribe<Payload>(
    channel: string,
    listener: (payload: Payload) => void,
  ): () => void {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      // Single producer (main-process Claude terminal session service); we
      // trust the wire shape and cast through the shared transport type.
      listener(data as Payload);
    };
    ipc.on(channel, handler);
    return () => {
      ipc.removeListener(channel, handler);
    };
  }

  return {
    launch: async (
      request: ClaudeTerminalLaunchRequest,
    ): Promise<ClaudeTerminalLaunchResponse> => {
      const response = await ipc.invoke(
        IPC_CHANNELS.claudeTerminalLaunch,
        request,
      );
      if (isClaudeTerminalLaunchRejectedResponse(response)) {
        throw new ClaudeTerminalLaunchError(
          response.error.code,
          response.error.message,
        );
      }
      return response as ClaudeTerminalLaunchResponse;
    },
    cleanup: (request: ClaudeTerminalCleanupRequest) =>
      ipc.invoke(IPC_CHANNELS.claudeTerminalCleanup, request) as Promise<void>,
    getState: (projectId: string, worktreeId: string, chatId: string) =>
      ipc.invoke(IPC_CHANNELS.claudeTerminalGetState, {
        projectId,
        worktreeId,
        chatId,
      }) as Promise<ClaudeTerminalRuntimeState | undefined>,
    interrupt: async (
      request: ClaudeTerminalInterruptRequest,
    ): Promise<void> => {
      await ipc.invoke(IPC_CHANNELS.claudeTerminalInterrupt, request);
    },
    syncTranscript: async (
      request: ClaudeTerminalSyncTranscriptRequest,
    ): Promise<ClaudeTerminalSyncTranscriptResponse> => {
      const response = await ipc.invoke(
        IPC_CHANNELS.claudeTerminalSyncTranscript,
        request,
      );
      if (!isClaudeTerminalSyncTranscriptResponse(response)) {
        throw new Error('Invalid Claude terminal transcript sync response');
      }
      return response;
    },
    onStateChanged: (listener) =>
      subscribe<ClaudeTerminalRuntimeState>(
        IPC_CHANNELS.claudeTerminalStateChanged,
        listener,
      ),
    onSyncCompleted: (listener) =>
      subscribe<TranscriptSyncResult>(
        IPC_CHANNELS.claudeTerminalSyncCompleted,
        listener,
      ),
    onError: (listener) =>
      subscribe<ClaudeTerminalErrorEvent>(
        IPC_CHANNELS.claudeTerminalError,
        listener,
      ),
  };
}
