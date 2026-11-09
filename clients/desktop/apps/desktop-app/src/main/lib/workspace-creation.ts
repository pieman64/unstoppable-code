import { randomUUID } from 'node:crypto';
import { notifyScriptActionsRepositoryAdd } from '../services/script-actions-lifecycle';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import { CloneCancelledError } from '../services/clone-jobs';
import { z } from 'zod';
import type { W5CommitOptions } from './w5-commit-scope';
import { runKeyedW5Operation, type W5KeyedAttempt } from './w5-keyed-operation';
import { WorkspaceCreationRefusedError } from './workspace-creation-refusal';
import { CoworkWorkspaceRecordRefusedError } from './cowork-workspace-records';
import { IdentifierValidationError } from './identifier-validation-error';
import { withWorkspaceCreationCommit } from './w5-workspace-creation-commit';
import { withW5Commit } from './w5-commit-log-file-store';
import { afterW5Commit } from './w5-commit-scope';
import { isAbsolute } from 'node:path';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  assertImportFolderExists,
  ImportFolderNotFoundError,
} from '@canopy/desktop-shared/node/lib/import-folder';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import { refuseWorkspaceCreation } from './workspace-creation-refusal';
import {
  addWorkspaceFromRemote,
  createAndPersistNewMultiRepoWorkspace,
  registerBoundMultiRepoWorkspace,
  registerCloudProjectMultiRepoWorkspace,
  createNewSingleRepoWorkspace,
  importMultiRepoWorkspaceManifestFromRepo,
  importWorkspaceFromRepoPath,
  registerSingleRepoWorkspaceWithoutManifest,
  WorkspaceIdentityInUseError,
  type AddWorkspaceFromRemoteProgress,
} from './workspace-service';

/** The caller of a create or import, recorded in workspace CRUD telemetry. */
export type WorkspaceCreationSource =
  | 'new_single_repo'
  | 'new_multi_repo'
  | 'folder'
  | 'remote'
  | 'import_from_repo'
  | 'portal'
  | 'org-shared-multi-repo-setup'
  | 'org-member-multi-repo-create'
  /** A Personal cloud project set up on this device (CAN-5192). */
  | 'cloud-project-setup'
  | 'shared_container_fork'
  | 'external_projects_import'
  /** A registered `core.workspace.create` wire call (W7b-3). */
  | 'desktop_canopy_client';

/**
 * The supported create and import variants. Local paths are trusted host
 * selections the adapter projected (CAN-3799 D8); none crosses a wire.
 */
export type WorkspaceCreationVariant =
  /** A new repository under the managed repos directory. */
  | { kind: 'new-single-repo'; name: string }
  /** A new multi-repo project with its source repository. */
  | { kind: 'new-multi-repo'; name: string }
  /** Host-only, validated complete clone with its organization binding. */
  | ({ kind: 'bound-multi-repo' } & Parameters<
      typeof registerBoundMultiRepoWorkspace
    >[0])
  /** Host-only, validated clones of a Personal cloud project (CAN-5192). */
  | ({ kind: 'cloud-project-multi-repo' } & Parameters<
      typeof registerCloudProjectMultiRepoWorkspace
    >[0])
  /**
   * An existing folder: a repository, a multi-repo manifest repository, or a
   * plain folder imported as an external Cowork project.
   */
  | { kind: 'local-folder'; folderPath: string }
  /** A repository whose `canopy.json` declares a multi-repo project. */
  | { kind: 'repository-manifest'; repoPath: string }
  /** A repository registered without writing `canopy.json` into it. */
  | { kind: 'repository-without-manifest'; repoPath: string; name?: string }
  /** A clone of a remote repository into `destinationDir`. */
  | {
      kind: 'remote-clone';
      remoteUrl: string;
      destinationDir: string;
      progress?: AddWorkspaceFromRemoteProgress;
    };

export interface WorkspaceCreationRequest {
  source: WorkspaceCreationSource;
  variant: WorkspaceCreationVariant;
  /** The workspaces collection revision read before this create. */
  expectedRevision?: number;
  idempotencyKey?: string;
  /**
   * A keyed wire call's receipt caller (W7b-3), derived from its principal;
   * defaults to `desktop-host:<source>`. Never part of the fingerprint.
   */
  receiptCaller?: string;
}

export interface WorkspaceCreationOutcome {
  /** The workspace as the create indexed it. */
  workspace: SidebarItem;
  /** The manifest repositories a manifest import cloned; otherwise empty. */
  clonedRepoIds: string[];
  /** Poll this operation through scriptActions.receipt after an add. */
  scriptActionsOperationId?: string;
}

const receiptOutcomeSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(['single-repo', 'multi-repo', 'cowork']),
    color: z.string(),
    order: z.number(),
    collapsed: z.boolean().optional(),
  }),
  clonedRepoIds: z.array(z.string()),
  scriptActionsOperationId: z.string().optional(),
});
/** The create DTO projected to portable identity/display fields for a keyed call. */
export type WorkspaceCreationReceiptOutcome = z.infer<
  typeof receiptOutcomeSchema
>;
function projectReceiptOutcome(
  workspace: SidebarItem,
  clonedRepoIds: string[],
  scriptActionsOperationId?: string,
): WorkspaceCreationReceiptOutcome {
  return receiptOutcomeSchema.parse({
    workspace,
    clonedRepoIds,
    scriptActionsOperationId,
  });
}

async function admitImportFolder(
  path: string,
  inspectFolder: boolean,
): Promise<void> {
  if (!isAbsolute(path)) {
    refuseWorkspaceCreation(
      'invalid-path',
      'repoPath must be an absolute path',
    );
  }
  if (!inspectFolder) return;
  try {
    await assertImportFolderExists(path);
  } catch (error) {
    if (error instanceof ImportFolderNotFoundError) {
      refuseWorkspaceCreation('missing-folder', error.message);
    }
    throw error;
  }
}

/** The checks that need no index read; each refuses before any effect. */
async function admitCreation(
  variant: WorkspaceCreationVariant,
  inspectFolder = true,
): Promise<void> {
  switch (variant.kind) {
    case 'new-single-repo':
    case 'new-multi-repo':
      if (!variant.name.trim()) {
        refuseWorkspaceCreation('name-required', 'Project name is required');
      }
      return;
    case 'bound-multi-repo':
    case 'cloud-project-multi-repo':
      await admitImportFolder(variant.path, inspectFolder);
      return;
    case 'local-folder':
      await admitImportFolder(variant.folderPath, inspectFolder);
      return;
    case 'repository-manifest':
      await admitImportFolder(variant.repoPath, inspectFolder);
      return;
    case 'repository-without-manifest':
      if (!isAbsolute(variant.repoPath)) {
        refuseWorkspaceCreation(
          'invalid-path',
          'repoPath must be an absolute path',
        );
      }
      return;
    case 'remote-clone':
      if (!variant.remoteUrl.trim()) {
        refuseWorkspaceCreation('invalid-remote', 'Remote URL is required');
      }
      if (!isAbsolute(variant.destinationDir.trim())) {
        refuseWorkspaceCreation(
          'invalid-path',
          'Destination directory must be an absolute path',
        );
      }
      return;
  }
}

async function runCreation(
  variant: WorkspaceCreationVariant,
): Promise<WorkspaceCreationOutcome> {
  switch (variant.kind) {
    case 'new-single-repo':
      return {
        workspace: await createNewSingleRepoWorkspace(variant.name),
        clonedRepoIds: [],
      };
    case 'new-multi-repo':
      return {
        workspace: await createAndPersistNewMultiRepoWorkspace(variant.name),
        clonedRepoIds: [],
      };
    case 'bound-multi-repo':
      return {
        workspace: await registerBoundMultiRepoWorkspace(variant),
        clonedRepoIds: variant.repositories.map((entry) =>
          entry.relativePath.slice('repos/'.length),
        ),
      };
    case 'cloud-project-multi-repo':
      return {
        workspace: await registerCloudProjectMultiRepoWorkspace(variant),
        clonedRepoIds: variant.repositories.map((repo) => repo.id),
      };
    case 'local-folder':
      return {
        workspace: await importWorkspaceFromRepoPath(variant.folderPath),
        clonedRepoIds: [],
      };
    case 'repository-manifest':
      return importMultiRepoWorkspaceManifestFromRepo(variant.repoPath);
    case 'repository-without-manifest':
      return {
        workspace: await registerSingleRepoWorkspaceWithoutManifest(
          variant.repoPath,
          variant.name,
        ),
        clonedRepoIds: [],
      };
    case 'remote-clone':
      return {
        workspace: variant.progress
          ? await addWorkspaceFromRemote(
              variant.remoteUrl,
              variant.destinationDir,
              variant.progress,
            )
          : await addWorkspaceFromRemote(
              variant.remoteUrl,
              variant.destinationDir,
            ),
        clonedRepoIds: [],
      };
  }
}

/**
 * The typed in-process workspace create and import boundary (CAN-3806),
 * behind the renderer's create and import channels, the Portal's
 * `portal.workspace.create`, organization project creation, shared-container
 * forks and the external project import. It refuses before any effect while
 * the W5 namespaces are not writable here, and checks names, paths and the
 * folder's existence first. Each variant then runs the desktop lifecycle,
 * which allocates the id and checks duplicates inside the commit that
 * indexes the workspace (CAN-3799 D11, D12), and raises a typed
 * `WorkspaceCreationRefusedError` with the message the desktop has always
 * shown. W5 files commit together with an optional collection revision check;
 * keyed calls reserve before provisioning and replay their portable outcome.
 * A repeated create without a key still adds another project.
 */
export function createWorkspace(
  request: WorkspaceCreationRequest & { idempotencyKey: string },
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationReceiptOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest & { idempotencyKey?: undefined },
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest,
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome | WorkspaceCreationReceiptOutcome>;
export function createWorkspace(
  request: WorkspaceCreationRequest,
  parentCommit?: W5CommitOptions,
): Promise<WorkspaceCreationOutcome | WorkspaceCreationReceiptOutcome> {
  return withStorageAdmission(PROJECT_W5_STORAGE, async () => {
    // Read-only admission retains the old validation and messages.
    await admitCreation(request.variant, request.idempotencyKey === undefined);
    const expectedRevisions: W5CommitOptions['expectedRevisions'] =
      request.expectedRevision === undefined
        ? undefined
        : [
            {
              resource: { kind: 'workspaces' },
              revision: request.expectedRevision,
            },
          ];
    const execute = async (
      binding: W5CommitOptions,
      attempt?: W5KeyedAttempt,
    ): Promise<WorkspaceCreationOutcome> => {
      const outcome = await withWorkspaceCreationCommit(
        parentCommit ?? { ...binding, expectedRevisions },
        () => runCreation(request.variant),
        attempt ? (): void => attempt.beforeEffects() : undefined,
        attempt
          ? (error): void =>
              attempt.validate(() => {
                throw error;
              })
          : undefined,
      );
      await afterW5Commit(() =>
        recordWorkspaceCrudTelemetry({
          action: 'create',
          workspaceId: outcome.workspace.id,
          source: request.source,
        }),
      );
      if (
        outcome.workspace.type !== 'cowork' &&
        request.variant.kind !== 'bound-multi-repo' &&
        request.variant.kind !== 'cloud-project-multi-repo'
      ) {
        const repoIds =
          outcome.workspace.type === 'single-repo'
            ? [SINGLE_REPO_USAGE_REPO_ID]
            : [
                ...outcome.workspace.repos.map((repo) => repo.id),
                WORKSPACE_ROOT_REPO_ID,
              ];
        outcome.scriptActionsOperationId = randomUUID();
        await afterW5Commit(() => {
          notifyScriptActionsRepositoryAdd(
            outcome.workspace.id,
            repoIds,
            outcome.scriptActionsOperationId,
          );
        });
      }
      return outcome;
    };
    if (request.idempotencyKey === undefined)
      return execute({ operation: 'core.workspace.create' });
    const rawVariant =
      request.variant.kind === 'remote-clone'
        ? {
            kind: request.variant.kind,
            remoteUrl: request.variant.remoteUrl,
            destinationDir: request.variant.destinationDir,
          }
        : request.variant;
    const variant =
      rawVariant.kind === 'new-single-repo' ||
      rawVariant.kind === 'new-multi-repo'
        ? { ...rawVariant, name: rawVariant.name.trim() }
        : rawVariant;
    const operation =
      request.variant.kind === 'new-single-repo' ||
      request.variant.kind === 'new-multi-repo'
        ? 'core.workspace.create'
        : 'core.workspace.import';
    return runKeyedW5Operation(
      {
        caller: request.receiptCaller ?? `desktop-host:${request.source}`,
        operation,
        idempotencyKey: request.idempotencyKey,
        parameters: variant,
        admit: () => admitCreation(request.variant),
        isPreEffectRefusal: (error) =>
          error instanceof CloneCancelledError ||
          error instanceof WorkspaceCreationRefusedError ||
          error instanceof ImportFolderNotFoundError ||
          error instanceof CoworkWorkspaceRecordRefusedError ||
          error instanceof IdentifierValidationError ||
          // Thrown before anything is written: the key may be sent again.
          error instanceof WorkspaceIdentityInUseError,
      },
      (outcome) => receiptOutcomeSchema.parse(outcome),
      async (binding, attempt) => {
        const result = await execute(binding, attempt);
        const outcome = projectReceiptOutcome(
          result.workspace,
          result.clonedRepoIds,
          result.scriptActionsOperationId,
        );
        // Activation, publication hooks and telemetry may still fail after the
        // canonical publication. Only a fully returned command earns a receipt.
        await withW5Commit({ ...binding, outcome }, async () => {});
        return outcome;
      },
    );
  });
}
