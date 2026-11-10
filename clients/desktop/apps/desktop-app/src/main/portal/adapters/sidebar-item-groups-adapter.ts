import type {
  PortalCommandEnvelope,
  PortalSidebarItemGroupsAssignNamedPayload,
  PortalSidebarItemGroupsAssignNamedResult,
} from '@canopy/protocol/portal';
import {
  isSidebarItemGroupColor,
  type SidebarItemGroupScope,
} from '@canopy/protocol/sidebar';
import { sidebarItemGroupsService } from '../../services/sidebar-item-groups-service';
import type { PortalAdapterContext } from './types';
import { failServiceError, isRecord } from './validation';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { validateId } from '../../lib/validation';
import { PortalServiceError } from '../../services/portal-service-error';

function readAssignNamedPayload(
  input: unknown,
): PortalSidebarItemGroupsAssignNamedPayload {
  try {
    if (
      !isRecord(input) ||
      Object.keys(input).some(
        (key) => !['scope', 'itemId', 'name', 'color'].includes(key),
      ) ||
      !isRecord(input.scope) ||
      Object.keys(input.scope).length !== 1 ||
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      (input.color !== undefined && !isSidebarItemGroupColor(input.color))
    ) {
      throw new Error('Invalid named group assignment');
    }
    let scope: SidebarItemGroupScope;
    if (input.scope.appAdvisor === true) {
      scope = { appAdvisor: true };
    } else {
      validateId(input.scope.workspaceLocalId, 'workspaceLocalId');
      scope = { workspaceLocalId: input.scope.workspaceLocalId };
    }
    validateId(input.itemId, 'itemId');
    return {
      scope,
      itemId: input.itemId,
      name: input.name,
      ...(isSidebarItemGroupColor(input.color) ? { color: input.color } : {}),
    };
  } catch {
    throw new PortalServiceError(
      'invalid_payload',
      'Invalid named sidebar group assignment payload.',
    );
  }
}

/** Assign an item to the first group with a name, creating it when none matches. */
export async function handlePortalSidebarItemGroupsAssignNamed(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const result: PortalSidebarItemGroupsAssignNamedResult =
      await sidebarItemGroupsService.assignItemToNamedGroup(
        readAssignNamedPayload(command.payload),
      );
    // The service transaction emits the same structural change as the
    // existing create/update paths; no second broadcast is needed here.
    context.complete(command, result);
  } catch (error) {
    if (error instanceof PortalServiceError) {
      failServiceError(command, context, error);
      return;
    }
    logMainProcessWarn('Portal sidebar group command failed', error);
    context.fail(
      command,
      'execution_failed',
      'Could not update the sidebar group. Refresh and try again.',
      false,
    );
  }
}

/** Additive core-owned compatibility routing to the existing canonical owner. */
export async function handlePortalSidebarItemGroups(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  try {
    const request = command.payload;
    switch (command.type) {
      case 'portal.sidebar.item_groups.list': {
        if (!isRecord(request)) throw new Error('Invalid group list request');
        if (!isRecord(request.scope)) throw new Error('Invalid group scope');
        const scope =
          request.scope.appAdvisor === true
            ? { appAdvisor: true as const }
            : typeof request.scope.workspaceLocalId === 'string'
              ? { workspaceLocalId: request.scope.workspaceLocalId }
              : undefined;
        if (!scope || Object.keys(request.scope).length !== 1)
          throw new Error('Invalid group scope');
        context.complete(command, {
          groups: await sidebarItemGroupsService.list(scope),
        });
        return;
      }
      case 'portal.sidebar.item_groups.create':
        context.complete(
          command,
          await sidebarItemGroupsService.create(request),
        );
        return;
      case 'portal.sidebar.item_groups.update':
        await sidebarItemGroupsService.update(request);
        break;
      case 'portal.sidebar.item_groups.ungroup':
        await sidebarItemGroupsService.ungroup(request);
        break;
      case 'portal.sidebar.item_groups.move_item':
        await sidebarItemGroupsService.moveItem(request);
        break;
      case 'portal.sidebar.item_groups.move_group':
        await sidebarItemGroupsService.moveGroup(request);
        break;
      default:
        context.fail(
          command,
          'unsupported_command',
          'Unsupported group command.',
        );
        return;
    }
    context.complete(command, { ok: true });
  } catch (error) {
    logMainProcessWarn('Portal sidebar group command failed', error);
    context.fail(
      command,
      'execution_failed',
      'Could not update the sidebar group. Refresh and try again.',
      false,
    );
  }
}
