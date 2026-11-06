import { MemoryProjectIdSchema } from '@canopy/protocol/memory-sync';
import {
  IPC_CHANNELS,
  type CloudProjectLinkOptions,
  type CloudProjectLinkRequest,
  type CloudProjectLinkResult,
} from '@canopy/desktop-shared/types';
import {
  findCloudProjectLink,
  linkCloudProject,
} from '../cloud-projects/cloud-project-binding-host';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLinkRequest(value: unknown): CloudProjectLinkRequest {
  if (!isRecord(value)) throw new Error('Invalid cloud project link request');
  const workspaceId = value.workspaceId;
  validateId(workspaceId, 'workspaceId');
  const target = value.target;
  if (isRecord(target) && target.kind === 'new')
    return { workspaceId, target: { kind: 'new' } };
  const projectId = isRecord(target)
    ? MemoryProjectIdSchema.safeParse(target.projectId)
    : null;
  if (isRecord(target) && target.kind === 'existing' && projectId?.success)
    return {
      workspaceId,
      target: { kind: 'existing', projectId: projectId.data },
    };
  throw new Error('Invalid cloud project link target');
}

/**
 * Linking a local workspace to its cloud project identity (CAN-5190): what
 * the Link to cloud project dialog offers, and the link the user chose.
 */
export function registerCloudProjectsHandlers(): void {
  registerIpcHandler<[unknown], CloudProjectLinkOptions>(
    IPC_CHANNELS.cloudProjectsFindLink,
    async (_event, workspaceId: unknown): Promise<CloudProjectLinkOptions> => {
      validateId(workspaceId, 'workspaceId');
      return findCloudProjectLink(workspaceId);
    },
  );
  registerIpcHandler<[unknown], CloudProjectLinkResult>(
    IPC_CHANNELS.cloudProjectsLink,
    async (_event, request: unknown): Promise<CloudProjectLinkResult> =>
      linkCloudProject(parseLinkRequest(request)),
  );
}
