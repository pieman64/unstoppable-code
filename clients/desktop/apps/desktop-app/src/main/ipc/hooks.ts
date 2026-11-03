import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type HookRunRequest,
  type HookRunResponse,
  type HookRunSnapshot,
  type HookSourceInfoRequest,
  type HookSourceInfoResponse,
  type InspectHookChatPluginDependenciesRequest,
  type InspectHookChatPluginDependenciesResponse,
  type HookStopRequest,
  type LoadWorktreeHookRunsRequest,
  type SaveProjectHooksRequest,
  type SaveWorkspaceHooksRequest,
  type SaveWorkspaceRepoHooksRequest,
  type SetWorktreePausedHooksRequest,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { assertWritableScope } from '../lib/read-only-scope';
import { registerIpcHandler } from './register';
import {
  createHookCompleteEvent,
  createHookOutputEvent,
  createHookStartedEvent,
} from '../lib/hook-events';
import { inspectHookChatPluginDependencies } from '../lib/hook-chat-plugin-dependencies';
import {
  cancelHook,
  loadWorktreeHookRuns,
  runHookCommand,
  saveProjectHooksFromService,
  setWorktreePausedHookKeys,
  saveWorkspaceHooksFromService,
  saveWorkspaceRepoHooksFromService,
} from '../services/hooks-service';
import type { RunHookOptions } from '../lib/hook-runner';
import { sendToWebContents } from '../lib/web-contents-send';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  projectedWorkspaceGuardedCommands,
  type ProjectedWorkspaceGuardedCommands,
} from '../canopy-runtime/workspace-guarded-dispatch';
import { getHookSourceInfoThroughCore } from '../canopy-runtime/hook-source-dispatch';

function createManualHookRunCallbacks(
  event: IpcMainInvokeEvent,
  projectId: string,
  worktreeId: string,
): Pick<RunHookOptions, 'onStarted' | 'onOutput' | 'onComplete'> {
  return {
    onStarted: (startedHook): void => {
      sendToWebContents(
        event.sender,
        IPC_CHANNELS.hookStarted,
        createHookStartedEvent(projectId, worktreeId, startedHook),
      );
    },
    onOutput: (outputHook, lines, _ref, activeActionIndex): void => {
      sendToWebContents(
        event.sender,
        IPC_CHANNELS.hookOutput,
        createHookOutputEvent(
          projectId,
          worktreeId,
          outputHook,
          lines,
          activeActionIndex,
        ),
      );
    },
    onComplete: (completedHook, result): void => {
      sendToWebContents(
        event.sender,
        IPC_CHANNELS.hookComplete,
        createHookCompleteEvent(projectId, worktreeId, completedHook, result),
      );
    },
  };
}

export function registerHookHandlers(
  getWindow: () => BrowserWindow | null,
  runtime: {
    dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;
    resolveCaller: DesktopIpcCallerResolver;
  },
): void {
  const guardedCommands = (
    event: IpcMainInvokeEvent,
  ): ProjectedWorkspaceGuardedCommands =>
    projectedWorkspaceGuardedCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  registerIpcHandler(
    IPC_CHANNELS.projectSaveHooks,
    async (event, request: SaveProjectHooksRequest): Promise<void> => {
      assertWritableScope(request.projectId);
      await saveProjectHooksFromService(request, (update) =>
        guardedCommands(event).updateHooks(update),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveHooks,
    async (event, request: SaveWorkspaceHooksRequest): Promise<void> => {
      assertWritableScope(request.workspaceId);
      await saveWorkspaceHooksFromService(request, (update) =>
        guardedCommands(event).updateHooks(update),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveRepoHooks,
    async (event, request: SaveWorkspaceRepoHooksRequest): Promise<void> => {
      assertWritableScope(request.workspaceId);
      await saveWorkspaceRepoHooksFromService(request, (update) =>
        guardedCommands(event).updateHooks(update),
      );
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.hookRun,
    async (event, request: HookRunRequest): Promise<HookRunResponse> => {
      const projectId =
        request.target === 'project' ? request.projectId : request.workspaceId;
      assertWritableScope(projectId);
      return runHookCommand(request, {
        getWindow,
        ...createManualHookRunCallbacks(event, projectId, request.worktreeId),
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.hookStop,
    async (
      _event,
      request: HookStopRequest,
    ): Promise<HookRunResponse | null> => {
      return cancelHook(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.hookLoadWorktreeRuns,
    async (
      _event,
      request: LoadWorktreeHookRunsRequest,
    ): Promise<HookRunSnapshot[]> => loadWorktreeHookRuns(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeSetPausedHooks,
    async (event, request: SetWorktreePausedHooksRequest): Promise<void> => {
      await setWorktreePausedHookKeys(request, (change) =>
        guardedCommands(event).setWorktreeHooksPaused(change),
      );
    },
  );

  // core.initiatedWork.source.get
  registerIpcHandler(
    IPC_CHANNELS.hookSourceInfo,
    async (
      event,
      request: HookSourceInfoRequest,
    ): Promise<HookSourceInfoResponse> =>
      getHookSourceInfoThroughCore(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.hookChatPluginDependenciesInspect,
    async (
      _event,
      request: InspectHookChatPluginDependenciesRequest,
    ): Promise<InspectHookChatPluginDependenciesResponse> => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      return inspectHookChatPluginDependencies(request);
    },
  );
}
