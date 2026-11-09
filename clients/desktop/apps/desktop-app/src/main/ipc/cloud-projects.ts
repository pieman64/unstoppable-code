import { BrowserWindow } from 'electron';
import {
  MemoryProjectIdSchema,
  MemoryUuidSchema,
} from '@canopy/protocol/memory-sync';
import {
  IPC_CHANNELS,
  type CloudProjectLinkOptions,
  type CloudProjectLinkRequest,
  type CloudProjectLinkResult,
  type CloudProjectSetupCatalog,
  type CloudProjectSetupOptions,
  type CloudProjectSetupRequest,
  type CloudProjectSetupResult,
} from '@canopy/desktop-shared/types';
import {
  findCloudProjectLink,
  linkCloudProject,
} from '../cloud-projects/cloud-project-binding-host';
import { normalizeDestinationRoot } from '../cloud-projects/destination-root';
import {
  cloudProjectSetupCatalog,
  cloudProjectSetupOptions,
  startCloudProjectSetup,
  subscribeCloudProjectSetupProgress,
} from '../cloud-projects/project-setup-host';
import { validateAbsolutePath, validateId } from '../lib/validation';
import { sendToWebContents } from '../lib/web-contents-send';
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

function parseProjectId(value: unknown): string {
  const parsed = MemoryProjectIdSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid cloud project id');
  return parsed.data;
}

/**
 * The request, or the selection it cannot set up: a repository list the
 * schema refuses is the user's to correct, so it comes back as
 * `invalid-selection` and the picker says so, rather than as a thrown error
 * the renderer can only report as a client failure (CAN-5192 round 6). A
 * malformed project id or destination is not a choice the picker offers, and
 * still throws.
 */
function parseSetupRequest(
  value: unknown,
): { ok: true; request: CloudProjectSetupRequest } | { ok: false } {
  if (!isRecord(value)) throw new Error('Invalid cloud project setup request');
  const repositoryIds = MemoryUuidSchema.array()
    .min(1)
    .max(100)
    .safeParse(value.repositoryIds);
  if (
    !repositoryIds.success ||
    new Set(repositoryIds.data).size !== repositoryIds.data.length
  )
    return { ok: false };
  const raw = value.destinationRoot;
  if (typeof raw !== 'string') throw new Error('Invalid destinationRoot');
  validateAbsolutePath(raw, 'destinationRoot');
  const destinationRoot = normalizeDestinationRoot(raw);
  return {
    ok: true,
    request: {
      projectId: parseProjectId(value.projectId),
      repositoryIds: repositoryIds.data,
      destinationRoot,
    },
  };
}

/**
 * Linking a local workspace to its cloud project identity (CAN-5190), and
 * setting a cloud project up on this device (CAN-5192).
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
  registerIpcHandler<[], CloudProjectSetupCatalog>(
    IPC_CHANNELS.cloudProjectsSetupCatalog,
    async (): Promise<CloudProjectSetupCatalog> => cloudProjectSetupCatalog(),
  );
  registerIpcHandler<[unknown], CloudProjectSetupOptions>(
    IPC_CHANNELS.cloudProjectsSetupOptions,
    async (_event, projectId: unknown): Promise<CloudProjectSetupOptions> =>
      cloudProjectSetupOptions(parseProjectId(projectId)),
  );
  registerIpcHandler<[unknown], CloudProjectSetupResult>(
    IPC_CHANNELS.cloudProjectsStartSetup,
    async (_event, request: unknown): Promise<CloudProjectSetupResult> => {
      const parsed = parseSetupRequest(request);
      return parsed.ok
        ? startCloudProjectSetup(parsed.request)
        : { ok: false, code: 'invalid-selection' };
    },
  );
  subscribeCloudProjectSetupProgress((progress): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.cloudProjectsSetupProgress,
          progress,
        );
    }
  });
}
