import { type JSX } from 'react';
import { createPortal } from 'react-dom';
import { DialogModal } from '@/components/shared/DialogModal';

export interface SplitInterruptedModalProps {
  worktreeId: string;
  /** Number of children the interrupted map was carving, for context. */
  childTotal: number;
  onResume: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}

const SPLIT_INTERRUPTED_BUTTON_CLASS =
  'focus-ring rounded-lg px-4 py-1.5 text-s fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary';

const SPLIT_INTERRUPTED_PRIMARY_CLASS =
  'focus-ring rounded-lg bg-accent-subtle px-4 py-1.5 text-s font-medium fg-accent transition hover:bg-accent-subtle/80';

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
  return createPortal(
    <DialogModal
      onClose={onDismiss}
      title="Split PR interrupted"
      subtitle={`Worktree ${worktreeId}`}
      maxWidth="lg"
      dataTestId="split-interrupted-modal"
    >
      <div className="space-y-3 px-5 py-4">
        <p className="text-s fg-primary/90">
          A Split PR run for this worktree was interrupted before it finished
          {childTotal > 0
            ? ` (${childTotal} ${childTotal === 1 ? 'child' : 'children'})`
            : ''}
          .
        </p>
        <p
          data-testid="split-interrupted-resume-note"
          className="rounded-md border bg-fg-primary/[0.03] px-3 py-2 text-xs fg-secondary"
        >
          Resuming after a restart re-plans the split. Unchanged plans resume
          from where they left off; if you change the plan, discard the split
          state and start over instead.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">
        <button
          type="button"
          onClick={onDismiss}
          data-testid="split-interrupted-dismiss"
          className={SPLIT_INTERRUPTED_BUTTON_CLASS}
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={onDiscard}
          data-testid="split-interrupted-discard"
          className={SPLIT_INTERRUPTED_BUTTON_CLASS}
        >
          Discard split state
        </button>
        <button
          type="button"
          onClick={onResume}
          data-testid="split-interrupted-resume"
          className={SPLIT_INTERRUPTED_PRIMARY_CLASS}
        >
          Resume
        </button>
      </div>
    </DialogModal>,
    document.body,
  );
}
