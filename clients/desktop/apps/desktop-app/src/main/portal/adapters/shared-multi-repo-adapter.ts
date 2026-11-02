import {
  PortalSharedMultiRepoCommandSchema,
  PortalSharedMultiRepoCreationsResultSchema,
  PORTAL_CATALOG_RESULT_MAX_BYTES,
  type PortalCommandEnvelope,
} from '@canopy/protocol/portal';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { getCanopyCloudCredentials } from '../../lib/canopy-cloud-account-store';
import { getDesktopOAuthClientDeviceId } from '../../canopy-cloud/oauth-login';
import { getOrgProjectCatalogService } from '../../services/org-project-catalog-service';
import { getOrgProjectMaterialization } from '../../lib/org-project-materialization';
import { resolveOrgProjectSetupDestination } from '../../lib/org-project-setup-destination';
import type { PortalAdapterContext } from './types';

/** Commands remain pinned to the account/device chosen by the paired session. */
export async function handlePortalSharedMultiRepo(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const parsed = PortalSharedMultiRepoCommandSchema.safeParse(command.payload);
  if (!parsed.success || !context.sessionId || context.origin) {
    context.fail(
      command,
      'invalid_payload',
      'A paired interactive session and supported request are required',
    );
    return;
  }
  const payload = parsed.data;
  const credentials = await getCanopyCloudCredentials();
  if (
    credentials.account?.id !== payload.accountId ||
    (await getDesktopOAuthClientDeviceId()) !== payload.deviceId
  ) {
    context.fail(
      command,
      'invalid_target',
      'The selected account or desktop changed',
    );
    return;
  }
  const caller: CanopyCallerDescriptor = {
    principalId: 'local-desktop-user',
    clientInstanceId: `portal-session:${context.sessionId}`,
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'portal',
    grants: ['core.workspace.read', 'core.workspace.write'],
  };
  const runtime = getActiveDesktopRuntime();
  let result: unknown;
  switch (payload.action) {
    case 'prepare':
      result = await runtime.query(
        'core.workspace.sharedMultiRepo.prepare',
        payload.params,
        { caller },
      );
      break;
    case 'create':
      result = await runtime.instruction(
        'core.workspace.sharedMultiRepo.create',
        payload.params,
        { caller },
      );
      break;
    case 'getCreation':
      result = await runtime.query(
        'core.workspace.sharedMultiRepo.getCreation',
        { creationKey: payload.creationKey },
        { caller },
      );
      break;
    case 'listCreations':
      result = PortalSharedMultiRepoCreationsResultSchema.parse({
        version: 1,
        creations: await runtime.query(
          'core.workspace.sharedMultiRepo.listCreations',
          { limit: payload.limit },
          { caller },
        ),
      });
      break;
    default: {
      if (
        !(credentials.organizations ?? []).some(
          (org) => org.id === payload.organizationId,
        )
      )
        throw new Error('Organization access is unavailable');
      const catalog = await getOrgProjectCatalogService().refresh(
        { kind: 'organization', organizationId: payload.organizationId },
        { force: true },
      );
      if (catalog.stale || catalog.error)
        throw new Error('Project access could not be checked');
      if (payload.action === 'catalog') {
        const offset = payload.offset ?? 0;
        const projects: typeof catalog.projects = [];
        for (const project of catalog.projects.slice(
          offset,
          offset + (payload.limit ?? 50),
        )) {
          if (
            Buffer.byteLength(
              JSON.stringify({ ...catalog, projects: [...projects, project] }),
              'utf8',
            ) > PORTAL_CATALOG_RESULT_MAX_BYTES
          )
            break;
          projects.push(project);
        }
        if (projects.length === 0 && offset < catalog.projects.length)
          throw new Error(
            'The project definition exceeds the paired catalog limit',
          );
        result = {
          ...catalog,
          projects,
          nextOffset:
            offset + projects.length < catalog.projects.length
              ? offset + projects.length
              : null,
        };
        break;
      }
      const project = catalog.projects.find(
        (row) => row.id === payload.projectId && row.capabilities.use,
      );
      if (!project) throw new Error('Project access is unavailable');
      const setup = getOrgProjectMaterialization();
      const scope = {
        organizationId: payload.organizationId,
        accountId: payload.accountId,
        deviceId: payload.deviceId,
      };
      if (payload.action === 'startSetup') {
        await getOrgProjectCatalogService().setPreference(
          { kind: 'organization', organizationId: payload.organizationId },
          payload.projectId,
          'ADDED',
        );
        const root = await resolveOrgProjectSetupDestination();
        if (
          (await getCanopyCloudCredentials()).account?.id !== payload.accountId
        )
          throw new Error('The selected account changed');
        result = await setup.startSetup(payload.projectId, root, scope);
      } else if (payload.action === 'cancelSetup') {
        await setup.cancelSetup(payload.projectId, scope);
        result = {};
      } else result = setup.getProgress(payload.projectId, scope);
    }
  }
  context.complete(command, result);
}
