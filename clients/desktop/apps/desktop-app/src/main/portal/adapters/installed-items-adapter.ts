import { z } from 'zod';
import {
  SetInstalledItemStatusRequestSchema,
  UninstallInstalledItemRequestSchema,
} from '@canopy/protocol/installed-items';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { PortalAdapterContext } from './types';

const project = z.object({ projectId: z.string().min(1) }).strict();
const status = SetInstalledItemStatusRequestSchema.extend({
  projectId: z.string().min(1),
});
const uninstall = UninstallInstalledItemRequestSchema.extend({
  projectId: z.string().min(1),
});

export function handlePortalInstalledItems(
  command: PortalCommandEnvelope,
  context: PortalAdapterContext,
): Promise<void> {
  const schema =
    command.type === 'portal.installed_items.list_status'
      ? project
      : command.type === 'portal.installed_items.set_status'
        ? status
        : uninstall;
  const parsed = schema.safeParse(command.payload);
  if (!parsed.success) {
    context.fail(command, 'invalid_payload', 'Invalid installed-item request.');
    return Promise.resolve();
  }
  if (
    !command.target?.workspaceLocalId ||
    command.target.workspaceLocalId !== parsed.data.projectId
  ) {
    context.fail(
      command,
      'invalid_target',
      'The project must match the paired command target.',
    );
    return Promise.resolve();
  }
  // Provider operations run off-loop, like the existing plugin install commands.
  // Retried requests are serialized by the service and reconcile durable provider state.
  void (async (): Promise<void> => {
    try {
      const { installedItemService } =
        await import('../../installed-items/installed-item-service');
      if (command.type === 'portal.installed_items.list_status')
        context.complete(command, await installedItemService.listStatus());
      else if (command.type === 'portal.installed_items.set_status') {
        const parsedStatus = status.parse(command.payload);
        const request = {
          target: parsedStatus.target,
          status: parsedStatus.status,
        };
        context.complete(
          command,
          await installedItemService.setStatus(request),
        );
      } else {
        const request = { target: uninstall.parse(command.payload).target };
        context.complete(
          command,
          await installedItemService.uninstall(request),
        );
      }
    } catch {
      context.fail(
        command,
        'execution_failed',
        'Installed-item state could not be read or changed. Retry to reconcile the saved operation.',
        true,
      );
    }
  })();
  return Promise.resolve();
}
