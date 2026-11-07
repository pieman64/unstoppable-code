import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type LoadWorktreeScriptRunsRequest,
  type SaveProjectScriptsRequest,
  type SaveWorkspacePlanDetectionRequest,
  type SaveWorkspaceRepoScriptsRequest,
  type SaveWorkspaceScriptsRequest,
  type ScriptRunRequest,
  type ScriptRunResponse,
  type ScriptRunSnapshot,
  type ScriptSourceInfoRequest,
  type ScriptSourceInfoResponse,
  type ScriptStopRequest,
} from '@canopy/desktop-shared/types';
import {
  cancelWorktreeSetup,
  loadWorktreeScriptRuns,
  runScript,
  stopScript,
} from '../services/scripts-service';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';
import { readScriptSourceInfo } from '../lib/script-source-info';
import {
  saveProjectScripts,
  saveWorkspaceRepoScripts,
  saveWorkspaceScripts,
} from '../lib/script-definition-saves';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  projectedWorkspaceMetadataCommands,
  type ProjectedWorkspaceMetadataCommands,
} from '../canopy-runtime/workspace-metadata-dispatch';
import type { DesktopIpcCallerResolver } from './file-tree';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import { withDaemonScriptRoute } from '../lib/daemon-script-route-context';
import {
  selectDaemonScripts,
  type DaemonScriptRouteContext,
} from '../lib/daemon-script-route';

export function registerScriptHandlers(
  runtime: {
    dispatcher: Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;
    resolveCaller: DesktopIpcCallerResolver;
  },
  windows: {
    getMainWindow: () => BrowserWindow | null;
    getAppAdvisorWindow: () => BrowserWindow | null;
  } = {
    getMainWindow: () => null,
    getAppAdvisorWindow: () => null,
  },
): void {
  const metadataCommands = (
    event: Parameters<DesktopIpcCallerResolver>[0],
  ): ProjectedWorkspaceMetadataCommands =>
    projectedWorkspaceMetadataCommands({
      dispatcher: runtime.dispatcher,
      caller: runtime.resolveCaller(event),
    });
  const routeContext = (
    event: Pick<IpcMainInvokeEvent, 'sender'> | null | undefined,
  ): DaemonScriptRouteContext => ({
    localWindow:
      event !== null &&
      event !== undefined &&
      resolveRemoteBridgeSender(event.sender) === null &&
      [windows.getMainWindow(), windows.getAppAdvisorWindow()].some(
        (window) =>
          window !== null &&
          window.webContents === event.sender &&
          !window.isDestroyed(),
      ),
  });
  registerIpcHandler(
    IPC_CHANNELS.scriptRun,
    async (event, request: ScriptRunRequest): Promise<ScriptRunResponse> =>
      (
        await withDaemonScriptRoute(
          selectDaemonScripts(routeContext(event)),
          () =>
            runScript(request, {
              onRendererOutput: (output) => {
                sendToWebContents(
                  event.sender,
                  IPC_CHANNELS.scriptOutput,
                  output,
                );
              },
            }),
        )
      ).value,
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptStop,
    async (
      event,
      request: ScriptStopRequest,
    ): Promise<ScriptRunResponse | null> =>
      stopScript(request, {
        onRendererComplete: (complete) => {
          sendToWebContents(
            event.sender,
            IPC_CHANNELS.scriptComplete,
            complete,
          );
        },
      }),
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptCancelWorktreeSetup,
    async (
      event,
      request: { projectId: string; worktreeId: string },
    ): Promise<void> =>
      cancelWorktreeSetup(request, {
        onRendererComplete: (complete) => {
          sendToWebContents(
            event.sender,
            IPC_CHANNELS.scriptComplete,
            complete,
          );
        },
      }),
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptLoadWorktreeRuns,
    async (
      _event,
      request: LoadWorktreeScriptRunsRequest,
    ): Promise<ScriptRunSnapshot[]> => loadWorktreeScriptRuns(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.scriptSourceInfo,
    async (
      event,
      request: ScriptSourceInfoRequest,
    ): Promise<ScriptSourceInfoResponse> =>
      readScriptSourceInfo(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.projectSaveScripts,
    async (event, request: SaveProjectScriptsRequest): Promise<void> =>
      saveProjectScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveScripts,
    async (event, request: SaveWorkspaceScriptsRequest): Promise<void> =>
      saveWorkspaceScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSavePlanDetection,
    async (
      event,
      request: SaveWorkspacePlanDetectionRequest,
    ): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await metadataCommands(event).updatePlanDetection({
        workspaceId: request.workspaceId,
        planDetection: request.planDetection,
        source: 'desktop',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveRepoScripts,
    async (event, request: SaveWorkspaceRepoScriptsRequest): Promise<void> =>
      saveWorkspaceRepoScripts(
        runtime.dispatcher,
        runtime.resolveCaller(event),
        request,
      ),
  );
}
