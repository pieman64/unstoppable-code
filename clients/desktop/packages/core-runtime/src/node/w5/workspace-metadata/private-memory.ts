import {
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../boundary-operation';
import { createW5CompositionLocks } from '../composition-operation';
import type { W5OutcomeParser } from '../composition-outcome';
import { createW5SingleDecisionOperation } from '../single-decision-operation';
import type {
  W5WorkspaceCommandHost,
  W5WorkspaceCommandStorage,
  W5WorkspaceManifestEditor,
} from './ports';

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

export interface WorkspacePrivateMemoryCommandHost extends W5WorkspaceCommandHost<WorkspacePrivateMemorySource> {
  manifest: W5WorkspaceManifestEditor;
  storage: Pick<W5WorkspaceCommandStorage, 'manifest'>;
  /** Whether the workspace index has the workspace. */
  hasWorkspace: (workspaceId: string) => Promise<boolean>;
  outcome: W5OutcomeParser<WorkspacePrivateMemoryUpdateOutcome>;
}

const NOT_FOUND_MESSAGE = 'Project was not found';
const CONFIGURATION_UNAVAILABLE_MESSAGE =
  'Project configuration is unavailable';

function refuse(
  reason: WorkspacePrivateMemoryRefusal,
  message: string,
): WorkspacePrivateMemoryRefusedError {
  return new WorkspacePrivateMemoryRefusedError(reason, message);
}

/**
 * `core.workspace.privateMemory.update` (CAN-3817): the local private memory
 * choice of one workspace. The organization check (`privateMemoryManagedBy`)
 * and the write use one read inside the workspace's manifest write queue, so
 * an organization policy recorded in the meantime is never overridden. A
 * missing, unreadable or malformed manifest is refused and left as it is. An
 * optional workspace revision and key are checked in the same commit
 * (CAN-4391).
 */
export function createWorkspacePrivateMemoryCommand(
  host: WorkspacePrivateMemoryCommandHost,
): (
  request: WorkspacePrivateMemoryUpdateRequest,
) => Promise<WorkspacePrivateMemoryUpdateOutcome> {
  const run = createW5SingleDecisionOperation<WorkspacePrivateMemorySource>(
    host.decision,
    (error) => error instanceof WorkspacePrivateMemoryRefusedError,
  );
  const locks = createW5CompositionLocks(host.paths);

  return async function updateWorkspacePrivateMemory(
    request: WorkspacePrivateMemoryUpdateRequest,
  ): Promise<WorkspacePrivateMemoryUpdateOutcome> {
    const { workspaceId, expectedRevision } = request;
    host.validateId(workspaceId, 'workspaceId');
    const requested: unknown = request.privateMemory;
    if (typeof requested !== 'boolean') {
      throw refuse('invalid-patch', 'Private memory must be a boolean');
    }
    const privateMemory = requested;
    const resource = { kind: 'workspace', workspaceId } as const;
    return run(
      {
        operation: 'core.workspace.privateMemory.update',
        source: request.source,
        idempotencyKey: request.idempotencyKey,
        parameters: () => ({ workspaceId, privateMemory }),
        storage: [host.storage.manifest],
      },
      async (): Promise<void> => {
        if (!(await host.hasWorkspace(workspaceId))) {
          throw refuse('not-found', NOT_FOUND_MESSAGE);
        }
      },
      (outcome) => host.outcome.parse(outcome),
      (_admitted, options, save) =>
        host.withCommit(
          {
            ...options,
            locks: locks({ manifests: [workspaceId] }),
            expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
          },
          async () => {
            await host.checkExpectedRevision(resource, expectedRevision);
            const edit = await host.manifest.edit(workspaceId, (view, read) => {
              if (read.authority === 'absent' || read.memoryMalformed) {
                throw refuse(
                  'configuration-unavailable',
                  CONFIGURATION_UNAVAILABLE_MESSAGE,
                );
              }
              if (view.privateMemoryManagedBy === 'organization') {
                throw refuse(
                  'managed-by-organization',
                  'Private memory is managed by your organization',
                );
              }
              return { result: undefined, change: { privateMemory } };
            });
            if (edit.status === 'unreadable') {
              throw refuse(
                'configuration-unavailable',
                CONFIGURATION_UNAVAILABLE_MESSAGE,
              );
            }
            return save({ workspaceId, privateMemory });
          },
        ),
    );
  };
}
