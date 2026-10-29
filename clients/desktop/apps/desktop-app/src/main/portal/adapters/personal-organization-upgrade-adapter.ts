import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import {
  PersonalProjectConversionRequestSchema,
  PersonalProjectStatusRequestSchema,
} from '@canopy/protocol/organizations';
import type { PortalAdapterContext } from './types';

export async function handlePortalPersonalOrganizationProjects(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  if (!context.sessionId) {
    context.fail(
      command,
      'invalid_target',
      'A paired desktop session is required',
    );
    return;
  }
  const { getPersonalOrganizationUpgradeService } =
    await import('../../services/personal-organization-upgrade-host');
  const service = getPersonalOrganizationUpgradeService();
  try {
    if (command.type === 'portal.personal_organization.projects.list') {
      context.complete(command, await service.list());
    } else if (
      command.type === 'portal.personal_organization.projects.status'
    ) {
      const request = PersonalProjectStatusRequestSchema.safeParse(
        command.payload,
      );
      if (!request.success) {
        context.fail(
          command,
          'invalid_payload',
          'Invalid operation status request',
        );
        return;
      }
      context.complete(
        command,
        await service.status(request.data.operationId, context.sessionId),
      );
    } else {
      const request = PersonalProjectConversionRequestSchema.safeParse(
        command.payload,
      );
      if (!request.success || !request.data.workspaceId) {
        context.fail(
          command,
          'invalid_payload',
          'Select one project in the authorized batch',
        );
        return;
      }
      // A conversion makes many Cloud round trips. Completing it off the
      // serial command loop keeps the Portal's `projects.status` polls, and
      // every other command, answering while it runs. The session manager
      // holds this command's receipt until it settles. Only the service's
      // mutation lane orders it now, against other conversions and resumes;
      // other Portal commands may run during a conversion, as desktop UI
      // actions always could.
      const conversion = request.data;
      const sessionId = context.sessionId;
      void (async (): Promise<void> => {
        try {
          context.complete(
            command,
            await service.convert(conversion, sessionId),
          );
        } catch (error) {
          failExecution(command, context, error);
        }
      })();
    }
  } catch (error) {
    failExecution(command, context, error);
  }
}

function failExecution(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
  error: unknown,
): void {
  context.fail(
    command,
    'execution_failed',
    error instanceof Error ? error.message : 'Operation unavailable',
  );
}
