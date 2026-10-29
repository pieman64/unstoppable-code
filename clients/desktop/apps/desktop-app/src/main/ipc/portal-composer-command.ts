import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type PortalChatComposerCommandResult,
  type PortalChatComposerSetterRequest,
} from '@canopy/desktop-shared/types';
import { sendToWindowDetailed } from '../lib/window-send';
import { registerIpcHandler } from './register';

const COMPOSER_COMMAND_ACK_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (result: PortalChatComposerCommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingRequest>();

export interface PortalComposerCommandSurfaces {
  getMainWindow: () => BrowserWindow | null;
}

function isFailureCode(
  value: unknown,
): value is Extract<PortalChatComposerCommandResult, { ok: false }>['code'] {
  return (
    value === 'not_found' ||
    value === 'invalid_target' ||
    value === 'execution_failed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateRendererResult(
  value: unknown,
): PortalChatComposerCommandResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    !('ok' in value) ||
    typeof value.ok !== 'boolean'
  ) {
    throw new Error('Invalid Portal composer command result.');
  }
  if (value.ok) {
    const data = 'data' in value ? value.data : undefined;
    if (data !== undefined && !isRecord(data)) {
      throw new Error('Invalid Portal composer command result data.');
    }
    return {
      requestId: value.requestId,
      ok: true,
      ...(data !== undefined ? { data } : {}),
    };
  }
  if (
    !('code' in value) ||
    !isFailureCode(value.code) ||
    !('error' in value) ||
    typeof value.error !== 'string' ||
    value.error.length === 0 ||
    !('retryable' in value) ||
    typeof value.retryable !== 'boolean'
  ) {
    throw new Error('Invalid Portal composer command failure result.');
  }
  return {
    requestId: value.requestId,
    ok: false,
    code: value.code,
    error: value.error,
    retryable: value.retryable,
  };
}

function settlePendingRequest(result: PortalChatComposerCommandResult): void {
  const request = pending.get(result.requestId);
  if (!request) {
    return;
  }
  clearTimeout(request.timer);
  pending.delete(result.requestId);
  request.resolve(result);
}

function unavailableResult(requestId: string): PortalChatComposerCommandResult {
  return {
    requestId,
    ok: false,
    code: 'execution_failed',
    error: 'The desktop app renderer is unavailable.',
    retryable: true,
  };
}

function timeoutResult(requestId: string): PortalChatComposerCommandResult {
  return {
    requestId,
    ok: false,
    code: 'execution_failed',
    error:
      'Timed out waiting for the desktop app to apply the composer change.',
    retryable: true,
  };
}

export function requestPortalComposerCommand(
  request: PortalChatComposerSetterRequest,
  surfaces: PortalComposerCommandSurfaces,
): Promise<PortalChatComposerCommandResult> {
  const existing = pending.get(request.requestId);
  if (existing) {
    return new Promise((resolve) => {
      const previousResolve = existing.resolve;
      existing.resolve = (result): void => {
        previousResolve(result);
        resolve(result);
      };
    });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settlePendingRequest(timeoutResult(request.requestId));
    }, COMPOSER_COMMAND_ACK_TIMEOUT_MS);
    timer.unref?.();
    pending.set(request.requestId, { resolve, timer });

    try {
      const delivery = sendToWindowDetailed(
        surfaces.getMainWindow(),
        IPC_CHANNELS.chatPortalComposerCommand,
        request,
      );
      if (!delivery.delivered) {
        settlePendingRequest(unavailableResult(request.requestId));
      }
    } catch {
      settlePendingRequest(unavailableResult(request.requestId));
    }
  });
}

export function registerPortalComposerCommandHandlers(): void {
  registerIpcHandler<[unknown], { ok: true }>(
    IPC_CHANNELS.chatPortalComposerCommandResult,
    (_event, value) => {
      settlePendingRequest(validateRendererResult(value));
      return { ok: true };
    },
  );
}
