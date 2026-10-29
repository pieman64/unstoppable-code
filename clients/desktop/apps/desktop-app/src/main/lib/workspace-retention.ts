import { z } from 'zod';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import {
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveAutoArchiveDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { acquireWorkspaceArchiveRetentionLease } from '../services/split-lock-service';
import { withArchivedWorkspaceOperationLock } from './archived-containers';
import { validateId } from './validation';
import { getWorkspaceConfigPath, getWorkspaceWorktreesFilePath } from './paths';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import { createW5SingleDecisionOperation } from './w5-single-decision-operation';
import {
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
} from './w5-storage';
import { touchAllWorkspaceTargets } from './workspace-activity';
import { WorktreeRegistryUnreadableError } from './worktree-list-repository';
import {
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
  type WorkspaceConfigUpdateRead,
} from './workspace-persistence';

/** The caller of a retention change. */
export type WorkspaceRetentionSource =
  /** `workspace:set-archive-retention`. */
  'workspace_settings';

/**
 * The typed fields of `core.workspace.retention.update` (CAN-3799). The
 * archive retention is always set; an absent Auto Delete field is unchanged.
 */
export interface WorkspaceRetentionPatch {
  /** Days archives are kept; `null` keeps them until deleted. */
  archiveRetentionDays: number | null;
  /** Days of inactivity before Auto Delete; `null` turns it off. */
  autoArchiveDays?: number | null;
  autoArchiveDeleteBranch?: boolean;
}

/** `expectedRevision` is the workspace revision (`workspace:{id}`). */
export interface WorkspaceRetentionUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  patch: WorkspaceRetentionPatch;
  source: WorkspaceRetentionSource;
}

export interface WorkspaceRetentionUpdateOutcome {
  workspaceId: string;
  /**
   * Whether this change turned Auto Delete on, so every worktree's activity
   * was stamped first and none is deleted for inactivity before it.
   */
  activityBaselineRecorded: boolean;
}

export type WorkspaceRetentionRefusal =
  | 'invalid-patch'
  | 'not-found'
  | 'unsupported-for-cowork'
  | 'retention-busy'
  | 'configuration-unavailable';

/** The retention change was refused before anything was written. */
export class WorkspaceRetentionRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceRetentionRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRetentionRefusedError';
  }
}

const outcomeSchema = z.object({
  workspaceId: z.string(),
  activityBaselineRecorded: z.boolean(),
});
const runRetentionCommand =
  createW5SingleDecisionOperation<WorkspaceRetentionSource>(
    (error) => error instanceof WorkspaceRetentionRefusedError,
  );

function isDayCount(value: unknown, minimum: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= MAX_ARCHIVE_RETENTION_DAYS
  );
}

/**
 * Validates a caller-supplied patch (IPC payloads are untyped at runtime)
 * with the messages the desktop has always shown.
 */
function validatePatch(patch: WorkspaceRetentionPatch): void {
  const { archiveRetentionDays, autoArchiveDays } = patch;
  if (archiveRetentionDays !== null && !isDayCount(archiveRetentionDays, 0)) {
    throw new WorkspaceRetentionRefusedError(
      'invalid-patch',
      `Archive retention must be null or an integer from 0 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  if (
    autoArchiveDays !== undefined &&
    autoArchiveDays !== null &&
    !isDayCount(autoArchiveDays, 1)
  ) {
    throw new WorkspaceRetentionRefusedError(
      'invalid-patch',
      `Auto Delete inactivity must be null or an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  const deleteBranch: unknown = patch.autoArchiveDeleteBranch;
  if (deleteBranch !== undefined && typeof deleteBranch !== 'boolean') {
    throw new WorkspaceRetentionRefusedError(
      'invalid-patch',
      'Auto Delete branch deletion must be a boolean',
    );
  }
}

function autoArchiveEnabled(config: WorkspaceConfigFile): boolean {
  return (
    resolveAutoArchiveDays(
      config.type,
      config.archiveRetentionDays,
      config.autoArchiveDays,
    ) !== null
  );
}

/**
 * The typed in-process `core.workspace.retention.update` boundary
 * (CAN-3817): the archive retention and Auto Delete settings of one code
 * workspace, from `workspace:set-archive-retention`. Cowork retention is a
 * Cowork setting and is refused.
 *
 * Holds the retention lease, archive lock, manifest scope and list lock in
 * that order. The activity baseline and settings share one decision with the
 * optional workspace revision, receipt and saved outcome (CAN-4613). A failed
 * stamp or either-file preflight conflict commits neither file. Compatibility
 * callers remain unkeyed; the operation stays in-process and unregistered.
 */
export async function updateWorkspaceRetention(
  request: WorkspaceRetentionUpdateRequest,
): Promise<WorkspaceRetentionUpdateOutcome> {
  const { workspaceId, source, idempotencyKey, expectedRevision } = request;
  const patch = { ...request.patch };
  validateId(workspaceId, 'workspaceId');
  validatePatch(patch);
  return runRetentionCommand(
    {
      operation: 'core.workspace.retention.update',
      source,
      idempotencyKey,
      parameters: () => ({ workspaceId, patch }),
      storage: [WORKSPACE_MANIFEST_STORAGE, WORKTREE_LIST_STORAGE],
    },
    (): Promise<void> => Promise.resolve(),
    (outcome) => outcomeSchema.parse(outcome),
    async (_admitted, options, save) => {
      let releaseRetentionLease: () => void;
      try {
        releaseRetentionLease =
          acquireWorkspaceArchiveRetentionLease(workspaceId);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new WorkspaceRetentionRefusedError(
          'retention-busy',
          error.message,
        );
      }
      try {
        return await withArchivedWorkspaceOperationLock(workspaceId, () =>
          withW5Commit(
            {
              ...options,
              fenceLockedFiles: true,
              locks: [
                { kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) },
                {
                  kind: 'list',
                  path: getWorkspaceWorktreesFilePath(workspaceId),
                },
              ],
              expectedRevisions: w5ExpectedRevision(
                { kind: 'workspace', workspaceId },
                expectedRevision,
              ),
            },
            async () => {
              await checkW5ExpectedRevision(
                { kind: 'workspace', workspaceId },
                expectedRevision,
              );
              return save(
                await updateWorkspaceConfig(
                  workspaceId,
                  async (
                    config: WorkspaceConfigFile,
                    read: WorkspaceConfigUpdateRead,
                  ): Promise<WorkspaceRetentionUpdateOutcome> => {
                    if (read.authority === 'absent') {
                      throw new WorkspaceRetentionRefusedError(
                        'not-found',
                        `Project ${workspaceId} not found.`,
                      );
                    }
                    if (config.type === 'cowork') {
                      throw new WorkspaceRetentionRefusedError(
                        'unsupported-for-cowork',
                        'Cowork retention is managed through cowork settings',
                      );
                    }
                    const wasEnabled = autoArchiveEnabled(config);
                    config.archiveRetentionDays = patch.archiveRetentionDays;
                    if (patch.autoArchiveDays !== undefined) {
                      config.autoArchiveDays = patch.autoArchiveDays;
                    }
                    if (patch.autoArchiveDeleteBranch !== undefined) {
                      config.autoArchiveDeleteBranch =
                        patch.autoArchiveDeleteBranch;
                    }
                    const activityBaselineRecorded =
                      !wasEnabled && autoArchiveEnabled(config);
                    // Throwing here leaves the manifest unwritten.
                    if (activityBaselineRecorded) {
                      await touchAllWorkspaceTargets(workspaceId);
                    }
                    return { workspaceId, activityBaselineRecorded };
                  },
                ),
              );
            },
          ),
        );
      } catch (error) {
        if (
          error instanceof WorkspaceConfigUnreadableError ||
          error instanceof WorktreeRegistryUnreadableError
        ) {
          throw new WorkspaceRetentionRefusedError(
            'configuration-unavailable',
            error.message,
          );
        }
        throw error;
      } finally {
        releaseRetentionLease();
      }
    },
  );
}
