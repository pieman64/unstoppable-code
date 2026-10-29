import { z } from 'zod';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import { getWorkspaceConfigPath } from './paths';
import { readWorkspaceIndexEntry } from './sidebar-items';
import { validateId } from './validation';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import { createW5SingleDecisionOperation } from './w5-single-decision-operation';
import { WORKSPACE_MANIFEST_STORAGE } from './w5-storage';
import {
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
  type WorkspaceConfigUpdateRead,
} from './workspace-persistence';
import { applyWorkspaceOwnershipDecision } from './workspace-ownership-decision-port';
import type { OrganizationPrivateMemoryStatus } from './worktree-record-decisions';

/** The caller of a local private memory change. */
export type WorkspacePrivateMemorySource =
  /** `workspace:set-private-memory`. */
  'workspace_settings';

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspacePrivateMemoryUpdateRequest extends W5BoundaryOptions {
  /** The resolved workspace, never the standalone chat sentinel. */
  workspaceId: string;
  privateMemory: boolean;
  source: WorkspacePrivateMemorySource;
}

export interface WorkspacePrivateMemoryUpdateOutcome {
  workspaceId: string;
  privateMemory: boolean;
}

const outcomeSchema = z.object({
  workspaceId: z.string(),
  privateMemory: z.boolean(),
});

export type WorkspacePrivateMemoryRefusal =
  | 'invalid-patch'
  | 'not-found'
  | 'configuration-unavailable'
  | 'managed-by-organization';

/** The private memory change was refused before anything was written. */
export class WorkspacePrivateMemoryRefusedError extends Error {
  constructor(
    readonly reason: WorkspacePrivateMemoryRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspacePrivateMemoryRefusedError';
  }
}

const NOT_FOUND_MESSAGE = 'Project was not found';
const CONFIGURATION_UNAVAILABLE_MESSAGE =
  'Project configuration is unavailable';
const ORGANIZATION_CONFIGURATION_UNAVAILABLE_MESSAGE =
  'Organization project config is unavailable for memory policy';

function refuse(
  reason: WorkspacePrivateMemoryRefusal,
  message: string,
): WorkspacePrivateMemoryRefusedError {
  return new WorkspacePrivateMemoryRefusedError(reason, message);
}

const runPrivateMemoryCommand =
  createW5SingleDecisionOperation<WorkspacePrivateMemorySource>(
    (error) => error instanceof WorkspacePrivateMemoryRefusedError,
  );

/**
 * Runs a local private memory write inside the workspace's manifest write
 * queue, refusing a manifest that is missing, unreadable or carries a memory
 * policy this version cannot read, before anything is written.
 */
async function updateMemoryPolicy(
  workspaceId: string,
  update: (config: WorkspaceConfigFile) => void,
): Promise<void> {
  try {
    await updateWorkspaceConfig(
      workspaceId,
      (config: WorkspaceConfigFile, read: WorkspaceConfigUpdateRead): void => {
        if (read.authority === 'absent' || read.memoryMalformed) {
          throw refuse(
            'configuration-unavailable',
            CONFIGURATION_UNAVAILABLE_MESSAGE,
          );
        }
        update(config);
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw refuse(
        'configuration-unavailable',
        CONFIGURATION_UNAVAILABLE_MESSAGE,
      );
    }
    throw error;
  }
}

/**
 * The typed in-process `core.workspace.privateMemory.update` boundary
 * (CAN-3817): the local private memory choice of one workspace, from
 * `workspace:set-private-memory`.
 *
 * The organization check (`privateMemoryManagedBy`) and the write use one
 * read inside the workspace's manifest write queue, so an organization
 * policy recorded in the meantime is never overridden and no repository,
 * ownership or other settings change is erased. A missing, unreadable or
 * malformed manifest is refused and left as it is. An optional workspace
 * revision and key are checked in the same commit (CAN-4391); the operation
 * stays unregistered.
 */
export async function updateWorkspacePrivateMemory(
  request: WorkspacePrivateMemoryUpdateRequest,
): Promise<WorkspacePrivateMemoryUpdateOutcome> {
  const { workspaceId, expectedRevision } = request;
  validateId(workspaceId, 'workspaceId');
  const requested: unknown = request.privateMemory;
  if (typeof requested !== 'boolean') {
    throw refuse('invalid-patch', 'Private memory must be a boolean');
  }
  const privateMemory = requested;
  const resource: W5Resource = { kind: 'workspace', workspaceId };
  return runPrivateMemoryCommand(
    {
      operation: 'core.workspace.privateMemory.update',
      source: request.source,
      idempotencyKey: request.idempotencyKey,
      parameters: () => ({ workspaceId, privateMemory }),
      storage: [WORKSPACE_MANIFEST_STORAGE],
    },
    async (): Promise<void> => {
      if (!(await readWorkspaceIndexEntry(workspaceId))) {
        throw refuse('not-found', NOT_FOUND_MESSAGE);
      }
    },
    (outcome) => outcomeSchema.parse(outcome),
    (_admitted, options, save) => {
      async function stageWorkspacePrivateMemory(): Promise<WorkspacePrivateMemoryUpdateOutcome> {
        await checkW5ExpectedRevision(resource, expectedRevision);
        await updateMemoryPolicy(workspaceId, (config): void => {
          if (config.privateMemoryManagedBy === 'organization') {
            throw refuse(
              'managed-by-organization',
              'Private memory is managed by your organization',
            );
          }
          config.privateMemory = privateMemory;
        });
        return save({ workspaceId, privateMemory });
      }
      return withW5Commit(
        {
          ...options,
          locks: [
            { kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) },
          ],
          expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
        },
        stageWorkspacePrivateMemory,
      );
    },
  );
}

export interface OrganizationPrivateMemoryRecord {
  workspaceId: string;
  organizationId: string;
  projectId: string;
  privateMemory: boolean;
}

/**
 * The private memory part of `internal.workspace.ownership.record` (CAN-3799
 * D9): the organization materialization and catalog reconciliation record an
 * organization project's inherited policy, together with the marker that
 * stops a local change. It is the sole writer of `privateMemoryManagedBy`.
 *
 * The workspace must still be bound to that organization project when the
 * write queue reaches it; otherwise, or when the manifest is missing,
 * unreadable or malformed, nothing is written. Resolves whether it changed
 * the manifest. The decision applies through the record decision port (W5c2).
 */
export async function recordOrganizationPrivateMemory(
  record: OrganizationPrivateMemoryRecord,
): Promise<boolean> {
  validateId(record.workspaceId, 'workspaceId');
  let status: OrganizationPrivateMemoryStatus;
  try {
    status = await applyWorkspaceOwnershipDecision(record.workspaceId, {
      kind: 'ownership.private-memory',
      organizationId: record.organizationId,
      projectId: record.projectId,
      privateMemory: record.privateMemory,
    });
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) status = 'refused';
    else throw error;
  }
  if (status === 'refused')
    throw refuse(
      'configuration-unavailable',
      ORGANIZATION_CONFIGURATION_UNAVAILABLE_MESSAGE,
    );
  return status === 'recorded';
}
