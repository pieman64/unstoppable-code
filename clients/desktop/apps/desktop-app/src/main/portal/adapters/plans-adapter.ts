import type {
  CreateTrackedPlanRequest,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import {
  createPlan,
  deletePlan,
  listPlans,
  readPlan,
  updatePlan,
} from '../../services/plans-service';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';

export async function handlePortalPlanList(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.plan.list']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid plan list payload.');
    return;
  }
  try {
    context.complete(command, await listPlans(command.payload));
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPlanGet(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.plan.get']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid plan get payload.');
    return;
  }
  try {
    const plan = await readPlan(command.payload, {
      portalCommandId: command.id,
    });
    context.complete(command, { ok: true, plan });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPlanCreate(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.plan.create']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid plan create payload.');
    return;
  }
  try {
    const plan = await createPlan(command.payload as CreateTrackedPlanRequest, {
      portalCommandId: command.id,
      getWindow: context.getWindow,
    });
    context.complete(command, { ok: true, plan });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPlanUpdate(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.plan.update']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid plan update payload.');
    return;
  }
  try {
    const plan = await updatePlan(command.payload as UpdateTrackedPlanRequest, {
      portalCommandId: command.id,
      getWindow: context.getWindow,
    });
    context.complete(command, { ok: true, plan });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export async function handlePortalPlanDelete(
  command: PortalCommandEnvelope<PortalCommandPayloadMap['portal.plan.delete']>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!isRecord(command.payload)) {
    context.fail(command, 'invalid_payload', 'Invalid plan delete payload.');
    return;
  }
  try {
    await deletePlan(command.payload, {
      portalCommandId: command.id,
      getWindow: context.getWindow,
    });
    context.complete(command, { ok: true });
  } catch (error) {
    failServiceError(command, context, error);
  }
}

export const handlePortalPlanOpen = handlePortalPlanGet;
