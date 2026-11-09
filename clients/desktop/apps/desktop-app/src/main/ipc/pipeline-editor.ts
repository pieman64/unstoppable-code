import type { WebContents } from 'electron';
import { BRAND } from '@canopy/brand/current';
import type { InterfaceToolOutcome } from '@canopy/core-runtime/node/client';
import {
  IPC_CHANNELS,
  type PipelineEditorRendererToolRequest,
  type PipelineEditorRendererToolResponse,
  type PipelineEditorSaveSnapshot,
  type PipelineEditorSaveTarget,
} from '@canopy/desktop-shared/types';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

/*
 * The Pipeline Editor's renderer tools reach the main window only through its
 * interface lease (CAN-5822): calls go out on `pipeline-editor:tool-request`
 * and replies come back on `pipeline-editor:tool-response`, where the lease
 * claims them before anything else sees them.
 */

let interfaceToolReplyHandler:
  | ((
      senderWebContentsId: number,
      response: unknown,
    ) => 'claimed' | 'not_claimed')
  | null = null;

/** Replies to lease-delivered calls are claimed before they are ignored. */
export function setPipelineEditorInterfaceToolReplyHandler(
  handler: typeof interfaceToolReplyHandler,
): void {
  interfaceToolReplyHandler = handler;
}

/** Deliver one lease-bound call to its renderer. */
export function sendPipelineEditorInterfaceToolRequest(
  webContents: WebContents,
  request: PipelineEditorRendererToolRequest,
): boolean {
  if (webContents.isDestroyed()) return false;
  webContents.send(IPC_CHANNELS.pipelineEditorToolRequest, request);
  return true;
}

export function pipelineEditorTimeoutResponse(
  requestId: string,
): PipelineEditorRendererToolResponse {
  return {
    requestId,
    ok: false,
    error: 'Timed out waiting for the Pipeline Editor renderer bridge.',
  };
}

export function pipelineEditorSurfaceUnavailableResponse(
  requestId: string,
): PipelineEditorRendererToolResponse {
  return {
    requestId,
    ok: false,
    error: `The main ${BRAND.displayName} window Pipeline Editor renderer bridge is unavailable.`,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const PIPELINE_SOURCES: ReadonlySet<string> = new Set([
  'bundled',
  'user',
  'curated',
  'project',
  'shared',
]);

function isValidId(value: unknown): value is string {
  try {
    validateId(value, 'id');
    return true;
  } catch {
    return false;
  }
}

function parseTarget(value: unknown): PipelineEditorSaveTarget | null {
  if (!isRecord(value)) return null;
  const { persistedId, source, revision, sharedRemoteId } = value;
  if (
    (persistedId !== undefined && typeof persistedId !== 'string') ||
    (revision !== undefined &&
      (!Number.isSafeInteger(revision) ||
        typeof revision !== 'number' ||
        revision < 0)) ||
    (sharedRemoteId !== undefined && !isValidId(sharedRemoteId)) ||
    // The ids a save writes under: a stored user pipeline's, or a share's.
    (persistedId !== undefined &&
      (source === 'user' || source === undefined) &&
      !isValidId(persistedId))
  )
    return null;
  const target: PipelineEditorSaveTarget = {};
  if (persistedId !== undefined) target.persistedId = persistedId;
  if (source !== undefined) {
    if (!isPipelineSource(source)) return null;
    target.source = source;
  }
  if (revision !== undefined) target.revision = revision;
  if (sharedRemoteId !== undefined) target.sharedRemoteId = sharedRemoteId;
  return target;
}

function isPipelineSource(
  value: unknown,
): value is NonNullable<PipelineEditorSaveTarget['source']> {
  return typeof value === 'string' && PIPELINE_SOURCES.has(value);
}

function parseSnapshot(value: unknown): PipelineEditorSaveSnapshot | null {
  if (!isRecord(value) || !isValidId(value.id)) return null;
  const target = parseTarget(value.target);
  if (!target) return null;
  try {
    // The same shape check every stored pipeline document passes.
    const pipeline = parsePipelineText(
      JSON.stringify({ pipeline: value.pipeline }),
    );
    return { id: value.id, target, pipeline };
  } catch {
    return null;
  }
}

/**
 * The fields of a renderer reply the tool results carry, in the order they
 * always have. Null for a reply that is not one.
 */
export function parsePipelineEditorRendererToolResponse(
  value: unknown,
): PipelineEditorRendererToolResponse | null {
  if (
    !isRecord(value) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.ok !== 'boolean'
  )
    return null;
  const response: PipelineEditorRendererToolResponse = {
    requestId: value.requestId,
    ok: value.ok,
  };
  if (typeof value.originChatId === 'string')
    response.originChatId = value.originChatId;
  if (typeof value.error === 'string') response.error = value.error;
  if (typeof value.pipelineYaml === 'string')
    response.pipelineYaml = value.pipelineYaml;
  if (typeof value.isDirty === 'boolean') response.isDirty = value.isDirty;
  if (Array.isArray(value.validation)) response.validation = value.validation;
  if (typeof value.readonly === 'boolean') response.readonly = value.readonly;
  if (Array.isArray(value.pipelines)) response.pipelines = value.pipelines;
  if (value.snapshot !== undefined) {
    const snapshot = parseSnapshot(value.snapshot);
    if (!snapshot) return null;
    response.snapshot = snapshot;
  }
  return response;
}

/** Today's response shapes for a lease-bound call's outcome (CAN-5822 D9). */
export function pipelineEditorOutcomeToResponse(
  outcome: InterfaceToolOutcome,
  requestId: string,
): PipelineEditorRendererToolResponse {
  if (outcome.ok) {
    const response = parsePipelineEditorRendererToolResponse(outcome.reply);
    return response
      ? { ...response, requestId }
      : {
          requestId,
          ok: false,
          error: 'The window returned an invalid result.',
        };
  }
  switch (outcome.error.kind) {
    case 'capability_unavailable':
    case 'unavailable':
    case 'resource_exhausted':
      return pipelineEditorSurfaceUnavailableResponse(requestId);
    case 'deadline_exceeded':
      return pipelineEditorTimeoutResponse(requestId);
    case 'cancelled':
      return { requestId, ok: false, error: 'The tool call was cancelled.' };
    default:
      return {
        requestId,
        ok: false,
        error: 'The window returned an invalid result.',
      };
  }
}

export function registerPipelineEditorHandlers(): void {
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.pipelineEditorToolResponse,
    (event, value) => {
      // Nothing else waits on these replies: an unclaimed one is late or stray.
      interfaceToolReplyHandler?.(event.sender.id, value);
    },
  );
}
