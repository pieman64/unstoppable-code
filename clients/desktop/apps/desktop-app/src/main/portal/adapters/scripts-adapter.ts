import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  ScriptRunRequest,
  ScriptSourceInfoRequest,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS as SCRIPT_IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../../lib/main-process-logging';
import { sendToWindow } from '../../lib/window-send';
import {
  cancelScript,
  getScriptSourceInfo,
  readAndEmitScriptRunTail,
  runScript,
} from '../../services/scripts-service';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalScriptRun(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.script.run']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid script run payload.');
    return;
  }
  try {
    // Keep the accessor lazy so each delivery targets the current window.
    const getWindow = context.getWindow ?? ((): null => null);
    const sendRendererEvent = (channel: string, event: unknown): void => {
      try {
        const delivered = sendToWindow(getWindow(), channel, event);
        if (!delivered) {
          return;
        }
      } catch (error) {
        logMainProcessError(
          'Failed to deliver a portal script event to the renderer.',
          error,
        );
      }
    };
    let markExecutionStarted: () => void = (): void => undefined;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const running = runScript(command.payload as ScriptRunRequest, {
      portalCommandId: command.id,
      onExecutionStarted: markExecutionStarted,
      onRendererStarted: (event) =>
        sendRendererEvent(SCRIPT_IPC_CHANNELS.scriptStarted, event),
      onRendererOutput: (event) =>
        sendRendererEvent(SCRIPT_IPC_CHANNELS.scriptOutput, event),
      onRendererComplete: (event) =>
        sendRendererEvent(SCRIPT_IPC_CHANNELS.scriptComplete, event),
    });
    await Promise.race([executionStarted, running.then((): void => undefined)]);
    context.complete(command, { ok: true });
    void running.catch((error: unknown): void => {
      logMainProcessError(
        'Portal script execution failed after it started.',
        error,
      );
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalScriptCancel(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.script.cancel']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid script cancel payload.');
    return;
  }
  try {
    const result = await cancelScript(command.payload, {
      portalCommandId: command.id,
    });
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalScriptSourceInfo(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.script.source_info']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid script source payload.');
    return;
  }
  try {
    context.complete(
      command,
      await getScriptSourceInfo(command.payload as ScriptSourceInfoRequest),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalScriptLogRequest(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.script.log_request']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid script log payload.');
    return;
  }
  try {
    if (!command.payload.projectId || !command.payload.worktreeId) {
      context.fail(
        command,
        'invalid_payload',
        'projectId and worktreeId are required.',
      );
      return;
    }
    const result = await readAndEmitScriptRunTail(
      {
        projectId: command.payload.projectId,
        worktreeId: command.payload.worktreeId,
        scriptKey: command.payload.scriptKey,
      },
      { portalCommandId: command.id },
    );
    context.complete(command, { lines: result.lines });
  } catch (error) {
    failServiceError(command, context, error);
  }
}
