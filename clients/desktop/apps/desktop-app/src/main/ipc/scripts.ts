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
  getScriptSourceInfo,
  loadWorktreeScriptRuns,
  runScript,
  saveProjectScriptsFromService,
  saveWorkspaceRepoScriptsFromService,
  saveWorkspaceScriptsFromService,
  stopScript,
} from '../services/scripts-service';
import { updateWorkspacePlanDetection } from '../lib/workspace-script-hook-settings';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

export function registerScriptHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.scriptRun,
    async (event, request: ScriptRunRequest): Promise<ScriptRunResponse> =>
      runScript(request, {
        onRendererOutput: (output) => {
          sendToWebContents(event.sender, IPC_CHANNELS.scriptOutput, output);
        },
      }),
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
      _event,
      request: ScriptSourceInfoRequest,
    ): Promise<ScriptSourceInfoResponse> => getScriptSourceInfo(request),
  );

  registerIpcHandler(
    IPC_CHANNELS.projectSaveScripts,
    async (_event, request: SaveProjectScriptsRequest): Promise<void> => {
      await saveProjectScriptsFromService(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveScripts,
    async (_event, request: SaveWorkspaceScriptsRequest): Promise<void> => {
      await saveWorkspaceScriptsFromService(request);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSavePlanDetection,
    async (
      _event,
      request: SaveWorkspacePlanDetectionRequest,
    ): Promise<void> => {
      validateId(request.workspaceId, 'workspaceId');
      await updateWorkspacePlanDetection({
        workspaceId: request.workspaceId,
        planDetection: request.planDetection,
        source: 'desktop',
      });
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.workspaceSaveRepoScripts,
    async (_event, request: SaveWorkspaceRepoScriptsRequest): Promise<void> => {
      await saveWorkspaceRepoScriptsFromService(request);
    },
  );
}
