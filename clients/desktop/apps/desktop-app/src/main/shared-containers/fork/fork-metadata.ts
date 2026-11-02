import {
  isProjectStartPage,
  type ProjectStartPage,
} from '@canopy/protocol/start-page';
import {
  applyWorkspaceManifestDecision,
  applyWorkspaceIndexRemoval,
} from '../../lib/workspace-record-decision-port';
import {
  SharedContainerForkMetadataRefusedError,
  type SharedContainerForkMetadataRefusal,
} from '../../lib/worktree-record-decision-apply';
export {
  SharedContainerForkMetadataRefusedError,
  type SharedContainerForkMetadataRefusal,
} from '../../lib/worktree-record-decision-apply';
import type { W5CommitOptions } from '../../lib/w5-commit-scope';
import {
  commitW5BoundaryStep,
  w5CompositionLocks,
} from '../../lib/w5-composition-operation';
import { IdentifierValidationError, validateId } from '../../lib/validation';
import { WorkspaceIndexUnreadableError } from '../../lib/workspace-index-repository';
import { WorkspaceConfigUnreadableError } from '../../lib/workspace-persistence';

/**
 * The workspace metadata writes of `core.sharedContainer.fork` (CAN-3824):
 * the published start page a code fork gives the project it created, and the
 * fallback that hides a project a fork created when its rollback cannot
 * delete it. The fork's copies, Git operations, chats, attachments and
 * provenance stay in the fork modules; the project itself is created through
 * `createWorkspace` and deleted through `deleteWorkspaceById`.
 *
 * Each write changes only what it owns, on a read made inside the write
 * queue of the file it changes, so a concurrent create, settings change or
 * ownership change is never erased. The unregistered fork command owns caller
 * revisions and receipts (CAN-3805); start-page publication joins its
 * record-only transition and the rollback fallback keeps its original path.
 */

/** The fork that writes the metadata (`shared-containers:fork`). */
export type SharedContainerForkMetadataSource = 'code_fork' | 'cowork_fork';

const SOURCES: ReadonlySet<string> = new Set<SharedContainerForkMetadataSource>(
  ['code_fork', 'cowork_fork'],
);

function refuse(
  reason: SharedContainerForkMetadataRefusal,
  message: string,
): SharedContainerForkMetadataRefusedError {
  return new SharedContainerForkMetadataRefusedError(reason, message);
}

function admit(
  source: string,
  allowed: ReadonlySet<string>,
  workspaceId: string,
): void {
  if (!allowed.has(source)) {
    throw refuse('invalid-request', 'Unknown shared-container fork source');
  }
  try {
    validateId(workspaceId, 'workspaceId');
  } catch (error) {
    if (error instanceof IdentifierValidationError) {
      throw refuse('invalid-request', error.message);
    }
    throw error;
  }
}

export interface SharedContainerForkStartPageRecord {
  /** Only a code fork writes the manifest; a Cowork fork's start page is a Cowork setting. */
  source: 'code_fork';
  /** The project the fork created. */
  workspaceId: string;
  /** The published start page, mapped to the project's repositories. */
  startPage: ProjectStartPage;
}

const START_PAGE_SOURCES: ReadonlySet<string> = new Set(['code_fork']);

/**
 * Sets the start page of the project a code fork created. It is applied to
 * the manifest read inside the workspace's write queue and changes only
 * `startPage`, so repositories the fork or another writer committed are
 * kept (CAN-3799 F9 for the fork). A project without a manifest is refused
 * rather than given a default one, and an unreadable manifest is left as it
 * is; either refusal fails the fork, whose rollback removes the project.
 */
async function stageSharedContainerForkStartPage(
  record: SharedContainerForkStartPageRecord,
): Promise<{ workspaceId: string; startPage: ProjectStartPage }> {
  admit(record.source, START_PAGE_SOURCES, record.workspaceId);
  const { workspaceId, startPage } = record;
  if (!isProjectStartPage(startPage)) {
    throw refuse('invalid-request', 'Invalid shared-container fork start page');
  }
  try {
    await applyWorkspaceManifestDecision(workspaceId, {
      kind: 'sharedContainer.fork.start-page',
      startPage,
    });
  } catch (error) {
    if (error instanceof WorkspaceConfigUnreadableError) {
      throw refuse('configuration-unavailable', error.message);
    }
    throw error;
  }
  return { workspaceId, startPage };
}

export function recordSharedContainerForkStartPage(
  record: SharedContainerForkStartPageRecord,
  commit?: W5CommitOptions,
): Promise<{ workspaceId: string; startPage: ProjectStartPage }> {
  return commitW5BoundaryStep(
    commit,
    commit ? w5CompositionLocks({ manifests: [record.workspaceId] }) : [],
    () => stageSharedContainerForkStartPage(record),
  );
}

export interface SharedContainerForkHideRequest {
  source: SharedContainerForkMetadataSource;
  /** The project the fork created and could not delete. */
  workspaceId: string;
}

/**
 * Hides a project a fork created when the rollback could not delete it: its
 * index entry is removed and nothing else is written, so its files stay for
 * a later cleanup. The entry is removed from the index read inside the index
 * queue, so a project another writer indexed meanwhile stays (CAN-3799 F8).
 * `not-found` means the project is no longer indexed and nothing was written.
 */
export async function hideSharedContainerForkWorkspace(
  request: SharedContainerForkHideRequest,
): Promise<{ status: 'hidden' | 'not-found' }> {
  admit(request.source, SOURCES, request.workspaceId);
  try {
    const removed = await applyWorkspaceIndexRemoval(request.workspaceId, {
      kind: 'sharedContainer.fork.hide',
    });
    return { status: removed ? 'hidden' : 'not-found' };
  } catch (error) {
    if (error instanceof WorkspaceIndexUnreadableError) {
      throw refuse('index-unavailable', error.message);
    }
    throw error;
  }
}
