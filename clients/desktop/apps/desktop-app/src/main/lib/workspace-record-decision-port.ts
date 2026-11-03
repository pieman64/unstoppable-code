import {
  getWorkspaceIndexRepository,
  removeWorkspaceIndexEntry,
} from './sidebar-items';
import { WorkspaceIndexUnreadableError } from './workspace-index-repository';
import { pipelineHookBindingsEnabled } from './workspace-source-record-policy';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  removeWorkspaceWorktrees,
  removeWorkspaceRecords,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import {
  applySourceChangeBindingsTo,
  applySourceChangeTargetRecordTo,
  removesSourceChangeTarget,
  admitSourceInitializationRecord,
  applySourceInitializationTo,
  applyWorkspaceConversionManifestTo,
  applySplitDestinationTo,
  removesSplitDestination,
  admitCompositionPromotion,
  admitTemporaryCompositionList,
  applyCompositionJoinRecordTo,
  applyCompositionJoinUndoTo,
  applyCompositionPromotionTo,
  applyCompositionRepositoriesUndoTo,
  applyCompositionRowsRestoreTo,
  applyCompositionSourceRecordTo,
  applyCompositionSourceUndoTo,
  applyTemporaryCompositionManifestTo,
  applyPipelineResultsSeenTo,
  applySharedContainerForkStartPageTo,
  applyWorkspaceIndexDecisionTo,
  CompositionRecordRefusedError,
  removesCompositionRow,
} from './worktree-record-decision-apply';
import type {
  CompositionJoinRecordDecision,
  CompositionJoinRecorded,
  CompositionJoinRecordOutcome,
  CompositionSourceRecordDecision,
  CompositionSourceRecorded,
  CompositionSourceRecordOutcome,
  PipelineResultsSeenDecision,
  PipelineResultsSeenOutcome,
  WorkspaceIndexDecision,
  WorkspaceIndexRemovalDecision,
  WorkspaceManifestDecision,
  WorktreeListPreconditions,
  WorktreeListRemovalDecision,
  WorktreeListRemovalOutcome,
  WorktreeListRemovalPreconditions,
  WorktreeListUpdateDecision,
  WorktreeListUpdateOutcome,
} from './worktree-record-decisions';

// The list update and removal, manifest and index members of
// `W5RecordDecisionPort` (W6d1), applied like the row and list members in
// `worktree-record-decision-port.ts`; the repositories keep their refusal
// diagnostics and admission. Kept apart so that module's importers do not
// load the sidebar index writers' dependencies.

/**
 * Applies one guarded list update under the list lock (X1). Recording kinds
 * report what the last pass that wrote read and wrote.
 */
export async function applyWorktreeListUpdate(
  workspaceId: string,
  decision: CompositionJoinRecordDecision,
  preconditions: WorktreeListPreconditions,
): Promise<CompositionJoinRecordOutcome>;
export async function applyWorktreeListUpdate(
  workspaceId: string,
  decision: CompositionSourceRecordDecision,
  preconditions: WorktreeListPreconditions,
): Promise<CompositionSourceRecordOutcome>;
export async function applyWorktreeListUpdate(
  workspaceId: string,
  decision: PipelineResultsSeenDecision,
  preconditions: WorktreeListPreconditions,
): Promise<PipelineResultsSeenOutcome>;
export async function applyWorktreeListUpdate(
  workspaceId: string,
  decision: WorktreeListUpdateDecision,
  preconditions: WorktreeListPreconditions,
): Promise<WorktreeListUpdateOutcome>;
export async function applyWorktreeListUpdate(
  workspaceId: string,
  decision: WorktreeListUpdateDecision | PipelineResultsSeenDecision,
  preconditions: WorktreeListPreconditions,
): Promise<
  | CompositionJoinRecordOutcome
  | CompositionSourceRecordOutcome
  | PipelineResultsSeenOutcome
  | WorktreeListUpdateOutcome
> {
  switch (decision.kind) {
    case 'split.destination.reserve':
    case 'split.destination.recovery':
    case 'split.destination.promote':
    case 'split.destination.archive':
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          (rows) =>
            applySplitDestinationTo(
              workspaceId,
              rows,
              decision,
              isWorkspaceWorktreeRecentlyRemoved(
                workspaceId,
                decision.worktree.id,
                decision.worktree.createdAt,
              ),
            ),
          preconditions,
        ),
      };
    case 'pipelineResults.markSeen': {
      // W5c2: only a pass that found the incarnation reports what it saw.
      let newlySeen: string[] = [];
      const worktrees = await updateWorkspaceWorktrees(
        workspaceId,
        (rows) => {
          const pass = applyPipelineResultsSeenTo(rows, decision);
          if (pass.newlySeen) newlySeen = pass.newlySeen;
          return pass.worktrees;
        },
        preconditions,
      );
      return { worktrees, newlySeen };
    }
    case 'composition.join.record': {
      let recorded: CompositionJoinRecorded | undefined;
      const worktrees = await updateWorkspaceWorktrees(
        workspaceId,
        (rows) => {
          const pass = applyCompositionJoinRecordTo(rows, decision);
          if (pass.recorded) recorded = pass.recorded;
          return pass.worktrees;
        },
        preconditions,
      );
      return { worktrees, recorded };
    }
    case 'composition.source.record': {
      let recorded: CompositionSourceRecorded | undefined;
      const worktrees = await updateWorkspaceWorktrees(
        workspaceId,
        (rows) => {
          const pass = applyCompositionSourceRecordTo(rows, decision);
          recorded = pass.recorded;
          return pass.worktrees;
        },
        preconditions,
      );
      return { worktrees, recorded };
    }
    case 'composition.join.undo':
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          (rows) => applyCompositionJoinUndoTo(rows, decision),
          preconditions,
        ),
      };
    case 'composition.source.undo':
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          (rows) => applyCompositionSourceUndoTo(rows, decision),
          preconditions,
        ),
      };
    case 'composition.rows.restore':
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          (rows) => applyCompositionRowsRestoreTo(rows, decision),
          preconditions,
        ),
      };
    case 'workspace.sourceChanges.target.record':
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          (rows) => applySourceChangeTargetRecordTo(rows, decision),
          preconditions,
        ),
      };
    case 'composition.temporary.create':
      // The manifest is read and written under the list lock, so a list that
      // appears meanwhile refuses the create before any manifest exists.
      return {
        worktrees: await updateWorkspaceWorktrees(
          workspaceId,
          async (_rows, read) => {
            admitTemporaryCompositionList(workspaceId, read?.authority);
            try {
              await applyWorkspaceManifestDecision(
                workspaceId,
                decision.manifest,
              );
            } catch (error) {
              if (error instanceof WorkspaceConfigUnreadableError)
                throw new CompositionRecordRefusedError(
                  'configuration-unavailable',
                  error.message,
                );
              throw error;
            }
            return [];
          },
          preconditions,
        ),
      };
  }
}

/**
 * Applies one guarded removal under the list lock (X2). It tombstones what it
 * removes, never notifies the Portal itself, and reports the ids it read.
 */
export async function applyWorktreeListRemoval(
  workspaceId: string,
  decision: WorktreeListRemovalDecision,
  preconditions: WorktreeListRemovalPreconditions,
): Promise<WorktreeListRemovalOutcome> {
  const order: string[] = [];
  const rows = await removeWorkspaceWorktrees(
    workspaceId,
    (row) => {
      order.push(row.id);
      switch (decision.kind) {
        case 'split.destination.remove':
          return removesSplitDestination(row, decision);
        case 'composition.row.remove':
          return removesCompositionRow(row, decision);
        case 'workspace.sourceChanges.target.remove':
          return removesSourceChangeTarget(row, decision);
      }
    },
    undefined,
    undefined,
    preconditions,
  );
  return { rows, order };
}

/**
 * Applies one manifest decision in the manifest queue (X3). An unreadable
 * manifest is refused, with its diagnostic, before the decision applies; the
 * written manifest keeps the ownership on disk.
 */
export async function applyWorkspaceManifestDecision(
  workspaceId: string,
  decision: WorkspaceManifestDecision,
): Promise<void> {
  switch (decision.kind) {
    case 'workspace.source.initialize':
      await updateWorkspaceConfig(workspaceId, (config, read) => {
        admitSourceInitializationRecord(workspaceId, config, read.authority);
        applySourceInitializationTo(
          config,
          decision,
          pipelineHookBindingsEnabled(),
        );
      });
      return;
    case 'workspace.conversion.manifest':
      await updateWorkspaceConfig(workspaceId, (config, read) =>
        applyWorkspaceConversionManifestTo(
          workspaceId,
          config,
          read.authority,
          decision,
        ),
      );
      return;
    case 'workspace.sourceChanges.bindings':
      await updateWorkspaceConfig(
        workspaceId,
        (config, read) =>
          applySourceChangeBindingsTo(config, read.authority, decision),
        { shouldWrite: Boolean },
      );
      return;
    case 'sharedContainer.fork.start-page':
      await updateWorkspaceConfig(workspaceId, (config, read) =>
        applySharedContainerForkStartPageTo(
          workspaceId,
          config,
          read.authority,
          decision,
        ),
      );
      return;
    case 'composition.repositories.undo':
      await updateWorkspaceConfig(
        workspaceId,
        (config, read) =>
          applyCompositionRepositoriesUndoTo(
            workspaceId,
            config,
            read.authority,
            decision,
          ),
        { shouldWrite: Boolean },
      );
      return;
    case 'composition.temporary.manifest':
      await updateWorkspaceConfig(workspaceId, (config, read) =>
        applyTemporaryCompositionManifestTo(
          workspaceId,
          config,
          read.authority,
          decision,
        ),
      );
      return;
    case 'composition.promote':
      // The index entry is renamed under the manifest queue, after the
      // manifest's checks and before its change.
      await updateWorkspaceConfig(workspaceId, async (config, read) => {
        admitCompositionPromotion(workspaceId, config, read.authority);
        try {
          await applyWorkspaceIndexDecision(decision.index);
        } catch (error) {
          if (error instanceof WorkspaceIndexUnreadableError)
            throw new CompositionRecordRefusedError(
              'index-unavailable',
              error.message,
            );
          throw error;
        }
        applyCompositionPromotionTo(config, decision);
      });
      return;
  }
}

/**
 * Applies one index update (X4) through the index repository, which admits
 * the index storage, refuses and reports a write over an unreadable index,
 * and schedules the Portal sync after its commit.
 */
export async function applyWorkspaceIndexDecision(
  decision: WorkspaceIndexDecision,
): Promise<void> {
  await getWorkspaceIndexRepository().update(
    ({ entries, authority, unserved }) => {
      const next = applyWorkspaceIndexDecisionTo(entries, authority, decision);
      if (next === null)
        throw new CompositionRecordRefusedError(
          'index-unavailable',
          new WorkspaceIndexUnreadableError(unserved).message,
        );
      return { result: undefined, entries: next };
    },
  );
}

/**
 * Applies one targeted index entry removal (X4) through the index entry
 * writer, with its post-commit type registry, remembered sidebar ids and
 * Portal notification. Returns whether the entry was there.
 */
export async function applyWorkspaceIndexRemoval(
  workspaceId: string,
  decision: WorkspaceIndexRemovalDecision,
): Promise<boolean> {
  switch (decision.kind) {
    case 'split.created-workspace.cleanup':
    case 'sharedContainer.fork.hide':
    case 'composition.destination.cleanup':
    case 'workspace.delete.index':
      return removeWorkspaceIndexEntry(workspaceId);
  }
}

/** Commits both record removals as one W5 decision. */
export async function applyWorkspaceRecordsRemoval(
  workspaceId: string,
  decision: {
    kind:
      | 'workspace.delete.records'
      | 'split.created-workspace.records'
      | 'composition.destination.records';
  },
): Promise<void> {
  switch (decision.kind) {
    case 'workspace.delete.records':
    case 'split.created-workspace.records':
    case 'composition.destination.records':
      await removeWorkspaceRecords(workspaceId);
  }
}
