import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  PortalStateDeltaPayload,
  TerminalKillRequest,
  TerminalResizeRequest,
  TerminalSpawnRequest,
  TerminalWriteRequest,
} from '@canopy/desktop-shared/types';
import {
  closeTerminal,
  resizeTerminal,
  spawnTerminalAfterShellPrewarm,
  TerminalServiceError,
  terminalSessionToPortalEntity,
  writeTerminal,
} from '../../services/terminal-service';
import { createPortalEvent } from '../portal-event-bus';
import type { PortalAdapterContext } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSpawnRequest(value: unknown): value is TerminalSpawnRequest {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    Number.isInteger(value.cols) &&
    Number.isInteger(value.rows)
  );
}

function isWriteRequest(value: unknown): value is TerminalWriteRequest {
  return (
    isRecord(value) &&
    typeof value.terminalId === 'string' &&
    typeof value.data === 'string'
  );
}

function isResizeRequest(value: unknown): value is TerminalResizeRequest {
  return (
    isRecord(value) &&
    typeof value.terminalId === 'string' &&
    Number.isInteger(value.cols) &&
    Number.isInteger(value.rows)
  );
}

function isKillRequest(value: unknown): value is TerminalKillRequest {
  return isRecord(value) && typeof value.terminalId === 'string';
}

function emitTerminalDelta(
  context: PortalAdapterContext,
  command: PortalCommandEnvelope,
  payload: PortalStateDeltaPayload,
): void {
  context.enqueueEvent(
    createPortalEvent('portal.state.delta', payload, { commandId: command.id }),
  );
}

function failTerminalError(
  context: PortalAdapterContext,
  command: PortalCommandEnvelope,
  error: unknown,
): void {
  if (error instanceof TerminalServiceError) {
    context.fail(command, error.code, error.message, false);
    return;
  }
  throw error;
}

function withCommandTargetScope<TPayload extends object>(
  command: PortalCommandEnvelope<TPayload>,
): TPayload & { projectId?: string; worktreeId?: string } {
  const payload = command.payload as Record<string, unknown>;
  return {
    ...command.payload,
    projectId:
      typeof payload.projectId === 'string'
        ? payload.projectId
        : command.target?.workspaceLocalId,
    worktreeId:
      typeof payload.worktreeId === 'string'
        ? payload.worktreeId
        : command.target?.worktreeLocalId,
  };
}

export function handlePortalTerminalOpen(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.terminal.open']
  >,
  context: PortalAdapterContext,
): void {
  if (!isSpawnRequest(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid terminal open payload.');
    return;
  }
  const request = command.payload;
  // A pending checkout must not hold the serial command loop: a later
  // archive can be the operation that cancels its setup. The session manager
  // retains this command's receipt until the detached open settles.
  void (async (): Promise<void> => {
    try {
      const session = await spawnTerminalAfterShellPrewarm(
        request,
        undefined,
        context.canMutateResources,
      );
      if (context.canMutateResources?.() === false) {
        closeTerminal({
          terminalId: session.id,
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        });
        throw new TerminalServiceError(
          'invalid_target',
          'The terminal request is no longer active.',
        );
      }
      const entity = terminalSessionToPortalEntity(session);
      emitTerminalDelta(context, command, {
        scope: 'terminal',
        target: {
          workspaceLocalId: session.projectId,
          worktreeLocalId: session.worktreeId,
          terminalLocalId: session.id,
        },
        entities: [entity],
        generatedAt: new Date().toISOString(),
      });
      context.complete(command, session);
    } catch (error) {
      // The original session's event sink discards stale results. A temporary
      // reconnect can also refuse mutations, but still needs a failure receipt.
      context.fail(
        command,
        error instanceof TerminalServiceError ? error.code : 'execution_failed',
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
  })();
}

export function handlePortalTerminalWrite(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.terminal.write']
  >,
  context: PortalAdapterContext,
): void {
  if (!isWriteRequest(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid terminal write payload.');
    return;
  }
  try {
    writeTerminal(withCommandTargetScope(command));
  } catch (error) {
    failTerminalError(context, command, error);
    return;
  }
  context.complete(command, { ok: true });
}

export function handlePortalTerminalResize(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.terminal.resize']
  >,
  context: PortalAdapterContext,
): void {
  if (!isResizeRequest(command.payload)) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid terminal resize payload.',
    );
    return;
  }
  try {
    resizeTerminal(withCommandTargetScope(command));
  } catch (error) {
    failTerminalError(context, command, error);
    return;
  }
  context.complete(command, { ok: true });
}

export function handlePortalTerminalClose(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.terminal.close']
  >,
  context: PortalAdapterContext,
): void {
  if (!isKillRequest(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid terminal close payload.');
    return;
  }
  try {
    closeTerminal(withCommandTargetScope(command));
  } catch (error) {
    failTerminalError(context, command, error);
    return;
  }
  emitTerminalDelta(context, command, {
    scope: 'terminal',
    target: { terminalLocalId: command.payload.terminalId },
    removed: [
      {
        entityType: 'terminal_session',
        localId: command.payload.terminalId,
      },
    ],
    generatedAt: new Date().toISOString(),
  });
  context.complete(command, { ok: true });
}
