/**
 * Pure re-export. Every gate below is defined in
 * `packages/ui-shared/src/lib/execution-actions.ts` — that is the single place
 * execution action availability is decided, shared with the web app. Nothing
 * is declared here.
 *
 * Matrix retry/cancel gates are deliberately inverses of each other:
 * - retry requires a terminal execution and terminal matrix group,
 * - cancel requires a non-terminal execution plus a live variant,
 *   never "execution is running", because a paused execution has no
 *   registered main-process handle yet its children are still cancellable.
 */
export {
  canResumeExecution,
  canRetryAllMatrixVariants,
  canRetryExecution,
  canRetryFailedMatrixVariants,
  canRetryMatrixExpansion,
  canRerunExecution,
  hasRerunReplayData,
  canCancelMatrixVariant,
  canRetryMatrixVariant,
  canRetryMatrixJob,
  getRetryableMatrixVariantIds,
  isTerminalExecutionStatus,
  isTerminalMatrixVariantStatus,
} from '@canopy/ui-shared/lib/execution-actions';
