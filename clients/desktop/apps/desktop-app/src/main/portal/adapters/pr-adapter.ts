import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  createPullRequest,
  refreshPullRequestState,
  runPrAction,
} from '../../services/pr-service';
import { createPortalEvent } from '../portal-event-bus';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';

function emitPrDelta(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
  payload: Awaited<ReturnType<typeof refreshPullRequestState>>,
): void {
  context.enqueueEvent(
    createPortalEvent(
      'portal.state.delta',
      {
        scope: 'pr',
        target: {
          workspaceLocalId: payload.workspaceLocalId,
          worktreeLocalId: payload.worktreeLocalId,
        },
        entities: [
          {
            entityType: 'pr_status',
            localId: payload.worktreeLocalId,
            parentLocalId: worktreeScopedParentLocalId(
              payload.workspaceLocalId,
              payload.worktreeLocalId,
            ),
            payload,
          },
        ],
        generatedAt: new Date().toISOString(),
      },
      { commandId: command.id },
    ),
  );
}

export async function handlePortalPrRefresh(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.pr.refresh']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid PR refresh payload.');
    return;
  }
  try {
    const state = await refreshPullRequestState(command.payload);
    emitPrDelta(command, context, state);
    context.complete(command, state);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPrCreate(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.pr.create']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid PR create payload.');
    return;
  }
  try {
    const state = await createPullRequest(command.payload);
    emitPrDelta(command, context, state);
    context.complete(command, state);
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPrAction(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.pr.action']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid PR action payload.');
    return;
  }
  try {
    const state = await runPrAction(command.payload, {
      getWindow: context.getWindow,
    });
    if (state && 'workspaceLocalId' in state) {
      emitPrDelta(command, context, state);
    }
    context.complete(command, state);
  } catch (error) {
    failServiceError(command, context, error);
  }
}
