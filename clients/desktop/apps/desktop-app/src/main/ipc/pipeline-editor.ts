import type { BrowserWindow } from 'electron';
import { BRAND } from '@canopy/brand/current';
import {
  IPC_CHANNELS,
  getRendererToolRequestScopeKey,
  type PipelineEditorRendererToolRequest,
  type PipelineEditorRendererToolResponse,
} from '@canopy/desktop-shared/types';
import { sendToWindowDetailed } from '../lib/window-send';
import { registerIpcHandler } from './register';

const TOOL_REQUEST_TIMEOUT_MS = 30_000;
const COMPLETED_RESPONSE_CACHE_LIMIT = 100;

type PendingRequest = {
  request: PipelineEditorRendererToolRequest;
  resolve: (response: PipelineEditorRendererToolResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

// Keyed by origin chat plus request ID: request IDs are only unique within a
// chat, so another chat's response must never settle or replay this one.
const pending = new Map<string, PendingRequest>();
const completed = new Map<string, PipelineEditorRendererToolResponse>();

function scopeKey(value: { requestId: string; originChatId?: string }): string {
  return getRendererToolRequestScopeKey(value.requestId, value.originChatId);
}

export interface PipelineEditorRendererToolSurfaces {
  getMainWindow: () => BrowserWindow | null;
}

function rememberCompletedResponse(
  key: string,
  response: PipelineEditorRendererToolResponse,
): void {
  completed.set(key, response);
  if (completed.size > COMPLETED_RESPONSE_CACHE_LIMIT) {
    const firstKey = completed.keys().next().value;
    if (firstKey !== undefined) {
      completed.delete(firstKey);
    }
  }
}

function timeoutResponse(
  requestId: string,
): PipelineEditorRendererToolResponse {
  return {
    requestId,
    ok: false,
    error: 'Timed out waiting for the Pipeline Editor renderer bridge.',
  };
}

function surfaceUnavailableResponse(
  request: PipelineEditorRendererToolRequest,
): PipelineEditorRendererToolResponse {
  return {
    requestId: request.requestId,
    ok: false,
    error: `The main ${BRAND.displayName} window Pipeline Editor renderer bridge is unavailable.`,
  };
}

function validateRendererToolResponse(
  value: unknown,
): PipelineEditorRendererToolResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    !('ok' in value) ||
    typeof value.ok !== 'boolean'
  ) {
    throw new Error('Invalid pipeline editor renderer tool response.');
  }
  const response: PipelineEditorRendererToolResponse = {
    requestId: value.requestId,
    ok: value.ok,
  };
  if ('originChatId' in value && typeof value.originChatId === 'string') {
    response.originChatId = value.originChatId;
  }
  if ('error' in value && typeof value.error === 'string') {
    response.error = value.error;
  }
  if ('pipelineYaml' in value && typeof value.pipelineYaml === 'string') {
    response.pipelineYaml = value.pipelineYaml;
  }
  if ('isDirty' in value && typeof value.isDirty === 'boolean') {
    response.isDirty = value.isDirty;
  }
  if ('validation' in value && Array.isArray(value.validation)) {
    response.validation = value.validation;
  }
  if ('readonly' in value && typeof value.readonly === 'boolean') {
    response.readonly = value.readonly;
  }
  if ('pipelines' in value && Array.isArray(value.pipelines)) {
    response.pipelines = value.pipelines;
  }
  return response;
}

function sendRendererToolRequest(
  request: PipelineEditorRendererToolRequest,
  surfaces: PipelineEditorRendererToolSurfaces,
): boolean {
  return sendToWindowDetailed(
    surfaces.getMainWindow(),
    IPC_CHANNELS.pipelineEditorToolRequest,
    request,
  ).delivered;
}

function settlePendingRequest(
  key: string,
  response: PipelineEditorRendererToolResponse,
): void {
  const request = pending.get(key);
  if (!request) {
    rememberCompletedResponse(key, response);
    return;
  }
  if (request.timer !== null) {
    clearTimeout(request.timer);
  }
  pending.delete(key);
  rememberCompletedResponse(key, response);
  request.resolve(response);
}

export function requestPipelineEditorRendererTool(
  request: PipelineEditorRendererToolRequest,
  surfaces: PipelineEditorRendererToolSurfaces,
): Promise<PipelineEditorRendererToolResponse> {
  const key = scopeKey(request);
  const cached = completed.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const existing = pending.get(key);
  if (existing) {
    return new Promise((resolve) => {
      const previousResolve = existing.resolve;
      existing.resolve = (response): void => {
        previousResolve(response);
        resolve(response);
      };
    });
  }

  return new Promise<PipelineEditorRendererToolResponse>((resolve) => {
    const timer = setTimeout(() => {
      settlePendingRequest(key, timeoutResponse(request.requestId));
    }, TOOL_REQUEST_TIMEOUT_MS);

    pending.set(key, { request, resolve, timer });
    try {
      if (!sendRendererToolRequest(request, surfaces)) {
        settlePendingRequest(key, surfaceUnavailableResponse(request));
      }
    } catch {
      settlePendingRequest(key, surfaceUnavailableResponse(request));
    }
  });
}

export function registerPipelineEditorHandlers(): void {
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.pipelineEditorToolResponse,
    (_event, value) => {
      const response = validateRendererToolResponse(value);
      const key = scopeKey(response);
      const request = pending.get(key);
      if (!request) {
        if (completed.has(key)) {
          return;
        }
        return;
      }
      settlePendingRequest(key, response);
    },
  );
}
