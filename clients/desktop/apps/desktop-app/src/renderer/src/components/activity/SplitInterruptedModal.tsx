import { type JSX } from 'react';
import { DialogModal } from '@/components/shared/DialogModal';
import { Button, Surface } from '@canopy/ui-shared/components';

export interface SplitInterruptedModalProps {
  worktreeId: string;
  /** Number of children the interrupted map was carving, for context. */
  childTotal: number;
  onResume: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}

/**
 * Shown on worktree open when a persisted split map is still `status:
 * 'executing'` but no live lock is held for the key — i.e. a split run was
 * interrupted by a crash or reload (A5's reload-release drops the lock, so a
 * genuinely-in-flight run would still hold it). The renderer cannot reproduce
 * the original reviewed plan+snapshot after a restart, so:
 *
 *  - Resume routes through the PRE-FLIGHT modal (a fresh re-plan). When the
 *    user approves an UNCHANGED plan, the engine's fingerprint gate matches the
 *    persisted map and resumes from where it left off; an edited plan trips
 *    `plan_mismatch` downstream, whose Discard path is the correct exit. The
 *    copy documents this limitation.
 *  - Discard removes the persisted map (existing `discardSplitPr`), surfacing
 *    the leftover-artifacts panel.
 *  - Dismiss closes the modal; the PR panel's existing affordances remain.
 */
export function SplitInterruptedModal({
  worktreeId,
  childTotal,
  onResume,
  onDiscard,
  onDismiss,
}: SplitInterruptedModalProps): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onDismiss}
      title="Split PR interrupted"
      subtitle={`Worktree ${worktreeId}`}
      maxWidth="lg"
      dataTestId="split-interrupted-modal"
    >
      <div className="flex flex-col px-6 py-4 gap-3">
        <p className="text-s fg-primary/90">
          A Split PR run for this worktree was interrupted before it finished
          {childTotal > 0
            ? ` (${childTotal} ${childTotal === 1 ? 'child' : 'children'})`
            : ''}
          .
        </p>
        <Surface variant="group" size="small">
          <p
            className="px-3 py-2 text-xs fg-secondary"
            data-testid="split-interrupted-resume-note"
          >
            Resuming after a restart re-plans the split. Unchanged plans resume
            from where they left off; if you change the plan, discard the split
            state and start over instead.
          </p>
        </Surface>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">
        <Button
          size="compact"
          onClick={onDismiss}
          data-testid="split-interrupted-dismiss"
        >
          Dismiss
        </Button>
        <Button
          variant="ghost-destructive"
          size="compact"
          onClick={onDiscard}
          data-testid="split-interrupted-discard"
        >
          Discard split state
        </Button>
        <Button
          variant="primary"
          size="compact"
          onClick={onResume}
          data-testid="split-interrupted-resume"
        >
          Resume
        </Button>
      </div>
    </DialogModal>
  );
}
