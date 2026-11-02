import type {
  HookRunRequest,
  HookSourceInfoRequest,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  cancelHook,
  changeWorktreeHookPause,
  getHookSourceInfo,
  hookToPortalEntity,
  listHooks,
  runHookCommand,
} from '../../services/hooks-service';
import { logMainProcessError } from '../../lib/main-process-logging';
import { createFeatureUpsertEvent } from '../portal-feature-events';
import { PortalServiceError } from '../../services/portal-service-error';
import { createPortalCaller } from '../portal-caller';
import { getCanopyPortalState } from '../portal-session-manager';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalHookRun(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.hook.run']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid hook run payload.');
    return;
  }
  try {
    let markEnqueued: () => void = (): void => undefined;
    const enqueued = new Promise<void>((resolve) => {
      markEnqueued = resolve;
    });
    const running = runHookCommand(command.payload as HookRunRequest, {
      portalCommandId: command.id,
      getWindow: context.getWindow,
      onEnqueued: markEnqueued,
    });
    await Promise.race([enqueued, running.then((): void => undefined)]);
    context.complete(command, { ok: true });
    void running.catch((error: unknown): void => {
      logMainProcessError(
        'Portal hook execution failed after it started.',
        error,
      );
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalHookCancel(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.hook.cancel']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid hook cancel payload.');
    return;
  }
  try {
    const result = await cancelHook(command.payload, {
      portalCommandId: command.id,
    });
    context.complete(command, result);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalHookPause(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.hook.pause']>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  const commandName = command.type === 'portal.hook.pause' ? 'pause' : 'resume';
  if (
    !isRecord(payload) ||
    typeof payload.projectId !== 'string' ||
    payload.projectId.length === 0 ||
    typeof payload.worktreeId !== 'string' ||
    payload.worktreeId.length === 0
  ) {
    context.fail(
      command,
      'invalid_payload',
      `Invalid hook ${commandName} payload.`,
    );
    return;
  }
  const hookKey =
    typeof payload.hookKey === 'string' && payload.hookKey.length > 0
      ? payload.hookKey
      : undefined;
  const hasHookKey = hookKey !== undefined;
  const hasAll = payload.all === true;
  if (hasHookKey === hasAll) {
    context.fail(
      command,
      'invalid_payload',
      'Provide exactly one of hookKey or all: true.',
    );
    return;
  }

  try {
    const hooks = await listHooks({
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
    if (hasHookKey && !hooks.some((hook) => hook.hookKey === hookKey)) {
      throw new PortalServiceError(
        'not_found',
        `Hook ${hookKey} was not found.`,
      );
    }
    let affectedKeys: string[];
    if (hasAll) {
      affectedKeys = hooks.map((hook) => hook.hookKey);
    } else {
      if (hookKey === undefined) {
        context.fail(command, 'invalid_payload', 'Hook key is required.');
        return;
      }
      affectedKeys = [hookKey];
    }
    // Applied to the latest row, so a competing pause or resume is kept.
    const { pausedHookKeys } = await changeWorktreeHookPause({
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      change: {
        kind: command.type === 'portal.hook.pause' ? 'pause' : 'resume',
        hookKeys: affectedKeys,
      },
      source: 'portal',
    });
    const refreshedHooks = await listHooks({
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
    });
    for (const hook of refreshedHooks) {
      context.enqueueEvent(
        createFeatureUpsertEvent({
          type: 'portal.hook.event',
          commandId: command.id,
          entity: hookToPortalEntity(hook),
        }),
      );
    }
    context.complete(command, {
      projectId: payload.projectId,
      worktreeId: payload.worktreeId,
      pausedHookKeys,
    });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalHookSourceInfo(
  command: PortalCommandEnvelope<
    PortalCommandPayloadMap['portal.hook.source_info']
  >,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid hook source payload.');
    return;
  }
  try {
    const sessionId = getCanopyPortalState().sessionId;
    if (!sessionId) throw new Error('Portal session is not active.');
    context.complete(
      command,
      await getHookSourceInfo(
        command.payload as HookSourceInfoRequest,
        createPortalCaller({ sessionId }, []),
      ),
    );
  } catch (error) {
    failServiceError(command, context, error);
  }
}
