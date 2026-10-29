import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import { sidebarItemGroupsService } from '../../services/sidebar-item-groups-service';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';
import { logMainProcessWarn } from '../../lib/main-process-logging';

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
